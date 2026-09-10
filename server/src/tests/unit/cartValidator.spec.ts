/**
 * @file server/src/tests/unit/cartValidator.spec.ts
 * @description 购物车入参校验单测（纯 zod，不依赖 config / Prisma / Redis）
 * @module tests/unit
 * @see server/src/validators/cart.validator.ts、docs/04-flows.md:355（F4.2 关键规则）
 * @author 软件开发团队
 * @created 2026-09-07
 *
 * 为什么单独测校验而不只靠接口测试：
 * 数量上限（CART-06）、strict 未知字段、ID 转换这些规则**只有负例才能暴露**，
 * 而接口层的负例要起整个 app（还依赖 DB）。这里纯函数直接断言，跑得快也更容易定位。
 *
 * 本文件不需要 `jest.mock('@/config')`：schema 只依赖 zod，import 链路上没有 config。
 */

import { describe, expect, it } from '@jest/globals';
import {
  addCartItemSchema,
  cartItemIdParamSchema,
  mergeCartSchema,
  removeCartItemsSchema,
  updateCartItemSchema,
} from '@/validators/cart.validator';

describe('cart.validator · 加购入参', () => {
  it('合法入参：skuId 字符串转 bigint', () => {
    const r = addCartItemSchema.parse({ skuId: '12', quantity: 3 });
    expect(r.skuId).toBe(12n);
    expect(typeof r.skuId).toBe('bigint');
  });

  it('合法入参：skuId 数字也收（前端两种都可能发）', () => {
    expect(addCartItemSchema.parse({ skuId: 12, quantity: 1 }).skuId).toBe(12n);
  });

  it('数量边界：1 与 999 通过，0 与 1000 拒绝', () => {
    expect(addCartItemSchema.safeParse({ skuId: '1', quantity: 1 }).success).toBe(true);
    expect(addCartItemSchema.safeParse({ skuId: '1', quantity: 999 }).success).toBe(true);
    expect(addCartItemSchema.safeParse({ skuId: '1', quantity: 0 }).success).toBe(false);
    expect(addCartItemSchema.safeParse({ skuId: '1', quantity: 1000 }).success).toBe(false);
  });

  it('数量非整数（2.5）拒绝', () => {
    expect(addCartItemSchema.safeParse({ skuId: '1', quantity: 2.5 }).success).toBe(false);
  });

  it('非法 ID 拒绝且不抛异常（避免 BigInt() 抛 SyntaxError 变 500）', () => {
    for (const bad of ['abc', '', '0', '-1', '1.5']) {
      const r = addCartItemSchema.safeParse({ skuId: bad, quantity: 1 });
      expect(r.success).toBe(false);
    }
  });

  it('strict：未知字段拒绝（前端传错字段名的常见情形）', () => {
    const r = addCartItemSchema.safeParse({ skuId: '1', quantity: 1, evil: 'x' });
    expect(r.success).toBe(false);
  });
});

describe('cart.validator · 改数量 / 勾选', () => {
  it('只传 quantity 通过', () => {
    expect(updateCartItemSchema.parse({ quantity: 5 })).toEqual({ quantity: 5 });
  });

  it('只传 selected 通过（不校验库存，不需要 quantity）', () => {
    expect(updateCartItemSchema.parse({ selected: false })).toEqual({ selected: false });
  });

  it('空对象拒绝：两个字段都不传是无意义写请求', () => {
    expect(updateCartItemSchema.safeParse({}).success).toBe(false);
  });

  it('路径参数 id 转 bigint', () => {
    expect(cartItemIdParamSchema.parse({ id: '7' }).id).toBe(7n);
  });
});

describe('cart.validator · 批量删除与合并', () => {
  it('ids 非空数组转 bigint[]', () => {
    expect(removeCartItemsSchema.parse({ ids: ['1', '2'] }).ids).toEqual([1n, 2n]);
  });

  it('ids 空数组拒绝', () => {
    expect(removeCartItemsSchema.safeParse({ ids: [] }).success).toBe(false);
  });

  it('ids 超 100 条拒绝（保护事务不被一次请求拖垮）', () => {
    const ids = Array.from({ length: 101 }, (_, i) => String(i + 1));
    expect(removeCartItemsSchema.safeParse({ ids }).success).toBe(false);
  });

  it('合并入参：items 转 bigint 且超 100 条拒绝', () => {
    const ok = mergeCartSchema.parse({ items: [{ skuId: '3', quantity: 2 }] });
    expect(ok.items[0]?.skuId).toBe(3n);

    const tooMany = mergeCartSchema.safeParse({
      items: Array.from({ length: 101 }, (_, i) => ({ skuId: String(i + 1), quantity: 1 })),
    });
    expect(tooMany.success).toBe(false);
  });

  it('合并入参：items 为空数组拒绝', () => {
    expect(mergeCartSchema.safeParse({ items: [] }).success).toBe(false);
  });
});
