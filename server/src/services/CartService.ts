/**
 * @file server/src/services/CartService.ts
 * @description 购物车领域服务：加购 / 列表实时校验 / 改数量 / 删除 / 未登录合并
 * @module services
 * @see docs/04-flows.md:293（F4 购物车）、prisma/schema.prisma（CartItem 模型）
 * @author 软件开发团队
 * @created 2026-09-07
 *
 * 分层铁律：本服务承载购物车全部业务规则（上限 / 失效判定 / 金额服务端重算），
 * Prisma 只通过 {@link CartRepository} 出现，Controller 禁止直接写查询。
 *
 * 安全约束（与 docs/04-flows.md 一致）：
 * - **所有查询都带 userId**：购物车是私有数据，漏条件即越权；
 * - **绝不返回 `costPrice`**：成本价仅后台可见，列表查询的 select 已排除；
 * - **金额一律 bigint（分）**：`totalAmount` 用当前 SKU 价重算，不信任前端快照；
 * - **不信任上游**：控制器已校验 quantity，这里再兜底一次。
 */

import type { PrismaClient } from '@prisma/client';
import { ProductStatus, SkuStatus } from '@prisma/client';
import { BusinessError, ConflictError } from '@/core/errors';
import { ErrorCode, getErrorMeta } from '@/core/errors/errorCodes';
import { getPrisma } from '@/core/prisma';
import { CartRepository, type CartItemListRow, type CartItemRow, type CartSkuCheckRow } from '@/repositories/CartRepository';

/** 简化的 Prisma 客户端形态（本服务只用到 cartItem / sku 两个委托） */
type DbClient = Pick<PrismaClient, 'cartItem' | 'sku'>;

/** 单 SKU 数量上限（分桶用，CART-06） */
const MAX_PER_SKU = 999;
/** 购物车总条目上限（CART-06） */
const MAX_ITEMS = 100;

/** SKU 不存在错误参数（21002，HTTP 404，沿用错误码表登记的语义） */
const SKU_NOT_FOUND_OPTIONS = {
  code: ErrorCode.SKU_NOT_FOUND,
  httpStatus: getErrorMeta(ErrorCode.SKU_NOT_FOUND).httpStatus,
} as const;

/** 商品已下架 / 不存在错误参数（21001，HTTP 404） */
const PRODUCT_NOT_FOUND_OPTIONS = {
  code: ErrorCode.PRODUCT_NOT_FOUND,
  httpStatus: getErrorMeta(ErrorCode.PRODUCT_NOT_FOUND).httpStatus,
} as const;

/** 库存不足错误参数（50001，HTTP 409，冲突类） */
const STOCK_NOT_ENOUGH_OPTIONS = {
  code: ErrorCode.STOCK_NOT_ENOUGH,
  httpStatus: getErrorMeta(ErrorCode.STOCK_NOT_ENOUGH).httpStatus,
} as const;

/** 购物车条目不存在错误参数（30001，HTTP 404） */
const CART_ITEM_NOT_FOUND_OPTIONS = {
  code: ErrorCode.CART_ITEM_NOT_FOUND,
  httpStatus: getErrorMeta(ErrorCode.CART_ITEM_NOT_FOUND).httpStatus,
} as const;

/** 条目失效原因（用于前端角标与结算拦截） */
export type CartInvalidReason =
  | 'DELETED' // SKU 或商品已软删
  | 'SKU_DISABLED' // SKU 已停用
  | 'PRODUCT_OFF_SALE' // 商品已下架
  | 'STOCK_NOT_ENOUGH'; // 可用库存 < 数量

/** 列表接口单条视图（已做失效 / 价格变动标注） */
export interface CartItemView {
  id: bigint;
  skuId: bigint;
  quantity: number;
  selected: boolean;
  /** 加购时快照价（分） */
  priceSnapshot: bigint;
  /** 当前 SKU 售价（分），用于「价格已变动」与结算重算 */
  price: bigint;
  skuStatus: SkuStatus;
  /** 实时可用库存（仅用于展示，结算以下单时重校验为准） */
  available: number;
  /** 是否失效（失效项禁止结算） */
  invalid: boolean;
  /** 失效原因；有效项为 null */
  invalidReason: CartInvalidReason | null;
  /** 当前价 != 快照价（提示「价格已变动」） */
  priceChanged: boolean;
}

