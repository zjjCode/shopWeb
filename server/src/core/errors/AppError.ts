/**
 * @file server/src/core/errors/AppError.ts
 * @description 应用异常基类：code / httpStatus / data / isOperational / requestId
 * @module core/errors
 * @see docs/02-architecture.md §5.2（异常体系与错误码）
 * @author 软件开发团队
 * @created 2026-09-03
 */

import { getRequestId } from '@/core/logger/requestContext';
import { ErrorCode, getErrorMeta, type ErrorCodeValue } from './errorCodes';

/** 应用异常的可选构造参数 */
export interface AppErrorOptions {
  /** 业务错误码，缺省为 90007（服务内部错误） */
  code?: number;
  /** HTTP 状态码，缺省按错误码映射表推导 */
  httpStatus?: number;
  /** 错误详情（字段级 errors[]、库存不足明细等） */
  data?: unknown;
  /**
   * 是否为「预期内的可操作异常」。
   *
   * true  = 业务规则拒绝（库存不足、状态非法），只记 warn，不触发告警；
   * false = 程序缺陷或依赖故障，记 error 并触发告警，需要人工介入。
   */
  isOperational?: boolean;
  /** 原始异常（用于错误链） */
  cause?: unknown;
}

/**
 * 应用异常基类。
 *
 * 设计要点：
 * 1. **HTTP 状态码与业务 code 双轨**：HTTP 表达语义大类，code 表达具体错误（§5.2）；
 * 2. `isOperational` 决定日志级别与是否告警 —— 区分「用户操作被拒绝」与「系统出故障」；
 * 3. 构造时抓取当前 requestId，使错误响应天然带上链路 ID；
 * 4. 各子类通过 `Object.setPrototypeOf` 修正原型链，保证 `instanceof` 在编译到 ES5 时依然成立
 *    （本项目 target 为 ES2022 本不需要，但保留可防止后续降级 target 时静默失效）。
 */
export class AppError extends Error {
  /** 业务错误码 */
  readonly code: number;
  /** HTTP 状态码 */
  readonly httpStatus: number;
  /** 错误详情 */
  readonly data: unknown;
  /** 是否为预期内的可操作异常 */
  readonly isOperational: boolean;
  /** 发生时的链路 ID */
  readonly requestId: string;
  /** 发生时间（毫秒时间戳） */
  readonly timestamp: number;

  /**
   * @param message 可直接展示给用户的中文提示
   * @param options 错误码 / HTTP 状态 / 详情 / 可操作性
   */
  constructor(message: string, options: AppErrorOptions = {}) {
    super(message);

    const code = options.code ?? ErrorCode.SYSTEM_INTERNAL;
    const meta = getErrorMeta(code);

    this.name = new.target.name;
    this.code = code;
    this.httpStatus = options.httpStatus ?? meta.httpStatus;
    this.data = options.data ?? null;
    this.isOperational = options.isOperational ?? true;
    this.requestId = getRequestId();
    this.timestamp = Date.now();

    if (options.cause !== undefined) {
      // Node 16.9+ 支持 Error cause，此处显式赋值以兼容类型定义
      (this as Error & { cause?: unknown }).cause = options.cause;
    }

    Object.setPrototypeOf(this, new.target.prototype);
    Error.captureStackTrace?.(this, new.target);
  }

  /**
   * 序列化为统一错误响应体。
   *
   * @returns 统一响应体（不含 requestId/timestamp 信封，由 response 模块补齐）
   */
  toJSON(): { code: number; message: string; data: unknown } {
    return {
      code: this.code,
      message: this.message,
      data: this.data ?? null,
    };
  }
}

/**
 * 判断任意值是否为应用异常。
 *
 * @description 类型守卫，避免在处理 unknown 捕获值时使用 any
 * @param error 待判断的值
 * @returns 是否为 AppError（含子类）
 */
export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

export type { ErrorCodeValue };
