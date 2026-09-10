/**
 * @file server/src/services/CacheService.ts
 * @description Redis 缓存封装：get / set / del / delByPattern + 缓存旁路 getOrSet，Redis 不可用时**降级放行**
 * @module services
 * @see docs/02-architecture.md §5.9（Key 命名规范）、docs/02-architecture.md:61（资金/库存/订单的权威源永远是 MySQL）
 * @author 软件开发团队
 * @created 2026-09-06
 *
 * 定位：**Redis 不是权威源**（docs/02-architecture.md:61 定调）。
 * 本组件只承担「性能与并发辅助」，因此任何 Redis 故障都**不得阻断业务**：
 * - `get` 失败 / 缓存未命中 → 返回 `null`，调用方走查库路径；
 * - `set` / `del` 失败 → 静默失败并记 warn 日志，绝不向上抛错。
 * 这与 `src/core/redis.ts` 的降级哲学一致：**保护措施不应该比它要防护的故障更致命**。
 *
 * Key 规范：统一由 {@link CacheService.buildKey} 生成 `「前缀:命名空间:参数」`，
 * 前缀取 `config.redis.keyPrefix`（默认即 `REDIS_KEY.PREFIX`），命名空间取 `REDIS_KEY.*` 常量，
 * 业务代码**禁止**自行拼接 `shop:` 前缀。所有缓存键必须带 TTL（锁除外，见 §5.9）。
 *
 * ⚠️ BigInt 坑：本项目金额是 `BIGINT`，Prisma 返回 JS `bigint`，而 `JSON.stringify` 遇到 bigint
 * 直接抛 `TypeError: Do not know how to serialize a BigInt`。因此序列化统一走
 * `@/core/response` 的 `safeStringify`（内置 bigint → number 转换），反序列化用 `parseJson`
 * （解析失败返回 null 而非抛错）。若缓存的业务对象含金额字段，取回后是 `number` 而非 `bigint`，
 * 这是刻意的：缓存只服务读接口，响应层同样会把 bigint 转 number（见 response.ts 的 jsonReplacer）。
 */

import type { Redis } from 'ioredis';
import { config } from '@/config';
import { logWarn } from '@/core/logger/logger';
import { getRedis } from '@/core/redis';
import { parseJson, safeStringify } from '@/core/response';

/** Redis 客户端获取器（返回 null 表示不可用）；注入式设计便于单测用假客户端驱动 */
export type RedisProvider = () => Redis | null;

/** SCAN 每次迭代的建议返回条数（不是硬上限，仅影响单次往返开销） */
const SCAN_COUNT = 200;

/**
 * Redis 缓存服务。
 *
 * @description 无状态：每次操作都重新取连接（连接本身是进程级单例），
 * 因此 Redis 中途故障恢复后无需重建本对象
 */
export class CacheService {
  /** Redis 客户端获取器 */
  private readonly provider: RedisProvider;

  /**
   * @param provider Redis 获取器，缺省取全局单例（{@link getRedis}）
   */
  constructor(provider: RedisProvider = getRedis) {
    this.provider = provider;
  }

  /**
   * 生成缓存 Key。
   *
   * @description 形如 `shop:cache:product:123`；前缀取自配置，命名空间取自 `REDIS_KEY.*`
   * @param namespace 命名空间（传 `REDIS_KEY` 中的常量，如 `REDIS_KEY.CACHE_CATEGORY_TREE`）
   * @param parts 业务标识片段（如 ID），按顺序拼接
   * @returns 完整 Key
   */
  buildKey(namespace: string, ...parts: Array<string | number>): string {
    return [`${config.redis.keyPrefix}:${namespace}`, ...parts].join(':');
  }

  /**
   * 读取缓存。
   *
   * @description Redis 不可用 / 命令失败 / 内容解析失败 / 未命中，一律返回 `null`，
   * 让调用方走查库路径——**缓存未命中不是错误**
   * @param key 完整 Key（由 {@link buildKey} 生成）
   * @returns 缓存值，或 null
   */
  async get<T>(key: string): Promise<T | null> {
    const redis = this.client();
    if (redis === null) {
      return null;
    }
    try {
      const raw = await redis.get(key);
      if (typeof raw !== 'string' || raw.length === 0) {
        return null;
      }
      return parseJson<T>(raw);
    } catch (error) {
      logWarn('cache.get_failed', { ctx: { key, reason: describeError(error) } });
      return null;
    }
  }

