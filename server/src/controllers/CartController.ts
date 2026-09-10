/**
 * @file server/src/controllers/CartController.ts
 * @description 购物车控制器：/api/cart 列表 / 加购 / 改数量 / 删除 / 未登录合并
 * @module controllers
 * @see docs/04-flows.md:293（F4 购物车时序）、docs/04-flows.md:355（F4.2 关键规则）
 * @see docs/02-architecture.md §5.5（分层：routes → controllers → services）
 * @author 软件开发团队
 * @created 2026-09-07
 *
 * 分层铁律：控制器**只做**取参、调用 service、组装响应，**禁止直接写 Prisma 查询**
 * （本文件不 import 任何 Prisma 相关内容，可作为一条可被 grep 校验的红线）。
 *
 * 越权防护：所有方法的 `userId` **只从 `req.auth` 取**，绝不从 query / body 读。
 * 若从入参读 userId，任何人改一个数字就能操作别人的购物车。
 *
 * ⚠️ `AuthPrincipal.userId` 是 `number`，而 `CartService` 全部方法要求 `bigint`：
 * JWT 的 `sub` 是字符串、解析成 number，而数据库主键是 `BIGINT`。
 * 既有 `AuthService` 的约定是「service 收 `number | bigint` 内部 `BigInt()` 转换」，
 * 但 `CartService` 刻意保持严格 `bigint`（领域层不该容忍两种 ID 类型），
 * 因此换算放在控制器边界这一层，由 {@link currentUserId} 统一负责。
 */

import type { Request, Response } from 'express';
import { sendOk } from '@/core/response';
import { cartService } from '@/services/CartService';
import type {
  AddCartItemInput,
  CartItemIdParam,
  MergeCartInput,
  RemoveCartItemsInput,
  UpdateCartItemInput,
} from '@/validators/cart.validator';

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
 * 购物车控制器。
 */
export class CartController {
  /**
   * 购物车列表（含实时有效性校验）。
   *
   * @description 返回 `{ valid, invalid, totalAmount }` 三段：
   * 前端必须**只结算 valid 且 selected 的条目**，失效项禁止进入结算。
   * `totalAmount` 由 service 按**当前 SKU 价**重算，不信任加购时的快照价。
   * @param req Express 请求
   * @param res Express 响应
   * @returns void
   */
  async list(req: Request, res: Response): Promise<void> {
    const result = await cartService.listWithValidation(currentUserId(req));
    sendOk(res, result);
  }

  /**
   * 加购。
   *
   * @description 同 SKU 累加不增行（依赖 `uk_user_sku`），由 service 保证；
   * 控制器不做数量累加逻辑——那是业务规则，放控制器里就无法被单测覆盖
   * @param req Express 请求（body 已由 validate 中间件转换：`skuId` 为 bigint）
   * @param res Express 响应
   * @returns void
   */
  async addItem(req: Request, res: Response): Promise<void> {
    const { skuId, quantity } = req.body as AddCartItemInput;
    const item = await cartService.addItem(currentUserId(req), skuId, quantity);
    sendOk(res, item);
  }

  /**
   * 改数量 / 勾选。
   *
   * @param req Express 请求（params.id 与 body 均已由 validate 转换）
   * @param res Express 响应
   * @returns void
   */
  async updateItem(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as CartItemIdParam;
    const dto = req.body as UpdateCartItemInput;
    const item = await cartService.update(currentUserId(req), id, dto);
    sendOk(res, item);
  }

  /**
   * 批量删除。
   *
   * @description 用 DELETE + body 传 ids 而不是 `DELETE /cart/items/:id` 循环调用：
   * 结算后要清掉一批条目，逐个删会产生 N 次往返，且无法保证原子性。
   * @param req Express 请求（body.ids 为 bigint[]）
   * @param res Express 响应
   * @returns void
   */
  async removeItems(req: Request, res: Response): Promise<void> {
    const { ids } = req.body as RemoveCartItemsInput;
    const deleted = await cartService.remove(currentUserId(req), ids);
    sendOk(res, { deleted });
  }

  /**
   * 合并未登录购物车。
   *
   * @description 未登录时前端把购物车存 localStorage，登录后一次性合并。
   * 返回 `{ merged, skipped }`：失效 SKU 不进购物车但要在 `skipped` 里告知前端原因，
   * 否则用户会看到「我明明加了 3 件，怎么只剩 1 件」而无从得知原因。
   * @param req Express 请求
   * @param res Express 响应
   * @returns void
   */
  async merge(req: Request, res: Response): Promise<void> {
    const { items } = req.body as MergeCartInput;
    const result = await cartService.mergeGuestCart(currentUserId(req), items);
    sendOk(res, result);
  }
}

/** 默认单例 */
export const cartController = new CartController();

export default cartController;
