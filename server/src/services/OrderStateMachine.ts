/**
 * @file server/src/services/OrderStateMachine.ts
 * @description 订单状态机：7 态白名单 + 条件更新跃迁 + 轨迹写入（F12）
 * @module services
 * @see docs/04-flows.md F12（1520-1630 行）：状态机总图 + F12.1 白名单表 + 四条铁律
 * @see prisma/schema.prisma（OrderStatus / OrderStatusLog）
 * @author 软件开发团队
 * @created 2026-09-12
 *
 * 职责边界（F12 铁律）：
 * 1. 禁止任何地方直接 `prisma.order.update({ data: { status } })`，一律走本模块的 `transition`；
 * 2. 状态更新**必须**带 `WHERE status = 期望原状态`，以 `affectedRows` 判定并发胜负；
 * 3. 每次状态变更**必须**同事务写 `order_status_logs`（`from`/`to`/操作人/原因）；
 * 4. `CANCELLED` 与 `REFUNDED` 为终态，不可再跃迁。
 *
 * 本模块**只负责订单态与轨迹**，不碰库存/资金/券——那些副作用由调用方在同事务内按 F6/F8/F9/F10 处理。
 */

import { Prisma, OrderStatus } from '@prisma/client';
import type { OperatorType } from '@prisma/client';
import { BusinessError } from '@/core/errors';
import { ErrorCode } from '@/core/errors/errorCodes';

/**
 * 状态跃迁白名单（F12.1）。
 *
 * @description 7 态：PENDING_PAYMENT / PAID / SHIPPED / COMPLETED / CANCELLED / REFUNDING / REFUNDED。
 * 终态 `CANCELLED` 与 `REFUNDED` 不可再跃迁（空数组）。
 */
export const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PENDING_PAYMENT: [OrderStatus.PAID, OrderStatus.CANCELLED],
  PAID: [OrderStatus.SHIPPED, OrderStatus.CANCELLED, OrderStatus.REFUNDING],
  SHIPPED: [OrderStatus.COMPLETED, OrderStatus.REFUNDING],
  COMPLETED: [OrderStatus.REFUNDING],
  CANCELLED: [],
  REFUNDING: [OrderStatus.REFUNDED, OrderStatus.PAID, OrderStatus.SHIPPED, OrderStatus.COMPLETED],
  REFUNDED: [],
};

/**
 * 判断一次跃迁是否合法。
 *
 * @param from 原状态
 * @param to 目标状态
 * @returns 是否允许
 */
export function isTransitionAllowed(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * 断言一次跃迁合法，非法抛 {@link ErrorCode.ORDER_STATUS_INVALID}（31002）。
 *
 * @param from 原状态
 * @param to 目标状态
 * @throws {BusinessError} 31002 状态机拒绝
 */
export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (!isTransitionAllowed(from, to)) {
    throw new BusinessError('订单状态流转非法', {
      code: ErrorCode.ORDER_STATUS_INVALID,
      httpStatus: 409,
    });
  }
}

/** 一次状态跃迁的入参 */
export interface StateMachineTransitionInput {
  /** 订单主键（写轨迹用） */
  orderId: bigint;
  /** 订单号（条件更新 + 写轨迹用） */
  orderNo: string;
  /** 期望原状态（条件更新 WHERE status=? 的并发闸门） */
  fromStatus: OrderStatus;
  /** 目标状态 */
  toStatus: OrderStatus;
  /** 操作人类型 */
  operatorType: OperatorType;
  /** 操作人 ID（SYSTEM 填 0） */
  operatorId: bigint;
  /** 操作人名称（可空） */
  operatorName?: string | null;
  /** 写入轨迹的 reason（如 TIMEOUT / USER_CANCEL / ADMIN_CANCEL） */
  reason?: string | null;
  /** 备注（可空） */
  remark?: string | null;
  /** 订单主表额外更新字段（如 cancelReason / cancelledAt / cancelNote / shippedAt ...） */
  extraData?: Prisma.OrderUpdateManyMutationInput;
  /** 轨迹附加 JSON（如 {paymentNo} / {refundNo}） */
  logExtra?: Prisma.InputJsonValue;
}

/**
 * 在调用方事务内执行一次合法的状态跃迁。
 *
 * 行为（严格遵循 F12 铁律）：
 * 1. `assertTransition(from, to)` —— 非法直接 31002；
 * 2. 条件更新 `UPDATE orders SET status=?, ... WHERE order_no=? AND status=from`，
 *    以 `affectedRows` 判定并发胜负（同事务由调用方开启）；
 * 3. 仅当 `affectedRows > 0` 时同事务写 `order_status_logs`。
 *
 * @param tx 事务客户端（**必须由调用方在 `withTransaction` 闭包内传入**）
 * @param input 跃迁入参
 * @returns 条件更新影响行数（0 表示原状态已变，调用方据此判「幂等跳过 / 并发冲突」）
 */
export async function transition(
  tx: Prisma.TransactionClient,
  input: StateMachineTransitionInput,
): Promise<number> {
  assertTransition(input.fromStatus, input.toStatus);

  const updated = await tx.order.updateMany({
    where: { orderNo: input.orderNo, status: input.fromStatus },
    data: { status: input.toStatus, ...(input.extraData ?? {}) },
  });

  if (updated.count > 0) {
    await tx.orderStatusLog.create({
      data: {
        orderId: input.orderId,
        orderNo: input.orderNo,
        fromStatus: input.fromStatus,
        toStatus: input.toStatus,
        operatorType: input.operatorType,
        operatorId: input.operatorId,
        operatorName: input.operatorName ?? null,
        reason: input.reason ?? null,
        remark: input.remark ?? null,
        extra: input.logExtra ?? Prisma.JsonNull,
      },
    });
  }

  return updated.count;
}
