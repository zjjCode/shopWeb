/**
 * @file server/src/middlewares/cors.ts
 * @description CORS 白名单中间件：非白名单 Origin 直接 403（统一响应格式）
 * @module middlewares
 * @see docs/02-architecture.md §5.5（第 3 步）
 * @author 软件开发团队
 * @created 2026-09-03
 */

import type { RequestHandler } from 'express';
import { config } from '@/config';
import { ErrorCode } from '@/core/errors';
import { sendFail } from '@/core/response';

/** 预检请求（OPTIONS）的缓存时长（秒） */
const PREFLIGHT_MAX_AGE = 86_400;

/** 允许的请求头 */
const ALLOWED_HEADERS = [
  'Content-Type',
  'Authorization',
  'X-Request-Id',
  'Idempotency-Key',
  'X-Requested-With',
].join(', ');

/** 允许的方法 */
const ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].join(', ');

/**
 * CORS 中间件。
 *
 * 设计要点：
 * 1. **无 Origin 头的请求直接放行** —— 服务端回调（支付宝/微信/聚合支付）与 curl 请求没有 Origin，
 *    走同源策略没有意义，拦了反而让联调无解；
 * 2. 白名单外的浏览器请求返回 403 统一响应，而不是抛异常（§5.5 要求统一格式）；
 * 3. 响应头带 `Vary: Origin`，避免 CDN 把给 A 源的响应缓存给 B 源。
 *
 * @returns Express 中间件
 */
export function cors(): RequestHandler {
  const allowedOrigins = new Set(config.cors.origins);

  return (req, res, next) => {
    const origin = req.headers.origin;

    if (typeof origin !== 'string' || origin.length === 0) {
      next();
      return;
    }

    res.setHeader('Vary', 'Origin');

    if (!allowedOrigins.has(origin)) {
      sendFail(res, ErrorCode.RESOURCE_FORBIDDEN, '该来源不在允许列表内', null, 403);
      return;
    }

    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS);
    res.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS);
    res.setHeader('Access-Control-Max-Age', String(PREFLIGHT_MAX_AGE));

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    next();
  };
}
