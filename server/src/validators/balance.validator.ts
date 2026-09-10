/**
 * @file server/src/validators/balance.validator.ts
 * @description 余额模块入参的 zod schema（创建充值单 body、流水分页 query）
 * @module validators
 * @see docs/04-flows.md F14（余额充值）、F14.2（余额不可用于充值）
 * @see src/validators/payment.validator.ts（bigintAmount 同款写法）
 * @see src/validators/product.validator.ts（normalizeText / positiveInt 分页同款写法）
 * @author 软件开发团队
 * @created 2026-09-09
 *
 * 校验边界：
 * - `payMethod` **仅允许 ALIPAY / WECHAT / BANKCARD，刻意不含 BALANCE**（F14.2 红线）：
 *   余额充余额会绕过充值限额，还会用「自己给自己加钱」的假象污染负债台账
 *   （`Σ 用户余额 = -net_liability` 恒等式，见 F11.5），必须在入参层直接拒绝。
 * - `amount` 用与支付模块完全相同的 `bigintAmount` transform：拒 0 / 负数 / 小数 / 非数字串。
 *   不用 `z.coerce.bigint()`——`BigInt('abc')` 抛 `SyntaxError`，会绕过 zod 的错误收集变成 500。
 */

import { z } from 'zod';

/**
 * 充值允许的支付方式白名单：仅外部渠道。
 *
 * @description **刻意不含 BALANCE / MOCK**（F14.2）：余额充余额会绕过充值限额；
 * 充值也没有 mock 渠道——mock 收银台只用于订单支付联调，充值走真渠道或 T070-C 的托管收银台。
 */
export const RECHARGE_PAY_METHODS = ['ALIPAY', 'WECHAT', 'BANKCARD'] as const;

/** 充值支付方式类型 */
export type RechargePayMethod = (typeof RECHARGE_PAY_METHODS)[number];

/**
 * 把 `string | number` 安全转成 bigint（金额，分）。
 *
 * @description 照抄 `payment.validator.ts:32`：拒绝 0、负数、小数与非数字串。
 * 小数说明前端单位用错了（元 vs 分），0 / 负数是明显非法的充值请求。
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
 * query 入参归一化：字符串去空格，空串 → `undefined`（等价于「未传」）。
 *
 * @description 照抄 `product.validator.ts`：前端按文档原样拼串时会带出 `?page=` 空值，
 * 直接 coerce 会得到 0 再被 min(1) 打回 400，体验很差；空串视为未传走默认值。
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
 * @description 照抄 `product.validator.ts` 的 positiveInt：非法值（负数 / 小数 / 超大值 /
 * 数组 / 空串）统一由 zod 产出 400，而不是静默回退默认值。
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
 * 余额流水分页 query：GET /api/balance/transactions。
 *
 * @description pageSize 上限 50（比商品列表的 100 更紧）：流水是资金数据，
 * 单页拉太大没有业务价值，只会放大越权试探面与内存占用。
 */
export const listTransactionsQuerySchema = z
  .object({
    /** 页码（从 1 起） */
    page: positiveInt('页码', 1_000_000, 1),
    /** 每页条数（默认 20，上限 50） */
    pageSize: positiveInt('每页条数', 50, 20),
  })
  .strict();

/**
 * 创建充值单入参：POST /api/balance/recharges。
 *
 * @description F14.1 ①：充值 = 创建充值单（PENDING）→ 渠道支付 → 回调事务 I 双流水入账。
 * `payMethod` 白名单见 {@link RECHARGE_PAY_METHODS}。
 */
export const rechargeSchema = z
  .object({
    /** 充值金额（分），必须为正整数 */
    amount: bigintAmount,
    /**
     * 支付方式：仅 ALIPAY / WECHAT / BANKCARD。
     *
     * @description **红线（F14.2）**：不含 BALANCE——余额充余额会绕过充值限额，
     * 并破坏负债恒等式；错误文案直接告诉用户原因，避免「为什么选不了余额」的客诉。
     */
    payMethod: z.enum(RECHARGE_PAY_METHODS, {
      errorMap: () => ({ message: '充值仅支持支付宝 / 微信 / 银行卡支付（余额不可用于充值）' }),
    }),
  })
  .strict();

/** 创建充值单入参类型 */
export type CreateRechargeBody = z.infer<typeof rechargeSchema>;
/** 余额流水分页查询类型 */
export type ListTransactionsQuery = z.infer<typeof listTransactionsQuerySchema>;
