/**
 * @file server/src/tests/unit/qaEdgeCases.spec.ts
 * @description QA 独立验证补充用例：专打「实现者自测没覆盖到的边界」——
 *              金额来源红线、库存事务边界、支付回调口径、生产环境 mock 端点注册
 * @module tests/unit
 * @see server/src/services/OrderService.ts、server/src/services/PaymentService.ts
 * @see server/src/routes/api/payment.routes.ts、docs/02-architecture.md §6.7（mock 红线）
 * @author QA（software-qa-engineer）
 * @created 2026-09-08
 *
 * 与既有 `orderService.spec.ts` / `paymentService.spec.ts` 的分工：
 * 既有套件覆盖「写了什么」，本套件覆盖「**绝不能写什么 / 绝不能注册什么**」——
 * 也就是那些一旦回归就会直接造成资损、但业务测试通常不会去断言的**负向契约**：
 *
 * 1. 金额入口唯一：下单与发起支付的校验器对**任何**金额字段一律 strict 拒收；
 *    下单落库金额与重算结果逐字段相等，购物车快照价（`sku.price`）不出现在任何写入参数里。
 * 2. 库存与订单写的边界：confirm 的订单行必须按 `payment.orderId` 过滤（防串单）；
 *    支付单 `orderId = null`（充值场景）时绝不推进订单、绝不 confirm 库存。
 * 3. 状态机边界：`expireAt <= now` 一律视为已超时；非 `PENDING_PAYMENT` 一律不可发起支付。
 * 4. 生产安全：`POST /api/payments/:paymentNo/mock-paid` 在 `NODE_ENV=production` 下
 *    **不得出现在路由表中**（不是「进处理器再抛错」，而是压根不注册）。
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { OrderStatus, PayChannel, PayStatus, ProductStatus, SkuStatus } from '@prisma/client';
import { ErrorCode } from '@/core/errors/errorCodes';
import { withTransaction } from '@/core/transaction';
import { OrderService } from '@/services/OrderService';
import { PaymentService } from '@/services/PaymentService';
import { createOrderSchema } from '@/validators/order.validator';
import { createPaymentSchema } from '@/validators/payment.validator';

/**
 * 配置桩工厂（**必须是函数声明**：`jest.mock` 会被提升到 import 之前执行）。
 *
 * @description 本套件要用 `jest.isolateModules` 重建模块注册表来验证「生产环境不注册 mock 端点」，
 * 而一旦在顶层 import 了 `@/config`，后续 `jest.doMock` 在隔离注册表里就不再生效
 * （配置桩会被外层注册表命中，导致两个环境拿到同一份 `isProduction`）。
 * 因此配置值统一由本工厂产出，语义与「从 config 读」完全一致。
 * @param isProduction 是否模拟生产环境
 * @returns 配置桩
 */
function buildConfigStub(isProduction = false) {
  return {
    config: {
      env: isProduction ? 'production' : 'test',
      redis: { keyPrefix: 'shop' },
      order: { payTimeoutMinutes: 30, autoConfirmDays: 15, afterSaleDays: 7 },
      freight: { freeThreshold: 9900, fee: 1200 },
      jwt: {
        shop: { accessSecret: 'x'.repeat(32), refreshSecret: 'x'.repeat(32), accessTtl: '2h', refreshTtl: '7d' },
        admin: { accessSecret: 'x'.repeat(32), refreshSecret: 'x'.repeat(32), accessTtl: '2h', refreshTtl: '7d' },
      },
      rateLimit: { enabled: false, globalMax: 600, globalWindowMs: 60_000, defaultMax: 120, defaultWindowMs: 60_000 },
      security: { bodyLimit: '1mb', trustProxy: 1 },
      // logger 在 import 时即读 config.log.level 建 winston 实例，缺了会让整个套件起不来
      log: { level: 'error', dir: '' },
    },
    isProduction,
    isTest: !isProduction,
    isDevelopment: false,
  };
}

