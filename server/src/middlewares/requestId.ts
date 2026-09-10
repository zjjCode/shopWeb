/**
 * @file server/src/middlewares/requestId.ts
 * @description 链路 ID 中间件：读取/生成 X-Request-Id → 写入 AsyncLocalStorage 与响应头
 * @module middlewares
 * @see docs/02-architecture.md §5.3（requestId 全链路透传）、§5.5（第 1 个中间件）
 * @author 软件开发团队
 * @created 2026-09-03
 */

import type { RequestHandler } from 'express';
import { HEADER } from '@/config/constants';
import { generateRequestId } from '@/core/idGenerator';
import { runWithContext } from '@/core/logger/requestContext';

/** 可信的客户端 requestId 格式：仅允许字母数字与 -_，长度 8~64（防日志注入与超长字段） */
const TRUSTED_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * 判断客户端传入的 requestId 是否可信。
 *
 * @description 直接采信外部输入会把任意内容写进日志与响应头（日志注入 / 头注入），
 * 因此只接受限定字符集与长度，不合规一律重新生成
 * @param value 请求头中的 X-Request-Id
 * @returns 是否可采信
 */
export function isTrustedRequestId(value: unknown): value is string {
  return typeof value === 'string' && TRUSTED_REQUEST_ID_PATTERN.test(value);
}

/**
 * 链路 ID 中间件（必须注册在所有中间件之前）。
 *
 * 关键实现：后续中间件与控制器都在 `runWithContext` 的回调里执行，
 * 因此整条调用链（含 await 之后的异步续体）都能通过 AsyncLocalStorage 取到 requestId，
 * 业务代码**无需**在函数签名里手动传递（§5.3）。
 *
 * @returns Express 中间件
 */
export function requestId(): RequestHandler {
  return (req, res, next) => {
    const incoming = req.header(HEADER.REQUEST_ID);
    // 上游（Nginx / 网关）传来的 ID 可信则透传，否则生成新的，保证跨服务链路可串起来
    const id = isTrustedRequestId(incoming) ? incoming : generateRequestId();

    req.requestId = id;
    res.setHeader(HEADER.REQUEST_ID, id);

    runWithContext({ requestId: id }, () => next());
  };
}
