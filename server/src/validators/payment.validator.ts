/**
 * @file server/src/validators/payment.validator.ts
 * @description 支付入参的 zod 校验 schema（发起支付 / mock 支付确认）
 * @module validators
 * @see docs/04-flows.md F6（556 行起）、docs/02-architecture.md §6.7（mock 渠道红线）
 * @see src/validators/order.validator.ts（同类写法）
 * @author 软件开发团队
 * @created 2026-09-08
 *
 * 校验边界：
 * - `payMethod` **本期只允许 `MOCK`**：真实渠道（ALIPAY / WECHAT / BANKCARD）要等 T061 的
 *   `PaymentRouter` 与适配器就绪。现在放开会让用户在收银台选了支付宝却拿到 mock 的支付页，
 *   属于「看起来能用、实际是假的」的坑，不如直接挡掉。
 * - 发起支付**绝不接收 `amount`**：应付金额由服务端按订单 `payAmount` 定（与下单同一条红线）。
 * - mock 确认端点的 `amount` 是**模拟渠道回调携带的金额**，不是「用户想付多少」——
 *   `PaymentService.handlePaidNotify` 会与支付单金额做**严格相等**校验，不符即抛 40002。
 *   这与真实渠道回调的语义完全一致（渠道告诉我们收了多少钱，我们核对，不采信）。
 */

import { z } from 'zod';

/** 单号最大长度（对齐 `payments.payment_no` 的 VarChar(32) 与 `orders.order_no`） */
const MAX_NO_LEN = 32;

/**
 * 把 `string | number` 安全转成 bigint（金额，分）。
 *
 * @description 拒绝 0、负数、小数与非数字串：金额为 0 或负是明显的非法回调，
 * 小数则说明前端单位用错了（元 vs 分）。不用 `z.coerce.bigint()`——
 * `BigInt('abc')` 抛 `SyntaxError`，会绕过 zod 的错误收集变成 500。
 */
const bigintAmount = z.union([z.string(), z.number()]).transform((value, ctx) => {
  const text = String(value);
  if (!/^[1-9]\d*$/.test(text)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: '金额格式不正确' });
    return z.NEVER;
  }
  return BigInt(text);
});

/**
 * 发起支付入参：POST /api/payments
 *
 * @description 只收「给哪笔订单付、用什么方式」，**不收金额**。
 */
export const createPaymentSchema = z
  .object({
    /** 订单号 */
    orderNo: z
      .string({ required_error: '订单号不能为空' })
      .trim()
      .min(1, '订单号不能为空')
      .max(MAX_NO_LEN, `订单号长度不可超过 ${MAX_NO_LEN}`),
    /**
     * 支付方式。**本期仅 MOCK 可用**（真实渠道待 T061 的 PaymentRouter 接入）。
     * 放开时把这里改成 `z.nativeEnum(PayChannel)` 即可。
     */
    payMethod: z.enum(['MOCK'], { errorMap: () => ({ message: '本期仅支持 MOCK 支付方式' }) }),
  })
  .strict();

/**
 * 路径参数：支付单号。
 *
 * @description 用于 mock 确认端点 `POST /api/payments/:paymentNo/mock-paid`。
 */
export const paymentNoParamSchema = z.object({
  paymentNo: z
    .string({ required_error: '支付单号不能为空' })
    .trim()
    .min(1, '支付单号不能为空')
    .max(MAX_NO_LEN, `支付单号长度不可超过 ${MAX_NO_LEN}`),
});

/**
 * mock 支付确认入参（模拟渠道回调）。
 *
 * @description `amount` 是**渠道声称收到的金额**（分），由服务端与支付单严格比对。
 * 它不是「用户想付多少」——改小不会少付，只会触发 40002 拒绝入账。
 */
export const mockPaidSchema = z
  .object({
    amount: bigintAmount,
  })
  .strict();

/** 发起支付入参类型 */
export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;
/** 支付单号路径参数类型 */
export type PaymentNoParam = z.infer<typeof paymentNoParamSchema>;
/** mock 支付确认入参类型 */
export type MockPaidInput = z.infer<typeof mockPaidSchema>;
