/**
 * @file server/src/middlewares/rateLimit.ts
 * @description 限流中间件工厂：Redis 固定窗口计数（多实例共享）+ 内存兜底 + 失败放行
 * @module middlewares
 * @see docs/02-architecture.md §5.8（限流封装）
 * @author 软件开发团队
 * @created 2026-09-03
 */

import type { Request, RequestHandler } from 'express';
import { config } from '@/config';
import { RATE_LIMIT_KEY, RATE_LIMIT_PRESETS } from '@/config/constants';
import { RateLimitError } from '@/core/errors';
import { logWarn } from '@/core/logger/logger';
import { getRedis } from '@/core/redis';
import { asyncHandler } from './asyncHandler';

/** 限流配置 */
export interface RateLimitOptions {
  /** 窗口时长（毫秒） */
  windowMs: number;
  /** 窗口内允许的最大请求数 */
  max: number;
  /** Redis Key 前缀（默认按 IP 维度） */
  prefix?: string;
  /** 自定义 Key 生成器（如按用户、按手机号） */
  keyGenerator?: (req: Request) => string;
  /** 超限提示文案 */
  message?: string;
}

/** 计数结果 */
interface CounterResult {
  /** 当前窗口内的累计请求数 */
  count: number;
  /** 距窗口重置的剩余毫秒数 */
  resetMs: number;
}

/** 内存兜底计数表（Redis 不可用时启用） */
const memoryCounters = new Map<string, { count: number; resetAt: number }>();

/** 内存表容量上限，超出后整体清空（防止恶意 IP 撑爆内存） */
const MEMORY_COUNTER_MAX = 10_000;

/**
 * 默认 Key 生成器：按 IP + 路由（`shop:rl:ip:{ip}:{METHOD}:{path}`）。
 *
 * @param req Express 请求对象
 * @returns 限流 Key 的业务部分
 */
export function defaultKeyGenerator(req: Request): string {
  const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
  const route = `${req.method}:${req.baseUrl}${req.path}`;
  return `${ip}:${route}`;
}

/**
 * 内存计数（Redis 不可用时的降级路径）。
 *
 * @param key 完整 Key
 * @param windowMs 窗口时长
 * @returns 计数结果
 */
function consumeMemory(key: string, windowMs: number): CounterResult {
  const now = Date.now();
  const current = memoryCounters.get(key);

  if (current === undefined || current.resetAt <= now) {
    memoryCounters.set(key, { count: 1, resetAt: now + windowMs });
    if (memoryCounters.size > MEMORY_COUNTER_MAX) {
      memoryCounters.clear();
    }
    return { count: 1, resetMs: windowMs };
  }

  current.count += 1;
  return { count: current.count, resetMs: current.resetAt - now };
}

/**
 * 消费一次配额（优先 Redis，失败降级内存）。
 *
 * 为什么 Redis 失败要**放行而不是拒绝**（§5.8）：
 * 限流的目的是保护系统，但 Redis 抖动时若把流量全部拒绝，等于把「Redis 故障」放大成「全站不可用」，
 * 这是典型的「保护措施比它要防护的故障更致命」。因此 Redis 异常时降级为单进程内存计数并打 warn。
 *
 * @param key 完整 Key
 * @param windowMs 窗口时长
 * @returns 计数结果
 */
async function consume(key: string, windowMs: number): Promise<CounterResult> {
  const redis = getRedis();
  if (redis === null) {
    return consumeMemory(key, windowMs);
  }

  try {
    const count = await redis.incr(key);
    if (count === 1) {
      // 首次命中才设置过期时间：保证窗口从第一次请求开始计时（固定窗口语义）
      await redis.pexpire(key, windowMs);
    }
    const ttl = await redis.pttl(key);
    return { count, resetMs: ttl > 0 ? ttl : windowMs };
  } catch (error) {
    logWarn('rate_limit.redis_degraded', { key, reason: error instanceof Error ? error.message : String(error) });
    return consumeMemory(key, windowMs);
  }
}

/**
 * 创建限流中间件。
 *
 * @description 返回 429 时携带 `Retry-After` 响应头（由 errorHandler 依据 RateLimitError 写入）
 * @param options 窗口、阈值、Key 维度
 * @returns Express 中间件
 */
export function rateLimit(options: RateLimitOptions): RequestHandler {
  const { windowMs, max, prefix = RATE_LIMIT_KEY.IP, keyGenerator = defaultKeyGenerator, message } = options;

  return asyncHandler(async (req, _res, next) => {
    if (!config.rateLimit.enabled) {
      next();
      return;
    }

    const key = `${config.redis.keyPrefix}:${prefix}:${keyGenerator(req)}`;
    const result = await consume(key, windowMs);

    if (result.count > max) {
      throw new RateLimitError(message, Math.ceil(result.resetMs / 1000));
    }

    next();
  });
}

/**
 * 全局兜底限流（单 IP 600 次 / 分钟）。
 *
 * @returns Express 中间件
 */
export function globalRateLimit(): RequestHandler {
  return rateLimit({
    windowMs: RATE_LIMIT_PRESETS.GLOBAL.windowMs,
    max: RATE_LIMIT_PRESETS.GLOBAL.max,
    prefix: RATE_LIMIT_KEY.GLOBAL,
    keyGenerator: (req) => req.ip ?? req.socket.remoteAddress ?? 'unknown',
  });
}

/**
 * 默认接口限流（用户优先，未登录退化到 IP，120 次 / 分钟）。
 *
 * @description 登录后以用户维度为准（§5.8：登录后以用户维度优先于 IP），
 * 避免同一出口 IP（如公司 NAT）下的多个用户互相挤占配额
 * @returns Express 中间件
 */
export function defaultRateLimit(): RequestHandler {
  return rateLimit({
    windowMs: RATE_LIMIT_PRESETS.DEFAULT.windowMs,
    max: RATE_LIMIT_PRESETS.DEFAULT.max,
    prefix: RATE_LIMIT_KEY.USER,
    keyGenerator: (req) => {
      const userId = req.auth?.userId;
      return userId !== undefined && req.auth?.scope === 'shop'
        ? `user:${userId}:${req.method}:${req.baseUrl}${req.path}`
        : defaultKeyGenerator(req);
    },
  });
}
