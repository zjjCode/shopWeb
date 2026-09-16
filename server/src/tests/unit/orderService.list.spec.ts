/**
 * @file server/src/tests/unit/orderService.list.spec.ts
 * @description 订单列表 / 详情读接口单测：假 Prisma 驱动，不连真实 DB
 * @module tests/unit
 * @see server/src/services/OrderService.ts（listOrders / getOrderDetail）
 * @author 软件开发团队
 * @created 2026-09-12
 *
 * 为什么必须有单测：环境无 MySQL 实例，读接口虽不写库，但以下契约单测必须守住：
 * - 越权防护：列表 / 详情的查询 `where` 强制带 `userId` + 软删过滤 `deletedAt: null`；
 * - 详情缺单 / 越权统一抛 `BusinessError(ORDER_NOT_FOUND, 404)`，不暴露订单是否存在；
 * - 分页偏移按 `(page-1)*pageSize` 计算；totalPages 至少 1（空列表不出现除零/0 页）；
 * - 列表项 thumbnail 取首行主图，详情把 `payment.channel` 映射到 `payMethod`。
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { OrderStatus } from '@prisma/client';
import { BusinessError } from '@/core/errors';
import { ErrorCode } from '@/core/errors/errorCodes';
import { OrderService } from '@/services/OrderService';
import type { PriceService } from '@/services/PriceService';
import type { StockService } from '@/services/StockService';

// config 在模块加载时即校验环境变量并可能 process.exit；测试环境没有 .env，注入固定值
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

// 单例在模块加载时会调用 getPrisma()，用假实现避免建真实客户端
jest.mock('@/core/prisma', () => ({
  getPrisma: jest.fn(() => ({})),
}));

// 读接口不开启事务，但模块顶部 import 了 withTransaction，仍接管以免意外连库
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

describe('OrderService 订单列表 / 详情读接口', () => {
  /** 假 Prisma：只实现读接口用到的委托 */
  let prisma: {
    address: { findFirst: jest.Mock<AnyAsyncFn> };
    cartItem: { findMany: jest.Mock<AnyAsyncFn>; deleteMany: jest.Mock<AnyAsyncFn> };
    order: {
      count: jest.Mock<AnyAsyncFn>;
      findMany: jest.Mock<AnyAsyncFn>;
      findFirst: jest.Mock<AnyAsyncFn>;
      create: jest.Mock<AnyAsyncFn>;
    };
    orderItem: { create: jest.Mock<AnyAsyncFn> };
    orderStatusLog: { create: jest.Mock<AnyAsyncFn> };
  };
  /** 假库存服务（读接口不调用，占位满足构造） */
  let stockService: { freeze: jest.Mock<AnyAsyncFn> };
  /** 假计价服务（读接口不调用，占位满足构造） */
  let priceService: { calculate: jest.Mock<AnyAsyncFn> };
  /** 被测试对象 */
  let svc: OrderService;

  beforeEach(() => {
    jest.clearAllMocks();

    prisma = {
      address: { findFirst: jest.fn<AnyAsyncFn>() },
      cartItem: { findMany: jest.fn<AnyAsyncFn>(), deleteMany: jest.fn<AnyAsyncFn>() },
      order: {
        count: jest.fn<AnyAsyncFn>(),
        findMany: jest.fn<AnyAsyncFn>(),
        findFirst: jest.fn<AnyAsyncFn>(),
        create: jest.fn<AnyAsyncFn>(),
      },
      orderItem: { create: jest.fn<AnyAsyncFn>() },
      orderStatusLog: { create: jest.fn<AnyAsyncFn>() },
    };
    stockService = { freeze: jest.fn<AnyAsyncFn>() };
    priceService = { calculate: jest.fn<AnyAsyncFn>() };

    svc = new OrderService(
      prisma as never,
      stockService as unknown as StockService,
      priceService as unknown as PriceService,
    );
  });

  /** 一条带 items / payments / refunds 的订单行（字段对齐 Order 模型的 include 结果） */
  function fakeOrderRow(orderNo: string, status: OrderStatus) {
    return {
      orderNo,
      status,
      payAmount: 100n,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      items: [
        {
          skuCode: 'SKU-A',
          productName: '商品A',
          specDigest: '颜色:黑',
          mainImage: '/img/a.jpg',
          unitPrice: 100n,
          quantity: 2,
          payableAmount: 200n,
        },
        {
          skuCode: 'SKU-B',
          productName: '商品B',
          specDigest: '颜色:白',
          mainImage: '/img/b.jpg',
          unitPrice: 50n,
          quantity: 1,
          payableAmount: 50n,
        },
      ],
      payments: [
        { channel: 'BALANCE', amount: 100n, status: 'SUCCESS', paidAt: new Date('2026-01-01T00:01:00.000Z') },
      ],
      refunds: [{ status: 'PENDING' as const, amount: 50n, type: 'PARTIAL' as const }],
    };
  }

  describe('listOrders', () => {
    it('不带 status 过滤：count 与 findMany 都带 userId + deletedAt:null，分页/排序正确映射', async () => {
      prisma.order.count.mockResolvedValue(25);
      prisma.order.findMany.mockResolvedValue([
        fakeOrderRow('NO1', OrderStatus.PAID),
        fakeOrderRow('NO2', OrderStatus.SHIPPED),
      ]);

      const result = await svc.listOrders(1n, { page: 1, pageSize: 10 });

      // 越权防护 + 软删过滤：count 与 findMany 一致
      expect(prisma.order.count).toHaveBeenCalledWith({ where: { userId: 1n, deletedAt: null } });
      const findManyArg = prisma.order.findMany.mock.calls[0][0];
      expect(findManyArg.where).toEqual({ userId: 1n, deletedAt: null });
      expect(findManyArg.orderBy).toEqual({ createdAt: 'desc', id: 'desc' });
      expect(findManyArg.skip).toBe(0);
      expect(findManyArg.take).toBe(10);
      expect(findManyArg.include).toEqual({
        items: {
          orderBy: { id: 'asc' },
          select: {
            productName: true,
            specDigest: true,
            mainImage: true,
            unitPrice: true,
            quantity: true,
          },
        },
      });

      // 列表映射
      expect(result.list).toHaveLength(2);
      expect(result.list[0].orderNo).toBe('NO1');
      expect(result.list[0].status).toBe(OrderStatus.PAID);
      expect(result.list[0].itemCount).toBe(2);
      expect(result.list[0].thumbnail).toBe('/img/a.jpg');
      expect(result.list[0].items[0].productName).toBe('商品A');
      expect(result.list[0].items[0].unitPrice).toBe(100n);

      // 分页元信息
      expect(result.total).toBe(25);
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(10);
      expect(result.totalPages).toBe(3); // ceil(25/10)
    });

    it('带 status 过滤：where 追加 status，且分页偏移按 (page-1)*pageSize 计算', async () => {
      prisma.order.count.mockResolvedValue(3);
      prisma.order.findMany.mockResolvedValue([fakeOrderRow('NO9', OrderStatus.CANCELLED)]);

      const result = await svc.listOrders(7n, { status: OrderStatus.CANCELLED, page: 2, pageSize: 5 });

      expect(prisma.order.count).toHaveBeenCalledWith({
        where: { userId: 7n, deletedAt: null, status: OrderStatus.CANCELLED },
      });
      const findManyArg = prisma.order.findMany.mock.calls[0][0];
      expect(findManyArg.where).toEqual({ userId: 7n, deletedAt: null, status: OrderStatus.CANCELLED });
      expect(findManyArg.skip).toBe(5);
      expect(findManyArg.take).toBe(5);
      expect(result.totalPages).toBe(1); // ceil(3/5)
    });

    it('空列表：totalPages 至少为 1，list 为空数组', async () => {
      prisma.order.count.mockResolvedValue(0);
      prisma.order.findMany.mockResolvedValue([]);

      const result = await svc.listOrders(1n, { page: 1, pageSize: 10 });

      expect(result.list).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.totalPages).toBe(1);
    });
  });

  describe('getOrderDetail', () => {
    const EXPECTED_INCLUDE = {
      items: {
        orderBy: { id: 'asc' },
        select: {
          skuCode: true,
          productName: true,
          specDigest: true,
          mainImage: true,
          unitPrice: true,
          quantity: true,
          payableAmount: true,
        },
      },
      payments: { select: { channel: true, amount: true, status: true, paidAt: true } },
      refunds: { select: { status: true, amount: true, type: true } },
    };

    it('返回详情：items / payments / refunds 正确映射，payment.channel 映射到 payMethod', async () => {
      prisma.order.findFirst.mockResolvedValue(fakeOrderRow('NO1', OrderStatus.PAID));

      const detail = await svc.getOrderDetail(1n, 'NO1');

      // 越权防护 + 软删过滤
      expect(prisma.order.findFirst).toHaveBeenCalledWith({
        where: { orderNo: 'NO1', userId: 1n, deletedAt: null },
        include: EXPECTED_INCLUDE,
      });

      expect(detail.orderNo).toBe('NO1');
      expect(detail.status).toBe(OrderStatus.PAID);
      expect(detail.payAmount).toBe(100n);

      expect(detail.items).toHaveLength(2);
      expect(detail.items[0].skuCode).toBe('SKU-A');
      expect(detail.items[0].productName).toBe('商品A');
      expect(detail.items[0].payableAmount).toBe(200n);

      expect(detail.payments).toHaveLength(1);
      expect(detail.payments[0].payMethod).toBe('BALANCE');
      expect(detail.payments[0].amount).toBe(100n);

      expect(detail.refunds).toHaveLength(1);
      expect(detail.refunds[0].type).toBe('PARTIAL');
      expect(detail.refunds[0].amount).toBe(50n);
    });

    it('越权或缺单：统一抛 BusinessError(ORDER_NOT_FOUND, 404)，不暴露订单是否存在', async () => {
      prisma.order.findFirst.mockResolvedValue(null);

      let caught: unknown;
      try {
        await svc.getOrderDetail(1n, 'NOT-EXIST');
      } catch (e) {
        caught = e;
      }

      expect(caught).toBeInstanceOf(BusinessError);
      const err = caught as BusinessError;
      expect(err.code).toBe(ErrorCode.ORDER_NOT_FOUND);
      expect(err.httpStatus).toBe(404);

      // 同样一个 where（带 userId + 软删），证明越权与缺单走同一路径
      expect(prisma.order.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { orderNo: 'NOT-EXIST', userId: 1n, deletedAt: null } }),
      );
    });
  });
});
