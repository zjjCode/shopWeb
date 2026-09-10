/**
 * @file server/src/core/errors/BusinessError.ts
 * @description 业务规则拒绝异常（HTTP 409）：状态非法流转、售后期已过、活动已结束等
 * @module core/errors
 * @see docs/02-architecture.md §5.2
 * @author 软件开发团队
 * @created 2026-09-03
 */

import { AppError, type AppErrorOptions } from './AppError';

/** BusinessError 的构造参数：code 必填（业务拒绝必须能定位到具体规则） */
export interface BusinessErrorOptions extends Omit<AppErrorOptions, 'code' | 'httpStatus'> {
  code: number;
  httpStatus?: number;
}

/**
 * 业务规则拒绝。
 *
 * 典型场景：订单当前状态不允许该操作（31002）、超出售后期（31005）、优惠券已过期（12005）。
 * 这类异常是**用户操作被拒绝**，不是系统故障，因此 `isOperational = true`，日志级别为 warn。
 */
export class BusinessError extends AppError {
  /**
   * @param message 可直接展示给用户的中文提示
   * @param options 必须携带 code
   */
  constructor(message: string, options: BusinessErrorOptions) {
    super(message, { httpStatus: 409, isOperational: true, ...options });
  }
}
