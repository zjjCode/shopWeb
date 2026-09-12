/**
 * @file server/src/tests/unit/orderShip.spec.ts
 * @description 发货 / 确认收货 / 自动确认（F10）单测：状态机跃迁 + 物流/自动确认时间 + 越权防护 + 幂等 + 事件
 * @module tests/unit
 * @see server/src/services/OrderService.ts（ship / confirmReceipt / autoConfirm / scanReceivableOrders）
 * @see server/src/jobs/handlers/autoConfirmReceipt.job.ts（autoConfirmReceipt / scanReceivableOrders）
 * @see docs/04-flows.md F10（发货与确认收货）
 * @author 软件开发团队
 * @created 2026-09-12
 *
 * 与 orderClose.spec.ts 同一套「假 Prisma / 假事务」打桩范式：不连真实 DB，验证
 * 「条件更新跃迁 + 物流/自动确认时间窗 + 越权防护 + 幂等跳过 + 订单完成事件」这些 tsc 查不出的业务边界。
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { OrderStatus } from '@prisma/client';
import { ErrorCode } from '@/core/errors/errorCodes';
import * as eventBus from '@/core/eventBus';
import { getPrisma } from '@/core/prisma';
import { withTransaction } from '@/core/transaction';
import { OrderService, orderService } from '@/services/OrderService';
import type { StockService } from '@/services/StockService';

// config 在模块加载时校验环境变量，注入固定测试值（env=test → 不投递延迟 job）
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

// 事件总线：仅验证「确认收货后触发 order.completed」，不依赖真实监听器
jest.mock('@/core/eventBus', () => ({
  emit: jest.fn(() => false),
}));

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyAsyncFn = (...args: any[]) => Promise<any>;
/* eslint-enable @typescript-eslint/no-explicit-any */

/** 事务闭包的假 tx（委托指向与注入同一批假实现，断言才能命中） */
let FAKE_TX: Record<string, unknown>;

