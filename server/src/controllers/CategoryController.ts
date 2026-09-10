/**
 * @file server/src/controllers/CategoryController.ts
 * @description 商品分类控制器：/api/categories 分类树查询
 * @module controllers
 * @see docs/02-architecture.md §5.5（分层：routes → controllers → services）
 * @see docs/04-flows.md:230（分类树 GET /api/categories/tree）
 * @author 软件开发团队
 * @created 2026-09-06
 *
 * 分层铁律：控制器**只做**调用 service 与组装响应，**禁止直接写 Prisma 查询**。
 * 分类树是公开读接口（商品浏览第一环），无需 access token。
 */

import type { Request, Response } from 'express';
import { sendOk } from '@/core/response';
import { categoryService } from '@/services/CategoryService';

/**
 * 商品分类控制器。
 */
export class CategoryController {
  /**
   * 三级分类树。
   *
   * @description 响应体统一包一层 `{ list }` 而不是直接返回数组：
   * 日后若要追加 `updatedAt`（缓存生成时间）等元信息，不需要把 `data` 从数组改成对象
   * （那是一次破坏性变更），与 `sendPaged` 的 `{ list, total }` 信封风格保持一致
   * @param _req Express 请求（本接口无入参）
   * @param res Express 响应
   * @returns void
   */
  async tree(_req: Request, res: Response): Promise<void> {
    const tree = await categoryService.getTree();
    sendOk(res, { list: tree });
  }
}

/** 默认单例 */
export const categoryController = new CategoryController();

export default categoryController;
