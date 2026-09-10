/**
 * @file server/src/tests/unit/money.spec.ts
 * @description MoneyUtil.allocate 分摊算法单测：尾差分配 / 权重截断 / 总和守恒 / 边界
 * @module tests/unit
 * @see docs/03-database.md §3.4（优惠分摊算法 CPN-13，五步）
 * @author 软件开发团队
 * @created 2026-09-04
 *
 * 这三个场景是分摊算法的**资金安全底线**：
 * - 尾差没分对 → 每行实付加起来 ≠ 订单实付（恒等式 E3 漂）；
 * - 截断缺失 → 单行分摊额超过行金额，行实付算成负数（违反约束 ④）；
 * - 守恒不成立 → 一单多件退一件时算不清该退多少，对账必挂。
 */

import { describe, expect, it } from '@jest/globals';

import { ValidationError } from '@/core/errors';
import { MoneyUtil } from '@/core/money';

describe('MoneyUtil.allocate', () => {
  it('尾差应分配给权重最大的行；权重并列时取行号最小者', () => {
    // Σw = 9，total = 7：每行向下取整得 2，尾差 1 落在下标 0
    expect(MoneyUtil.allocate(7, [3, 3, 3])).toEqual([3, 2, 2]);
  });

  it('截断后单行分摊额不得超过该行权重（旧实现会把尾差全部砸到同一行导致溢出）', () => {
    // Σw = 6，total = 5：每行向下取整得 1，尾差 2 必须按剩余容量分到两行，
    // 而不是全部加给下标 0 —— 否则结果为 [3,1,1]，3 > 权重 2，行实付变负数
    const weights = [2, 2, 2];
    const result = MoneyUtil.allocate(5, weights);

    expect(result).toEqual([2, 2, 1]);
    result.forEach((share, index) => {
      // 逐行比对权重（约束 ④）：任何一行溢出都会把该行实付算成负数
      expect(share).toBeLessThanOrEqual(weights[index] ?? 0);
      expect(share).toBeGreaterThanOrEqual(0);
    });
    expect(indexSafeSum(result)).toBe(5);
  });

  it('分摊金额超出各行权重上限时应抛出 ValidationError 而不是静默截断', () => {
    // Σw = 30 < total = 35：优惠力度已超过全部订单行可承受上限，
    // 截断后仍有 5 分无处安放，必须让调用方 clamp 优惠额后重试
    expect(() => MoneyUtil.allocate(35, [10, 20])).toThrow(ValidationError);
  });

  it('总和守恒：任意权重组合下 Σ allocated === total', () => {
    /**
     * 用例数据的**前置条件**：`total <= Σw`。
     *
     * 一旦 `total > Σw`（优惠力度大于全部订单行可分摊金额），allocate 按设计必须抛错 ——
     * 那是上面第 3 个用例的专属场景，不属于本用例的守恒验证范围。
     * 早期版本这里写的是 `999 / [1..9]`（Σw=45）与 `12345 / [1,10,100,1000,10000]`（Σw=11111），
     * 两组都突破了前置条件，导致本用例恒抛 ValidationError：
     * 错在**用例数据**而非实现（实现拒绝越界分摊正是 §3.4 约束 ④ 的要求）。
     * 这里把权重等比放大（×100 / ×2）以保留「权重差异悬殊」的覆盖意图，同时满足 Σw >= total。
     */
    const cases: ReadonlyArray<{ total: number; weights: readonly number[] }> = [
      { total: 10_001, weights: [3333, 3333, 3335] },
      { total: 1, weights: [1, 1, 1, 1, 1, 1, 1] },
      { total: 999, weights: [100, 200, 300, 400, 500, 600, 700, 800, 900] },
      { total: 12_345, weights: [2, 20, 200, 2000, 20_000] },
    ];

    for (const { total, weights } of cases) {
      const result = MoneyUtil.allocate(total, weights);
      expect(result).toHaveLength(weights.length);
      expect(indexSafeSum(result)).toBe(total);
      result.forEach((share, index) => {
        expect(share).toBeLessThanOrEqual(weights[index] ?? 0);
      });
    }
  });

  it('权重为 0 的行不参与分摊，金额全部落在有权重的行', () => {
    // 赠送行（权重 0）不应分到任何优惠，否则会退给用户不存在的钱
    expect(MoneyUtil.allocate(10, [0, 30])).toEqual([0, 10]);
  });

  it('边界：total 为 0 时全行归零；空权重数组且 total 为 0 时返回空数组', () => {
    expect(MoneyUtil.allocate(0, [100, 200])).toEqual([0, 0]);
    expect(MoneyUtil.allocate(0, [])).toEqual([]);
  });

  it('边界：空权重数组且 total 非 0 时应抛错（金额无处安放）', () => {
    expect(() => MoneyUtil.allocate(1, [])).toThrow(ValidationError);
  });
});

/**
 * 求和（测试内工具）。
 *
 * @description 单测里直接用 reduce 求和，避免被测对象（MoneyUtil.sum）出错时
 * 断言也跟着失效 —— 断言不应依赖被测实现
 * @param values 数值数组
 * @returns 总和
 */
function indexSafeSum(values: readonly number[]): number {
  return values.reduce<number>((acc, value) => acc + value, 0);
}
