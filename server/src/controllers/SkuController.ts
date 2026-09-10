/**
 * @file server/src/controllers/SkuController.ts
 * @description SKU 控制器：/api/skus/:id/quote 实时报价（商品浏览环节）
 * @module controllers
 * @see docs/02-architecture.md §5.5（分层：routes → controllers → services）
 * @see docs/04-flows.md:262（SKU 报价 GET /api/skus/:id/quote）
 * @author 软件开发团队
 * @created 2026-09-06
 *
 * 分层铁律：控制器**只做**取参、调 service、组响应，**禁止直接写 Prisma 查询**
 * （本文件不应出现任何 `@prisma/client` 的导入）。
 * 报价是公开读接口（登录前也要能看到价格），无需 access token。
 *
 * ⚠️ 不要在这里手工转换 bigint：{@link SkuQuote} 的 `skuId` / `price` / `originalPrice`
 * 都是 bigint（金额一律「分」且用 BigInt 承载）。响应体里的 bigint 由 `app.ts` 全局注册的
 * `json replacer`（{@link jsonReplacer}）统一处理，控制器再做 `Number()` 既重复又容易漏，
 * 还会让「缓存命中（number）」与「查库（bigint）」两种来源在出口表现不一致。
 */

import type { Request, Response } from 'express';
import { sendOk } from '@/core/response';
import { skuService } from '@/services/SkuService';
import type { SkuIdParam } from '@/validators/product.validator';

/**
 * SKU 控制器。
 */
export class SkuController {
  /**
   * SKU 实时报价。
   *
   * @description `req.params.id` 已被 validate 中间件按 `skuIdParamSchema` 校验并
   * **回写成 bigint**（见 src/middlewares/validate.ts:88），这里直接透传给 service，
   * 不再重复解析字符串。SKU 不存在由 service 抛 21002，经 asyncHandler 交给 errorHandler 输出 404。
   *
   * 价格可缓存 60s、库存每次读库（docs/04-flows.md:266），这些取舍都在 service 内，
   * 控制器不感知数据来源。
   *
   * @param req Express 请求
   * @param res Express 响应
   * @returns void
   */
  async quote(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as SkuIdParam;

    const quote = await skuService.getQuote(id);
    sendOk(res, quote);
  }
}

/** 默认单例 */
export const skuController = new SkuController();

export default skuController;
