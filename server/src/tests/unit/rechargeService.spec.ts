/**
 * @file server/src/tests/unit/rechargeService.spec.ts
 * @description 充值单服务 + 余额入参校验单测：两表同事务 / F14.2 红线（余额不可用于充值）/
 * 金额校验 / 过期时间 / P2002 重试
 * @module tests/unit
 * @see server/src/services/RechargeService.ts、docs/04-flows.md F14.1 / F14.2
 * @see prisma/schema.prisma:958（RechargeOrder）、:859（Payment）
 * @see src/tests/unit/fundService.spec.ts（withTransaction 接管 + AnyAsyncFn 打桩模式）
 * @author 软件开发团队
 * @created 2026-09-09
 *
 * 为什么必须有单测：环境无 MySQL / Redis，而「充值单 + 支付单两表同事务」写错就是
 * 半张充值单的脏数据（渠道回调无从推进）；「余额不可用于充值」是 F14.2 红线，
 * validator 漏挡就是绕过充值限额的资损口子。这些规则 tsc 完全查不出来。
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PayChannel, PayStatus, PaymentBizType, Prisma, RechargeStatus } from '@prisma/client';
import { ErrorCode } from '@/core/errors/errorCodes';
import { withTransaction } from '@/core/transaction';
import { RechargeService } from '@/services/RechargeService';
import { listTransactionsQuerySchema, rechargeSchema } from '@/validators/balance.validator';

// config 在模块加载时即校验环境变量并可能 process.exit；测试环境没有 .env，注入固定值
jest.mock('@/config', () => ({
  config: {
    env: 'test',
    redis: { keyPrefix: 'shop' },
    // logger 在 import 时即读 config.log.level 建 winston 实例，缺了会让整个套件起不来
    log: { level: 'error', dir: '' },
  },
  isProduction: false,
  isTest: true,
  isDevelopment: false,
}));

// 单例在模块加载时会调用 getPrisma()，用假实现避免建真实客户端
jest.mock('@/core/prisma', () => ({
  getPrisma: jest.fn(() => ({})),
}));

// 事务在这里被接管：由测试决定「执行闭包并传入假 tx」还是「直接抛错」
jest.mock('@/core/transaction', () => ({
  withTransaction: jest.fn(),
}));

/**
 * 打桩函数类型。
 *
 * @description 这里必须用 `any` 而非 `unknown`：`@jest/globals` 会把 `Promise<unknown>`
 * 的解析类型推导成 `never`，导致 `mockResolvedValue(...)` 报 TS2345。打桩是通行例外。
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyAsyncFn = (...args: any[]) => Promise<any>;
/* eslint-enable @typescript-eslint/no-explicit-any */

/** 事务闭包的假 tx（RechargeService 在事务内一律通过 tx.xxx 写库） */
let FAKE_TX: Record<string, unknown>;

/** 假客户端里 rechargeOrder / payment 两个委托的形状 */
interface Delegates {
  rechargeOrder: {
    create: jest.Mock<AnyAsyncFn>;
  };
  payment: {
    create: jest.Mock<AnyAsyncFn>;
  };
}

/** 构造一套独立的假委托（默认 client 与假 tx 各一套，互不共享） */
function makeDelegates(): Delegates {
  return {
    rechargeOrder: {
      create: jest.fn<AnyAsyncFn>(),
    },
    payment: {
      create: jest.fn<AnyAsyncFn>(),
    },
  };
}