// config 在模块加载时即校验环境变量并可能 process.exit；测试环境没有 .env，注入固定值
jest.mock('@/config', () => buildConfigStub(false));

// 单例在模块加载时会调用 getPrisma()，用假实现避免建真实客户端
jest.mock('@/core/prisma', () => ({
  getPrisma: jest.fn(() => ({})),
}));

// 事务在这里被接管：由测试决定「执行闭包并传入假 tx」还是「直接抛错模拟回滚」
jest.mock('@/core/transaction', () => ({
  withTransaction: jest.fn(),
}));

/**
 * 打桩函数类型。
 *
 * @description 与既有套件保持一致：`@jest/globals` 会把 `Promise<unknown>` 的解析类型
 * 推导成 `never`，导致 `mockResolvedValue(...)` 报 TS2345。打桩是通行例外。
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyAsyncFn = (...args: any[]) => Promise<any>;
type AnySyncFn = (...args: any[]) => any;
/* eslint-enable @typescript-eslint/no-explicit-any */

/** 事务闭包的假 tx */
let FAKE_TX: Record<string, unknown>;

/** 构造一条购物车条目（SKU 快照价可单独指定，用于验证「快照价不参与落库」） */
function makeCartItem(skuId: bigint, quantity: number, snapshotPrice: bigint) {
  return {
    id: skuId,
    skuId,
    quantity,
    sku: {
      id: skuId,
      productId: skuId + 1000n,
      skuCode: `SKU-${skuId}`,
      specDigest: '颜色:陨石黑',
      imageUrl: null,
      price: snapshotPrice, // 加购时的快照价：绝不能参与下单落库
      originalPrice: 12000n,
      status: SkuStatus.ENABLED,
      product: {
        id: skuId + 1000n,
        name: '测试商品',
        mainImage: '/img/main.jpg',
        status: ProductStatus.ON_SALE,
      },
    },
  };
}

/** 构造计价结果（goodsAmount 由调用方给定，运费按满 9900 包邮） */
function makePrice(unitPrice: bigint, quantity: number) {
  const goodsAmount = unitPrice * BigInt(quantity);
  const freightAmount = goodsAmount >= 9900n ? 0n : 1200n;
  return {
    goodsAmount,
    rowPromoDiscount: 0n,
    orderPromoDiscount: 0n,
    couponDiscount: 0n,
    pointDeductAmount: 0n,
    freightAmount,
    payAmount: goodsAmount + freightAmount,
    items: [
      {
        skuId: 2001n,
        quantity,
        unitPrice,
        goodsAmount,
        promoDiscount: 0n,
        allocatedDiscount: 0n,
        payableAmount: goodsAmount,
      },
    ],
  };
}

