/**
 * @file server/src/tests/unit/refundService.spec.ts
 * @description 退款领域层（T080-A）单元测试：apply 拒收路径、audit 双分支、execute 事务 C 与三条流水记账
 * @module tests/unit
 * @see server/src/services/RefundService.ts、docs/04-flows.md F9.1 ④ / F9.3（1171 行反向结转对）
 * @author 软件开发团队
 * @created 2026-09-09
 *
 * ⚠️ 本套件与既有两个套件最大的不同（也是它存在的理由）：
 * **「构造注入的 Prisma 委托」(`OUTER`) 与「`withTransaction` 回调里的 tx 委托」(`TX`)
 * 是两组完全独立的 `jest.fn()`**。既有套件里二者是同一个 mock 对象，于是
 * 「写操作到底走了 tx、还是误走了外部 Prisma 单例」在断言层面**无法区分** ——
 * 而「漏传 tx」正是本批最致命的回归方向（记账跑独立连接 → 事务回滚时钱凭空多出来）。
 * 拆成两组后 `expect(OUTER.xxx).not.toHaveBeenCalled()` 才真正有意义。
 *
 * 覆盖：
 * 1. `apply` 六条拒收路径 + 成功建单（`refundNo` 由 `IdGenerator` 生成、`status=PENDING`、
 *    `refundTo` 由 `payMethod` 正确映射）；
 * 2. `audit` 驳回 / 同意 / 不存在 / 非 PENDING / 并发 `count=0`；
 * 3. `execute` BALANCE 三条流水：金额一致、调用顺序、`isLiability` 取值（尤其反向结转对）、
 *    同一 `txGroupNo`、counterparty 互指、`(bizType, idempotencyKey)` 组合互不相同；
 * 4. `execute` 全部写操作走 tx，外部单例零调用；
 * 5. `execute` 退款单并发（`count=0`）→ 不推进订单、不记账；
 * 6. `execute` CHANNEL → 抛 41004 且不记账、订单状态不变；
 * 7. 记账任一步抛错 → 向上传播，后续流水不执行。
 *
 * 边界说明：**真实回滚行为由 MySQL 事务保证，单元层无法验证**。本套件验证的是
 * 「写操作是否都在同一个事务闭包内」+「失败是否向上传播」，DB 层回滚待集成测试验证。
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { OrderStatus, PayChannel, RefundStatus, RefundTarget, RefundType } from '@prisma/client';
import { ErrorCode } from '@/core/errors/errorCodes';
import { IdGenerator } from '@/core/idGenerator';
import { withTransaction } from '@/core/transaction';
import type { FundService } from '@/services/FundService';
import { RefundService } from '@/services/RefundService';
import type { StockService } from '@/services/StockService';

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

// 单号生成器：固定返回值，便于断言「退款单号确实来自 IdGenerator」与「三条流水同组号」。
// 其余导出透传真实实现，避免影响同样依赖本模块的 FundService / StockService。
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

/** 记账入参（断言用，只取关心的字段） */
type FundPost = {
  accountId: bigint;
  amount: bigint;
  bizType: string;
  isLiability?: boolean;
  counterpartyAccountId?: bigint | null;
  counterpartyAccountNo?: string | null;
  txGroupNo?: string | null;
  idempotencyKey?: string | null;
  orderNo?: string | null;
  refundNo?: string | null;
};

/** 固定退款单号（`IdGenerator.refundNo` 的桩返回值） */
const REFUND_NO = 'SR20260910000000000001';
/** 固定交易组号（`IdGenerator.txGroupNo` 的桩返回值） */
const TX_GROUP_NO = 'TG20260910000000000001';

/** 可申请退款的订单（默认：已支付、实付 10000 分、余额支付、未退过） */
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

/** 执行中的退款单（默认：整单退 10000 分、退余额、PROCESSING） */
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
    ...overrides,
  };
}

