/**
 * @file server/src/routes/api/cart.routes.ts
 * @description C 端购物车路由：/api/cart（列表 / 加购 / 改数量 / 删除 / 未登录合并）
 * @module routes/api
 * @see docs/02-architecture.md §5.5（中间件顺序）、§5.8（限流）
 * @see docs/04-flows.md:307、321、329、338（F4 购物车四个时序）
 * @author 软件开发团队
 * @created 2026-09-07
 *
 * 为什么每个端点都要挂 `auth({ scope: 'shop' })`：
 * 购物车是**用户私有数据**。漏挂等于任何人都能列/改/删别人的购物车。
 * 控制器里只从 `req.auth` 取 userId，中间件则是这条约束的第一道闸门——
 * 两者缺一不可：只用控制器约束则未登录请求会打到 service，只用中间件则控制器仍可能被误改成从入参读。
 *
 * 限流：写操作（加购 / 改 / 删 / 合并）比读更容易被脚本刷，但设计文档未单独给出购物车阈值，
 * 因此统一沿用「默认接口」120 次/分钟；后续若出现刷单再按 §5.8 单独调阈值。
 *
 * 路由形状说明：`DELETE /cart/items` 用请求体传 `ids[]` 而不是 `DELETE /cart/items/:id`，
 * 因为结算成功后要一次性清掉一批条目，逐个删会产生 N 次往返且无法保证原子性。
 */

import { type Router, Router as ExpressRouter } from 'express';
import { RATE_LIMIT_KEY, RATE_LIMIT_PRESETS } from '@/config/constants';
import { cartController } from '@/controllers/CartController';
import { asyncHandler } from '@/middlewares/asyncHandler';
import { auth } from '@/middlewares/auth';
import { rateLimit } from '@/middlewares/rateLimit';
import { validate } from '@/middlewares/validate';
import {
  addCartItemSchema,
  cartItemIdParamSchema,
  mergeCartSchema,
  removeCartItemsSchema,
  updateCartItemSchema,
} from '@/validators/cart.validator';

/**
 * 统一的「默认接口」限流。
 *
 * @description 抽成工厂而不是复制四遍参数：限流阈值一旦要调，
 * 散落四处的字面量一定会有漏改的那个
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
 * 构建 C 端购物车路由。
 *
 * @returns Express Router
 */
export function createCartRouter(): Router {
  const router = ExpressRouter();

  // 列表：实时有效性校验（失效项 / 价格变动 / 仅勾选有效项的合计）
  router.get('/cart', auth({ scope: 'shop' }), defaultRateLimit(), asyncHandler(cartController.list));

  // 加购：同 SKU 累加不增行
  router.post(
    '/cart/items',
    auth({ scope: 'shop' }),
    defaultRateLimit(),
    validate({ body: addCartItemSchema }),
    asyncHandler(cartController.addItem),
  );

  // 改数量 / 勾选：params 与 body 都要校验
  router.patch(
    '/cart/items/:id',
    auth({ scope: 'shop' }),
    defaultRateLimit(),
    validate({ params: cartItemIdParamSchema, body: updateCartItemSchema }),
    asyncHandler(cartController.updateItem),
  );

  // 批量删除：DELETE + body ids[]
  router.delete(
    '/cart/items',
    auth({ scope: 'shop' }),
    defaultRateLimit(),
    validate({ body: removeCartItemsSchema }),
    asyncHandler(cartController.removeItems),
  );

  // 合并未登录购物车（localStorage → 服务端）
  router.post(
    '/cart/merge',
    auth({ scope: 'shop' }),
    defaultRateLimit(),
    validate({ body: mergeCartSchema }),
    asyncHandler(cartController.merge),
  );

  return router;
}

/** C 端购物车路由单例 */
export const cartRouter = createCartRouter();

export default cartRouter;