  /**
   * 写入缓存（带 TTL）。
   *
   * @description 失败静默返回 false：写不进缓存最多是慢一点，不该让接口 500
   * @param key 完整 Key
   * @param value 待缓存值（会被 JSON 序列化，bigint 自动降级为 number）
   * @param ttlSeconds 过期秒数，必须为正（§5.9：缓存键全部带 TTL）
   * @returns 写入成功 true
   */
  async set<T>(key: string, value: T, ttlSeconds: number): Promise<boolean> {
    const redis = this.client();
    if (redis === null) {
      return false;
    }
    // 序列化单独 try：bigint / 循环引用导致的失败不该被误记为「Redis 故障」
    let payload: string;
    try {
      payload = safeStringify(value);
    } catch (error) {
      logWarn('cache.serialize_failed', { ctx: { key, reason: describeError(error) } });
      return false;
    }
    try {
      await redis.set(key, payload, 'EX', ttlSeconds);
      return true;
    } catch (error) {
      logWarn('cache.set_failed', { ctx: { key, reason: describeError(error) } });
      return false;
    }
  }

  /**
   * 删除一个或多个 Key。
   *
   * @param keys 待删除的 Key
   * @returns 实际删除的条数（Redis 不可用时为 0）
   */
  async del(...keys: string[]): Promise<number> {
    if (keys.length === 0) {
      return 0;
    }
    const redis = this.client();
    if (redis === null) {
      return 0;
    }
    try {
      return await redis.del(...keys);
    } catch (error) {
      logWarn('cache.del_failed', { ctx: { count: keys.length, reason: describeError(error) } });
      return 0;
    }
  }

  /**
   * 按模式批量删除（如 `shop:cache:product:*`）。
   *
   * @description **用 SCAN 而不是 KEYS**：KEYS 会一次性遍历整个键空间并阻塞单线程 Redis，
   * 键多时等同于一次线上故障。SCAN 是增量迭代，每次只扫 `SCAN_COUNT` 条，代价是可能
   * 漏掉迭代期间新增的键——缓存清理场景下可接受（漏掉的下次清理或等 TTL 自然过期）
   * @param pattern 匹配模式（传完整 Key 模式，含前缀与命名空间）
   * @returns 实际删除的条数
   */
  async delByPattern(pattern: string): Promise<number> {
    const redis = this.client();
    if (redis === null) {
      return 0;
    }
    let cursor = '0';
    let deleted = 0;
    try {
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', SCAN_COUNT);
        cursor = next;
        if (keys.length > 0) {
          await redis.del(...keys);
          deleted += keys.length;
        }
      } while (cursor !== '0');
      return deleted;
    } catch (error) {
      logWarn('cache.del_by_pattern_failed', {
        ctx: { pattern, deleted, reason: describeError(error) },
      });
      return deleted;
    }
  }

  /**
   * 缓存旁路（cache-aside）：命中直接返回，未命中回源并回填。
   *
   * @description 这是本组件的主要用法——把「查缓存 → 未命中查库 → 回填」三步收敛到一处，
   * 且 Redis 不可用时**依然会执行 `loader`**（只是不回填），业务正确性不受影响
   * @param key 完整 Key
   * @param ttlSeconds 过期秒数
   * @param loader 回源函数（通常是一次 DB 查询）
   * @returns 缓存值或回源结果
   */
  async getOrSet<T>(key: string, ttlSeconds: number, loader: () => Promise<T>): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) {
      return cached;
    }
    const value = await loader();
    await this.set(key, value, ttlSeconds);
    return value;
  }

  /**
   * 取 Redis 连接，不可用或获取过程抛错时返回 null。
   *
   * @description `getRedis()` 本身不抛错，但注入的 provider（如某些封装）可能抛，
   * 这里一并兜住，保证「取连接」这一动作绝不会让缓存调用方崩掉
   * @returns Redis 实例或 null
   */
  private client(): Redis | null {
    try {
      return this.provider();
    } catch (error) {
      logWarn('cache.client_unavailable', { ctx: { reason: describeError(error) } });
      return null;
    }
  }
}

/**
 * 错误描述（仅取 message，不序列化整个 Error 对象）。
 *
 * @param error 任意异常
 * @returns 可读描述
 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 默认单例 */
export const cacheService = new CacheService();

export default cacheService;
