/**
 * @file server/src/services/AddressService.ts
 * @description 收货地址领域服务：列表 / 新增 / 修改 / 软删 / 设为默认（含默认地址互斥与删除保护）
 * @module services
 * @see docs/04-flows.md（F5 下单流程：T011 是下单 T050 的必要前置）
 * @see prisma/schema.prisma（Address 模型：addresses 表、@map 字段、[userId,deletedAt,createdAt]/[userId,isDefault] 索引）
 * @author 软件开发团队
 * @created 2026-09-07
 *
 * 业务规则（逐条对应需求）：
 * 1. **越权防护**：所有查询/更新/删除的 `where` **都必须带 `userId`**（详见各方法注释）。
 *    地址是用户私有数据，漏了就是「改一个 id 就能改别人地址」的严重漏洞。
 * 2. **软删**：删除走 `deletedAt` 置位（`update`），不是物理 `delete`；列表只查 `deletedAt: null`。
 * 3. **默认地址互斥**：同一用户最多 1 个 `isDefault = true`。
 *    - 新建时若 `isDefault = true` 或该用户还没有任何地址（首个地址自动默认），先把其它地址置 false；
 *    - **必须用事务**（@/core/transaction 的 `withTransaction`）保证「先取消旧的、再设新的」原子，
 *      否则中途失败会出现 0 个或 2 个默认地址。
 * 4. **默认地址自动递补**：删除的是**默认地址**且仍有其它有效地址时，
 *    **自动把最近创建的一个递补为默认**（产品裁定，设计文档未明确规定）。
 *    这样既避免「有地址却没有默认」的歧义状态，又不强迫用户做两步操作
 *    （先 setDefault 再 remove）。递补与软删必须在同一事务内，
 *    否则中途失败会留下「0 个默认地址」的不一致。
 * 5. **切换默认**：`setDefault` 同样在事务内先取消其它默认，再置新默认。
 */

import type { Address, Prisma, PrismaClient } from '@prisma/client';
import { BusinessError } from '@/core/errors';
import { ErrorCode } from '@/core/errors/errorCodes';
import { getPrisma } from '@/core/prisma';
import { withTransaction } from '@/core/transaction';
import type { CreateAddressInput, UpdateAddressInput } from '@/validators/address.validator';

/** 简化的 Prisma 客户端形态（本服务只用到 address 委托） */
type DbClient = Pick<PrismaClient, 'address'>;

/** 地址不存在错误（11001 / HTTP 404） */
const ADDRESS_NOT_FOUND_OPTIONS = {
  code: ErrorCode.ADDRESS_NOT_FOUND,
  httpStatus: 404,
} as const;

/** 列表排序：默认地址排最前，其余按创建时间倒序（最近新增在前） */
const LIST_ORDER = { isDefault: 'desc' as const, createdAt: 'desc' as const };

/**
 * 收货地址服务。
 */
export class AddressService {
  /** 注入的 Prisma 客户端（单测可注入假实现打桩） */
  private readonly prisma: DbClient;

  /**
   * @param prisma Prisma 客户端，缺省时取全局单例
   */
  constructor(prisma: DbClient = getPrisma()) {
    this.prisma = prisma;
  }

  /**
   * 列表（只查未软删，默认地址排最前）。
   *
   * @description `where` 强制带 `userId` 与 `deletedAt: null`（越权防护 + 软删过滤）
   * @param userId 用户 ID（私有数据）
   * @returns 地址数组（含默认地址标记）
   */
  async list(userId: bigint): Promise<Address[]> {
    return this.prisma.address.findMany({
      where: { userId, deletedAt: null },
      orderBy: LIST_ORDER,
    });
  }

  /**
   * 取单条并校验归属（内部复用：修改/删除/设为默认前先确认「是我的且没被删」）。
   *
   * @description `where` 同时带 `id` 与 `userId` 与 `deletedAt: null`——
   * 即便调用方传入别人的 id，也只会命中「自己名下且有效」的记录，天然越权防护
   * @param userId 用户 ID（私有数据）
   * @param id 地址 ID
   * @returns 地址或 null
   */
  private findOwned(userId: bigint, id: bigint) {
    return this.prisma.address.findFirst({
      where: { id, userId, deletedAt: null },
    });
  }

