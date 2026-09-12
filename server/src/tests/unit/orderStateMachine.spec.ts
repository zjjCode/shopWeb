/**
 * @file server/src/tests/unit/orderStateMachine.spec.ts
 * @description 订单状态机单测：白名单 + assertTransition + transition（条件更新 + 轨迹）
 * @module tests/unit
 * @see server/src/services/OrderStateMachine.ts、docs/04-flows.md F12（状态机总图 + 白名单 + 铁律）
 * @author 软件开发团队
 * @created 2026-09-12
 *
 * 验证状态机不可绕过：所有跃迁必须带 WHERE status=fromStatus 条件更新，并以 affectedRows 判并发，
 * 同时写 order_status_logs 轨迹。这是「状态机不被直接绕过」红线在单元层的落地。
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { CancelReason, OperatorType, OrderStatus } from '@prisma/client';
import { BusinessError } from '@/core/errors';
import {
  assertTransition,
  isTransitionAllowed,
  transition,
  TRANSITIONS,
} from '@/services/OrderStateMachine';
import type { Prisma } from '@prisma/client';

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyAsyncFn = (...args: any[]) => Promise<any>;
/* eslint-enable @typescript-eslint/no-explicit-any */

describe('OrderStateMachine 状态机（F12）', () => {
  describe('TRANSITIONS 白名单', () => {
    it('PENDING_PAYMENT 仅允许 → PAID / CANCELLED', () => {
      expect(TRANSITIONS[OrderStatus.PENDING_PAYMENT]).toEqual(
        expect.arrayContaining([OrderStatus.PAID, OrderStatus.CANCELLED]),
      );
      // 不允许跨级（待支付不能直接到已发货 / 已完成）
      expect(isTransitionAllowed(OrderStatus.PENDING_PAYMENT, OrderStatus.SHIPPED)).toBe(false);
      expect(isTransitionAllowed(OrderStatus.PENDING_PAYMENT, OrderStatus.COMPLETED)).toBe(false);
    });

    it('终态 CANCELLED / REFUNDED 不可再跃迁', () => {
      expect(TRANSITIONS[OrderStatus.CANCELLED]).toEqual([]);
      expect(TRANSITIONS[OrderStatus.REFUNDED]).toEqual([]);
      expect(isTransitionAllowed(OrderStatus.CANCELLED, OrderStatus.PAID)).toBe(false);
      expect(isTransitionAllowed(OrderStatus.REFUNDED, OrderStatus.REFUNDING)).toBe(false);
    });

    it('PAID 允许 → SHIPPED / CANCELLED / REFUNDING', () => {
      expect(isTransitionAllowed(OrderStatus.PAID, OrderStatus.SHIPPED)).toBe(true);
      expect(isTransitionAllowed(OrderStatus.PAID, OrderStatus.CANCELLED)).toBe(true);
      expect(isTransitionAllowed(OrderStatus.PAID, OrderStatus.REFUNDING)).toBe(true);
    });

    it('REFUNDING 允许 → REFUNDED / 退回 PAID / SHIPPED / COMPLETED（退款失败回退）', () => {
      expect(isTransitionAllowed(OrderStatus.REFUNDING, OrderStatus.REFUNDED)).toBe(true);
      expect(isTransitionAllowed(OrderStatus.REFUNDING, OrderStatus.SHIPPED)).toBe(true);
    });
  });

  describe('assertTransition', () => {
    it('合法跃迁不抛错', () => {
      expect(() =>
        assertTransition(OrderStatus.PENDING_PAYMENT, OrderStatus.CANCELLED),
      ).not.toThrow();
    });

    it('非法跃迁抛 BusinessError（31002）', () => {
      expect(() =>
        assertTransition(OrderStatus.COMPLETED, OrderStatus.CANCELLED),
      ).toThrow(BusinessError);
    });
  });

  describe('transition 条件更新 + 轨迹', () => {
    let tx: {
      order: { updateMany: jest.Mock<AnyAsyncFn> };
      orderStatusLog: { create: jest.Mock<AnyAsyncFn> };
    };

    beforeEach(() => {
      tx = {
        order: { updateMany: jest.fn<AnyAsyncFn>() },
        orderStatusLog: { create: jest.fn<AnyAsyncFn>() },
      };
    });

    it('合法跃迁：条件更新 WHERE 带 orderNo + fromStatus，并同事务写轨迹', async () => {
      tx.order.updateMany.mockResolvedValue({ count: 1 });

      const affected = await transition(tx as unknown as Prisma.TransactionClient, {
        orderId: 9001n,
        orderNo: 'NO-TEST-1',
        fromStatus: OrderStatus.PENDING_PAYMENT,
        toStatus: OrderStatus.CANCELLED,
        operatorType: OperatorType.SYSTEM,
        operatorId: 0n,
        reason: CancelReason.TIMEOUT,
        extraData: { cancelReason: CancelReason.TIMEOUT, cancelledAt: new Date() },
      });

      expect(affected).toBe(1);
      // 铁律 2：条件更新必须带 WHERE status='期望原状态'
      expect(tx.order.updateMany).toHaveBeenCalledWith({
        where: { orderNo: 'NO-TEST-1', status: OrderStatus.PENDING_PAYMENT },
        data: expect.objectContaining({
          status: OrderStatus.CANCELLED,
          cancelReason: CancelReason.TIMEOUT,
        }),
      });
      // 铁律 3：受影响才写轨迹
      expect(tx.orderStatusLog.create).toHaveBeenCalledTimes(1);
      expect(tx.orderStatusLog.create.mock.calls[0]?.[0].data).toMatchObject({
        orderNo: 'NO-TEST-1',
        fromStatus: OrderStatus.PENDING_PAYMENT,
        toStatus: OrderStatus.CANCELLED,
        operatorType: OperatorType.SYSTEM,
        operatorId: 0n,
        reason: CancelReason.TIMEOUT,
      });
    });

    it('并发已变（affectedRows=0）：不写轨迹，返回 0（幂等跳过）', async () => {
      tx.order.updateMany.mockResolvedValue({ count: 0 });

      const affected = await transition(tx as unknown as Prisma.TransactionClient, {
        orderId: 9001n,
        orderNo: 'NO-TEST-1',
        fromStatus: OrderStatus.PENDING_PAYMENT,
        toStatus: OrderStatus.CANCELLED,
        operatorType: OperatorType.SYSTEM,
        operatorId: 0n,
        reason: CancelReason.TIMEOUT,
      });

      expect(affected).toBe(0);
      expect(tx.orderStatusLog.create).not.toHaveBeenCalled();
    });

    it('非法跃迁：在条件更新前抛错，绝不触碰 DB', async () => {
      await expect(
        transition(tx as unknown as Prisma.TransactionClient, {
          orderId: 9001n,
          orderNo: 'NO-TEST-1',
          fromStatus: OrderStatus.COMPLETED,
          toStatus: OrderStatus.CANCELLED,
          operatorType: OperatorType.SYSTEM,
          operatorId: 0n,
        }),
      ).rejects.toThrow(BusinessError);
      expect(tx.order.updateMany).not.toHaveBeenCalled();
      expect(tx.orderStatusLog.create).not.toHaveBeenCalled();
    });
  });
});
