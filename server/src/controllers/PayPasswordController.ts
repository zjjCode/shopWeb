/**
 * @file server/src/controllers/PayPasswordController.ts
 * @description 支付密码控制器：POST /api/user/pay-password（设置）、PUT /api/user/pay-password（修改）
 * @module controllers
 * @see docs/12-phase12-plan.md（T070）、server/src/services/PayPasswordService.ts
 * @author 软件开发团队
 * @created 2026-09-20
 *
 * 分层铁律：控制器**只做**取参、调用 service、组装响应，**禁止直接写 Prisma**。
 * 越权防护：`userId` **只从 `req.auth` 取**（路由已挂 `auth({ scope: 'shop' })`）。
 */

import type { Request, Response } from 'express';
import { sendOk } from '@/core/response';
import { payPasswordService } from '@/services/PayPasswordService';
import type { ModifyPayPasswordInput, SetPayPasswordInput } from '@/validators/payPassword.validator';

/**
 * 支付密码控制器。
 */
export class PayPasswordController {
  /**
   * 首次设置支付密码。
   *
   * @param req Express 请求（body 已由 validate 校验）
   * @param res Express 响应
   * @returns void
   * @throws {BusinessError} 密码强度不足（61007）/ 已设置（61011）/ 账号不存在（10012）
   */
  async set(req: Request, res: Response): Promise<void> {
    const { payPassword } = req.body as SetPayPasswordInput;
    await payPasswordService.set(req.auth!.userId, payPassword);
    sendOk(res, null);
  }

  /**
   * 修改支付密码。
   *
   * @param req Express 请求（body 已由 validate 校验）
   * @param res Express 响应
   * @returns void
   * @throws {BusinessError} 未设置（61009）/ 原密码错误（61007）/ 新密码强度不足 / 账号不存在（10012）
   */
  async modify(req: Request, res: Response): Promise<void> {
    const { oldPayPassword, payPassword } = req.body as ModifyPayPasswordInput;
    await payPasswordService.modify(req.auth!.userId, oldPayPassword, payPassword);
    sendOk(res, null);
  }
}

/** 默认单例 */
export const payPasswordController = new PayPasswordController();

export default payPasswordController;
