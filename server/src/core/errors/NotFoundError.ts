/**
 * @file server/src/core/errors/NotFoundError.ts
 * @description 资源不存在异常（HTTP 404）
 * @module core/errors
 * @see docs/02-architecture.md §5.2
 * @author 软件开发团队
 * @created 2026-09-03
 */

import { AppError, type AppErrorOptions } from './AppError';
import { ErrorCode } from './errorCodes';

/** NotFoundError 的构造参数 */
export interface NotFoundErrorOptions extends AppErrorOptions {
  code?: number;
}

/**
 * 资源不存在。
 *
 * 默认错误码为 90003（接口不存在），用于路由兜底；
 * 业务资源（订单/商品/地址）应传入领域错误码，如 31001 订单不存在、21001 商品不存在或已下架。
 */
export class NotFoundError extends AppError {
  /**
   * @param message 提示文案，默认「资源不存在」
   * @param options 领域错误码（如 ErrorCode.ORDER_NOT_FOUND）
   */
  constructor(message = '资源不存在', options: NotFoundErrorOptions = {}) {
    super(message, {
      code: options.code ?? ErrorCode.ROUTE_NOT_FOUND,
      httpStatus: options.httpStatus ?? 404,
      isOperational: options.isOperational ?? true,
      data: options.data ?? null,
    });
  }
}
