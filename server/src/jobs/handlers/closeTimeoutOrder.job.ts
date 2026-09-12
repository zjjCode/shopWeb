/**
 * @file server/src/jobs/handlers/closeTimeoutOrder.job.ts
 * @description 超时关单 Job：单条关单 + 兜底扫描（F10 / F7.2）
 * @module jobs/handlers
 * @see docs/04-flows.md F10（超时关单时序）、F7.2（定时任务实现方式与多实例防重）
 * @see server/src/services/OrderService.ts（closeByTimeout：状态机 + 释放冻结 + 关闭待支付单）
 * @author 软件开发团队
 * @created 2026-09-12
 */

import { OrderStatus } from '@prisma/client';
import { getPrisma } from '@/core/prisma';
import { logError, logInfo } from '@/core/logger/logger';
import { orderService } from '@/services/OrderService';

/** 单次扫描上限（F7.2：LIMIT 500 分页） */
export const SCAN_LIMIT = 500;

/**
 * 单条超时关单（由 BullMQ Worker / cron 调用）。
 *
 * @description 失败仅记 error 日志并向上抛出，让 BullMQ 触发重试（attempts=3）。
 * 天然幂等：底层 `closeByTimeout` 靠 `WHERE status='PENDING_PAYMENT'` 条件更新保证。
 * @param orderNo 订单号
 * @returns 关单结果（skipped 表示已不在待支付态）
 */
export async function closeTimeoutOrder(orderNo: string): Promise<{ skipped: boolean }> {
  try {
    const result = await orderService.closeByTimeout(orderNo);
    logInfo('job.closeTimeoutOrder.done', { ctx: { orderNo, skipped: result.skipped } });
    return result;
  } catch (error) {
    logError('job.closeTimeoutOrder.failed', error, { ctx: { orderNo } });
    throw error;
  }
}

/**
 * 扫描「已超时且仍为待支付」的订单（F7.2 兜底扫描条件）。
 *
 * @description `WHERE status='PENDING_PAYMENT' AND expire_at < NOW()`，走 `idx_status_expire` 索引；
 * 按 `id` 升序分页，避免漏扫与乱序。`LIMIT` 由调用方传入（默认 500）。
 * @param limit 单批上限
 * @returns 待关单的订单号列表
 */
export async function scanExpiredOrders(limit: number = SCAN_LIMIT): Promise<string[]> {
  const prisma = getPrisma();
  const rows = await prisma.order.findMany({
    where: { status: OrderStatus.PENDING_PAYMENT, expireAt: { lt: new Date() } },
    select: { orderNo: true },
    orderBy: { id: 'asc' },
    take: limit,
  });
  return rows.map((row) => row.orderNo);
}
