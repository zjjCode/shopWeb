/**
 * @file server/src/middlewares/errorHandler.ts
 * @description 全局异常中间件：任意异常 → 统一错误响应（AppError / zod / Prisma / 未知错误）
 * @module middlewares
 * @see docs/02-architecture.md §5.2（异常体系与错误码）、§5.5（第 14 步：必须最后注册）
 * @author 软件开发团队
 * @created 2026-09-04
 *
 * 三条硬约束：
 * 1. **未知错误绝不泄漏堆栈**：`message` 只给通用文案，堆栈只进日志（§7.4）；
 * 2. **错误码与 HTTP 状态双轨**：HTTP 表达语义大类，code 表达具体错误（§5.2）；
 * 3. **日志分级**：`isOperational = true`（业务规则拒绝）记 warn 不告警，
 *    `false`（程序缺陷 / 依赖故障）记 error 并触发告警。
 *    不分级的结果是「库存不足」和「空指针」混在同一条 error 流里，告警彻底失效。
 */

import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import {
  AppError,
  ConflictError,
  ErrorCode,
  NotFoundError,
  RateLimitError,
  ValidationError,
  getErrorMeta,
  type FieldError,
} from '@/core/errors';
import { logError, logWarn } from '@/core/logger/logger';
import { getRequestId } from '@/core/logger/requestContext';
import { sendFail } from '@/core/response';

/**
 * Prisma 已知错误的最小结构。
 *
 * @description 这里**刻意不 import `Prisma` 命名空间**：
 * 项目在 `prisma/schema.prisma` 落地前，`npx prisma generate` 只产出桩代码，
 * `Prisma.PrismaClientKnownRequestError` 尚不存在；而错误码是字符串协议（`P2002` 等），
 * 用鸭子类型判定既能在当下编译通过，也避免把 errorHandler 绑死在生成产物上。
 */
interface PrismaKnownErrorShape {
  /** Prisma 错误码，形如 `P2002` */
  code: string;
  /** 错误上下文（唯一键冲突的字段、外键约束的表等） */
  meta?: Record<string, unknown>;
}

/**
 * 判断是否为 Prisma 已知错误。
 *
 * @param error 任意捕获值
 * @returns 是否为 `Error & { code: 'Pxxxx' }`
 */
function isPrismaKnownError(error: unknown): error is Error & PrismaKnownErrorShape {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && /^P\d{4}$/.test(code);
}

/**
 * 从 Prisma P2002 的 `meta.target` 提取冲突字段名。
 *
 * @description MySQL 下 `target` 形如 `['phone']`，不同数据库可能是字符串或对象，
 * 因此这里做宽容解析，解析不出来就返回空数组而不是抛错
 * @param meta Prisma 错误上下文
 * @returns 冲突字段名列表
 */
function extractUniqueFields(meta: Record<string, unknown> | undefined): string[] {
  const target = meta?.['target'];
  if (Array.isArray(target)) {
    return target.map((item) => String(item));
  }
  if (typeof target === 'string' && target.length > 0) {
    return [target];
  }
  return [];
}

/**
 * 把 zod 校验失败转换为字段级错误列表。
 *
 * @param error zod 异常
 * @returns 字段级错误列表（嵌套字段用 `.` 连接，数组元素用 `[0]`）
 */
function zodToFieldErrors(error: ZodError): FieldError[] {
  return error.issues.map((issue) => ({
    field: issue.path.join('.') || '(root)',
    message: issue.message,
    code: ErrorCode.FIELD_FORMAT_INVALID,
  }));
}

/**
 * 把任意异常归一成 {@link AppError}。
 *
 * @description 归一化顺序：AppError → zod → Prisma 已知错误 → 未知错误。
 * 已知来源保留各自的语义（P2002 → 409、P2025 → 404、zod → 400 字段级明细），
 * 未知来源一律降级为 90007 / 500 且抹掉原始 message。
 * @param error 任意捕获值
 * @returns 归一化后的应用异常
 */
