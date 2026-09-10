/**
 * @file server/src/middlewares/authorize.ts
 * @description 权限点校验：`authorize(...permissionCodes)`（替换 v1 的 rbac.ts，改为细粒度权限点）
 * @module middlewares
 * @see docs/03-database.md §3.10（RBAC 与权限点清单）
 * @author 软件开发团队
 * @created 2026-09-03
 *
 * 缓存策略（这是本文件最需要解释的地方）：
 * 普通权限走 Redis 缓存（60s），敏感权限**每次实时查库**。
 * 原因：缓存带来的最大风险是「撤权延迟」。普通权限延迟 60s 只是体验问题；
 * 而 `balance:adjust`（手工调账）、`fund:reconcile`（对账）这类权限如果被延迟生效，
 * 一个刚被撤权的管理员有整整 60 秒可以把钱划走 —— 这个代价无法接受，
 * 因此敏感权限宁可牺牲一次查询也要保证立即生效（见 constants/permissions.ts）。
 */

import type { RequestHandler } from 'express';
import {
  ALL_PERMISSIONS,
  isSensitivePermission,
  rbacPermsCacheKey,
  RBAC_PERMS_CACHE_TTL_SECONDS,
  type PermissionCode,
} from '@/constants/permissions';
import { UserRole } from '@/constants/enums';
import { AppError, AuthError } from '@/core/errors';
import { ErrorCode } from '@/core/errors/errorCodes';
import { logError } from '@/core/logger/logger';
import { parseJson, safeStringify } from '@/core/response';
import { getRedis, withRedis } from '@/core/redis';

/**
 * 权限加载器：按管理员 ID 取出其全部权限点编码。
 *
 * 为什么不在这里直接查库：
 * 分层铁律要求「中间件不得跨层调用 repository」。真正的取数实现由
 * `services/adminPermissionService`（T0xx 阶段落地）通过 {@link setPermissionLoader} 注册进来，
 * 本中间件只负责「缓存 + 比对 + 拦截」，职责单一且不产生反向依赖。
 */
export type PermissionLoader = (adminUserId: number) => Promise<readonly string[]>;

/** 已注册的权限加载器（未注册时拒绝放行，避免静默通过造成越权） */
let permissionLoader: PermissionLoader | null = null;

/**
 * 注册权限加载器。
 *
 * @description 应在应用装配阶段（`app.ts`）调用一次
 * @param loader 权限加载器实现
 */
export function setPermissionLoader(loader: PermissionLoader): void {
  permissionLoader = loader;
}

/**
 * 获取当前注册的权限加载器。
 *
 * @returns 已注册的加载器，未注册时为 null
 */
export function getPermissionLoader(): PermissionLoader | null {
  return permissionLoader;
}

/**
 * 读取管理员权限集合（带缓存开关）。
 *
 * @param adminUserId 管理员 ID
 * @param allowCache 是否允许读缓存（敏感权限必须传 false）
 * @returns 权限点集合
 * @throws {AppError} 未注册加载器时抛出 500（宁可报错也不能放行）
 */
async function loadPermissions(adminUserId: number, allowCache: boolean): Promise<Set<string>> {
  const cacheKey = rbacPermsCacheKey(adminUserId);

  if (allowCache) {
    const cached = await withRedis((redis) => redis.get(cacheKey), null);
    if (cached !== null && cached.length > 0) {
      const parsed = parseJson<string[]>(cached);
      if (Array.isArray(parsed)) {
        return new Set(parsed);
      }
      // 缓存内容损坏时按未命中处理，下一分支会重新加载并覆盖
    }
  }

  if (permissionLoader === null) {
    throw new AppError('权限加载器未注册，无法完成权限校验', {
      code: ErrorCode.SYSTEM_INTERNAL,
      data: { hint: '请在 app.ts 中调用 setPermissionLoader() 注册取数实现' },
    });
  }

  const codes = await permissionLoader(adminUserId);
  const permissions = new Set(codes);

  if (allowCache) {
    await withRedis((redis) => redis.setex(cacheKey, RBAC_PERMS_CACHE_TTL_SECONDS, safeStringify(codes)), null);
  }

  return permissions;
}

/**
 * 权限点校验中间件。
 *
 * @description 全部必需权限**都**具备才放行（AND 语义）；
 * 超级管理员直接放行并持有全量权限点
 * @param required 必需的权限点编码列表
 * @returns Express 中间件
 */
export function authorize(...required: PermissionCode[]): RequestHandler {
  return (req, _res, next) => {
    void (async () => {
      try {
        const principal = req.auth;

        if (principal === undefined) {
          next(AuthError.unauthorized('请先登录后台账号', ErrorCode.ACCESS_TOKEN_EXPIRED));
          return;
        }
        if (principal.scope !== 'admin') {
          next(AuthError.forbidden('无权访问后台接口', ErrorCode.RESOURCE_FORBIDDEN));
          return;
        }

        // 超级管理员持有全量权限点：既是设计约定，也让后续逻辑无需特判
        if (principal.role === UserRole.SUPER_ADMIN) {
          req.permissions = new Set(ALL_PERMISSIONS as readonly string[]);
          next();
          return;
        }

        // 只要本次校验涉及敏感权限，就整体走实时查库 —— 一次请求多查一次库，
        // 换来的是撤权零延迟，这笔账在资金场景里永远划算
        const involvesSensitive = required.some((code) => isSensitivePermission(code));
        const permissions = await loadPermissions(principal.userId, !involvesSensitive);
        req.permissions = permissions;

        const missing = required.filter((code) => !permissions.has(code));
        if (missing.length > 0) {
          // 缺少的权限点只写日志，不回给客户端：
          // 回显「你缺的是 balance:adjust」等于帮攻击者画出后台能力地图（§7.2）
          logError('rbac.permission_denied', new Error('权限不足'), {
            adminId: principal.userId,
            method: req.method,
            path: req.path,
            ctx: { missingPermissions: missing },
          });
          next(AuthError.forbidden('需要更高权限', ErrorCode.PERMISSION_DENIED));
          return;
        }

        next();
      } catch (error) {
        logError('rbac.authorize_failed', error, {
          adminId: req.auth?.userId,
          method: req.method,
          path: req.path,
        });
        next(error);
      }
    })();
  };
}

/**
 * 判断当前请求是否持有指定权限点。
 *
 * @description 供控制器内做「有权限就多返回一些字段」的分支判断；
 * 权限集合由 {@link authorize} 注入，未走该中间件时恒为 false
 * @param req Express 请求对象
 * @param code 权限点编码
 * @returns 是否持有
 */
export function hasPermission(req: { permissions?: ReadonlySet<string> }, code: PermissionCode): boolean {
  return req.permissions?.has(code) === true;
}

/**
 * 主动失效某个管理员的权限缓存。
 *
 * @description 角色变更、权限调整、管理员禁用时必须调用，
 * 否则被撤权者仍能凭借缓存在 TTL 内继续操作（§3.10）
 * @param adminUserId 管理员 ID
 * @returns Promise，删除完成后 resolve
 */
export async function invalidatePermissionCache(adminUserId: number): Promise<void> {
  await withRedis((redis) => redis.del(rbacPermsCacheKey(adminUserId)), null);
}

/**
 * 判断 Redis 权限缓存当前是否可用。
 *
 * @description 用于健康检查与降级观测
 * @returns 可用时 true
 */
export function isPermissionCacheAvailable(): boolean {
  return getRedis() !== null;
}
