/**
 * @file server/src/services/SkuService.ts
 * @description SKU 服务：实时报价（价格可缓存 60s，**库存绝不缓存**）
 * @module services
 * @see docs/04-flows.md:262（GET /api/skus/:id/quote）、docs/02-architecture.md:61（权威源是 MySQL）
 * @see docs/02-architecture.md §5.9（Key 命名与 TTL）
 * @author 软件开发团队
 * @created 2026-09-06
 *
 * 分层铁律：本服务不接触 Express 的 req/res，只做查询与组装，响应由 Controller 包装；
 * Prisma 只出现在本文件内，Controller 禁止直接写查询。
 *
 * 为什么**库存必须实时读库、绝不进缓存**（docs/04-flows.md:266）：
 * Redis 不是权威源（docs/02-architecture.md:61），库存是会被并发下单持续改写的字段。
 * 若把整个 quote（含 available）塞进缓存，用户在缓存 TTL 内看到的库存是「过去某个时刻的快照」，
 * 结果就是页面显示有货、下单时才报库存不足，甚至超卖 —— 这比慢一点严重得多。
 * 价格相反：它由后台改价触发，分钟级延迟可接受，因此允许缓存 60s。
 *
 * ⚠️ BigInt 序列化陷阱：金额是 Prisma `BigInt`（JS `bigint`），而 `JSON.stringify` 遇 bigint
 * 直接抛 `TypeError`。`CacheService` 用 `safeStringify` 把 bigint 降级成 number 存进 Redis，
 * 于是**缓存命中路径拿回的是 number，查库路径是 bigint** —— 两条路径类型不一致会让下游
 * `MoneyUtil` 直接炸。因此缓存载荷刻意只存 number（分），取回后用 {@link toCentBigInt} 归一成 bigint。
 */

import type { PrismaClient } from '@prisma/client';
import { SkuStatus } from '@prisma/client';
import { CACHE_TTL_SECONDS, REDIS_KEY } from '@/config/constants';
import { BusinessError } from '@/core/errors';
import { ErrorCode, getErrorMeta } from '@/core/errors/errorCodes';
import { getPrisma } from '@/core/prisma';
import { cacheService, type CacheService } from './CacheService';

/** SKU 报价（实时） */
export interface SkuQuote {
  /** SKU ID */
  skuId: bigint;
  /** 售价（分） */
  price: bigint;
  /** 划线原价（分），可空 */
  originalPrice: bigint | null;
  /** 实时可用库存（每次都读库，绝不缓存） */
  available: number;
  /** 是否可售：sku.status === ENABLED && deletedAt === null */
  enabled: boolean;
}

/**
 * 缓存里的价格载荷：金额一律 `number`（分）。
 *
 * 这不是精度妥协，而是刻意的边界设计：JSON 存不下 bigint，缓存层统一用 number 承载，
 * 出入缓存各转换一次，保证 service 对外**只暴露 bigint**，下游无需关心数据来自缓存还是 DB。
 */
interface SkuPricePayload {
  /** 售价（分） */
  price: number;
  /** 划线原价（分），可空 */
  originalPrice: number | null;
}

/**
 * SKU 不存在时的错误参数。
 *
 * @description `BusinessError` 默认 HTTP 409，而错误码表里 `SKU_NOT_FOUND` 登记的是 404
 * （`ERROR_META`，src/core/errors/errorCodes.ts:213）—— 404 才是「资源不存在」的正确语义，
 * 这里显式沿用错误码表的状态，避免同一码在不同抛出点给出不同 HTTP 状态
 */
const SKU_NOT_FOUND_OPTIONS = {
  code: ErrorCode.SKU_NOT_FOUND,
  httpStatus: getErrorMeta(ErrorCode.SKU_NOT_FOUND).httpStatus,
} as const;

/** 简化的 Prisma 客户端形态（本服务只用到 sku 委托） */
type DbClient = Pick<PrismaClient, 'sku'>;

/**
 * 把「分」金额归一成 bigint。
 *
 * @description 两条来源必须收敛成同一类型：
 * 1. 查库路径 —— Prisma 返回 `bigint`；
 * 2. 缓存命中路径 —— `safeStringify` 已把 bigint 降级成 `number`，`parseJson` 拿回的仍是 number。
 * 如果直接把两者混着返回，`price + count` 这类运算会撞上 `TypeError: Cannot mix BigInt and other types`，
 * 而且只在缓存命中后才炸 —— 本地自测时 Redis 多半是空的，缺陷会一路带到线上。
 *
 * 另：缓存值来自 Redis，属于**外部边界**，可能被人为写入脏数据，因此非有限值不当作 0 处理
 * （那会显示成「免费」），而是直接判为数据异常。
 *
 * @param value 金额（分），bigint 或 number，可空
 * @returns bigint（分）；入参为 null/undefined 时返回 null
 * @throws {BusinessError} 遇到非有限数值（脏缓存）：code 90007
 */
function toCentBigInt(value: number | bigint | null | undefined): bigint | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return BigInt(Math.round(value));
  }
  throw new BusinessError('SKU 价格数据异常，请稍后重试', { code: ErrorCode.SYSTEM_INTERNAL });
}

