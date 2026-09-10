/**
 * @file server/src/services/AdminAuthService.ts
 * @description 后台认证服务：登录 / 登出 / 刷新 / 资料（admin 作用域）
 * @module services
 * @see docs/02-architecture.md §7.1（双作用域密钥）、docs/04-flows.md F1（后台登录时序）
 * @author 软件开发团队
 * @created 2026-09-05
 *
 * 与 C 端的关键差异（T010 设计裁定，**极易写错**）：
 * - **失败锁定载体不同**：C 端用 Redis（`users` 表无失败计数字段），后台用 `admin_users` 表的
 *   `loginFailCount` / `lockedUntil` 两个 DB 字段实现「5 次锁定 15 分钟」。切勿套用 C 端 Redis 方案。
 * - **tokenVersion 同样存在**：登出 / 权限变更（RBAC-12）时 `tokenVersion++`，强制重登录。
 * - 后台角色为动态 RBAC（多对多），access token 的 `role` 仅用于标识是否超级管理员
 *   （'SUPER_ADMIN' / 'ADMIN'），细粒度权限由 `authorize` 中间件实时判定。
 */

import type { PrismaClient } from '@prisma/client';
import { AdminStatus, SubjectType } from '@prisma/client';
import { AuthError, RateLimitError } from '@/core/errors';
import { ErrorCode } from '@/core/errors/errorCodes';
import { getPrisma } from '@/core/prisma';
import { sha256Hex } from '@/utils/crypto';
import { comparePassword } from '@/utils/hash';
import { tokenService } from './TokenService';
import type { AuthMeta } from './AuthService';

/** 后台登录入参 */
export interface AdminLoginInput {
  /** 管理员用户名 */
  username: string;
  /** 明文密码 */
  password: string;
}

/** 对外返回的脱敏管理员对象 */
export interface AdminPayload {
  id: string;
  username: string;
  realName: string | null;
  phone: string | null;
  status: string;
  isSuperAdmin: boolean;
  roles: string[];
  lastLoginAt: Date | null;
  createdAt: Date;
}

/** 后台登录结果 */
export interface AdminAuthResult extends AdminPayload {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

/** 简化的 Prisma 客户端形态（登出时还需按哈希定位 refresh token 记录） */
type DbClient = Pick<PrismaClient, 'adminUser' | 'refreshToken'>;

/** 锁定窗口（毫秒）：15 分钟，与 C 端一致 */
const ADMIN_LOCK_WINDOW_MS = 15 * 60 * 1000;
/** 失败锁定阈值 */
const ADMIN_MAX_FAILS = 5;

/**
 * 后台认证服务。
 */
export class AdminAuthService {
  /** 注入的 Prisma 客户端 */
  private readonly prisma: DbClient;

  /**
   * @param prisma Prisma 客户端，缺省时取全局单例
   */
  constructor(prisma: DbClient = getPrisma()) {
    this.prisma = prisma;
  }

  /**
   * 后台登录。
   *
   * @description 锁定走 `admin_users.lockedUntil`；失败计数走 `loginFailCount`（DB 字段，非 Redis）；
   * 防账号枚举（统一 10003）；成功后重置计数、更新登录时间后再签发 token
   * @param input 登录入参
   * @param meta 请求元数据
   * @returns 脱敏管理员信息与 token 对
   * @throws {RateLimitError} 10011 已锁定 / {AuthError} 10003 账号或密码错误 / 10004 账号已禁用
   */
  async login(input: AdminLoginInput, meta: AuthMeta = {}): Promise<AdminAuthResult> {
    const admin = await this.prisma.adminUser.findUnique({
      where: { username: input.username },
      include: { adminRoles: { include: { role: true } } },
    });

    // 1. 已锁定（DB 字段判定）
    if (admin !== null && admin.lockedUntil !== null && admin.lockedUntil.getTime() > Date.now()) {
      const remainingSeconds = Math.ceil((admin.lockedUntil.getTime() - Date.now()) / 1000);
      throw new RateLimitError('账号已临时锁定，请 15 分钟后再试', remainingSeconds, {
        code: ErrorCode.LOGIN_TOO_MANY_ATTEMPTS,
      });
    }

    const passwordOk = admin !== null ? await comparePassword(input.password, admin.passwordHash) : false;

    if (admin === null || !passwordOk) {
      // 仅当用户存在时才累加失败计数（不存在不计数，避免无意义写库；统一返回 10003 防枚举）
      if (admin !== null) {
        await this.registerFail(admin);
      }
      throw AuthError.unauthorized('账号或密码错误', ErrorCode.BAD_CREDENTIALS);
    }

    if (admin.status !== AdminStatus.ACTIVE) {
      throw AuthError.forbidden('账号已被禁用', ErrorCode.ACCOUNT_DISABLED);
    }

    // 2. 成功：重置失败计数与锁定，更新登录信息
    await this.prisma.adminUser.update({
      where: { id: admin.id },
      data: {
        loginFailCount: 0,
        lockedUntil: null,
        lastLoginAt: new Date(),
        lastLoginIp: meta.ip ?? null,
      },
    });

    const isSuper = admin.adminRoles.some((link) => link.role.code === 'SUPER_ADMIN');
    const role = isSuper ? 'SUPER_ADMIN' : 'ADMIN';

    const pair = await tokenService.issueTokenPair(
      { subjectType: SubjectType.ADMIN, subjectId: admin.id, role, tokenVersion: admin.tokenVersion },
      'admin',
      { userAgent: meta.userAgent, ip: meta.ip },
    );

    return { ...this.toAdminPayload(admin, isSuper), ...pair };
  }