/** 列表返回：有效 / 失效分组 + 仅勾选且有效项的合计（分） */
export interface CartListResult {
  valid: CartItemView[];
  invalid: CartItemView[];
  /** 金额（分，bigint），只累加 `selected && !invalid` 的条目，按当前价算 */
  totalAmount: bigint;
}

/** 未登录购物车合并的单条入参 */
export interface GuestCartItem {
  skuId: bigint;
  quantity: number;
}

/** 合并结果：成功并入的条目数 + 被跳过的条目及原因 */
export interface MergeResult {
  merged: number;
  skipped: { skuId: bigint; reason: CartInvalidReason | 'QUANTITY_INVALID' }[];
}

/**
 * 购物车服务。
 */
export class CartService {
  /** 注入的购物车仓储（所有 DB 访问经由此层） */
  private readonly repo: CartRepository;

  /**
   * @param prisma Prisma 客户端，缺省时取全局单例（仅用于构造默认仓储）
   * @param repo 购物车仓储，缺省时基于注入的 prisma 构造
   */
  constructor(prisma: DbClient = getPrisma(), repo?: CartRepository) {
    // 仓储复用同一份 prisma，保证事务 / mock 边界一致
    this.repo = repo ?? new CartRepository(prisma);
  }

  /**
   * 加购。
   *
   * @description 时序见 docs/04-flows.md:307：
   * 1. 兜底校验 `quantity ∈ [1, 999]`（别信任上游）；
   * 2. 校验 SKU / 商品状态：SKU 缺失或软删 / 停用 → 21002；商品下架或软删 → 21001；
   * 3. `available < quantity` → 库存不足（ConflictError 50001）；
   * 4. 单 SKU ≤ 999、总条目 ≤ 100 上限；
   * 5. upsert 累加（同 SKU 不增行），写入 `priceSnapshot = sku.price`。
   * @param userId 用户 ID（私有数据，所有查询都带它）
   * @param skuId SKU ID
   * @param quantity 加购数量
   * @returns 写入后的购物车条目
   * @throws {BusinessError} SKU 不存在 / 商品下架 / 超上限（21002 / 21001 / 30003 / 30004）
   * @throws {ConflictError} 库存不足（50001）
   */
  async addItem(userId: bigint, skuId: bigint, quantity: number): Promise<CartItemRow> {
    // 1. 兜底校验（控制器已校验，这里再拦一次）
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new BusinessError('数量必须大于 0', { code: ErrorCode.CART_QUANTITY_INVALID });
    }
    if (quantity > MAX_PER_SKU) {
      throw new BusinessError('单个 SKU 数量不可超过 999', { code: ErrorCode.CART_ITEM_QUANTITY_LIMIT });
    }

    // 2. 校验 SKU / 商品状态与库存（断言通过即窄化为非空且可售）
    const sku = this.assertSkuSellable(await this.repo.findSkuForAdd(skuId));

    const available = sku.stock?.available ?? 0;
    if (available < quantity) {
      // 3. 库存不足：冲突类错误，提示「请刷新后重试」
      throw new ConflictError('库存不足', STOCK_NOT_ENOUGH_OPTIONS);
    }

    // 4. 上限校验
    const existing = await this.repo.findByUserSku(userId, skuId);
    if (existing !== null) {
      // 同 SKU 累加：累加后超过单 SKU 上限 → 拒绝（已写入的条目不被修改）
      if (existing.quantity + quantity > MAX_PER_SKU) {
        throw new BusinessError('单个 SKU 数量不可超过 999', { code: ErrorCode.CART_ITEM_QUANTITY_LIMIT });
      }
      // 5. 累加不增行（update: { quantity: { increment } }）
      return this.repo.addOrIncrement(userId, skuId, quantity, sku.price);
    }

