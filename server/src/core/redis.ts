/**
 * @file server/src/core/redis.ts
 * @description ioredis 单例 + 连接降级：不可用时返回 null，绝不阻塞主流程
 * @module core
 * @see docs/02-architecture.md §5.9（Key 命名规范）、§5.8（限流降级策略）
 * @author 软件开发团队
 * @created 2026-09-03
 *
 * 降级策略的取舍：
 * Redis 在本系统里只承担「限流、缓存、削峰锁、队列底座」四种职责，
 * 全部都有 DB 侧的权威兜底（库存权威是 DB CAS、账户权威是 FOR UPDATE）。
 * 因此 Redis 故障时**降级放行**优于「直接拒绝请求」——
 * 保护措施不应该比它要防护的故障更致命。
 */

import Redis, { type RedisOptions } from 'ioredis';
import { config } from '@/config';
import { logError, logWarn } from '@/core/logger/logger';

/** 进程级单例连接 */
let client: Redis | null = null;

/** 是否已进入降级态（连接不可用后置 true，避免每次请求都重连打日志风暴） */
let degraded = false;

/** 是否已打印过降级告警（同一进程只打一次，避免刷屏） */
let degradedLogged = false;

/**
 * 构造连接参数。
 *
 * 注意：**不设置 `keyPrefix`**。所有调用方（如 rateLimit）已按 §5.9 自行拼接
 * `shop:{domain}:...` 前缀，这里再设会变成 `shop:shop:rl:...` 双前缀。
 *
 * @returns ioredis 连接参数
 */
function buildOptions(): RedisOptions {
  return {
    lazyConnect: true,
    // 命令超时必须小于 HTTP 超时，否则慢 Redis 会把请求线程拖死
    connectTimeout: config.redis.connectTimeoutMs,
    commandTimeout: config.redis.commandTimeoutMs,
    maxRetriesPerRequest: 2,
    // 必须开启离线队列：lazyConnect 下首次命令会先排队等建连，
    // 否则冷启动的头几个请求会因为「连接还没就绪」被误判成 Redis 故障而降级。
    // 真正的 Redis 故障由 retryStrategy（10 次后放弃）+ commandTimeout 兜底。
    enableOfflineQueue: true,
    retryStrategy: (times: number) => (times > 10 ? null : Math.min(times * 200, 3_000)),
  };
}

/**
 * 标记进入降级态。
 *
 * @description 只打一次 error 日志：Redis 抖动可能每秒触发成千上万条错误事件，
 * 全量打印会先压垮磁盘和日志采集
 * @param reason 降级原因
 */
function markDegraded(reason: string): void {
  degraded = true;
  if (degradedLogged) {
    return;
  }
  degradedLogged = true;
  logError('redis.degraded', new Error(reason), {
    ctx: { hint: '后续依赖 Redis 的能力（限流/缓存/削峰锁）将走降级路径' },
  });
}

/**
 * 获取 Redis 连接。
 *
 * @description Redis 不可用或处于降级态时返回 `null`，调用方必须自行兜底
 * @returns Redis 实例，或 null（不可用 / 降级态）
 */
export function getRedis(): Redis | null {
  if (degraded) {
    return null;
  }
  if (client !== null) {
    // 只排除终态（end/close）：connecting / reconnecting 状态下命令会在离线队列里等待就绪，
    // 如果把 connecting 也判成不可用，冷启动期间所有限流都会误降级到内存计数。
    return client.status === 'end' || client.status === 'close' ? null : client;
  }

  const instance = new Redis(config.redis.url, buildOptions());

  instance.on('error', (error: Error) => {
    markDegraded(error.message);
  });
  instance.on('end', () => {
    markDegraded('连接已关闭');
  });

  // 首次调用不等待连接完成：调用方用 await 执行命令时 ioredis 会自动排队建连。
  // 这里显式触发连接，把「连接失败」暴露在第一次使用而不是更后面的某个随机请求上。
  instance.connect().catch((error: Error) => {
    markDegraded(error.message);
  });

  client = instance;
  return instance;
}

/**
 * 获取 Redis 连接，不可用时抛错。
 *
 * @description 仅供「没有 Redis 就无法正确执行」的场景使用（如分布式锁抢占）；
 * 常规缓存与限流请用 {@link getRedis} + 降级
 * @returns Redis 实例
 * @throws {Error} Redis 不可用时抛出
 */
export function getRedisOrThrow(): Redis {
  const instance = getRedis();
  if (instance === null) {
    throw new Error('Redis 当前不可用（降级态），无法执行该操作');
  }
  return instance;
}

/**
 * 判断 Redis 当前是否可用。
 *
 * @returns 可用时 true
 */
export function isRedisAvailable(): boolean {
  return getRedis() !== null;
}

/**
 * 在 Redis 可用时执行回调，不可用或报错时返回兜底值。
 *
 * @description 把「取不到就降级」的样板代码收敛到一处，业务侧只关心返回值
 * @param fn Redis 可用时执行的操作
 * @param fallback 兜底值
 * @returns 操作结果或兜底值
 */
export async function withRedis<T>(fn: (redis: Redis) => Promise<T>, fallback: T): Promise<T> {
  const redis = getRedis();
  if (redis === null) {
    return fallback;
  }
  try {
    return await fn(redis);
  } catch (error) {
    logWarn('redis.command_failed', {
      ctx: { reason: error instanceof Error ? error.message : String(error) },
    });
    return fallback;
  }
}

/**
 * 关闭 Redis 连接。
 *
 * @description 优雅退出时调用；`quit()` 会等命令发完再关，`disconnect()` 是强拆。
 * 这里用 quit，避免丢掉正在写入的限流计数
 * @returns Promise，关闭完成后 resolve
 */
export async function closeRedis(): Promise<void> {
  if (client === null) {
    return;
  }
  const instance = client;
  client = null;
  degraded = false;
  degradedLogged = false;
  try {
    await instance.quit();
  } catch {
    instance.disconnect();
  }
}
