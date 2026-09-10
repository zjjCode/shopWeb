/**
 * @file server/src/routes/api/address.routes.ts
 * @description C 端收货地址路由：/api/addresses（列表 / 新增 / 修改 / 删除 / 设为默认）
 * @module routes/api
 * @see docs/02-architecture.md §5.5（中间件顺序）、§5.8（限流）
 * @see src/routes/api/cart.routes.ts（同类写法：auth + defaultRateLimit + validate + asyncHandler）
 * @author 软件开发团队
 * @created 2026-09-07
 *
 * 为什么每个端点都挂 `auth({ scope: 'shop' })`：
 * 收货地址是**用户私有数据**。漏挂等于任何人都能列/改/删别人的地址。
 * 控制器里只从 `req.auth` 取 userId，中间件则是第一道闸门——两者缺一不可。
 *
 * 「设为默认」用 `PUT /api/addresses/:id/default`：语义是「把某地址置为默认」的幂等整体替换，
 * 符合 REST 对 PUT 的约定（整条资源状态变为默认），也比 PATCH 字段更明确、不易被误用为局部更新。
 */

import { type Router, Router as ExpressRouter } from 'express';
import { RATE_LIMIT_KEY, RATE_LIMIT_PRESETS } from '@/config/constants';
import { addressController } from '@/controllers/AddressController';
import { asyncHandler } from '@/middlewares/asyncHandler';
import { auth } from '@/middlewares/auth';
import { rateLimit } from '@/middlewares/rateLimit';
import { validate } from '@/middlewares/validate';
import {
  addressIdParamSchema,
  createAddressSchema,
  updateAddressSchema,
} from '@/validators/address.validator';

/**
 * 统一的「默认接口」限流（沿用购物车方案，阈值未单独规定时统一 120 次/分钟）。
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
 * 构建 C 端收货地址路由。
 *
 * @returns Express Router
 */
export function createAddressRouter(): Router {
  const router = ExpressRouter();

  // 列表：只返回未软删、默认地址排最前
  router.get('/addresses', auth({ scope: 'shop' }), defaultRateLimit(), asyncHandler(addressController.list));

  // 新增
  router.post(
    '/addresses',
    auth({ scope: 'shop' }),
    defaultRateLimit(),
    validate({ body: createAddressSchema }),
    asyncHandler(addressController.create),
  );

  // 修改
  router.patch(
    '/addresses/:id',
    auth({ scope: 'shop' }),
    defaultRateLimit(),
    validate({ params: addressIdParamSchema, body: updateAddressSchema }),
    asyncHandler(addressController.update),
  );

  // 删除（软删）
  router.delete(
    '/addresses/:id',
    auth({ scope: 'shop' }),
    defaultRateLimit(),
    validate({ params: addressIdParamSchema }),
    asyncHandler(addressController.remove),
  );

  // 设为默认
  router.put(
    '/addresses/:id/default',
    auth({ scope: 'shop' }),
    defaultRateLimit(),
    validate({ params: addressIdParamSchema }),
    asyncHandler(addressController.setDefault),
  );

  return router;
}

/** C 端收货地址路由单例 */
export const addressRouter = createAddressRouter();

export default addressRouter;