  /**
   * 新增地址。
   *
   * @description 默认地址互斥（C 端经典规则）：
   * - `isDefault = true` 或 **该用户还没有任何地址（首个地址自动默认）** → 设为默认；
   * - 设为默认时**在事务内**先把其它有效地址 `isDefault` 置 false，再新建默认地址，
   *   保证「0 个或 2 个默认地址」的不一致不会因中途失败而出现。
   * @param userId 用户 ID（私有数据）
   * @param dto 新增字段
   * @returns 新建的地址
   * @throws {BusinessError} 地址不存在（11001，理论上新增不会触发，保留一致性）
   */
  async create(userId: bigint, dto: CreateAddressInput): Promise<Address> {
    const wantsDefault = dto.isDefault === true;
    // 先查现有有效地址数，判断是否需要「自动默认」（仅首个地址）
    const existingCount = await this.prisma.address.count({
      where: { userId, deletedAt: null },
    });
    const shouldBeDefault = wantsDefault || existingCount === 0;

    const baseData: Prisma.AddressUncheckedCreateInput = {
      userId,
      receiverName: dto.receiverName,
      phone: dto.phone,
      provinceCode: dto.provinceCode,
      provinceName: dto.provinceName,
      cityCode: dto.cityCode,
      cityName: dto.cityName,
      districtCode: dto.districtCode,
      districtName: dto.districtName,
      detailAddress: dto.detailAddress,
      tag: dto.tag ?? null,
    };

    if (!shouldBeDefault) {
      // 普通地址：直接建，isDefault=false
      return this.prisma.address.create({ data: { ...baseData, isDefault: false } });
    }

    // 需要成为默认：事务内「先取消旧的、再建新的」，原子
    return withTransaction(
      async (tx) => {
        await tx.address.updateMany({
          where: { userId, isDefault: true, deletedAt: null }, // 只取消同用户的有效默认
          data: { isDefault: false },
        });
        return tx.address.create({ data: { ...baseData, isDefault: true } });
      },
      { label: 'address.create' },
    );
  }

  /**
   * 修改地址。
   *
   * @description 步骤：
   * 1. 先 `findOwned` 取现有（带 userId）——不存在即越权/误删场景 → 11001；
   * 2. 若 `isDefault = true`：事务内先取消其它默认，再把本条置 true；
   *    否则只更新传了的字段（不含 isDefault 时保持原值）。
   * @param userId 用户 ID（私有数据）
   * @param id 地址 ID
   * @param dto 待更新字段（全可选，但至少传一个，由 validator 保证）
   * @returns 更新后的地址
   * @throws {BusinessError} 地址不存在（11001）
   */
  async update(userId: bigint, id: bigint, dto: UpdateAddressInput): Promise<Address> {
    // 1. 越权防护：带 userId 取现有，null 即「不是我的 / 已删」→ 直接拒
    const existing = await this.findOwned(userId, id);
    if (existing === null) {
      throw new BusinessError('收货地址不存在', ADDRESS_NOT_FOUND_OPTIONS);
    }

    // 逐字段搬运「传了的字段」，未传的保持原值（isDefault 单独处理，避免 undefined 误写）
    const data: Prisma.AddressUpdateInput = {};
    if (dto.receiverName !== undefined) data.receiverName = dto.receiverName;
    if (dto.phone !== undefined) data.phone = dto.phone;
    if (dto.provinceCode !== undefined) data.provinceCode = dto.provinceCode;
    if (dto.provinceName !== undefined) data.provinceName = dto.provinceName;
    if (dto.cityCode !== undefined) data.cityCode = dto.cityCode;
    if (dto.cityName !== undefined) data.cityName = dto.cityName;
    if (dto.districtCode !== undefined) data.districtCode = dto.districtCode;
    if (dto.districtName !== undefined) data.districtName = dto.districtName;
    if (dto.detailAddress !== undefined) data.detailAddress = dto.detailAddress;
    if (dto.tag !== undefined) data.tag = dto.tag;
    if (dto.isDefault !== undefined) data.isDefault = dto.isDefault;

    if (dto.isDefault === true) {
      // 设为默认：事务内先取消其它默认，再置本条为默认
      return withTransaction(
        async (tx) => {
          await tx.address.updateMany({
            where: { userId, isDefault: true, deletedAt: null, id: { not: id } }, // 排除自己
            data: { isDefault: false },
          });
          return tx.address.update({ where: { id, userId }, data: { ...data, isDefault: true } });
        },
        { label: 'address.update.setDefault' },
      );
    }

    // 普通修改：只更新传了的字段，isDefault 保持原值（data 不含则不动）
    return this.prisma.address.update({ where: { id, userId }, data });
  }

