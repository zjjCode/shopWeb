/**
 * @file server/src/core/errors/ValidationError.ts
 * @description 参数校验失败异常（HTTP 400）：zod 校验失败、金额恒等式不成立，含字段级 errors[]
 * @module core/errors
 * @see docs/02-architecture.md §5.2、§7.3
 * @author 软件开发团队
 * @created 2026-09-03
 */

import { AppError, type AppErrorOptions } from './AppError';
import { ErrorCode } from './errorCodes';

/** 字段级错误信息 */
export interface FieldError {
  /** 字段路径，嵌套字段用 `.` 连接，数组元素用 `[0]` */
  field: string;
  /** 可直接展示的中文提示 */
  message: string;
  /** 字段级错误码（默认 90002） */
  code: number;
}

/** ValidationError 的构造参数 */
export interface ValidationErrorOptions extends AppErrorOptions {
  /** 字段级错误列表 */
  errors?: FieldError[];
}

/**
 * 参数校验失败。
 *
 * 设计要点：`data` 固定为 `{ errors: FieldError[] }`，前端可直接渲染到表单项下方（§5.1 失败响应示例）。
 * 金额恒等式校验失败（E1~E10）也复用本类，由调用方传入具体的 code（如 31003/60004）。
 */
export class ValidationError extends AppError {
  /** 字段级错误列表（可能为空，例如整体性的恒等式校验失败） */
  readonly errors: FieldError[];

  /**
   * @param message 概览提示，默认「参数校验失败」
   * @param options 错误码与字段级错误列表
   */
  constructor(message = '参数校验失败', options: ValidationErrorOptions = {}) {
    const errors = options.errors ?? [];
    super(message, {
      code: options.code ?? ErrorCode.VALIDATION_FAILED,
      httpStatus: options.httpStatus ?? 400,
      isOperational: options.isOperational ?? true,
      data: options.data ?? { errors },
    });
    this.errors = errors;
  }

  /**
   * 由字段级错误列表快速构造实例。
   *
   * @param errors 字段级错误列表
   * @param message 概览提示
   * @returns ValidationError 实例
   */
  static fromFieldErrors(errors: FieldError[], message = '参数校验失败'): ValidationError {
    return new ValidationError(message, { errors });
  }
}
