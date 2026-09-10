/**
 * @file server/src/core/logger/httpFormat.ts
 * @description HTTP 访问日志格式：请求进入 / 响应完成的结构化字段构造
 * @module core/logger
 * @see docs/02-architecture.md §5.3（分层记录点：中间件入口与出口）
 * @author 软件开发团队
 * @created 2026-09-03
 */

import type { Request, Response } from 'express';
import { redact } from './redact';

/** HTTP 访问日志字段 */
export interface HttpLogFields {
  msg: string;
  method: string;
  path: string;
  /** 完整 URL（含 query，已脱敏） */
  url: string;
  query: Record<string, unknown>;
  ip: string;
  userAgent: string;
  requestId: string;
  /** 请求体大小（字节），不打印 body 内容 */
  requestSize?: number;
  /** 响应完成后补充 */
  status?: number;
  durationMs?: number;
  responseSize?: number;
  /** 业务响应码（统一响应体中的 code） */
  code?: number | null;
}

/** 慢请求阈值（毫秒），超过则日志级别升为 warn（§5.3） */
export const SLOW_REQUEST_MS = 1000;

/** 需要脱敏后再打印的 query 参数 */
const SENSITIVE_QUERY_KEYS = new Set(['token', 'access_token', 'code', 'signature', 'sign']);

/**
 * 取客户端 IP。
 *
 * @description 生产部署在 Nginx 之后，需信任一层代理（config.security.trustProxy）后取 X-Forwarded-For
 * @param req Express 请求对象
 * @returns 客户端 IP
 */
export function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0]?.trim() ?? req.ip ?? 'unknown';
  }
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

/**
 * 构造「请求进入」阶段的日志字段。
 *
 * @description query 会被脱敏且剔除敏感参数，body 只记录大小不记录内容（防密码/Token 入库日志）
 * @param req Express 请求对象
 * @param requestId 全链路 ID
 * @returns 日志字段
 */
export function buildRequestLog(req: Request, requestId: string): HttpLogFields {
  const query: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(req.query ?? {})) {
    query[key] = SENSITIVE_QUERY_KEYS.has(key.toLowerCase()) ? '******' : value;
  }

  const contentLength = Number(req.headers['content-length'] ?? 0);

  return {
    msg: 'http.request',
    method: req.method,
    path: req.path,
    url: req.originalUrl,
    query: redact(query) as Record<string, unknown>,
    ip: getClientIp(req),
    userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : 'unknown',
    requestId,
    requestSize: Number.isNaN(contentLength) ? 0 : contentLength,
  };
}

/**
 * 构造「响应完成」阶段的日志字段。
 *
 * @description 响应体已发送后才调用，此时可拿到 status 与耗时；>1s 的慢请求由调用方降级为 warn
 * @param base 请求进入阶段的字段
 * @param res Express 响应对象
 * @param durationMs 处理耗时（毫秒）
 * @param code 统一响应体中的业务码（非 2xx 时为错误码）
 * @returns 日志字段
 */
export function buildResponseLog(
  base: HttpLogFields,
  res: Response,
  durationMs: number,
  code: number | null = null,
): HttpLogFields {
  return {
    ...base,
    msg: 'http.response',
    status: res.statusCode,
    durationMs,
    responseSize: Number(res.getHeader('content-length') ?? 0),
    code,
  };
}
