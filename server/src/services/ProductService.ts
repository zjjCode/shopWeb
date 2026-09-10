/**
 * @file server/src/services/ProductService.ts
 * @description 商品服务：前台商品列表（分页 + 分类子树筛选 + 白名单排序）与商品详情（Redis 缓存 5 分钟）
 * @module services
 * @see docs/02-architecture.md §5.5（分层）、§5.9（Key 命名与 TTL）、:61（Redis 不是权威源）
 * @see docs/03-database.md（Product / ProductImage / ProductSpec / Sku 模型）
 * @see docs/04-flows.md:243（商品列表 GET /api/products）、:252（商品详情 GET /api/products/:id）
 * @author 软件开发团队
 * @created 2026-09-06
 *
 * 分层铁律：本服务**不接触** Express 的 req/res，只做查询与组装，响应由 Controller 包装。
 *
 * 一、列表页两个必须踩准的点：
 * 1. **分类筛选必须覆盖整棵子树**。`Category.path` 形如 `/1/12/123/`（schema 注释原文：「前缀匹配可查
 *    整棵子树」），因此先取父级 path 再 `startsWith` 前缀匹配出全部子孙。只查 `parentId = categoryId`
 *    的**一层**是最典型的 bug：用户点一级分类会看不到任何三级分类下的商品（电商里绝大多数商品挂在
 *    三级分类上），表现为「分类页一片空白」。
 * 2. **价格取 `products` 表冗余的 `minPrice` / `maxPrice`，不聚合 SKU**。
 *    ⚠️ 与设计文档的差异：`docs/04-flows.md:249` 的时序图画的是「批量补 SKU 最低价（按
 *    product_id IN (...) 聚合）」，这与冗余字段的存在互相矛盾——若每次都聚合，冗余字段就失去意义。
 *    **裁定：用冗余字段**。理由是 `Product.minPrice` 的 schema 注释已明确「冗余最低/最高售价（分），
 *    便于列表页展示，SKU 变动时同步更新」，列表页多一次 GROUP BY 只会把分页查询拖成慢查询。
 *    代价是冗余字段与 SKU 可能短暂不一致，由 SKU 变更侧的同步逻辑负责（不属本批范围）。
 *
 * 二、金额一律 `bigint`（分），禁止裸算术；SKU 的 `costPrice`（成本价，仅后台可见）
 * 绝不出现在任何 select 中。
 */

import type { Prisma, PrismaClient } from '@prisma/client';
import { CategoryStatus, ProductStatus, SkuStatus } from '@prisma/client';
import { CACHE_TTL_SECONDS, REDIS_KEY } from '@/config/constants';
import { BusinessError } from '@/core/errors';
import { ErrorCode } from '@/core/errors/errorCodes';
import { getPrisma } from '@/core/prisma';
import type { PageParams } from '@/types/common';
import { normalizeSort, type SortOrder } from '@/utils/paging';
import type { ProductListQuery } from '@/validators/product.validator';
import { PRODUCT_SORT_FIELDS } from '@/validators/product.validator';
import { cacheService, type CacheService } from './CacheService';

/** 简化的 Prisma 客户端形态（本服务只用到 product / category 两个委托） */
type DbClient = Pick<PrismaClient, 'product' | 'category'>;

/** 列表项：显式挑选的字段，不含任何 SKU 或成本信息 */
export interface ProductListItem {
  id: bigint;
  categoryId: bigint;
  name: string;
  subTitle: string | null;
  mainImage: string;
  /** 最低售价（分） */
  minPrice: bigint;
  /** 最高售价（分） */
  maxPrice: bigint;
  totalSales: number;
}

/** 详情中的图集项 */
export interface ProductImageItem {
  id: bigint;
  url: string;
  sort: number;
}

/** 详情中的规格定义项（如「颜色」= ["陨石黑","冰川银"]） */
export interface ProductSpecItem {
  id: bigint;
  name: string;
  /** 规格值数组（JSON） */
  values: Prisma.JsonValue;
  sort: number;
}

/**
 * 详情中的 SKU 项。
 *
 * ⚠️ 字段是**显式白名单**，绝不含 `costPrice`（成本价，仅后台可见）。
 * 也**不含 `stock`**：docs/04-flows.md:260 明确「详情缓存不含库存，库存走独立实时接口」，
 * 把库存写进 5 分钟缓存会直接导致超卖。
 */
export interface ProductSkuItem {
  id: bigint;
  /** 规格组合 JSON：{"颜色":"陨石黑","版本":"8G+128G"} */
  specValues: Prisma.JsonValue;
  /** 售价（分） */
  price: bigint;
  /** 划线原价（分），可空 */
  originalPrice: bigint | null;
  imageUrl: string | null;
}

