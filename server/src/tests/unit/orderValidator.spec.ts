/**
 * @file server/src/tests/unit/orderValidator.spec.ts
 * @description 下单入参 zod schema 单测（对照 T030-B 的 `cartValidator.spec.ts` 补充）
 * @module tests/unit
 * @see server/src/validators/order.validator.ts、docs/04-flows.md F5
 * @author 软件开发团队
 * @created 2026-09-07
 *
 * 最关键的用例是**「金额字段必须被拒」**：下单金额一律服务端重算，
 * 若校验层放行了 `payAmount`，就等于把价格篡改的口子开在了入口。
 * 这条红线必须有测试守着，否则哪天有人给 schema 加个可选金额字段也不会被发现。
 */

import { describe, expect, it } from '@jest/globals';
import { createOrderSchema } from '@/validators/order.validator';

/** 合法的基础入参 */
const validInput = { addressId: '1', cartItemIds: ['11', '12'] };

/** 校验并返回是否通过 */
const parse = (input: unknown) => createOrderSchema.safeParse(input);

describe('createOrderSchema 下单入参校验', () => {
  it('合法入参通过，ID 字符串被转成 bigint', () => {
    const result = parse(validInput);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.addressId).toBe(1n);
      expect(result.data.cartItemIds).toEqual([11n, 12n]);
    }
  });

  it('ID 也接受 number（前端 JSON 可能直接给数字）', () => {
    const result = parse({ addressId: 1, cartItemIds: [11] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.addressId).toBe(1n);
    }
  });

  it.each([
    ['0', '0'],
    ['负数', '-1'],
    ['小数', '1.5'],
    ['非数字串', 'abc'],
    ['空串', ''],
  ])('addressId 为%s时被拒绝（不用 coerce，避免 BigInt 抛错变 500）', (_label, value) => {
    expect(parse({ ...validInput, addressId: value }).success).toBe(false);
  });

  it('cartItemIds 为空数组 → 拒绝', () => {
    expect(parse({ addressId: '1', cartItemIds: [] }).success).toBe(false);
  });

  it('cartItemIds 超过 100 条 → 拒绝（保护事务长度）', () => {
    const ids = Array.from({ length: 101 }, (_, i) => String(i + 1));
    expect(parse({ addressId: '1', cartItemIds: ids }).success).toBe(false);
  });

  it('cartItemIds 恰好 100 条 → 通过', () => {
    const ids = Array.from({ length: 100 }, (_, i) => String(i + 1));
    expect(parse({ addressId: '1', cartItemIds: ids }).success).toBe(true);
  });

  it('buyerRemark 超过 255 字 → 拒绝', () => {
    expect(parse({ ...validInput, buyerRemark: 'x'.repeat(256) }).success).toBe(false);
  });

  it('buyerRemark 为 null → 通过（可空）', () => {
    expect(parse({ ...validInput, buyerRemark: null }).success).toBe(true);
  });

  it('couponId 为 null → 通过（本期恒 null）', () => {
    expect(parse({ ...validInput, couponId: null }).success).toBe(true);
  });

  it('未知字段 → 拒绝（strict，防前端拼错字段名）', () => {
    expect(parse({ ...validInput, unknownField: 1 }).success).toBe(false);
  });

  it('⚠️ 红线：payAmount 等金额字段一律被拒（金额必须服务端重算）', () => {
    expect(parse({ ...validInput, payAmount: 1 }).success).toBe(false);
    expect(parse({ ...validInput, freightAmount: 0 }).success).toBe(false);
    expect(parse({ ...validInput, goodsAmount: 100 }).success).toBe(false);
  });
});
