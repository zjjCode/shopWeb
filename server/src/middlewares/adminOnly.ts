/**
 * @file server/src/middlewares/adminOnly.ts
 * @description 后台作用域守卫：强制 `scope=admin`，杜绝 C 端 token 访问后台接口
 * @module middlewares
 * @see docs/02-architecture.md §5.5（第 8 个中间件：adminOnly / rbac）
 * @author 软件开发团队
 * @created 2026-09-03
 *
 * 为什么有了 `auth({ scope: 'admin' })` 还需要这一层：
 * 两者校验的东西不同。`auth` 校验的是「这个 token 是用 admin 密钥签的」；
 * 本中间件校验的是「当前请求已经拿到了 admin 主体」。
 * 当路由链上出现 `optionalAuth` 或作用域缺省时，没有这一层就会出现「没登录也能进后台」的漏洞。
 * 它是**兜底断言**，不是重复校验。
 */

import type { RequestHandler } from 'express';
import { AuthError } from '@/core/errors';
import { ErrorCode } from '@/core/errors/errorCodes';

/**
 * 后台作用域守卫。
 *
 * @description 必须挂在 `auth({ scope: 'admin' })` **之后**
 * @returns Express 中间件
 */
export function adminOnly(): RequestHandler {
  return (req, _res, next) => {
    const principal = req.auth;

    if (principal === undefined) {
      next(AuthError.unauthorized('请先登录后台账号', ErrorCode.ACCESS_TOKEN_EXPIRED));
      return;
    }

    if (principal.scope !== 'admin') {
      // C 端 token 打后台接口：属于越权尝试，记 403 而不是 401
      next(AuthError.forbidden('无权访问后台接口', ErrorCode.RESOURCE_FORBIDDEN));
      return;
    }

    next();
  };
}

/**
 * 判断当前请求是否已通过后台认证。
 *
 * @description 供控制器内的分支逻辑使用（如后台列表需按 `data_scope` 过滤数据）
 * @param req Express 请求对象
 * @returns 是否为后台管理员请求
 */
export function isAdminRequest(req: { auth?: { scope?: string } }): boolean {
  return req.auth?.scope === 'admin';
}
