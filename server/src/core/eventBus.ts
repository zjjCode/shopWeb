/**
 * @file server/src/core/eventBus.ts
 * @description 进程内事件总线：order.completed 等（积分体系 / 营销触达的钩子预留）
 * @module core
 * @see docs/02-architecture.md §3（事件总线预留）
 * @author 软件开发团队
 * @created 2026-09-03
 *
 * 边界说明：
 * 本总线**只做进程内解耦**，不跨实例、不保证持久化，也不替代 BullMQ。
 * 适用于「失败了无所谓」的旁路逻辑（积分累计、站内信、缓存预热）。
 * 任何影响资金 / 库存正确性的逻辑都必须走队列 + 事务，不能挂在这里。
 */

import { EventEmitter } from 'node:events';
import { logError, logDebug } from '@/core/logger/logger';

/** 订单完成事件（积分累计、复购券发放的主要钩子） */
export interface OrderCompletedEvent {
  /** 订单 ID */
  orderId: number;
  /** 订单号 */
  orderNo: string;
  /** 下单用户 ID */
  userId: number;
  /** 实付金额（分） */
  payAmount: number;
  /** 完成时间 */
  completedAt: Date;
}

/** 订单取消事件（释放优惠券、回收积分的钩子） */
export interface OrderCancelledEvent {
  /** 订单 ID */
  orderId: number;
  /** 订单号 */
  orderNo: string;
  /** 下单用户 ID */
  userId: number;
  /** 取消原因（对应 CancelReason 枚举） */
  reason: string;
  /** 取消时间 */
  cancelledAt: Date;
}

/** 支付成功事件（发货提醒、风控采样的钩子） */
export interface PaymentSucceededEvent {
  /** 支付单号 */
  paymentNo: string;
  /** 关联业务单号（订单号或充值单号） */
  bizNo: string;
  /** 支付金额（分） */
  amount: number;
  /** 支付渠道 */
  channel: string;
  /** 支付完成时间 */
  paidAt: Date;
}

/** 事件名 → 载荷类型映射（新增事件必须在此登记，否则 on/emit 无法推导类型） */
export interface AppEventMap {
  'order.completed': OrderCompletedEvent;
  'order.cancelled': OrderCancelledEvent;
  'payment.succeeded': PaymentSucceededEvent;
}

/** 事件名联合类型 */
export type AppEventName = keyof AppEventMap;

/**
 * 底层发射器。
 *
 * `setMaxListeners` 提高上限的原因：事件总线是**多订阅**模型，
 * 每接入一个旁路能力就多一个监听器，Node 默认 10 的上限会误报内存泄漏警告。
 */
const emitter = new EventEmitter();
emitter.setMaxListeners(100);

/** 事件处理器的形态（同步或异步） */
type EventHandler<K extends AppEventName> = (payload: AppEventMap[K]) => void | Promise<void>;

/**
 * 把用户处理器包装成「异常自愈」的同步函数。
 *
 * 为什么必须包一层：EventEmitter 是**同步**广播，异步处理器 reject 时
 * 没有任何人能 catch，会变成 unhandledRejection 直接打挂进程。
 * 这里把异步调用收敛到一个立即执行的 async 闭包里并统一记录异常，
 * 保证订阅方的失败永远不会影响主流程（§：旁路逻辑不阻断主链路）。
 *
 * @param event 事件名（仅用于日志定位）
 * @param handler 用户处理器
 * @returns 可直接交给 EventEmitter 的同步函数
 */
function wrapHandler<K extends AppEventName>(event: K, handler: EventHandler<K>): (payload: AppEventMap[K]) => void {
  return (payload: AppEventMap[K]): void => {
    // void 显式丢弃 Promise：这里是 fire-and-forget，发布方不等待处理结果
    void (async () => {
      try {
        await handler(payload);
      } catch (error) {
        logError('eventbus.handler_failed', error, { ctx: { event } });
      }
    })();
  };
}

/**
 * 订阅事件。
 *
 * @description 处理器抛出的异常会被捕获并记录，**绝不影响主流程** ——
 * 订阅方是旁路逻辑，它的失败不能让下单/支付主链路报错
 * @param event 事件名
 * @param handler 事件处理器（支持异步）
 * @returns 取消订阅的函数
 */
export function on<K extends AppEventName>(event: K, handler: EventHandler<K>): () => void {
  const wrapped = wrapHandler(event, handler);
  emitter.on(event, wrapped);
  return () => {
    emitter.off(event, wrapped);
  };
}

/**
 * 订阅事件（只触发一次）。
 *
 * @param event 事件名
 * @param handler 事件处理器
 * @returns 取消订阅的函数（在事件触发前调用可阻止其执行）
 */
export function once<K extends AppEventName>(event: K, handler: EventHandler<K>): () => void {
  const wrapped = wrapHandler(event, handler);
  emitter.once(event, wrapped);
  return () => {
    emitter.off(event, wrapped);
  };
}

/**
 * 发布事件。
 *
 * @description 同步广播给所有订阅者；订阅者内部的异步处理由各自处理器负责。
 * 发布本身不 await，因此**不能用来保证下游一定执行完成**
 * @param event 事件名
 * @param payload 事件载荷
 * @returns 是否有订阅者
 */
export function emit<K extends AppEventName>(event: K, payload: AppEventMap[K]): boolean {
  const hasListeners = emitter.listenerCount(event) > 0;
  if (!hasListeners) {
    logDebug('eventbus.no_listener', { ctx: { event } });
  }
  return emitter.emit(event, payload);
}

/**
 * 查询事件的订阅者数量。
 *
 * @param event 事件名
 * @returns 订阅者数量
 */
export function listenerCount(event: AppEventName): number {
  return emitter.listenerCount(event);
}

/**
 * 移除事件的全部订阅者。
 *
 * @description 主要供测试隔离使用，避免用例之间串扰
 * @param event 事件名，缺省时清空全部事件
 */
export function removeAllListeners(event?: AppEventName): void {
  if (event === undefined) {
    emitter.removeAllListeners();
    return;
  }
  emitter.removeAllListeners(event);
}