describe('QA-1 资金红线：金额绝不可能来自前端', () => {
  /** 所有可能承载「前端想付多少」的字段名（含大小写与常见别名） */
  const AMOUNT_FIELD_NAMES = [
    'amount',
    'payAmount',
    'payableAmount',
    'goodsAmount',
    'freightAmount',
    'totalAmount',
    'price',
    'unitPrice',
    'couponDiscount',
    'pointDeductAmount',
    'orderPromoDiscount',
    'rowPromoDiscount',
  ];

  it('下单校验器：任何金额字段一律 strict 拒收（金额只可能来自 PriceService 重算）', () => {
    const base = { addressId: '1', cartItemIds: ['11'] };
    const accepted = AMOUNT_FIELD_NAMES.filter((f) => createOrderSchema.safeParse({ ...base, [f]: 1 }).success);
    expect(accepted).toEqual([]); // 非空即说明校验层开了「前端定价」的口子
  });

  it('发起支付校验器：任何金额字段一律 strict 拒收（应付由订单 payAmount 定）', () => {
    const base = { orderNo: 'SO20260908000001234', payMethod: 'MOCK' };
    const accepted = AMOUNT_FIELD_NAMES.filter((f) => createPaymentSchema.safeParse({ ...base, [f]: 1 }).success);
    expect(accepted).toEqual([]); // 非空即说明校验层开了「前端定价」的口子
  });

  it('计价入口只收 skuId + quantity：OrderService 不把任何价格传给 PriceService', async () => {
    const { svc, prisma, priceService } = setupOrderService();
    prisma.cartItem.findMany.mockResolvedValue([makeCartItem(2001n, 2, 1n)]);
    const price = makePrice(8000n, 2);
    priceService.calculate.mockResolvedValue(price);

    await svc.createOrder(7n, { addressId: 1n, cartItemIds: [11n] });

    const arg = priceService.calculate.mock.calls[0]?.[0] as { items: unknown[] };
    expect(arg.items).toEqual([{ skuId: 2001n, quantity: 2 }]);
  });

  it('下单落库金额逐字段等于重算结果，购物车快照价 1 分不出现在任何写入参数中', async () => {
    const { svc, prisma, priceService } = setupOrderService();
    // 快照价 1 分（被篡改过的极端值），服务端重算单价 8000 分 × 2 件
    prisma.cartItem.findMany.mockResolvedValue([makeCartItem(2001n, 2, 1n)]);
    const price = makePrice(8000n, 2);
    priceService.calculate.mockResolvedValue(price);

    await svc.createOrder(7n, { addressId: 1n, cartItemIds: [11n] });

    const orderData = (prisma.order.create.mock.calls[0]?.[0] as { data: Record<string, bigint> }).data;
    expect(orderData.goodsAmount).toBe(16000n);
    expect(orderData.freightAmount).toBe(0n);
    expect(orderData.rowPromoDiscount).toBe(0n);
    expect(orderData.orderPromoDiscount).toBe(0n);
    expect(orderData.couponDiscount).toBe(0n);
    expect(orderData.pointDeductAmount).toBe(0n);
    expect(orderData.payAmount).toBe(16000n);
    // 关键：任何一个金额字段都不允许等于被篡改的快照价（1 分）
    const leakedFields = Object.entries(orderData)
      .filter(([, value]) => typeof value === 'bigint' && value === 1n)
      .map(([key]) => key);
    expect(leakedFields).toEqual([]); // 非空即说明某个金额落到了快照价

    const itemData = (prisma.orderItem.create.mock.calls[0]?.[0] as { data: Record<string, bigint> }).data;
    expect(itemData.unitPrice).toBe(8000n); // 重算单价，不是 sku.price（1 分）
    expect(itemData.goodsAmount).toBe(16000n);
    expect(itemData.payableAmount).toBe(16000n);
    expect(itemData.originalPrice).toBe(12000n); // 原价取自 sku.originalPrice，与快照价无关
  });
});

