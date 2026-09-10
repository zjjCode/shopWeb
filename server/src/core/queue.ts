/**
 * @file server/src/core/queue.ts
 * @description BullMQ 连接与队列定义：payment-callback / refund-exec / order-close / order-auto-confirm / notify
 * @module core
 * @see docs/02-architecture.md §10.1（异步任务与队列）
 * @author 软件开发团队
 * @created 2026-09-03
 *
 * 为什么支付回调要「先落日志 + 投递队列、由 Worker 消费」：
 * 入账事务（资金流水 + 订单状态 + 库存确认）耗时长且必须串行，
 * 而渠道对回调有严格的响应时限（支付宝要求 5s 内返回 success，否则重发）。
 * 直接同步处理会在高并发下超时并触发渠道重发风暴，因此这里只负责**可靠投递**。
 */

import { Queue, type Job, type JobsOptions } from 'bullmq';
import type IORedis from 'ioredis';
import { config } from '@/config';
import { QUEUE_NAMES, QUEUE_LIMITS, DEFAULT_BACKOFF_DELAY_MS } from '@/config/constants';
import { getRequestId } from '@/core/logger/requestContext';
import { logError, logInfo } from '@/core/logger/logger';

/** 队列名联合类型 */
export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/**
 * 任务数据的公共外壳。
 *
 * @description 所有任务都带 `requestId`，Worker 入口据此重建日志上下文，
 * 使「回调日志」与「入账日志」能串成一条链路（§10.2 requestId 透传）
 */
export interface JobEnvelope<T = Record<string, unknown>> {
  /** 链路追踪 ID */
  requestId: string;
  /** 业务单号，便于日志检索与人工排查 */
  bizNos?: Record<string, string>;
  /** 任务业务载荷 */
  payload: T;
}

/** 队列实例缓存（同一进程内同名队列只建一次） */
const queueCache = new Map<QueueName, Queue>();

/** BullMQ 专用连接（进程级单例，独立于业务 Redis 连接） */
let connection: IORedis | null = null;

/**
 * 获取 BullMQ 使用的 Redis 连接。
 *
 * 为什么与 `core/redis.ts` 分开：
 * 1. BullMQ 要求 `maxRetriesPerRequest: null`（它自己管理重试语义，交给 ioredis 反而会丢任务）；
 * 2. 业务连接受损降级时，不应连带把队列连接也关掉 —— 队列是资金入账的可靠通道，必须独立存活。
 *
 * @returns ioredis 连接实例
 */
export function getQueueConnection(): IORedis {
  if (connection !== null) {
    return connection;
  }

  // 动态 require：ioredis 是本模块的类型依赖而非运行时必需，
  // 延迟到真正使用队列时才加载，减少冷启动开销。
  // 此处刻意豁免 @typescript-eslint/no-var-requires：改成静态 import 会强制冷启动时
  // 加载 ioredis，与本函数存在的意义（延迟加载）相悖，故保留 require 而非改代码迁就规则。
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const RedisCtor = (require('ioredis') as typeof import('ioredis')).default;

  const instance = new RedisCtor(config.redis.url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    connectTimeout: config.redis.connectTimeoutMs,
  });

  instance.on('error', (error: Error) => {
    // 队列连接异常必须打 error：支付回调投递失败意味着资金入账延迟，属于需要人工关注的故障
    logError('queue.connection_error', error);
  });

  connection = instance;
  return instance;
}

/**
 * 获取（或创建）指定队列。
 *
 * @description 默认重试策略统一走「指数退避 + 固定间隔兜底」，各队列并发见 `QUEUE_LIMITS`
 * @param name 队列名
 * @returns BullMQ 队列实例
 */
