/**
 * @file server/src/validators/refund.validator.ts
 * @description 退款入参的 zod 校验 schema（申请退款 body、退款单号路径参数、审核 body、列表 query）
 * @module validators
 * @see docs/04-flows.md F9（退款流程）
 * @see src/validators/payment.validator.ts（bigintAmount 同款写法）
 * @see src/validators/balance.validator.ts（分页 query 同款写法）
 * @author 软件开发团队
 * @created 2026-09-12
 *
 * 校验边界（资金安全红线）：
 * - **退款去向 `refundTo` 绝不由前端传**（F9.1 ① 单一来源）：由 RefundService.apply 按订单
 *   `payMethod` 映射，validator 用 `.strict()` 直接拒绝该字段。前端伪造「退余额」等于把平台现金
 *   变成自己的余额——必须在入参层挡掉。
 * - `amount` 用与支付 / 余额模块相同的 `bigintAmount` transform：拒 0 / 负数 / 小数 / 非数字串。
 * - `type` 用 `RefundType` 原生枚举（FULL / PARTIAL），部分退款的行级校验属 T080-C。
 * - 审核 body 只收 `approve`（布尔）与可选 `remark`，**不收任何资金字段**——审核只决定「同不同意」。
 */

import { z } from 'zod';
import { RefundType } from '@prisma/client';

/** 单号最大长度（对齐 `refunds.refund_no` 的 VarChar(32)） */
const MAX_NO_LEN = 32;

/**
 * 把 `string | number` 安全转成 bigint（金额，分）。
 *
 * @description 照抄 `payment.validator.ts:32` / `balance.validator.ts:38`：拒绝 0、负数、小数与非数字串。
 * 不用 `z.coerce.bigint()`——`BigInt('abc')` 抛 `SyntaxError`，会绕过 zod 的错误收集变成 500。
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
 * @description 照抄 `balance.validator.ts:53`：前端按文档原样拼串时会带出 `?page=` 空值，
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
 * @description 照抄 `balance.validator.ts:71` 的 positiveInt：非法值统一由 zod 产出 400。
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
 * 申请退款入参：POST /api/refunds。
 *
 * @description F9.1 ①：只收「给哪笔订单退、退整单还是部分、退多少、原因」，
 * **绝不收退款去向**（由 service 按 payMethod 映射）。
 */
export const applyRefundSchema = z
  .object({
    /** 订单号（必须属于当前登录用户，service 层越权校验兜底） */
    orderNo: z
      .string({ required_error: '订单号不能为空' })
      .trim()
      .min(1, '订单号不能为空')
      .max(MAX_NO_LEN, `订单号长度不可超过 ${MAX_NO_LEN}`),
    /** 退款类型：整单退 / 部分退（部分退行级校验见 service 层 T080-C） */
    type: z.nativeEnum(RefundType, { errorMap: () => ({ message: '退款类型不合法' }) }),
    /** 退款金额（分，bigint；恒 > 0，且 ≤ 订单可退金额，service 层校验上限） */
    amount: bigintAmount,
    /** 退款原因码（字典常量维护，可选） */
    reasonCode: z.string().trim().max(32, '原因码长度不可超过 32').optional(),
    /** 退款原因说明（可选，≤ 500） */
    reasonText: z.string().trim().max(500, '原因说明长度不可超过 500').optional(),
    /** 凭证图片 URL 列表（可选，最多 9 张） */
    voucherImages: z
      .array(z.string().trim().max(512, '凭证图片 URL 过长'))
      .max(9, '凭证图片最多 9 张')
      .optional(),
    /**
     * 部分退款行明细（仅 `type=PARTIAL` 时由前端提供）：整单退由 service 自动按订单全行展开，
     * 前端传了也忽略。每个元素含 `orderItemId`（订单行 ID）/ `quantity`（退几件）/ `amount`（退多少分）。
     * 行级金额与数量的最终校验在 service 层（防超退 / 防伪造行），validator 只做基础形态。
     */
    items: z
      .array(
        z.object({
          /** 订单行 ID（number 或字符串数字均可，统一转 bigint） */
          orderItemId: z.union([z.string(), z.number()]).transform((v) => BigInt(String(v))),
          /** 本次退款数量（正整数） */
          quantity: z.number().int('退款数量必须为整数').positive('退款数量必须大于 0'),
          /** 本次退款金额（分，bigint；拒 0 / 负 / 小数 / 非数字串） */
          amount: bigintAmount,
        }),
      )
      .max(50, '退款商品行最多 50 条')
      .optional(),
    // ⚠️ 红线：故意不接收 `refundTo` —— 退款去向由 service 按 payMethod 映射，前端伪造无效
  })
  .strict();

/**
 * 退款单号路径参数：GET /api/refunds/:refundNo、POST /admin/refunds/:refundNo/audit。
 */
export const refundNoParamSchema = z.object({
  refundNo: z
    .string({ required_error: '退款单号不能为空' })
    .trim()
    .min(1, '退款单号不能为空')
    .max(MAX_NO_LEN, `退款单号长度不可超过 ${MAX_NO_LEN}`),
});

/**
 * 审核退款入参：POST /admin/refunds/:refundNo/audit。
 *
 * @description 审核只决定「同不同意」+ 备注，**不接收任何资金字段**：金额 / 去向 / 状态
 * 全部由 service 层按退款单既有数据推进。
 */
export const auditRefundSchema = z
  .object({
    /** 是否同意（true = 推进退款执行，false = 驳回） */
    approve: z.boolean({ errorMap: () => ({ message: 'approve 必须为布尔值' }) }),
    /** 审核备注（驳回时写入 rejectedReason，可选） */
    remark: z.string().trim().max(500, '审核备注长度不可超过 500').optional(),
  })
  .strict();

/**
 * 退款列表分页 query：GET /api/refunds。
 *
 * @description pageSize 上限 50（与余额流水一致）：退款是资金数据，单页拉太大只会放大越权试探面。
 */
export const listRefundsQuerySchema = z
  .object({
    /** 页码（从 1 起） */
    page: positiveInt('页码', 1_000_000, 1),
    /** 每页条数（默认 20，上限 50） */
    pageSize: positiveInt('每页条数', 50, 20),
  })
  .strict();

/** 申请退款入参类型 */
export type ApplyRefundBody = z.infer<typeof applyRefundSchema>;
/** 退款单号路径参数类型 */
export type RefundNoParam = z.infer<typeof refundNoParamSchema>;
/** 审核退款入参类型 */
export type AuditRefundBody = z.infer<typeof auditRefundSchema>;
/** 退款列表分页查询类型 */
export type ListRefundsQuery = z.infer<typeof listRefundsQuerySchema>;
