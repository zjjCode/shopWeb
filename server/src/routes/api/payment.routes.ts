/**
 * @file server/src/routes/api/payment.routes.ts
 * @description C 端支付路由：POST /api/payments、POST /api/payments/:paymentNo/mock-paid
 * @module routes/api
 * @see docs/04-flows.md F6（556 行起）、docs/02-architecture.md §5.5（中间件顺序）、§6.7（mock 红线）
 * @see src/routes/api/order.routes.ts（同类写法）
 * @author 软件开发团队
 * @created 2026-09-08
 *
 * 中间件顺序（**不能调换**）：
 * 1. `auth({ scope: 'shop' })` —— 支付是私有操作，未登录必须挡在门外；
 * 2. `rateLimit(PAY_CREATE)` —— 20 次 / 分钟；
 * 3. `idempotency({ scope: PAY_CREATE })` —— 幂等抢占，**必须在 validate 之前**：
 *    抢占用的指纹基于原始 body 计算，若先让 validate 转换（金额字符串 → bigint），
 *    指纹会随 transform 漂移，导致「同一笔请求被判成参数不一致」的误报；
 * 4. `validate(...)` —— 最后才做业务参数校验。
 *
 * ⚠️ **mock 确认端点生产环境不注册**：
 * 设计红线（`02-architecture.md` §6.7）明确「`NODE_ENV=production` 下 mock 强制不可启用」。
 * 若在生产注册，任何人都能把订单标记成已支付而**没有一分钱真实资金流入**，
 * 会直接污染对账。这里用 `isProduction` 在装配期就不注册该路由，
 * 生产请求会落到兜底 404——比在处理器里 `if (isProduction) throw` 更彻底
 * （后者仍会进入路由匹配、留下日志与限流计数）。
 */

import { type Router, Router as ExpressRouter } from 'express';
import { isProduction } from '@/config';
import { IDEMPOTENT_SCOPE, RATE_LIMIT_KEY, RATE_LIMIT_PRESETS } from '@/config/constants';
import { paymentController } from '@/controllers/PaymentController';
import { asyncHandler } from '@/middlewares/asyncHandler';
import { auth } from '@/middlewares/auth';
import { idempotency } from '@/middlewares/idempotency';
import { rateLimit } from '@/middlewares/rateLimit';
import { requireBalancePassword } from '@/middlewares/balancePassword';
import { validate } from '@/middlewares/validate';
import {
  balancePaySchema,
  createPaymentSchema,
  mockPaidSchema,
  paymentNoParamSchema,
} from '@/validators/payment.validator';

/**
 * 支付接口限流：20 次 / 分钟。
 *
 * @returns 限流中间件
 */
function payCreateRateLimit() {
  return rateLimit({
    windowMs: RATE_LIMIT_PRESETS.PAY_CREATE.windowMs,
    max: RATE_LIMIT_PRESETS.PAY_CREATE.max,
    prefix: RATE_LIMIT_KEY.ROUTE,
    message: '支付请求过于频繁，请稍后再试',
  });
}

/**
 * 构建 C 端支付路由。
 *
 * @returns Express Router
 */
export function createPaymentRouter(): Router {
  const router = ExpressRouter();

  // 发起支付：幂等 + 限流 + 校验（顺序见文件头说明）
  router.post(
    '/payments',
    auth({ scope: 'shop' }),
    payCreateRateLimit(),
    idempotency({ scope: IDEMPOTENT_SCOPE.PAY_CREATE }),
    validate({ body: createPaymentSchema }),
    asyncHandler(paymentController.create),
  );

  // mock 确认支付：**仅非生产环境注册**（生产请求会落到兜底 404）
  if (!isProduction) {
    router.post(
      '/payments/:paymentNo/mock-paid',
      auth({ scope: 'shop' }),
      payCreateRateLimit(),
      validate({ params: paymentNoParamSchema, body: mockPaidSchema }),
      asyncHandler(paymentController.mockPaid),
    );
  }

  // 余额支付（同步扣款，F6.6 负债结转对）：真实功能，全环境注册（不依赖任何外部渠道）
  // 余额支付前必须校验支付密码（二次确认）：validate 先保字段非空，requireBalancePassword
  // 再做「锁定 → 是否已设置 → 比对」完整校验；校验器在 bootstrap 注册（见 server.ts）。
  router.post(
    '/payments/:paymentNo/balance-pay',
    auth({ scope: 'shop' }),
    payCreateRateLimit(),
    validate({ params: paymentNoParamSchema, body: balancePaySchema }),
    requireBalancePassword('payPassword'),
    asyncHandler(paymentController.balancePay),
  );

  return router;
}

/** C 端支付路由单例 */
export const paymentRouter = createPaymentRouter();

export default paymentRouter;
