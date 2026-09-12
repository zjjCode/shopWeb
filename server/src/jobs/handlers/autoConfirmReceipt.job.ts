/**
 * @file server/src/jobs/handlers/autoConfirmReceipt.job.ts
 * @description 自动确认收货 Job：单条自动确认 + 兜底扫描（F10 ④ / F7.2）
 * @module jobs/handlers
 * @see docs/04-flows.md F10（自动确认收货时序）、F7.2（定时任务实现方式与多实例防重）
 * @see server/src/services/OrderService.ts（autoConfirm / scanReceivableOrders）
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
 * 单条自动确认收货（由 BullMQ Worker / cron 调用）。
 *
 * @description 失败仅记 error 日志并向上抛出，让 BullMQ 触发重试（attempts=3）。
 * 天然幂等：底层 `autoConfirm` 靠 `WHERE status='SHIPPED'` 条件更新保证。
 * @param orderNo 订单号
 * @returns 确认结果（skipped 表示已不在已发货态）
 */
export async function autoConfirmReceipt(orderNo: string): Promise<{ skipped: boolean }> {
  try {
    const result = await orderService.autoConfirm(orderNo);
    logInfo('job.autoConfirmReceipt.done', { ctx: { orderNo, skipped: result.skipped } });
    return result;
  } catch (error) {
    logError('job.autoConfirmReceipt.failed', error, { ctx: { orderNo } });
    throw error;
  }
}

/**
 * 扫描「已发货且超过自动确认时间」的订单（F7.2 兜底扫描条件）。
 *
 * @description `WHERE status='SHIPPED' AND auto_confirm_at < NOW()`，走 `idx_status_autoconfirm` 索引；
 * 按 `id` 升序分页。`LIMIT` 由调用方传入（默认 500）。
 * @param limit 单批上限
 * @returns 待自动确认的订单号列表
 */
export async function scanReceivableOrders(limit: number = SCAN_LIMIT): Promise<string[]> {
  const prisma = getPrisma();
  const rows = await prisma.order.findMany({
    where: { status: OrderStatus.SHIPPED, autoConfirmAt: { lt: new Date() } },
    select: { orderNo: true },
    orderBy: { id: 'asc' },
    take: limit,
  });
  return rows.map((row) => row.orderNo);
}
