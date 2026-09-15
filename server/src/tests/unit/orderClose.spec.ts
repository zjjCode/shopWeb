/**
 * @file server/src/tests/unit/orderClose.spec.ts
 * @description 取消 / 超时关单（F8 / F10）单测：状态机跃迁 + 释放冻结库存 + 关闭待支付单 +
 *              解冻占用券（T041）+ 越权防护 + 幂等跳过；以及 closeTimeoutOrder job / scanExpiredOrders。
 * @module tests/unit
 * @see server/src/services/OrderService.ts（cancelByUser / cancelByAdmin / closeByTimeout）
 * @see server/src/services/OrderStateMachine.ts（transition：条件更新 + 轨迹落库）
 * @see server/src/jobs/handlers/closeTimeoutOrder.job.ts（closeTimeoutOrder / scanExpiredOrders）
 * @see docs/04-flows.md F8（取消订单）、F10（超时关单）
 * @author 软件开发团队
 * @created 2026-09-12
 *
 * 与 orderService.spec.ts 同一套「假 Prisma / 假库存 / 假券服务 / 假事务」打桩范式：不连真实 DB，
 * 验证「状态机条件跃迁 + 释放冻结库存 + 关闭待支付单 + 解冻券 + 越权防护 + 幂等跳过」这些 tsc 查不出的业务边界。
 *
 * ⚠️ 历史说明：本文件初版断言 `prisma.order.updateMany` + `orderStatusLog.create`（T051 旧实现）；
 * 当前 OrderService 已统一走 `transition`（状态机，内部完成条件更新 + 轨迹落库），故断言改为 `transition` 调用。
 * T041 接入后，关单 / 取消路径额外调用 `couponService.releaseByOrderNo` 解冻占用券（LOCKED→UNUSED）。
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { CancelReason, OperatorType, OrderStatus, PayStatus } from '@prisma/client';
import { ErrorCode } from '@/core/errors/errorCodes';
import { getPrisma } from '@/core/prisma';
import { withTransaction } from '@/core/transaction';
import { transition } from '@/services/OrderStateMachine';
import { OrderService, orderService } from '@/services/OrderService';
import type { CouponService } from '@/services/CouponService';
import type { PriceService } from '@/services/PriceService';
import type { StockService } from '@/services/StockService';

// config 在模块加载时校验环境变量，注入固定测试值
jest.mock('@/config', () => ({
  config: { env: 'test', redis: { keyPrefix: 'shop' }, log: { level: 'error', dir: '' } },
  isProduction: false,
  isTest: true,
  isDevelopment: false,
}));

// 单例在模块加载时调用 getPrisma()，用假实现避免建真实客户端
jest.mock('@/core/prisma', () => ({
  getPrisma: jest.fn(() => ({})),
}));

// 事务被接管：由测试决定「执行闭包并注入假 tx」
jest.mock('@/core/transaction', () => ({
  withTransaction: jest.fn(),
}));

// 状态机被接管：由测试决定 affected 行数（0 表示并发已变 / 幂等跳过）
jest.mock('@/services/OrderStateMachine', () => ({
  transition: jest.fn(),
}));

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyAsyncFn = (...args: any[]) => Promise<any>;
/* eslint-enable @typescript-eslint/no-explicit-any */

/** 事务闭包的假 tx（委托指向与注入同一批假实现，断言才能命中） */
let FAKE_TX: Record<string, unknown>;