/** 详情中的商品主信息 */
export interface ProductDetailProduct {
  id: bigint;
  categoryId: bigint;
  name: string;
  subTitle: string | null;
  mainImage: string;
  /** 图文详情 HTML（展示前须确认入库已过 sanitize-html 白名单） */
  detail: string | null;
  minPrice: bigint;
  maxPrice: bigint;
  totalSales: number;
}

/** 商品详情聚合结果 */
export interface ProductDetail {
  product: ProductDetailProduct;
  images: ProductImageItem[];
  specs: ProductSpecItem[];
  skus: ProductSkuItem[];
}

/**
 * 详情的「JSON 安全」缓存快照。
 *
 * ⚠️ 存在的理由（本项目最大的坑）：金额与 ID 都是 Prisma `BigInt`，返回 JS `bigint`，
 * 而 `JSON.stringify` 遇到 bigint 直接抛 `TypeError: Do not know how to serialize a BigInt`。
 * `CacheService` 用 `safeStringify` 落缓存（bigint → number），`parseJson` 读回，
 * 于是「缓存命中」路径拿到的 `price` 是 `number`，而「查库」路径是 `bigint`——
 * 两条路径类型不一致会让下游 `MoneyUtil` 直接炸（bigint 与 number 不能混算）。
 *
 * 对策：缓存只存本快照（bigint 全部降级：ID → string，金额 → number），
 * 对外一律经 {@link fromSnapshot} 还原成 `ProductDetail`，保证调用方看到的永远是 bigint。
 */
export interface ProductDetailSnapshot {
  product: {
    id: string;
    categoryId: string;
    name: string;
    subTitle: string | null;
    mainImage: string;
    detail: string | null;
    minPrice: number;
    maxPrice: number;
    totalSales: number;
  };
  images: Array<{ id: string; url: string; sort: number }>;
  specs: Array<{ id: string; name: string; values: Prisma.JsonValue; sort: number }>;
  skus: Array<{
    id: string;
    specValues: Prisma.JsonValue;
    price: number;
    originalPrice: number | null;
    imageUrl: string | null;
  }>;
}

/** 列表查询的字段白名单（与 {@link ProductListItem} 一一对应，禁止包含 SKU / 成本字段） */
const LIST_SELECT = {
  id: true,
  categoryId: true,
  name: true,
  subTitle: true,
  mainImage: true,
  minPrice: true,
  maxPrice: true,
  totalSales: true,
} as const;

/** 「商品不存在或已下架」提示文案，与 errorCodes.ts:212 的映射表保持一致 */
const PRODUCT_NOT_FOUND_MESSAGE = '商品不存在或已下架';

/**
 * 构造列表排序条件（纯函数，便于单测）。
 *
 * @description 入参 `field` 是**前端传入的**排序名（已在 `PRODUCT_SORT_FIELDS` 白名单内），
 * 必须映射到真实 Prisma 字段：`price` → `minPrice`（冗余最低价）、`sales` → `totalSales`。
 * 若把 `price` 直接当字段名拼进 `orderBy`，Prisma 会抛「未知列」，等于把内部表结构当成对外契约。
 *
 * **为什么必须追加 `id` 降序做次级排序**：主排序字段（尤其 `sort`）存在大量重复值，
 * MySQL 对相同键值的返回顺序不保证稳定，`LIMIT ... OFFSET` 翻页时同一条记录可能出现在第 1 页
 * 又出现在第 2 页（重复），也可能两页都不出现（漏掉）。追加唯一的 `id` 后排序变成全序，
 * 分页结果才是确定的。
 *
 * @param field 白名单校验后的排序名（createdAt / price / sales / sort）
 * @param order 排序方向
 * @returns Prisma orderBy 数组
 */
export function buildOrderBy(field: string, order: SortOrder): Prisma.ProductOrderByWithRelationInput[] {
  switch (field) {
    case 'createdAt':
      return [{ createdAt: order }, { id: 'desc' }];
    case 'price':
      return [{ minPrice: order }, { id: 'desc' }];
    case 'sales':
      return [{ totalSales: order }, { id: 'desc' }];
    default:
      // 默认走运营排序 `sort`：后台设置的推荐位优先展示
      return [{ sort: order }, { id: 'desc' }];
  }
}

/**
 * 把详情压成 JSON 安全快照（写缓存前调用）。
 *
 * @param detail 查库得到的详情
 * @returns 可安全 `JSON.stringify` 的快照
 */
