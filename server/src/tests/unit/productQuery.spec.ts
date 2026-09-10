/**
 * @file server/src/tests/unit/productQuery.spec.ts
 * @description 商品 / SKU 前台查询单测：排序白名单、分类**子树**筛选、缓存与查库两条路径的金额类型一致性、
 *              库存不被缓存污染、成本价不泄露、缓存故障不阻断业务
 * @module tests/unit
 * @see server/src/services/ProductService.ts、server/src/services/SkuService.ts
 * @see docs/04-flows.md:243（商品列表）、:252（商品详情）、:262（SKU 报价）
 * @see docs/02-architecture.md:61（Redis 不是权威源）
 * @author 软件开发团队
 * @created 2026-09-06
 *
 * 为什么必须有这批用例：环境里**没有 MySQL 与 Redis 实例**，集成测试跑不起来，而下面这些逻辑
 * `tsc` 一个都检查不出来，一旦出错就是线上事故：
 * 1. 分类筛选漏掉子孙分类（只查 `parentId` 一层 → 用户点一级分类看不到三级分类下的商品）；
 * 2. 缓存命中路径与查库路径的金额类型不一致（number vs bigint → 下游 `MoneyUtil` 直接炸）；
 * 3. 库存被缓存污染（页面显示有货、下单才报库存不足，甚至超卖）；
 * 4. 成本价 `costPrice` 泄露给前台；
 * 5. `count` 与 `findMany` 条件漂移（「总数 100 但第 3 页没数据」）。
 *
 * 全部用假 Prisma（构造函数注入）+ 真 `CacheService` 注入假 Redis 驱动，不依赖任何真实实例。
 */

import { describe, expect, it, jest } from '@jest/globals';

// config 在模块加载时即校验环境变量并可能 process.exit；测试环境没有 .env，
// 因此用假 config 注入固定前缀，避免加载真实配置
jest.mock('@/config', () => ({
  config: {
    env: 'test',
    redis: { keyPrefix: 'shop' },
    // logger 在 import 时即读 config.log.level 建 winston 实例，缺了会让整个套件起不来
    log: { level: 'error', dir: '' },
  },
  isProduction: false,
  isTest: true,
  isDevelopment: false,
}));

// 单例在模块加载时会调用 getPrisma()，用假实现避免建真实客户端
jest.mock('@/core/prisma', () => ({
  getPrisma: jest.fn(() => ({})),
}));

// CacheService 的默认 provider 取的是这里的 getRedis，默认返回 null（模拟「无 Redis 实例」）
jest.mock('@/core/redis', () => ({
  getRedis: jest.fn(() => null),
}));

import type { Prisma, PrismaClient } from '@prisma/client';
import { CategoryStatus, ProductStatus, SkuStatus } from '@prisma/client';
import type { Redis } from 'ioredis';
import { BusinessError } from '@/core/errors';
import { ErrorCode } from '@/core/errors/errorCodes';
import { jsonReplacer } from '@/core/response';
import { CacheService } from '@/services/CacheService';
import {
  buildOrderBy,
  fromSnapshot,
  ProductService,
  toSnapshot,
  type ProductDetail,
  type ProductListItem,
} from '@/services/ProductService';
import { SkuService } from '@/services/SkuService';
import type { PageParams } from '@/types/common';
import type { ProductListQuery } from '@/validators/product.validator';
import type { SortOrder } from '@/utils/paging';

// ---------------------------------------------------------------------------
// 假 Prisma
// ---------------------------------------------------------------------------

/** 商品 findMany 入参（只声明断言用到的字段） */
interface ProductFindManyArgs {
  where?: Record<string, unknown>;
  orderBy?: unknown;
  skip?: number;
  take?: number;
  select?: Record<string, unknown>;
}

/** 商品 findFirst 入参 */
interface ProductFindFirstArgs {
  where?: Record<string, unknown>;
  select?: Record<string, unknown>;
}

/** 分类查询入参 */
interface CategoryFindArgs {
  where?: Record<string, unknown>;
  select?: Record<string, unknown>;
}

/** SKU findUnique 入参 */
interface SkuFindUniqueArgs {
  where?: { id?: bigint };
  select?: Record<string, unknown>;
}

