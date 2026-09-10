/**
 * @file server/src/controllers/BalanceController.ts
 * @description 余额控制器：/api/balance（查余额 / 流水分页 / 创建充值单）
 * @module controllers
 * @see docs/02-architecture.md §5.5（分层：routes → controllers → services）
 * @see docs/04-flows.md F14（余额充值）、F15（余额支付）
 * @see src/controllers/AddressController.ts（同类写法：只从 req.auth 取 userId、边界做 BigInt 转换）
 * @author 软件开发团队
 * @created 2026-09-09
 *
 * 分层铁律：控制器**只做**取参、调用 service、组装响应，**禁止直接写 Prisma 查询**
 * （本文件不 import 任何 Prisma 相关内容，作为可被 grep 校验的红线）。
 *
 * 越权防护：所有方法的 `userId` **只从 `req.auth` 取**，绝不从 query / body 读。
 * 余额与流水是用户私有资金数据，路由层的 `auth({ scope: 'shop' })` 是第一道闸门，
 * 这里的 `currentUserId` 是第二道——两者缺一不可。
 */

import type { Request, Response } from 'express';
import { sendOk } from '@/core/response';
import { balanceService } from '@/services/BalanceService';
import { rechargeService } from '@/services/RechargeService';
import type { CreateRechargeBody, ListTransactionsQuery } from '@/validators/balance.validator';

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
 * 余额控制器。
 */
export class BalanceController {
  /**
   * 查询余额账户。
   *
   * @description 调 `getOrCreateAccount`：**首次查询自动开户**（零余额账户），
   * 返回 { accountNo, balance, status }，前端不需要先调「开户」接口。
   * @param req Express 请求
   * @param res Express 响应
   * @returns void
   */
  async getBalance(req: Request, res: Response): Promise<void> {
    const account = await balanceService.getOrCreateAccount(currentUserId(req));
    sendOk(res, account);
  }

  /**
   * 余额流水明细（分页）。
   *
   * @description 越权红线在 service 内兜底：先按 userId 解析账户，再按 accountId 查流水
   * （fund_transactions 无 userId 列，账户归属即边界）。
   * @param req Express 请求（query 已由 validate 转换，page / pageSize 已是 number）
   * @param res Express 响应
   * @returns void
   */
  async listTransactions(req: Request, res: Response): Promise<void> {
    const query = req.query as unknown as ListTransactionsQuery;
    const result = await balanceService.listTransactions(currentUserId(req), {
      page: query.page,
      pageSize: query.pageSize,
    });
    sendOk(res, result);
  }

  /**
   * 创建充值单。
   *
   * @description F14.1 ①：创建充值单（PENDING）→ 前端拿 payUrl 拉起支付；
   * 渠道回调入账（事务 I）是 T070-C，本端点只负责「开单」。
   * @param req Express 请求（body 已由 validate 转换，amount 已是 bigint）
   * @param res Express 响应
   * @returns void
   */
  async createRecharge(req: Request, res: Response): Promise<void> {
    const dto = req.body as CreateRechargeBody;
    const result = await rechargeService.create(currentUserId(req), dto);
    sendOk(res, result);
  }
}

/** 默认单例 */
export const balanceController = new BalanceController();

export default balanceController;
