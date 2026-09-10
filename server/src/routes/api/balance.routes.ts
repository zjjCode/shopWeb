/**
 * @file server/src/routes/api/balance.routes.ts
 * @description C 端余额路由：/api/balance（查余额 / 流水分页 / 创建充值单）
 * @module routes/api
 * @see docs/02-architecture.md §5.5（中间件顺序）、§5.8（限流）
 * @see docs/04-flows.md F14（余额充值）
 * @see src/routes/api/address.routes.ts（同类写法：auth + defaultRateLimit + validate + asyncHandler）
 * @author 软件开发团队
 * @created 2026-09-09
 *
 * 为什么每个端点都挂 `auth({ scope: 'shop' })`：
 * 余额与流水是**用户私有资金数据**，充值单更是直接产生负债的动作。漏挂 auth 等于
 * 任何人都能看别人的流水、拿别人的账户开充值单。控制器里只从 `req.auth` 取 userId，
 * 中间件则是第一道闸门——两者缺一不可。
 */

import { type Router, Router as ExpressRouter } from 'express';
import { RATE_LIMIT_KEY, RATE_LIMIT_PRESETS } from '@/config/constants';
import { balanceController } from '@/controllers/BalanceController';
import { asyncHandler } from '@/middlewares/asyncHandler';
import { auth } from '@/middlewares/auth';
import { rateLimit } from '@/middlewares/rateLimit';
import { validate } from '@/middlewares/validate';
import { listTransactionsQuerySchema, rechargeSchema } from '@/validators/balance.validator';

/**
 * 统一的「默认接口」限流（沿用收货地址方案，阈值未单独规定时统一 120 次/分钟）。
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
 * 构建 C 端余额路由。
 *
 * @returns Express Router
 */
export function createBalanceRouter(): Router {
  const router = ExpressRouter();

  // 查余额：首次查询自动开户（零余额账户），返回 { accountNo, balance, status }
  router.get('/balance', auth({ scope: 'shop' }), defaultRateLimit(), asyncHandler(balanceController.getBalance));

  // 流水明细（分页）：越权红线（userId 边界）由 service 兜底
  router.get(
    '/balance/transactions',
    auth({ scope: 'shop' }),
    defaultRateLimit(),
    validate({ query: listTransactionsQuerySchema }),
    asyncHandler(balanceController.listTransactions),
  );

  // 创建充值单：F14.1 ①，payMethod 仅外部渠道（余额不可用于充值，validator 白名单已挡）
  router.post(
    '/balance/recharges',
    auth({ scope: 'shop' }),
    defaultRateLimit(),
    validate({ body: rechargeSchema }),
    asyncHandler(balanceController.createRecharge),
  );

  return router;
}

/** C 端余额路由单例 */
export const balanceRouter = createBalanceRouter();

export default balanceRouter;
