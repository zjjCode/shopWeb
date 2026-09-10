/**
 * @file server/src/core/logger/requestContext.ts
 * @description 请求上下文：AsyncLocalStorage 承载 requestId / userId / adminId / bizNos，全链路隐式透传
 * @module core/logger
 * @see docs/02-architecture.md §5.3（requestId 全链路透传）
 * @author 软件开发团队
 * @created 2026-09-03
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { TokenScope } from '@/config/types';

/** 单个请求/任务的执行上下文 */
export interface RequestContext {
  /** 全链路追踪 ID，与响应头 X-Request-Id 一致 */
  requestId: string;
  /** C 端买家 ID（后台接口为空） */
  userId?: number;
  /** 后台管理员 ID（C 端接口为空） */
  adminId?: number;
  /** 角色标识（ buyers 为 'USER'，后台为角色编码） */
  role?: string;
  /** JWT 作用域 */
  scope?: TokenScope;
  /** 业务单号，便于日志检索（订单号 / 支付单号 / 退款单号） */
  bizNos?: Record<string, string>;
  /** 队列任务名（异步 Worker 场景） */
  jobName?: string;
  /** 其它自定义上下文（脱敏后写入日志） */
  extras?: Record<string, unknown>;
}

/** 上下文存储实例：进程级单例 */
const storage = new AsyncLocalStorage<RequestContext>();

/** 无上下文时的兜底 requestId，保证日志字段永不缺失 */
export const NO_REQUEST_ID = 'no-request-id';

/**
 * 在指定上下文中执行函数。
 *
 * @description 中间件与 Worker 入口使用；回调内发起的异步调用链都能通过 {@link getContext} 取到上下文
 * @param context 初始上下文（至少包含 requestId）
 * @param fn 待执行的函数
 * @returns 函数的返回值
 */
export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

/**
 * 在指定上下文中执行异步函数。
 *
 * @param context 初始上下文
 * @param fn 待执行的异步函数
 * @returns 函数执行结果的 Promise
 */
export function runWithContextAsync<T>(context: RequestContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(context, fn);
}

/**
 * 取当前上下文。
 *
 * @description 无上下文（如进程启动阶段、游离的定时器）时返回 undefined，调用方需自行兜底
 * @returns 当前上下文或 undefined
 */
export function getContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * 取当前 requestId。
 *
 * @description 日志与响应构造使用；无上下文时返回 {@link NO_REQUEST_ID}，保证字段结构稳定
 * @returns 当前 requestId
 */
export function getRequestId(): string {
  return storage.getStore()?.requestId ?? NO_REQUEST_ID;
}

/**
 * 就地补充上下文字段。
 *
 * @description 典型场景：鉴权中间件解出 userId 后回填，使后续日志自动带上操作主体
 * @param patch 需要补充或覆盖的字段
 * @returns 是否成功写入（无上下文时返回 false）
 */
export function patchContext(patch: Partial<RequestContext>): boolean {
  const context = storage.getStore();
  if (!context) {
    return false;
  }
  Object.assign(context, patch);
  return true;
}

/**
 * 追加业务单号到上下文（订单号 / 支付单号 / 退款单号）。
 *
 * @param bizNos 业务单号键值对
 * @returns 是否成功写入
 */
export function patchBizNos(bizNos: Record<string, string>): boolean {
  const context = storage.getStore();
  if (!context) {
    return false;
  }
  context.bizNos = { ...(context.bizNos ?? {}), ...bizNos };
  return true;
}

/**
 * 为 BullMQ 任务重建上下文。
 *
 * @description 异步任务脱离了 HTTP 请求上下文，需在 Worker 入口用 job 数据里的 requestId 重建，
 * 否则支付回调的入账日志与回调日志无法串联（§10.2 requestId 透传要求）
 * @param job 任务数据，至少包含 requestId
 * @param fn 待执行的函数
 * @returns 函数的返回值
 */
export function runWithJobContext<T>(
  job: { requestId?: string; jobName?: string; bizNos?: Record<string, string> },
  fn: () => T,
): T {
  return storage.run(
    {
      requestId: job.requestId ?? NO_REQUEST_ID,
      jobName: job.jobName,
      bizNos: job.bizNos,
    },
    fn,
  );
}

/**
 * 为 BullMQ 任务重建上下文（异步版本）。
 *
 * @param job 任务数据
 * @param fn 待执行的异步函数
 * @returns 函数执行结果的 Promise
 */
export function runWithJobContextAsync<T>(
  job: { requestId?: string; jobName?: string; bizNos?: Record<string, string> },
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run(
    {
      requestId: job.requestId ?? NO_REQUEST_ID,
      jobName: job.jobName,
      bizNos: job.bizNos,
    },
    fn,
  );
}