describe('QA-2 支付回调口径与库存事务边界', () => {
  it('回调金额偏大 → 同样拒绝入账（40002）：金额校验是严格相等，不是「不超过」', async () => {
    const { svc, prisma, stockService } = setupPaymentService();
    prisma.payment.findUnique.mockResolvedValue(makePayment({ amount: 12800n }));

    await expect(
      svc.handlePaidNotify('PAY1', { channelTradeNo: 'T-1', amount: 99999999n }),
    ).rejects.toMatchObject({ code: ErrorCode.PAYMENT_AMOUNT_MISMATCH });

    expect(withTransaction).not.toHaveBeenCalled();
    expect(stockService.confirm).not.toHaveBeenCalled();
  });

  it('支付单 orderId 为 null（充值场景）→ 绝不推进订单、绝不 confirm 库存', async () => {
    const { svc, prisma, stockService, fundService } = setupPaymentService();
    prisma.payment.findUnique.mockResolvedValue(
      makePayment({ orderId: null, orderNo: null, rechargeId: 5001n, userId: 7n, bizNo: 'RC20260910000001' }),
    );

    await svc.handlePaidNotify('PAY1', { channelTradeNo: 'T-1', amount: 12800n });

    expect(prisma.order.updateMany).not.toHaveBeenCalled();
    expect(prisma.orderStatusLog.create).not.toHaveBeenCalled();
    expect(stockService.confirm).not.toHaveBeenCalled();
    // 资金口径红线（T070-C）：充值走 F14.1 ② 双流水，**绝不能**按 ORDER_PAY 记账
    // （记成 ORDER_PAY = 虚增平台收入 + 漏记负债，负债表与利润表同时错且没有任何报错）
    const bizTypes = fundService.credit.mock.calls.map((c) => (c[0] as { bizType: string }).bizType);
    expect(bizTypes).toEqual(['PLATFORM_RECHARGE_IN', 'BALANCE_RECHARGE']);
    // 平台侧必须是负债口径（平台收了钱但欠用户），这是与订单支付的唯一区别
    expect((fundService.credit.mock.calls[0]?.[0] as { isLiability: boolean }).isLiability).toBe(true);
    // 充值单被推进，且用户余额账户按支付单 userId 定位（首充自动开户）
    expect(prisma.rechargeOrder.updateMany).toHaveBeenCalledTimes(1);
    expect(fundService.getOrCreateAccount).toHaveBeenCalledWith(7n, 'USER_BALANCE', FAKE_TX);
    // 支付单本身仍要正常推进为 SUCCESS
    const payArg = prisma.payment.updateMany.mock.calls[0]?.[0] as { data: { status: string } };
    expect(payArg.data.status).toBe('SUCCESS');
  });

  it('confirm 的订单行查询必须按 payment.orderId 过滤（防串单 confirm 到别的订单）', async () => {
    const { svc, prisma } = setupPaymentService();
    prisma.payment.findUnique.mockResolvedValue(makePayment({ orderId: 4242n }));

    await svc.handlePaidNotify('PAY1', { channelTradeNo: 'T-1', amount: 12800n });

    const arg = prisma.orderItem.findMany.mock.calls[0]?.[0] as { where: { orderId: bigint } };
    expect(arg.where.orderId).toBe(4242n); // 必须是本支付单的订单，不能是 paymentNo 或固定值
  });

  it('建支付单时 userId 取自调用方入参（不是支付单/订单上的字段，更不是 body）', async () => {
    const { svc, prisma } = setupPaymentService();

    await svc.createPayment(555n, { orderNo: 'SO20260908000001234', payMethod: PayChannel.MOCK });

    const arg = prisma.payment.create.mock.calls[0]?.[0] as { data: { userId: bigint } };
    expect(arg.data.userId).toBe(555n);
  });
});

