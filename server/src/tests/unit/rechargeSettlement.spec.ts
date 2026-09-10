/**
 * @file server/src/tests/unit/rechargeSettlement.spec.ts
 * @description QA 独立验证补充：充值入账（F14.1 ② 事务 I）的边界加固用例
 * @module tests/unit
 * @see server/src/services/PaymentService.ts（settleRecharge）、docs/04-flows.md F14.1 ②
 * @author QA（software-qa-engineer）
 * @created 2026-09-09
 *
 * 为什么单独一份、而不是往 paymentService.spec.ts 里加：
 * 既有 `paymentService.spec.ts` 的 `FAKE_TX.xxx` **与构造注入的 `prisma.xxx` 是同一个 mock 对象**，
 * 因此「写操作走的是 tx，还是误走了外部 Prisma 单例」在断言层面**无法区分**。
 * 而「漏传 tx」正是本批最致命的回归方向（记账跑独立连接 → 事务回滚时钱凭空多出来）。
 * 本套件刻意让 **tx 委托与外部单例委托是两组独立的 jest.fn()**，于是可以断言：
 *   `外部单例.rechargeOrder.updateMany` 一次都没被调用，`tx.rechargeOrder.updateMany` 被调用。
 * 这是既有两个套件都做不到的检查。
 *
 * 覆盖实现者自测未覆盖的边界：
 * 1. 双流水 `(bizType, idempotencyKey)` 组合唯一 —— 撞 `uk_biz_idem` 会被 FundService 判为
 *    「幂等命中」并**静默跳过加余额**（钱不进账、不报错），这是充值侧最隐蔽的一类资损；
 * 2. 充值流水不得携带 `orderNo`（否则对账会把充值算进订单维度）；
 * 3. 全部写操作必须经 tx（外部单例零调用）；
 * 4. 充值支付单的金额不符 / CLOSED / FAILED / 并发抢占四条拒收路径；
 * 5. 记账任一环节抛错必须**向上传播**（绝不能被吞掉变成"入账成功"）；
 * 6. 充值单推进只改状态/时间/支付单号，绝不回写金额；两条流水 counterparty 互指。
 *
 * 边界说明：**真实回滚行为由 MySQL 事务保证，单元层无法验证**。本套件验证的是
 * 「写操作是否都在同一个事务闭包内」+「失败是否向上传播」，DB 层回滚待集成测试验证。
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PayChannel, PayStatus } from '@prisma/client';
import { ErrorCode } from '@/core/errors/errorCodes';
import { withTransaction } from '@/core/transaction';
import type { FundService } from '@/services/FundService';
import { PaymentService } from '@/services/PaymentService';
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

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyAsyncFn = (...args: any[]) => Promise<any>;
/* eslint-enable @typescript-eslint/no-explicit-any */

/** 充值支付单（`orderId = null`、`bizNo` = 充值单号、走外部渠道） */
function makeRechargePayment(overrides: Record<string, unknown> = {}) {
  return {
    paymentNo: 'PAY-RC-0001',
    orderId: null,
    rechargeId: 5001n,
    userId: 7n,
    orderNo: null,
    bizNo: 'RC20260910000001777777',
    amount: 5000n,
    status: PayStatus.PENDING,
    payUrl: '/mock-pay?paymentNo=PAY-RC-0001',
    expireAt: new Date(Date.now() + 30 * 60_000),
    channel: PayChannel.ALIPAY,
    ...overrides,
  };
}

