/**
 * @file server/src/jobs/handlers/retryRefund.job.ts
 * @description 渠道退款重试 Job：单笔重试 + 兜底扫描（F9.2 失败重试策略 / T080-D）
 * @module jobs/handlers
 * @see docs/04-flows.md F9.2（失败重试策略）、docs/12-phase12-plan.md（第一批：T080 重试）
 * @see server/src/services/RefundService.ts（retry：FAILED→PROCESSING→SUCCESS 重投）
 * @author 软件开发团队
 * @created 2026-09-18
 */

import { RefundStatus } from '@prisma/client';
import { getPrisma } from '@/core/prisma';
import { logInfo } from '@/core/logger/logger';
import { REFUND_RULE } from '@/constants/bizRules';
import { refundService } from '@/services/RefundService';

/** 单次扫描上限（F9.2：LIMIT 200 分页，避免单批过大） */
export const RETRY_SCAN_LIMIT = 200;

/**
 * 单笔退款重试（由 cron 兜底扫描调用）。
 *
 * @description 结果语义见 {@link refundService.retry}：'retried' | 'skipped' | 'exhausted'。
 * 失败不在此抛出——由调度器逐单捕获，避免单笔异常中断整批扫描。
 * @param refundNo 退款单号
 * @returns 重试结果字面量
 */
export async function retryRefund(refundNo: string): Promise<'retried' | 'skipped' | 'exhausted'> {
  const result = await refundService.retry(refundNo);
  logInfo('job.retryRefund.done', { ctx: { refundNo, result } });
  return result;
}

/**
 * 扫描「超时失败且仍可重试」的退款单（F9.2 兜底扫描条件）。
 *
 * @description `WHERE status='FAILED' AND retry_count < RETRY_MAX AND next_retry_at <= NOW()`，
 * 走 `idx_status_next_retry_at` 索引；按 `next_retry_at` 升序（最紧迫的先重试），分页取。
 * 已超 `RETRY_MAX` 的终态单不在此扫描范围，转人工处理。
 * @param limit 单批上限
 * @returns 待重试的退款单号列表
 */
export async function scanFailedRefunds(limit: number = RETRY_SCAN_LIMIT): Promise<string[]> {
  const prisma = getPrisma();
  const rows = await prisma.refund.findMany({
    where: {
      status: RefundStatus.FAILED,
      retryCount: { lt: REFUND_RULE.RETRY_MAX },
      nextRetryAt: { lte: new Date() },
    },
    select: { refundNo: true },
    orderBy: { nextRetryAt: 'asc' },
    take: limit,
  });
  return rows.map((row) => row.refundNo);
}
