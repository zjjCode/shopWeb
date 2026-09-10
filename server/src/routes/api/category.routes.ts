/**
 * @file server/src/routes/api/category.routes.ts
 * @description C 端分类路由：/api/categories（分类树，公开读）
 * @module routes/api
 * @see docs/02-architecture.md §5.5（中间件顺序）、§5.8（限流）、:316（目录树命名）
 * @see docs/04-flows.md:230（分类树 GET /api/categories/tree）
 * @author 软件开发团队
 * @created 2026-09-06
 *
 * 命名：与 `docs/02-architecture.md:316` 的目录树一致（`category.routes.ts  # /api/categories/*  公开`），
 * 不再使用旧的 `catalog.routes.ts`。商品与 SKU 的 C 端读端点拆到 `product.routes.ts`，
 * 本文件只负责分类。
 *
 * 端点收敛：只保留 `/categories/tree`。旧文件曾把 `/categories` 与 `/categories/tree`
 * 同时指向同一 handler，但 `docs/04-flows.md:230` 的时序图只有 `/api/categories/tree`，
 * `/api/categories` 在设计文档里查无实据，已按裁定删除别名。
 *
 * 限流：分类树是公开接口且被首页高频调用，挂 IP 维度「默认接口」阈值（120 次/分钟）兜底。
 */

import { type Router, Router as ExpressRouter } from 'express';
import { RATE_LIMIT_KEY, RATE_LIMIT_PRESETS } from '@/config/constants';
import { categoryController } from '@/controllers/CategoryController';
import { asyncHandler } from '@/middlewares/asyncHandler';
import { rateLimit } from '@/middlewares/rateLimit';

/**
 * 构建 C 端分类路由。
 *
 * @returns Express Router
 */
export function createCategoryRouter(): Router {
  const router = ExpressRouter();

  // 分类树：公开读；IP 维度 120 次/分钟
  router.get(
    '/categories/tree',
    rateLimit({
      windowMs: RATE_LIMIT_PRESETS.DEFAULT.windowMs,
      max: RATE_LIMIT_PRESETS.DEFAULT.max,
      prefix: RATE_LIMIT_KEY.ROUTE,
      message: '请求过于频繁，请稍后再试',
    }),
    asyncHandler(categoryController.tree),
  );

  return router;
}

/** C 端分类路由单例 */
export const categoryRouter = createCategoryRouter();

export default categoryRouter;