describe('OrderService 发货 / 确认收货 / 自动确认（F10）', () => {
  /** 假 Prisma：只实现本任务涉及的委托 */
  let prisma: {
    order: {
      findFirst: jest.Mock<AnyAsyncFn>;
      updateMany: jest.Mock<AnyAsyncFn>;
      findMany: jest.Mock<AnyAsyncFn>;
    };
    orderStatusLog: { create: jest.Mock<AnyAsyncFn> };
  };
  /** 假库存服务（本任务方法不触碰，保留以满足构造签名） */
  let stockService: { release: jest.Mock<AnyAsyncFn> };
  /** 被测试对象 */
  let svc: OrderService;

  beforeEach(() => {
    jest.clearAllMocks();

    prisma = {
      order: {
        findFirst: jest.fn<AnyAsyncFn>(),
        updateMany: jest.fn<AnyAsyncFn>(),
        findMany: jest.fn<AnyAsyncFn>(),
      },
      orderStatusLog: { create: jest.fn<AnyAsyncFn>() },
    };
    stockService = { release: jest.fn<AnyAsyncFn>() };

    // 假 tx 的委托与注入的假实现同一个引用，保证「事务内写库」断言命中
    FAKE_TX = {
      order: prisma.order,
      orderStatusLog: prisma.orderStatusLog,
    };

    (withTransaction as unknown as jest.Mock<AnyAsyncFn>).mockImplementation(async (fn) =>
      fn(FAKE_TX),
    );

    prisma.order.findFirst.mockResolvedValue({ id: 9001n, status: OrderStatus.PENDING_PAYMENT });
    prisma.order.updateMany.mockResolvedValue({ count: 1 });
    prisma.order.findMany.mockResolvedValue([]);
    prisma.orderStatusLog.create.mockResolvedValue({ id: 1n });

    svc = new OrderService(
      prisma as never,
      stockService as unknown as StockService,
    );
  });

  describe('ship（F10 ① 管理员发货）', () => {
    const dto = { companyCode: 'SF', companyName: '顺丰速运', trackingNo: 'SF123456', remark: '尽快送达' };

    it('PAID → SHIPPED：条件更新 + 写物流 + autoConfirmAt(15d) + 轨迹', async () => {
      prisma.order.findFirst.mockResolvedValue({ id: 9001n, status: OrderStatus.PAID });
      await svc.ship(7n, 'NO-TEST-1', dto);

      // 预筛：只查订单号（管理员不校验归属）
      expect(prisma.order.findFirst).toHaveBeenCalledWith({
        where: { orderNo: 'NO-TEST-1' },
        select: { id: true, status: true },
      });
      // 条件更新 WHERE 带 orderNo + PAID
      const upd = prisma.order.updateMany.mock.calls[0][0];
      expect(upd.where).toEqual({ orderNo: 'NO-TEST-1', status: OrderStatus.PAID });
      expect(upd.data.status).toBe(OrderStatus.SHIPPED);
      expect(upd.data.logisticsCompanyCode).toBe('SF');
      expect(upd.data.logisticsCompanyName).toBe('顺丰速运');
      expect(upd.data.logisticsNo).toBe('SF123456');
      expect(upd.data.shippedAt).toBeInstanceOf(Date);
      expect(upd.data.autoConfirmAt).toBeInstanceOf(Date);
      // autoConfirmAt = shippedAt + 15 天
      expect(
        (upd.data.autoConfirmAt as Date).getTime() - (upd.data.shippedAt as Date).getTime(),
      ).toBe(15 * 86_400_000);
      // 轨迹
      expect(prisma.orderStatusLog.create).toHaveBeenCalledTimes(1);
    });

    it('订单不存在 → 31001', async () => {
      prisma.order.findFirst.mockResolvedValue(null);

      await expect(svc.ship(7n, 'NO-NOT-EXIST', dto)).rejects.toMatchObject({
        code: ErrorCode.ORDER_NOT_FOUND,
      });
      expect(prisma.order.updateMany).not.toHaveBeenCalled();
    });

    it('非 PAID（如 SHIPPED）→ 31002（仅已支付可发货）', async () => {
      prisma.order.findFirst.mockResolvedValue({ id: 9001n, status: OrderStatus.SHIPPED });

      await expect(svc.ship(7n, 'NO-TEST-1', dto)).rejects.toMatchObject({
        code: ErrorCode.ORDER_STATUS_INVALID,
      });
      expect(prisma.order.updateMany).not.toHaveBeenCalled();
    });

    it('并发已变（updateMany count=0）→ 幂等跳过，不写轨迹、不抛错', async () => {
      prisma.order.findFirst.mockResolvedValue({ id: 9001n, status: OrderStatus.PAID });
      prisma.order.updateMany.mockResolvedValue({ count: 0 });

      await svc.ship(7n, 'NO-TEST-1', dto);

      expect(prisma.orderStatusLog.create).not.toHaveBeenCalled();
    });
  });

  describe('confirmReceipt（F10 ③ 用户确认收货）', () => {
    it('SHIPPED → COMPLETED：条件更新 + completedAt + afterSaleExpireAt(7d) + emit order.completed', async () => {
      prisma.order.findFirst.mockResolvedValue({
        id: 9001n,
        status: OrderStatus.SHIPPED,
        userId: 1n,
        payAmount: 100n,
      });
      await svc.confirmReceipt(1n, 'NO-TEST-1');

      // 越权防护：查询 where 必须带 userId
      expect(prisma.order.findFirst).toHaveBeenCalledWith({
        where: { orderNo: 'NO-TEST-1', userId: 1n },
        select: { id: true, status: true, userId: true, payAmount: true },
      });
      const upd = prisma.order.updateMany.mock.calls[0][0];
      expect(upd.where).toEqual({ orderNo: 'NO-TEST-1', status: OrderStatus.SHIPPED });
      expect(upd.data.status).toBe(OrderStatus.COMPLETED);
      expect(upd.data.completedAt).toBeInstanceOf(Date);
      expect(upd.data.afterSaleExpireAt).toBeInstanceOf(Date);
      // afterSaleExpireAt = completedAt + 7 天（售后期）
      expect(
        (upd.data.afterSaleExpireAt as Date).getTime() - (upd.data.completedAt as Date).getTime(),
      ).toBe(7 * 86_400_000);
      expect(prisma.orderStatusLog.create).toHaveBeenCalledTimes(1);
      // 积分发放钩子（一期空实现，但事件必须发出）
      expect(eventBus.emit).toHaveBeenCalledWith(
        'order.completed',
        expect.objectContaining({
          orderNo: 'NO-TEST-1',
          userId: 1,
          orderId: 9001,
          payAmount: 100,
        }),
      );
    });

    it('越权（错误 userId）：findFirst 返回 null → 31001，不泄露订单是否存在', async () => {
      prisma.order.findFirst.mockResolvedValue(null);

      await expect(svc.confirmReceipt(999n, 'NO-TEST-1')).rejects.toMatchObject({
        code: ErrorCode.ORDER_NOT_FOUND,
      });
      expect(prisma.order.updateMany).not.toHaveBeenCalled();
      expect(eventBus.emit).not.toHaveBeenCalled();
    });

    it('非 SHIPPED（如 PAID）→ 31002', async () => {
      prisma.order.findFirst.mockResolvedValue({
        id: 9001n,
        status: OrderStatus.PAID,
        userId: 1n,
        payAmount: 100n,
      });

      await expect(svc.confirmReceipt(1n, 'NO-TEST-1')).rejects.toMatchObject({
        code: ErrorCode.ORDER_STATUS_INVALID,
      });
      expect(prisma.order.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('autoConfirm（F10 ④ 系统自动确认）', () => {
    it('SHIPPED → COMPLETED：条件更新 + 写轨迹，返回 skipped:false', async () => {
      prisma.order.findFirst.mockResolvedValue({ id: 9001n, status: OrderStatus.SHIPPED });

      const result = await svc.autoConfirm('NO-TEST-1');

      expect(result).toEqual({ skipped: false });
      const upd = prisma.order.updateMany.mock.calls[0][0];
      expect(upd.where).toEqual({ orderNo: 'NO-TEST-1', status: OrderStatus.SHIPPED });
      expect(upd.data.status).toBe(OrderStatus.COMPLETED);
      expect(prisma.orderStatusLog.create).toHaveBeenCalledTimes(1);
    });

    it('已非 SHIPPED（如 COMPLETED）→ 幂等 skipped:true，零变更', async () => {
      prisma.order.findFirst.mockResolvedValue({ id: 9001n, status: OrderStatus.COMPLETED });

      const result = await svc.autoConfirm('NO-TEST-1');

      expect(result).toEqual({ skipped: true });
      expect(prisma.order.updateMany).not.toHaveBeenCalled();
    });

    it('订单不存在 → 幂等 skipped:true', async () => {
      prisma.order.findFirst.mockResolvedValue(null);

      const result = await svc.autoConfirm('NO-NOT-EXIST');

      expect(result).toEqual({ skipped: true });
      expect(prisma.order.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('scanReceivableOrders（F7.2 / F10 兜底扫描）', () => {
    it('扫描 SHIPPED + autoConfirmAt<now，按 id 升序返回订单号', async () => {
      prisma.order.findMany.mockResolvedValue([{ orderNo: 'A' }, { orderNo: 'B' }]);

      const result = await svc.scanReceivableOrders(10);

      expect(result).toEqual(['A', 'B']);
      expect(prisma.order.findMany).toHaveBeenCalledWith({
        where: { status: OrderStatus.SHIPPED, autoConfirmAt: { lt: expect.any(Date) } },
        select: { orderNo: true },
        orderBy: { id: 'asc' },
        take: 10,
      });
    });
  });
});

describe('autoConfirmReceipt job + scanReceivableOrders（F7.2 / F10）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('autoConfirmReceipt job：透传 orderService.autoConfirm 的结果', async () => {
    const spy = jest
      .spyOn(orderService, 'autoConfirm')
      .mockResolvedValue({ skipped: false });

    const { autoConfirmReceipt } = await import('@/jobs/handlers/autoConfirmReceipt.job');
    const result = await autoConfirmReceipt('NO-TEST-1');

    expect(spy).toHaveBeenCalledWith('NO-TEST-1');
    expect(result).toEqual({ skipped: false });
    spy.mockRestore();
  });

  it('scanReceivableOrders：扫描 SHIPPED + autoConfirmAt<now，按 id 升序返回订单号', async () => {
    const fakePrisma = {
      order: {
        findMany: jest.fn<AnyAsyncFn>().mockResolvedValue([{ orderNo: 'A' }, { orderNo: 'B' }]),
      },
    };
    (getPrisma as unknown as jest.Mock).mockReturnValue(fakePrisma);

    const { scanReceivableOrders } = await import('@/jobs/handlers/autoConfirmReceipt.job');
    const result = await scanReceivableOrders(10);

    expect(result).toEqual(['A', 'B']);
    expect(fakePrisma.order.findMany).toHaveBeenCalledWith({
      where: { status: OrderStatus.SHIPPED, autoConfirmAt: { lt: expect.any(Date) } },
      select: { orderNo: true },
      orderBy: { id: 'asc' },
      take: 10,
    });
  });
});
