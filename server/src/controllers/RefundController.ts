/**
 * @file server/src/controllers/RefundController.ts
 * @description C 端退款控制器：/api/refunds（申请 / 列表 / 详情）
 * @module controllers
 * @see docs/04-flows.md F9（退款流程）、docs/02-architecture.md §5.5（分层铁律）
 * @see src/controllers/PaymentController.ts（同类写法：只从 req.auth 取 userId、边界做 BigInt 转换）
 * @author 软件开发团队
 * @created 2026-09-12
 *
 * 分层铁律：控制器只做取参、调用 service、组装响应，禁止直接写 Prisma 查询
 * （本文件不 import 任何 Prisma 相关内容，与 PaymentController 同口径的红线）。
 *
 * 越权防护：所有方法的 `userId` 只从 `req.auth` 取，绝不从 body / query 读。
 * 退款单是用户私有资金数据，路由层 `auth({ scope: 'shop' })` 是第一道闸门，
 * 这里 `currentUserId` 是第二道——两者缺一不可。service 层还会按 `where.userId` 兜底（统一 404）。
 *
 * 金额：`apply` 的 `amount` 由 validator 转成 bigint（分），前端传不进 `refundTo`
 * （validator strict 拒收），退款去向完全由 service 按订单 `payMethod` 映射。
 */

import type { Request, Response } from 'express';
import { sendCreated, sendOk } from '@/core/response';
import { refundService } from '@/services/RefundService';
import type {
  ApplyRefundBody,
  ListRefundsQuery,
  RefundNoParam,
} from '@/validators/refund.validator';

/**
 * 取当前登录用户的 ID（bigint）。
 *
 * @description 只认 `req.auth`：路由上已挂 `auth({ scope: 'shop' })`，未登录请求会被中间件挡掉，
 * 这里用非空断言是安全的（中间件保证了不变量）。
 * @param req Express 请求
 * @returns 用户 ID（bigint）
 */
function currentUserId(req: Request): bigint {
  return BigInt(req.auth!.userId);
}

/**
 * C 端退款控制器。
 */
export class RefundController {
  /**
   * 申请退款：POST /api/refunds。
   *
   * @description 只信 `orderNo` / `type` / `amount` / 原因，**不收退款去向**。
   * service 全程事务外只读校验（归属 / 状态 / 售后期 / 进行中 / 金额），失败即抛错且不写库。
   * 响应体：`{ refundNo, status }`（status 恒 PENDING）。
   * @param req Express 请求（body 已由 validate 转换，amount 已是 bigint）
   * @param res Express 响应
   * @returns void
   * @throws {NotFoundError} 订单不存在或不属该用户（31001）
   * @throws {BusinessError} 订单状态不可退（31002）、超出售后期（31005）
   * @throws {ConflictError} 存在进行中退款单（41003）、退款金额超额（41002）
   */
  async apply(req: Request, res: Response): Promise<void> {
    const dto = req.body as ApplyRefundBody;
    const result = await refundService.apply(currentUserId(req), dto);
    sendCreated(res, result);
  }

  /**
   * 退款列表：GET /api/refunds（当前用户，分页，按创建时间倒序）。
   *
   * @description 越权红线由 service 的 `where.userId` 兜底。query 已由 validate 转换，
   * `page` / `pageSize` 已是 number。
   * @param req Express 请求
   * @param res Express 响应
   * @returns void
   */
  async list(req: Request, res: Response): Promise<void> {
    const query = req.query as unknown as ListRefundsQuery;
    const result = await refundService.listByUser(currentUserId(req), {
      page: query.page,
      pageSize: query.pageSize,
    });
    sendOk(res, result);
  }

  /**
   * 退款详情：GET /api/refunds/:refundNo。
   *
   * @description 越权统一 404（service 按 `where.userId` 兜底，不区分「不存在」与「不属于你」），
   * 防止响应差异探测。含退款行明细 `items`。
   * @param req Express 请求（params.refundNo 已由 validate 校验）
   * @param res Express 响应
   * @returns void
   * @throws {NotFoundError} 退款单不存在或不属该用户（41001）
   */
  async detail(req: Request, res: Response): Promise<void> {
    const { refundNo } = req.params as unknown as RefundNoParam;
    const refund = await refundService.getByNo(currentUserId(req), refundNo);
    sendOk(res, refund);
  }
}

/** 默认单例 */
export const refundController = new RefundController();

export default refundController;
