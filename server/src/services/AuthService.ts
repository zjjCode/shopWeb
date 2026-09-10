/**
 * @file server/src/services/AuthService.ts
 * @description C 端认证服务：注册 / 登录 / 登出 / 刷新 / 资料（shop 作用域）
 * @module services
 * @see docs/04-flows.md F1（注册/登录/刷新/登出时序）、docs/02-architecture.md §7.1
 * @see docs/03-database.md §1.3（userBalanceAccountNo）、§3.x（注册同事务开户 事务 H）
 * @author 软件开发团队
 * @created 2026-09-05
 *
 * 安全设计说明：
 * - **账号枚举防护**：用户不存在与密码错误统一返回 `10003 账号或密码错误`，绝不区分。
 * - **失败锁定走 Redis**（与后台走 DB 字段不同，详见 T010 设计裁定）：
 *   同一手机号累计 5 次失败锁定 15 分钟；无 Redis 实例时降级为不锁定（不阻塞主流程）。
 * - **注册同事务开户**：注册时在一个事务内同时创建 `users` 与 `USER_BALANCE` 资金账户，
 *   否则后续余额/充值/支付全线无账户可用。此点与 F1 时序图「漏画开户步骤」存在文档矛盾，
 *   按 `docs/03-database.md:2275` 的明确要求执行（详见 docs/07 开发流程记录 log-009）。
 */

import type { PrismaClient } from '@prisma/client';
import { AccountStatus, FundAccountType, SubjectType, UserRole, UserStatus } from '@prisma/client';
import { config } from '@/config';
import { AuthError, ConflictError, RateLimitError } from '@/core/errors';
import { ErrorCode } from '@/core/errors/errorCodes';
import { getPrisma } from '@/core/prisma';
import { getRedis } from '@/core/redis';
import { withTransaction } from '@/core/transaction';
import { sha256Hex } from '@/utils/crypto';
import { comparePassword, hashPassword } from '@/utils/hash';
import { userBalanceAccountNo } from '@/core/idGenerator';
import { tokenService } from './TokenService';

/** 注册入参 */
export interface RegisterInput {
  /** 手机号（中国大陆） */
  phone: string;
  /** 明文密码 */
  password: string;
  /** 昵称 */
  nickname: string;
}

/** 登录入参 */
export interface LoginInput {
  /** 手机号 */
  phone: string;
  /** 明文密码 */
  password: string;
}

/** 请求元数据（IP / UA，审计与限流用） */
export interface AuthMeta {
  /** 客户端 IP */
  ip?: string | null;
  /** User-Agent */
  userAgent?: string | null;
}

/** 对外返回的脱敏用户对象（绝不携带 passwordHash 等敏感字段） */
export interface UserPayload {
  id: string;
  phone: string;
  nickname: string;
  role: string;
  status: string;
  lastLoginAt: Date | null;
  createdAt: Date;
}

/** 注册 / 登录结果 */
export interface AuthResult extends UserPayload {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

/** 简化的 Prisma 客户端形态（登出时还需按哈希定位 refresh token 记录） */
type DbClient = Pick<PrismaClient, 'user' | 'fundAccount' | 'refreshToken'>;

/** 登录失败锁定窗口（毫秒）：15 分钟 */
const LOGIN_LOCK_WINDOW_MS = 15 * 60 * 1000;
/** 登录失败锁定阈值 */
const LOGIN_MAX_FAILS = 5;
/** 失败计数窗口（与锁定窗口一致，便于计数自然过期） */
const FAIL_WINDOW_SECONDS = 900;

/**
 * C 端认证服务。
 */
export class AuthService {
  /** 注入的 Prisma 客户端 */
  private readonly prisma: DbClient;

  /**
   * @param prisma Prisma 客户端，缺省时取全局单例
   */
  constructor(prisma: DbClient = getPrisma()) {
    this.prisma = prisma;
  }