/** 构造 Prisma P2002 唯一键冲突异常 */
function uniqueViolation(): unknown {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

describe('RechargeService 创建充值单', () => {
  /** 假 tx 的委托 */
  let txClient: Delegates;
  /** 被测试对象（无状态服务，测试缝隙为 withTransaction mock） */
  let svc: RechargeService;

  beforeEach(() => {
    jest.clearAllMocks();

    txClient = makeDelegates();

    FAKE_TX = {
      __fakeTx: true,
      rechargeOrder: txClient.rechargeOrder,
      payment: txClient.payment,
    };

    (withTransaction as unknown as jest.Mock<AnyAsyncFn>).mockImplementation(async (fn) =>
      fn(FAKE_TX),
    );

    txClient.rechargeOrder.create.mockResolvedValue({ id: 501n });
    txClient.payment.create.mockResolvedValue({ id: 601n });

    svc = new RechargeService();
  });

  it('两表同事务写入：withTransaction 被调，充值单/支付单字段全对，默认 client 未被使用', async () => {
    const r = await svc.create(1n, { amount: 10_000n, payMethod: 'ALIPAY' });

    expect(withTransaction).toHaveBeenCalledTimes(1);

    const roArg = txClient.rechargeOrder.create.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    const payArg = txClient.payment.create.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };

    // 充值单：F14.2 —— payAmount = amount（不参与优惠）、PENDING、渠道对应、过期时间有值
    expect(roArg.data.rechargeNo).toMatch(/^RC/);
    expect(roArg.data.userId).toBe(1n);
    expect(roArg.data.amount).toBe(10_000n);
    expect(roArg.data.payAmount).toBe(10_000n);
    expect(roArg.data.status).toBe(RechargeStatus.PENDING);
    expect(roArg.data.channel).toBe(PayChannel.ALIPAY);
    expect(roArg.data.expireAt).toBeInstanceOf(Date);

    // 支付单：bizType=RECHARGE、bizNo=充值单号、rechargeId=刚创建的充值单 ID、过期时间与充值单一致
    expect(payArg.data.bizType).toBe(PaymentBizType.RECHARGE);
    expect(payArg.data.bizNo).toBe(roArg.data.rechargeNo);
    expect(payArg.data.rechargeId).toBe(501n);
    expect(payArg.data.paymentNo).toMatch(/^PAY/);
    expect(payArg.data.amount).toBe(10_000n);
    expect(payArg.data.channel).toBe(PayChannel.ALIPAY);
    expect(payArg.data.status).toBe(PayStatus.PENDING);
    expect(payArg.data.expireAt).toBe(roArg.data.expireAt);

    // 返回结构：payUrl 为 mock 收银台占位，携带支付单号
    expect(r.rechargeNo).toBe(roArg.data.rechargeNo);
    expect(r.paymentNo).toBe(payArg.data.paymentNo);
    expect(r.payUrl).toBe(`/mock-pay?paymentNo=${r.paymentNo}`);
    expect(r.amount).toBe(10_000n);
    expect(r.expireAt).toBe(roArg.data.expireAt);
  });

  it('payMethod=WECHAT / BANKCARD：两表 channel 映射一致', async () => {
    await svc.create(1n, { amount: 5_000n, payMethod: 'WECHAT' });
    await svc.create(1n, { amount: 5_000n, payMethod: 'BANKCARD' });

    const roChannels = txClient.rechargeOrder.create.mock.calls.map(
      (call) => (call[0] as { data: { channel: string } }).data.channel,
    );
    const payChannels = txClient.payment.create.mock.calls.map(
      (call) => (call[0] as { data: { channel: string } }).data.channel,
    );
    expect(roChannels).toEqual([PayChannel.WECHAT, PayChannel.BANKCARD]);
    expect(payChannels).toEqual([PayChannel.WECHAT, PayChannel.BANKCARD]);
  });

  it('expireAt = 创建时刻 + 30 分钟（与订单关单口径一致，F14.2）', async () => {
    const before = Date.now();
    const r = await svc.create(1n, { amount: 5_000n, payMethod: 'ALIPAY' });
    const after = Date.now();
    const thirtyMinutes = 30 * 60 * 1000;

    expect(r.expireAt.getTime()).toBeGreaterThanOrEqual(before + thirtyMinutes);
    expect(r.expireAt.getTime()).toBeLessThanOrEqual(after + thirtyMinutes);
  });

  it('P2002（单号碰撞）→ 重新生成单号整单重试一次并成功', async () => {
    txClient.rechargeOrder.create
      .mockRejectedValueOnce(uniqueViolation())
      .mockResolvedValueOnce({ id: 502n });

    const r = await svc.create(1n, { amount: 5_000n, payMethod: 'ALIPAY' });

    // 两次尝试：第一次撞唯一键（在充值单写入处中止），第二次成功
    expect(withTransaction).toHaveBeenCalledTimes(2);
    expect(txClient.rechargeOrder.create).toHaveBeenCalledTimes(2);
    // 第一次在充值单写入即中止 → 支付单只在成功的第二次写入一次（同事务回滚语义）
    expect(txClient.payment.create).toHaveBeenCalledTimes(1);

    // 两次充值单号必须不同（重新生成，而不是复用撞车的单号）
    const ro1 = (txClient.rechargeOrder.create.mock.calls[0]?.[0] as { data: { rechargeNo: string } }).data;
    const ro2 = (txClient.rechargeOrder.create.mock.calls[1]?.[0] as { data: { rechargeNo: string } }).data;
    expect(ro1.rechargeNo).not.toBe(ro2.rechargeNo);

    // 返回的是第二次（成功）的充值单，支付单关联新充值单（bizNo / rechargeId 对齐第二次）
    expect(r.rechargeNo).toBe(ro2.rechargeNo);
    const pay = (txClient.payment.create.mock.calls[0]?.[0] as {
      data: { paymentNo: string; bizNo: string; rechargeId: bigint };
    }).data;
    expect(pay.bizNo).toBe(ro2.rechargeNo);
    expect(pay.rechargeId).toBe(502n);
    expect(r.paymentNo).toBe(pay.paymentNo);
  });

  it('连续两次 P2002 → 只重试一次后抛出（不无限重试）', async () => {
    txClient.rechargeOrder.create.mockRejectedValue(uniqueViolation());

    await expect(svc.create(1n, { amount: 5_000n, payMethod: 'ALIPAY' })).rejects.toMatchObject({
      code: 'P2002',
    });

    expect(withTransaction).toHaveBeenCalledTimes(2); // 首次 + 1 次重试
    expect(txClient.rechargeOrder.create).toHaveBeenCalledTimes(2);
  });

  it('amount ≤ 0（service 级双保险）→ 抛 61004，不开事务、不写任何表', async () => {
    await expect(svc.create(1n, { amount: 0n, payMethod: 'ALIPAY' })).rejects.toMatchObject({
      code: ErrorCode.RECHARGE_AMOUNT_INVALID,
    });
    await expect(svc.create(1n, { amount: -100n, payMethod: 'ALIPAY' })).rejects.toMatchObject({
      code: ErrorCode.RECHARGE_AMOUNT_INVALID,
    });

    expect(withTransaction).not.toHaveBeenCalled();
    expect(txClient.rechargeOrder.create).not.toHaveBeenCalled();
    expect(txClient.payment.create).not.toHaveBeenCalled();
  });

  it('payMethod=BALANCE（service 级纵深防御，模拟绕过 validator 的内部调用）→ 抛 90002，不开事务、不写任何表', async () => {
    // 'BALANCE' 不在 RechargePayMethod 类型内，as never 模拟「绕过 HTTP validator 的调用方」
    await expect(
      svc.create(1n, { amount: 1000n, payMethod: 'BALANCE' as never }),
    ).rejects.toMatchObject({
      code: ErrorCode.FIELD_FORMAT_INVALID,
    });

    // 变异测试 M2 证明：validator 白名单是唯一防线时单点脆弱，service 必须双保险（与金额同款）
    expect(withTransaction).not.toHaveBeenCalled();
    expect(txClient.rechargeOrder.create).not.toHaveBeenCalled();
    expect(txClient.payment.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 入参校验（validator 级）：F14.2 红线 + 金额格式 + 分页
// ---------------------------------------------------------------------------

describe('balance.validator 充值入参', () => {
  it('F14.2 红线：payMethod=BALANCE / MOCK 被拒，仅三外部渠道通过', () => {
    expect(rechargeSchema.safeParse({ amount: '1000', payMethod: 'BALANCE' }).success).toBe(false);
    expect(rechargeSchema.safeParse({ amount: '1000', payMethod: 'MOCK' }).success).toBe(false);

    for (const m of ['ALIPAY', 'WECHAT', 'BANKCARD']) {
      const parsed = rechargeSchema.safeParse({ amount: '1000', payMethod: m });
      expect(parsed.success).toBe(true);
    }
  });

  it('amount 校验：小数 / 0 / 负数 / 非数字被拒；合法值转为 bigint（分）', () => {
    expect(rechargeSchema.safeParse({ amount: '100.5', payMethod: 'ALIPAY' }).success).toBe(false);
    expect(rechargeSchema.safeParse({ amount: '0', payMethod: 'ALIPAY' }).success).toBe(false);
    expect(rechargeSchema.safeParse({ amount: '-5', payMethod: 'ALIPAY' }).success).toBe(false);
    expect(rechargeSchema.safeParse({ amount: 'abc', payMethod: 'ALIPAY' }).success).toBe(false);

    const byString = rechargeSchema.parse({ amount: '1000', payMethod: 'ALIPAY' });
    expect(byString.amount).toBe(1000n);
    expect(typeof byString.amount).toBe('bigint');

    // number 形式同样收（前端可能直接传数字分值）
    const byNumber = rechargeSchema.parse({ amount: 1000, payMethod: 'ALIPAY' });
    expect(byNumber.amount).toBe(1000n);
  });

  it('strict：未知字段一律拒绝（充值单与分页 query 均如此）', () => {
    expect(
      rechargeSchema.safeParse({ amount: '1000', payMethod: 'ALIPAY', channelTradeNo: 'x' }).success,
    ).toBe(false);
    expect(listTransactionsQuerySchema.safeParse({ page: 1, orderBy: 'amount' }).success).toBe(false);
  });
});

describe('balance.validator 流水分页 query', () => {
  it('默认值：不传 page / pageSize 时为 { page: 1, pageSize: 20 }', () => {
    expect(listTransactionsQuerySchema.parse({})).toEqual({ page: 1, pageSize: 20 });
  });

  it('边界：pageSize 上限 50（51 拒、50 过）、page 从 1 起（0 拒）、字符串被 coerce 成 number', () => {
    expect(listTransactionsQuerySchema.safeParse({ pageSize: 51 }).success).toBe(false);
    expect(listTransactionsQuerySchema.safeParse({ pageSize: 50 }).success).toBe(true);
    expect(listTransactionsQuerySchema.safeParse({ page: 0 }).success).toBe(false);

    const coerced = listTransactionsQuerySchema.parse({ page: '3', pageSize: '15' });
    expect(coerced).toEqual({ page: 3, pageSize: 15 });
    expect(typeof coerced.page).toBe('number');
  });
});
