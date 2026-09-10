/**
 * @file server/src/middlewares/notFound.ts
 * @description 兜底 404 中间件：所有未匹配路由 → 统一响应（错误码 90003）
 * @module middlewares
 * @see docs/02-architecture.md §5.5（第 13 步：兜底 → 90003）
 * @author 软件开发团队
 * @created 2026-09-04
 *
 * 为什么必须显式兜底：
 * Express 默认的 404 是一段 HTML（"Cannot GET /xxx"）。前端 axios 拦截器按
 * `Content-Type: application/json` 解析会直接抛语法错误，用户看到的是「网络异常」
 * 而不是「接口不存在」。因此必须自己兜底，保证**任何**响应都是统一信封（§5.1）。
 */

import type { RequestHandler } from 'express';
import { ErrorCode, getErrorMeta } from '@/core/errors/errorCodes';
import { sendFail } from '@/core/response';

/**
 * 路由兜底中间件。
 *
 * @description 必须注册在**所有业务路由之后**、{@link errorHandler} 之前（§5.5 顺序表）。
 * 自检：若把它注册在路由之前，所有请求都会被判定为 404。
 *
 * 这里直接 `sendFail` 而不是 `next(new NotFoundError(...))`：
 * 兜底 404 是最外层逻辑，自身不应该再依赖 errorHandler 是否注册 ——
 * 在单元测试里只装配一个小 app 时，直接响应能保证行为确定。
 *
 * @returns Express 中间件（不调用 next）
 */
export function notFound(): RequestHandler {
  return (req, res) => {
    const meta = getErrorMeta(ErrorCode.ROUTE_NOT_FOUND);
    sendFail(
      res,
      ErrorCode.ROUTE_NOT_FOUND,
      meta.message,
      { method: req.method, path: req.originalUrl },
      meta.httpStatus,
    );
  };
}

export default notFound;
