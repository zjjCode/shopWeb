/**
 * @file server/src/routes/api/auth.routes.ts
 * @description C 端认证路由：/api/auth/*（注册/登录/刷新/登出/资料）
 * @module routes/api
 * @see docs/04-flows.md F1、docs/02-architecture.md §5.5（中间件顺序）、§5.8（限流）
 * @author 软件开发团队
 * @created 2026-09-05
 *
 * 限流（用既有 rateLimit，不另写）：
 * - 注册：IP 维度 5 次/小时（RATE_LIMIT_PRESETS.REGISTER）
 * - 登录：账号(IP+手机号) 维度 10 次/15 分钟（RATE_LIMIT_PRESETS.LOGIN）
 *   注：登录失败锁定（5 次锁 15 分钟）由 AuthService 走 Redis 实现，与限流是两个独立维度。
 */

import { type Router, Router as ExpressRouter } from 'express';
import { auth } from '@/middlewares/auth';
import { asyncHandler } from '@/middlewares/asyncHandler';
import { rateLimit } from '@/middlewares/rateLimit';
import { RATE_LIMIT_KEY, RATE_LIMIT_PRESETS } from '@/config/constants';
import { validate } from '@/middlewares/validate';
import { loginSchema, registerSchema } from '@/validators/auth.validator';
import { authController } from '@/controllers/AuthController';

/**
 * 构建 C 端认证路由。
 *
 * @returns Express Router
 */
export function createAuthRouter(): Router {
  const router = ExpressRouter();

  // 注册：IP 维度 5 次/小时
  router.post(
    '/register',
    rateLimit({
      windowMs: RATE_LIMIT_PRESETS.REGISTER.windowMs,
      max: RATE_LIMIT_PRESETS.REGISTER.max,
      prefix: RATE_LIMIT_KEY.IP,
      message: '注册过于频繁，请 1 小时后再试',
    }),
    validate({ body: registerSchema }),
    asyncHandler(authController.register),
  );

  // 登录：账号维度（IP + 手机号）10 次/15 分钟
  router.post(
    '/login',
    rateLimit({
      windowMs: RATE_LIMIT_PRESETS.LOGIN.windowMs,
      max: RATE_LIMIT_PRESETS.LOGIN.max,
      prefix: RATE_LIMIT_KEY.IP,
      keyGenerator: (req) => `${req.ip ?? 'unknown'}:${typeof req.body?.phone === 'string' ? req.body.phone : 'anon'}`,
      message: '登录尝试过于频繁，请 15 分钟后再试',
    }),
    validate({ body: loginSchema }),
    asyncHandler(authController.login),
  );

  // 刷新：refresh token 取自 Cookie，无需 access token，故不加 auth 中间件
  router.post('/refresh', asyncHandler(authController.refresh));

  // 登出 / 资料：需 shop 作用域 access token
  router.post('/logout', auth({ scope: 'shop' }), asyncHandler(authController.logout));
  router.get('/profile', auth({ scope: 'shop' }), asyncHandler(authController.profile));

  return router;
}

/** C 端认证路由单例 */
export const authRouter = createAuthRouter();

export default authRouter;
