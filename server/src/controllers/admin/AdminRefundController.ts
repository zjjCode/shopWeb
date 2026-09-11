/**
 * @file server/src/controllers/admin/AdminRefundController.ts
 * @description 后台退款控制器：/admin/refunds/:refundNo/audit（审核 + 触发执行）
 * @module controllers/admin
 * @see docs/04-flows.md F9.1 ②（审核）、F9.2（失败重试策略）、F9.3（按 pay_method 路由退款）
 * @see src/controllers/admin/AdminAuthController.ts（后台作用域同类写法）
 * @author 软件开发团队
 * @created 2026-09-12
 *
 * 审核终点 = 触发执行：本端点 `audit(approve=true)` 通过后**立即执行退款**
 * （F9.1 ② 审核通过即进入退款中 → F9.1 ④ 执行）。两条资金安全硬约束在此兑现：
 * - **BALANCE 即时 SUCCESS**：余额退款是本地事务，execute 成功即退款单 SUCCESS、钱已退回余额；
 * - **CHANNEL 捕获 4104 置 FAILED 不 500**：一期无 PaymentAdapter，execute 抛 ExternalServiceError(4104)，
 *   本端点捕获后调 `refundService.markChannelFailed` 把退款单置 FAILED（订单状态不变），
 *   返回 2xx 而非 500，避免「钱没退但接口崩了」的脏状态。
 *
 * 越权防护：后台审核只认 `req.auth`（admin 作用域），`refundNo` 来自路径参数且 service 按单号定位，
 * 不存在「改单号看别人退款」的越权（后台本就可见全部）。C 端 token 被 `adminOnly()` 挡在门外。
 */

import type { Request, Response } from 'express';
import { ExternalServiceError } from '@/core/errors';
import { ErrorCode } from '@/core/errors/errorCodes';
import { sendOk } from '@/core/response';
import { RefundStatus } from '@prisma/client';
import { refundService } from '@/services/RefundService';
import type { AuditRefundBody, RefundNoParam } from '@/validators/refund.validator';

/**
 * 后台退款控制器。
 */
export class AdminRefundController {
  /**
   * 审核退款：POST /admin/refunds/:refundNo/audit。
   *
   * @description 同意即触发执行退款，驳回只推进退款单状态（不执行任何资金操作）：
   * - 驳回（approve=false）→ status = REJECTED，订单状态不变；
   * - 同意 + 余额退款（refundTo=BALANCE）→ execute 成功 → status = SUCCESS；
   * - 同意 + 渠道退款（refundTo=CHANNEL）→ execute 抛 4104（一期无 PaymentAdapter）
   *   → 捕获后置 status = FAILED（订单状态不变），返回 2xx 而非 500。
   *
   * 其它异常（如并发重复审核 41003、平台账户缺失 60001）照常向上抛，由 errorHandler 统一处理。
   * @param req Express 请求（params.refundNo 与 body.approve/remark 已由 validate 校验）
   * @param res Express 响应
   * @returns void
   */
  async audit(req: Request, res: Response): Promise<void> {
    const { refundNo } = req.params as unknown as RefundNoParam;
    const { approve, remark } = req.body as AuditRefundBody;
    const adminId = BigInt(req.auth!.userId);

    // 第一步：条件更新推进退款单（PENDING → PROCESSING / REJECTED）；非 PENDING 抛 41003
    await refundService.audit(adminId, refundNo, approve, remark);

    // 驳回：直接返回 REJECTED，不执行任何资金操作（订单状态不变）
    if (!approve) {
      sendOk(res, { refundNo, status: RefundStatus.REJECTED });
      return;
    }

    // 同意：立即执行退款。BALANCE 即时 SUCCESS；CHANNEL 抛 4104 → 置 FAILED 不 500
    let status: RefundStatus = RefundStatus.PROCESSING;
    try {
      await refundService.execute(refundNo);
      status = RefundStatus.SUCCESS;
    } catch (error) {
      if (error instanceof ExternalServiceError && error.code === ErrorCode.REFUND_EXEC_FAILED) {
        // 渠道退款一期未实现：把退款单标记 FAILED（execute 事务已回滚，订单状态不变），
        // 返回 2xx 而非 500，避免「钱没退但接口崩」的脏状态
        await refundService.markChannelFailed(refundNo, (error as Error).message);
        status = RefundStatus.FAILED;
      } else {
        // 其它异常（并发 / 平台账户缺失等）照常向上抛
        throw error;
      }
    }

    sendOk(res, { refundNo, status });
  }
}

/** 默认单例 */
export const adminRefundController = new AdminRefundController();

export default adminRefundController;
