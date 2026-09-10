/**
 * @file server/src/services/TokenService.ts
 * @description Token 签发 / 轮换 / 吊销 / tokenVersion 管理（双 scope：shop / admin 共用一张 refresh_tokens 表）
 * @module services
 * @see docs/02-architecture.md §7.1（双作用域密钥与 token 家族）、docs/04-flows.md F1（刷新/登出时序）
 * @see docs/03-database.md §3.x（refresh_tokens 表：只存 sha256 哈希、familyId 家族吊销）
 * @author 软件开发团队
 * @created 2026-09-05
 *
 * 设计要点（§7.1 / 03-database）：
 * 1. **access token 只签名不落库**，由 `auth.ts` 验签；本服务只负责签发。
 * 2. **refresh token 明文仅在签发这一次返回给客户端**，库里只存 `sha256(明文)` 哈希，
 *    之后任何环节都无法再取回明文 —— 即使 DB 泄露也无法重放。
 * 3. **家族（familyId）机制**：同一登录会话签发的所有 refresh token 共享一个 familyId；
 *    检测到「已吊销 token 被再次使用」即判定为**重放攻击**，吊销整个 family，
 *    攻击者拿不到任何未吊销的可刷新凭证。
 * 4. **登出 = 吊销 family + tokenVersion++**：只吊销 refresh 的话，
 *    已签发的 access token 在 TTL 内（2h）仍可用，所以必须两者同时做。
 */
