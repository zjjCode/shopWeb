/**
 * @file server/prisma/seed/catalog.seed.ts
 * @description Demo 商品目录种子：分类树 → 商品 → 图片 / 规格 → SKU → 库存（T021-C）
 * @module seed
 * @see docs/03-database.md §2（Category / Product / Sku / SkuStock 模型）、§8.2（执行顺序）、§8.3（幂等）
 * @see src/services/ProductService.ts（列表读 minPrice/maxPrice 冗余字段）
 * @author 软件开发团队
 * @created 2026-09-07
 *
 * ## 为什么需要这份数据
 * 项目正在打通「登录 → 商品浏览 → 加购 → 下单 → 支付」最小闭环，前三环代码已完成，
 * 但 `prisma/seed/` 原本只有权限 / 角色 / 管理员 / 平台现金账户 / 支付方式，**没有任何商品数据**，
 * 导致商品浏览与加购无法被真实验证。本模块补齐分类 / 商品 / SKU / 库存。
 *
 * ## 幂等策略：显式指定主键
 * `Category` / `Product` / `Sku` 都只有自增 `id` 作唯一键，若用 `create` 重复执行会不断插入重复行。
 * 因此这里**显式指定 id**（分类 1~22、商品 1001~1008、SKU 2001~2016），用 `upsert({ where: { id } })`。
 * Prisma 允许对 `@default(autoincrement())` 字段显式赋值。
 *
 * ## ⚠️ minPrice / maxPrice 必须算出来，不能手写
 * `products.min_price` / `max_price` 是冗余字段（schema 注释：「冗余最低/最高售价（分），
 * 便于列表页展示，SKU 变动时同步更新」），而前台列表 `ProductService.list` **直接读这两个字段**展示价格。
 * 手写两个数字必然与 SKU 实际价格漂移，表现为「列表页 ¥3999、点进去 ¥4199」这类极难排查的不一致。
 * 这里统一由 {@link resolvePriceRange} 从 SKU 价格计算。
 *
 * ## 数据刻意留的两个验证点
 * - `available: 5` 且 `warningThreshold: 10` 的 SKU → 验证后台「库存预警」高亮
 * - `available: 0` 的 SKU → 验证售罄展示与加购失败路径（`ErrorCode.STOCK_NOT_ENOUGH` 50001）
 */

import type { PrismaClient } from '@prisma/client';
import type { Prisma } from '@prisma/client';

/** demo 分类（显式 id，便于预先确定 path） */
interface DemoCategory {
  id: number;
  parentId: number | null;
  name: string;
  /** 层级：1 / 2 / 3 */
  level: number;
  /** 层级路径，形如 `/1/11/111/`，段数必须与 level 一致 */
  path: string;
  sort: number;
}

/** demo SKU（金额单位：分，用 number 书写，写入时统一 BigInt()） */
interface DemoSku {
  id: number;
  /**
   * 确定性 skuCode。
   *
   * 不用 `src/core/idGenerator.ts:254` 的 `skuCode()`：它带时间戳 / 序列号成分，
   * 重复执行会产出不同值，从而插入新 SKU、破坏幂等。
   */
  code: string;
  /** 规格组合，键为规格名 */
  specValues: Record<string, string>;
  price: number;
  originalPrice: number;
  /** 成本价（仅后台可见，前台 select 已排除）；必须低于 price */
  costPrice: number;
  /** 初始可用库存 */
  available: number;
  /** 库存预警阈值，缺省 10 */
  warningThreshold?: number;
  /** 重量（克），为 P1 按重量计费运费预留 */
  weight: number;
  imageUrl?: string;
}

/** demo 商品 */
interface DemoProduct {
  id: number;
  categoryId: number;
  name: string;
  subTitle: string;
  mainImage: string;
  /** 图文详情（HTML）。真实业务必须过 sanitize-html 白名单，此处为受控常量故直接书写 */
  detail: string;
  sort: number;
  totalSales: number;
  /** 图集（按顺序），url 列表 */
  images: string[];
  /** 规格定义（顺序即 sort） */
  specs: { name: string; values: string[] }[];
  skus: DemoSku[];
}

// ---------------------------------------------------------------------------
// 分类：2 个一级 → 二级 → 三级（必须覆盖到三级，否则验证不了分类树的层级组装）
// ---------------------------------------------------------------------------