    // 新 SKU：校验总条目上限（注意是「+1」后才判断）
    const count = await this.repo.countByUser(userId);
    if (count >= MAX_ITEMS) {
      throw new BusinessError('购物车条目不可超过 100 条', { code: ErrorCode.CART_ITEM_COUNT_LIMIT });
    }
    // 5. 首次插入（写入价格快照）
    return this.repo.addOrIncrement(userId, skuId, quantity, sku.price);
  }

  /**
   * 断言 SKU 当前可售（存在且未软删、未停用、所属商品在售且未软删）。
   *
   * @description 错误码选择（docs/04-flows.md:315 允许二选一）：
   * - SKU 缺失 / 软删 / 停用 → `SKU_NOT_FOUND (21002)`：对买家而言「这个 SKU 买不了」等同于不存在；
   * - 商品下架 / 软删 → `PRODUCT_NOT_FOUND (21001)`：商品维度不可售，与「商品不存在」同语义。
   * @param sku SKU 校验投影
   * @throws {BusinessError} SKU 不可售（21002）/ 商品下架（21001）
   */
  private assertSkuSellable(sku: CartSkuCheckRow | null): CartSkuCheckRow {
    if (sku === null || sku.deletedAt !== null) {
      throw new BusinessError('SKU 不存在', SKU_NOT_FOUND_OPTIONS);
    }
    if (sku.status === SkuStatus.DISABLED) {
      throw new BusinessError('SKU 已停用', SKU_NOT_FOUND_OPTIONS);
    }
    if (sku.product.deletedAt !== null || sku.product.status === ProductStatus.OFF_SALE) {
      throw new BusinessError('商品已下架', PRODUCT_NOT_FOUND_OPTIONS);
    }
    return sku;
  }

  /**
   * 购物车列表 + 实时有效性校验。
   *
   * @description 逐条判定（CART-03）：失效 ∈ {商品下架, SKU 停用, 库存不足, 已删除} → 标记 `invalid`，
   * 禁止结算；`price != price_snapshot` → `priceChanged = true`，前端显示「价格已变动」。
   * `totalAmount` 只累加 `selected && !invalid` 的条目，金额用**当前 SKU 价**重算（不信任快照）。
   * @param userId 用户 ID（私有数据）
   * @returns 有效 / 失效分组 + 勾选有效项合计（分）
   */
  async listWithValidation(userId: bigint): Promise<CartListResult> {
    const rows: CartItemListRow[] = await this.repo.listByUser(userId);

    const valid: CartItemView[] = [];
    const invalid: CartItemView[] = [];
    let totalAmount = 0n;

    for (const row of rows) {
      const sku = row.sku;
      const product = sku.product;
      const available = sku.stock?.available ?? 0;

      // 失效判定（CART-03）：先软删，再状态，最后库存
      let invalidReason: CartInvalidReason | null = null;
      if (sku.deletedAt !== null || product.deletedAt !== null) {
        invalidReason = 'DELETED';
      } else if (sku.status === SkuStatus.DISABLED) {
        invalidReason = 'SKU_DISABLED';
      } else if (product.status === ProductStatus.OFF_SALE) {
        invalidReason = 'PRODUCT_OFF_SALE';
      } else if (available < row.quantity) {
        invalidReason = 'STOCK_NOT_ENOUGH';
      }

      // 价格变动：当前价 != 加购快照价
      const priceChanged = sku.price !== row.priceSnapshot;

      const view: CartItemView = {
        id: row.id,
        skuId: row.skuId,
        quantity: row.quantity,
        selected: row.selected,
        priceSnapshot: row.priceSnapshot,
        price: sku.price,
        skuStatus: sku.status,
        available,
        invalid: invalidReason !== null,
        invalidReason,
        priceChanged,
      };

      if (invalidReason !== null) {
        invalid.push(view);
        continue;
      }

      valid.push(view);
      // totalAmount 只累加勾选且有效的条目，金额用当前价重算（以后端为准）
      if (row.selected) {
        totalAmount += sku.price * BigInt(row.quantity);
      }
    }

    return { valid, invalid, totalAmount };
  }

  /**
   * 改数量 / 勾选。
   *
   * @description `quantity` 越界（<1 或 >999）→ 30002 / 30003；`quantity > 可用库存` → 库存不足（50001）。
   * where 带 userId，越权防护；原记录只在校验通过后写入
   * @param userId 用户 ID（私有数据）
   * @param id 条目 ID
   * @param dto 待更新字段
   * @returns 更新后的条目
   * @throws {BusinessError} 条目不存在（30001）/ 数量非法（30002 / 30003）
   * @throws {ConflictError} 库存不足（50001）
   */
  async update(userId: bigint, id: bigint, dto: { quantity?: number; selected?: boolean }): Promise<CartItemRow> {
    if (dto.quantity !== undefined) {
      if (!Number.isInteger(dto.quantity) || dto.quantity < 1) {
        throw new BusinessError('数量必须大于 0', { code: ErrorCode.CART_QUANTITY_INVALID });
      }
      if (dto.quantity > MAX_PER_SKU) {
        throw new BusinessError('单个 SKU 数量不可超过 999', { code: ErrorCode.CART_ITEM_QUANTITY_LIMIT });
      }
    }

    // 先取现有条目（带 userId），不存在即越权/误删场景
    const existing = await this.repo.findById(userId, id);
    if (existing === null) {
      throw new BusinessError('购物车条目不存在', CART_ITEM_NOT_FOUND_OPTIONS);
    }

    // 改数量时校验库存：库存不足不改写原记录
    if (dto.quantity !== undefined) {
      const available = existing.sku.stock?.available ?? 0;
      if (available < dto.quantity) {
        throw new ConflictError('库存不足', STOCK_NOT_ENOUGH_OPTIONS);
      }
    }

    return this.repo.update(userId, id, dto);
  }

  /**
   * 删除购物车条目。
   *
   * @description where 同时带 `id(in)` 与 `userId`，越权防护；返回实际删除条数
   * @param userId 用户 ID（私有数据）
   * @param ids 待删除条目 ID 列表
   * @returns 实际删除条数
   */
  async remove(userId: bigint, ids: bigint[]): Promise<number> {
    return this.repo.remove(userId, ids);
  }

  /**
   * 合并未登录购物车（登录后调用）。
   *
   * @description 逐条处理（docs/04-flows.md:337）：
   * - 同 SKU 先按 guest 列表聚合，再与服务端已有数量累加，**封顶 999**（`LEAST(已有 + 新增, 999)`）；
   * - SKU 失效（缺失 / 软删 / 停用 / 商品下架）/ 库存不足 / 数量非法 → 进 `skipped`，reason 明确，不写入；
   * - 返回 `{ merged, skipped }`。
   *
   * ⚠️ 关于事务：每条 `mergeSet` 是原子的 `ON DUPLICATE KEY UPDATE`（单 SKU 不增行），
   * 本方法在应用层逐条下发；真正的「整批合并包进一个事务」由上层（Controller / 下单编排）按需包裹
   * `prisma.$transaction`，避免领域服务直接依赖 `$transaction` 类型而难以打桩。逐条 upsert 是幂等的，
   * 重复合并不会重复扣减
   * @param userId 用户 ID（私有数据）
   * @param items 未登录购物车条目列表
   * @returns 合并结果
   */
  async mergeGuestCart(userId: bigint, items: GuestCartItem[]): Promise<MergeResult> {
    const skipped: MergeResult['skipped'] = [];
    let merged = 0;

    // 先按 skuId 聚合 guest 列表（同一 SKU 多行先累加）
    const bySku = new Map<bigint, number>();
    for (const item of items) {
      if (!Number.isInteger(item.quantity) || item.quantity < 1) {
        skipped.push({ skuId: item.skuId, reason: 'QUANTITY_INVALID' });
        continue;
      }
      bySku.set(item.skuId, (bySku.get(item.skuId) ?? 0) + item.quantity);
    }

    for (const [skuId, guestQty] of bySku) {
      const sku = await this.repo.findSkuForAdd(skuId);

      // 失效判定（与 addItem 同语义）：SKU 缺失/软删/停用 → SKU_INVALID；商品下架/软删 → PRODUCT_INVALID
      if (sku === null || sku.deletedAt !== null || sku.status === SkuStatus.DISABLED) {
        skipped.push({ skuId, reason: 'SKU_DISABLED' });
        continue;
      }
      if (sku.product.deletedAt !== null || sku.product.status === ProductStatus.OFF_SALE) {
        skipped.push({ skuId, reason: 'PRODUCT_OFF_SALE' });
        continue;
      }

      const available = sku.stock?.available ?? 0;
      if (available < guestQty) {
        skipped.push({ skuId, reason: 'STOCK_NOT_ENOUGH' });
        continue;
      }

      // 累加并封顶 999（应用层先算好绝对值，再交给仓库 set）
      const existing = await this.repo.findByUserSku(userId, skuId);
      const newQty = Math.min((existing?.quantity ?? 0) + guestQty, MAX_PER_SKU);
      await this.repo.mergeSet(userId, skuId, newQty, sku.price);
      merged += 1;
    }

    return { merged, skipped };
  }
}

/** 默认单例（供 Controller 直接消费） */
export const cartService = new CartService();
export default cartService;
