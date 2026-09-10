/**
 * @file server/src/tests/unit/paymentValidator.spec.ts
 * @description 支付入参 zod schema 单测（对照 `orderValidator.spec.ts` 补充）
 * @module tests/unit
 * @see server/src/validators/payment.validator.ts、docs/04-flows.md F6
 * @author 软件开发团队
 * @created 2026-09-08
 *
 * 两条必须守住的红线：
 * 1. **发起支付绝不接收金额** —— 应付金额由服务端按订单 `payAmount` 定，
 *    若校验层放行 `amount`，价格篡改的口子就开在了入口。
 * 2. **本期只开放 MOCK 渠道** —— 真实渠道要等 T061 的 `PaymentRouter`，
 *    现在放开会让用户选了支付宝却拿到 mock 支付页（看起来能用、实际是假的）。
 */

import { describe, expect, it } from '@jest/globals';
import {
  createPaymentSchema,
  mockPaidSchema,
  paymentNoParamSchema,
} from '@/validators/payment.validator';

/** 合法的发起支付入参 */
const validCreate = { orderNo: 'SO20260908000001234', payMethod: 'MOCK' };

/** 校验并返回是否通过 */
const parseCreate = (input: unknown) => createPaymentSchema.safeParse(input);

describe('createPaymentSchema 发起支付校验', () => {
  it('合法入参通过（MOCK 渠道）', () => {
    const result = parseCreate(validCreate);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.payMethod).toBe('MOCK');
    }
  });

  it('⚠️ 红线：传 amount 一律被拒（金额必须由服务端按订单定）', () => {
    expect(parseCreate({ ...validCreate, amount: 1 }).success).toBe(false);
    expect(parseCreate({ ...validCreate, payAmount: 100 }).success).toBe(false);
  });

  it('orderNo 为空 → 拒绝', () => {
    expect(parseCreate({ ...validCreate, orderNo: '' }).success).toBe(false);
  });

  it('orderNo 超过 32 字符 → 拒绝', () => {
    expect(parseCreate({ ...validCreate, orderNo: 'x'.repeat(33) }).success).toBe(false);
  });

  it('payMethod 为 ALIPAY / WECHAT → 拒绝（本期未开放）', () => {
    expect(parseCreate({ ...validCreate, payMethod: 'ALIPAY' }).success).toBe(false);
    expect(parseCreate({ ...validCreate, payMethod: 'WECHAT' }).success).toBe(false);
  });

  it('未知字段 → 拒绝（strict，防前端拼错字段名）', () => {
    expect(parseCreate({ ...validCreate, unknownField: 1 }).success).toBe(false);
  });

  it('缺少 orderNo → 拒绝', () => {
    expect(parseCreate({ payMethod: 'MOCK' }).success).toBe(false);
  });
});

describe('paymentNoParamSchema 支付单号路径参数校验', () => {
  it('合法支付单号通过', () => {
    expect(paymentNoParamSchema.safeParse({ paymentNo: 'PAY20260908000001' }).success).toBe(true);
  });

  it('空 / 超长 → 拒绝', () => {
    expect(paymentNoParamSchema.safeParse({ paymentNo: '' }).success).toBe(false);
    expect(paymentNoParamSchema.safeParse({ paymentNo: 'x'.repeat(33) }).success).toBe(false);
  });
});

describe('mockPaidSchema mock 确认入参校验', () => {
  it('合法金额通过并转成 bigint（分）', () => {
    const result = mockPaidSchema.safeParse({ amount: '12800' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.amount).toBe(12800n);
    }
  });

  it('金额也接受 number', () => {
    const result = mockPaidSchema.safeParse({ amount: 12800 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.amount).toBe(12800n);
    }
  });

  it.each([
    ['0', '0'],
    ['负数', '-1'],
    ['小数（元/分单位用错）', '128.5'],
    ['非数字串', 'abc'],
  ])('amount 为%s时被拒绝', (_label, value) => {
    expect(mockPaidSchema.safeParse({ amount: value }).success).toBe(false);
  });

  it('未知字段 → 拒绝（strict）', () => {
    expect(mockPaidSchema.safeParse({ amount: 100, extra: 1 }).success).toBe(false);
  });
});
