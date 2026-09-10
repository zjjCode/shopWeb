/**
 * @file server/src/core/errors/ConflictError.ts
 * @description 冲突异常（HTTP 409）：唯一键冲突、并发更新冲突、幂等指纹冲突
 * @module core/errors
 * @see docs/02-architecture.md §5.2
 * @author 软件开发团队
 * @created 2026-09-03
 */

import { AppError, type AppErrorOptions } from './AppError';
import { ErrorCode } from './errorCodes';

/** ConflictError 的构造参数：code 必填 */
export interface ConflictErrorOptions extends Omit<AppErrorOptions, 'code' | 'httpStatus'> {
  code: number;
  httpStatus?: number;
}

/**
 * 冲突类异常。
 *
 * 与 {@link BusinessError} 的区别：ConflictError 强调「**并发或重复**导致的冲突」
 * （手机号已注册 10002、SKU 编码已存在 21003、幂等指纹冲突 90006、CAS 重试耗尽 50002），
 * 前端通常提示「请刷新后重试」；BusinessError 强调「规则不允许」，重试也不会成功。
 */
export class ConflictError extends AppError {
  /**
   * @param message 提示文案
   * @param options 必须携带 code
   */
  constructor(message: string, options: ConflictErrorOptions) {
    super(message, {
      code: options.code ?? ErrorCode.SYSTEM_INTERNAL,
      httpStatus: options.httpStatus ?? 409,
      isOperational: options.isOperational ?? true,
      data: options.data ?? null,
    });
  }
}
