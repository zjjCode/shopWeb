/**
 * @file server/src/controllers/admin/AdminOrderController.ts
 * @description 后台订单控制器：POST /admin/orders/:orderNo/ship（发货，F10 ①）
 * @module controllers/admin
 * @see docs/04-flows.md F10（发货与确认收货）
 * @see src/controllers/admin/AdminRefundController.ts（后台作用域同类写法）
 * @author 软件开发团队
 * @created 2026-09-12
 *
 * 分层铁律：控制器**只做**取参、调用 service、组装响应，**禁止直接写 Prisma 查询**。
 *
 * 越权防护：后台接口统一 `auth({ scope: 'admin' })` + `adminOnly()` + `authorize('order:ship')`，
 * `adminId` 只从 `req.auth` 取，绝不从 body 读。C 端 token 被 `adminOnly()` 挡在门外。
 *
 * 物流轨迹订阅（F10 ① `OS->>LA: subscribe`）与操作日志（F10 `OS->>AL: 写 operation_logs`）
 * 一期未接入：`LogisticsAdapter` 与 `AuditService` 尚未落地，留待 T091 后台运营统一补；
 * 二者均为旁路能力，缺失不阻断订单状态流转（符合 F10.2「物流降级不阻断」「幂等靠状态更新」）。
 */

import type { Request, Response } from 'express';
import { sendOk } from '@/core/response';
import { OrderStatus } from '@prisma/client';
import { orderService } from '@/services/OrderService';
import type { ShipOrderBody } from '@/validators/order.validator';

/**
 * 后台订单控制器。
 */
export class AdminOrderController {
  /**
   * 发货（F10 ①）：POST /admin/orders/:orderNo/ship。
   *
   * @description 仅 `PAID` 可发货（service 层校验，非 PAID 抛 31002）；写入物流公司编码/名称/
   * 运单号 + `autoConfirmAt = shippedAt + 15 天`，并注册延迟自动确认 job。
   * 响应体：`{ orderNo, status: 'SHIPPED' }`。
   * @param req Express 请求（orderNo 来自路径参数，物流信息来自 body）
   * @param res Express 响应
   * @returns void
   */
  async ship(req: Request, res: Response): Promise<void> {
    const { orderNo } = req.params as { orderNo: string };
    const body = req.body as ShipOrderBody;
    const adminId = BigInt(req.auth!.userId);

    await orderService.ship(adminId, orderNo, {
      companyCode: body.companyCode,
      companyName: body.companyName,
      trackingNo: body.trackingNo,
      remark: body.remark ?? null,
    });

    sendOk(res, { orderNo, status: OrderStatus.SHIPPED });
  }
}

/** 默认单例 */
export const adminOrderController = new AdminOrderController();

export default adminOrderController;
