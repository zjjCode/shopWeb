/**
 * @file server/src/core/errors/RateLimitError.ts
 * @description 限流异常（HTTP 429），携带 retryAfter 用于设置 Retry-After 响应头
 * @module core/errors
 * @see docs/02-architecture.md §5.2、§5.8
 * @author 软件开发团队
 * @created 2026-09-03
 */

import { AppError, type AppErrorOptions } from './AppError';
import { ErrorCode } from './errorCodes';

/** RateLimitError 的构造参数 */
export interface RateLimitErrorOptions extends AppErrorOptions {
  code?: number;
}

/**
 * 请求过于频繁。
 *
 * `retryAfter` 单位为**秒**，由 errorHandler 写入 `Retry-After` 响应头（§5.8 超限响应要求），
 * 前端可据此展示倒计时并自动重试。
 */
export class RateLimitError extends AppError {
  /** 距离可重试的剩余秒数 */
  readonly retryAfter: number;

  /**
   * @param message 提示文案，默认「请求过于频繁，请稍后再试」
   * @param retryAfter 剩余秒数，默认 60
   * @param options 错误码等可选参数
   */
  constructor(message = '请求过于频繁，请稍后再试', retryAfter = 60, options: RateLimitErrorOptions = {}) {
    super(message, {
      code: options.code ?? ErrorCode.TOO_MANY_REQUESTS,
      httpStatus: options.httpStatus ?? 429,
      isOperational: options.isOperational ?? true,
      data: options.data ?? null,
    });
    this.retryAfter = Math.max(1, Math.ceil(retryAfter));
  }
}