/**
 * 同 {@link toCentBigInt}，但用于**非空**金额字段（如 `price`）。
 *
 * @description `skus.price` 在库里是 `NOT NULL`，所以这里出现 null 只可能是脏缓存，
 * 属于数据异常而非「原价可空」那类正常分支，按异常抛出而不是静默补 0（补 0 等于标价免费）
 * @param value 金额（分）
 * @returns bigint（分）
 * @throws {BusinessError} 值为空或不是有限数值：code 90007
 */
function toRequiredCentBigInt(value: number | bigint | null | undefined): bigint {
  const cents = toCentBigInt(value);
  if (cents === null) {
    throw new BusinessError('SKU 价格数据异常，请稍后重试', { code: ErrorCode.SYSTEM_INTERNAL });
  }
  return cents;
}

/**
 * SKU 服务。
 */
export class SkuService {
  /** 注入的 Prisma 客户端 */
  private readonly prisma: DbClient;
  /** 注入的缓存服务 */
  private readonly cache: CacheService;

  /**
   * @param prisma Prisma 客户端，缺省时取全局单例
   * @param cache 缓存服务，缺省时取全局单例
   */
  constructor(prisma: DbClient = getPrisma(), cache: CacheService = cacheService) {
    this.prisma = prisma;
    this.cache = cache;
  }

  /**
   * 取单个 SKU 的报价。
   *
   * @description 一次调用、两条路径：
   * 1. **实时路径（每次都走）**：`status` / `deletedAt` / `stock.available` —— 库存与可售状态不缓存；
   * 2. **可缓存路径（60s）**：`price` / `originalPrice` —— 走 {@link CacheService.getOrSet}。
   *
   * 之所以拆成两次查询而不是一次查完再只缓存价格：库存本来就必须每次查库，
   * 若把价格塞进同一次查询，缓存命中与否都要打库，那 60s 缓存就**完全省不掉任何一次往返**，
   * 纯粹是额外开销。拆开之后，缓存命中时可省掉价格那次查询。
   *
   * `select` 显式挑字段，**绝不 select `costPrice`**（成本价仅后台可见，schema 注释原文），
   * 也不用 `include` 全量返回，从查询层面杜绝泄露。
   *
   * @param skuId SKU ID
   * @returns SKU 报价（价格与库存均已归一为对外类型）
   * @throws {BusinessError} SKU 不存在（21002，HTTP 404）
   */
  async getQuote(skuId: bigint): Promise<SkuQuote> {
    // 实时路径：库存与可售状态。故意不过滤 deletedAt —— 软删 SKU 由 enabled=false 表达，
    // 让调用方（购物车/订单的失效项判断）拿到「存在但不可售」这一区分度，而不是一律 404
    const live = await this.prisma.sku.findUnique({
      where: { id: skuId },
      select: {
        id: true,
        status: true,
        deletedAt: true,
        stock: { select: { available: true } },
      },
    });

    if (live === null) {
      throw new BusinessError('SKU 不存在', SKU_NOT_FOUND_OPTIONS);
    }

    const price = await this.getCachedPrice(skuId);

    return {
      skuId: live.id,
      price: toRequiredCentBigInt(price.price),
      originalPrice: toCentBigInt(price.originalPrice),
      // Sku.stock 是可空关系：没建库存记录时视为 0（等价于无货），与 SQL LEFT JOIN 的语义一致
      available: live.stock?.available ?? 0,
      enabled: live.status === SkuStatus.ENABLED && live.deletedAt === null,
    };
  }

  /**
   * 取 SKU 价格（缓存旁路，TTL 60s）。
   *
   * @description Redis 不可用时 {@link CacheService.getOrSet} 仍会执行回源，只是不回填，
   * 因此**缓存故障不会阻断报价**
   * @param skuId SKU ID
   * @returns 价格载荷（金额为 number 分）
   */
  private async getCachedPrice(skuId: bigint): Promise<SkuPricePayload> {
    const cacheKey = this.cache.buildKey(REDIS_KEY.CACHE_SKU_PRICE, String(skuId));
    return this.cache.getOrSet(cacheKey, CACHE_TTL_SECONDS.SKU_PRICE, () => this.queryPrice(skuId));
  }

  /**
   * 查库取价格（缓存回源用）。
   *
   * @description 只挑金额字段，并且**转成 number 再返回**：这里就是 bigint → number 的唯一收敛点，
   * 出缓存后再由 {@link toCentBigInt} 转回 bigint
   * @param skuId SKU ID
   * @returns 价格载荷
   * @throws {BusinessError} SKU 不存在（21002，HTTP 404）
   */
  private async queryPrice(skuId: bigint): Promise<SkuPricePayload> {
    const row = await this.prisma.sku.findUnique({
      where: { id: skuId },
      select: { price: true, originalPrice: true },
    });

    if (row === null) {
      // 并发删除场景：实时查询已放行、价格查询时记录才消失，同样按不存在处理
      throw new BusinessError('SKU 不存在', SKU_NOT_FOUND_OPTIONS);
    }

    return {
      price: Number(row.price),
      originalPrice: row.originalPrice === null ? null : Number(row.originalPrice),
    };
  }
}

/** 默认单例 */
export const skuService = new SkuService();

export default skuService;
