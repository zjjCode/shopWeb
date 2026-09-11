/**
 * @file server/src/routes/api/refund.routes.ts
 * @description C 端退款路由：/api/refunds（申请 / 列表 / 详情）
 * @module routes/api
 * @see docs/02-architecture.md §5.5（中间件顺序）、§5.8（限流）
 * @see src/routes/api/balance.routes.ts（同类写法：auth + defaultRateLimit + validate + asyncHandler）
 * @author 软件开发团队
 * @created 2026-09-12
 *
 * 退款单是用户私有资金数据：每个端点都挂 `auth({ scope: 'shop' })`，控制器里只从 `req.auth` 取 userId。
 */

import { type Router, Router as ExpressRouter } from 'express';
import { RATE_LIMIT_KEY, RATE_LIMIT_PRESETS } from '@/config/constants';
import { asyncHandler } from '@/middlewares/asyncHandler';
import { auth } from '@/middlewares/auth';
import { rateLimit } from '@/middlewares/rateLimit';
import { validate } from '@/middlewares/validate';
import { refundController } from '@/controllers/RefundController';
import {
  applyRefundSchema,
  listRefundsQuerySchema,
  refundNoParamSchema,
} from '@/validators/refund.validator';

/**
 * 统一的「默认接口」限流（沿用余额方案，阈值未单独规定时统一 120 次/分钟）。
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
 * 构建 C 端退款路由。
 *
 * @returns Express Router
 */
export function createRefundRouter(): Router {
  const router = ExpressRouter();

  // 申请退款：F9.1 ①，建 PENDING 单（不扣钱、不改订单状态）
  router.post(
    '/refunds',
    auth({ scope: 'shop' }),
    defaultRateLimit(),
    validate({ body: applyRefundSchema }),
    asyncHandler(refundController.apply),
  );

  // 退款列表（分页）：当前用户，按创建时间倒序
  router.get(
    '/refunds',
    auth({ scope: 'shop' }),
    defaultRateLimit(),
    validate({ query: listRefundsQuerySchema }),
    asyncHandler(refundController.list),
  );

  // 退款详情：F9.1 ③，越权统一 404（service 按 where.userId 兜底）
  router.get(
    '/refunds/:refundNo',
    auth({ scope: 'shop' }),
    validate({ params: refundNoParamSchema }),
    asyncHandler(refundController.detail),
  );

  return router;
}

/** C 端退款路由单例 */
export const refundRouter = createRefundRouter();

export default refundRouter;