  /**
   * 用户注册。
   *
   * @description 事务内创建 `users` + `USER_BALANCE` 资金账户；事务提交后再签发 token
   * @param input 注册入参
   * @param meta 请求元数据
   * @returns 脱敏用户信息与 token 对
   * @throws {ConflictError} 10002 手机号已注册
   */
  async register(input: RegisterInput, meta: AuthMeta = {}): Promise<AuthResult> {
    const existing = await this.prisma.user.findUnique({ where: { phone: input.phone } });
    if (existing !== null) {
      throw new ConflictError('手机号已注册', { code: ErrorCode.PHONE_REGISTERED });
    }

    const passwordHash = await hashPassword(input.password);

    const user = await withTransaction(
      async (tx) => {
        const created = await tx.user.create({
          data: {
            phone: input.phone,
            passwordHash,
            nickname: input.nickname,
            role: UserRole.USER,
            status: UserStatus.ACTIVE,
            tokenVersion: 1,
          },
        });
        // 同事务开户（事务 H）：每用户 1 条 USER_BALANCE 账户
        // 注：F1 时序图漏画此步，按 docs/03-database.md:2275 执行
        await tx.fundAccount.create({
          data: {
            accountNo: userBalanceAccountNo(created.id),
            accountType: FundAccountType.USER_BALANCE,
            userId: created.id,
            name: '用户余额账户',
            currency: 'CNY',
            balance: BigInt(0),
            frozenBalance: BigInt(0),
            totalIn: BigInt(0),
            totalOut: BigInt(0),
            status: AccountStatus.ACTIVE,
          },
        });
        return created;
      },
      { label: 'auth.register' },
    );

    const pair = await tokenService.issueTokenPair(
      { subjectType: SubjectType.USER, subjectId: user.id, role: UserRole.USER, tokenVersion: user.tokenVersion },
      'shop',
      { userAgent: meta.userAgent, ip: meta.ip },
    );

    return { ...this.toUserPayload(user), ...pair };
  }