describe('OrderService 取消 / 超时关单（F8 / F10，含券解冻 T041）', () => {
  /** 假 Prisma：只实现本任务涉及的委托 */
  let prisma: {
    order: { findFirst: jest.Mock<AnyAsyncFn> };
    orderItem: { findMany: jest.Mock<AnyAsyncFn> };
    payment: { updateMany: jest.Mock<AnyAsyncFn> };
  };
  /** 假库存服务 */
  let stockService: { release: jest.Mock<AnyAsyncFn> };
  /** 假券服务（T041：关单/取消时解冻占用券） */
  let couponService: { releaseByOrderNo: jest.Mock<AnyAsyncFn> };
  /** 假计价服务（构造注入，避免实例化真实实现） */
  let priceService: { calculate: jest.Mock<AnyAsyncFn> };
  /** 被测试对象 */
  let svc: OrderService;

  beforeEach(() => {
    jest.clearAllMocks();

    prisma = {
      order: { findFirst: jest.fn<AnyAsyncFn>() },
      orderItem: { findMany: jest.fn<AnyAsyncFn>() },
      payment: { updateMany: jest.fn<AnyAsyncFn>() },
    };
    stockService = { release: jest.fn<AnyAsyncFn>() };
    couponService = { releaseByOrderNo: jest.fn<AnyAsyncFn>() };
    priceService = { calculate: jest.fn<AnyAsyncFn>() };

    // 假 tx 的委托与注入的假实现同一个引用，保证「事务内写库」断言命中
    FAKE_TX = {
      orderItem: prisma.orderItem,
      payment: prisma.payment,
    };

    (withTransaction as unknown as jest.Mock<AnyAsyncFn>).mockImplementation(async (fn) =>
      fn(FAKE_TX),
    );
    // 状态机默认 affected=1（成功跃迁）；个别测试用 mockResolvedValueOnce(0) 模拟并发已变
    (transition as unknown as jest.Mock<AnyAsyncFn>).mockResolvedValue(1);

    prisma.order.findFirst.mockResolvedValue({ id: 9001n, status: OrderStatus.PENDING_PAYMENT });
    // 故意乱序返回：验证释放严格按 sku_id 升序（与冻结顺序一致，防死锁）
    prisma.orderItem.findMany.mockResolvedValue([
      { skuId: 2002n, quantity: 1 },
      { skuId: 2001n, quantity: 2 },
    ]);
    prisma.payment.updateMany.mockResolvedValue({ count: 1 });
    stockService.release.mockResolvedValue({ skuId: 2001n, changeQty: 2 });
    couponService.releaseByOrderNo.mockResolvedValue(undefined);

    svc = new OrderService(
      prisma as never,
      stockService as unknown as StockService,
      priceService as unknown as PriceService,
      couponService as unknown as CouponService,
    );
  });

  describe('closeByTimeout（F10 系统超时关单）', () => {
    it('PENDING_PAYMENT → CANCELLED：状态机跃迁 + 释放冻结(升序) + 关闭待支付单 + 解冻券，返回 skipped:false', async () => {
      const result = await svc.closeByTimeout('NO-TEST-1');

      expect(result).toEqual({ skipped: false });
      // ① 预筛：只查待支付
      expect(prisma.order.findFirst).toHaveBeenCalledWith({
        where: { orderNo: 'NO-TEST-1' },
        select: { id: true, status: true },
      });
      // ② 状态机条件跃迁（WHERE 带 fromStatus=PENDING_PAYMENT，内部完成更新 + 轨迹落库）
      expect(transition).toHaveBeenCalledTimes(1);
      expect(transition).toHaveBeenCalledWith(
        FAKE_TX,
        expect.objectContaining({
          orderId: 9001n,
          orderNo: 'NO-TEST-1',
          fromStatus: OrderStatus.PENDING_PAYMENT,
          toStatus: OrderStatus.CANCELLED,
          operatorType: OperatorType.SYSTEM,
          operatorId: 0n,
          reason: CancelReason.TIMEOUT,
        }),
      );
      // ③ 释放冻结库存：按 sku_id 升序查询（与冻结顺序一致，防死锁），并释放全部行
      expect(prisma.orderItem.findMany).toHaveBeenCalledWith({
        where: { orderId: 9001n },
        select: { skuId: true, quantity: true },
        orderBy: { skuId: 'asc' },
      });
      const releasedSkus = stockService.release.mock.calls.map(
        (c) => (c[0] as { skuId: bigint }).skuId,
      );
      expect([...releasedSkus].sort()).toEqual([2001n, 2002n]);
      // ④ 关闭关联待支付单
      expect(prisma.payment.updateMany).toHaveBeenCalledWith({
        where: { orderId: 9001n, status: PayStatus.PENDING },
        data: { status: PayStatus.CLOSED, closedAt: expect.any(Date) },
      });
      // ⑤ T041：解冻下单占用的券（LOCKED→UNUSED），无券记录则幂等跳过
      expect(couponService.releaseByOrderNo).toHaveBeenCalledWith('NO-TEST-1', FAKE_TX);
    });

    it('订单已不在待支付态（如 PAID）→ 幂等 skipped:true，零变更（绝不解冻券/释放库存）', async () => {
      prisma.order.findFirst.mockResolvedValue({ id: 9001n, status: OrderStatus.PAID });

      const result = await svc.closeByTimeout('NO-TEST-1');

      expect(result).toEqual({ skipped: true });
      expect(transition).not.toHaveBeenCalled();
      expect(stockService.release).not.toHaveBeenCalled();
      expect(prisma.payment.updateMany).not.toHaveBeenCalled();
      expect(couponService.releaseByOrderNo).not.toHaveBeenCalled();
    });

    it('订单不存在 → 幂等 skipped:true，解冻券不被调用', async () => {
      prisma.order.findFirst.mockResolvedValue(null);

      const result = await svc.closeByTimeout('NO-NOT-EXIST');

      expect(result).toEqual({ skipped: true });
      expect(transition).not.toHaveBeenCalled();
      expect(couponService.releaseByOrderNo).not.toHaveBeenCalled();
    });

    it('并发已变（状态机 affected=0）→ 幂等 skipped:true，绝不重复释放库存 / 解冻券', async () => {
      (transition as unknown as jest.Mock<AnyAsyncFn>).mockResolvedValueOnce(0);

      const result = await svc.closeByTimeout('NO-TEST-1');

      expect(result).toEqual({ skipped: true });
      // 状态机确实被调用了（只是 affected=0 表示并发已变），但后续副作用不得执行
      expect(transition).toHaveBeenCalledTimes(1);
      expect(stockService.release).not.toHaveBeenCalled();
      expect(prisma.payment.updateMany).not.toHaveBeenCalled();
      expect(couponService.releaseByOrderNo).not.toHaveBeenCalled();
    });
  });

  describe('cancelByUser（F8 路径 1：C 端用户取消待支付单）', () => {
    it('成功取消：where 带 userId，状态机 + 释放冻结 + 关闭待支付单 + 解冻券', async () => {
      await svc.cancelByUser(1n, 'NO-TEST-1', '不想买了');

      // 越权防护：查询 where 必须带 userId
      expect(prisma.order.findFirst).toHaveBeenCalledWith({
        where: { orderNo: 'NO-TEST-1', userId: 1n },
        select: { id: true, status: true },
      });
      expect(transition).toHaveBeenCalledWith(
        FAKE_TX,
        expect.objectContaining({
          orderId: 9001n,
          fromStatus: OrderStatus.PENDING_PAYMENT,
          toStatus: OrderStatus.CANCELLED,
          operatorType: OperatorType.USER,
          operatorId: 1n,
          // 显式 reason（'不想买了'）覆盖到 transition.reason；取消原因常量在 extraData.cancelReason
          extraData: expect.objectContaining({ cancelReason: CancelReason.USER_CANCEL }),
        }),
      );
      expect(stockService.release).toHaveBeenCalled();
      expect(prisma.payment.updateMany).toHaveBeenCalled();
      // T041：解冻下单占用的券
      expect(couponService.releaseByOrderNo).toHaveBeenCalledWith('NO-TEST-1', FAKE_TX);
    });

    it('越权（错误 userId）：findFirst 返回 null → 31001，不泄露订单是否存在', async () => {
      prisma.order.findFirst.mockResolvedValue(null);

      await expect(svc.cancelByUser(999n, 'NO-TEST-1')).rejects.toMatchObject({
        code: ErrorCode.ORDER_NOT_FOUND,
      });
      expect(transition).not.toHaveBeenCalled();
      expect(couponService.releaseByOrderNo).not.toHaveBeenCalled();
    });

    it('已支付订单取消 → 31002（本期仅允许待支付取消，已支付需走退款 F9）', async () => {
      prisma.order.findFirst.mockResolvedValue({ id: 9001n, status: OrderStatus.PAID });

      await expect(svc.cancelByUser(1n, 'NO-TEST-1')).rejects.toMatchObject({
        code: ErrorCode.ORDER_STATUS_INVALID,
      });
      expect(transition).not.toHaveBeenCalled();
      expect(couponService.releaseByOrderNo).not.toHaveBeenCalled();
    });
  });

  describe('cancelByAdmin（F8 路径 3 子集：管理员取消待支付单）', () => {
    it('成功取消：where 不带 userId（管理员越权校验由路由 scope 负责）+ 解冻券', async () => {
      await svc.cancelByAdmin(7n, 'NO-TEST-1');

      expect(prisma.order.findFirst).toHaveBeenCalledWith({
        where: { orderNo: 'NO-TEST-1' },
        select: { id: true, status: true },
      });
      expect(transition).toHaveBeenCalledWith(
        FAKE_TX,
        expect.objectContaining({
          fromStatus: OrderStatus.PENDING_PAYMENT,
          toStatus: OrderStatus.CANCELLED,
          operatorType: OperatorType.ADMIN,
          operatorId: 7n,
          reason: CancelReason.ADMIN_CANCEL,
        }),
      );
      expect(stockService.release).toHaveBeenCalled();
      expect(prisma.payment.updateMany).toHaveBeenCalled();
      // T041：解冻下单占用的券
      expect(couponService.releaseByOrderNo).toHaveBeenCalledWith('NO-TEST-1', FAKE_TX);
    });
  });
});

