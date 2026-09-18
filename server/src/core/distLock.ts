/**
 * @file server/src/core/distLock.ts
 * @description Redis 分布式锁（SET key value PX ttl NX）：多实例下 cron 兜底扫描去重（F7.2）
 * @module core
 * @see docs/04-flows.md F7.2（定时任务实现方式与多实例防重）、docs/12-phase12-plan.md（T091 调度锁）
 * @author 软件开发团队
 * @created 2026-09-18
 *
 * 设计取舍（与 `redis.ts` 整体「保护不能比故障更致命」原则一致）：
 * - **降级放行**：Redis 不可用或命令失败时返回 `true`（放行），由 DB 层条件更新兜底幂等。
 *   多实例下「某一轮扫描重复跑一次」远优于「Redis 抖动导致所有实例的定时任务全停」。
 * - **自带自动过期（PX）**：无需手动释放；TTL 需 > 扫描间隔，确保正常不会并发重叠。
 *   若强一致释放（防 TTL 内实例宕机后备用实例干等），需引入随机 token + Lua 比对删除，
 *   本批按 F7.2 注释原口径（SET NX PX）实现，够用且不引入额外复杂度。
 */

import { getRedis } from '@/core/redis';
import { logWarn } from '@/core/logger/logger';

/** 分布式锁默认 TTL（毫秒）：兜底扫描类任务 90s，覆盖单批扫描耗时且大于扫描间隔 */
export const DIST_LOCK_DEFAULT_TTL_MS = 90_000;

/**
 * 尝试获取分布式锁。
 *
 * @description `SET shop:lock:{key} 1 PX {ttlMs} NX`：同一时刻只允许一个实例持有，
 * 用于「关单 / 自动确认 / 退款重试」等 cron 兜底扫描的去重（F7.2）。
 * Redis 不可用 / 命令失败 → 降级放行（返回 true），由 DB 条件更新兜底幂等。
 * @param key 锁名（无需前缀，内部统一拼 `shop:lock:`）
 * @param ttlMs 锁过期时间（毫秒）；建议 > 扫描间隔
 * @returns 获取成功或降级放行时为 true；被其他实例占用时为 false
 */
export async function tryAcquireLock(
  key: string,
  ttlMs: number = DIST_LOCK_DEFAULT_TTL_MS,
): Promise<boolean> {
  const redis = getRedis();
  if (redis === null) {
    // Redis 不可用：降级放行，避免定时任务全停（DB 条件更新兜底幂等）
    logWarn('dist_lock.redis_unavailable_degrade', { ctx: { key } });
    return true;
  }
  try {
    const result = await redis.set(`shop:lock:${key}`, '1', 'PX', ttlMs, 'NX');
    return result === 'OK';
  } catch (error) {
    // 命令失败同样降级放行，与 Redis 不可用同口径
    logWarn('dist_lock.acquire_failed_degrade', {
      ctx: { key, reason: error instanceof Error ? error.message : String(error) },
    });
    return true;
  }
}