describe('QA-3 状态机边界', () => {
  it('expireAt 恰好等于当前时刻 → 视为已超时，拒绝发起支付（31004）', async () => {
    const { svc, prisma } = setupPaymentService();
    const now = new Date();
    prisma.order.findFirst.mockResolvedValue(makeOrder({ expireAt: now }));

    await expect(
      svc.createPayment(1n, { orderNo: 'SO20260908000001234', payMethod: PayChannel.MOCK }),
    ).rejects.toMatchObject({ code: ErrorCode.ORDER_TIMEOUT_CLOSED });
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  it('订单已取消（CANCELLED）→ 拒绝发起支付（31002）', async () => {
    const { svc, prisma } = setupPaymentService();
    prisma.order.findFirst.mockResolvedValue(makeOrder({ status: OrderStatus.CANCELLED }));

    await expect(
      svc.createPayment(1n, { orderNo: 'SO20260908000001234', payMethod: PayChannel.MOCK }),
    ).rejects.toMatchObject({ code: ErrorCode.ORDER_STATUS_INVALID });
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  it('订单支付超时时间必须等于 config.order.payTimeoutMinutes（防硬编码与配置漂移）', async () => {
    const { svc, prisma, priceService } = setupOrderService();
    prisma.cartItem.findMany.mockResolvedValue([makeCartItem(2001n, 1, 10000n)]);
    priceService.calculate.mockResolvedValue(makePrice(10000n, 1));

    const before = Date.now();
    const result = await svc.createOrder(1n, { addressId: 1n, cartItemIds: [11n] });
    const after = Date.now();

    const expectedMinutes = buildConfigStub(false).config.order.payTimeoutMinutes;
    const minMs = before + expectedMinutes * 60_000;
    const maxMs = after + expectedMinutes * 60_000;
    expect(result.expireAt.getTime()).toBeGreaterThanOrEqual(minMs);
    expect(result.expireAt.getTime()).toBeLessThanOrEqual(maxMs);
  });
});

// ---------------------------------------------------------------------------
// 测试装配（与既有套件同构：假 Prisma + 假依赖 + 假 tx）
// ---------------------------------------------------------------------------

/** 假订单 */
function makeOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 9001n,
    orderNo: 'SO20260908000001234',
    userId: 1n,
    status: OrderStatus.PENDING_PAYMENT,
    payAmount: 12800n,
    expireAt: new Date(Date.now() + 30 * 60_000),
    ...overrides,
  };
}

/** 假支付单 */
function makePayment(overrides: Record<string, unknown> = {}) {
  return {
    paymentNo: 'PAY1',
    orderId: 9001n,
    orderNo: 'SO20260908000001234',
    bizNo: 'SO20260908000001234',
    amount: 12800n,
    status: PayStatus.PENDING,
    payUrl: '/payment/PAY1',
    expireAt: new Date(Date.now() + 30 * 60_000),
    channel: PayChannel.MOCK,
    ...overrides,
  };
}

/** 假地址 */
const FAKE_ADDRESS = {
  id: 1n,
  receiverName: '张三',
  phone: '13800138000',
  provinceName: '广东省',
  cityName: '深圳市',
  districtName: '南山区',
  detailAddress: '科技园路 1 号',
  tag: 'HOME',
};

/** 装配 OrderService（假 Prisma + 假库存 + 假计价） */
function setupOrderService() {
  const prisma = {
    address: { findFirst: jest.fn<AnyAsyncFn>() },
    cartItem: { findMany: jest.fn<AnyAsyncFn>(), deleteMany: jest.fn<AnyAsyncFn>() },
    order: { create: jest.fn<AnyAsyncFn>() },
    orderItem: { create: jest.fn<AnyAsyncFn>() },
    orderStatusLog: { create: jest.fn<AnyAsyncFn>() },
  };
  const stockService = { freeze: jest.fn<AnyAsyncFn>() };
  const priceService = { calculate: jest.fn<AnyAsyncFn>() };

  FAKE_TX = { __fakeTx: true, order: prisma.order, orderItem: prisma.orderItem, orderStatusLog: prisma.orderStatusLog, cartItem: prisma.cartItem };
  (withTransaction as unknown as jest.Mock<AnySyncFn>).mockImplementation(async (fn: AnyAsyncFn) => fn(FAKE_TX));

  prisma.address.findFirst.mockResolvedValue(FAKE_ADDRESS);
  prisma.order.create.mockResolvedValue({ id: 9001n });
  prisma.orderItem.create.mockResolvedValue({ id: 1n });
  prisma.orderStatusLog.create.mockResolvedValue({ id: 1n });
  prisma.cartItem.deleteMany.mockResolvedValue({ count: 1 });
  stockService.freeze.mockResolvedValue({ skuId: 2001n, changeQty: 1 });
  priceService.calculate.mockResolvedValue(makePrice(10000n, 1));

  const svc = new OrderService(
    prisma as never,
    stockService as never,
    priceService as never,
  );
  return { svc, prisma, stockService, priceService };
}

/** 装配 PaymentService（假 Prisma + 假库存） */
function setupPaymentService() {
  const prisma = {
    order: { findFirst: jest.fn<AnyAsyncFn>(), updateMany: jest.fn<AnyAsyncFn>() },
    orderItem: { findMany: jest.fn<AnyAsyncFn>() },
    orderStatusLog: { create: jest.fn<AnyAsyncFn>() },
    payment: {
      create: jest.fn<AnyAsyncFn>(),
      findUnique: jest.fn<AnyAsyncFn>(),
      findMany: jest.fn<AnyAsyncFn>(),
      updateMany: jest.fn<AnyAsyncFn>(),
    },
    /** 入账时查平台现金账户用（T061 记账接线后 handlePaidNotify 会用到） */
    fundAccount: { findFirst: jest.fn<AnyAsyncFn>() },
    /** 充值入账推进充值单用（T070-C） */
    rechargeOrder: { updateMany: jest.fn<AnyAsyncFn>() },
  };
  const stockService = { confirm: jest.fn<AnyAsyncFn>() };
  /** 假资金服务（T061 记账接线后 handlePaidNotify 会调用 credit；T070-C 起充值走双流水 + 自动开户） */
  const fundService = {
    credit: jest.fn<AnyAsyncFn>(),
    getOrCreateAccount: jest.fn<AnyAsyncFn>(),
  };

  FAKE_TX = {
    __fakeTx: true,
    order: prisma.order,
    orderItem: prisma.orderItem,
    orderStatusLog: prisma.orderStatusLog,
    payment: prisma.payment,
    fundAccount: prisma.fundAccount,
    rechargeOrder: prisma.rechargeOrder,
  };
  (withTransaction as unknown as jest.Mock<AnySyncFn>).mockImplementation(async (fn: AnyAsyncFn) => fn(FAKE_TX));

  prisma.order.findFirst.mockResolvedValue(makeOrder());
  prisma.order.updateMany.mockResolvedValue({ count: 1 });
  prisma.orderItem.findMany.mockResolvedValue([{ skuId: 2001n, quantity: 1 }]);
  prisma.orderStatusLog.create.mockResolvedValue({ id: 1n });
  prisma.payment.findMany.mockResolvedValue([]);
  prisma.payment.findUnique.mockResolvedValue(makePayment());
  prisma.payment.updateMany.mockResolvedValue({ count: 1 });
  prisma.payment.create.mockImplementation(
    async (args: { data: Record<string, unknown> }) => args.data,
  );
  stockService.confirm.mockResolvedValue({ skuId: 2001n, changeQty: -1 });
  // 平台现金账户由种子数据预置，默认存在
  prisma.fundAccount.findFirst.mockResolvedValue({ id: 7001n, accountNo: 'ACC_PLATFORM_CASH' });
  prisma.rechargeOrder.updateMany.mockResolvedValue({ count: 1 });
  fundService.credit.mockResolvedValue({
    txNo: 'FT2026090800000001',
    accountId: 7001n,
    accountNo: 'ACC_PLATFORM_CASH',
    direction: 'IN',
    amount: 12800n,
    beforeBalance: 0n,
    afterBalance: 12800n,
    duplicated: false,
  });
  // 用户余额账户（首充由 FundService 自动开户）
  fundService.getOrCreateAccount.mockResolvedValue({
    id: 8001n,
    accountNo: 'ACC_USER_BALANCE_1',
    accountType: 'USER_BALANCE',
    status: 'ACTIVE',
    balance: 0n,
    frozenBalance: 0n,
    version: 0,
  });

  const svc = new PaymentService(prisma as never, stockService as never, fundService as never);
  return { svc, prisma, stockService, fundService };
}

// `beforeEach` 在本文件只用于表达「每个用例前重置」的语义；
// 实际装配由 setupXxx() 完成（不同 describe 需要的依赖不同，集中 beforeEach 反而会让 mock 互相污染）
beforeEach(() => {
  jest.clearAllMocks();
});