export function toSnapshot(detail: ProductDetail): ProductDetailSnapshot {
  return {
    product: {
      id: String(detail.product.id),
      categoryId: String(detail.product.categoryId),
      name: detail.product.name,
      subTitle: detail.product.subTitle,
      mainImage: detail.product.mainImage,
      detail: detail.product.detail,
      minPrice: Number(detail.product.minPrice),
      maxPrice: Number(detail.product.maxPrice),
      totalSales: detail.product.totalSales,
    },
    images: detail.images.map((item) => ({ id: String(item.id), url: item.url, sort: item.sort })),
    specs: detail.specs.map((item) => ({
      id: String(item.id),
      name: item.name,
      values: item.values,
      sort: item.sort,
    })),
    skus: detail.skus.map((item) => ({
      id: String(item.id),
      specValues: item.specValues,
      price: Number(item.price),
      originalPrice: item.originalPrice === null ? null : Number(item.originalPrice),
      imageUrl: item.imageUrl,
    })),
  };
}

/**
 * 把缓存快照还原成详情（读缓存后调用）。
 *
 * @description 金额回转成 bigint 时用 `Math.round` 兜底：理论上缓存里是整数分，
 * 但一旦有人塞进浮点，`BigInt(1.5)` 会直接抛 `RangeError`，宁可先取整也不要让读接口 500
 * @param snapshot 缓存快照
 * @returns 详情（金额与 ID 均为 bigint）
 */
export function fromSnapshot(snapshot: ProductDetailSnapshot): ProductDetail {
  return {
    product: {
      id: BigInt(snapshot.product.id),
      categoryId: BigInt(snapshot.product.categoryId),
      name: snapshot.product.name,
      subTitle: snapshot.product.subTitle,
      mainImage: snapshot.product.mainImage,
      detail: snapshot.product.detail,
      minPrice: BigInt(Math.round(snapshot.product.minPrice)),
      maxPrice: BigInt(Math.round(snapshot.product.maxPrice)),
      totalSales: snapshot.product.totalSales,
    },
    images: snapshot.images.map((item) => ({ id: BigInt(item.id), url: item.url, sort: item.sort })),
    specs: snapshot.specs.map((item) => ({
      id: BigInt(item.id),
      name: item.name,
      values: item.values,
      sort: item.sort,
    })),
    skus: snapshot.skus.map((item) => ({
      id: BigInt(item.id),
      specValues: item.specValues,
      price: BigInt(Math.round(item.price)),
      originalPrice: item.originalPrice === null ? null : BigInt(Math.round(item.originalPrice)),
      imageUrl: item.imageUrl,
    })),
  };
}

/**
 * 商品服务。
 */
export class ProductService {
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
   * 商品列表（分页 + 筛选 + 排序）。
   *
   * @description `count` 与 `findMany` 用 `Promise.all` 并发，且**共用同一个 where**
   * （由 {@link resolveListWhere} 构造）——两处条件一旦写两遍就会漂移，
   * 表现为「总数 100 但翻到第 3 页没数据」这类经典的分页对不上问题
   * @param query 校验后的筛选条件（categoryId / keyword / sortField / sortOrder）
   * @param paging 分页参数（由 pagination 中间件归一化）
   * @returns 当前页列表与总条数
   */
  async list(query: ProductListQuery, paging: PageParams): Promise<{ list: ProductListItem[]; total: number }> {
    const where = await this.resolveListWhere(query);
    if (where === null) {
      // 分类不存在 / 已禁用 / 已删除：没有任何商品可命中，直接短路，省掉 count + findMany
      return { list: [], total: 0 };
    }

    const sort = normalizeSort(query.sortField, query.sortOrder, PRODUCT_SORT_FIELDS, 'sort', 'desc');
    const [total, list] = await Promise.all([
      this.prisma.product.count({ where }),
      this.prisma.product.findMany({
        where,
        orderBy: buildOrderBy(sort.field, sort.order),
        skip: paging.skip,
        take: paging.take,
        select: LIST_SELECT,
      }),
    ]);

    return { list, total };
  }

  /**
   * 商品详情（缓存 5 分钟）。
   *
   * @description Key 形如 `shop:cache:product:{id}:v1`（docs/04-flows.md 的 F3.2 表格）。
   * Redis 不可用时 {@link CacheService.getOrSet} 照常回源查库，**缓存故障不阻断业务**
   * （docs/02-architecture.md:61：MySQL 才是权威源）
   * @param id 商品 ID
   * @returns 商品主信息 + 图集 + 规格 + 在售 SKU 列表（不含库存、不含成本价）
   * @throws BusinessError 21001 商品不存在或已下架（HTTP 404）
   */
  async detail(id: bigint): Promise<ProductDetail> {
    const cacheKey = this.cache.buildKey(REDIS_KEY.CACHE_PRODUCT, `${id}:v1`);
    const snapshot = await this.cache.getOrSet<ProductDetailSnapshot>(
      cacheKey,
      CACHE_TTL_SECONDS.PRODUCT,
      async () => toSnapshot(await this.queryDetail(id)),
    );
    // 无论命中缓存还是回源，统一经 fromSnapshot 还原，保证对外类型一致（金额恒为 bigint）
    return fromSnapshot(snapshot);
  }