const CATEGORIES: DemoCategory[] = [
  { id: 1, parentId: null, name: '手机数码', level: 1, path: '/1/', sort: 10 },
  { id: 11, parentId: 1, name: '智能手机', level: 2, path: '/1/11/', sort: 10 },
  { id: 111, parentId: 11, name: '国产旗舰', level: 3, path: '/1/11/111/', sort: 10 },
  { id: 112, parentId: 11, name: '影音游戏', level: 3, path: '/1/11/112/', sort: 20 },
  { id: 12, parentId: 1, name: '平板电脑', level: 2, path: '/1/12/', sort: 20 },
  { id: 2, parentId: null, name: '电脑办公', level: 1, path: '/2/', sort: 20 },
  { id: 21, parentId: 2, name: '笔记本电脑', level: 2, path: '/2/21/', sort: 10 },
  { id: 22, parentId: 2, name: '外设配件', level: 2, path: '/2/22/', sort: 20 },
];

// ---------------------------------------------------------------------------
// 商品（金额单位：分）
// ---------------------------------------------------------------------------

/** 生成图集 URL（demo 用占位域名，不请求真实资源） */
function images(base: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `https://cdn.example.com/demo/${base}-${i + 1}.jpg`);
}

const PRODUCTS: DemoProduct[] = [
  {
    id: 1001,
    categoryId: 111,
    name: '星曜 X9 Pro 5G 手机',
    subTitle: '2K 直屏 · 5000mAh · 120W 快充',
    mainImage: 'https://cdn.example.com/demo/x9pro-main.jpg',
    detail: '<p>星曜 X9 Pro，旗舰影像与性能的均衡之选。</p><ul><li>6.78 英寸 2K 直屏</li><li>5000mAh 电池 + 120W 有线快充</li><li>5000 万像素主摄（OIS）</li></ul>',
    sort: 100,
    totalSales: 1286,
    images: images('x9pro', 3),
    specs: [{ name: '颜色', values: ['陨石黑', '冰川银', '曙光金'] }],
    skus: [
      { id: 2001, code: 'DEMO-P1001-01', specValues: { 颜色: '陨石黑' }, price: 399900, originalPrice: 429900, costPrice: 268000, available: 500, weight: 210 },
      { id: 2002, code: 'DEMO-P1001-02', specValues: { 颜色: '冰川银' }, price: 399900, originalPrice: 429900, costPrice: 268000, available: 300, weight: 210 },
      { id: 2003, code: 'DEMO-P1001-03', specValues: { 颜色: '曙光金' }, price: 419900, originalPrice: 449900, costPrice: 282000, available: 120, weight: 212 },
    ],
  },
  {
    id: 1002,
    categoryId: 111,
    name: '星曜 X9 5G 手机',
    subTitle: '轻旗舰 · 手感出众',
    mainImage: 'https://cdn.example.com/demo/x9-main.jpg',
    detail: '<p>星曜 X9，更轻更薄的旗舰体验。</p><ul><li>6.36 英寸小直屏</li><li>4500mAh 电池 + 90W 快充</li></ul>',
    sort: 90,
    totalSales: 2043,
    images: images('x9', 2),
    specs: [{ name: '颜色', values: ['陨石黑', '冰川银'] }],
    skus: [
      { id: 2004, code: 'DEMO-P1002-01', specValues: { 颜色: '陨石黑' }, price: 299900, originalPrice: 329900, costPrice: 198000, available: 200, weight: 185 },
      { id: 2005, code: 'DEMO-P1002-02', specValues: { 颜色: '冰川银' }, price: 309900, originalPrice: 329900, costPrice: 205000, available: 150, weight: 185 },
    ],
  },
  {
    id: 1003,
    categoryId: 112,
    name: '星曜 Note 大屏影音手机',
    subTitle: '7 英寸巨屏 · 对称双扬',
    mainImage: 'https://cdn.example.com/demo/note-main.jpg',
    detail: '<p>星曜 Note，为影音与游戏而生。</p><ul><li>7.0 英寸大屏</li><li>对称式立体双扬声器</li></ul>',
    sort: 80,
    totalSales: 671,
    images: images('note', 2),
    specs: [{ name: '颜色', values: ['曜石黑', '晨曦白'] }],
    skus: [
      { id: 2006, code: 'DEMO-P1003-01', specValues: { 颜色: '曜石黑' }, price: 359900, originalPrice: 389900, costPrice: 241000, available: 80, weight: 228 },
      // 刻意低于预警阈值（10）：验证后台「库存预警」高亮
      { id: 2007, code: 'DEMO-P1003-02', specValues: { 颜色: '晨曦白' }, price: 369900, originalPrice: 389900, costPrice: 248000, available: 5, warningThreshold: 10, weight: 228 },
    ],
  },
  {
    id: 1004,
    categoryId: 12,
    name: '星曜 Pad 11 平板电脑',
    subTitle: '11 英寸 · 144Hz · 四扬声器',
    mainImage: 'https://cdn.example.com/demo/pad11-main.jpg',
    detail: '<p>星曜 Pad 11，办公与娱乐兼顾。</p><ul><li>11 英寸 144Hz 屏幕</li><li>四扬声器 + 杜比全景声</li></ul>',
    sort: 70,
    totalSales: 438,
    images: images('pad11', 2),
    specs: [{ name: '版本', values: ['WiFi 版', '5G 版'] }],
    skus: [
      { id: 2008, code: 'DEMO-P1004-01', specValues: { 版本: 'WiFi 版' }, price: 259900, originalPrice: 279900, costPrice: 172000, available: 260, weight: 480 },
      // 刻意售罄：验证售罄展示与加购失败路径（50001 库存不足）
      { id: 2009, code: 'DEMO-P1004-02', specValues: { 版本: '5G 版' }, price: 319900, originalPrice: 349900, costPrice: 213000, available: 0, weight: 492 },
    ],
  },
  {
    id: 1005,
    categoryId: 21,
    name: '星曜 Book Air 14 轻薄本',
    subTitle: '1.19kg · 超长续航',
    mainImage: 'https://cdn.example.com/demo/bookair14-main.jpg',
    detail: '<p>星曜 Book Air 14，随身生产力。</p><ul><li>重量 1.19kg</li><li>60Wh 电池，本地视频播放 16 小时</li></ul>',
    sort: 60,
    totalSales: 312,
    images: images('bookair14', 3),
    specs: [{ name: '配置', values: ['16G+512G', '16G+1TB'] }],
    skus: [
      { id: 2010, code: 'DEMO-P1005-01', specValues: { 配置: '16G+512G' }, price: 629900, originalPrice: 679900, costPrice: 431000, available: 90, weight: 1190 },
      { id: 2011, code: 'DEMO-P1005-02', specValues: { 配置: '16G+1TB' }, price: 699900, originalPrice: 749900, costPrice: 478000, available: 45, weight: 1190 },
    ],
  },
  {
    id: 1006,
    categoryId: 21,
    name: '星曜 Book Pro 16 创作本',
    subTitle: '3.2K 触屏 · 独显',
    mainImage: 'https://cdn.example.com/demo/bookpro16-main.jpg',
    detail: '<p>星曜 Book Pro 16，为专业创作打造。</p><ul><li>16 英寸 3.2K 触控屏</li><li>独立显卡 + 32G 内存</li></ul>',
    sort: 50,
    totalSales: 126,
    images: images('bookpro16', 2),
    specs: [{ name: '配置', values: ['32G+1TB'] }],
    skus: [
      { id: 2012, code: 'DEMO-P1006-01', specValues: { 配置: '32G+1TB' }, price: 999900, originalPrice: 1099900, costPrice: 682000, available: 30, weight: 1980 },
    ],
  },
  {
    id: 1007,
    categoryId: 22,
    name: '星曜 静音无线鼠标',
    subTitle: '静音微动 · 双模连接',
    mainImage: 'https://cdn.example.com/demo/mouse-main.jpg',
    detail: '<p>星曜 静音无线鼠标，办公静音之选。</p><ul><li>静音微动开关</li><li>蓝牙 + 2.4G 双模</li></ul>',
    sort: 40,
    totalSales: 5127,
    images: images('mouse', 2),
    specs: [{ name: '颜色', values: ['深空灰', '珍珠白'] }],
    skus: [
      { id: 2013, code: 'DEMO-P1007-01', specValues: { 颜色: '深空灰' }, price: 12900, originalPrice: 15900, costPrice: 5200, available: 800, weight: 96 },
      { id: 2014, code: 'DEMO-P1007-02', specValues: { 颜色: '珍珠白' }, price: 13900, originalPrice: 15900, costPrice: 5600, available: 620, weight: 96 },
    ],
  },
  {
    id: 1008,
    categoryId: 22,
    name: '星曜 87 键机械键盘',
    subTitle: 'Gasket 结构 · 三模热插拔',
    mainImage: 'https://cdn.example.com/demo/kb87-main.jpg',
    detail: '<p>星曜 87 键机械键盘，手感与声音的平衡。</p><ul><li>Gasket 结构，软弹手感</li><li>有线 / 蓝牙 / 2.4G 三模</li><li>全键热插拔</li></ul>',
    sort: 30,
    totalSales: 1893,
    images: images('kb87', 3),
    specs: [{ name: '轴体', values: ['红轴', '茶轴'] }],
    skus: [
      { id: 2015, code: 'DEMO-P1008-01', specValues: { 轴体: '红轴' }, price: 49900, originalPrice: 59900, costPrice: 21600, available: 240, weight: 890 },
      { id: 2016, code: 'DEMO-P1008-02', specValues: { 轴体: '茶轴' }, price: 52900, originalPrice: 59900, costPrice: 22900, available: 180, weight: 890 },
    ],
  },
];