/** 详情查询里的一行 SKU（**刻意带上 costPrice**，用于验证它不会外泄） */
interface FakeSkuDetailRow {
  id: bigint;
  specValues: Prisma.JsonValue;
  price: bigint;
  originalPrice: bigint | null;
  imageUrl: string | null;
  costPrice: bigint;
}

/** 商品详情查询返回的一行（含三个嵌套查询） */
interface FakeProductRow {
  id: bigint;
  categoryId: bigint;
  name: string;
  subTitle: string | null;
  mainImage: string;
  detail: string | null;
  minPrice: bigint;
  maxPrice: bigint;
  totalSales: number;
  images: Array<{ id: bigint; url: string; sort: number }>;
  specs: Array<{ id: bigint; name: string; values: Prisma.JsonValue; sort: number }>;
  skus: FakeSkuDetailRow[];
}

/** SKU 实时查询返回行 */
interface FakeSkuLiveRow {
  id: bigint;
  status: SkuStatus;
  deletedAt: Date | null;
  stock: { available: number } | null;
}

/** SKU 价格查询返回行 */
interface FakeSkuPriceRow {
  price: bigint;
  originalPrice: bigint | null;
}

/** SKU 两次查询的返回联合 */
type FakeSkuRow = FakeSkuLiveRow | FakeSkuPriceRow;

/**
 * 构造假 Prisma：三个委托的方法都是可断言的 `jest.fn`，整体再断言成 `PrismaClient` 注入服务。
 *
 * @description 每个用例内各自调用一次，避免用例间共享 mock 状态
 * @returns 注入用的 prisma 与各个 mock 句柄
 */
function buildFakePrisma() {
  const productFindMany = jest.fn<(args: ProductFindManyArgs) => Promise<ProductListItem[]>>(async () => []);
  const productCount = jest.fn<(args: { where?: Record<string, unknown> }) => Promise<number>>(async () => 0);
  const productFindFirst = jest.fn<(args: ProductFindFirstArgs) => Promise<FakeProductRow | null>>(async () => null);
  const categoryFindFirst = jest.fn<(args: CategoryFindArgs) => Promise<{ path: string } | null>>(async () => null);
  const categoryFindMany = jest.fn<(args: CategoryFindArgs) => Promise<Array<{ id: bigint }> | null>>(async () => []);
  const skuFindUnique = jest.fn<(args: SkuFindUniqueArgs) => Promise<FakeSkuRow | null>>(async () => null);

  const prisma = {
    product: { findMany: productFindMany, count: productCount, findFirst: productFindFirst },
    category: { findFirst: categoryFindFirst, findMany: categoryFindMany },
    sku: { findUnique: skuFindUnique },
  } as unknown as PrismaClient;

  return {
    prisma,
    product: { findMany: productFindMany, count: productCount, findFirst: productFindFirst },
    category: { findFirst: categoryFindFirst, findMany: categoryFindMany },
    sku: { findUnique: skuFindUnique },
  };
}

/**
 * 取 mock 第 index 次调用的第一个入参（index 从 0 开始）。
 *
 * @param calls `mock.mock.calls`
 * @param index 调用序号
 * @returns 第一个入参
 * @throws 该次调用不存在时给出明确错误信息（好过拿到 undefined 再报一堆无关断言）
 */
function callArg<T extends unknown[]>(calls: readonly T[], index: number): T[0] {
  const args = calls[index];
  if (args === undefined) {
    throw new Error(`mock 只被调用了 ${calls.length} 次，取不到第 ${index + 1} 次调用的入参`);
  }
  return args[0];
}

// ---------------------------------------------------------------------------
// 假 Redis
// ---------------------------------------------------------------------------

/**
 * 构造 Map 支撑的假 Redis（仅实现 CacheService 用到的命令）。
 *
 * @returns store（可直接读写底层数据）与 redis 客户端
 */
