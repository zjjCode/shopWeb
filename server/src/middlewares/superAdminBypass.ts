/**
 * @file server/src/middlewares/superAdminBypass.ts
 * @description 超级管理员旁路：仅 SUPER_ADMIN 可放行，并为后续处理器打上可追溯的标记
 * @module middlewares
 * @see docs/03-database.md §3.10（SUPER_ADMIN 角色绕过运行时校验）
 * @author 软件开发团队
 * @created 2026-09-03
 *
 * 设计取舍：
 * 超级管理员在播种时被勾选全部权限点并绕过运行时权限校验，这是**有意为之** ——
 * 否则权限体系一旦配错就会把唯一的救火通道也堵死（管理员无法给自己赋权 = 系统锁死）。
 * 但「绕过」绝不意味着「不留痕」：本中间件会在 `req.superAdminBypass` 上打标记，
 * 操作日志中间件据此把该次操作标记为「超级管理员绕过」，供审计追溯。
 */

import type { RequestHandler } from 'express';
import { UserRole } from '@/constants/enums';
import { AuthError } from '@/core/errors';
import { ErrorCode } from '@/core/errors/errorCodes';
import { logWarn } from '@/core/logger/logger';

/**
 * 判断主体是否为超级管理员。
 *
 * @param req 任意带 auth 的请求对象
 * @returns 是否为超级管理员
 */
export function isSuperAdmin(req: { auth?: { role?: string } }): boolean {
  return req.auth?.role === UserRole.SUPER_ADMIN;
}

/**
 * 判断本次请求是否已获得超级管理员旁路授权。
 *
 * @description 供操作日志与敏感操作二次确认逻辑读取
 * @param req Express 请求对象
 * @returns 是否已旁路
 */
export function hasSuperAdminBypass(req: { superAdminBypass?: boolean }): boolean {
  return req.superAdminBypass === true;
}

/**
 * 超级管理员旁路中间件。
 *
 * @description 通过者在 `req.superAdminBypass` 置 true，未通过者直接 403。
 * 必须挂在 `auth` + `adminOnly` **之后**
 * @returns Express 中间件
 */
export function superAdminBypass(): RequestHandler {
  return (req, _res, next) => {
    const principal = req.auth;

    if (principal === undefined) {
      next(AuthError.unauthorized('请先登录后台账号', ErrorCode.ACCESS_TOKEN_EXPIRED));
      return;
    }

    if (principal.scope !== 'admin') {
      next(AuthError.forbidden('无权访问后台接口', ErrorCode.RESOURCE_FORBIDDEN));
      return;
    }

    if (principal.role !== UserRole.SUPER_ADMIN) {
      next(AuthError.forbidden('仅超级管理员可执行该操作', ErrorCode.SUPER_ADMIN_ONLY));
      return;
    }

    // 旁路必须留痕：这类操作正是审计最该盯住的（绕过权限体系 = 天然的高风险动作）
    req.superAdminBypass = true;
    logWarn('rbac.super_admin_bypass', {
      adminId: principal.userId,
      method: req.method,
      path: req.path,
    });

    next();
  };
}
