/**
 * @file server/src/services/PayPasswordService.ts
 * @description 支付密码服务：校验 / 是否已设置 / 首次设置 / 修改（复用 utils/hash）
 * @module services
 * @see server/src/middlewares/balancePassword.ts（setPayPasswordHandlers 注入点）、
 *      docs/03-database.md §3.11（pay_password_hash）、docs/12-phase12-plan.md（T070）
 * @author 软件开发团队
 * @created 2026-09-20
 *
 * 分层铁律：本服务直连 `users` 表，但**不**走 AuthService —— AuthService 故意在
 * `toUserPayload` 中排除 `payPasswordHash`（设计上不为登录链路暴露该字段），
 * 因此支付密码的读写单独成服务，避免污染登录态逻辑。
 *
 * 存储：bcrypt(sha256(plain), cost=12)，与登录密码同一套哈希工具（utils/hash），
 * 规避 bcrypt 72 字节截断。强度校验复用 `isPasswordStrong`（8~64 位且含字母 + 数字）。
 *
 * 与 balancePassword 中间件的分工：
 * - 中间件负责「校验顺序编排」（锁定 → 已设 → 比对）与**失败计数（Redis）**；
 * - 本服务只负责「对库读写 pay_password_hash」这一件事，不直接碰 Redis。
 */

import type { PrismaClient } from '@prisma/client';
import { BusinessError } from '@/core/errors';
import { ErrorCode } from '@/core/errors/errorCodes';
import { getPrisma } from '@/core/prisma';
import { comparePassword, hashPassword, isPasswordStrong } from '@/utils/hash';

/** 简化的 Prisma 客户端形态（只用到 user 委托） */
type DbClient = Pick<PrismaClient, 'user'>;

/**
 * 支付密码服务。
 */
export class PayPasswordService {
  /** 注入的 Prisma 客户端 */
  private readonly prisma: DbClient;

  /**
   * @param prisma Prisma 客户端，缺省时取全局单例
   */
  constructor(prisma: DbClient = getPrisma()) {
    this.prisma = prisma;
  }

  /**
   * 校验支付密码。
   *
   * @description 由 balancePassword 中间件 verifier 调用。**只认库里的哈希，不抛异常**：
   * 用户不存在 / 未设置密码 → 返回 false（让中间件走对应的业务错误码）。
   * @param userId 用户 ID（number，来自 AuthPrincipal）
   * @param plain 明文支付密码
   * @returns 是否匹配
   */
  async verify(userId: number, plain: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { id: BigInt(userId) },
      select: { payPasswordHash: true },
    });
    if (user === null || user.payPasswordHash === null) {
      return false;
    }
    return comparePassword(plain, user.payPasswordHash);
  }

  /**
   * 是否已设置支付密码。
   *
   * @description 由 balancePassword 中间件 checker 调用，决定「未设置 → 引导设置」分支。
   * @param userId 用户 ID
   * @returns 已设置返回 true
   */
  async hasPassword(userId: number): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { id: BigInt(userId) },
      select: { payPasswordHash: true },
    });
    return user !== null && user.payPasswordHash !== null;
  }

  /**
   * 首次设置支付密码。
   *
   * @description 已设置则拒绝（必须走 modify），避免「不验旧密码就覆盖」的越权改密。
   * @param userId 用户 ID
   * @param plain 明文支付密码（强度在此校验）
   * @returns void
   * @throws {BusinessError} 密码强度不足 / 已设置（61011）/ 账号不存在（10012）
   */
  async set(userId: number, plain: string): Promise<void> {
    if (!isPasswordStrong(plain)) {
      throw new BusinessError('支付密码需为 8~64 位且同时包含字母和数字', {
        code: ErrorCode.PAY_PASSWORD_INCORRECT,
      });
    }

    const existing = await this.prisma.user.findUnique({
      where: { id: BigInt(userId) },
      select: { payPasswordHash: true },
    });
    if (existing === null) {
      throw new BusinessError('账号不存在', { code: ErrorCode.USER_NOT_FOUND });
    }
    if (existing.payPasswordHash !== null) {
      throw new BusinessError('支付密码已设置，请使用修改接口', { code: ErrorCode.PAY_PASSWORD_ALREADY_SET });
    }

    const passwordHash = await hashPassword(plain);
    await this.prisma.user.update({
      where: { id: BigInt(userId) },
      data: { payPasswordHash: passwordHash },
    });
  }

  /**
   * 修改支付密码。
   *
   * @description 必须先校验原密码（防越权改密），再写入新哈希。
   * @param userId 用户 ID
   * @param oldPlain 原明文支付密码
   * @param newPlain 新明文支付密码（强度在此校验）
   * @returns void
   * @throws {BusinessError} 未设置（61009）/ 原密码错误（61007）/ 新密码强度不足 / 账号不存在（10012）
   */
  async modify(userId: number, oldPlain: string, newPlain: string): Promise<void> {
    if (!isPasswordStrong(newPlain)) {
      throw new BusinessError('支付密码需为 8~64 位且同时包含字母和数字', {
        code: ErrorCode.PAY_PASSWORD_INCORRECT,
      });
    }

    const user = await this.prisma.user.findUnique({
      where: { id: BigInt(userId) },
      select: { payPasswordHash: true },
    });
    if (user === null) {
      throw new BusinessError('账号不存在', { code: ErrorCode.USER_NOT_FOUND });
    }
    if (user.payPasswordHash === null) {
      throw new BusinessError('未设置支付密码，请先设置', { code: ErrorCode.PAY_PASSWORD_NOT_SET });
    }

    const oldMatched = await comparePassword(oldPlain, user.payPasswordHash);
    if (!oldMatched) {
      throw new BusinessError('原支付密码错误', { code: ErrorCode.PAY_PASSWORD_INCORRECT });
    }

    const newHash = await hashPassword(newPlain);
    await this.prisma.user.update({
      where: { id: BigInt(userId) },
      data: { payPasswordHash: newHash },
    });
  }
}

/** 默认单例 */
export const payPasswordService = new PayPasswordService();

export default payPasswordService;
