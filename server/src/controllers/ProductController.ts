/**
 * @file server/src/controllers/ProductController.ts
 * @description 商品控制器：/api/products 列表与详情（商品浏览环节）
 * @module controllers
 * @see docs/02-architecture.md §5.5（分层：routes → controllers → services）、§5.7（分页封装）
 * @see docs/04-flows.md:243（商品列表）、:252（商品详情）
 * @author 软件开发团队
 * @created 2026-09-06
 *
 * 分层铁律：控制器**只做**取参、调 service、组响应，**禁止直接写 Prisma 查询**
 * （本文件不应出现任何 `@prisma/client` 的导入）。
 * 商品浏览是公开读接口（登录前也要能逛），无需 access token。
 */

import type { Request, Response } from 'express';
import { sendOk, sendPaged } from '@/core/response';
import { productService } from '@/services/ProductService';
import { normalizePaging, type RawPagingQuery } from '@/utils/paging';
import type { ProductIdParam, ProductListQuery } from '@/validators/product.validator';

/**
 * 商品控制器。
 */
export class ProductController {
  /**
   * 商品列表（分页）。
   *
   * @description 入参有两个来源，二者都已是**转换后**的值，控制器不再做任何 `Number()`：
   * - `req.query`：validate 中间件按 zod schema 校验后**回写**（见 validate.ts:88），
   *   因此 `categoryId` 已是 bigint；
   * - `req.pagination`：pagination 中间件归一化后的 `{ page, pageSize, skip, take }`。
   *   它是可选属性（中间件按需挂载），缺失时用 {@link normalizePaging} 兜底，
   *   保证漏挂中间件时接口仍然可用且参数安全，而不是拿到 undefined 去 skip/take。
   * @param req Express 请求
   * @param res Express 响应
   * @returns void
   */
  async list(req: Request, res: Response): Promise<void> {
    const query = req.query as unknown as ProductListQuery;
    const paging = req.pagination ?? normalizePaging(req.query as RawPagingQuery);

    const { list, total } = await productService.list(query, paging);
    sendPaged(res, list, total, paging.page, paging.pageSize);
  }

  /**
   * 商品详情。
   *
   * @description `req.params.id` 已被 validate 中间件回写成 bigint（路由侧用
   * `productIdParamSchema` 校验），这里不再重复解析；商品不存在或已下架由 service 抛
   * 21001，经 asyncHandler 交给 errorHandler 输出 404。
   * @param req Express 请求
   * @param res Express 响应
   * @returns void
   */
  async detail(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as ProductIdParam;

    const data = await productService.detail(id);
    sendOk(res, data);
  }
}

/** 默认单例 */
export const productController = new ProductController();

export default productController;