  /**
   * 删除地址（软删），默认地址自动递补。
   *
   * @description 删除默认地址时的策略（产品裁定，设计文档未明确）：
   * - 删掉的是默认地址、且用户**还有其它有效地址** → **自动把最近创建的一个递补为默认**；
   * - 删掉的是默认地址且是**最后一个** → 直接删（已无地址可递补）；
   * - 非默认地址 → 直接软删。
   *
   * 为什么不采用「拒绝删除、要求用户先切换默认」：
   * 那会强迫用户做两步操作（先 setDefault 再 remove），而主流电商（淘宝/京东）都是
   * 删除后自动递补。自动递补同样能保证「有地址就必有默认地址」这一不变量，
   * 且不会让结算页陷入「有地址却没有默认」的歧义状态。
   *
   * **递补必须在事务内**：软删与置默认若分开执行，中途失败会留下「0 个默认地址」的不一致。
   *
   * 软删=更新 `deletedAt`，绝不物理 delete；所有 `where` 带 userId（越权防护）。
   *
   * @param userId 用户 ID（私有数据）
   * @param id 地址 ID
   * @returns 软删后的地址（含 deletedAt）
   * @throws {BusinessError} 地址不存在（11001）
   */
  async remove(userId: bigint, id: bigint): Promise<Address> {
    // 越权防护：带 userId 取现有
    const existing = await this.findOwned(userId, id);
    if (existing === null) {
      throw new BusinessError('收货地址不存在', ADDRESS_NOT_FOUND_OPTIONS);
    }

    // 删的不是默认地址：直接软删，不影响默认归属
    if (!existing.isDefault) {
      return this.prisma.address.update({
        where: { id, userId },
        data: { deletedAt: new Date() },
      });
    }

    // 删的是默认地址：事务内「软删 + 递补最近的一个」，保证原子
    return withTransaction(
      async (tx) => {
        const removed = await tx.address.update({
          where: { id, userId },
          data: { deletedAt: new Date(), isDefault: false },
        });

        // 递补：取其余有效地址中最近创建的一个（createdAt 倒序第一条）
        const successor = await tx.address.findFirst({
          where: { userId, deletedAt: null, id: { not: id } },
          orderBy: { createdAt: 'desc' },
          select: { id: true },
        });
        if (successor !== null) {
          await tx.address.update({
            where: { id: successor.id, userId },
            data: { isDefault: true },
          });
        }

        return removed;
      },
      { label: 'address.remove' },
    );
  }

  /**
   * 设为默认地址。
   *
   * @description 事务内「先取消其它默认（排除自己）、再置本条为默认」，保证互斥原子性。
   * @param userId 用户 ID（私有数据）
   * @param id 地址 ID
   * @returns 更新后的地址（isDefault = true）
   * @throws {BusinessError} 地址不存在（11001）
   */
  async setDefault(userId: bigint, id: bigint): Promise<Address> {
    // 越权防护：带 userId 取现有，null 即拒
    const existing = await this.findOwned(userId, id);
    if (existing === null) {
      throw new BusinessError('收货地址不存在', ADDRESS_NOT_FOUND_OPTIONS);
    }

    return withTransaction(
      async (tx) => {
        await tx.address.updateMany({
          where: { userId, isDefault: true, deletedAt: null, id: { not: id } }, // 排除自己
          data: { isDefault: false },
        });
        return tx.address.update({
          where: { id, userId },
          data: { isDefault: true },
        });
      },
      { label: 'address.setDefault' },
    );
  }
}

/** 默认单例（供 Controller 直接消费） */
export const addressService = new AddressService();
export default addressService;
