/**
 * @file server/src/controllers/OrderController.ts
 * @description 下单控制器：POST /api/orders（事务 A 的 HTTP 入口）
 * @module controllers
 * @see docs/04-flows.md F5（363-536 行）、docs/02-architecture.md §5.5（分层）
 * @author 软件开发团队
 * @created 2026-09-07
 *
 * 分层铁律：控制器**只做**取参、调用 service、组装响应，**禁止直接写 Prisma 查询**
 * （本文件不 import 任何 Prisma 相关内容，可作为一条可被 grep 校验的红线）。
 *
 * 越权防护：`userId` **只从 `req.auth` 取**，绝不从 body 读。
 * 若从入参读 userId，任何人改一个数字就能用别人的地址下单。
 *
 * ⚠️ `AuthPrincipal.userId` 是 `number`，而 `OrderService` 要求 `bigint`：
 * 换算放在控制器边界这一层，由 {@link currentUserId} 统一负责。
 *
 * 幂等：由路由上的 `idempotency` 中间件以 `Idempotency-Key` 头抢占保证，
 * 控制器不感知幂等——重复提交根本到不了这里（中间件直接回放首次响应快照）。
 */

import type { Request, Response } from 'express';
import { sendOk } from '@/core/response';
import { orderService } from '@/services/OrderService';
import type { CreateOrderInput } from '@/validators/order.validator';

/**
 * 取当前登录用户的 ID（bigint）。
 *
 * @description 只认 `req.auth`：路由上已挂 `auth({ scope: 'shop' })`，
 * 未登录请求会被中间件挡掉，这里用非空断言是安全的（中间件保证了不变量）。
 * @param req Express 请求
 * @returns 用户 ID（bigint）
 */
function currentUserId(req: Request): bigint {
  return BigInt(req.auth!.userId);
}

/**
 * 下单控制器。
 */
export class OrderController {
  /**
   * 提交订单。
   *
   * @description 服务端只信 `addressId` + `cartItemIds`，**金额一律在此之下由
   * `PriceService` 重算**（F5 阶段 2）。前端传来的任何金额都会在校验层被 strict 拒掉。
   *
   * 响应体：`{ orderNo, payAmount, expireAt }`。
   * 其中 `payAmount` 是 bigint（分），依赖 `app.set('json replacer', jsonReplacer)`
   * 才能正常序列化成字符串——未接线时 Express 会直接 500。
   *
   * @param req Express 请求（body 已由 validate 中间件转换：ID 为 bigint）
   * @param res Express 响应
   * @returns void
   */
  async create(req: Request, res: Response): Promise<void> {
    const dto = req.body as CreateOrderInput;
    const result = await orderService.createOrder(currentUserId(req), dto);
    sendOk(res, result);
  }

  /**
   * 取消「待支付」订单（F8 路径 1，仅 C 端用户）。
   *
   * @description 越权防护由 service 层以 `userId` 兜底（越权或缺单统一 31001）；
   * 本期仅允许待支付订单取消，已支付取消需走退款流程（见 F9）。
   * 响应体：`{ orderNo, cancelled: true }`。
   * @param req Express 请求（orderNo 来自路由参数，reason 来自 body）
   * @param res Express 响应
   * @returns void
   */
  async cancel(req: Request, res: Response): Promise<void> {
    const { orderNo } = req.params as { orderNo: string };
    const body = (req.body ?? {}) as { reason?: string | null };
    await orderService.cancelByUser(currentUserId(req), orderNo, body.reason ?? null);
    sendOk(res, { orderNo, cancelled: true });
  }

  /**
   * 确认收货（F10 ③，仅 C 端用户）。
   *
   * @description 越权防护由 service 层以 `userId` 兜底（越权或缺单统一 31001）。
   * 响应体：`{ orderNo, completed: true }`。
   * @param req Express 请求（orderNo 来自路由参数）
   * @param res Express 响应
   * @returns void
   */
  async confirm(req: Request, res: Response): Promise<void> {
    const { orderNo } = req.params as { orderNo: string };
    await orderService.confirmReceipt(currentUserId(req), orderNo);
    sendOk(res, { orderNo, completed: true });
  }
}

/** 默认单例 */
export const orderController = new OrderController();

export default orderController;
