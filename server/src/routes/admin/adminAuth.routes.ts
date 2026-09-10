/**
 * @file server/src/routes/admin/adminAuth.routes.ts
 * @description 后台认证路由：/admin/auth/*（登录/登出/刷新/资料）
 * @module routes/admin
 * @see docs/02-architecture.md:330（后台路由规划）、docs/04-flows.md F1（后台登录时序）
 * @author 软件开发团队
 * @created 2026-09-05
 *
 * 后台失败锁定走 `admin_users` DB 字段（见 AdminAuthService），此处不额外加登录限流，
 * 但保留与 C 端一致的路由结构。受保护接口统一 `auth({ scope: 'admin' })`。
 */

import { type Router, Router as ExpressRouter } from 'express';
import { auth } from '@/middlewares/auth';
import { adminOnly } from '@/middlewares/adminOnly';
import { asyncHandler } from '@/middlewares/asyncHandler';
import { validate } from '@/middlewares/validate';
import { loginSchema } from '@/validators/auth.validator';
import { adminAuthController } from '@/controllers/admin/AdminAuthController';

/**
 * 构建后台认证路由。
 *
 * @returns Express Router
 */
export function createAdminAuthRouter(): Router {
  const router = ExpressRouter();

  // 登录：无 access token
  router.post('/login', validate({ body: loginSchema }), asyncHandler(adminAuthController.login));

  // 刷新：refresh token 取自 Cookie
  router.post('/refresh', asyncHandler(adminAuthController.refresh));

  // 登出 / 资料：需 admin 作用域 access token（adminOnly 兜底，防止作用域缺省导致越权）
  router.post('/logout', auth({ scope: 'admin' }), adminOnly(), asyncHandler(adminAuthController.logout));
  router.get('/profile', auth({ scope: 'admin' }), adminOnly(), asyncHandler(adminAuthController.profile));

  return router;
}

/** 后台认证路由单例 */
export const adminAuthRouter = createAdminAuthRouter();

export default adminAuthRouter;