describe('充值入账（事务 I）边界加固', () => {
  /**
   * 外部 Prisma 单例的委托（**只允许只读查询走它**）。
   *
   * @description 关键：它与 {@link TX} 是两组独立 mock，任何写操作误走外部单例都会被断言抓住。
   */
  let OUTER: {
    payment: { findUnique: jest.Mock<AnyAsyncFn>; updateMany: jest.Mock<AnyAsyncFn> };
    rechargeOrder: { updateMany: jest.Mock<AnyAsyncFn> };
    fundAccount: { findFirst: jest.Mock<AnyAsyncFn> };
    order: { updateMany: jest.Mock<AnyAsyncFn> };
    orderStatusLog: { create: jest.Mock<AnyAsyncFn> };
  };
  /** 事务闭包内的委托（**所有写操作必须走它**） */
  let TX: {
    payment: { updateMany: jest.Mock<AnyAsyncFn> };
    rechargeOrder: { updateMany: jest.Mock<AnyAsyncFn> };
    fundAccount: { findFirst: jest.Mock<AnyAsyncFn> };
    order: { updateMany: jest.Mock<AnyAsyncFn> };
    orderItem: { findMany: jest.Mock<AnyAsyncFn> };
    orderStatusLog: { create: jest.Mock<AnyAsyncFn> };
  };
  let stockService: { confirm: jest.Mock<AnyAsyncFn> };
  let fundService: { credit: jest.Mock<AnyAsyncFn>; getOrCreateAccount: jest.Mock<AnyAsyncFn> };
  let svc: PaymentService;

  beforeEach(() => {
    jest.clearAllMocks();

    OUTER = {
      // 注意：这里刻意**不给** updateMany 设默认返回值。
      // 它属于"绝不该被调用"的写操作委托，一旦被测代码误走外部单例，
      // 断言 not.toHaveBeenCalled() 会先于返回值问题把问题暴露出来。
      payment: { findUnique: jest.fn<AnyAsyncFn>(), updateMany: jest.fn<AnyAsyncFn>() },
      rechargeOrder: { updateMany: jest.fn<AnyAsyncFn>() },
      fundAccount: { findFirst: jest.fn<AnyAsyncFn>() },
      order: { updateMany: jest.fn<AnyAsyncFn>() },
      orderStatusLog: { create: jest.fn<AnyAsyncFn>() },
    };
    TX = {
      payment: { updateMany: jest.fn<AnyAsyncFn>() },
      rechargeOrder: { updateMany: jest.fn<AnyAsyncFn>() },
      fundAccount: { findFirst: jest.fn<AnyAsyncFn>() },
      order: { updateMany: jest.fn<AnyAsyncFn>() },
      orderItem: { findMany: jest.fn<AnyAsyncFn>() },
      orderStatusLog: { create: jest.fn<AnyAsyncFn>() },
    };
    stockService = { confirm: jest.fn<AnyAsyncFn>() };
    fundService = { credit: jest.fn<AnyAsyncFn>(), getOrCreateAccount: jest.fn<AnyAsyncFn>() };

    (withTransaction as unknown as jest.Mock<AnyAsyncFn>).mockImplementation(async (fn: AnyAsyncFn) =>
      fn(TX),
    );

    OUTER.payment.findUnique.mockResolvedValue(makeRechargePayment());
    TX.payment.updateMany.mockResolvedValue({ count: 1 });
    TX.rechargeOrder.updateMany.mockResolvedValue({ count: 1 });
    TX.fundAccount.findFirst.mockResolvedValue({ id: 7001n, accountNo: 'ACC_PLATFORM_CASH' });

    fundService.getOrCreateAccount.mockResolvedValue({
      id: 8001n,
      accountNo: 'ACC_USER_BALANCE_7',
      accountType: 'USER_BALANCE',
      status: 'ACTIVE',
      balance: 0n,
      frozenBalance: 0n,
      version: 0,
    });
    fundService.credit.mockResolvedValue({ txNo: 'FT-1', duplicated: false });

    svc = new PaymentService(
      OUTER as never,
      stockService as unknown as StockService,
      fundService as unknown as FundService,
    );
  });

  /** 发起一次成功的充值回调（金额与支付单一致） */
  const notify = () =>
    svc.handlePaidNotify('PAY-RC-0001', { channelTradeNo: 'T-RC-1', amount: 5000n });

  // -------------------------------------------------------------------------
  // 1. 幂等键 / 流水维度
  // -------------------------------------------------------------------------

  it('双流水 (bizType, idempotencyKey) 组合必须互不相同 —— 撞 uk_biz_idem 会被静默判为幂等命中，钱不入账且无报错', async () => {
    await notify();

    const keys = fundService.credit.mock.calls.map((c) => {
      const a = c[0] as { bizType: string; idempotencyKey: string | null };
      return `${a.bizType}::${a.idempotencyKey ?? ''}`;
    });

    expect(keys).toHaveLength(2);
    // 两条流水各写一行 fund_transactions，唯一键是 (biz_type, idempotency_key)。
    // 组合一旦相同，第二条 INSERT 撞 P2002 → FundService.doPost 走 duplicated 分支
    // → **不更新余额、不抛错**：平台侧记了负债、用户余额却没加，且接口返回成功。
    expect(new Set(keys).size).toBe(2);
    // 两侧同键本身是设计（不同 bizType 才不会撞），这里把该前提显式钉住
    const idemKeys = fundService.credit.mock.calls.map(
      (c) => (c[0] as { idempotencyKey: string | null }).idempotencyKey,
    );
    expect(idemKeys).toEqual(['PAY-RC-0001', 'PAY-RC-0001']);
  });

  it('充值流水不得携带 orderNo（否则对账会把充值算进订单维度）', async () => {
    await notify();

    const orderNos = fundService.credit.mock.calls.map(
      (c) => (c[0] as { orderNo?: string | null }).orderNo ?? null,
    );
    expect(orderNos).toEqual([null, null]);
    // 两条流水都必须锚定充值单号，否则无法按 rechargeNo 反查
    const rechargeNos = fundService.credit.mock.calls.map(
      (c) => (c[0] as { rechargeNo?: string | null }).rechargeNo,
    );
    expect(rechargeNos).toEqual(['RC20260910000001777777', 'RC20260910000001777777']);
  });

  it('两条流水的 counterparty 必须互指（平台 ↔ 用户余额账户），且账户来自 getOrCreateAccount 而非硬编码', async () => {
    await notify();

    const platform = fundService.credit.mock.calls[0]?.[0] as {
      accountId: bigint;
      counterpartyAccountId?: bigint | null;
      counterpartyAccountNo?: string | null;
    };
    const user = fundService.credit.mock.calls[1]?.[0] as {
      accountId: bigint;
      counterpartyAccountId?: bigint | null;
      counterpartyAccountNo?: string | null;
    };

    expect(platform.accountId).toBe(7001n); // 查出来的平台现金账户
    expect(platform.counterpartyAccountId).toBe(8001n);
    expect(platform.counterpartyAccountNo).toBe('ACC_USER_BALANCE_7');
    expect(user.accountId).toBe(8001n);
    expect(user.counterpartyAccountId).toBe(7001n);
    expect(user.counterpartyAccountNo).toBe('ACC_PLATFORM_CASH');
  });

  // -------------------------------------------------------------------------
  // 2. 事务红线（外部单例零调用）——既有套件做不到的检查
  // -------------------------------------------------------------------------

  it('充值路径全部写操作必须经 tx：外部 Prisma 单例的 rechargeOrder / fundAccount / payment 一次都不能被直接调用', async () => {
    await notify();

    // 这三个都是写操作，走外部单例 = 记账跑独立连接，事务回滚时账已经记了（钱凭空多出来）
    expect(OUTER.rechargeOrder.updateMany).not.toHaveBeenCalled();
    expect(OUTER.fundAccount.findFirst).not.toHaveBeenCalled();
    expect(OUTER.payment.updateMany).not.toHaveBeenCalled();

    // 对应地在 tx 上必须各发生一次
    expect(TX.rechargeOrder.updateMany).toHaveBeenCalledTimes(1);
    expect(TX.fundAccount.findFirst).toHaveBeenCalledTimes(1);
    expect(TX.payment.updateMany).toHaveBeenCalledTimes(1);

    // 唯一的只读查询（定位支付单）才允许走外部单例
    expect(OUTER.payment.findUnique).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // 3. 充值支付单的四条拒收路径
  // -------------------------------------------------------------------------

  it('充值回调金额不符 → 不推进充值单、不记账、不开事务（支付单保持 PENDING 等真实回调）', async () => {
    await expect(
      svc.handlePaidNotify('PAY-RC-0001', { channelTradeNo: 'T-RC-1', amount: 1n }),
    ).rejects.toMatchObject({ code: ErrorCode.PAYMENT_AMOUNT_MISMATCH });

    expect(withTransaction).not.toHaveBeenCalled();
    expect(TX.rechargeOrder.updateMany).not.toHaveBeenCalled();
    expect(fundService.credit).not.toHaveBeenCalled();
    expect(fundService.getOrCreateAccount).not.toHaveBeenCalled();
  });

  it('充值支付单已 CLOSED / FAILED（迟到或伪造回调）→ 不推进充值单、不记账', async () => {
    OUTER.payment.findUnique.mockResolvedValue(makeRechargePayment({ status: PayStatus.CLOSED }));
    await expect(notify()).rejects.toMatchObject({ code: ErrorCode.PAYMENT_CLOSED });

    OUTER.payment.findUnique.mockResolvedValue(makeRechargePayment({ status: PayStatus.FAILED }));
    await expect(notify()).rejects.toMatchObject({ code: ErrorCode.PAYMENT_FINAL_STATE });

    expect(withTransaction).not.toHaveBeenCalled();
    expect(TX.rechargeOrder.updateMany).not.toHaveBeenCalled();
    expect(fundService.credit).not.toHaveBeenCalled();
  });

  it('并发回调抢先（支付单条件更新 count=0）→ 充值单不推进、不记账', async () => {
    TX.payment.updateMany.mockResolvedValue({ count: 0 });

    await expect(notify()).resolves.toBeUndefined();

    expect(TX.rechargeOrder.updateMany).not.toHaveBeenCalled();
    expect(fundService.getOrCreateAccount).not.toHaveBeenCalled();
    expect(fundService.credit).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 4. 记账失败必须向上传播（单元层边界：写操作都在闭包内 + 失败不吞）
  // -------------------------------------------------------------------------

  it('用户余额账户开户抛错 → 异常向上传播（整笔回滚），绝不静默吞掉', async () => {
    fundService.getOrCreateAccount.mockRejectedValue(new Error('uk_user_account 冲突且重读失败'));

    await expect(notify()).rejects.toThrow('uk_user_account 冲突且重读失败');

    // 充值单推进已在同一事务闭包内执行，抛错后由 DB 整体回滚（单元层只能验到「同在闭包内」）
    expect(TX.rechargeOrder.updateMany).toHaveBeenCalledTimes(1);
    expect(fundService.credit).not.toHaveBeenCalled();
  });

  it('第一次 credit（平台负债侧）抛错 → 异常向上传播，第二次 credit 不得执行', async () => {
    fundService.credit.mockRejectedValueOnce(new Error('PLATFORM_RECHARGE_IN 写入失败'));

    await expect(notify()).rejects.toThrow('PLATFORM_RECHARGE_IN 写入失败');

    expect(fundService.credit).toHaveBeenCalledTimes(1); // 只尝试了第一次
  });

  it('第二次 credit（用户余额侧）抛错 → 异常向上传播（绝不能被吞掉变成「入账成功」）', async () => {
    fundService.credit
      .mockResolvedValueOnce({ txNo: 'FT-1', duplicated: false })
      .mockRejectedValueOnce(new Error('BALANCE_RECHARGE 写入失败'));

    await expect(notify()).rejects.toThrow('BALANCE_RECHARGE 写入失败');
    expect(fundService.credit).toHaveBeenCalledTimes(2);
  });

  it('充值路径异常时绝不影响订单域（订单推进 / 轨迹 / 库存 confirm 全程零调用）', async () => {
    fundService.credit.mockRejectedValue(new Error('记账失败'));

    await expect(notify()).rejects.toThrow('记账失败');

    expect(OUTER.order.updateMany).not.toHaveBeenCalled();
    expect(TX.order.updateMany).not.toHaveBeenCalled();
    expect(OUTER.orderStatusLog.create).not.toHaveBeenCalled();
    expect(TX.orderStatusLog.create).not.toHaveBeenCalled();
    expect(TX.orderItem.findMany).not.toHaveBeenCalled();
    expect(stockService.confirm).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 5. 充值单推进的字段面
  // -------------------------------------------------------------------------

  it('充值单推进只改 status / paidAt / paymentNo，绝不回写金额（金额只由支付单权威决定）', async () => {
    await notify();

    const arg = TX.rechargeOrder.updateMany.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    // 白名单式断言：多写一个字段就红（防止有人顺手把 amount/giftAmount 也回写进来）
    expect(Object.keys(arg.data).sort()).toEqual(['paidAt', 'paymentNo', 'status']);
    expect(arg.data.status).toBe('SUCCESS');
    expect(arg.data.paymentNo).toBe('PAY-RC-0001');
    expect(arg.data.paidAt).toBeInstanceOf(Date);
  });

  it('记账金额恒取支付单 amount：支付单 12345 分时两条流水都是 12345n（bigint），与回调入参无关', async () => {
    OUTER.payment.findUnique.mockResolvedValue(makeRechargePayment({ amount: 12345n }));

    await svc.handlePaidNotify('PAY-RC-0001', { channelTradeNo: 'T-RC-1', amount: 12345n });

    const amounts = fundService.credit.mock.calls.map((c) => (c[0] as { amount: unknown }).amount);
    expect(amounts).toEqual([12345n, 12345n]);
    expect(amounts.every((a) => typeof a === 'bigint')).toBe(true);
  });
});
