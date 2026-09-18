/**
 * @file server/src/tests/unit/refundRetry.spec.ts
 * @description 退款重试（T080-D）单元测试：markChannelFailed 退避写 nextRetryAt、retry 状态机守卫
 * @module tests/unit
 * @see server/src/services/RefundService.ts（markChannelFailed / retry）、docs/12-phase12-plan.md
 * @author 软件开发团队
 * @created 2026-09-18
 *
 * 覆盖：
 * 1. markChannelFailed：写 FAILED + failReason + retry_count+1 + nextRetry_at 退避；where 放宽到 [PROCESSING, FAILED]；
 *    命中 RETRY_MAX 后 nextRetryAt=null（终态转人工）。
 * 2. retry 状态机：'skipped'（非 FAILED / re-arm 落空）、'exhausted'（retry_count>=MAX）、
 *    'retried'（re-arm 后 execute 成功）、'retried'（re-arm 后 execute 再抛 41004 → markChannelFailed 补偿）。
 * 3. retry 复用 execute：成功路径下记账（recordBalanceRefund）仍只走 tx，外部单例零调用。
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { OrderStatus, PayChannel, RefundStatus, RefundTarget, RefundType } from '@prisma/client';
import { IdGenerator } from '@/core/idGenerator';
import { withTransaction } from '@/core/transaction';
import type { CouponService } from '@/services/CouponService';
import type { FundService } from '@/services/FundService';
import { RefundService } from '@/services/RefundService';
import type { StockService } from '@/services/StockService';
import { REFUND_RULE } from '@/constants/bizRules';

jest.mock('@/config', () => ({
  config: {
    env: 'test',
    redis: { keyPrefix: 'shop' },
    log: { level: 'error', dir: '' },
  },
  isProduction: false,
  isTest: true,
  isDevelopment: false,
}));

jest.mock('@/core/prisma', () => ({
  getPrisma: jest.fn(() => ({})),
}));

jest.mock('@/core/transaction', () => ({
  withTransaction: jest.fn(),
}));

jest.mock('@/core/idGenerator', () => {
  const actual = jest.requireActual<Record<string, unknown>>('@/core/idGenerator');
  const actualGenerator = actual.IdGenerator as Record<string, unknown>;
  return {
    ...actual,
    IdGenerator: {
      ...actualGenerator,
      refundNo: jest.fn(),
      txGroupNo: jest.fn(),
    },
  };
});

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyAsyncFn = (...args: any[]) => Promise<any>;
/* eslint-enable @typescript-eslint/no-explicit-any */

const REFUND_NO = 'SR20260910000000000001';
const TX_GROUP_NO = 'TG20260910000000000001';

function makeOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 9001n,
    orderNo: 'SO20260910000000000001',
    userId: 7n,
    status: OrderStatus.PAID,
    payAmount: 10000n,
    refundedAmount: 0n,
    payMethod: PayChannel.BALANCE,
    completedAt: null,
    ...overrides,
  };
}

function makeRefund(overrides: Record<string, unknown> = {}) {
  return {
    id: 5001n,
    refundNo: REFUND_NO,
    orderId: 9001n,
    orderNo: 'SO20260910000000000001',
    userId: 7n,
    type: RefundType.FULL,
    amount: 10000n,
    refundTo: RefundTarget.BALANCE,
    status: RefundStatus.PROCESSING,
    retryCount: 0,
    ...overrides,
  };
}

