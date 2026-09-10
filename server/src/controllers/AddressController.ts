/**
 * @file server/src/controllers/AddressController.ts
 * @description 收货地址控制器：/api/addresses（列表 / 新增 / 修改 / 删除 / 设为默认）
 * @module controllers
 * @see docs/02-architecture.md §5.5（分层：routes → controllers → services）
 * @see src/controllers/CartController.ts（同类写法：只从 req.auth 取 userId、边界做 BigInt 转换）
 * @author 软件开发团队
 * @created 2026-09-07
 *
 * 分层铁律：控制器**只做**取参、调用 service、组装响应，**禁止直接写 Prisma 查询**
 * （本文件不 import 任何 Prisma 相关内容，作为可被 grep 校验的红线）。
 *
 * 越权防护：所有方法的 `userId` **只从 `req.auth` 取**，绝不从 query / body 读。
 *
 * ⚠️ `AuthPrincipal.userId` 是 `number`，而 `AddressService` 要求 `bigint`：
 * 换算放在控制器边界，由 {@link currentUserId} 统一负责（与 CartController 一致）。
 */

import type { Request, Response } from 'express';
import { sendOk } from '@/core/response';
import { addressService } from '@/services/AddressService';
import type { AddressIdParam, CreateAddressInput, UpdateAddressInput } from '@/validators/address.validator';

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
 * 收货地址控制器。
 */
export class AddressController {
  /**
   * 地址列表。
   *
   * @description 只返回未软删的地址，默认地址排最前（service 已排序）
   * @param req Express 请求
   * @param res Express 响应
   * @returns void
   */
  async list(req: Request, res: Response): Promise<void> {
    const addresses = await addressService.list(currentUserId(req));
    sendOk(res, addresses);
  }

  /**
   * 新增地址。
   *
   * @description 默认地址互斥 / 首个自动默认由 service 保证，控制器不做业务判断
   * @param req Express 请求（body 已由 validate 转换）
   * @param res Express 响应
   * @returns void
   */
  async create(req: Request, res: Response): Promise<void> {
    const dto = req.body as CreateAddressInput;
    const address = await addressService.create(currentUserId(req), dto);
    sendOk(res, address);
  }

  /**
   * 修改地址。
   *
   * @description params.id 与 body 均由 validate 转换（id 为 bigint）
   * @param req Express 请求
   * @param res Express 响应
   * @returns void
   */
  async update(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as AddressIdParam;
    const dto = req.body as UpdateAddressInput;
    const address = await addressService.update(currentUserId(req), id, dto);
    sendOk(res, address);
  }

  /**
   * 删除地址（软删）。
   *
   * @param req Express 请求（params.id 为 bigint）
   * @param res Express 响应
   * @returns void
   */
  async remove(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as AddressIdParam;
    const address = await addressService.remove(currentUserId(req), id);
    sendOk(res, address);
  }

  /**
   * 设为默认地址。
   *
   * @param req Express 请求（params.id 为 bigint）
   * @param res Express 响应
   * @returns void
   */
  async setDefault(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as AddressIdParam;
    const address = await addressService.setDefault(currentUserId(req), id);
    sendOk(res, address);
  }
}

/** 默认单例 */
export const addressController = new AddressController();

export default addressController;
