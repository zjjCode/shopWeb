/**
 * @file server/src/middlewares/bodyParser.ts
 * @description 请求体解析：json / urlencoded + 保留原始 body（回调验签必须）
 * @module middlewares
 * @see docs/02-architecture.md §5.5（第 6 步）、§6.1（回调验签）
 * @author 软件开发团队
 * @created 2026-09-03
 */

import express, { type RequestHandler } from 'express';
import type { Request } from 'express';
import { config } from '@/config';

/**
 * 请求体解析中间件组合。
 *
 * 为什么要保留 rawBody（§6.1）：
 * 支付回调的验签必须用**原始报文**计算签名，一旦被 JSON 解析再序列化，
 * 字段顺序、空白字符、数字精度都可能变化，导致签名校验失败。
 * 因此这里在 `verify` 阶段把 Buffer 原文存到 `req.rawBody`。
 *
 * @returns Express 中间件数组
 */
export function bodyParser(): RequestHandler[] {
  const jsonParser = express.json({
    limit: config.security.bodyLimit,
    verify: (req: Request, _res, buffer: Buffer) => {
      req.rawBody = buffer.toString('utf8');
    },
  });

  const urlencodedParser = express.urlencoded({
    extended: true,
    limit: config.security.bodyLimit,
    verify: (req: Request, _res, buffer: Buffer) => {
      // urlencoded 场景同样保留原文（部分渠道回调使用 form 表单）
      if (req.rawBody === undefined) {
        req.rawBody = buffer.toString('utf8');
      }
    },
  });

  return [jsonParser, urlencodedParser];
}
