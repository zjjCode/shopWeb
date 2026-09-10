/**
 * @file server/src/tests/unit/orderService.spec.ts
 * @description 下单服务（事务 A）单测：假 Prisma / 假库存 / 假计价驱动，不连真实 DB
 * @module tests/unit
 * @see server/src/services/OrderService.ts、docs/04-flows.md F5（363-536 行）
 * @author 软件开发团队
 * @created 2026-09-07
 *
 * 为什么必须有单测：环境无 MySQL 实例，而下单是**全系统最关键的事务**。
 * 下面这些规则一旦写错就是资金或库存事故，且 tsc 完全查不出来：
 * - 金额必须来自 `PriceService` 重算，绝不能用购物车快照价；
 * - 库存冻结必须在事务内（要拿到 `tx`），否则建单失败时库存回不去；
 * - 多 SKU 冻结必须按 `sku_id` 升序，否则并发下单会死锁；
 * - 收货地址 / 购物车 / 清理条目都必须带 `userId`，否则是越权漏洞。
 *
 * 边界说明：**真实回滚行为由 MySQL 事务保证，单元层无法验证**。
 * 本套件验证的是「代码是否把写操作放在了事务闭包内、失败时是否在建单前中止」，
 * 这是单元层能且必须守住的边界；DB 层回滚待集成测试验证。
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ProductStatus, SkuStatus } from '@prisma/client';
import { ConflictError } from '@/core/errors';
import { ErrorCode } from '@/core/errors/errorCodes';
import { withTransaction } from '@/core/transaction';
import { OrderService, type CreateOrderInput } from '@/services/OrderService';
import type { PriceResult, PriceService } from '@/services/PriceService';
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
 * @description `OrderService` 在事务内一律通过 `tx.xxx` 写库（不是外部单例），
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

/** 构造计价结果（真实运费规则：满 9900 包邮，否则 1200） */
function makePrice(rows: { skuId: bigint; quantity: number; unitPrice: bigint }[]): PriceResult {
  const items = rows.map((r) => {
    const goodsAmount = r.unitPrice * BigInt(r.quantity);
    return {
      skuId: r.skuId,
      quantity: r.quantity,
      unitPrice: r.unitPrice,
      goodsAmount,
      promoDiscount: 0n,
      allocatedDiscount: 0n,
      payableAmount: goodsAmount,
    };
  });
  const goodsAmount = items.reduce((acc, it) => acc + it.goodsAmount, 0n);
  const freightAmount = goodsAmount >= 9900n ? 0n : 1200n;
  return {
    goodsAmount,
    rowPromoDiscount: 0n,
    orderPromoDiscount: 0n,
    couponDiscount: 0n,
    pointDeductAmount: 0n,
    freightAmount,
    payAmount: goodsAmount + freightAmount,
    items,
  };
}

/** 构造一条购物车条目（含 SKU → 商品快照） */
function makeCartItem(
  id: bigint,
  skuId: bigint,
  quantity: number,
  overrides: { skuStatus?: SkuStatus; productStatus?: ProductStatus } = {},
) {
  return {
    id,
    skuId,
    quantity,
    sku: {
      id: skuId,
      productId: skuId + 1000n,
      skuCode: `SKU-${skuId}`,
      specDigest: '颜色:陨石黑',
      imageUrl: null,
      price: 10000n,
      originalPrice: null,
      status: overrides.skuStatus ?? SkuStatus.ENABLED,
      product: {
        id: skuId + 1000n,
        name: '测试商品',
        mainImage: '/img/main.jpg',
        status: overrides.productStatus ?? ProductStatus.ON_SALE,
      },
    },
  };
}

/** 假地址（字段对齐 Address 模型） */
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