export function getQueue(name: QueueName): Queue {
  const cached = queueCache.get(name);
  if (cached !== undefined) {
    return cached;
  }

  const queue = new Queue(name, {
    connection: getQueueConnection(),
    defaultJobOptions: {
      attempts: QUEUE_LIMITS[name].attempts,
      backoff: { type: 'exponential', delay: DEFAULT_BACKOFF_DELAY_MS },
      removeOnComplete: { age: 7 * 24 * 3_600, count: 5_000 },
      // 失败任务保留 30 天：资金类任务需要人工介入重放，不能自动清掉
      removeOnFail: { age: 30 * 24 * 3_600 },
    },
  });

  queue.on('error', (error: Error) => {
    logError('queue.error', error, { ctx: { queue: name } });
  });

  queueCache.set(name, queue);
  return queue;
}

/** 支付回调入账队列 */
export const paymentCallbackQueue = (): Queue => getQueue(QUEUE_NAMES.PAYMENT_CALLBACK);
/** 退款执行队列（渠道调用必须在事务外） */
export const refundExecQueue = (): Queue => getQueue(QUEUE_NAMES.REFUND_EXEC);
/** 超时关单队列 */
export const orderCloseQueue = (): Queue => getQueue(QUEUE_NAMES.ORDER_CLOSE);
/** 自动确认收货队列 */
export const orderAutoConfirmQueue = (): Queue => getQueue(QUEUE_NAMES.ORDER_AUTO_CONFIRM);
/** 通知队列（失败仅告警，不阻塞主流程） */
export const notifyQueue = (): Queue => getQueue(QUEUE_NAMES.NOTIFY);

/**
 * 投递任务。
 *
 * @description 统一在该入口完成两件事：
 * 1. **jobId 去重**：同一业务单号重复投递只会被 BullMQ 接受一次（天然幂等），
 *    避免渠道重发回调导致重复入账；
 * 2. **requestId 透传**：未显式传入时取当前请求上下文，保证链路可追踪。
 *
 * @param name 队列名
 * @param jobName 任务类型名（Worker 按此分派处理器）
 * @param payload 业务载荷
 * @param options 投递选项
 * @returns 已创建的任务；Redis 不可用时返回 null（调用方需自行落库兜底）
 */
export async function enqueue<T extends Record<string, unknown>>(
  name: QueueName,
  jobName: string,
  payload: T,
  options: { jobId?: string; requestId?: string; bizNos?: Record<string, string>; delayMs?: number } = {},
): Promise<Job<JobEnvelope<T>> | null> {
  const envelope: JobEnvelope<T> = {
    requestId: options.requestId ?? getRequestId(),
    bizNos: options.bizNos,
    payload,
  };

  const jobOptions: JobsOptions = {};
  if (options.jobId !== undefined && options.jobId.length > 0) {
    jobOptions.jobId = options.jobId;
  }
  if (options.delayMs !== undefined && options.delayMs > 0) {
    jobOptions.delay = options.delayMs;
  }

  try {
    const job = await getQueue(name).add(jobName, envelope, jobOptions);
    logInfo('queue.enqueued', {
      ctx: { queue: name, jobName, jobId: options.jobId ?? job.id, bizNos: options.bizNos },
    });
    return job as Job<JobEnvelope<T>>;
  } catch (error) {
    // 投递失败不能静默：支付回调没进队列就等于这笔钱永远入不了账
    logError('queue.enqueue_failed', error, {
      ctx: { queue: name, jobName, jobId: options.jobId, bizNos: options.bizNos },
    });
    return null;
  }
}

/**
 * 关闭全部队列与底层连接。
 *
 * @description 优雅退出时调用：`queue.close()` 会等待进行中的任务落盘，
 * 直接 kill 进程可能造成任务状态卡在 active 直到超时
 * @returns Promise，全部关闭后 resolve
 */
export async function closeQueues(): Promise<void> {
  await Promise.all(
    Array.from(queueCache.values()).map(async (queue) => {
      try {
        await queue.close();
      } catch (error) {
        logError('queue.close_failed', error);
      }
    }),
  );
  queueCache.clear();

  if (connection !== null) {
    const instance = connection;
    connection = null;
    try {
      await instance.quit();
    } catch {
      instance.disconnect();
    }
  }
}
