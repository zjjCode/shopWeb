/**
 * @file server/src/types/express.d.ts
 * @description Express Request 类型扩展：requestId / rawBody / auth / permissions / pagination / idempotencyKey
 * @module types
 * @see docs/02-architecture.md §5.5（中间件执行顺序）
 * @author 软件开发团队
 * @created 2026-09-03
 *
 * 约定：中间件只允许通过这里声明的字段向下游传递数据。
 * 想加新字段必须先在此登记，避免各中间件往 `req` 上挂野属性（那等于放弃了类型检查）。
 */

import type { AuthPrincipal, PageParams } from './common';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** 全链路追踪 ID（requestId 中间件注入，同时写入响应头 X-Request-Id） */
      requestId: string;
      /**
       * 原始请求体文本：回调验签必须使用原始报文。
       *
       * JSON 解析再 stringify 会改变键序与空白，导致签名校验失败，
       * 因此 bodyParser 必须保留未经处理的原文（§5.5 第 6 步）。
       */
      rawBody?: string;
      /** 认证主体（auth 中间件注入，未认证时为 undefined） */
      auth?: AuthPrincipal;
      /** 归一化后的分页参数（pagination 中间件注入） */
      pagination?: PageParams;
      /** 幂等键（idempotency 中间件注入，取自 Idempotency-Key 请求头） */
      idempotencyKey?: string;
      /** 当前管理员的权限点集合（authorize 中间件注入，仅 admin 作用域） */
      permissions?: ReadonlySet<string>;
      /** 超级管理员绕过标记（superAdminBypass 中间件注入，用于敏感操作的二次放行） */
      superAdminBypass?: boolean;
    }
  }
}

export {};
