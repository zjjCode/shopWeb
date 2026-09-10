/**
 * @file server/src/validators/product.validator.ts
 * @description 商品 / SKU 前台查询入参的 zod schema（商品列表 query、商品 id params、SKU id params）
 * @module validators
 * @see docs/04-flows.md:243（商品列表 `?page=1&pageSize=20&categoryId=&sort=`）、:262（SKU 报价）
 * @see docs/02-architecture.md §7.3（参数校验：未知字段 400）
 * @see src/middlewares/validate.ts（校验通过后把转换结果回写 req）
 * @author 软件开发团队
 * @created 2026-09-06
 *
 * 三条约定：
 * 1. **query 里的空串一律视为「未传」**（`?categoryId=&keyword=`）。前端按文档原样拼串时会带出空值，
 *    若直接喂给 `z.coerce.bigint()` 会得到 `BigInt('') === 0n` —— 一个能查到错误分类的合法值，
 *    属于最难排查的那类缺陷；同理 `?page=` 会 coerce 成 0 再被 min(1) 打回 400，体验也很差。
 * 2. **输出即转换后类型**：中间件会把 `parsed.data` 回写 `req.query` / `req.params`，
 *    因此下游 Controller 拿到的 `page` 已是 number、`id` 已是 bigint，无需再手工转换。
 * 3. **未知字段拒绝**：`.strict()` —— 静默忽略拼错的查询参数会让筛选「看起来没生效」，
 *    早失败比晚发现便宜。
 */

import { z } from 'zod';
import { LIST_RULE } from '@/constants/bizRules';

/** 商品列表排序字段白名单（与 docs/04-flows.md:243 的 `sort` 一致，进入 SQL 前必须过白名单） */
export const PRODUCT_SORT_FIELDS = ['createdAt', 'price', 'sales', 'sort'] as const;

/** 排序方向白名单 */
export const SORT_ORDERS = ['asc', 'desc'] as const;

/**
 * query 入参归一化：字符串去空格，空串 → `undefined`（等价于「未传」）。
 *
 * @description 非字符串原样透传，交给内层 schema 判定，避免在这里替 zod 做类型决定
 * @param value 原始入参
 * @returns 归一化后的值
 */
function normalizeText(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * 构造分页类正整数参数（page / pageSize）。
 *
 * @description 非法值（负数 / 小数 / 超大值 / 数组 / 空串）统一由 zod 产出 400，
 * 而不是像 `utils/paging.ts` 那样静默回退默认值 —— 校验层就该把话说清楚，
 * 回退策略属于「读接口容错」，只在 service 侧使用
 * @param label 中文名，用于错误文案
 * @param max 允许的最大值
 * @param defaultValue 未传时使用的值
 * @returns zod schema（输出 number）
 */
function positiveInt(label: string, max: number, defaultValue: number) {
  return z.preprocess(
    normalizeText,
    z.coerce
      .number()
      .int(`${label}必须是整数`)
      .min(1, `${label}必须大于 0`)
      .max(max, `${label}不可超过 ${max}`)
      .default(defaultValue),
  );
}

/**
 * 路径 / 查询参数里的 ID：字符串 → bigint。
 *
 * @description **不用 `z.coerce.bigint()` 裸转**：`BigInt('abc')` 抛的是 `SyntaxError`，
 * 绕过 zod 的错误收集会变成 500 而不是 400。先用正则把住「纯数字」这一关，
 * 再 transform 成 bigint，非法输入稳定产出字段级错误
 */
const idSchema = z
  .string()
  .regex(/^[1-9]\d*$/, 'ID 必须是正整数')
  .transform((value) => BigInt(value));

/** 商品列表查询参数 schema */
export const productListSchema = z
  .object({
    page: positiveInt('页码', 1_000_000, LIST_RULE.DEFAULT_PAGE),
    pageSize: positiveInt('每页条数', LIST_RULE.MAX_PAGE_SIZE, LIST_RULE.DEFAULT_PAGE_SIZE),
    /**
     * 分类 ID：传空串等价于不筛选。
     * `.optional()` 必须写在 `preprocess` **内层** —— 写在外层时，归一化产生的 `undefined`
     * 会先撞上外层 ZodOptional 之后的必经解析路径而报 Required，空串依旧 400
     */
    categoryId: z.preprocess(normalizeText, z.coerce.bigint().min(1n, '分类 ID 必须是正整数').optional()),
    /** 商品名关键字，去空格后 1~64 字；纯空格等价于不传 */
    keyword: z.preprocess(normalizeText, z.string().min(1, '关键字不可为空').max(64, '关键字长度不可超过 64 字').optional()),
    sortField: z.preprocess(normalizeText, z.enum(PRODUCT_SORT_FIELDS).optional()),
    sortOrder: z.preprocess(normalizeText, z.enum(SORT_ORDERS).optional()),
  })
  .strict();

/** 商品 ID 路径参数 schema */
export const productIdParamSchema = z.object({
  id: idSchema,
});

/** SKU ID 路径参数 schema */
export const skuIdParamSchema = z.object({
  id: idSchema,
});

/** 商品列表查询参数类型（校验并回写后的形态） */
export type ProductListQuery = z.infer<typeof productListSchema>;
/** 商品 ID 路径参数类型 */
export type ProductIdParam = z.infer<typeof productIdParamSchema>;
/** SKU ID 路径参数类型 */
export type SkuIdParam = z.infer<typeof skuIdParamSchema>;
