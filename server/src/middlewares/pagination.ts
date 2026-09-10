/**
 * @file server/src/middlewares/pagination.ts
 * @description 分页中间件：解析 page / pageSize 并归一化后挂载到 req.pagination
 * @module middlewares
 * @see docs/02-architecture.md §5.5（第 11 步：路由级按需挂载）、§5.7（分页封装）
 * @author 软件开发团队
 * @created 2026-09-04
 *
 * 为什么要收敛成中间件：
 * 列表接口分散在几十个控制器里，若各自写 `Number(req.query.page)`，
 * 一定会长出 `?page=-1`、`?pageSize=1000000` 这类既能绕过校验、又能一次拖垮数据库的写法。
 * 收敛到中间件后，控制器拿到的永远是已经归一化的 `{ page, pageSize, skip, take }`。
 */

import type { RequestHandler } from 'express';
import { normalizePaging, type RawPagingQuery } from '@/utils/paging';

/**
 * 分页参数中间件。
 *
 * @description 分页与排序的**服务端截断策略**（§5.7）：
 * `pageSize` 超出 `LIST_RULE.MAX_PAGE_SIZE` 时截断而不是报错 ——
 * 前端偶发传大值时直接拒绝会让用户看到莫名其妙的失败，但截断必须发生在服务端。
 * 排序字段白名单校验请配合 {@link normalizeSort} 在控制器内完成（每个列表允许排序的列不同）。
 *
 * 用法（列表路由）：
 * ```ts
 * router.get('/orders', auth(), pagination(), asyncHandler(listOrders));
 * ```
 *
 * @returns Express 中间件
 */
export function pagination(): RequestHandler {
  return (req, _res, next) => {
    req.pagination = normalizePaging(req.query as RawPagingQuery);
    next();
  };
}

export default pagination;