  /**
   * 查库取详情（不读缓存，供回源与后台场景使用）。
   *
   * @description 一次 `findFirst` 带出 images / specs / skus 三个嵌套查询，避免 N+1。
   * 商品必须是在售（`ON_SALE`）且未软删，否则对外就等同于「不存在」——
   * 把 DRAFT / OFF_SALE 的商品返回出去等于泄露未上架商品
   * @param id 商品 ID
   * @returns 商品详情
   * @throws BusinessError 21001 商品不存在或已下架（HTTP 404）
   */
  async queryDetail(id: bigint): Promise<ProductDetail> {
    const product = await this.prisma.product.findFirst({
      where: { id, status: ProductStatus.ON_SALE, deletedAt: null },
      select: {
        id: true,
        categoryId: true,
        name: true,
        subTitle: true,
        mainImage: true,
        detail: true,
        minPrice: true,
        maxPrice: true,
        totalSales: true,
        images: {
          orderBy: [{ sort: 'asc' }, { id: 'asc' }],
          select: { id: true, url: true, sort: true },
        },
        specs: {
          orderBy: [{ sort: 'asc' }, { id: 'asc' }],
          select: { id: true, name: true, values: true, sort: true },
        },
        skus: {
          // 停售 / 已删的 SKU 不能出现在详情里，否则用户能加购一个买不了的规格
          where: { status: SkuStatus.ENABLED, deletedAt: null },
          // 次级 id 排序保证同价 SKU 顺序稳定，避免缓存前后顺序跳动
          orderBy: [{ price: 'asc' }, { id: 'asc' }],
          // ⚠️ 显式白名单：绝不能图省事写 `include: { skus: true }`，那会把 `costPrice` 一起吐给前台
          select: {
            id: true,
            specValues: true,
            price: true,
            originalPrice: true,
            imageUrl: true,
          },
        },
      },
    });

    if (product === null) {
      throw new BusinessError(PRODUCT_NOT_FOUND_MESSAGE, {
        code: ErrorCode.PRODUCT_NOT_FOUND,
        // BusinessError 默认 409，但 21001 在 errorCodes.ts:212 的映射里是 404；
        // 「资源不存在」必须是 404，否则网关重试与前端跳转逻辑都会误判
        httpStatus: 404,
      });
    }

    return {
      product: {
        id: product.id,
        categoryId: product.categoryId,
        name: product.name,
        subTitle: product.subTitle,
        mainImage: product.mainImage,
        detail: product.detail,
        minPrice: product.minPrice,
        maxPrice: product.maxPrice,
        totalSales: product.totalSales,
      },
      images: product.images,
      specs: product.specs,
      skus: product.skus,
    };
  }

  /**
   * 构造列表筛选条件。
   *
   * @description 前台只看 `ON_SALE` 且未软删的商品（DRAFT / PENDING_AUDIT / OFF_SALE 一律不可见）。
   * `keyword` 命中 `name` 的模糊匹配（`@@index([deletedAt, name])` 说明设计上支持按名称检索）。
   *
   * 分类筛选走 `Category.path` 前缀匹配取**整棵子树**（原因见文件头注释第 1 点）；
   * 子树内只保留 `ENABLED` 且未软删的分类——父级禁用时其下商品不应继续从列表页漏出来。
   *
   * @param query 校验后的筛选条件
   * @returns Prisma where 条件；`null` 表示分类不存在/不可用，调用方应直接返回空列表
   */
  private async resolveListWhere(query: ProductListQuery): Promise<Prisma.ProductWhereInput | null> {
    const where: Prisma.ProductWhereInput = { status: ProductStatus.ON_SALE, deletedAt: null };

    if (query.keyword !== undefined && query.keyword.length > 0) {
      where.name = { contains: query.keyword };
    }

    if (query.categoryId !== undefined) {
      const parent = await this.prisma.category.findFirst({
        where: { id: query.categoryId, status: CategoryStatus.ENABLED, deletedAt: null },
        select: { path: true },
      });
      if (parent === null) {
        // 失效分类返回空列表而不是「忽略分类条件」：后者会让点了个失效分类的用户看到全站商品
        return null;
      }
      // path 形如 `/1/12/123/`，`startsWith` 天然包含分类自身（`/1/` 以 `/1/` 开头）
      const subtree = await this.prisma.category.findMany({
        where: { path: { startsWith: parent.path }, status: CategoryStatus.ENABLED, deletedAt: null },
        select: { id: true },
      });
      where.categoryId = { in: subtree.map((item) => item.id) };
    }

    return where;
  }
}

/** 默认单例 */
export const productService = new ProductService();

export default productService;
