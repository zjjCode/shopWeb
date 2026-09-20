/**
 * @file server/src/routes/api/user.routes.ts
 * @description C 端用户路由：/api/user/*（当前用户的支付密码设置 / 修改）
 * @module routes/api
 * @see docs/02-architecture.md §5.5（中间件顺序）、§5.8（限流）、docs/12-phase12-plan.md（T070）
 * @author 软件开发团队
 * @created 2026-09-20
 *
 * 为什么挂在 /api/user 下且每个端点单独挂 `auth({ scope: 'shop' })`：
 * 支付密码是**用户私有安全数据**，任何端点漏挂 auth 都等于把改密码的入口露给匿名用户。
 * 控制器里只从 `req.auth` 取 userId，中间件则是第一道闸门——两者缺一不可。
 */

import { type Router, Router as ExpressRouter } from 'express';
import { RATE_LIMIT_KEY, RATE_LIMIT_PRESETS } from '@/config/constants';
import { asyncHandler } from '@/middlewares/asyncHandler';
import { auth } from '@/middlewares/auth';
import { rateLimit } from '@/middlewares/rateLimit';
import { validate } from '@/middlewares/validate';
import { payPasswordController } from '@/controllers/PayPasswordController';
import { modifyPayPasswordSchema, setPayPasswordSchema } from '@/validators/payPassword.validator';

/**
 * 统一的「默认接口」限流（沿用余额路由方案，阈值未单独规定时统一 120 次/分钟）。
 *
 * @returns 限流中间件
 */
function defaultRateLimit() {
  return rateLimit({
    windowMs: RATE_LIMIT_PRESETS.DEFAULT.windowMs,
    max: RATE_LIMIT_PRESETS.DEFAULT.max,
    prefix: RATE_LIMIT_KEY.ROUTE,
    message: '请求过于频繁，请稍后再试',
  });
}

/**
 * 构建 C 端用户路由。
 *
 * @returns Express Router
 */
export function createUserRouter(): Router {
  const router = ExpressRouter();

  // 首次设置支付密码（未设置才能调，已设置返回 61011）
  router.post(
    '/user/pay-password',
    auth({ scope: 'shop' }),
    defaultRateLimit(),
    validate({ body: setPayPasswordSchema }),
    asyncHandler(payPasswordController.set),
  );

  // 修改支付密码（已设置才能调，需校验原密码，否则返回 61009 / 61007）
  router.put(
    '/user/pay-password',
    auth({ scope: 'shop' }),
    defaultRateLimit(),
    validate({ body: modifyPayPasswordSchema }),
    asyncHandler(payPasswordController.modify),
  );

  return router;
}

/** C 端用户路由单例 */
export const userRouter = createUserRouter();

export default userRouter;
