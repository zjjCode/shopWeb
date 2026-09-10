/**
 * @file server/src/middlewares/security.ts
 * @description 安全中间件：helmet 安全响应头 + HTTP 参数污染防护（hpp 的零依赖等价实现）
 * @module middlewares
 * @see docs/02-architecture.md §5.5（第 4 步）、§7.4（注入与 XSS 防护）
 * @author 软件开发团队
 * @created 2026-09-03
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import helmet from 'helmet';

/**
 * helmet 实例：按 §7.4 定制 CSP。
 *
 * CSP 说明：
 * - `default-src 'self'`：默认只允许同源资源；
 * - `img-src 'self' data: https:`：商品图可能来自 CDN（https）与内联 data URI；
 * - `object-src 'none'`：彻底关闭 `<object>/<embed>/<applet>`，这是 XSS 的常见载体。
 */
const helmetMiddleware = helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"], // Element Plus 与内联样式需要
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"], // 等价于 X-Frame-Options: DENY
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
  frameguard: { action: 'deny' },
  noSniff: true,
  hsts: { maxAge: 15_552_000, includeSubDomains: true }, // 180 天
});

/**
 * HTTP 参数污染（HPP）防护。
 *
 * @description `?status=1&status=2` 在不同框架下会解析成字符串或数组，攻击者利用这种差异
 * 绕过校验逻辑。这里统一**只保留第一个值**（与主流 API 网关行为一致），让校验结果确定。
 * @returns Express 中间件
 */
export function hppGuard(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    for (const [key, value] of Object.entries(req.query)) {
      if (Array.isArray(value)) {
        req.query[key] = value[0];
      }
    }
    next();
  };
}

/**
 * 安全中间件组合（helmet + hpp）。
 *
 * @returns Express 中间件数组
 */
export function security(): RequestHandler[] {
  return [helmetMiddleware, hppGuard()];
}
