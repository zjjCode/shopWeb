/**
 * @file server/src/controllers/PaymentController.ts
 * @description 支付控制器：POST /api/payments（发起支付）、POST /api/payments/:paymentNo/mock-paid（mock 确认）
 * @module controllers
 * @see docs/04-flows.md F6（556 行起）、docs/02-architecture.md §5.5（分层）
 * @author 软件开发团队
 * @created 2026-09-08
 *
 * 分层铁律：控制器**只做**取参、调用 service、组装响应，**禁止直接写 Prisma 查询**
 * （本文件不 import 任何 Prisma 相关内容，可作为一条可被 grep 校验的红线）。
 *
 * 越权防护：`userId` **只从 `req.auth` 取**，绝不从 body / query 读。
 * 若从入参读 userId，任何人改一个订单号就能替别人发起支付。
 *
 * ⚠️ `AuthPrincipal.userId` 是 `number`，而 `PaymentService` 要求 `bigint`：
 * 换算放在控制器边界，由 {@link currentUserId} 统一负责（与 `AddressController` / `OrderController` 一致）。
 *
 * 金额：`createPayment` 的金额由服务端按订单 `payAmount` 决定，前端**传不进来**（校验器 strict 拒收）。
 * `mockPaid` 的 `amount` 是模拟渠道回调携带的金额，由 service 与支付单**严格相等**校验后才会入账。
 */

import type { Request, Response } from 'express';
import { sendOk } from '@/core/response';
import { paymentService } from '@/services/PaymentService';
import type {
  CreatePaymentInput,
  MockPaidInput,
  PaymentNoParam,
} from '@/validators/payment.validator';

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

/** mock 渠道交易号前缀（真实渠道由渠道下发，如支付宝 trade_no / 微信 transaction_id） */
const MOCK_TRADE_NO_PREFIX = 'MOCK';

/**
 * 支付控制器。
 */
export class PaymentController {
  /**
   * 发起支付。
   *
   * @description 只信 `orderNo` 与 `payMethod`，金额一律由服务端按订单 `payAmount` 定。
   *
   * 响应体：`{ paymentNo, payUrl, amount, expireAt }`。其中 `amount` 是 bigint（分），
   * 依赖 `app.set('json replacer', jsonReplacer)` 才能正常序列化——未接线时 Express 会直接 500。
   *
   * ⚠️ 非 MOCK 渠道下 `payUrl` 会是**空串**（T061 接入 `PaymentRouter` 后才有真实地址）。
   * 收银台页面必须能处理空串，不要直接 `location.href = payUrl`——那会跳到当前页，
   * 表现为「点了支付没反应」。本期 `payMethod` 只允许 MOCK，该路径暂不可达。
   *
   * @param req Express 请求（body 已由 validate 校验）
   * @param res Express 响应
   * @returns void
   * @throws {NotFoundError} 订单不存在（31001）
   * @throws {BusinessError} 订单状态不可支付 / 订单已超时关闭
   */
  async create(req: Request, res: Response): Promise<void> {
    const dto = req.body as CreatePaymentInput;
    const result = await paymentService.createPayment(currentUserId(req), dto);
    sendOk(res, result);
  }

  /**
   * mock 渠道确认支付（**仅非生产环境注册**，用于本地联调与演示）。
   *
   * @description 真实场景下这一步由渠道异步回调触发（支付宝 / 微信 POST 到回调端点），
   * 这里用一个人为端点模拟「渠道通知我们钱收到了」。
   *
   * `channelTradeNo` 由服务端按 `MOCK-{paymentNo}` 生成（真实渠道由渠道下发）。
   * 入账会走 `handlePaidNotify` 的完整校验：金额严格相等 → 事务内推进支付单 / 订单 / 库存。
   *
   * @param req Express 请求（params.paymentNo 与 body.amount 均已由 validate 校验）
   * @param res Express 响应
   * @returns void
   * @throws {NotFoundError} 支付单不存在（40001）
   * @throws {ConflictError} 金额不符（40002）/ 支付单已关闭（40003）/ 支付单已终态（40004）
   */
  async mockPaid(req: Request, res: Response): Promise<void> {
    const { paymentNo } = req.params as unknown as PaymentNoParam;
    const { amount } = req.body as MockPaidInput;

    await paymentService.handlePaidNotify(paymentNo, {
      channelTradeNo: `${MOCK_TRADE_NO_PREFIX}-${paymentNo}`,
      amount,
    });

    sendOk(res, { paymentNo });
  }

  /**
   * 余额支付（同步扣款，F6.6 负债结转对）。
   *
   * @description 余额支付没有渠道异步回调，用户点击「余额支付」时同步完成扣款 + 记账 + 推进订单。
   * 仅 `auth({ scope: 'shop' })` 用户可调，`userId` 只从 `req.auth` 取（绝不从入参读）。
   * @param req Express 请求（params.paymentNo 已由 validate 校验）
   * @param res Express 响应
   * @returns void
   * @throws {NotFoundError} 支付单不存在（40001）
   * @throws {BusinessError} 非余额支付单（40005）、余额不足（61002）
   */
  async balancePay(req: Request, res: Response): Promise<void> {
    const { paymentNo } = req.params as unknown as PaymentNoParam;

    await paymentService.payByBalance(paymentNo, currentUserId(req));

    sendOk(res, { paymentNo });
  }
}

/** 默认单例 */
export const paymentController = new PaymentController();

export default paymentController;
