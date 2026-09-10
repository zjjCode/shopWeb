/**
 * @file server/src/core/errors/AuthError.ts
 * @description 认证与授权异常（HTTP 401 / 403）：Token 缺失过期、越权、需要更高权限
 * @module core/errors
 * @see docs/02-architecture.md §5.2、§7.1、§7.2
 * @author 软件开发团队
 * @created 2026-09-03
 */

import { AppError, type AppErrorOptions } from './AppError';
import { ErrorCode } from './errorCodes';

/** AuthError 的构造参数 */
export interface AuthErrorOptions extends AppErrorOptions {
  code?: number;
}

/**
 * 认证/授权失败。
 *
 * 401 与 403 用同一类型表达，通过静态工厂区分：
 * - {@link AuthError.unauthorized}：未认证或登录失效（401）
 * - {@link AuthError.forbidden}：已认证但越权或权限不足（403）
 */
export class AuthError extends AppError {
  /**
   * @param message 提示文案
   * @param options 错误码与 HTTP 状态
   */
  constructor(message: string, options: AuthErrorOptions = {}) {
    super(message, {
      code: options.code ?? ErrorCode.ACCESS_TOKEN_EXPIRED,
      httpStatus: options.httpStatus ?? 401,
      isOperational: options.isOperational ?? true,
      data: options.data ?? null,
    });
  }

  /**
   * 未认证 / 登录失效（401）。
   *
   * @param message 提示文案，默认「登录已失效，请重新登录」
   * @param code 错误码，默认 10005
   * @returns AuthError 实例（HTTP 401）
   */
  static unauthorized(message = '登录已失效，请重新登录', code: number = ErrorCode.ACCESS_TOKEN_EXPIRED): AuthError {
    return new AuthError(message, { code, httpStatus: 401 });
  }

  /**
   * 已认证但无权访问（403）。
   *
   * @description 越权（10009）与权限不足（10010）都走 403；**不返回具体缺少哪个权限点**，
   * 避免攻击者据此探测后台能力面（§7.2）
   * @param message 提示文案，默认「需要更高权限」
   * @param code 错误码，默认 10010
   * @returns AuthError 实例（HTTP 403）
   */
  static forbidden(message = '需要更高权限', code: number = ErrorCode.PERMISSION_DENIED): AuthError {
    return new AuthError(message, { code, httpStatus: 403 });
  }
}
