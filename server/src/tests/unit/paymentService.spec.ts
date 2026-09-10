/**
 * @file server/src/tests/unit/paymentService.spec.ts
 * @description 支付服务单测：发起支付（建单 / 越权 / 超时 / 幂等复用）与支付成功入账（事务 B）的不变量
 * @module tests/unit
 * @see server/src/services/PaymentService.ts、docs/04-flows.md F6（556 行起，重点 F6.3 / F6.4）
 * @see docs/01-PRD.md PAY-03（重复回调只入账一次 + 金额不符拒绝入账并告警）
 * @author 软件开发团队
 * @created 2026-09-07
 *
 * 为什么必须有单测：环境无 MySQL / Redis 实例，而支付是「钱、订单状态、库存」三者的交汇点。
 * 下面这些规则一旦写错就是资损事故，且 tsc 完全查不出来：
 * - 回调金额必须与支付单**严格相等**，否则伪造回调可以 1 分钱买走一台手机；
 * - 重复回调只能入账一次（库存 confirm / 订单轨迹各一次）；
 * - 库存 confirm 必须拿到事务内的 `tx`，否则后续失败时 `frozen → sold` 退不回去；
 * - 多 SKU confirm 必须按 `sku_id` 升序，否则与下单冻结交叉加锁会死锁；
 * - 订单查询必须带 `userId`，否则是「替别人付款 / 看别人订单」的越权漏洞。
 *
 * 边界说明：**真实回滚行为由 MySQL 事务保证，单元层无法验证**。
 * 本套件验证的是「写操作是否放在事务闭包内、幂等分支是否提前返回、条件更新是否带 status」，
 * 这是单元层能且必须守住的边界；DB 层回滚待集成测试验证。
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { OrderStatus, PayChannel, PayStatus } from '@prisma/client';
import { ErrorCode } from '@/core/errors/errorCodes';
import { withTransaction } from '@/core/transaction';
import type { FundService } from '@/services/FundService';
import { PaymentService, type CreatePaymentInput } from '@/services/PaymentService';
import type { StockService } from '@/services/StockService';

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

// 事务在这里被接管：由测试决定「执行闭包并传入假 tx」还是「直接抛错模拟回滚」
jest.mock('@/core/transaction', () => ({
  withTransaction: jest.fn(),
}));

/**
 * 事务闭包的假 tx。
 *
 * @description `PaymentService` 在事务内一律通过 `tx.xxx` 写库（不是外部单例），
 * 所以假 tx 必须提供委托，且委托指向与构造注入同一批假实现，断言才能命中。
 * 在 `beforeEach` 里重建。
 */
let FAKE_TX: Record<string, unknown>;

/**
 * 打桩函数类型。
 *
 * @description 这里必须用 `any` 而非 `unknown`：`@jest/globals` 会把 `Promise<unknown>`
 * 的解析类型推导成 `never`，导致 `mockResolvedValue(...)` 报 TS2345。打桩是通行例外。
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyAsyncFn = (...args: any[]) => Promise<any>;
/* eslint-enable @typescript-eslint/no-explicit-any */

/** 假订单（字段对齐 Order 模型中本服务用到的部分） */
interface FakeOrder {
  id: bigint;
  orderNo: string;
  userId: bigint;
  status: OrderStatus;
  payAmount: bigint;
  expireAt: Date;
}

/** 假支付单（字段对齐 Payment 模型中本服务用到的部分） */
interface FakePayment {
  paymentNo: string;
  orderId: bigint | null;
  /** 关联充值单 ID（RECHARGE 场景必填；订单支付为 null） */
  rechargeId: bigint | null;
  /** 支付单归属用户（充值入账按它定位用户余额账户） */
  userId: bigint;
  orderNo: string | null;
  bizNo: string;
  amount: bigint;
  status: PayStatus;
  payUrl: string | null;
  expireAt: Date | null;
  channel: PayChannel;
}

/** 构造假订单（默认：待支付、未超时、应付 128.00 元） */
function makeOrder(overrides: Partial<FakeOrder> = {}): FakeOrder {
  return {
    id: 9001n,
    orderNo: 'SO20260907000001123456',
    userId: 1n,
    status: OrderStatus.PENDING_PAYMENT,
    payAmount: 12800n,
    expireAt: new Date(Date.now() + 30 * 60 * 1000),
    ...overrides,
  };
}

/** 构造假支付单（默认：待支付、MOCK 渠道、金额与订单一致） */
function makePayment(overrides: Partial<FakePayment> = {}): FakePayment {
  return {
    paymentNo: 'PAY20260907000001999999',
    orderId: 9001n,
    rechargeId: null,
    userId: 1n,
    orderNo: 'SO20260907000001123456',
    bizNo: 'SO20260907000001123456',
    amount: 12800n,
    status: PayStatus.PENDING,
    payUrl: '/payment/PAY20260907000001999999',
    expireAt: new Date(Date.now() + 30 * 60 * 1000),
    channel: PayChannel.MOCK,
    ...overrides,
  };
}