function toAppError(error: unknown): AppError {
  // 1. 业务主动抛出：原样透传，各自的 httpStatus / code / data 已就位
  if (error instanceof AppError) {
    return error;
  }

  // 2. zod 校验失败：转成字段级 errors[]，前端可直接渲染到表单项下方
  if (error instanceof ZodError) {
    return new ValidationError('参数校验失败', { errors: zodToFieldErrors(error) });
  }

  // 3. Prisma 已知错误码：把数据库语义翻译成 HTTP 语义
  if (isPrismaKnownError(error)) {
    const meta = error.meta;

    switch (error.code) {
      case 'P2002': {
        // 唯一键冲突 → 409。§5.2 尚未登记「通用唯一键冲突」错误码，
        // 暂用 90001 承载并显式指定 httpStatus 409，待错误码表补充后替换为专属 code
        return new ConflictError('数据已存在，请勿重复提交', {
          code: ErrorCode.VALIDATION_FAILED,
          httpStatus: 409,
          data: { fields: extractUniqueFields(meta) },
        });
      }
      case 'P2025': {
        // 记录不存在（update/delete 影响 0 行）→ 404
        return new NotFoundError('记录不存在或已被删除', {
          code: ErrorCode.ROUTE_NOT_FOUND,
          data: { detail: meta ?? null },
        });
      }
      case 'P2003': {
        // 外键约束失败：引用了不存在的记录 → 400
        return new ValidationError('关联数据不存在，无法完成操作', {
          code: ErrorCode.FIELD_FORMAT_INVALID,
          data: { detail: meta ?? null },
        });
      }
      case 'P2014': {
        // 删除/更新会破坏必填关系 → 409
        return new ConflictError('存在关联数据，无法完成该操作', {
          code: ErrorCode.VALIDATION_FAILED,
          httpStatus: 409,
          data: { detail: meta ?? null },
        });
      }
      default: {
        // 其余 Prisma 错误码（连接失败、超时、死锁 1213、锁等待超时 1205）：
        // 属于依赖故障，标记为不可操作异常以触发告警
        return new AppError('数据库操作失败，请稍后重试', {
          code: ErrorCode.DEPENDENCY_UNAVAILABLE,
          httpStatus: 500,
          isOperational: false,
          data: { prismaCode: error.code },
          cause: error,
        });
      }
    }
  }

  // 4. 未知错误：只给通用文案，原始信息全部留在日志里
  return new AppError(getErrorMeta(ErrorCode.SYSTEM_INTERNAL).message, {
    code: ErrorCode.SYSTEM_INTERNAL,
    httpStatus: 500,
    isOperational: false,
    data: null,
    cause: error,
  });
}

/**
 * 全局异常中间件。
 *
 * @description **必须最后注册**（§5.5 第 14 步），否则它之后的中间件抛错无人处理。
 *
 * 响应已发出的处理：流式响应或控制器已 `res.json()` 之后再抛错时，
 * 头部已经发出，此时再写响应体会抛 `ERR_HTTP_HEADERS_SENT`。
 * 正确做法是 `next(err)` 交回 Express 默认处理器，由它销毁连接。
 *
 * @returns Express 错误处理中间件（四参数签名）
 */
export function errorHandler(): ErrorRequestHandler {
  return (err: unknown, req, res, next): void => {
    if (res.headersSent) {
      next(err);
      return;
    }

    const appError = toAppError(err);
    const requestId = req.requestId ?? getRequestId();

    // 限流响应必须带 Retry-After（§5.8）：前端据此展示倒计时并自动重试
    if (appError instanceof RateLimitError) {
      res.setHeader('Retry-After', String(appError.retryAfter));
    }

    const fields = {
      requestId,
      method: req.method,
      path: req.originalUrl,
      errCode: appError.code,
      errMessage: appError.message,
      status: appError.httpStatus,
    };

    if (appError.isOperational) {
      // 预期内的业务拒绝：warn 级别，不触发告警（库存不足、状态非法、参数错误）
      logWarn('request.rejected', fields);
    } else {
      // 程序缺陷或依赖故障：error 级别 + 原始堆栈，接入告警通道
      logError('request.unhandled_error', err, fields);
    }

    // data 里绝不包含 stack：AppError.data 由抛出处显式构造，未知错误的 data 为 null
    sendFail(res, appError.code, appError.message, appError.data ?? null, appError.httpStatus);
  };
}

export default errorHandler;