describe('退款领域层 RefundService（T080-A）', () => {
  /**
   * 外部 Prisma 单例的委托。
   *
   * @description 与 {@link TX} 是两组独立 mock —— 任何写操作误走外部单例都会被断言抓住。
   */
  let OUTER: {
    order: { findFirst: jest.Mock<AnyAsyncFn>; findUnique: jest.Mock<AnyAsyncFn>; updateMany: jest.Mock<AnyAsyncFn> };
    orderItem: { updateMany: jest.Mock<AnyAsyncFn> };
    orderStatusLog: { create: jest.Mock<AnyAsyncFn> };
    payment: { updateMany: jest.Mock<AnyAsyncFn> };
    refund: {
      findFirst: jest.Mock<AnyAsyncFn>;
      findUnique: jest.Mock<AnyAsyncFn>;
      create: jest.Mock<AnyAsyncFn>;
      updateMany: jest.Mock<AnyAsyncFn>;
    };
    refundItem: { findMany: jest.Mock<AnyAsyncFn> };
    fundAccount: { findFirst: jest.Mock<AnyAsyncFn> };
  };
  /** 事务闭包内的委托（**所有写操作必须走它**） */
  let TX: {
    order: { findUnique: jest.Mock<AnyAsyncFn>; updateMany: jest.Mock<AnyAsyncFn> };
    orderItem: { updateMany: jest.Mock<AnyAsyncFn> };
    orderStatusLog: { create: jest.Mock<AnyAsyncFn> };
    payment: { updateMany: jest.Mock<AnyAsyncFn> };
    refund: { findUnique: jest.Mock<AnyAsyncFn>; updateMany: jest.Mock<AnyAsyncFn> };
    refundItem: { findMany: jest.Mock<AnyAsyncFn> };
    fundAccount: { findFirst: jest.Mock<AnyAsyncFn> };
  };
  let stockService: { refundReturn: jest.Mock<AnyAsyncFn> };
  let fundService: {
    credit: jest.Mock<AnyAsyncFn>;
    debit: jest.Mock<AnyAsyncFn>;
    getOrCreateAccount: jest.Mock<AnyAsyncFn>;
  };
  let svc: RefundService;

  beforeEach(() => {
    jest.clearAllMocks();

    OUTER = {
      order: {
        findFirst: jest.fn<AnyAsyncFn>(),
        findUnique: jest.fn<AnyAsyncFn>(),
        updateMany: jest.fn<AnyAsyncFn>(),
      },
      orderItem: { updateMany: jest.fn<AnyAsyncFn>() },
      orderStatusLog: { create: jest.fn<AnyAsyncFn>() },
      payment: { updateMany: jest.fn<AnyAsyncFn>() },
      refund: {
        findFirst: jest.fn<AnyAsyncFn>(),
        findUnique: jest.fn<AnyAsyncFn>(),
        create: jest.fn<AnyAsyncFn>(),
        updateMany: jest.fn<AnyAsyncFn>(),
      },
      refundItem: { findMany: jest.fn<AnyAsyncFn>() },
      fundAccount: { findFirst: jest.fn<AnyAsyncFn>() },
    };
    TX = {
      order: { findUnique: jest.fn<AnyAsyncFn>(), updateMany: jest.fn<AnyAsyncFn>() },
      orderItem: { updateMany: jest.fn<AnyAsyncFn>() },
      orderStatusLog: { create: jest.fn<AnyAsyncFn>() },
      payment: { updateMany: jest.fn<AnyAsyncFn>() },
      refund: { findUnique: jest.fn<AnyAsyncFn>(), updateMany: jest.fn<AnyAsyncFn>() },
      refundItem: { findMany: jest.fn<AnyAsyncFn>() },
      fundAccount: { findFirst: jest.fn<AnyAsyncFn>() },
    };
    stockService = { refundReturn: jest.fn<AnyAsyncFn>() };
    fundService = {
      credit: jest.fn<AnyAsyncFn>(),
      debit: jest.fn<AnyAsyncFn>(),
      getOrCreateAccount: jest.fn<AnyAsyncFn>(),
    };

    (withTransaction as unknown as jest.Mock<AnyAsyncFn>).mockImplementation(
      async (fn: AnyAsyncFn) => fn(TX),
    );

    (IdGenerator.refundNo as unknown as jest.Mock<() => string>).mockReturnValue(REFUND_NO);
    (IdGenerator.txGroupNo as unknown as jest.Mock<() => string>).mockReturnValue(TX_GROUP_NO);

    // ---- apply 默认链路 ----
    OUTER.order.findFirst.mockResolvedValue(makeOrder());
    OUTER.refund.findFirst.mockResolvedValue(null); // 无进行中退款单
    OUTER.refund.create.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
      refundNo: args.data.refundNo,
      status: args.data.status,
    }));

    // ---- audit 默认链路 ----
    OUTER.refund.findUnique.mockResolvedValue(makeRefund({ status: RefundStatus.PENDING }));
    TX.refund.updateMany.mockResolvedValue({ count: 1 });
    TX.order.findUnique.mockResolvedValue(makeOrder());
    TX.orderStatusLog.create.mockResolvedValue({ id: 1n });

    // ---- execute 默认链路 ----
    TX.refund.updateMany.mockResolvedValue({ count: 1 });
    TX.refund.findUnique.mockResolvedValue(makeRefund());
    TX.order.findUnique.mockResolvedValue(makeOrder());
    TX.order.updateMany.mockResolvedValue({ count: 1 });
    TX.refundItem.findMany.mockResolvedValue([
      { id: 6001n, orderItemId: 7001n, skuId: 101n, quantity: 1, amount: 4000n },
      { id: 6002n, orderItemId: 7002n, skuId: 100n, quantity: 2, amount: 6000n },
    ]);
    TX.orderItem.updateMany.mockResolvedValue({ count: 1 });
    TX.payment.updateMany.mockResolvedValue({ count: 1 });
    TX.fundAccount.findFirst.mockResolvedValue({ id: 3001n, accountNo: 'ACC_PLATFORM_CASH' });

    stockService.refundReturn.mockResolvedValue({ skuId: 101n });
    fundService.getOrCreateAccount.mockResolvedValue({
      id: 3002n,
      accountNo: 'ACC_USER_BALANCE_7',
      accountType: 'USER_BALANCE',
      status: 'ACTIVE',
      balance: 0n,
      frozenBalance: 0n,
      version: 0,
    });
    fundService.credit.mockResolvedValue({ txNo: 'FT-1', duplicated: false });
    fundService.debit.mockResolvedValue({ txNo: 'FT-3', duplicated: false });

    svc = new RefundService(
      OUTER as never,
      stockService as unknown as StockService,
      fundService as unknown as FundService,
    );
  });

  /** 发起一次整单退款申请（默认 10000 分 = 订单实付） */
  const applyFull = (overrides: Partial<{ amount: bigint; type: RefundType }> = {}) =>
    svc.apply(7n, {
      orderNo: 'SO20260910000000000001',
      type: overrides.type ?? RefundType.FULL,
      amount: overrides.amount ?? 10000n,
      reasonCode: 'QUALITY',
      reasonText: '质量问题',
    });

  // ==========================================================================
  // 1. apply —— 拒收路径（任一失败都不写库）
  // ==========================================================================

  it('订单不存在或不属于当前用户 → NotFoundError 31001，且不建单（越权探测也按不存在处理）', async () => {
    OUTER.order.findFirst.mockResolvedValue(null);

    await expect(applyFull()).rejects.toMatchObject({ code: ErrorCode.ORDER_NOT_FOUND });
    expect(OUTER.refund.create).not.toHaveBeenCalled();

    // 换个 userId 查同一订单 → 同样是「不存在」，绝不泄露订单是否存在
    const arg = OUTER.order.findFirst.mock.calls[0]?.[0] as { where: Record<string, unknown> };
    expect(arg.where).toEqual({ orderNo: 'SO20260910000000000001', userId: 7n });
  });

  it('订单状态不在 {PAID, SHIPPED, COMPLETED} → BusinessError 31002，且不建单', async () => {
    for (const status of [
      OrderStatus.PENDING_PAYMENT,
      OrderStatus.CANCELLED,
      OrderStatus.REFUNDING,
      OrderStatus.REFUNDED,
    ]) {
      OUTER.order.findFirst.mockResolvedValue(makeOrder({ status }));
      await expect(applyFull()).rejects.toMatchObject({ code: ErrorCode.ORDER_STATUS_INVALID });
    }
    expect(OUTER.refund.create).not.toHaveBeenCalled();
  });

  it('已完成但超过 7 天售后期 → BusinessError 31005，且不建单', async () => {
    OUTER.order.findFirst.mockResolvedValue(
      makeOrder({
        status: OrderStatus.COMPLETED,
        completedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
      }),
    );

    await expect(applyFull()).rejects.toMatchObject({ code: ErrorCode.ORDER_AFTER_SALE_EXPIRED });
    expect(OUTER.refund.create).not.toHaveBeenCalled();
  });

  it('已完成但仍在 7 天售后期内 → 允许申请（不抛错）', async () => {
    OUTER.order.findFirst.mockResolvedValue(
      makeOrder({
        status: OrderStatus.COMPLETED,
        completedAt: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000),
      }),
    );

    await expect(applyFull()).resolves.toEqual({ refundNo: REFUND_NO, status: 'PENDING' });
  });

  it('存在 PENDING / PROCESSING 的退款单 → ConflictError 41003，且不建单', async () => {
    OUTER.refund.findFirst.mockResolvedValue({ id: 5001n });

    await expect(applyFull()).rejects.toMatchObject({ code: ErrorCode.REFUND_IN_PROGRESS });
    expect(OUTER.refund.create).not.toHaveBeenCalled();

    // 查询必须带 orderId + 进行中状态集合
    const arg = OUTER.refund.findFirst.mock.calls[0]?.[0] as {
      where: { orderId: bigint; status: { in: string[] } };
    };
    expect(arg.where.orderId).toBe(9001n);
    expect(arg.where.status.in).toEqual(['PENDING', 'PROCESSING']);
  });

  it('退款金额 <= 0 → BusinessError（service 层纵深防御），且不建单', async () => {
    await expect(applyFull({ amount: 0n })).rejects.toMatchObject({
      code: ErrorCode.FIELD_FORMAT_INVALID,
    });
    await expect(applyFull({ amount: -1n })).rejects.toMatchObject({
      code: ErrorCode.FIELD_FORMAT_INVALID,
    });
    expect(OUTER.refund.create).not.toHaveBeenCalled();
  });

  it('退款金额超过可退金额（payAmount - refundedAmount）→ ConflictError 41002，且不建单', async () => {
    OUTER.order.findFirst.mockResolvedValue(makeOrder({ payAmount: 10000n, refundedAmount: 3000n }));

    // 可退 7000，申请 7001
    await expect(applyFull({ amount: 7001n })).rejects.toMatchObject({
      code: ErrorCode.REFUND_AMOUNT_EXCEEDED,
    });
    expect(OUTER.refund.create).not.toHaveBeenCalled();

    // 恰好 7000 属于边界内，必须放行
    await expect(applyFull({ amount: 7000n })).resolves.toBeTruthy();
  });

  // ==========================================================================
  // 2. apply —— 成功建单
  // ==========================================================================

  it('成功建单：refundNo 由 IdGenerator 生成、status=PENDING、退款去向由 payMethod 映射（BALANCE → BALANCE）', async () => {
    await expect(applyFull()).resolves.toEqual({ refundNo: REFUND_NO, status: 'PENDING' });

    expect(IdGenerator.refundNo).toHaveBeenCalledTimes(1);

    const arg = OUTER.refund.create.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(arg.data.refundNo).toBe(REFUND_NO);
    expect(arg.data.status).toBe(RefundStatus.PENDING);
    expect(arg.data.refundTo).toBe(RefundTarget.BALANCE);
    expect(arg.data.orderId).toBe(9001n);
    expect(arg.data.userId).toBe(7n);
    expect(arg.data.amount).toBe(10000n);
    expect(arg.data.type).toBe(RefundType.FULL);
  });

  it('渠道支付（ALIPAY / WECHAT / MOCK / 未回写支付方式）→ refundTo=CHANNEL，绝不落到余额', async () => {
    for (const payMethod of [
      PayChannel.ALIPAY,
      PayChannel.WECHAT,
      PayChannel.MOCK,
      PayChannel.BANKCARD,
      null,
    ]) {
      OUTER.refund.create.mockClear();
      OUTER.order.findFirst.mockResolvedValue(makeOrder({ payMethod }));

      await applyFull();

      const arg = OUTER.refund.create.mock.calls[0]?.[0] as { data: Record<string, unknown> };
      expect(arg.data.refundTo).toBe(RefundTarget.CHANNEL);
    }
  });

  // ==========================================================================
  // 3. audit —— 驳回 / 同意 / 拒收
  // ==========================================================================

  it('驳回：status=REJECTED + 审核信息 + 写订单轨迹（to=订单原状态），且订单状态一律不变', async () => {
    await svc.audit(99n, REFUND_NO, false, '凭证不足');

    const arg = TX.refund.updateMany.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    // 条件更新：refund_no + status=PENDING 双条件，这就是并发闸门
    expect(arg.where).toEqual({ refundNo: REFUND_NO, status: RefundStatus.PENDING });
    expect(arg.data.status).toBe(RefundStatus.REJECTED);
    expect(arg.data.auditBy).toBe(99n);
    expect(arg.data.rejectedReason).toBe('凭证不足');
    expect(arg.data.auditAt).toBeInstanceOf(Date);

    const log = TX.orderStatusLog.create.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(log.data.toStatus).toBe(OrderStatus.PAID); // 订单原状态，不是 REFUNDED
    expect(log.data.fromStatus).toBe(OrderStatus.PAID);
    expect(log.data.operatorType).toBe('ADMIN');
    expect(log.data.extra).toEqual({ refundNo: REFUND_NO });

    // 订单状态一律不变：任何分支都不允许改 orders
    expect(OUTER.order.updateMany).not.toHaveBeenCalled();
    expect(TX.order.updateMany).not.toHaveBeenCalled();
  });

  it('同意：status=PROCESSING + 审核信息，不写订单轨迹、不动订单状态', async () => {
    await svc.audit(99n, REFUND_NO, true, '同意退款');

    const arg = TX.refund.updateMany.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(arg.data.status).toBe(RefundStatus.PROCESSING);
    expect(arg.data.auditBy).toBe(99n);
    expect(arg.data.auditRemark).toBe('同意退款');
    expect(arg.data.auditAt).toBeInstanceOf(Date);

    expect(TX.orderStatusLog.create).not.toHaveBeenCalled();
    expect(TX.order.updateMany).not.toHaveBeenCalled();
    expect(OUTER.order.updateMany).not.toHaveBeenCalled();
  });

  it('退款单不存在 → NotFoundError 41001，不开事务', async () => {
    OUTER.refund.findUnique.mockResolvedValue(null);

    await expect(svc.audit(99n, 'SR-NOT-EXIST', true)).rejects.toMatchObject({
      code: ErrorCode.REFUND_NOT_FOUND,
    });
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it('退款单非 PENDING 状态 → ConflictError，不开事务', async () => {
    for (const status of [RefundStatus.PROCESSING, RefundStatus.SUCCESS, RefundStatus.REJECTED]) {
      OUTER.refund.findUnique.mockResolvedValue(makeRefund({ status }));
      await expect(svc.audit(99n, REFUND_NO, true)).rejects.toMatchObject({
        code: ErrorCode.REFUND_IN_PROGRESS,
      });
    }
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it('并发重复审核（条件更新 count=0）→ ConflictError，不写轨迹', async () => {
    TX.refund.updateMany.mockResolvedValue({ count: 0 });

    await expect(svc.audit(99n, REFUND_NO, true)).rejects.toMatchObject({
      code: ErrorCode.REFUND_IN_PROGRESS,
    });
    expect(TX.orderStatusLog.create).not.toHaveBeenCalled();
  });

  // ==========================================================================
  // 4. execute —— BALANCE 三条流水记账
  // ==========================================================================

  /** 取三条流水的入参（按调用顺序：credit、credit、debit） */
  const threePosts = (): FundPost[] => [
    fundService.credit.mock.calls[0]?.[0] as FundPost,
    fundService.credit.mock.calls[1]?.[0] as FundPost,
    fundService.debit.mock.calls[0]?.[0] as FundPost,
  ];

  it('BALANCE 退款写三条流水：金额恒等于退款单金额、方向顺序为 余额IN → 结转IN → 结转OUT', async () => {
    await svc.execute(REFUND_NO);

    expect(fundService.credit).toHaveBeenCalledTimes(2);
    expect(fundService.debit).toHaveBeenCalledTimes(1);

    const [balance, settleIn, settleOut] = threePosts();

    // ① 用户余额到账
    expect(balance.bizType).toBe('BALANCE_REFUND');
    expect(balance.accountId).toBe(3002n);
    expect(balance.amount).toBe(10000n);
    // ② 反向结转对-先：负债增
    expect(settleIn.bizType).toBe('LIABILITY_SETTLE_IN');
    expect(settleIn.accountId).toBe(3001n);
    expect(settleIn.amount).toBe(10000n);
    // ③ 反向结转对-后：收入减
    expect(settleOut.bizType).toBe('LIABILITY_SETTLE_OUT');
    expect(settleOut.accountId).toBe(3001n);
    expect(settleOut.amount).toBe(10000n);

    // 调用顺序：两次 credit 严格早于 debit（先 IN 后 OUT，中间态恒为 +N）
    const seq = [
      ...fundService.credit.mock.invocationCallOrder,
      ...fundService.debit.mock.invocationCallOrder,
    ];
    expect(seq).toEqual([...seq].sort((a, b) => a - b));
  });

  it('⚠️ isLiability 取值：BALANCE_REFUND=false、LIABILITY_SETTLE_IN=**true**、LIABILITY_SETTLE_OUT=**false**（退款是反向结转，与支付口径取反）', async () => {
    await svc.execute(REFUND_NO);

    const [balance, settleIn, settleOut] = threePosts();

    // 用户余额流水恒 false，不参与平台负债口径
    expect(balance.isLiability).toBe(false);
    // ⚠️ schema 注释写的是支付口径（IN=false）；退款是**反向**结转，这里必须是 true（负债增）
    expect(settleIn.isLiability).toBe(true);
    // ⚠️ schema 注释写的是支付口径（OUT=true）；退款是**反向**结转，这里必须是 false（收入减）
    expect(settleOut.isLiability).toBe(false);
  });

  it('三条流水共享同一 txGroupNo，且 counterparty 互指（平台现金 ↔ 用户余额）', async () => {
    await svc.execute(REFUND_NO);

    const [balance, settleIn, settleOut] = threePosts();

    expect(IdGenerator.txGroupNo).toHaveBeenCalledTimes(1);
    expect(balance.txGroupNo).toBe(TX_GROUP_NO);
    expect(settleIn.txGroupNo).toBe(TX_GROUP_NO);
    expect(settleOut.txGroupNo).toBe(TX_GROUP_NO);

    // 余额侧：账户=用户余额，对手方=平台现金
    expect(balance.accountId).toBe(3002n);
    expect(balance.counterpartyAccountId).toBe(3001n);
    expect(balance.counterpartyAccountNo).toBe('ACC_PLATFORM_CASH');
    // 平台侧两条：账户=平台现金，对手方=用户余额
    expect(settleIn.counterpartyAccountId).toBe(3002n);
    expect(settleIn.counterpartyAccountNo).toBe('ACC_USER_BALANCE_7');
    expect(settleOut.counterpartyAccountId).toBe(3002n);
    expect(settleOut.counterpartyAccountNo).toBe('ACC_USER_BALANCE_7');

    // 流水必须锚定订单号与退款单号，否则对账无法溯源
    expect(balance.refundNo).toBe(REFUND_NO);
    expect(balance.orderNo).toBe('SO20260910000000000001');
  });

  it('三条流水的 (bizType, idempotencyKey) 组合互不相同 —— 撞 uk_biz_idem 会被静默判为幂等命中，钱不入账且不报错', async () => {
    await svc.execute(REFUND_NO);

    const posts = threePosts();
    const keys = posts.map((p) => `${p.bizType}::${p.idempotencyKey ?? ''}`);

    expect(keys).toEqual([
      `BALANCE_REFUND::${REFUND_NO}`,
      `LIABILITY_SETTLE_IN::${REFUND_NO}`,
      `LIABILITY_SETTLE_OUT::${REFUND_NO}`,
    ]);
    // 唯一键 uk_biz_idem 是复合键 (biz_type, idempotency_key)：
    // 三条流水 bizType 各不相同，同用 refundNo 也不会互撞；组合必须唯一。
    expect(new Set(keys).size).toBe(3);
  });

  it('用户余额账户经 getOrCreateAccount 定位（且必须传 tx），平台现金账户不存在则抛错拒绝记账', async () => {
    await svc.execute(REFUND_NO);

    expect(fundService.getOrCreateAccount).toHaveBeenCalledTimes(1);
    const call = fundService.getOrCreateAccount.mock.calls[0] as unknown[];
    expect(call[0]).toBe(7n);
    expect(call[1]).toBe('USER_BALANCE');
    expect(call[2]).toBe(TX); // 漏传 tx = 记账跑独立连接，回滚时钱凭空多出来

    // 平台现金账户缺失 → 拒绝记账（绝不自动创建：那意味着用没对过账的账户退钱）
    TX.fundAccount.findFirst.mockResolvedValue(null);
    fundService.credit.mockClear();
    await expect(svc.execute(REFUND_NO)).rejects.toMatchObject({
      code: ErrorCode.FUND_RECORD_FAILED,
    });
    expect(fundService.credit).not.toHaveBeenCalled();
  });

  // ==========================================================================
  // 5. execute —— 事务红线：全部写操作走 tx，外部单例零调用
  // ==========================================================================

  it('execute 全部读写经 tx：外部 Prisma 单例的任何委托一次都不能被调用', async () => {
    await svc.execute(REFUND_NO);

    expect(OUTER.refund.updateMany).not.toHaveBeenCalled();
    expect(OUTER.refund.findUnique).not.toHaveBeenCalled();
    expect(OUTER.order.updateMany).not.toHaveBeenCalled();
    expect(OUTER.order.findUnique).not.toHaveBeenCalled();
    expect(OUTER.orderStatusLog.create).not.toHaveBeenCalled();
    expect(OUTER.payment.updateMany).not.toHaveBeenCalled();
    expect(OUTER.orderItem.updateMany).not.toHaveBeenCalled();
    expect(OUTER.refundItem.findMany).not.toHaveBeenCalled();
    expect(OUTER.fundAccount.findFirst).not.toHaveBeenCalled();

    // 对应地在 tx 上必须各发生一次（库存回仓 2 行 → orderItem.updateMany 2 次）
    expect(TX.refund.updateMany).toHaveBeenCalledTimes(1);
    expect(TX.order.updateMany).toHaveBeenCalledTimes(1);
    expect(TX.orderStatusLog.create).toHaveBeenCalledTimes(1);
    expect(TX.payment.updateMany).toHaveBeenCalledTimes(1);
    expect(TX.orderItem.updateMany).toHaveBeenCalledTimes(2);
    expect(TX.fundAccount.findFirst).toHaveBeenCalledTimes(1);

    // 库存回仓必须拿到 tx（漏传 → 回滚后货已回仓但钱没退 = 白送一件货）
    expect(stockService.refundReturn).toHaveBeenCalledTimes(2);
    for (const call of stockService.refundReturn.mock.calls) {
      expect(call[1]).toBe(TX);
    }
    // 按 sku_id 升序串行（防多订单并发死锁，F5.3）
    const skuSeq = stockService.refundReturn.mock.calls.map(
      (c) => (c[0] as { skuId: bigint }).skuId,
    );
    expect(skuSeq).toEqual([100n, 101n]);
  });

  it('订单推进：FULL 置 REFUNDED；PARTIAL 且累计未达实付则保持原状态', async () => {
    await svc.execute(REFUND_NO);
    const fullArg = TX.order.updateMany.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(fullArg.data.status).toBe(OrderStatus.REFUNDED);
    expect(TX.orderStatusLog.create.mock.calls[0]?.[0]).toMatchObject({
      data: { fromStatus: OrderStatus.PAID, toStatus: OrderStatus.REFUNDED },
    });

    // 部分退 3000 分：累计 3000 < 实付 10000 → 状态不动
    jest.clearAllMocks();
    (withTransaction as unknown as jest.Mock<AnyAsyncFn>).mockImplementation(
      async (fn: AnyAsyncFn) => fn(TX),
    );
    TX.refund.updateMany.mockResolvedValue({ count: 1 });
    TX.refund.findUnique.mockResolvedValue(
      makeRefund({ type: RefundType.PARTIAL, amount: 3000n }),
    );
    TX.order.findUnique.mockResolvedValue(makeOrder());
    TX.order.updateMany.mockResolvedValue({ count: 1 });
    TX.refundItem.findMany.mockResolvedValue([]);
    TX.payment.updateMany.mockResolvedValue({ count: 1 });
    TX.fundAccount.findFirst.mockResolvedValue({ id: 3001n, accountNo: 'ACC_PLATFORM_CASH' });
    fundService.getOrCreateAccount.mockResolvedValue({
      id: 3002n,
      accountNo: 'ACC_USER_BALANCE_7',
      accountType: 'USER_BALANCE',
      status: 'ACTIVE',
      balance: 0n,
      frozenBalance: 0n,
      version: 0,
    });
    fundService.credit.mockResolvedValue({ txNo: 'FT-1', duplicated: false });
    fundService.debit.mockResolvedValue({ txNo: 'FT-3', duplicated: false });

    await svc.execute(REFUND_NO);
    const partArg = TX.order.updateMany.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(partArg.data.status).toBeUndefined();
  });

  it('支付单 SUCCESS → REFUNDED（仅命中成功的支付单）', async () => {
    await svc.execute(REFUND_NO);

    const arg = TX.payment.updateMany.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(arg.where).toEqual({ orderId: 9001n, status: 'SUCCESS' });
    expect(arg.data.status).toBe('REFUNDED');
  });

  // ==========================================================================
  // 6. execute —— 并发 / 渠道 / 记账失败
  // ==========================================================================

  it('退款单并发（条件更新 count=0）→ 抛 41003，且不推进订单、不写轨迹、不记账、不回仓', async () => {
    TX.refund.updateMany.mockResolvedValue({ count: 0 });

    await expect(svc.execute(REFUND_NO)).rejects.toMatchObject({
      code: ErrorCode.REFUND_IN_PROGRESS,
    });

    expect(TX.order.updateMany).not.toHaveBeenCalled();
    expect(TX.orderStatusLog.create).not.toHaveBeenCalled();
    expect(TX.payment.updateMany).not.toHaveBeenCalled();
    expect(TX.orderItem.updateMany).not.toHaveBeenCalled();
    expect(TX.refundItem.findMany).not.toHaveBeenCalled();
    expect(TX.fundAccount.findFirst).not.toHaveBeenCalled();
    expect(stockService.refundReturn).not.toHaveBeenCalled();
    expect(fundService.credit).not.toHaveBeenCalled();
    expect(fundService.debit).not.toHaveBeenCalled();
    expect(fundService.getOrCreateAccount).not.toHaveBeenCalled();
  });

  it('CHANNEL 退款（一期无 PaymentAdapter）→ 抛 ExternalServiceError 41004，不记账且订单状态不变', async () => {
    TX.refund.findUnique.mockResolvedValue(makeRefund({ refundTo: RefundTarget.CHANNEL }));

    await expect(svc.execute(REFUND_NO)).rejects.toMatchObject({
      code: ErrorCode.REFUND_EXEC_FAILED,
    });

    // 绝不允许「钱没确认退成功就先把账记了」
    expect(TX.fundAccount.findFirst).not.toHaveBeenCalled();
    expect(fundService.getOrCreateAccount).not.toHaveBeenCalled();
    expect(fundService.credit).not.toHaveBeenCalled();
    expect(fundService.debit).not.toHaveBeenCalled();
    // 订单状态 / 支付单 / 库存一次都不许动（F9.2「订单状态不变」）
    expect(TX.order.updateMany).not.toHaveBeenCalled();
    expect(TX.orderStatusLog.create).not.toHaveBeenCalled();
    expect(TX.payment.updateMany).not.toHaveBeenCalled();
    expect(TX.orderItem.updateMany).not.toHaveBeenCalled();
    expect(stockService.refundReturn).not.toHaveBeenCalled();
  });

  it('第一条流水（余额 IN）抛错 → 向上传播，后续两条流水绝不执行', async () => {
    fundService.credit.mockRejectedValueOnce(new Error('BALANCE_REFUND 写入失败'));

    await expect(svc.execute(REFUND_NO)).rejects.toThrow('BALANCE_REFUND 写入失败');

    expect(fundService.credit).toHaveBeenCalledTimes(1);
    expect(fundService.debit).not.toHaveBeenCalled();
  });

  it('第二条流水（反向结转 IN）抛错 → 向上传播，第三条（结转 OUT）绝不执行', async () => {
    fundService.credit
      .mockResolvedValueOnce({ txNo: 'FT-1', duplicated: false })
      .mockRejectedValueOnce(new Error('LIABILITY_SETTLE_IN 写入失败'));

    await expect(svc.execute(REFUND_NO)).rejects.toThrow('LIABILITY_SETTLE_IN 写入失败');

    expect(fundService.credit).toHaveBeenCalledTimes(2);
    expect(fundService.debit).not.toHaveBeenCalled();
  });

  it('第三条流水（反向结转 OUT）抛错 → 向上传播（绝不能被吞掉变成「退款成功」）', async () => {
    fundService.debit.mockRejectedValueOnce(new Error('LIABILITY_SETTLE_OUT 写入失败'));

    await expect(svc.execute(REFUND_NO)).rejects.toThrow('LIABILITY_SETTLE_OUT 写入失败');

    expect(fundService.credit).toHaveBeenCalledTimes(2);
    expect(fundService.debit).toHaveBeenCalledTimes(1);
  });

  it('库存回仓抛错 → 向上传播，记账绝不执行（先回仓后记账的顺序不能被吞异常破坏）', async () => {
    stockService.refundReturn.mockRejectedValue(new Error('库存回仓失败'));

    await expect(svc.execute(REFUND_NO)).rejects.toThrow('库存回仓失败');

    expect(TX.payment.updateMany).not.toHaveBeenCalled();
    expect(fundService.credit).not.toHaveBeenCalled();
    expect(fundService.debit).not.toHaveBeenCalled();
  });
});
