/**
 * @file server/src/middlewares/httpLogger.ts
 * @description HTTP 访问日志中间件：请求进入记 http.request，响应完成记 http.response（>1s 转 warn）
 * @module middlewares
 * @see docs/02-architecture.md §5.3（分层记录点：中间件入口与出口）
 * @author 软件开发团队
 * @created 2026-09-03
 */

import type { RequestHandler } from 'express';
import { buildRequestLog, buildResponseLog, SLOW_REQUEST_MS, type HttpLogFields } from '@/core/logger/httpFormat';
import { logHttp, logWarn } from '@/core/logger/logger';

/**
 * HTTP 访问日志中间件（紧跟 requestId 之后注册）。
 *
 * 实现要点：
 * 1. 入口只记录**元数据**（method/path/query/ip/ua/body 大小），**不打印 body** —— body 里可能有密码与卡号；
 * 2. 出口挂在 `res.finish` 钩子上，此时状态码与耗时已确定；
 * 3. 慢请求（>1s）升级为 warn，便于性能排查（§5.3）。
 *
 * @returns Express 中间件
 */
export function httpLog(): RequestHandler {
  return (req, res, next) => {
    const fields: HttpLogFields = buildRequestLog(req, req.requestId);
    const startedAt = process.hrtime.bigint();

    logHttp({ ...fields } as unknown as Record<string, unknown>);

    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      const completed = buildResponseLog(fields, res, Math.round(durationMs * 100) / 100);

      if (durationMs > SLOW_REQUEST_MS) {
        logWarn('http.slow_response', completed as unknown as Record<string, unknown>);
        return;
      }
      logHttp(completed as unknown as Record<string, unknown>);
    });

    next();
  };
}