// eslint 会因「jwt 默认导入」报 no-default-export，这里按项目既有风格用默认导入
import jwt from 'jsonwebtoken';
import { randomBytes, randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { SubjectType } from '@prisma/client';
import { config } from '@/config';
import type { TokenScope } from '@/config/types';
import { AuthError } from '@/core/errors';
import { ErrorCode } from '@/core/errors/errorCodes';
import { getPrisma } from '@/core/prisma';
import { sha256Hex } from '@/utils/crypto';

/** Token 主体（用于签发，userId / adminId 二选一） */
export interface TokenSubject {
  /** C 端用户 / 后台管理员 */
  subjectType: SubjectType;
  /** 主体 ID（C 端为 userId，后台为 adminId），即 JWT 的 `sub` */
  subjectId: bigint;
  /** 角色标识（C 端为 'USER'，后台为 'SUPER_ADMIN' / 'ADMIN'） */
  role?: string;
  /** token 版本号：用于强制下线，+1 即让该主体所有已签发 access token 失效 */
  tokenVersion: number;
}

/** 签发时透传的元数据 */
export interface TokenIssueMeta {
  /** User-Agent，审计用 */
  userAgent?: string | null;
  /** 客户端 IP，审计用 */
  ip?: string | null;
  /** 轮换时沿用旧记录的 familyId */
  familyId?: string;
}

/** 一对 token（refresh 明文只在此时返回） */
export interface TokenPair {
  /** access token（Bearer 头使用） */
  accessToken: string;
  /** refresh token 明文（仅此一次；Cookie + 响应体均携带，见 §5.5 传输约定） */
  refreshToken: string;
  /** access token 有效期（秒），便于前端预判过期 */
  expiresIn: number;
}

/** 简化的 Prisma 客户端形态（仅声明本服务用到的委托，便于测试注入假 client） */
type DbClient = Pick<
  PrismaClient,
  'refreshToken' | 'user' | 'adminUser'
>;

/** refresh_tokens 记录的最小形态（取自 Prisma 查询结果） */
interface RefreshRecordShape {
  id: bigint;
  subjectType: SubjectType;
  userId: bigint | null;
  adminId: bigint | null;
  familyId: string;
  userAgent: string | null;
  ip: string | null;
  expiresAt: Date;
  revokedAt: Date | null;
}

/** refresh token 有效期解析缓存，避免每次签发都正则解析 */
const ttlSecondsCache = new Map<string, number>();

/**
 * 把 `2h` / `7d` / `15m` / `30s` 形式的 TTL 解析为秒。
 *
 * @description JWT 的 `expiresIn` 接受字符串，但响应体要返回数字秒数，统一在此转换
 * @param ttl TTL 字符串
 * @returns 秒数
 */
export function parseTtlToSeconds(ttl: string): number {
  const cached = ttlSecondsCache.get(ttl);
  if (cached !== undefined) {
    return cached;
  }
  const matched = /^(\d+)\s*(s|m|h|d)$/i.exec(ttl.trim());
  let seconds: number;
  if (matched === null) {
    // 兜底：解析失败按 1 小时处理，避免签发出永不过期的 token
    seconds = 3600;
  } else {
    const value = Number.parseInt(matched[1], 10);
    const unit = matched[2].toLowerCase();
    const multiplier = unit === 'd' ? 86_400 : unit === 'h' ? 3600 : unit === 'm' ? 60 : 1;
    seconds = value * multiplier;
  }
  ttlSecondsCache.set(ttl, seconds);
  return seconds;
}

/**
 * Token 服务：签发、轮换、吊销、版本号管理。
 *
 * 实现说明：所有 DB 操作通过构造时注入的 Prisma 客户端进行，
 * 默认取全局单例（`getPrisma()`），测试时可注入假 client。
 */
export class TokenService {
  /** 注入的 Prisma 客户端 */
  private readonly prisma: DbClient;

  /**
   * @param prisma Prisma 客户端，缺省时取全局单例
   */
  constructor(prisma: DbClient = getPrisma()) {
    this.prisma = prisma;
  }

  /**
   * 签发一对 token（access + refresh）。
   *
   * @description refresh token 明文仅在此返回，库里只存其 sha256 哈希；
   * 首次签发会生成 familyId，轮换时由调用方通过 `meta.familyId` 沿用
   * @param subject 主体信息
   * @param scope 作用域（shop / admin）
   * @param meta 透传元数据（UA / IP / familyId）
   * @returns 一对 token
   */
  async issueTokenPair(subject: TokenSubject, scope: TokenScope, meta: TokenIssueMeta = {}): Promise<TokenPair> {
    const access = this.signAccessToken(subject, scope);
    const created = await this.createRefreshRecord(this.prisma, {
      subjectType: subject.subjectType,
      subjectId: subject.subjectId,
      familyId: meta.familyId ?? randomUUID(),
      userAgent: meta.userAgent ?? null,
      ip: meta.ip ?? null,
      scope,
    });
    return {
      accessToken: access.accessToken,
      refreshToken: created.refreshToken,
      expiresIn: access.expiresIn,
    };
  }

  /**
   * 轮换 refresh token（核心安全逻辑）。
   *
   * 判定顺序（严格按 §7.1）：
   * 1. 按 `sha256(refreshToken)` 查不到 → 10006 已吊销/无效；
   * 2. 已吊销（`revokedAt !== null`）→ 判定**重放**，吊销整个 familyId 下所有未吊销记录 → 10008；
   * 3. 已过期（`expiresAt < now`）→ 10007；
   * 4. 正常：先签发新记录（沿用 familyId），再把旧记录置为吊销且 `replacedById` 指向新 ID。
   *
   * @param refreshToken refresh token 明文
   * @param scope 作用域（shop / admin）
   * @returns 新的 token 对
   * @throws {AuthError} 10006 / 10007 / 10008
   */
  async rotate(refreshToken: string, scope: TokenScope): Promise<TokenPair> {
    const tokenHash = sha256Hex(refreshToken);
    const record = (await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
    })) as RefreshRecordShape | null;

    if (record === null) {
      throw AuthError.unauthorized('Refresh Token 无效或已吊销', ErrorCode.REFRESH_TOKEN_REVOKED);
    }

    // 2. 重放检测：已吊销的 token 再次被使用，说明旧凭证泄露，吊销整族
    if (record.revokedAt !== null) {
      await this.prisma.refreshToken.updateMany({
        where: { familyId: record.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw AuthError.unauthorized('检测到 Token 重放，已吊销该设备会话', ErrorCode.REFRESH_TOKEN_REPLAYED);
    }

    // 3. 过期
    if (record.expiresAt.getTime() < Date.now()) {
      throw AuthError.unauthorized('Refresh Token 已过期', ErrorCode.REFRESH_TOKEN_EXPIRED);
    }

    // 4. 正常轮换：读取主体当前 role / tokenVersion（可能被 bump 过），签发新记录并吊销旧记录
    const claims = await this.resolveSubjectClaims(scope, record.subjectType, record.userId ?? record.adminId);
    const subjectId = record.userId ?? record.adminId;
    if (subjectId === null) {
      throw AuthError.unauthorized('Refresh Token 主体无效', ErrorCode.REFRESH_TOKEN_REVOKED);
    }

    const created = await this.createRefreshRecord(this.prisma, {
      subjectType: record.subjectType,
      subjectId,
      familyId: record.familyId,
      userAgent: record.userAgent,
      ip: record.ip,
      scope,
    });

    await this.prisma.refreshToken.update({
      where: { id: record.id },
      data: { revokedAt: new Date(), replacedById: created.id },
    });

    const access = this.signAccessToken(
      { subjectType: record.subjectType, subjectId, role: claims.role, tokenVersion: claims.tokenVersion },
      scope,
    );

    return { accessToken: access.accessToken, refreshToken: created.refreshToken, expiresIn: access.expiresIn };
  }

  /**
   * 吊销某个 familyId 下的所有 refresh token（登出 / 禁用时调用）。
   *
   * @description 与 `bumpTokenVersion` 配合使用：仅吊销 refresh 不足以让已签发的 access token 失效
   * @param familyId 家族 ID
   * @returns void
   */
  async revokeFamily(familyId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { familyId },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * 递增主体 tokenVersion，使该主体所有已签发的 access token 立即失效（强制下线 / 改密 / 权限变更）。
   *
   * @param params scope + 主体 ID（二选一）
   * @returns void
   */
  async bumpTokenVersion(params: { scope: TokenScope; userId?: number | bigint; adminId?: number | bigint }): Promise<void> {
    if (params.scope === 'shop') {
      if (params.userId === undefined) {
        return;
      }
      await this.prisma.user.update({
        where: { id: BigInt(params.userId) },
        data: { tokenVersion: { increment: 1 } },
      });
      return;
    }
    if (params.adminId === undefined) {
      return;
    }
    await this.prisma.adminUser.update({
      where: { id: BigInt(params.adminId) },
      data: { tokenVersion: { increment: 1 } },
    });
  }

  /**
   * 仅签发 access token（不落库）。
   *
   * @description `tv` 是 tokenVersion 的缩写，与 `auth.ts` 的 `claims.tv` 对应，务必一致
   * @param subject 主体信息
   * @param scope 作用域
   * @returns access token 与有效期秒数
   */
  private signAccessToken(subject: TokenSubject, scope: TokenScope): { accessToken: string; expiresIn: number } {
    const expiresIn = parseTtlToSeconds(config.jwt[scope].accessTtl);
    const jti = randomUUID();
    const accessToken = jwt.sign(
      { sub: String(subject.subjectId), role: subject.role, scope, tv: subject.tokenVersion, jti },
      config.jwt[scope].accessSecret,
      { expiresIn },
    );
    return { accessToken, expiresIn };
  }

  /**
   * 写入一条 refresh token 记录（仅存 sha256 哈希）。
   *
   * @description 明文 refresh token 在调用方处生成并仅返回这一次；familyId 必须显式传入
   * @param db Prisma 客户端（或事务客户端）
   * @param params 写入参数
   * @returns 新记录 ID 与 refresh token 明文
   */
  private async createRefreshRecord(
    db: DbClient,
    params: { subjectType: SubjectType; subjectId: bigint; familyId: string; userAgent: string | null; ip: string | null; scope: TokenScope },
  ): Promise<{ id: bigint; refreshToken: string }> {
    const refreshToken = randomBytes(32).toString('hex');
    const tokenHash = sha256Hex(refreshToken);
    const expiresAt = new Date(Date.now() + parseTtlToSeconds(config.jwt[params.scope].refreshTtl) * 1000);

    const record = await db.refreshToken.create({
      data: {
        subjectType: params.subjectType,
        userId: params.subjectType === SubjectType.USER ? params.subjectId : null,
        adminId: params.subjectType === SubjectType.ADMIN ? params.subjectId : null,
        tokenHash,
        familyId: params.familyId,
        userAgent: params.userAgent,
        ip: params.ip,
        expiresAt,
      },
    });
    return { id: record.id, refreshToken };
  }

  /**
   * 读取主体当前的 role 与 tokenVersion，用于轮换时签发合法的 access token。
   *
   * @param scope 作用域
   * @param subjectType 主体类型
   * @param subjectId 主体 ID
   * @returns role 与 tokenVersion
   */
  private async resolveSubjectClaims(
    scope: TokenScope,
    subjectType: SubjectType,
    subjectId: bigint | null,
  ): Promise<{ role?: string; tokenVersion: number }> {
    if (subjectId === null) {
      throw AuthError.unauthorized('Refresh Token 主体无效', ErrorCode.REFRESH_TOKEN_REVOKED);
    }
    if (scope === 'shop' || subjectType === SubjectType.USER) {
      const user = await this.prisma.user.findUnique({ where: { id: subjectId } });
      if (user === null) {
        throw AuthError.unauthorized('账号不存在', ErrorCode.REFRESH_TOKEN_REVOKED);
      }
      return { role: user.role, tokenVersion: user.tokenVersion };
    }
    const admin = await this.prisma.adminUser.findUnique({
      where: { id: subjectId },
      include: { adminRoles: { include: { role: true } } },
    });
    if (admin === null) {
      throw AuthError.unauthorized('管理员不存在', ErrorCode.REFRESH_TOKEN_REVOKED);
    }
    const isSuper = admin.adminRoles.some((link) => link.role.code === 'SUPER_ADMIN');
    return { role: isSuper ? 'SUPER_ADMIN' : 'ADMIN', tokenVersion: admin.tokenVersion };
  }
}

/** 默认单例（使用全局 Prisma 客户端） */
export const tokenService = new TokenService();

export default tokenService;
