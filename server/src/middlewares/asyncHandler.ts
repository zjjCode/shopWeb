/**
 * @file server/src/middlewares/asyncHandler.ts
 * @description 异步路由处理器包装：把 Promise rejection 统一交给 errorHandler
 * @module middlewares
 * @see docs/02-architecture.md §5.5（errorHandler 必须最后注册）
 * @author 软件开发团队
 * @created 2026-09-03
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';

/** 允许同步或异步返回的路由处理器 */
export type MaybeAsyncRequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => Promise<unknown> | unknown;

/**
 * 包装异步处理器。
 *
 * 背景：Express 4 不会自动捕获 async 处理器抛出的异常，未包装的 `async (req,res) => { throw ... }`
 * 会产生 unhandledRejection 并导致请求挂死。所有 async 控制器/中间件都必须过这一层。
 *
 * @param handler 可能返回 Promise 的处理器
 * @returns 标准 Express 中间件
 */
export function asyncHandler(handler: MaybeAsyncRequestHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}
