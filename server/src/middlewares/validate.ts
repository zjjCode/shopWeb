/**
 * @file server/src/middlewares/validate.ts
 * @description zod 参数校验中间件：params / query / body / headers 全覆盖，失败输出字段级 errors[]
 * @module middlewares
 * @see docs/02-architecture.md §5.5（第 9 步）、§7.3（参数校验）
 * @author 软件开发团队
 * @created 2026-09-03
 */

import type { RequestHandler } from 'express';
import { z } from 'zod';
import { ValidationError, type FieldError } from '@/core/errors';
import { ErrorCode } from '@/core/errors/errorCodes';

/** 校验目标：分别对应 req 上的四个位置 */
export interface ValidateSchemas {
  params?: z.ZodTypeAny;
  query?: z.ZodTypeAny;
  body?: z.ZodTypeAny;
  headers?: z.ZodTypeAny;
}

/**
 * 把 zod 的 issue 列表转换成字段级错误。
 *
 * @description 字段路径用 `.` 连接嵌套字段、用 `[n]` 表示数组下标，与前端表单字段名可直接对齐
 * @param issues zod 校验问题
 * @param location 参数位置（params/query/body）
 * @returns 字段级错误列表
 */
function toFieldErrors(issues: z.ZodIssue[], location: string): FieldError[] {
  return issues.map((issue) => {
    const path = issue.path.map((segment) => (typeof segment === 'number' ? `[${segment}]` : String(segment))).join('.');
    const field = path.length > 0 ? `${location}.${path}` : location;
    return {
      field,
      message: issue.message,
      code: issue.code === z.ZodIssueCode.invalid_type ? ErrorCode.FIELD_FORMAT_INVALID : ErrorCode.FIELD_FORMAT_INVALID,
    };
  });
}

/**
 * 参数校验中间件。
 *
 * 设计要点：
 * 1. 校验通过后**回写** `req`（`Object.assign(req.params, ...)` 不可行于只读属性，
 *    因此用 `Reflect.set` 覆盖）—— 这样下游拿到的是**类型转换后**的值（如 `page` 已是 number），
 *    避免每个控制器重复 `Number(req.query.page)`；
 * 2. 未知字段由 schema 的 `.strict()` 决定，中间件不强加策略（§7.3 要求 strict）；
 * 3. 失败时一次性汇总**全部**字段错误，而不是遇到第一个就返回，减少前端来回次数。
 *
 * @param schemas 各位置的 zod schema
 * @returns Express 中间件
 */
export function validate(schemas: ValidateSchemas): RequestHandler {
  return (req, _res, next) => {
    const fieldErrors: FieldError[] = [];
    const replacements: Record<string, unknown> = {};

    const locations = ['headers', 'params', 'query', 'body'] as const;

    for (const location of locations) {
      const schema = schemas[location];
      if (!schema) {
        continue;
      }

      const parsed = schema.safeParse(req[location]);
      if (!parsed.success) {
        fieldErrors.push(...toFieldErrors(parsed.error.issues, location));
        continue;
      }
      replacements[location] = parsed.data;
    }

    if (fieldErrors.length > 0) {
      next(ValidationError.fromFieldErrors(fieldErrors));
      return;
    }

    // params 是 Express 从路由模板解析出来的普通对象，可直接覆写字段值
    for (const location of locations) {
      const replacement = replacements[location];
      if (replacement === undefined || typeof replacement !== 'object' || replacement === null) {
        continue;
      }
      Object.assign(req[location] as Record<string, unknown>, replacement);
    }

    next();
  };
}