describe('OrderService 下单（事务 A）', () => {
  /** 假 Prisma：只实现 OrderService 用到的委托 */
  let prisma: {
    address: { findFirst: jest.Mock<AnyAsyncFn> };
    cartItem: { findMany: jest.Mock<AnyAsyncFn>; deleteMany: jest.Mock<AnyAsyncFn> };
    order: { create: jest.Mock<AnyAsyncFn> };
    orderItem: { create: jest.Mock<AnyAsyncFn> };
    orderStatusLog: { create: jest.Mock<AnyAsyncFn> };
  };
  /** 假库存服务 */
  let stockService: { freeze: jest.Mock<AnyAsyncFn> };
  /** 假计价服务 */
  let priceService: { calculate: jest.Mock<AnyAsyncFn> };
  /** 被测试对象 */
  let svc: OrderService;

  beforeEach(() => {
    jest.clearAllMocks();

    prisma = {
      address: { findFirst: jest.fn<AnyAsyncFn>() },
      cartItem: { findMany: jest.fn<AnyAsyncFn>(), deleteMany: jest.fn<AnyAsyncFn>() },
      order: { create: jest.fn<AnyAsyncFn>() },
      orderItem: { create: jest.fn<AnyAsyncFn>() },
      orderStatusLog: { create: jest.fn<AnyAsyncFn>() },
    };
    stockService = { freeze: jest.fn<AnyAsyncFn>() };
    priceService = { calculate: jest.fn<AnyAsyncFn>() };

    // 假 tx 的委托指向同一批假实现，保证「事务内写库」的断言能命中
    FAKE_TX = {
      __fakeTx: true,
      order: prisma.order,
      orderItem: prisma.orderItem,
      orderStatusLog: prisma.orderStatusLog,
      cartItem: prisma.cartItem,
    };

    // 默认：事务正常执行闭包并注入假 tx
    (withTransaction as unknown as jest.Mock<AnyAsyncFn>).mockImplementation(async (fn) =>
      fn(FAKE_TX),
    );

    prisma.address.findFirst.mockResolvedValue(FAKE_ADDRESS);
    prisma.order.create.mockResolvedValue({ id: 9001n });
    prisma.orderItem.create.mockResolvedValue({ id: 1n });
    prisma.orderStatusLog.create.mockResolvedValue({ id: 1n });
    prisma.cartItem.deleteMany.mockResolvedValue({ count: 1 });
    stockService.freeze.mockResolvedValue({ skuId: 2001n, changeQty: 1 });
    priceService.calculate.mockResolvedValue(makePrice([{ skuId: 2001n, quantity: 1, unitPrice: 10000n }]));

    svc = new OrderService(
      prisma as never,
      stockService as unknown as StockService,
      priceService as unknown as PriceService,
    );
  });

  /** 基础下单入参 */
  const baseInput: CreateOrderInput = { addressId: 1n, cartItemIds: [11n] };

  it('正常下单成功：返回 orderNo 与应付金额，且应付金额来自 PriceService 重算', async () => {
    prisma.cartItem.findMany.mockResolvedValue([makeCartItem(11n, 2001n, 1)]);
    const price = makePrice([{ skuId: 2001n, quantity: 1, unitPrice: 10000n }]);
    priceService.calculate.mockResolvedValue(price);

    const result = await svc.createOrder(1n, baseInput);

    expect(result.orderNo).toEqual(expect.any(String));
    expect(result.payAmount).toBe(price.payAmount);
    expect(result.expireAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('金额服务端重算：即使购物车快照价被篡改成 1 分，订单金额仍以重算价为准', async () => {
    prisma.cartItem.findMany.mockResolvedValue([makeCartItem(11n, 2001n, 1)]);
    // 服务端重算：单价 100 元 × 1 件 = 10000 分，满 99 包邮 → 应付 10000
    const price = makePrice([{ skuId: 2001n, quantity: 1, unitPrice: 10000n }]);
    priceService.calculate.mockResolvedValue(price);

    const result = await svc.createOrder(1n, baseInput);

    // 关键：订单写入的金额必须等于重算值，与购物车 priceSnapshot（此处刻意不参与）无关
    expect(result.payAmount).toBe(10000n);
    const orderCreateArg = prisma.order.create.mock.calls[0]?.[0] as { data: { payAmount: bigint } };
    expect(orderCreateArg.data.payAmount).toBe(10000n);
  });

  it('地址越权防护：查询 where 必须同时带 id / userId / deletedAt:null', async () => {
    prisma.cartItem.findMany.mockResolvedValue([makeCartItem(11n, 2001n, 1)]);

    await svc.createOrder(1n, baseInput);

    const arg = prisma.address.findFirst.mock.calls[0]?.[0] as {
      where: { id: bigint; userId: bigint; deletedAt: null };
    };
    expect(arg.where.id).toBe(1n);
    expect(arg.where.userId).toBe(1n); // 漏了就是越权漏洞
    expect(arg.where.deletedAt).toBeNull();
  });

  it('地址不属于当前用户 → 拒绝下单（11001）', async () => {
    prisma.address.findFirst.mockResolvedValue(null);
    prisma.cartItem.findMany.mockResolvedValue([makeCartItem(11n, 2001n, 1)]);

    await expect(svc.createOrder(1n, baseInput)).rejects.toMatchObject({
      code: ErrorCode.ADDRESS_NOT_FOUND,
    });
    expect(prisma.order.create).not.toHaveBeenCalled();
  });

  it('购物车条目缺失（有条目被删或不属于该用户）→ 拒绝下单（30005），绝不静默少结算', async () => {
    // 请求 2 个条目，只查到 1 个
    prisma.cartItem.findMany.mockResolvedValue([makeCartItem(11n, 2001n, 1)]);

    await expect(svc.createOrder(1n, { addressId: 1n, cartItemIds: [11n, 12n] })).rejects.toMatchObject({
      code: ErrorCode.CART_HAS_INVALID_ITEMS,
    });
    expect(prisma.order.create).not.toHaveBeenCalled();
  });

  it('购物车查询只命中已勾选且属该用户的条目', async () => {
    prisma.cartItem.findMany.mockResolvedValue([makeCartItem(11n, 2001n, 1)]);

    await svc.createOrder(1n, baseInput);

    const arg = prisma.cartItem.findMany.mock.calls[0]?.[0] as {
      where: { id: { in: bigint[] }; userId: bigint; selected: boolean };
    };
    expect(arg.where.id.in).toEqual([11n]);
    expect(arg.where.userId).toBe(1n);
    expect(arg.where.selected).toBe(true);
  });

  it('空结算列表 → 拒绝下单（30005）', async () => {
    await expect(svc.createOrder(1n, { addressId: 1n, cartItemIds: [] })).rejects.toMatchObject({
      code: ErrorCode.CART_HAS_INVALID_ITEMS,
    });
  });

  it('商品已下架 → 拒绝下单（21001）', async () => {
    prisma.cartItem.findMany.mockResolvedValue([
      makeCartItem(11n, 2001n, 1, { productStatus: ProductStatus.OFF_SALE }),
    ]);

    await expect(svc.createOrder(1n, baseInput)).rejects.toMatchObject({
      code: ErrorCode.PRODUCT_NOT_FOUND,
    });
    expect(prisma.order.create).not.toHaveBeenCalled();
  });

  it('SKU 已禁用 → 拒绝下单（21002）', async () => {
    prisma.cartItem.findMany.mockResolvedValue([
      makeCartItem(11n, 2001n, 1, { skuStatus: SkuStatus.DISABLED }),
    ]);

    await expect(svc.createOrder(1n, baseInput)).rejects.toMatchObject({
      code: ErrorCode.SKU_NOT_FOUND,
    });
  });

  it('数量越界（0 件）→ 拒绝下单（30002）', async () => {
    prisma.cartItem.findMany.mockResolvedValue([makeCartItem(11n, 2001n, 0)]);

    await expect(svc.createOrder(1n, baseInput)).rejects.toMatchObject({
      code: ErrorCode.CART_QUANTITY_INVALID,
    });
  });

  it('数量越界（超过 999）→ 拒绝下单（30003）', async () => {
    prisma.cartItem.findMany.mockResolvedValue([makeCartItem(11n, 2001n, 1000)]);

    await expect(svc.createOrder(1n, baseInput)).rejects.toMatchObject({
      code: ErrorCode.CART_ITEM_QUANTITY_LIMIT,
    });
  });

  it('库存冻结必须在事务内：freeze 收到的 tx 不能是 undefined', async () => {
    prisma.cartItem.findMany.mockResolvedValue([makeCartItem(11n, 2001n, 1)]);

    await svc.createOrder(1n, baseInput);

    const txArg = stockService.freeze.mock.calls[0]?.[1];
    expect(txArg).toBeDefined();
    expect(txArg).toBe(FAKE_TX); // 必须是事务闭包内的 tx，不是外部单例
  });

  it('多 SKU 冻结严格按 sku_id 升序（防并发死锁）', async () => {
    // 故意乱序返回：先 3001 后 2001
    prisma.cartItem.findMany.mockResolvedValue([
      makeCartItem(11n, 3001n, 1),
      makeCartItem(12n, 2001n, 1),
    ]);
    priceService.calculate.mockResolvedValue(
      makePrice([
        { skuId: 3001n, quantity: 1, unitPrice: 5000n },
        { skuId: 2001n, quantity: 1, unitPrice: 5000n },
      ]),
    );

    await svc.createOrder(1n, { addressId: 1n, cartItemIds: [11n, 12n] });

    const frozenOrder = stockService.freeze.mock.calls.map(
      (c) => (c[0] as { skuId: bigint }).skuId,
    );
    expect(frozenOrder).toEqual([2001n, 3001n]); // 升序，不是购物车返回顺序
  });

  it('库存不足 → 事务内中断，绝不建单（已冻结的其它 SKU 由 DB 事务回滚）', async () => {
    prisma.cartItem.findMany.mockResolvedValue([makeCartItem(11n, 2001n, 1)]);
    stockService.freeze.mockRejectedValue(
      new ConflictError('库存不足', { code: ErrorCode.STOCK_NOT_ENOUGH }),
    );

    await expect(svc.createOrder(1n, baseInput)).rejects.toMatchObject({
      code: ErrorCode.STOCK_NOT_ENOUGH,
    });

    // 关键：库存失败后绝不能建单（否则就是「没库存却生成待支付订单」的资金事故）
    expect(prisma.order.create).not.toHaveBeenCalled();
    expect(prisma.orderItem.create).not.toHaveBeenCalled();
    expect(prisma.orderStatusLog.create).not.toHaveBeenCalled();
    expect(prisma.cartItem.deleteMany).not.toHaveBeenCalled();
  });

  it('清理已结算购物车条目时 where 带 userId（防越权删别人的条目）', async () => {
    prisma.cartItem.findMany.mockResolvedValue([makeCartItem(11n, 2001n, 1)]);

    await svc.createOrder(1n, baseInput);

    const arg = prisma.cartItem.deleteMany.mock.calls[0]?.[0] as {
      where: { id: { in: bigint[] }; userId: bigint };
    };
    expect(arg.where.id.in).toEqual([11n]);
    expect(arg.where.userId).toBe(1n);
  });

  it('订单行写入的是服务端重算单价与分摊结果，不是购物车快照价', async () => {
    prisma.cartItem.findMany.mockResolvedValue([makeCartItem(11n, 2001n, 2)]);
    const price = makePrice([{ skuId: 2001n, quantity: 2, unitPrice: 8000n }]);
    priceService.calculate.mockResolvedValue(price);

    await svc.createOrder(1n, baseInput);

    const arg = prisma.orderItem.create.mock.calls[0]?.[0] as {
      data: { unitPrice: bigint; quantity: number; goodsAmount: bigint; payableAmount: bigint };
    };
    expect(arg.data.unitPrice).toBe(8000n);
    expect(arg.data.quantity).toBe(2);
    expect(arg.data.goodsAmount).toBe(16000n);
    expect(arg.data.payableAmount).toBe(16000n);
  });

  it('订单状态轨迹：fromStatus 为 NULL，toStatus 为 PENDING_PAYMENT', async () => {
    prisma.cartItem.findMany.mockResolvedValue([makeCartItem(11n, 2001n, 1)]);

    await svc.createOrder(1n, baseInput);

    const arg = prisma.orderStatusLog.create.mock.calls[0]?.[0] as {
      data: { fromStatus: string | null; toStatus: string; operatorType: string; operatorId: bigint };
    };
    expect(arg.data.fromStatus).toBeNull();
    expect(arg.data.toStatus).toBe('PENDING_PAYMENT');
    expect(arg.data.operatorType).toBe('USER');
    expect(arg.data.operatorId).toBe(1n);
  });

  it('地址在下单时固化为快照（删改原地址不影响历史订单）', async () => {
    prisma.cartItem.findMany.mockResolvedValue([makeCartItem(11n, 2001n, 1)]);

    await svc.createOrder(1n, baseInput);

    const arg = prisma.order.create.mock.calls[0]?.[0] as {
      data: { receiverName: string; receiverPhone: string; receiverProvince: string };
    };
    expect(arg.data.receiverName).toBe('张三');
    expect(arg.data.receiverPhone).toBe('13800138000');
    expect(arg.data.receiverProvince).toBe('广东省');
  });

  it('金额恒等式不成立（计价引擎返回矛盾数据）→ 拒绝下单（31003）', async () => {
    prisma.cartItem.findMany.mockResolvedValue([makeCartItem(11n, 2001n, 1)]);
    const price = makePrice([{ skuId: 2001n, quantity: 1, unitPrice: 10000n }]);
    // 人为破坏 E1：应付金额不等于「商品 - 优惠 + 运费」
    price.payAmount = 1n;
    priceService.calculate.mockResolvedValue(price);

    await expect(svc.createOrder(1n, baseInput)).rejects.toMatchObject({
      code: ErrorCode.ORDER_AMOUNT_INVALID,
    });
    expect(prisma.order.create).not.toHaveBeenCalled();
  });

  it('行实付合计 + 运费 != 应付（E7 被破坏）→ 拒绝下单（31003）', async () => {
    prisma.cartItem.findMany.mockResolvedValue([makeCartItem(11n, 2001n, 1)]);
    const price = makePrice([{ skuId: 2001n, quantity: 1, unitPrice: 10000n }]);
    // 商品 10000（满 99 包邮 → 运费 0、应付 10000），但把行实付改成 5000 破坏 E7
    price.items[0]!.payableAmount = 5000n;
    priceService.calculate.mockResolvedValue(price);

    await expect(svc.createOrder(1n, baseInput)).rejects.toMatchObject({
      code: ErrorCode.ORDER_AMOUNT_INVALID,
    });
    expect(prisma.order.create).not.toHaveBeenCalled();
  });
});