  /**
   * 用户登录。
   *
   * @description 防账号枚举（统一 10003）；失败走 Redis 计数，5 次锁定 15 分钟；
   * 成功后清计数、更新登录时间和 IP，再签发 token
   * @param input 登录入参
   * @param meta 请求元数据
   * @returns 脱敏用户信息与 token 对
   * @throws {AuthError} 10003 账号或密码错误 / 10004 账号已禁用 / 10011 锁定
   */
  async login(input: LoginInput, meta: AuthMeta = {}): Promise<AuthResult> {
    await this.assertNotLocked(input.phone);

    const user = await this.prisma.user.findUnique({ where: { phone: input.phone } });
    const passwordOk = user !== null ? await comparePassword(input.password, user.passwordHash) : false;

    if (user === null || !passwordOk) {
      // 无论用户是否存在都计数，避免攻击者借此探测手机号是否已注册
      await this.registerFail(input.phone);
      throw AuthError.unauthorized('账号或密码错误', ErrorCode.BAD_CREDENTIALS);
    }

    if (user.status !== UserStatus.ACTIVE) {
      throw AuthError.forbidden('账号已被禁用', ErrorCode.ACCOUNT_DISABLED);
    }

    await this.clearFails(input.phone);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date(), lastLoginIp: meta.ip ?? null },
    });

    const pair = await tokenService.issueTokenPair(
      { subjectType: SubjectType.USER, subjectId: user.id, role: UserRole.USER, tokenVersion: user.tokenVersion },
      'shop',
      { userAgent: meta.userAgent, ip: meta.ip },
    );

    return { ...this.toUserPayload(user), ...pair };
  }

  /**
   * 刷新 token（委派 TokenService 轮换）。
   *
   * @param refreshToken refresh token 明文
   * @returns 新的 token 对
   */
  async refresh(refreshToken: string): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    return tokenService.rotate(refreshToken, 'shop');
  }

  /**
   * 登出。
   *
   * @description 吊销当前 familyId 下所有 refresh token **且** tokenVersion++，
   * 二者缺一不可（只吊销 refresh 的话 2h 内已签发的 access token 仍可用）
   * @param userId 用户 ID（取自 access token 主体）
   * @param refreshToken 当前 refresh token 明文（用于定位 familyId），可空
   * @returns void
   */
  async logout(userId: number | bigint, refreshToken?: string): Promise<void> {
    if (typeof refreshToken === 'string' && refreshToken.length > 0) {
      const tokenHash = sha256Hex(refreshToken);
      const record = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });
      if (record !== null && record.subjectType === SubjectType.USER) {
        await tokenService.revokeFamily(record.familyId);
      }
    }
    await tokenService.bumpTokenVersion({ scope: 'shop', userId });
  }

  /**
   * 获取当前用户资料（脱敏）。
   *
   * @param userId 用户 ID
   * @returns 脱敏用户对象
   * @throws {AuthError} 账号不存在
   */
  async getProfile(userId: number | bigint): Promise<UserPayload> {
    const user = await this.prisma.user.findUnique({ where: { id: BigInt(userId) } });
    if (user === null) {
      throw AuthError.unauthorized('账号不存在', ErrorCode.BAD_CREDENTIALS);
    }
    return this.toUserPayload(user);
  }

  /**
   * 将 user 记录脱敏为对外对象。
   *
   * @description 显式挑选字段，绝不包含 passwordHash / payPasswordHash / tokenVersion 等敏感或内部字段
   * @param user Prisma user 记录
   * @returns 脱敏对象
   */
  private toUserPayload(user: {
    id: bigint;
    phone: string;
    nickname: string;
    role: string;
    status: string;
    lastLoginAt: Date | null;
    createdAt: Date;
  }): UserPayload {
    return {
      id: String(user.id),
      phone: user.phone,
      nickname: user.nickname,
      role: user.role,
      status: user.status,
      lastLoginAt: user.lastLoginAt,
      createdAt: user.createdAt,
    };
  }

  // --------------------------------------------------------------------------
  // 失败锁定（Redis 实现，与后台 DB 字段实现不同）
  // --------------------------------------------------------------------------

  /**
   * 断言手机号未被锁定。
   *
   * @description 无 Redis 实例时降级为放行（不阻塞登录流程）
   * @param phone 手机号
   * @throws {RateLimitError} 10011 已锁定
   */
  private async assertNotLocked(phone: string): Promise<void> {
    const redis = getRedis();
    if (redis === null) {
      return;
    }
    const lockKey = this.lockKey(phone);
    const ttl = await redis.ttl(lockKey);
    if (ttl > 0) {
      throw new RateLimitError('登录尝试过于频繁，请 15 分钟后再试', Math.ceil(ttl), {
        code: ErrorCode.LOGIN_TOO_MANY_ATTEMPTS,
      });
    }
  }

  /**
   * 注册一次登录失败，达到阈值则锁定 15 分钟。
   *
   * @param phone 手机号
   * @returns void
   */
  private async registerFail(phone: string): Promise<void> {
    const redis = getRedis();
    if (redis === null) {
      return;
    }
    const failKey = this.failKey(phone);
    const count = await redis.incr(failKey);
    if (count === 1) {
      await redis.expire(failKey, FAIL_WINDOW_SECONDS);
    }
    if (count >= LOGIN_MAX_FAILS) {
      await redis.set(this.lockKey(phone), '1', 'EX', LOGIN_LOCK_WINDOW_MS / 1000);
    }
  }

  /**
   * 登录成功后清除失败计数与锁定。
   *
   * @param phone 手机号
   * @returns void
   */
  private async clearFails(phone: string): Promise<void> {
    const redis = getRedis();
    if (redis === null) {
      return;
    }
    await redis.del(this.failKey(phone), this.lockKey(phone));
  }

  /** 失败计数键 */
  private failKey(phone: string): string {
    return `${config.redis.keyPrefix}:rl:login:fail:${phone}`;
  }

  /** 锁定键 */
  private lockKey(phone: string): string {
    return `${config.redis.keyPrefix}:rl:login:lock:${phone}`;
  }
}

/** 默认单例 */
export const authService = new AuthService();

export default authService;
