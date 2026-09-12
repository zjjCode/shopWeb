/**
 * @file server/src/routes/admin/order.routes.ts
 * @description 后台订单路由：POST /admin/orders/:orderNo/ship（发货，F10 ①）
 * @module routes/admin
 * @see docs/04-flows.md F10（发货与确认收货）
 * @see src/routes/admin/refund.routes.ts（同类写法：auth({ scope:'admin' }) + adminOnly + authorize）
 * @author 软件开发团队
 * @created 2026-09-12
 */

import { type Router, Router as ExpressRouter } from 'express';
import { authorize } from '@/middlewares/authorize';
import { adminOnly } from '@/middlewares/adminOnly';
import { asyncHandler } from '@/middlewares/asyncHandler';
import { auth } from '@/middlewares/auth';
import { validate } from '@/middlewares/validate';
import { adminOrderController } from '@/controllers/admin/AdminOrderController';
import { orderNoParamSchema, shipOrderSchema } from '@/validators/order.validator';

/**
 * 构建后台订单路由。
 *
 * @returns Express Router
 */
export function createAdminOrderRouter(): Router {
  const router = ExpressRouter();

  // 发货：F10 ①，仅已支付订单可发；rbac(admin:order:ship) 细粒度权限校验
  router.post(
    '/orders/:orderNo/ship',
    auth({ scope: 'admin' }),
    adminOnly(),
    authorize('order:ship'),
    validate({ params: orderNoParamSchema, body: shipOrderSchema }),
    asyncHandler(adminOrderController.ship),
  );

  return router;
}

/** 后台订单路由单例 */
export const adminOrderRouter = createAdminOrderRouter();

export default adminOrderRouter;