  /**
   * 刷新 token（委派 TokenService 轮换）。
   *
   * @param refreshToken refresh token 明文
   * @returns 新的 token 对
   */
  async refresh(refreshToken: string): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    return tokenService.rotate(refreshToken, 'admin');
  }

  /**
   * 后台登出。
   *
   * @description 吊销 family + tokenVersion++（与 C 端语义一致）
   * @param adminId 管理员 ID
   * @param refreshToken 当前 refresh token 明文（定位 familyId），可空
   * @returns void
   */
  async logout(adminId: number | bigint, refreshToken?: string): Promise<void> {
    if (typeof refreshToken === 'string' && refreshToken.length > 0) {
      const record = await this.prisma.refreshToken.findUnique({ where: { tokenHash: sha256Hex(refreshToken) } });
      if (record !== null && record.subjectType === SubjectType.ADMIN) {
        await tokenService.revokeFamily(record.familyId);
      }
    }
    await tokenService.bumpTokenVersion({ scope: 'admin', adminId });
  }

  /**
   * 获取后台管理员资料（脱敏）。
   *
   * @param adminId 管理员 ID
   * @returns 脱敏管理员对象
   * @throws {AuthError} 账号不存在
   */
  async getProfile(adminId: number | bigint): Promise<AdminPayload> {
    const admin = await this.prisma.adminUser.findUnique({
      where: { id: BigInt(adminId) },
      include: { adminRoles: { include: { role: true } } },
    });
    if (admin === null) {
      throw AuthError.unauthorized('管理员不存在', ErrorCode.BAD_CREDENTIALS);
    }
    const isSuper = admin.adminRoles.some((link) => link.role.code === 'SUPER_ADMIN');
    return this.toAdminPayload(admin, isSuper);
  }

  /**
   * 将 admin 记录脱敏为对外对象。
   *
   * @description 显式挑选字段，绝不包含 passwordHash 等敏感字段
   * @param admin Prisma adminUser 记录（含 adminRoles）
   * @param isSuper 是否为超级管理员
   * @returns 脱敏对象
   */
  private toAdminPayload(
    admin: {
      id: bigint;
      username: string;
      realName: string | null;
      phone: string | null;
      status: string;
      lastLoginAt: Date | null;
      createdAt: Date;
      adminRoles: ReadonlyArray<{ role: { code: string } }>;
    },
    isSuper: boolean,
  ): AdminPayload {
    return {
      id: String(admin.id),
      username: admin.username,
      realName: admin.realName,
      phone: admin.phone,
      status: admin.status,
      isSuperAdmin: isSuper,
      roles: admin.adminRoles.map((link) => link.role.code),
      lastLoginAt: admin.lastLoginAt,
      createdAt: admin.createdAt,
    };
  }

  /**
   * 注册一次后台登录失败，达到阈值则锁定 15 分钟（DB 字段实现）。
   *
   * @param admin 管理员记录
   * @returns void
   */
  private async registerFail(admin: {
    id: bigint;
    loginFailCount: number;
  }): Promise<void> {
    const next = admin.loginFailCount + 1;
    if (next >= ADMIN_MAX_FAILS) {
      await this.prisma.adminUser.update({
        where: { id: admin.id },
        data: { loginFailCount: next, lockedUntil: new Date(Date.now() + ADMIN_LOCK_WINDOW_MS) },
      });
    } else {
      await this.prisma.adminUser.update({
        where: { id: admin.id },
        data: { loginFailCount: next },
      });
    }
  }
}

/** 默认单例 */
export const adminAuthService = new AdminAuthService();

export default adminAuthService;
