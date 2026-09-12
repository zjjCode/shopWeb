/**
 * @file server/src/jobs/scheduler.ts
 * @description 异步任务调度器：BullMQ Worker（消费延迟关单 job）+ cron 兜底扫描（F7.2 / F10）
 * @module jobs
 * @see docs/04-flows.md F7.2（定时任务实现方式与多实例防重）、F10（超时关单）
 * @see server/src/core/queue.ts（order-close 队列定义）
 * @author 软件开发团队
 * @created 2026-09-12
 *
 * 双触发设计（F7.2）：
 * - **主触发**：下单时注册的 BullMQ 延迟 job（delay = expireAt - now，jobId = orderNo 去重），
 *   由本模块启动的 Worker 在到期时精确消费；
 * - **兜底**：`setInterval` 每 60s 扫描一次已超时待支付订单，直接关单，
 *   覆盖「job 丢失 / 服务重启 / Redis 抖动」等延迟 job 未触达的场景。
 *
 * 多实例防重：BullMQ 保证一个延迟 job 只被一个 Worker 领取；cron 兜底由应用层单实例部署约定保证
 * （若多实例部署，需按 F7.2 加 Redis 分布式锁 `SET shop:lock:job:close-timeout-order NX PX`，本期未接）。
 *
 * 测试环境（`config.env === 'test'`）不启动，避免单测触碰 Redis / 真实 DB。
 */

import { Worker } from 'bullmq';
import type { Job } from 'bullmq';
import { config } from '@/config';
import { QUEUE_NAMES } from '@/config/constants';
import { getQueueConnection } from '@/core/queue';
import { logError, logInfo } from '@/core/logger/logger';
import { closeTimeoutOrder, scanExpiredOrders } from './handlers/closeTimeoutOrder.job';

/** cron 兜底扫描间隔（毫秒）：F7.2 规定 1 分钟 */
const SCAN_INTERVAL_MS = 60_000;

/** 延迟关单 job 的处理并发（对齐 QUEUE_LIMITS[ORDER_CLOSE].concurrency） */
const CLOSE_CONCURRENCY = 3;

/** 轮询定时器（cron 兜底扫描） */
let scanTimer: ReturnType<typeof setInterval> | null = null;

/** BullMQ Worker（消费延迟关单 job） */
let closeWorker: Worker | null = null;

/**
 * 从 job 数据中抽取订单号。
 *
 * @description `enqueue` 会把业务载荷包进 `JobEnvelope`：`job.data.payload.orderNo`；
 * 同时兼容裸 `{ orderNo }`，便于测试直接构造 job。
 * @param data 任务数据
 * @returns 订单号或 undefined
 */
function extractOrderNo(data: unknown): string | undefined {
  if (data === null || typeof data !== 'object') {
    return undefined;
  }
  const envelope = data as { payload?: { orderNo?: string }; orderNo?: string };
  const candidate = envelope.payload?.orderNo ?? envelope.orderNo;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined;
}

/**
 * 启动调度器（幂等，重复调用只生效一次）。
 *
 * @description 测试环境直接返回。生产/开发环境：启动 Worker 消费延迟关单 job，
 * 并启动 cron 兜底扫描（启动即补偿一次）。
 */
export function startScheduler(): void {
  if (config.env === 'test') {
    return;
  }
  if (closeWorker !== null || scanTimer !== null) {
    return; // 幂等：避免热重载/重复启动造成多实例
  }

  // ① Worker：消费下单时注册的延迟关单 job（F10 触发方式 A，精确）
  closeWorker = new Worker(
    QUEUE_NAMES.ORDER_CLOSE,
    async (job: Job) => {
      const orderNo = extractOrderNo(job.data);
      if (orderNo !== undefined) {
        await closeTimeoutOrder(orderNo);
      }
    },
    { connection: getQueueConnection(), concurrency: CLOSE_CONCURRENCY },
  );
  closeWorker.on('error', (error: Error) => {
    logError('scheduler.worker_error', error, { ctx: { queue: QUEUE_NAMES.ORDER_CLOSE } });
  });

  // ② cron 兜底扫描（F7.2 触发方式 B，防 job 丢失 / 服务重启）
  const tick = async (): Promise<void> => {
    try {
      const orderNos = await scanExpiredOrders();
      for (const orderNo of orderNos) {
        // 直接处理而非再次入队：最简单可靠，且两条路径都天然幂等
        await closeTimeoutOrder(orderNo);
      }
      if (orderNos.length > 0) {
        logInfo('scheduler.scan_done', { ctx: { closed: orderNos.length } });
      }
    } catch (error) {
      logError('scheduler.scan_failed', error);
    }
  };

  void tick(); // 启动即补偿一次（覆盖服务重启期间堆积的超时单）
  scanTimer = setInterval(tick, SCAN_INTERVAL_MS);
}

/**
 * 停止调度器（优雅退出时调用）。
 *
 * @description 清除定时器并关闭 Worker（Worker.close 会等待进行中的 job 落盘）。
 */
export async function stopScheduler(): Promise<void> {
  if (scanTimer !== null) {
    clearInterval(scanTimer);
    scanTimer = null;
  }
  if (closeWorker !== null) {
    const worker = closeWorker;
    closeWorker = null;
    await worker.close();
  }
}