function buildFakeRedis() {
  const store = new Map<string, string>();

  const get = jest.fn<(key: string) => Promise<string | null>>(async (key) => store.get(key) ?? null);
  const set = jest.fn<(key: string, value: string, mode: string, ttl: number) => Promise<'OK'>>(async (key, value) => {
    store.set(key, value);
    return 'OK';
  });
  const del = jest.fn<(...keys: string[]) => Promise<number>>(async (...keys) => {
    let removed = 0;
    for (const key of keys) {
      if (store.delete(key)) {
        removed += 1;
      }
    }
    return removed;
  });
  const scan = jest.fn<(cursor: string, ...args: unknown[]) => Promise<[string, string[]]>>(async () => ['0', []]);

  return { store, redis: { get, set, del, scan } as unknown as Redis };
}

// ---------------------------------------------------------------------------
// 测试数据
// ---------------------------------------------------------------------------

/** 固定分页参数 */
const PAGING_FIXTURE: PageParams = { page: 2, pageSize: 20, skip: 20, take: 20 };

/**
 * 商品详情夹具（金额与 ID 一律 bigint）。
 *
 * @returns 详情
 */
function detailFixture(): ProductDetail {
  return {
    product: {
      id: 100n,
      categoryId: 12n,
      name: '旗舰手机',
      subTitle: '8G+128G',
      mainImage: 'https://cdn.test/main.png',
      detail: '<p>图文详情</p>',
      minPrice: 199900n,
      maxPrice: 299900n,
      totalSales: 7,
    },
    images: [{ id: 1n, url: 'https://cdn.test/1.png', sort: 0 }],
    specs: [{ id: 2n, name: '颜色', values: ['陨石黑', '冰川银'], sort: 0 }],
    skus: [
      {
        id: 10n,
        specValues: { 颜色: '陨石黑' },
        price: 199900n,
        originalPrice: 229900n,
        imageUrl: null,
      },
      {
        id: 11n,
        specValues: { 颜色: '冰川银' },
        price: 209900n,
        originalPrice: null,
        imageUrl: null,
      },
    ],
  };
}

/**
 * 商品详情**数据库行**夹具。
 *
 * @description 刻意带上 `costPrice`：它模拟「有人把 select 写成 `include: { skus: true }`」
 * 时 Prisma 会返回的字段，用来验证服务层没有把它透传出去
 * @returns 数据库行
 */
function dbRowFixture(): FakeProductRow {
  const detail = detailFixture();
  return {
    ...detail.product,
    images: detail.images,
    specs: detail.specs,
    skus: detail.skus.map((sku) => ({ ...sku, costPrice: 150000n })),
  };
}

/**
 * SKU 实时行夹具。
 *
 * @param overrides 覆盖字段
 * @returns 实时行
 */
function liveRow(overrides: Partial<FakeSkuLiveRow> = {}): FakeSkuLiveRow {
  return { id: 10n, status: SkuStatus.ENABLED, deletedAt: null, stock: { available: 100 }, ...overrides };
}

/**
 * SKU 价格行夹具。
 *
 * @param overrides 覆盖字段
 * @returns 价格行
 */
function priceRow(overrides: Partial<FakeSkuPriceRow> = {}): FakeSkuPriceRow {
  return { price: 9900n, originalPrice: 10900n, ...overrides };
}

/**
 * 判断一次 SKU 查询是否查价格（用于假实现分流「实时查询 / 价格查询」）。
 *
 * @param args findUnique 入参
 * @returns 是否查价格
 */
function selectsPrice(args: SkuFindUniqueArgs): boolean {
  return Object.keys(args.select ?? {}).includes('price');
}

/**
 * 递归收集任意值里出现过的所有键名。
 *
 * @description 用于「成本价泄露」这类**负向断言**：必须递归，因为 `costPrice` 可能藏在任何一层
 * @param value 任意值
 * @param found 收集器
 * @returns 键名数组（含重复）
 */
