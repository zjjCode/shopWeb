/**
 * @file server/src/routes/api/product.routes.ts
 * @description C 端商品 / SKU 路由：/api/products（列表、详情）与 /api/skus/:id/quote（报价）
 * @module routes/api
 * @see docs/02-architecture.md §5.5（中间件顺序）、§5.8（限流）
 * @see docs/04-flows.md:243（商品列表）、:252（商品详情）、:262（SKU 报价）
 * @author 软件开发团队
 * @created 2026-09-06
 *
 * 为什么 SKU 报价不单独建 `sku.routes.ts`：
 * `docs/02-architecture.md` 的 C 端路由树里**没有** `sku.routes.ts` —— 后台侧把 SKU 挂在
 * `adminProduct.routes.ts`（`/admin/products/*、/admin/skus/*`）。C 端只有一个报价端点，
 * 为它单开文件会让「一个端点一个文件」的粒度失衡，也与目录树不一致，
 * 因此 `/api/skus/:id/quote` 一并放在本文件，与商品读端点同属「前台浏览」这一组。
 *
 * 中间件顺序要点：**`validate` 必须排在 `pagination` 之前**。
 * `validate` 会把 zod 转换后的值回写 `req.query`（src/middlewares/validate.ts:88 用 `Object.assign`），
 * 之后 `pagination()` 才能读到已经是 number 的 `page` / `pageSize`；顺序反了，
 * `normalizePaging` 拿到的是原始字符串，只能靠自己的容错兜底，校验层的 400 语义就丢了。
 *
 * 本文件**只做装配**：不出现任何业务逻辑，也不出现 Prisma 调用。
 */

import { type Router, Router as ExpressRouter } from 'express';
import { RATE_LIMIT_KEY, RATE_LIMIT_PRESETS } from '@/config/constants';
import { productController } from '@/controllers/ProductController';
import { skuController } from '@/controllers/SkuController';
import { asyncHandler } from '@/middlewares/asyncHandler';
import { pagination } from '@/middlewares/pagination';
import { rateLimit } from '@/middlewares/rateLimit';
import { validate } from '@/middlewares/validate';
import { productIdParamSchema, productListSchema, skuIdParamSchema } from '@/validators/product.validator';

/**
 * 默认接口限流：IP/路由维度 120 次/分钟。
 *
 * @description 读接口能被列表页、搜索页高频触发，统一兜一层，避免单 IP 刷爆数据库
 * @returns 限流中间件
 */
function defaultRateLimit(): ReturnType<typeof rateLimit> {
  return rateLimit({
    windowMs: RATE_LIMIT_PRESETS.DEFAULT.windowMs,
    max: RATE_LIMIT_PRESETS.DEFAULT.max,
    prefix: RATE_LIMIT_KEY.ROUTE,
    message: '请求过于频繁，请稍后再试',
  });
}

/**
 * 构建 C 端商品 / SKU 路由。
 *
 * @returns Express Router
 */
export function createProductRouter(): Router {
  const router = ExpressRouter();

  // 商品列表：分页读。validate 先跑，pagination 才能拿到转换后的 page/pageSize
  router.get(
    '/products',
    defaultRateLimit(),
    validate({ query: productListSchema }),
    pagination(),
    asyncHandler(productController.list),
  );

  // 商品详情：路径参数 id 由 validate 转成 bigint
  router.get(
    '/products/:id',
    defaultRateLimit(),
    validate({ params: productIdParamSchema }),
    asyncHandler(productController.detail),
  );

  // SKU 报价：价格可缓存 60s，库存实时读库（见 SkuService 说明）
  router.get(
    '/skus/:id/quote',
    defaultRateLimit(),
    validate({ params: skuIdParamSchema }),
    asyncHandler(skuController.quote),
  );

  return router;
}

/** C 端商品 / SKU 路由单例 */
export const productRouter = createProductRouter();

export default productRouter;
