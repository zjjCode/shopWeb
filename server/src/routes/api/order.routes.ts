/**
 * @file server/src/routes/api/order.routes.ts
 * @description C 端订单路由：POST /api/orders（下单，事务 A 的入口）
 * @module routes/api
 * @see docs/04-flows.md F5（363-536 行）、docs/02-architecture.md §5.5（中间件顺序）
 * @see src/routes/api/cart.routes.ts（同类写法）
 * @author 软件开发团队
 * @created 2026-09-07
 *
 * 中间件顺序（**不能调换**）：
 * 1. `auth({ scope: 'shop' })` —— 订单是私有资源，未登录必须挡在门外；
 * 2. `rateLimit(ORDER_CREATE)` —— 10 次 / 分钟（F5.1 明确规定），先限流再碰存储；
 * 3. `idempotency({ scope: ORDER_CREATE })` —— 幂等抢占，**必须在 validate 之前**：
 *    抢占用的指纹基于原始 body 计算，若先让 validate 转换（ID 字符串 → bigint），
 *    指纹会随 transform 顺序漂移，导致「同一笔请求被判成参数不一致」的误报；
 * 4. `validate({ body: createOrderSchema })` —— 最后才做业务参数校验。
 *
 * 幂等与业务的一致性关系（重要）：
 * 幂等记录由中间件在**事务外**抢占，而设计 F5.3 要求「幂等抢占与业务同事务」。
 * 这里采用工程折中并记录理由：中间件拿不到业务事务，但它在业务失败时会把记录
 * 置为 `FAILED`（靠包装 `res.json` 捕获非 2xx 响应，见 `@/middlewares/idempotency`），
 * 因此「业务失败 → 同 Key 可重试」这一 F5.3 的实质目标依然成立，
 * 只是实现手段由「事务回滚」变为「失败标记」。
 */

import { type Router, Router as ExpressRouter } from 'express';
import { IDEMPOTENT_SCOPE, RATE_LIMIT_KEY, RATE_LIMIT_PRESETS } from '@/config/constants';
import { orderController } from '@/controllers/OrderController';
import { asyncHandler } from '@/middlewares/asyncHandler';
import { auth } from '@/middlewares/auth';
import { idempotency } from '@/middlewares/idempotency';
import { pagination } from '@/middlewares/pagination';
import { rateLimit } from '@/middlewares/rateLimit';
import { validate } from '@/middlewares/validate';
import {
  cancelOrderSchema,
  createOrderSchema,
  orderListQuerySchema,
  orderNoParamSchema,
} from '@/validators/order.validator';

/**
 * 下单限流：10 次 / 分钟（F5.1 明确要求，比默认 120 次严格得多）。
 *
 * @returns 限流中间件
 */
function orderCreateRateLimit() {
  return rateLimit({
    windowMs: RATE_LIMIT_PRESETS.ORDER_CREATE.windowMs,
    max: RATE_LIMIT_PRESETS.ORDER_CREATE.max,
    prefix: RATE_LIMIT_KEY.ROUTE,
    message: '下单过于频繁，请稍后再试',
  });
}

/**
 * 订单读接口限流：IP/路由维度 120 次/分钟（与商品列表读接口一致，避免单 IP 刷爆数据库）。
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
 * 构建 C 端订单路由。
 *
 * @returns Express Router
 */
export function createOrderRouter(): Router {
  const router = ExpressRouter();

  // 提交订单：幂等 + 限流 + 校验 + 事务（顺序见文件头说明）
  router.post(
    '/orders',
    auth({ scope: 'shop' }),
    orderCreateRateLimit(),
    idempotency({ scope: IDEMPOTENT_SCOPE.ORDER_CREATE }),
    validate({ body: createOrderSchema }),
    asyncHandler(orderController.create),
  );

  // 取消「待支付」订单（F8 路径 1）：越权防护在 service 层以 userId 兜底
  router.post(
    '/orders/:orderNo/cancel',
    auth({ scope: 'shop' }),
    orderCreateRateLimit(),
    validate({ params: orderNoParamSchema, body: cancelOrderSchema }),
    asyncHandler(orderController.cancel),
  );

  // 确认收货（F10 ③）：越权防护在 service 层以 userId 兜底
  router.post(
    '/orders/:orderNo/confirm',
    auth({ scope: 'shop' }),
    orderCreateRateLimit(),
    validate({ params: orderNoParamSchema }),
    asyncHandler(orderController.confirm),
  );

  // 订单列表（分页读）：validate 先跑（写回 number 的 page/pageSize），pagination 才能拿到
  router.get(
    '/orders',
    auth({ scope: 'shop' }),
    defaultRateLimit(),
    validate({ query: orderListQuerySchema }),
    pagination(),
    asyncHandler(orderController.list),
  );

  // 订单详情：路径参数 orderNo（越权/缺单由 service 抛 31001 → 404）
  router.get(
    '/orders/:orderNo',
    auth({ scope: 'shop' }),
    defaultRateLimit(),
    validate({ params: orderNoParamSchema }),
    asyncHandler(orderController.detail),
  );

  return router;
}

/** C 端订单路由单例 */
export const orderRouter = createOrderRouter();

export default orderRouter;