function collectKeys(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectKeys(item, found);
    }
    return found;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, nested] of Object.entries(value)) {
      found.push(key);
      collectKeys(nested, found);
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// 一、buildOrderBy（清单 1）
// ---------------------------------------------------------------------------

describe('buildOrderBy', () => {
  it('四个白名单字段各自映射到正确的 Prisma 字段（price→minPrice、sales→totalSales）', () => {
    expect(buildOrderBy('createdAt', 'desc')).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    expect(buildOrderBy('price', 'asc')).toEqual([{ minPrice: 'asc' }, { id: 'desc' }]);
    expect(buildOrderBy('sales', 'desc')).toEqual([{ totalSales: 'desc' }, { id: 'desc' }]);
    expect(buildOrderBy('sort', 'asc')).toEqual([{ sort: 'asc' }, { id: 'desc' }]);
  });

  it('白名单外的字段一律回退到默认 sort，绝不把用户输入原样拼进 Prisma', () => {
    // 前 3 个是「看起来像字段名」的注入尝试，后 5 个是畸形输入
    const illegal = ['', 'minPrice', 'costPrice', 'stock.available', 'id', 'PRICE', 'sort; DROP TABLE products', '__proto__'];

    for (const field of illegal) {
      for (const order of ['asc', 'desc'] as SortOrder[]) {
        const orderBy = buildOrderBy(field, order);
        expect(orderBy[0]).toEqual({ sort: order });
        expect(Object.keys(orderBy[0])).toEqual(['sort']);
      }
    }

    // 关键：用户输入不得作为字段名出现在 orderBy 里（否则等于把表结构当成对外契约）
    expect(JSON.stringify(buildOrderBy('costPrice', 'desc'))).not.toContain('costPrice');
    expect(JSON.stringify(buildOrderBy('stock.available', 'desc'))).not.toContain('available');
  });

  it('所有分支都追加 id 降序做次级排序（分页稳定性：MySQL 对同键值顺序不保证）', () => {
    for (const field of ['createdAt', 'price', 'sales', 'sort', 'unknownField']) {
      for (const order of ['asc', 'desc'] as SortOrder[]) {
        const orderBy = buildOrderBy(field, order);
        expect(orderBy).toHaveLength(2);
        expect(orderBy[1]).toEqual({ id: 'desc' });
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 二、toSnapshot / fromSnapshot 往返（清单 2）
// ---------------------------------------------------------------------------

describe('toSnapshot / fromSnapshot', () => {
  it('bigint → number → bigint 往返严格相等，且类型仍是 bigint', () => {
    const detail = detailFixture();
    const snapshot = toSnapshot(detail);

    // 快照必须 JSON 安全：否则写缓存这一步就炸（JSON.stringify 遇 bigint 抛 TypeError）
    expect(() => JSON.stringify(snapshot)).not.toThrow();
    expect(snapshot.product.minPrice).toBe(199900);
    expect(typeof snapshot.product.minPrice).toBe('number');
    expect(snapshot.skus[0]?.price).toBe(199900);
    expect(snapshot.skus[0]?.originalPrice).toBe(229900);

    const back = fromSnapshot(snapshot);

    expect(back.product.id).toBe(detail.product.id);
    expect(back.product.categoryId).toBe(detail.product.categoryId);
    expect(back.product.minPrice).toBe(detail.product.minPrice);
    expect(back.product.maxPrice).toBe(detail.product.maxPrice);
    expect(typeof back.product.minPrice).toBe('bigint');
    expect(back.skus.map((sku) => sku.price)).toEqual(detail.skus.map((sku) => sku.price));
    expect(typeof back.skus[0]?.price).toBe('bigint');
    expect(back.skus[0]?.originalPrice).toBe(229900n);
    expect(back.skus[1]?.originalPrice).toBeNull();
    expect(back.images[0]?.id).toBe(1n);
    expect(back.specs[0]?.id).toBe(2n);
  });

  it('往返对「超大金额」与「原价为空」同样成立（金额不因降级而丢值）', () => {
    const base = detailFixture();
    const large: ProductDetail = {
      ...base,
      product: { ...base.product, minPrice: 900_000_000_000n },
      skus: [{ id: 10n, specValues: { 颜色: '陨石黑' }, price: 199900n, originalPrice: null, imageUrl: null }],
    };

    const back = fromSnapshot(toSnapshot(large));

    expect(back.product.minPrice).toBe(900_000_000_000n);
    expect(typeof back.product.minPrice).toBe('bigint');
    expect(back.skus[0]?.originalPrice).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 三、ProductService.list（清单 3 ~ 6）
// ---------------------------------------------------------------------------

describe('ProductService.list', () => {
  it('分类筛选覆盖整棵子树：用 Category.path 前缀匹配，绝不是 parentId 只查一层', async () => {
    const { prisma, product, category } = buildFakePrisma();
    // 父级是二级分类 /1/12/
    category.findFirst.mockImplementation(async () => ({ path: '/1/12/' }));
    // 子树：自身 12、三级 1234（其父级是 123，用 parentId=12 根本查不到它）
    category.findMany.mockImplementation(async () => [{ id: 12n }, { id: 123n }, { id: 1234n }]);
    const service = new ProductService(prisma, new CacheService(() => null));

    await service.list({ page: 1, pageSize: 20, categoryId: 12n }, PAGING_FIXTURE);

    // 取子树：path 前缀匹配，而不是 parentId
    const subtreeArgs = callArg(category.findMany.mock.calls, 0);
    expect(subtreeArgs.where?.path).toEqual({ startsWith: '/1/12/' });
    expect(subtreeArgs.where).not.toHaveProperty('parentId');

    // 落到商品上的条件是「子树 id 列表 in 查询」，且必须包含三级分类 1234
    const where = callArg(product.findMany.mock.calls, 0).where ?? {};
    const categoryId = where.categoryId as { in: bigint[] } | undefined;
    expect(categoryId).toBeDefined();
    expect(categoryId?.in).toEqual([12n, 123n, 1234n]);
    // 显式否定「只查直接子类」的写法——这是本项目最典型的 bug
    expect(where).not.toHaveProperty('parentId');
    expect(where.categoryId).not.toEqual(12n);
  });

  it('固定过滤条件：status = ON_SALE 且 deletedAt = null（草稿 / 待审 / 下架 / 软删一律不可见）', async () => {
    const { prisma, product } = buildFakePrisma();
    const service = new ProductService(prisma, new CacheService(() => null));

    await service.list({ page: 1, pageSize: 20 }, PAGING_FIXTURE);

    const where = callArg(product.findMany.mock.calls, 0).where ?? {};
    expect(where.status).toBe(ProductStatus.ON_SALE);
    expect(where.deletedAt).toBeNull();
  });

  it('分类不存在 / 已禁用 / 已删除 → 短路返回空列表，findMany 与 count 一次都不调用', async () => {
    const { prisma, product, category } = buildFakePrisma();
    category.findFirst.mockImplementation(async () => null);
    const service = new ProductService(prisma, new CacheService(() => null));

    const result = await service.list({ page: 1, pageSize: 20, categoryId: 999n }, PAGING_FIXTURE);

    expect(result).toEqual({ list: [], total: 0 });
    expect(product.findMany).not.toHaveBeenCalled();
    expect(product.count).not.toHaveBeenCalled();
  });

  it('分类查询本身过滤 ENABLED 且未软删（父级禁用时其下商品不能从列表页漏出来）', async () => {
    const { prisma, category } = buildFakePrisma();
    category.findFirst.mockImplementation(async () => ({ path: '/1/' }));
    category.findMany.mockImplementation(async () => [{ id: 1n }]);
    const service = new ProductService(prisma, new CacheService(() => null));

    await service.list({ page: 1, pageSize: 20, categoryId: 1n }, PAGING_FIXTURE);

    const lookup = callArg(category.findFirst.mock.calls, 0);
    expect(lookup.where?.id).toBe(1n);
    expect(lookup.where?.status).toBe(CategoryStatus.ENABLED);
    expect(lookup.where?.deletedAt).toBeNull();

    const subtree = callArg(category.findMany.mock.calls, 0);
    expect(subtree.where?.status).toBe(CategoryStatus.ENABLED);
    expect(subtree.where?.deletedAt).toBeNull();
  });

  it('count 与 findMany 共用同一个 where 对象（防止「总数 100 但第 3 页没数据」）', async () => {
    const { prisma, product, category } = buildFakePrisma();
    category.findFirst.mockImplementation(async () => ({ path: '/1/' }));
    category.findMany.mockImplementation(async () => [{ id: 1n }, { id: 2n }]);
    const service = new ProductService(prisma, new CacheService(() => null));
    const query: ProductListQuery = { page: 1, pageSize: 20, categoryId: 1n, keyword: '手机' };

    await service.list(query, PAGING_FIXTURE);

    expect(product.count).toHaveBeenCalledTimes(1);
    expect(product.findMany).toHaveBeenCalledTimes(1);

    const countWhere = callArg(product.count.mock.calls, 0).where;
    const findManyWhere = callArg(product.findMany.mock.calls, 0).where;

    // 深度相等只是底线；同一个引用才能证明「没有把条件写两遍」
    expect(countWhere).toEqual(findManyWhere);
    expect(countWhere).toBe(findManyWhere);
    // 关键字条件确实进了 where，上面的相等断言才有意义
    expect(countWhere?.name).toEqual({ contains: '手机' });
    expect(findManyWhere?.categoryId).toEqual({ in: [1n, 2n] });
  });
});

// ---------------------------------------------------------------------------
// 四、ProductService.detail（清单 7、8、15）
// ---------------------------------------------------------------------------

describe('ProductService.detail', () => {
  it('缓存未命中与命中两条路径的金额都必须是 bigint', async () => {
    const { prisma, product } = buildFakePrisma();
    product.findFirst.mockImplementation(async () => dbRowFixture());
    const { redis, store } = buildFakeRedis();
    const service = new ProductService(prisma, new CacheService(() => redis));

    const missed = await service.detail(100n);
    expect(typeof missed.product.minPrice).toBe('bigint');
    expect(missed.product.minPrice).toBe(199900n);
    expect(typeof missed.skus[0]?.price).toBe('bigint');
    expect(missed.skus[0]?.price).toBe(199900n);
    // 未命中路径确实回源并回填了缓存
    expect(store.has('shop:cache:product:100:v1')).toBe(true);

    const hit = await service.detail(100n);
    // 命中缓存：不再查库（两次调用只有一次 findFirst）
    expect(product.findFirst).toHaveBeenCalledTimes(1);
    // 缓存里存的是 number，取回后必须转回 bigint —— 漏了这步，下游 MoneyUtil 直接炸
    expect(typeof hit.product.minPrice).toBe('bigint');
    expect(hit.product.minPrice).toBe(199900n);
    expect(typeof hit.skus[0]?.price).toBe('bigint');
    expect(hit.skus[0]?.price).toBe(199900n);
    expect(hit.skus[0]?.originalPrice).toBe(229900n);
    expect(hit.product.id).toBe(100n);
    expect(hit.images[0]?.id).toBe(1n);
  });

  it('泄露检查：返回的 skus 绝不含 costPrice（成本价仅后台可见）', async () => {
    const { prisma, product } = buildFakePrisma();
    product.findFirst.mockImplementation(async () => dbRowFixture());
    const service = new ProductService(prisma, new CacheService(() => null));

    const detail = await service.detail(100n);

    // 正向：确认夹具里确实带了 costPrice，否则下面的断言是白测
    expect(collectKeys(dbRowFixture())).toContain('costPrice');
    // 序列化后的键名（前端真正拿到的东西）
    expect(collectKeys(JSON.parse(JSON.stringify(detail, jsonReplacer)))).not.toContain('costPrice');
    // 原始返回对象同样不允许带 —— 防止有人把整行直接透传
    expect(collectKeys(detail)).not.toContain('costPrice');
    // 查询层也要堵死：select 里不能出现 costPrice
    expect(collectKeys(callArg(product.findFirst.mock.calls, 0).select)).not.toContain('costPrice');
  });

  it('降级：Redis 完全不可用时 detail 仍正常返回（缓存故障不得阻断业务）', async () => {
    const { prisma, product } = buildFakePrisma();
    product.findFirst.mockImplementation(async () => dbRowFixture());
    const service = new ProductService(prisma, new CacheService(() => null));

    const detail = await service.detail(100n);

    expect(detail.product.id).toBe(100n);
    expect(typeof detail.product.minPrice).toBe('bigint');
    expect(detail.skus).toHaveLength(2);
    expect(product.findFirst).toHaveBeenCalledTimes(1);
  });

  it('附加：商品不存在 / 非 ON_SALE / 已软删 → BusinessError 21001 且 HTTP 404', async () => {
    const { prisma, product } = buildFakePrisma();
    product.findFirst.mockImplementation(async () => null);
    const service = new ProductService(prisma, new CacheService(() => null));

    expect(ErrorCode.PRODUCT_NOT_FOUND).toBe(21001);
    await expect(service.detail(404n)).rejects.toBeInstanceOf(BusinessError);

    let caught: unknown;
    try {
      await service.detail(404n);
    } catch (error) {
      caught = error;
    }
    const error = caught as BusinessError;
    expect(error).toBeInstanceOf(BusinessError);
    expect(error.code).toBe(ErrorCode.PRODUCT_NOT_FOUND);
    expect(error.httpStatus).toBe(404);
    // 查询条件里必须自带 ON_SALE + 未软删，把未上架商品返回出去等于泄露
    expect(callArg(product.findFirst.mock.calls, 0).where).toEqual({
      id: 404n,
      status: ProductStatus.ON_SALE,
      deletedAt: null,
    });
  });
});

// ---------------------------------------------------------------------------
// 五、SkuService.getQuote（清单 9 ~ 15）
// ---------------------------------------------------------------------------

describe('SkuService.getQuote', () => {
  it('库存不被缓存污染：缓存里的 available 一律无效，返回实时库值', async () => {
    const { prisma, sku } = buildFakePrisma();
    sku.findUnique.mockImplementation(async (args) =>
      selectsPrice(args) ? priceRow() : liveRow({ stock: { available: 2 } }),
    );
    const { redis, store } = buildFakeRedis();
    // 脏缓存里塞了一个「有货 9999」的假库存
    store.set('shop:cache:sku:price:10', JSON.stringify({ price: 1, originalPrice: null, available: 9999 }));
    const service = new SkuService(prisma, new CacheService(() => redis));

    const quote = await service.getQuote(10n);

    expect(quote.available).toBe(2);
    // 价格确实取自缓存 → 证明缓存被读到了，但库存没被它污染
    expect(quote.price).toBe(1n);
    expect(quote.enabled).toBe(true);
  });

  it('缓存命中时跳过价格查询：只打一次实时查', async () => {
    const { prisma, sku } = buildFakePrisma();
    const selects: string[][] = [];
    sku.findUnique.mockImplementation(async (args) => {
      const keys = Object.keys(args.select ?? {});
      selects.push(keys);
      return selectsPrice(args) ? priceRow() : liveRow();
    });
    const { redis } = buildFakeRedis();
    const service = new SkuService(prisma, new CacheService(() => redis));

    await service.getQuote(10n);
    // 未命中：实时查询 + 价格查询
    expect(sku.findUnique).toHaveBeenCalledTimes(2);
    expect(selects[0]).toEqual(['id', 'status', 'deletedAt', 'stock']);
    expect(selects[1]).toEqual(['price', 'originalPrice']);

    const before = sku.findUnique.mock.calls.length;
    const second = await service.getQuote(10n);
    const after = sku.findUnique.mock.calls.length;

    // 命中缓存：只查实时那一次，价格查询被完全跳过（这正是拆两次查询的意义）
    expect(after - before).toBe(1);
    expect(Object.keys(callArg(sku.findUnique.mock.calls, after - 1).select ?? {})).not.toContain('price');
    expect(second.price).toBe(9900n);
  });

  it('缓存未命中与命中两条路径的 price 都是 bigint', async () => {
    const { prisma, sku } = buildFakePrisma();
    sku.findUnique.mockImplementation(async (args) => (selectsPrice(args) ? priceRow() : liveRow()));
    const { redis } = buildFakeRedis();
    const service = new SkuService(prisma, new CacheService(() => redis));

    const missed = await service.getQuote(10n);
    expect(typeof missed.price).toBe('bigint');
    expect(missed.price).toBe(9900n);
    expect(typeof missed.originalPrice).toBe('bigint');
    expect(missed.originalPrice).toBe(10900n);

    const hit = await service.getQuote(10n);
    expect(typeof hit.price).toBe('bigint');
    expect(hit.price).toBe(9900n);
    expect(typeof hit.originalPrice).toBe('bigint');
  });

  it('两次查询的 select 都不含 costPrice（成本价仅后台可见）', async () => {
    const { prisma, sku } = buildFakePrisma();
    sku.findUnique.mockImplementation(async (args) => (selectsPrice(args) ? priceRow() : liveRow()));
    const service = new SkuService(prisma, new CacheService(() => null));

    await service.getQuote(10n);

    const live = callArg(sku.findUnique.mock.calls, 0);
    const price = callArg(sku.findUnique.mock.calls, 1);

    expect(Object.keys(live.select ?? {})).toEqual(['id', 'status', 'deletedAt', 'stock']);
    expect(Object.keys(price.select ?? {})).toEqual(['price', 'originalPrice']);
    expect(collectKeys(live.select)).not.toContain('costPrice');
    expect(collectKeys(price.select)).not.toContain('costPrice');
  });

  it('SKU 不存在 → BusinessError 21002 且 HTTP 404', async () => {
    const { prisma, sku } = buildFakePrisma();
    sku.findUnique.mockImplementation(async () => null);
    const service = new SkuService(prisma, new CacheService(() => null));

    expect(ErrorCode.SKU_NOT_FOUND).toBe(21002);
    await expect(service.getQuote(99n)).rejects.toBeInstanceOf(BusinessError);

    let caught: unknown;
    try {
      await service.getQuote(99n);
    } catch (error) {
      caught = error;
    }
    const error = caught as BusinessError;
    expect(error).toBeInstanceOf(BusinessError);
    expect(error.code).toBe(ErrorCode.SKU_NOT_FOUND);
    expect(error.httpStatus).toBe(404);
    // 两次调用各只打了一次查询：实时查询就判空返回，不会继续去查价格
    expect(sku.findUnique).toHaveBeenCalledTimes(2);
  });

  it('SKU 为 DISABLED 或已软删 → enabled === false，且不抛错', async () => {
    const { prisma, sku } = buildFakePrisma();
    const service = new SkuService(prisma, new CacheService(() => null));
    const cases: Array<{ name: string; row: FakeSkuLiveRow }> = [
      { name: 'DISABLED', row: liveRow({ status: SkuStatus.DISABLED }) },
      { name: '已软删', row: liveRow({ deletedAt: new Date('2026-09-01T00:00:00.000Z') }) },
    ];

    for (const item of cases) {
      sku.findUnique.mockImplementation(async (args) => (selectsPrice(args) ? priceRow() : item.row));

      const quote = await service.getQuote(10n);

      expect(quote.enabled).toBe(false);
      expect(quote.available).toBe(100);
      expect(quote.price).toBe(9900n);
    }
  });

  it('降级：Redis 完全不可用时 getQuote 仍正常返回（缓存故障不得阻断业务）', async () => {
    const { prisma, sku } = buildFakePrisma();
    sku.findUnique.mockImplementation(async (args) =>
      selectsPrice(args) ? priceRow() : liveRow({ stock: { available: 5 } }),
    );
    const service = new SkuService(prisma, new CacheService(() => null));

    const quote = await service.getQuote(10n);

    expect(quote).toEqual({
      skuId: 10n,
      price: 9900n,
      originalPrice: 10900n,
      available: 5,
      enabled: true,
    });
    expect(typeof quote.price).toBe('bigint');
  });

  it('附加：缓存里的价格是脏数据（非数值）→ 抛 90007，绝不补 0（补 0 等于标价免费）', async () => {
    const { prisma, sku } = buildFakePrisma();
    sku.findUnique.mockImplementation(async (args) => (selectsPrice(args) ? priceRow() : liveRow()));
    const { redis, store } = buildFakeRedis();
    store.set('shop:cache:sku:price:10', JSON.stringify({ price: 'abc', originalPrice: null }));
    const service = new SkuService(prisma, new CacheService(() => redis));

    let caught: unknown;
    try {
      await service.getQuote(10n);
    } catch (error) {
      caught = error;
    }
    const error = caught as BusinessError;
    expect(error).toBeInstanceOf(BusinessError);
    expect(error.code).toBe(ErrorCode.SYSTEM_INTERNAL);
    expect(ErrorCode.SYSTEM_INTERNAL).toBe(90007);
  });

  it('附加：无库存记录时 available 视为 0（与 SQL LEFT JOIN 语义一致）', async () => {
    const { prisma, sku } = buildFakePrisma();
    sku.findUnique.mockImplementation(async (args) => (selectsPrice(args) ? priceRow() : liveRow({ stock: null })));
    const service = new SkuService(prisma, new CacheService(() => null));

    const quote = await service.getQuote(10n);

    expect(quote.available).toBe(0);
    expect(quote.enabled).toBe(true);
  });
});