describe('PaymentService 支付（发起 + 入账事务 B）', () => {
  /** 假 Prisma：只实现 PaymentService 用到的委托 */
  let prisma: {
    order: { findFirst: jest.Mock<AnyAsyncFn>; updateMany: jest.Mock<AnyAsyncFn> };
    orderItem: { findMany: jest.Mock<AnyAsyncFn> };
    orderStatusLog: { create: jest.Mock<AnyAsyncFn> };
    payment: {
      create: jest.Mock<AnyAsyncFn>;
      findUnique: jest.Mock<AnyAsyncFn>;
      findMany: jest.Mock<AnyAsyncFn>;
      updateMany: jest.Mock<AnyAsyncFn>;
    };
    /** 入账时查平台现金账户用 */
    fundAccount: { findFirst: jest.Mock<AnyAsyncFn> };
    /** 充值入账推进充值单用（T070-C） */
    rechargeOrder: { updateMany: jest.Mock<AnyAsyncFn> };
  };
  /** 假库存服务 */
  let stockService: { confirm: jest.Mock<AnyAsyncFn> };
  /** 假资金服务（入账写 ORDER_PAY / 充值双流水） */
  let fundService: {
    credit: jest.Mock<AnyAsyncFn>;
    /** 充值入账按 userId 取（首充开户）用户余额账户 */
    getOrCreateAccount: jest.Mock<AnyAsyncFn>;
  };
  /** 被测试对象 */
  let svc: PaymentService;

  beforeEach(() => {
    jest.clearAllMocks();

    prisma = {
      order: {
        findFirst: jest.fn<AnyAsyncFn>(),
        updateMany: jest.fn<AnyAsyncFn>(),
      },
      orderItem: { findMany: jest.fn<AnyAsyncFn>() },
      orderStatusLog: { create: jest.fn<AnyAsyncFn>() },
      payment: {
        create: jest.fn<AnyAsyncFn>(),
        findUnique: jest.fn<AnyAsyncFn>(),
        findMany: jest.fn<AnyAsyncFn>(),
        updateMany: jest.fn<AnyAsyncFn>(),
      },
      fundAccount: { findFirst: jest.fn<AnyAsyncFn>() },
      rechargeOrder: { updateMany: jest.fn<AnyAsyncFn>() },
    };
    stockService = { confirm: jest.fn<AnyAsyncFn>() };
    fundService = { credit: jest.fn<AnyAsyncFn>(), getOrCreateAccount: jest.fn<AnyAsyncFn>() };

    // 假 tx 的委托指向同一批假实现，保证「事务内写库」的断言能命中
    FAKE_TX = {
      __fakeTx: true,
      order: prisma.order,
      orderItem: prisma.orderItem,
      orderStatusLog: prisma.orderStatusLog,
      payment: prisma.payment,
      fundAccount: prisma.fundAccount,
      rechargeOrder: prisma.rechargeOrder,
    };

    // 默认：事务正常执行闭包并注入假 tx
    (withTransaction as unknown as jest.Mock<AnyAsyncFn>).mockImplementation(async (fn) =>
      fn(FAKE_TX),
    );

    prisma.order.findFirst.mockResolvedValue(makeOrder());
    prisma.order.updateMany.mockResolvedValue({ count: 1 });
    prisma.orderItem.findMany.mockResolvedValue([{ skuId: 2001n, quantity: 1 }]);
    prisma.orderStatusLog.create.mockResolvedValue({ id: 1n });
    prisma.payment.findMany.mockResolvedValue([]);
    prisma.payment.findUnique.mockResolvedValue(makePayment());
    prisma.payment.updateMany.mockResolvedValue({ count: 1 });
    // 充值单默认可被推进（单独用例会把它 mock 成 count=0 模拟迟到回调）
    prisma.rechargeOrder.updateMany.mockResolvedValue({ count: 1 });
    prisma.payment.create.mockImplementation(async (args: { data: { paymentNo: string; amount: bigint; expireAt: Date | null } }) => ({
      paymentNo: args.data.paymentNo,
      amount: args.data.amount,
      expireAt: args.data.expireAt,
    }));
    stockService.confirm.mockResolvedValue({ skuId: 2001n, changeQty: -1 });

    // 平台现金账户由种子数据预置，默认存在（用例 4 会单独把它 mock 成 null）
    prisma.fundAccount.findFirst.mockResolvedValue({
      id: 7001n,
      accountNo: 'ACC_PLATFORM_CASH',
    });
    fundService.credit.mockResolvedValue({
      txNo: 'FT2026090700000001',
      accountId: 7001n,
      accountNo: 'ACC_PLATFORM_CASH',
      direction: 'IN',
      amount: 12800n,
      beforeBalance: 0n,
      afterBalance: 12800n,
      duplicated: false,
    });
    // 用户余额账户（首充由 FundService 自动开户；充值入账按支付单 userId 取）
    fundService.getOrCreateAccount.mockResolvedValue({
      id: 8001n,
      accountNo: 'ACC_USER_BALANCE_1',
      accountType: 'USER_BALANCE',
      status: 'ACTIVE',
      balance: 0n,
      frozenBalance: 0n,
      version: 0,
    });

    svc = new PaymentService(
      prisma as never,
      stockService as unknown as StockService,
      fundService as unknown as FundService,
    );
  });

  /** 基础发起支付入参 */
  const baseInput: CreatePaymentInput = { orderNo: 'SO20260907000001123456', payMethod: PayChannel.MOCK };

  // --------------------------------------------------------------------------
  // createPayment
  // --------------------------------------------------------------------------

  it('正常发起支付：返回 paymentNo / payUrl / amount，且 amount 等于订单 payAmount', async () => {
    const order = makeOrder({ payAmount: 12800n });
    prisma.order.findFirst.mockResolvedValue(order);

    const result = await svc.createPayment(1n, baseInput);

    expect(result.paymentNo).toEqual(expect.any(String));
    expect(result.payUrl).toBe(`/payment/${result.paymentNo}`);
    expect(result.amount).toBe(12800n); // 服务端金额，与前端传值无关
    expect(result.expireAt).toEqual(order.expireAt);
  });

  it('建单落库金额取订单 payAmount（不是任何前端传值）', async () => {
    prisma.order.findFirst.mockResolvedValue(makeOrder({ payAmount: 9900n }));

    await svc.createPayment(1n, baseInput);

    const arg = prisma.payment.create.mock.calls[0]?.[0] as {
      data: { amount: bigint; bizType: string; bizNo: string; channel: string; isMock: boolean; status: string };
    };
    expect(arg.data.amount).toBe(9900n);
    expect(arg.data.bizType).toBe('ORDER');
    expect(arg.data.bizNo).toBe('SO20260907000001123456');
    expect(arg.data.channel).toBe('MOCK');
    expect(arg.data.status).toBe('PENDING');
    expect(arg.data.isMock).toBe(true); // MOCK 渠道必须打标，便于对账剔除
  });

  it('越权防护：订单查询 where 必须同时带 orderNo 与 userId', async () => {
    await svc.createPayment(1n, baseInput);

    const arg = prisma.order.findFirst.mock.calls[0]?.[0] as {
      where: { orderNo: string; userId: bigint };
    };
    expect(arg.where.orderNo).toBe('SO20260907000001123456');
    expect(arg.where.userId).toBe(1n); // 漏了就是「替别人付款」的越权漏洞
  });

  it('订单不属于当前用户 → 拒绝发起支付（31001）', async () => {
    prisma.order.findFirst.mockResolvedValue(null);

    await expect(svc.createPayment(2n, baseInput)).rejects.toMatchObject({
      code: ErrorCode.ORDER_NOT_FOUND,
    });
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  it('订单已超时 → 拒绝发起支付（31004），且绝不建支付单', async () => {
    prisma.order.findFirst.mockResolvedValue(
      makeOrder({ expireAt: new Date(Date.now() - 1_000) }),
    );

    await expect(svc.createPayment(1n, baseInput)).rejects.toMatchObject({
      code: ErrorCode.ORDER_TIMEOUT_CLOSED,
    });
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  it('订单已支付（非 PENDING_PAYMENT）→ 拒绝重复发起支付（31002）', async () => {
    prisma.order.findFirst.mockResolvedValue(makeOrder({ status: OrderStatus.PAID }));

    await expect(svc.createPayment(1n, baseInput)).rejects.toMatchObject({
      code: ErrorCode.ORDER_STATUS_INVALID,
    });
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  it('同一订单重复发起支付 → 复用同一张支付单，不产生第二张', async () => {
    prisma.payment.findMany.mockResolvedValue([
      {
        paymentNo: 'PAY20260907000001888888',
        payUrl: '/payment/PAY20260907000001888888',
        amount: 12800n,
        expireAt: new Date(Date.now() + 60_000),
        channel: PayChannel.MOCK,
        status: PayStatus.PENDING,
      },
    ]);

    const result = await svc.createPayment(1n, baseInput);

    expect(result.paymentNo).toBe('PAY20260907000001888888');
    expect(prisma.payment.create).not.toHaveBeenCalled(); // 绝不新建第二张
  });

  it('幂等复用优先返回已 SUCCESS 的支付单（即便存在更晚创建的 PENDING 单）', async () => {
    // 故意把 PENDING 单排在前面（模拟 orderBy createdAt desc 的返回顺序被打乱）
    prisma.payment.findMany.mockResolvedValue([
      {
        paymentNo: 'PAY-NEW-PENDING',
        payUrl: null,
        amount: 12800n,
        expireAt: null,
        channel: PayChannel.MOCK,
        status: PayStatus.PENDING,
      },
      {
        paymentNo: 'PAY-OLD-SUCCESS',
        payUrl: null,
        amount: 12800n,
        expireAt: null,
        channel: PayChannel.MOCK,
        status: PayStatus.SUCCESS,
      },
    ]);

    const result = await svc.createPayment(1n, baseInput);

    expect(result.paymentNo).toBe('PAY-OLD-SUCCESS');
    expect(result.payUrl).toBe('/payment/PAY-OLD-SUCCESS'); // payUrl 缺失时按渠道重算
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  it('MOCK 渠道 payUrl 为前端收银台；非 MOCK 渠道本期留空（待 PaymentRouter 接入）', async () => {
    const mockResult = await svc.createPayment(1n, baseInput);
    expect(mockResult.payUrl).toBe(`/payment/${mockResult.paymentNo}`);

    // 换 ALIPAY 再发一次：本期未接适配器，payUrl 为空串而非伪造地址
    prisma.order.findFirst.mockResolvedValue(makeOrder());
    const aliResult = await svc.createPayment(1n, { orderNo: baseInput.orderNo, payMethod: PayChannel.ALIPAY });
    expect(aliResult.payUrl).toBe('');
  });

  // --------------------------------------------------------------------------
  // handlePaidNotify
  // --------------------------------------------------------------------------

  it('支付单不存在 → 拒绝入账（40001）', async () => {
    prisma.payment.findUnique.mockResolvedValue(null);

    await expect(
      svc.handlePaidNotify('PAY-NOT-EXIST', { channelTradeNo: 'TRADE-1', amount: 12800n }),
    ).rejects.toMatchObject({ code: ErrorCode.PAYMENT_NOT_FOUND });

    expect(withTransaction).not.toHaveBeenCalled();
  });

  it('回调金额不符 → 拒绝入账（40002），支付单保持 PENDING 且不开事务', async () => {
    prisma.payment.findUnique.mockResolvedValue(makePayment({ amount: 12800n }));

    await expect(
      svc.handlePaidNotify('PAY20260907000001999999', {
        channelTradeNo: 'TRADE-1',
        amount: 1n, // 伪造：1 分钱想买走 128 元的单
      }),
    ).rejects.toMatchObject({ code: ErrorCode.PAYMENT_AMOUNT_MISMATCH });

    // 关键：绝不能推进状态（支付单仍待支付，等真实回调）
    expect(prisma.payment.updateMany).not.toHaveBeenCalled();
    expect(withTransaction).not.toHaveBeenCalled();
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
    expect(stockService.confirm).not.toHaveBeenCalled();
  });

  it('已 CLOSED 的支付单收到回调 → 拒绝入账（40003）且不开事务', async () => {
    prisma.payment.findUnique.mockResolvedValue(makePayment({ status: PayStatus.CLOSED }));

    await expect(
      svc.handlePaidNotify('PAY20260907000001999999', { channelTradeNo: 'TRADE-1', amount: 12800n }),
    ).rejects.toMatchObject({ code: ErrorCode.PAYMENT_CLOSED });

    // 迟到回调必须被拒绝并告警，绝不能被 WHERE status='PENDING' 静默吞掉
    expect(withTransaction).not.toHaveBeenCalled();
    expect(prisma.payment.updateMany).not.toHaveBeenCalled();
    expect(stockService.confirm).not.toHaveBeenCalled();
  });

  it('已 FAILED / REFUNDED 的支付单收到回调 → 拒绝入账（40004）且不开事务', async () => {
    prisma.payment.findUnique.mockResolvedValue(makePayment({ status: PayStatus.FAILED }));
    await expect(
      svc.handlePaidNotify('PAY20260907000001999999', { channelTradeNo: 'TRADE-1', amount: 12800n }),
    ).rejects.toMatchObject({ code: ErrorCode.PAYMENT_FINAL_STATE });

    prisma.payment.findUnique.mockResolvedValue(makePayment({ status: PayStatus.REFUNDED }));
    await expect(
      svc.handlePaidNotify('PAY20260907000001999999', { channelTradeNo: 'TRADE-2', amount: 12800n }),
    ).rejects.toMatchObject({ code: ErrorCode.PAYMENT_FINAL_STATE });

    expect(withTransaction).not.toHaveBeenCalled();
  });

  it('已 SUCCESS 的支付单重复回调 → 静默返回不告警（正常重发，不是异常）', async () => {
    prisma.payment.findUnique.mockResolvedValue(makePayment({ status: PayStatus.SUCCESS }));

    await expect(
      svc.handlePaidNotify('PAY20260907000001999999', { channelTradeNo: 'TRADE-1', amount: 12800n }),
    ).resolves.toBeUndefined();

    // 与 CLOSED/FAILED 的区别：SUCCESS 是正常重复回调，不开事务、不抛错、不写任何东西
    expect(withTransaction).not.toHaveBeenCalled();
    expect(prisma.payment.updateMany).not.toHaveBeenCalled();
    expect(stockService.confirm).not.toHaveBeenCalled();
  });

  it('支付成功 → 订单回写 payMethod（值取支付单 channel），避免对账无法追溯渠道', async () => {
    prisma.payment.findUnique.mockResolvedValue(
      makePayment({ status: PayStatus.PENDING, channel: PayChannel.WECHAT }),
    );

    await svc.handlePaidNotify('PAY20260907000001999999', { channelTradeNo: 'TRADE-1', amount: 12800n });

    const orderArg = prisma.order.updateMany.mock.calls[0]?.[0] as {
      data: { status: string; payMethod: string };
    };
    expect(orderArg.data.payMethod).toBe('WECHAT'); // 不是 null，也不是前端传值
  });

  it('回调幂等：同一支付单连续回调两次 → 库存 confirm 只调一次、订单轨迹只写一次', async () => {
    // 第一次：待支付；第二次：已被首次回调推进为 SUCCESS（模拟 DB 真实状态）
    prisma.payment.findUnique
      .mockResolvedValueOnce(makePayment({ status: PayStatus.PENDING }))
      .mockResolvedValueOnce(makePayment({ status: PayStatus.SUCCESS }));

    await svc.handlePaidNotify('PAY20260907000001999999', { channelTradeNo: 'TRADE-1', amount: 12800n });
    await svc.handlePaidNotify('PAY20260907000001999999', { channelTradeNo: 'TRADE-1', amount: 12800n });

    expect(stockService.confirm).toHaveBeenCalledTimes(1);
    expect(prisma.orderStatusLog.create).toHaveBeenCalledTimes(1);
    // 第二重：已 SUCCESS 时事务都不必开启
    expect(withTransaction).toHaveBeenCalledTimes(1);
  });

  it('支付单状态推进必须是条件更新（WHERE status=PENDING），防并发重复推进', async () => {
    await svc.handlePaidNotify('PAY20260907000001999999', { channelTradeNo: 'TRADE-1', amount: 12800n });

    const arg = prisma.payment.updateMany.mock.calls[0]?.[0] as {
      where: { paymentNo: string; status: string };
      data: { status: string; channelTradeNo: string; paidAt: Date };
    };
    expect(arg.where.paymentNo).toBe('PAY20260907000001999999');
    expect(arg.where.status).toBe('PENDING'); // 漏了就是「重复入账」
    expect(arg.data.status).toBe('SUCCESS');
    expect(arg.data.channelTradeNo).toBe('TRADE-1');
    expect(arg.data.paidAt).toBeInstanceOf(Date);
  });

  it('库存 confirm 必须在事务内：收到的 tx 必须是事务闭包的 tx，不能是 undefined', async () => {
    await svc.handlePaidNotify('PAY20260907000001999999', { channelTradeNo: 'TRADE-1', amount: 12800n });

    const txArg = stockService.confirm.mock.calls[0]?.[1];
    expect(txArg).toBeDefined();
    expect(txArg).toBe(FAKE_TX); // 必须是事务闭包内的 tx，不是外部单例（否则回滚时库存回不去）
  });

  it('多 SKU 的库存 confirm 严格按 skuId 升序（与下单冻结顺序一致，防死锁）', async () => {
    // 故意乱序返回：先 3001 后 2001
    prisma.orderItem.findMany.mockResolvedValue([
      { skuId: 3001n, quantity: 2 },
      { skuId: 2001n, quantity: 1 },
    ]);

    await svc.handlePaidNotify('PAY20260907000001999999', { channelTradeNo: 'TRADE-1', amount: 12800n });

    const confirmOrder = stockService.confirm.mock.calls.map((c) => (c[0] as { skuId: bigint }).skuId);
    expect(confirmOrder).toEqual([2001n, 3001n]); // 升序，不是查询返回顺序
    const qtyArg = stockService.confirm.mock.calls[0]?.[0] as { qty: number; bizNo: string };
    expect(qtyArg.qty).toBe(1); // 数量取订单行 quantity
    expect(qtyArg.bizNo).toBe('SO20260907000001123456');
  });

  it('支付成功 → 订单推进为 PAID（带状态条件）并写入轨迹', async () => {
    await svc.handlePaidNotify('PAY20260907000001999999', { channelTradeNo: 'TRADE-1', amount: 12800n });

    const orderArg = prisma.order.updateMany.mock.calls[0]?.[0] as {
      where: { id: bigint; status: string };
      data: { status: string; paidAt: Date };
    };
    expect(orderArg.where.id).toBe(9001n);
    expect(orderArg.where.status).toBe('PENDING_PAYMENT'); // 状态机条件，防重复推进
    expect(orderArg.data.status).toBe('PAID');

    const logArg = prisma.orderStatusLog.create.mock.calls[0]?.[0] as {
      data: {
        orderId: bigint;
        fromStatus: string;
        toStatus: string;
        operatorType: string;
        operatorId: bigint;
      };
    };
    expect(logArg.data.fromStatus).toBe('PENDING_PAYMENT');
    expect(logArg.data.toStatus).toBe('PAID');
    expect(logArg.data.operatorType).toBe('SYSTEM');
    expect(logArg.data.operatorId).toBe(0n);
  });

  it('并发回调（updateMany 返回 count=0）→ 直接返回不报错，库存与轨迹都不动', async () => {
    // 支付单读到仍是 PENDING（模拟读到旧快照），但条件更新已被并发回调抢占
    prisma.payment.findUnique.mockResolvedValue(makePayment({ status: PayStatus.PENDING }));
    prisma.payment.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      svc.handlePaidNotify('PAY20260907000001999999', { channelTradeNo: 'TRADE-1', amount: 12800n }),
    ).resolves.toBeUndefined();

    expect(stockService.confirm).not.toHaveBeenCalled();
    expect(prisma.orderStatusLog.create).not.toHaveBeenCalled();
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // 记账（T061）：渠道支付 → 平台现金账户 ORDER_PAY 的 IN 流水
  // --------------------------------------------------------------------------

  it('渠道支付成功 → 记账 1 次，bizType=ORDER_PAY / isLiability=false / amount=支付单金额', async () => {
    await svc.handlePaidNotify('PAY20260907000001999999', { channelTradeNo: 'TRADE-1', amount: 12800n });

    expect(fundService.credit).toHaveBeenCalledTimes(1);
    const arg = fundService.credit.mock.calls[0]?.[0] as {
      accountId: bigint;
      amount: bigint;
      bizType: string;
      isLiability: boolean;
      orderNo: string;
      paymentNo: string;
      operatorType: string;
      operatorId: bigint;
    };
    expect(arg.accountId).toBe(7001n); // 查出来的平台现金账户，不是写死的
    expect(arg.bizType).toBe('ORDER_PAY');
    expect(arg.isLiability).toBe(false); // 订单收款是平台收入，不是欠用户的储值
    expect(arg.amount).toBe(12800n); // = 支付单金额
    expect(arg.orderNo).toBe('SO20260907000001123456');
    expect(arg.paymentNo).toBe('PAY20260907000001999999');
    expect(arg.operatorType).toBe('SYSTEM');
    expect(arg.operatorId).toBe(0n);
  });

  it('记账事务红线：credit 收到的第二参必须是事务 B 的 tx，不能是 undefined', async () => {
    await svc.handlePaidNotify('PAY20260907000001999999', { channelTradeNo: 'TRADE-1', amount: 12800n });

    const txArg = fundService.credit.mock.calls[0]?.[1];
    expect(txArg).toBeDefined();
    expect(txArg).toBe(FAKE_TX); // 漏传 tx → 记账跑独立连接，事务回滚时钱已入账（钱凭空多出来）
  });

  it('记账幂等红线：idempotencyKey 必须是 paymentNo（撞 uk_biz_idem 即已记过）', async () => {
    await svc.handlePaidNotify('PAY20260907000001999999', { channelTradeNo: 'TRADE-1', amount: 12800n });

    const arg = fundService.credit.mock.calls[0]?.[0] as { idempotencyKey: string | null };
    expect(arg.idempotencyKey).toBe('PAY20260907000001999999');
  });

  it('平台现金账户不存在 → 拒绝入账并抛错（60001），订单与库存都不动（整事务回滚）', async () => {
    prisma.fundAccount.findFirst.mockResolvedValue(null);

    await expect(
      svc.handlePaidNotify('PAY20260907000001999999', { channelTradeNo: 'TRADE-1', amount: 12800n }),
    ).rejects.toMatchObject({ code: ErrorCode.FUND_RECORD_FAILED });

    // 记账排在订单推进与库存 confirm 之前，失败即整事务回滚 —— 绝不允许「订单已 PAID 但没记账」
    expect(fundService.credit).not.toHaveBeenCalled();
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
    expect(prisma.orderStatusLog.create).not.toHaveBeenCalled();
    expect(stockService.confirm).not.toHaveBeenCalled();
  });

  it('重复回调（支付单已 SUCCESS）→ 记账一次都没被调用（走静默返回分支）', async () => {
    prisma.payment.findUnique.mockResolvedValue(makePayment({ status: PayStatus.SUCCESS }));

    await svc.handlePaidNotify('PAY20260907000001999999', { channelTradeNo: 'TRADE-1', amount: 12800n });

    expect(fundService.credit).not.toHaveBeenCalled();
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it('并发回调（支付单 updateMany count=0）→ 不记账（第二重幂等先于记账生效）', async () => {
    prisma.payment.updateMany.mockResolvedValue({ count: 0 });

    await svc.handlePaidNotify('PAY20260907000001999999', { channelTradeNo: 'TRADE-1', amount: 12800n });

    expect(fundService.credit).not.toHaveBeenCalled();
  });

  it('金额口径：记账 amount 取支付单 amount（bigint），回调金额只作为原始证据存字符串', async () => {
    prisma.payment.findUnique.mockResolvedValue(makePayment({ amount: 55500n }));

    await svc.handlePaidNotify('PAY20260907000001999999', { channelTradeNo: 'TRADE-1', amount: 55500n });

    const creditArg = fundService.credit.mock.calls[0]?.[0] as { amount: unknown };
    // 权威来源是支付单：bigint，不是回调声称的数字
    expect(typeof creditArg.amount).toBe('bigint');
    expect(creditArg.amount).toBe(55500n);

    // 回调金额只作为留痕证据落 raw_notify（字符串），绝不参与记账运算
    const payArg = prisma.payment.updateMany.mock.calls[0]?.[0] as {
      data: { rawNotify: { amount: string } };
    };
    expect(payArg.data.rawNotify.amount).toBe('55500');
  });

  // --------------------------------------------------------------------------
  // 充值入账（T070-C / F14.1 ② 事务 I）：充值单推进 + 双流水
  // --------------------------------------------------------------------------

  /** 构造充值支付单（orderId=null、bizNo=充值单号、走外部渠道） */
  function makeRechargePayment(overrides: Partial<FakePayment> = {}): FakePayment {
    return makePayment({
      orderId: null,
      orderNo: null,
      rechargeId: 5001n,
      userId: 7n,
      bizNo: 'RC20260910000001777777',
      amount: 5000n,
      channel: PayChannel.ALIPAY,
      ...overrides,
    });
  }

  it('充值回调成功 → 充值单条件推进 SUCCESS + 回写 paidAt/paymentNo，两条 IN 流水共享 txGroupNo', async () => {
    prisma.payment.findUnique.mockResolvedValue(makeRechargePayment());

    await svc.handlePaidNotify('PAY20260907000001999999', { channelTradeNo: 'TRADE-1', amount: 5000n });

    // ① 充值单推进：必须带 status=PENDING 条件（迟到回调给已关单充值单入账 = 白送钱）
    const rcArg = prisma.rechargeOrder.updateMany.mock.calls[0]?.[0] as {
      where: { id: bigint; status: string };
      data: { status: string; paidAt: Date; paymentNo: string };
    };
    expect(rcArg.where.id).toBe(5001n);
    expect(rcArg.where.status).toBe('PENDING');
    expect(rcArg.data.status).toBe('SUCCESS');
    expect(rcArg.data.paidAt).toBeInstanceOf(Date);
    expect(rcArg.data.paymentNo).toBe('PAY20260907000001999999'); // schema:971 反查与幂等锚点

    // ② 双流水：平台侧（负债）+ 用户侧（余额）
    expect(fundService.credit).toHaveBeenCalledTimes(2);
    const platform = fundService.credit.mock.calls[0]?.[0] as {
      accountId: bigint;
      bizType: string;
      isLiability: boolean;
      amount: bigint;
      txGroupNo: string;
      rechargeNo: string;
      idempotencyKey: string | null;
    };
    const user = fundService.credit.mock.calls[1]?.[0] as {
      accountId: bigint;
      bizType: string;
      isLiability?: boolean;
      txGroupNo: string;
      amount: bigint;
    };
    expect(platform.accountId).toBe(7001n); // 查出来的平台现金账户，不是写死的
    expect(platform.bizType).toBe('PLATFORM_RECHARGE_IN');
    expect(platform.isLiability).toBe(true); // ★ 与 ORDER_PAY 的唯一区别：平台收了钱但**欠**用户
    expect(platform.rechargeNo).toBe('RC20260910000001777777');
    expect(platform.idempotencyKey).toBe('PAY20260907000001999999');
    expect(user.accountId).toBe(8001n); // getOrCreateAccount 返回的用户余额账户
    expect(user.bizType).toBe('BALANCE_RECHARGE');
    expect(user.isLiability ?? false).toBe(false); // 用户余额流水恒 false
    expect(platform.amount).toBe(5000n); // 金额取支付单，不是回调入参
    expect(user.amount).toBe(5000n);
    // 同组：对账时可按 txGroupNo 成对还原「现金进 / 余额增」
    expect(platform.txGroupNo).toEqual(expect.any(String));
    expect(platform.txGroupNo).toBe(user.txGroupNo);

    // ③ 用户余额账户按支付单 userId 定位（首充自动开户）
    expect(fundService.getOrCreateAccount).toHaveBeenCalledWith(7n, 'USER_BALANCE', FAKE_TX);

    // ④ 充值绝不能碰订单 / 轨迹 / 库存
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
    expect(prisma.orderStatusLog.create).not.toHaveBeenCalled();
    expect(prisma.orderItem.findMany).not.toHaveBeenCalled();
    expect(stockService.confirm).not.toHaveBeenCalled();
  });

  it('充值记账事务红线：两次 credit 的第二参都必须是事务 B 的 tx（漏传 = 回滚时钱凭空多出）', async () => {
    prisma.payment.findUnique.mockResolvedValue(makeRechargePayment());

    await svc.handlePaidNotify('PAY20260907000001999999', { channelTradeNo: 'TRADE-1', amount: 5000n });

    expect(fundService.credit.mock.calls[0]?.[1]).toBe(FAKE_TX);
    expect(fundService.credit.mock.calls[1]?.[1]).toBe(FAKE_TX);
    expect(fundService.getOrCreateAccount.mock.calls[0]?.[2]).toBe(FAKE_TX); // 开户也必须同事务
  });

  it('充值记账绝不写 ORDER_PAY（虚增收入红线），金额恒为支付单 amount 的 bigint', async () => {
    prisma.payment.findUnique.mockResolvedValue(makeRechargePayment({ amount: 8888n }));

    await svc.handlePaidNotify('PAY20260907000001999999', { channelTradeNo: 'TRADE-1', amount: 8888n });

    const bizTypes = fundService.credit.mock.calls.map((c) => (c[0] as { bizType: string }).bizType);
    expect(bizTypes).toEqual(['PLATFORM_RECHARGE_IN', 'BALANCE_RECHARGE']);
    const amounts = fundService.credit.mock.calls.map((c) => (c[0] as { amount: unknown }).amount);
    expect(amounts).toEqual([8888n, 8888n]); // bigint，且是支付单金额
  });

  it('充值单非 PENDING（迟到回调 / 已关单）→ 拒绝入账（61006），钱绝不进已关充值单', async () => {
    prisma.payment.findUnique.mockResolvedValue(makeRechargePayment());
    prisma.rechargeOrder.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      svc.handlePaidNotify('PAY20260907000001999999', { channelTradeNo: 'TRADE-1', amount: 5000n }),
    ).rejects.toMatchObject({ code: ErrorCode.RECHARGE_ALREADY_PAID });

    expect(fundService.credit).not.toHaveBeenCalled();
  });

  it('平台现金账户不存在 → 拒绝入账（60001），充值单推进后整事务回滚', async () => {
    prisma.payment.findUnique.mockResolvedValue(makeRechargePayment());
    prisma.fundAccount.findFirst.mockResolvedValue(null);

    await expect(
      svc.handlePaidNotify('PAY20260907000001999999', { channelTradeNo: 'TRADE-1', amount: 5000n }),
    ).rejects.toMatchObject({ code: ErrorCode.FUND_RECORD_FAILED });

    expect(fundService.credit).not.toHaveBeenCalled();
    expect(fundService.getOrCreateAccount).not.toHaveBeenCalled();
  });

  it('充值支付单缺 rechargeId（脏数据纵深防御）→ 拒绝入账（61005），不推进任何单', async () => {
    prisma.payment.findUnique.mockResolvedValue(makeRechargePayment({ rechargeId: null }));

    await expect(
      svc.handlePaidNotify('PAY20260907000001999999', { channelTradeNo: 'TRADE-1', amount: 5000n }),
    ).rejects.toMatchObject({ code: ErrorCode.RECHARGE_NOT_FOUND });

    expect(prisma.rechargeOrder.updateMany).not.toHaveBeenCalled();
    expect(fundService.credit).not.toHaveBeenCalled();
  });

  it('充值重复回调（支付单已 SUCCESS）→ 不开事务、不重复入账', async () => {
    prisma.payment.findUnique.mockResolvedValue(makeRechargePayment({ status: PayStatus.SUCCESS }));

    await expect(
      svc.handlePaidNotify('PAY20260907000001999999', { channelTradeNo: 'TRADE-1', amount: 5000n }),
    ).resolves.toBeUndefined();

    expect(withTransaction).not.toHaveBeenCalled();
    expect(fundService.credit).not.toHaveBeenCalled();
    expect(prisma.rechargeOrder.updateMany).not.toHaveBeenCalled();
  });

  it('余额支付（channel=BALANCE）本期不记账，留 TODO(T070) 且不影响订单推进', async () => {
    prisma.payment.findUnique.mockResolvedValue(
      makePayment({ status: PayStatus.PENDING, channel: PayChannel.BALANCE }),
    );

    await svc.handlePaidNotify('PAY20260907000001999999', { channelTradeNo: 'TRADE-1', amount: 12800n });

    // 结转对需要 BalanceService 扣 USER_BALANCE（T070-A），现在没有余额账户可扣
    expect(fundService.credit).not.toHaveBeenCalled();
    // 但订单与库存仍照常推进：余额支付本身是合法路径，只是记账延后
    expect(prisma.order.updateMany).toHaveBeenCalledTimes(1);
    expect(stockService.confirm).toHaveBeenCalledTimes(1);
  });

  it('订单已被其它路径推进（updateMany 返回 count=0）→ 只写支付单，不重复写轨迹', async () => {
    prisma.order.updateMany.mockResolvedValue({ count: 0 });

    await svc.handlePaidNotify('PAY20260907000001999999', { channelTradeNo: 'TRADE-1', amount: 12800n });

    expect(prisma.orderStatusLog.create).not.toHaveBeenCalled();
    // 但库存仍需 confirm：支付单是「本次首次成功」，库存不能再漏
    expect(stockService.confirm).toHaveBeenCalledTimes(1);
  });
});
