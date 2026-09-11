/**
 * @file server/src/routes/admin/refund.routes.ts
 * @description 后台退款路由：/admin/refunds/:refundNo/audit（审核 + 触发执行）
 * @module routes/admin
 * @see docs/04-flows.md F9.1 ②（审核）、F9.3（按 pay_method 路由）
 * @see src/routes/admin/adminAuth.routes.ts（同类写法：auth({ scope:'admin' }) + adminOnly）
 * @author 软件开发团队
 * @created 2026-09-12
 */

import { type Router, Router as ExpressRouter } from 'express';
import { adminOnly } from '@/middlewares/adminOnly';
import { asyncHandler } from '@/middlewares/asyncHandler';
import { auth } from '@/middlewares/auth';
import { validate } from '@/middlewares/validate';
import { adminRefundController } from '@/controllers/admin/AdminRefundController';
import { auditRefundSchema, refundNoParamSchema } from '@/validators/refund.validator';

/**
 * 构建后台退款路由。
 *
 * @returns Express Router
 */
export function createAdminRefundRouter(): Router {
  const router = ExpressRouter();

  // 审核退款：审核通过即触发执行（BALANCE 即时 SUCCESS / CHANNEL 置 FAILED 不 500）
  router.post(
    '/refunds/:refundNo/audit',
    auth({ scope: 'admin' }),
    adminOnly(),
    validate({ params: refundNoParamSchema, body: auditRefundSchema }),
    asyncHandler(adminRefundController.audit),
  );

  return router;
}

/** 后台退款路由单例 */
export const adminRefundRouter = createAdminRefundRouter();

export default adminRefundRouter;
