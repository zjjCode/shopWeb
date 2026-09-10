/**
 * @file server/src/validators/cart.validator.ts
 * @description 购物车入参的 zod 校验 schema（加购 / 改数量 / 删除 / 未登录合并）
 * @module validators
 * @see docs/04-flows.md:293（F4 购物车）、docs/04-flows.md:355（F4.2 关键规则）
 * @see src/validators/product.validator.ts（同类写法）
 * @author 软件开发团队
 * @created 2026-09-07
 *
 * 校验边界（与 F4.2 规则表一一对应）：
 * - 数量 `quantity ∈ [1, 999]`（CART-06），超上限返回 `30003`；
 * - 合并入参数组长度 ≤ 100，避免一次请求塞进几千条把事务拖垮；
 * - 设计 §7.3 要求 strict：未知字段直接 400，不放过拼写错误的字段（那通常意味着前端传错了语义）。
 *
 * ⚠️ 为什么 ID 要收 `string | number` 再转 bigint：
 * 数据库主键是 `BIGINT`，Prisma 返回 JS `bigint`；但 JSON 无法安全表示 bigint
 * （前端 `JSON.stringify` 会直接抛错），所以前端只能把 ID 当**字符串**发。
 * 路径参数天然是字符串，请求体则两种都可能遇到，因此这里两种都收，统一转成 bigint。
 * 不用 `z.coerce.bigint()`：`BigInt('abc')` 抛 `SyntaxError`，会绕过 zod 的错误收集变成 500
 * （这个坑在 `product.validator.ts` 里已经踩过一次）。
 */

import { z } from 'zod';

/** 单 SKU 数量上限（CART-06） */
const MAX_QUANTITY = 999;
/** 单次合并的条目数上限（保护事务，避免一次请求塞入过多条目） */
const MAX_MERGE_ITEMS = 100;

/**
 * 把 `string | number` 安全转成 bigint。
 *
 * @description 拒绝 `0`、负数、小数与非数字字符串——这类值要么查不到，
 * 要么（如 `BigInt('') === 0n`）会命中一个存在但错误的 ID，最难排查
 * @returns 校验通过返回 bigint，否则追加 zod issue 并中断
 */
const bigintId = z.union([z.string(), z.number()]).transform((value, ctx) => {
  const text = String(value);
  if (!/^[1-9]\d*$/.test(text)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'ID 格式不正确' });
    return z.NEVER;
  }
  return BigInt(text);
});

/** 数量的公共约束：1 ~ 999 的整数 */
const quantity = z
  .number({ invalid_type_error: '数量必须是数字' })
  .int('数量必须是整数')
  .min(1, '数量必须大于 0')
  .max(MAX_QUANTITY, `单个 SKU 数量不可超过 ${MAX_QUANTITY}`);

/** 加购入参：POST /api/cart/items */
export const addCartItemSchema = z
  .object({
    skuId: bigintId,
    quantity,
  })
  .strict();

/**
 * 改数量 / 勾选入参：PATCH /api/cart/items/:id
 *
 * @description 两个字段都可选，但**不能都不传**（`{}` 是一次无意义的写请求），
 * 用 `refine` 兜住；只传 `selected` 时不校验库存
 */
export const updateCartItemSchema = z
  .object({
    quantity: quantity.optional(),
    selected: z.boolean().optional(),
  })
  .strict()
  .refine((data) => data.quantity !== undefined || data.selected !== undefined, {
    message: 'quantity 与 selected 至少需要传一个',
  });

/** 路径参数：购物车条目 ID */
export const cartItemIdParamSchema = z.object({ id: bigintId });

/** 批量删除入参：DELETE /api/cart/items */
export const removeCartItemsSchema = z
  .object({
    ids: z.array(bigintId).min(1, 'ids 不可为空').max(MAX_MERGE_ITEMS, `单次最多删除 ${MAX_MERGE_ITEMS} 条`),
  })
  .strict();

/** 未登录购物车合并入参：POST /api/cart/merge */
export const mergeCartSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            skuId: bigintId,
            quantity,
          })
          .strict(),
      )
      .min(1, 'items 不可为空')
      .max(MAX_MERGE_ITEMS, `单次最多合并 ${MAX_MERGE_ITEMS} 条`),
  })
  .strict();

/** 加购入参类型 */
export type AddCartItemInput = z.infer<typeof addCartItemSchema>;
/** 改数量 / 勾选入参类型 */
export type UpdateCartItemInput = z.infer<typeof updateCartItemSchema>;
/** 购物车条目 ID 路径参数类型 */
export type CartItemIdParam = z.infer<typeof cartItemIdParamSchema>;
/** 批量删除入参类型 */
export type RemoveCartItemsInput = z.infer<typeof removeCartItemsSchema>;
/** 合并入参类型 */
export type MergeCartInput = z.infer<typeof mergeCartSchema>;