// ---------------------------------------------------------------------------
// 派生计算
// ---------------------------------------------------------------------------

/**
 * 由 SKU 价格算出商品的 `minPrice` / `maxPrice`。
 *
 * @description 见文件头说明：这两个是冗余字段，必须由 SKU 价格推导，手写必然漂移。
 * @param skus 该商品下的 SKU
 * @returns 最低价与最高价（分）
 */
export function resolvePriceRange(skus: DemoSku[]): { minPrice: bigint; maxPrice: bigint } {
  const prices = skus.map((s) => s.price);
  return { minPrice: BigInt(Math.min(...prices)), maxPrice: BigInt(Math.max(...prices)) };
}

/**
 * 生成 `specDigest`：规格值按规格名排序后以 `名:值` 拼接，用 `|` 分隔。
 *
 * @description 与 schema 注释一致：「规格值按规格名排序后拼接（如 "颜色:陨石黑|版本:8G+128G"）」。
 * 排序用默认 UTF-16 比较，结果确定；同一商品下必须唯一（`uk_product_spec`）。
 * @param specValues 规格组合
 * @returns specDigest
 */
export function resolveSpecDigest(specValues: Record<string, string>): string {
  return Object.keys(specValues)
    .sort()
    .map((key) => `${key}:${specValues[key] ?? ''}`)
    .join('|');
}

