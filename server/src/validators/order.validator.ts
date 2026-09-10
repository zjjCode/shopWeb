/**
 * @file server/src/validators/order.validator.ts
 * @description 下单入参的 zod 校验 schema（POST /api/orders）
 * @module validators
 * @see docs/04-flows.md F5（363-536 行）、docs/04-flows.md:358（结算二次校验）
 * @see src/validators/cart.validator.ts（同类写法）
 * @author 软件开发团队
 * @created 2026-09-07
 *
 * 校验边界：
 * - `cartItemIds` 数组长度 1 ~ 100：上限与购物车条目上限一致，避免一次请求塞进
 *   几千条把事务 A 拖垮（事务越长，锁持有越久，死锁与超时的概率越高）；
 * - `addressId` / `couponId` 用 `bigintId` 安全转换（拒绝 0 / 负数 / 小数 / 非数字串）；
 * - 设计 §7.3 要求 strict：未知字段直接 400，不放过拼写错误的字段。
 *
 * ⚠️ **绝不接受任何金额字段**（`payAmount` / `freightAmount` 等）：
 * 金额一律由服务端 `PriceService` 重算（F5 阶段 2）。若这里放开金额入参，
 * 就等于把「价格篡改」的口子开在校验层——strict 会直接拒掉，这是有意为之的红线。
 */

import { z } from 'zod';

/** 单次下单的购物车条目数上限（与购物车条目上限一致，保护事务长度） */
const MAX_ORDER_ITEMS = 100;

/** 买家备注最大长度（与 `orders.buyer_remark` 的 VarChar(255) 对齐） */
const MAX_BUYER_REMARK = 255;

/**
 * 把 `string | number` 安全转成 bigint。
 *
 * @description 拒绝 `0`、负数、小数与非数字字符串——这类值要么查不到，
 * 要么（如 `BigInt('') === 0n`）会命中一个存在但错误的 ID，最难排查。
 * 不用 `z.coerce.bigint()`：`BigInt('abc')` 抛 `SyntaxError`，会绕过 zod 的错误收集变成 500。
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

/**
 * 下单入参：POST /api/orders
 *
 * @description 只收「选了什么、送到哪、用什么券」，**不收任何金额**。
 */
export const createOrderSchema = z
  .object({
    /** 收货地址 ID（必须属于当前用户，由 service 层带 userId 校验） */
    addressId: bigintId,
    /** 参与结算的购物车条目 ID（必须是已勾选的） */
    cartItemIds: z
      .array(bigintId)
      .min(1, '请选择要结算的商品')
      .max(MAX_ORDER_ITEMS, `单次最多结算 ${MAX_ORDER_ITEMS} 个条目`),
    /** 买家备注（可空） */
    buyerRemark: z
      .string()
      .trim()
      .max(MAX_BUYER_REMARK, `买家备注不可超过 ${MAX_BUYER_REMARK} 字`)
      .nullish(),
    /**
     * 优惠券 ID（可空）。**本期恒为 null**：券占用需与建单同事务，
     * 待 T041 的 CouponService 就绪后启用。
     */
    couponId: bigintId.nullish(),
  })
  .strict();

/** 下单入参类型 */
export type CreateOrderInput = z.infer<typeof createOrderSchema>;