describe('退款重试 T080-D（RefundService）', () => {
  let OUTER: {
    refund: {
      findFirst: jest.Mock<AnyAsyncFn>;
      findUnique: jest.Mock<AnyAsyncFn>;
      updateMany: jest.Mock<AnyAsyncFn>;
    };
  };
  let TX: {
    refund: { findUnique: jest.Mock<AnyAsyncFn>; updateMany: jest.Mock<AnyAsyncFn> };
    order: { findUnique: jest.Mock<AnyAsyncFn>; updateMany: jest.Mock<AnyAsyncFn> };
    orderItem: { updateMany: jest.Mock<AnyAsyncFn> };
    orderStatusLog: { create: jest.Mock<AnyAsyncFn> };
    payment: { updateMany: jest.Mock<AnyAsyncFn> };
    refundItem: { findMany: jest.Mock<AnyAsyncFn> };
    fundAccount: { findFirst: jest.Mock<AnyAsyncFn> };
  };
  let stockService: { refundReturn: jest.Mock<AnyAsyncFn> };
  let fundService: { recordBalanceRefund: jest.Mock<AnyAsyncFn> };
  let couponService: { restoreByOrderNo: jest.Mock<AnyAsyncFn> };
  let svc: RefundService;

  beforeEach(() => {
    jest.clearAllMocks();

    OUTER = {
      refund: {
        findFirst: jest.fn<AnyAsyncFn>(),
        findUnique: jest.fn<AnyAsyncFn>(),
        updateMany: jest.fn<AnyAsyncFn>(),
      },
    };
    TX = {
      refund: { findUnique: jest.fn<AnyAsyncFn>(), updateMany: jest.fn<AnyAsyncFn>() },
      order: { findUnique: jest.fn<AnyAsyncFn>(), updateMany: jest.fn<AnyAsyncFn>() },
      orderItem: { updateMany: jest.fn<AnyAsyncFn>() },
      orderStatusLog: { create: jest.fn<AnyAsyncFn>() },
      payment: { updateMany: jest.fn<AnyAsyncFn>() },
      refundItem: { findMany: jest.fn<AnyAsyncFn>() },
      fundAccount: { findFirst: jest.fn<AnyAsyncFn>() },
    };
    stockService = { refundReturn: jest.fn<AnyAsyncFn>() };
    fundService = { recordBalanceRefund: jest.fn<AnyAsyncFn>() };
    couponService = { restoreByOrderNo: jest.fn<AnyAsyncFn>() };

    (withTransaction as unknown as jest.Mock<AnyAsyncFn>).mockImplementation(
      async (fn: AnyAsyncFn) => fn(TX),
    );
    (IdGenerator.refundNo as unknown as jest.Mock<() => string>).mockReturnValue(REFUND_NO);
    (IdGenerator.txGroupNo as unknown as jest.Mock<() => string>).mockReturnValue(TX_GROUP_NO);

    // execute 默认链路（BALANCE 全退成功）
    TX.refund.updateMany.mockResolvedValue({ count: 1 });
    TX.refund.findUnique.mockResolvedValue(makeRefund());
    TX.order.findUnique.mockResolvedValue(makeOrder());
    TX.order.updateMany.mockResolvedValue({ count: 1 });
    TX.refundItem.findMany.mockResolvedValue([]);
    TX.orderItem.updateMany.mockResolvedValue({ count: 1 });
    TX.payment.updateMany.mockResolvedValue({ count: 1 });
    TX.fundAccount.findFirst.mockResolvedValue({ id: 3001n, accountNo: 'ACC_PLATFORM_CASH' });
    stockService.refundReturn.mockResolvedValue({ skuId: 101n });
    fundService.recordBalanceRefund.mockResolvedValue({ txGroupNo: TX_GROUP_NO });
    couponService.restoreByOrderNo.mockResolvedValue(undefined);

    svc = new RefundService(
      OUTER as never,
      stockService as unknown as StockService,
      fundService as unknown as FundService,
      couponService as unknown as CouponService,
    );
  });

  // --------------------------------------------------------------------------
  // markChannelFailed
  // --------------------------------------------------------------------------

  it('markChannelFailed：写 FAILED + failReason + retry_count+1 + nextRetry_at 退避（attempt=1 → 60s），where 放宽到 [PROCESSING, FAILED]', async () => {
    OUTER.refund.findFirst.mockResolvedValue({ retryCount: 0 });

    const before = Date.now();
    await svc.markChannelFailed(REFUND_NO, '渠道网关超时');
    const after = Date.now();

    expect(OUTER.refund.updateMany).toHaveBeenCalledTimes(1);
    const call = OUTER.refund.updateMany.mock.calls[0]?.[0] as {
      where: { refundNo: string; status: { in: string[] } };
      data: { status: string; failReason: string; retryCount: { increment: number }; nextRetryAt: Date | null };
    };
    expect(call.where.refundNo).toBe(REFUND_NO);
    expect(call.where.status.in).toEqual(
      expect.arrayContaining([RefundStatus.PROCESSING, RefundStatus.FAILED]),
    );
    expect(call.data.status).toBe(RefundStatus.FAILED);
    expect(call.data.failReason).toBe('渠道网关超时');
    expect(call.data.retryCount).toEqual({ increment: 1 });

    const expectedAt = before + REFUND_RULE.backoffMs(1);
    const actualAt = call.data.nextRetryAt?.getTime() ?? 0;
    expect(actualAt).toBeGreaterThanOrEqual(expectedAt - 50);
    expect(actualAt).toBeLessThanOrEqual(after + REFUND_RULE.backoffMs(1) + 50);
  });

  it('markChannelFailed：退避随累计失败次数指数增长（retryCount=3 → attempt=4 → 480s）', async () => {
    OUTER.refund.findFirst.mockResolvedValue({ retryCount: 3 });

    await svc.markChannelFailed(REFUND_NO, 'x');

    const call = OUTER.refund.updateMany.mock.calls[0]?.[0] as {
      data: { nextRetryAt: Date | null };
    };
    // 60 * 2^(4-1) = 60 * 8 = 480000ms
    expect(call.data.nextRetryAt?.getTime()).toBeGreaterThanOrEqual(Date.now() + 480000 - 50);
  });

  it('markChannelFailed：命中 RETRY_MAX 后 nextRetryAt=null（终态，转人工，不再被扫描命中）', async () => {
    OUTER.refund.findFirst.mockResolvedValue({ retryCount: REFUND_RULE.RETRY_MAX });

    await svc.markChannelFailed(REFUND_NO, 'x');

    const call = OUTER.refund.updateMany.mock.calls[0]?.[0] as {
      data: { nextRetryAt: Date | null };
    };
    expect(call.data.nextRetryAt).toBeNull();
  });

  // --------------------------------------------------------------------------
  // retry 状态机
  // --------------------------------------------------------------------------

  it("retry：退款单非 FAILED（SUCCESS）→ 'skipped'，且不 re-arm / 不执行 execute", async () => {
    OUTER.refund.findFirst.mockResolvedValue(makeRefund({ status: RefundStatus.SUCCESS, retryCount: 0 }));

    const result = await svc.retry(REFUND_NO);

    expect(result).toBe('skipped');
    expect(OUTER.refund.updateMany).not.toHaveBeenCalled(); // re-arm 未发生
    expect(TX.refund.updateMany).not.toHaveBeenCalled(); // execute 未发生
  });

  it('retry：retry_count 已达 RETRY_MAX → "exhausted"，不 re-arm', async () => {
    OUTER.refund.findFirst.mockResolvedValue(
      makeRefund({ status: RefundStatus.FAILED, retryCount: REFUND_RULE.RETRY_MAX }),
    );

    const result = await svc.retry(REFUND_NO);

    expect(result).toBe('exhausted');
    expect(OUTER.refund.updateMany).not.toHaveBeenCalled();
  });

  it('retry：re-arm 条件更新落空（并发被别人领走）→ "skipped"，不执行 execute', async () => {
    OUTER.refund.findFirst.mockResolvedValue(makeRefund({ status: RefundStatus.FAILED, retryCount: 0 }));
    OUTER.refund.updateMany.mockResolvedValue({ count: 0 }); // re-arm 落空

    const result = await svc.retry(REFUND_NO);

    expect(result).toBe('skipped');
    expect(TX.refund.updateMany).not.toHaveBeenCalled(); // execute 未发生
  });

  it("retry：re-arm(FAILED→PROCESSING) 后 execute 成功 → 'retried'，记账仍只走 tx", async () => {
    OUTER.refund.findFirst.mockResolvedValue(makeRefund({ status: RefundStatus.FAILED, retryCount: 0 }));
    OUTER.refund.updateMany.mockResolvedValue({ count: 1 }); // re-arm 成功

    const result = await svc.retry(REFUND_NO);

    expect(result).toBe('retried');
    // re-arm：FAILED → PROCESSING
    const rearm = OUTER.refund.updateMany.mock.calls[0]?.[0] as {
      where: { status: string };
      data: { status: string };
    };
    expect(rearm.where.status).toBe(RefundStatus.FAILED);
    expect(rearm.data.status).toBe(RefundStatus.PROCESSING);
    // execute 成功：记账只走 tx，外部单例零调用
    expect(TX.refund.updateMany).toHaveBeenCalled();
    expect(fundService.recordBalanceRefund).toHaveBeenCalledTimes(1);
  });

  it("retry：re-arm 后 execute 再抛 41004（渠道失败）→ 补偿 markChannelFailed，返回 'retried'", async () => {
    // 命中 CHANNEL 分支：loadExecutingRefund 返回 CHANNEL 退款单，loadExecutingOrder 返回 MOCK 支付
    TX.refund.findUnique.mockResolvedValue(
      makeRefund({ status: RefundStatus.PROCESSING, refundTo: RefundTarget.CHANNEL }),
    );
    TX.order.findUnique.mockResolvedValue(makeOrder({ payMethod: PayChannel.MOCK }));

    OUTER.refund.findFirst.mockResolvedValue(makeRefund({ status: RefundStatus.FAILED, retryCount: 0 }));
    // re-arm 一次；markChannelFailed 内部还会再调一次 findFirst + 一次 updateMany
    OUTER.refund.updateMany
      .mockResolvedValueOnce({ count: 1 }) // re-arm
      .mockResolvedValueOnce({ count: 1 }); // markChannelFailed

    const result = await svc.retry(REFUND_NO);

    expect(result).toBe('retried');
    // 共两次 updateMany：re-arm(FAILED→PROCESSING) + markChannelFailed(FAILED, 写退避)
    expect(OUTER.refund.updateMany).toHaveBeenCalledTimes(2);
    const markCall = OUTER.refund.updateMany.mock.calls[1]?.[0] as {
      where: { status: { in: string[] } };
      data: { status: string; nextRetryAt: Date | null };
    };
    expect(markCall.data.status).toBe(RefundStatus.FAILED);
    expect(markCall.where.status.in).toEqual(
      expect.arrayContaining([RefundStatus.PROCESSING, RefundStatus.FAILED]),
    );
    expect(markCall.data.nextRetryAt).not.toBeNull();
  });

  it('retry：execute 抛出非 41004 错误 → 向上传播（不静默吞）', async () => {
    TX.refund.updateMany.mockImplementationOnce(() => {
      throw new Error('DB connection lost');
    });

    OUTER.refund.findFirst.mockResolvedValue(makeRefund({ status: RefundStatus.FAILED, retryCount: 0 }));
    OUTER.refund.updateMany.mockResolvedValue({ count: 1 }); // re-arm

    await expect(svc.retry(REFUND_NO)).rejects.toThrow('DB connection lost');
  });
});