// ---------------------------------------------------------------------------
// 写入
// ---------------------------------------------------------------------------

/** 各表写入条数 */
export interface CatalogSeedCounts {
  categories: number;
  products: number;
  productImages: number;
  productSpecs: number;
  skus: number;
  skuStocks: number;
}

/**
 * 写入 demo 商品目录：分类树 → 商品 → 图片 / 规格 → SKU → 库存。
 *
 * @description 顺序由外键依赖决定：商品依赖分类，SKU 依赖商品，库存依赖 SKU。
 * 图片与规格用「先 deleteMany 再 createMany」而不是 upsert —— 这两张表只有自增 id，
 * 显式 id 会让 id 段与业务主键错位，重建反而更干净且仍然幂等。
 * @param prisma PrismaClient 实例
 * @returns 各表写入条数
 */
export async function seedCatalog(prisma: PrismaClient): Promise<CatalogSeedCounts> {
  // 1. 分类树
  for (const c of CATEGORIES) {
    await prisma.category.upsert({
      where: { id: BigInt(c.id) },
      create: {
        id: BigInt(c.id),
        parentId: c.parentId === null ? null : BigInt(c.parentId),
        name: c.name,
        level: c.level,
        path: c.path,
        sort: c.sort,
        status: 'ENABLED',
      },
      update: { name: c.name, level: c.level, path: c.path, sort: c.sort, status: 'ENABLED' },
    });
  }

  // 2. 商品 + 图集 + 规格 + SKU + 库存
  for (const p of PRODUCTS) {
    const { minPrice, maxPrice } = resolvePriceRange(p.skus);

    await prisma.product.upsert({
      where: { id: BigInt(p.id) },
      create: {
        id: BigInt(p.id),
        categoryId: BigInt(p.categoryId),
        name: p.name,
        subTitle: p.subTitle,
        mainImage: p.mainImage,
        detail: p.detail,
        status: 'ON_SALE',
        minPrice,
        maxPrice,
        totalSales: p.totalSales,
        sort: p.sort,
      },
      update: {
        name: p.name,
        subTitle: p.subTitle,
        mainImage: p.mainImage,
        detail: p.detail,
        status: 'ON_SALE',
        minPrice,
        maxPrice,
        totalSales: p.totalSales,
        sort: p.sort,
      },
    });

    // 图集：重建（幂等，且避免显式 id 与自增段冲突）
    await prisma.productImage.deleteMany({ where: { productId: BigInt(p.id) } });
    await prisma.productImage.createMany({
      data: p.images.map((url, idx) => ({ productId: BigInt(p.id), url, sort: (idx + 1) * 10 })),
    });

    // 规格：重建
    await prisma.productSpec.deleteMany({ where: { productId: BigInt(p.id) } });
    await prisma.productSpec.createMany({
      data: p.specs.map((spec, idx) => ({
        productId: BigInt(p.id),
        name: spec.name,
        values: spec.values as unknown as Prisma.InputJsonValue,
        sort: (idx + 1) * 10,
      })),
    });

    // SKU + 库存
    for (const s of p.skus) {
      await prisma.sku.upsert({
        where: { id: BigInt(s.id) },
        create: {
          id: BigInt(s.id),
          productId: BigInt(p.id),
          skuCode: s.code,
          specValues: s.specValues as unknown as Prisma.InputJsonValue,
          specDigest: resolveSpecDigest(s.specValues),
          price: BigInt(s.price),
          originalPrice: BigInt(s.originalPrice),
          costPrice: BigInt(s.costPrice),
          weight: s.weight,
          imageUrl: s.imageUrl ?? null,
          status: 'ENABLED',
          sales: 0,
        },
        update: {
          skuCode: s.code,
          specValues: s.specValues as unknown as Prisma.InputJsonValue,
          specDigest: resolveSpecDigest(s.specValues),
          price: BigInt(s.price),
          originalPrice: BigInt(s.originalPrice),
          costPrice: BigInt(s.costPrice),
          weight: s.weight,
          status: 'ENABLED',
        },
      });

      // 库存：恒等式 total = available + frozen + sold（初始 frozen=0、sold=0）
      await prisma.skuStock.upsert({
        where: { skuId: BigInt(s.id) },
        create: {
          skuId: BigInt(s.id),
          total: s.available,
          available: s.available,
          frozen: 0,
          sold: 0,
          warningThreshold: s.warningThreshold ?? 10,
        },
        update: {
          total: s.available,
          available: s.available,
          frozen: 0,
          sold: 0,
          warningThreshold: s.warningThreshold ?? 10,
        },
      });
    }
  }

  const [categories, products, productImages, productSpecs, skus, skuStocks] = await Promise.all([
    prisma.category.count({ where: { id: { in: CATEGORIES.map((c) => BigInt(c.id)) } } }),
    prisma.product.count({ where: { id: { in: PRODUCTS.map((p) => BigInt(p.id)) } } }),
    prisma.productImage.count({ where: { productId: { in: PRODUCTS.map((p) => BigInt(p.id)) } } }),
    prisma.productSpec.count({ where: { productId: { in: PRODUCTS.map((p) => BigInt(p.id)) } } }),
    prisma.sku.count({ where: { productId: { in: PRODUCTS.map((p) => BigInt(p.id)) } } }),
    prisma.skuStock.count({
      where: { skuId: { in: PRODUCTS.flatMap((p) => p.skus.map((s) => BigInt(s.id))) } },
    }),
  ]);

  console.warn(
    `[seed:catalog] 分类 ${categories} / 商品 ${products} / 图片 ${productImages} / 规格 ${productSpecs} / SKU ${skus} / 库存 ${skuStocks}`,
  );

  return { categories, products, productImages, productSpecs, skus, skuStocks };
}

/** 导出供自检脚本做数据自洽性校验（不参与写入） */
export const CATALOG_SEED_DATA = { CATEGORIES, PRODUCTS };