describe('closeTimeoutOrder job + scanExpiredOrders（F7.2 / F10）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('closeTimeoutOrder job：透传 orderService.closeByTimeout 的结果', async () => {
    const spy = jest
      .spyOn(orderService, 'closeByTimeout')
      .mockResolvedValue({ skipped: false });

    const { closeTimeoutOrder } = await import('@/jobs/handlers/closeTimeoutOrder.job');
    const result = await closeTimeoutOrder('NO-TEST-1');

    expect(spy).toHaveBeenCalledWith('NO-TEST-1');
    expect(result).toEqual({ skipped: false });
    spy.mockRestore();
  });

  it('scanExpiredOrders：扫描 PENDING_PAYMENT + expireAt<now，按 id 升序返回订单号', async () => {
    const fakePrisma = {
      order: {
        findMany: jest.fn<AnyAsyncFn>().mockResolvedValue([{ orderNo: 'A' }, { orderNo: 'B' }]),
      },
    };
    (getPrisma as unknown as jest.Mock).mockReturnValue(fakePrisma);

    const { scanExpiredOrders } = await import('@/jobs/handlers/closeTimeoutOrder.job');
    const result = await scanExpiredOrders(10);

    expect(result).toEqual(['A', 'B']);
    expect(fakePrisma.order.findMany).toHaveBeenCalledWith({
      where: { status: OrderStatus.PENDING_PAYMENT, expireAt: { lt: expect.any(Date) } },
      select: { orderNo: true },
      orderBy: { id: 'asc' },
      take: 10,
    });
  });
});
