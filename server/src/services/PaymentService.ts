/**
 * @file server/src/services/PaymentService.ts
 * @description 支付领域服务：发起支付（建单 + 渠道路由）与支付成功入账（事务 B）
 * @module services
 * @see docs/04-flows.md F6（556 行起）：F6.1 时序图、F6.3 回调幂等双重保险、F6.4 事务边界与回滚点、F6.5 渠道路由
 * @see docs/01-PRD.md PAY-01 ~ PAY-04（模拟支付、回调幂等、金额一致校验、回调原始数据落库）
 * @see prisma/schema.prisma（Payment 859 行起 / Order 674 行起 / OrderItem 778 行起 / OrderStatusLog 824 行起）
 * @author 软件开发团队
 * @created 2026-09-07
 *
 * 这是「登录 → 商品浏览 → 加购 → 下单 → 支付」闭环的最后一环。三条铁律：
 *
 * 1. **金额以支付单为准，绝不信回调**：回调金额与支付单 `amount` **必须严格相等**，
 *    不符即拒绝入账 + 告警（PAY-03 / F6.3「金额校验」行）。支付单金额在建单时取自
 *    `orders.pay_amount`（服务端算出的应付），天然不经过前端。
 * 2. **重复回调只入账一次**：幂等两重 —— 事务外判定 `status === SUCCESS` 直接返回（第一重），
 *    事务内 `UPDATE ... WHERE status='PENDING'` 的 `affectedRows=0` 直接返回（第二重，防并发）。
 *    两重都**不报错**：对渠道而言「重复通知」是正常现象，报错只会招来无限重发。
 * 3. **库存 confirm 必须在事务内**：`StockService.confirm` 必须拿到 `tx`，
 *    否则后续任何一步失败都无法把 `frozen → sold` 的库存退回去（F6.4「库存 frozen → sold ↩️ 回滚」）。
 *
 * 4. **记账必须在同一事务内，且金额以支付单为准**：渠道支付成功要写 `ORDER_PAY` 的 IN 流水，
 *    `FundService.credit` 必须拿到事务 B 的 `tx`（漏传 → 事务回滚时钱已入账，**钱凭空多出来**）；
 *    金额取 `payment.amount` 而非回调入参 `input.amount` —— 回调金额是外部输入，支付单才是权威。
 *
 * 死锁预防：多 SKU 的库存 confirm **严格按 `sku_id` 升序**串行，与下单 T050 的 freeze 顺序一致（F5.3 / F6.4）。
 *
 * ⚠️ 本期边界（T060）：
 * - **只实现 MOCK 渠道**：`payUrl` 为前端收银台地址 `/payment/{paymentNo}`。真实渠道由
 *   `PaymentRouter` 按 `payMethod` 分发适配器（F6.5），属下一批任务。
 * - **渠道支付已记账，余额支付已接入**：渠道支付（MOCK/ALIPAY/WECHAT）在事务 B 内写
 *   `ORDER_PAY` 的 IN 流水（平台现金账户，`is_liability=false`），已随 T061 接入；
 *   余额支付（`channel=BALANCE`）走独立的 {@link PaymentService.payByBalance} 同步入口，
 *   按 F6.6 负债结转对（USER_BALANCE OUT + PLATFORM 先 IN 后 OUT）记账（结算原语收口在
 *   `FundService.recordBalancePayment`，本服务只做业务编排）。
 * - **充值入账已接入（T070-C）**：`orderId === null` 的支付单走 {@link PaymentService.settleRecharge}
 *   （F14.1 ② 事务 I）—— 推进充值单 + 同 `tx_group_no` 写两条 IN 流水
 *   `PLATFORM_RECHARGE_IN`（`is_liability=**true**`，平台欠用户）与 `BALANCE_RECHARGE`（用户余额 +）。
 * - **不做券核销**：`LOCKED → USED` 应在同一事务内，待 CouponService 就绪后补。
 * - **不注册延迟关单 job / 不投递 BullMQ**：回调入口与 Worker 属下一批任务。
 */

import type { PrismaClient } from '@prisma/client';
import {
  OperatorType,
  OrderStatus,
  PayChannel,
  PayStatus,
  PaymentBizType,
  RechargeStatus,
} from '@prisma/client';
import { FundAccountType, FundBizType } from '@/constants/enums';
import { BusinessError, ConflictError, NotFoundError } from '@/core/errors';
import { ErrorCode } from '@/core/errors/errorCodes';
import { paymentNo as generatePaymentNo, txGroupNo as generateTxGroupNo } from '@/core/idGenerator';
import { logWarn } from '@/core/logger/logger';
import { getPrisma } from '@/core/prisma';
import { withTransaction } from '@/core/transaction';
import { FundService, type TxClient } from '@/services/FundService';
import { buildChannelPayUrl } from '@/services/payment/paymentRouter';
import { StockService } from '@/services/StockService';

/** 本服务用到的 Prisma 委托（单测注入假实现时只需实现这些） */
type DbClient = Pick<
  PrismaClient,
  'order' | 'orderItem' | 'orderStatusLog' | 'payment' | 'fundAccount'
>;

/** 入账时需要的支付单字段（结构化收窄，便于单测构造与复用） */
type PaidPayment = {
  paymentNo: string;
  /**
   * 关联订单 ID。
   *
   * @description **这是「订单支付」与「充值」的分水岭**：`bizType = ORDER` 的支付单挂订单，
   * `RECHARGE` 的挂充值单（`orderId` 为 NULL）。两者记账口径完全不同，误判会虚增收入 + 漏记负债。
   */
  orderId: bigint | null;
  /**
   * 关联充值单 ID。
   *
   * @description `bizType = RECHARGE` 时必填（schema:871），订单支付为 NULL。
   * 充值入账必须据此定位充值单——拿不到就等于「不知道这笔钱该进谁的余额」，只能拒绝入账。
   */
  rechargeId: bigint | null;
  /** 支付单归属用户（充值入账按它定位用户余额账户） */
  userId: bigint;
  orderNo: string | null;
  bizNo: string;
  amount: bigint;
  channel: PayChannel;
};

/** 发起支付入参 */
export interface CreatePaymentInput {
  /** 订单号（必须属于当前用户，见 createPayment 的越权校验） */
  orderNo: string;
  /** 支付渠道（v1.1 单一支付，无混合） */
  payMethod: PayChannel;
}

/** 发起支付结果 */
export interface CreatePaymentResult {
  /** 支付单号 */
  paymentNo: string;
  /** 收银台地址（MOCK 为前端 `/payment/{paymentNo}`；真实渠道为托管页 / 二维码） */
  payUrl: string;
  /** 应付金额（分，bigint），取自订单 pay_amount，与前端传值无关 */
  amount: bigint;
  /** 支付单过期时间（与订单 expireAt 一致） */
  expireAt: Date | null;
}

/** 渠道支付成功回调入参 */
export interface PaidNotifyInput {
  /** 渠道交易号（支付宝 trade_no / 微信 transaction_id） */
  channelTradeNo: string;
  /** 渠道回调金额（分）：必须与支付单金额严格相等 */
  amount: bigint;
}

/** 支付单可复用的状态：成功单直接返回，待支付单复用（v1.1：1 笔订单 = 1 个有效支付单） */
const REUSABLE_PAYMENT_STATUS = [PayStatus.SUCCESS, PayStatus.PENDING] as const;

/** 订单行查询字段（confirm 只需 skuId 与 quantity） */
const ORDER_ITEM_SELECT = { skuId: true, quantity: true } as const;

/** 订单行（confirm 用） */
type OrderItemRow = { skuId: bigint; quantity: number };

/**
 * 支付服务。
 *
 * @description 两个依赖均可注入，单测用假实现打桩验证幂等、金额校验与事务边界。
 */
export class PaymentService {
  /** Prisma 客户端 */
  private readonly prisma: DbClient;
  /** 库存服务（入账时 frozen → sold） */
  private readonly stockService: StockService;
  /** 资金服务（入账时写 ORDER_PAY 的 IN 流水） */
  private readonly fundService: FundService;

  /**
   * @param prisma Prisma 客户端，缺省取全局单例
   * @param stockService 库存服务，缺省新建
   * @param fundService 资金服务，缺省新建
   */
  constructor(
    prisma: DbClient = getPrisma(),
    stockService: StockService = new StockService(),
    fundService: FundService = new FundService(),
  ) {
    this.prisma = prisma;
    this.stockService = stockService;
    this.fundService = fundService;
  }

  /**
   * 发起支付（建单 + 渠道路由，**不做入账**）。
   *
   * @description 事务外只读校验 → 幂等复用 → 一次建单。全程不开事务，
   * 因为「建一张支付单」是单表单行写入，本身即原子；开事务只会无谓拉长锁持有时间。
   * @param userId 用户 ID
   * @param input 发起支付入参
   * @returns 支付单号 / 收银台地址 / 金额 / 过期时间
   * @throws {NotFoundError} 订单不存在或不属该用户（31001）
   * @throws {BusinessError} 订单状态非待支付（31002）、订单已超时（31004）
   */
  async createPayment(userId: bigint, input: CreatePaymentInput): Promise<CreatePaymentResult> {
    // ---------- 阶段 1：校验订单（事务外，只读，失败无副作用）----------
    const order = await this.loadPayableOrder(userId, input.orderNo);

    // ---------- 阶段 2：幂等复用（1 笔订单 = 1 个有效支付单）----------
    const existing = await this.findReusablePayment(order.orderNo);
    if (existing !== null) {
      return {
        paymentNo: existing.paymentNo,
        payUrl: existing.payUrl ?? this.buildPayUrl(existing.paymentNo, existing.channel),
        amount: existing.amount,
        expireAt: existing.expireAt,
      };
    }

    // ---------- 阶段 3：建支付单 ----------
    const paymentNo = generatePaymentNo();
    const payUrl = this.buildPayUrl(paymentNo, input.payMethod);

    const created = await this.prisma.payment.create({
      data: {
        paymentNo,
        orderId: order.id,
        orderNo: order.orderNo,
        userId,
        bizType: PaymentBizType.ORDER,
        bizNo: order.orderNo,
        channel: input.payMethod,
        amount: order.payAmount,
        status: PayStatus.PENDING,
        payUrl,
        expireAt: order.expireAt,
        isMock: input.payMethod === PayChannel.MOCK,
      },
    });

    return {
      paymentNo: created.paymentNo,
      payUrl,
      amount: created.amount,
      expireAt: created.expireAt,
    };
  }

  /**
   * 支付成功入账（事务 B）。
   *
   * @description 事务外只读校验（幂等第一重 + 金额校验）→ 事务内推进支付单 / 订单 / 轨迹 / 库存。
   * 幂等第二重是事务内的 `UPDATE ... WHERE status='PENDING'`，`count === 0` 直接返回**不报错**——
   * 重复回调是渠道的正常行为（F6.4「affectedRows=0 → 回滚 → 判定并发，返回成功」）。
   * @param paymentNo 支付单号
   * @param input 回调入参
   * @returns void
   * @throws {NotFoundError} 支付单不存在（40001）
   * @throws {ConflictError} 回调金额与支付单金额不一致（40002），支付单保持 PENDING
   * @throws {ConflictError} 支付单已关闭（40003）/ 已处终态（40004），迟到或伪造回调，拒绝入账并告警
   */
  async handlePaidNotify(paymentNo: string, input: PaidNotifyInput): Promise<void> {
    // ---------- 阶段 1：事务外只读校验（F6.4：读支付单 + 金额校验在事务外）----------
    const payment = await this.prisma.payment.findUnique({ where: { paymentNo } });
    if (payment === null) {
      throw new NotFoundError('支付单不存在', { code: ErrorCode.PAYMENT_NOT_FOUND });
    }

    // 金额必须严格相等：这是「伪造/篡改回调」的唯一防线，绝不做近似比较（PAY-03）
    if (payment.amount !== input.amount) {
      // TODO(T061)：回调落 integration_call_logs 后，这里补 notify_count+1 与 raw_notify 留痕（F6.3）
      logWarn('payment.amount_mismatch', {
        bizNos: { paymentNo },
        ctx: {
          orderNo: payment.orderNo,
          expected: payment.amount.toString(),
          received: input.amount.toString(),
          channelTradeNo: input.channelTradeNo,
        },
      });
      throw new ConflictError('支付金额与支付单不一致', {
        code: ErrorCode.PAYMENT_AMOUNT_MISMATCH,
      });
    }

    // 终态拦截：CLOSED / FAILED / REFUNDED 的支付单收到「支付成功」回调，只可能是
    // ① 渠道迟到的重复通知（支付单已被关单/失败/退款），或 ② 伪造回调。
    // 若不加这一层，它们会走进事务被 `WHERE status='PENDING'` 挡住 → count=0 → **静默返回成功**，
    // 异常被吞掉且无告警（F6.3 要求 CLOSED 返回 40003）。必须显式拒绝 + 告警。
    if (payment.status === PayStatus.CLOSED) {
      logWarn('payment.notify_on_closed', {
        bizNos: { paymentNo },
        ctx: { orderNo: payment.orderNo, channelTradeNo: input.channelTradeNo },
      });
      throw new ConflictError('支付单已关闭', { code: ErrorCode.PAYMENT_CLOSED });
    }
    if (payment.status === PayStatus.FAILED || payment.status === PayStatus.REFUNDED) {
      logWarn('payment.notify_on_final_state', {
        bizNos: { paymentNo },
        ctx: { orderNo: payment.orderNo, status: payment.status, channelTradeNo: input.channelTradeNo },
      });
      throw new ConflictError('支付单已处于终态，不可入账', { code: ErrorCode.PAYMENT_FINAL_STATE });
    }

    // 幂等第一重：已成功的支付单直接返回，绝不再入账一次（F6.3「第二重保险」）。
    // 注意与上面的终态拦截区分：SUCCESS 是**正常重复回调**，静默返回、不告警（否则渠道重发会刷屏）。
    if (payment.status === PayStatus.SUCCESS) {
      return;
    }

    // ---------- 阶段 2：事务 B ----------
    await withTransaction(
      async (tx) => {
        // 1) 支付单 PENDING → SUCCESS（条件更新本身就是幂等第二重）
        const paidAt = new Date();
        const updated = await tx.payment.updateMany({
          where: { paymentNo, status: PayStatus.PENDING },
          data: {
            status: PayStatus.SUCCESS,
            channelTradeNo: input.channelTradeNo,
            paidAt,
            notifyCount: { increment: 1 },
            lastNotifyAt: paidAt,
            rawNotify: {
              channelTradeNo: input.channelTradeNo,
              amount: input.amount.toString(),
              paidAt: paidAt.toISOString(),
            },
          },
        });

        // affectedRows=0：已被并发回调抢先推进 → 直接返回，不报错（F6.4）
        if (updated.count === 0) {
          return;
        }

        const orderNo = payment.orderNo ?? payment.bizNo;

        // 2) 记账：先按 `orderId` 分流 —— 充值（NULL）与订单支付（非 NULL）是两套完全不同的账，
        //    分流点必须在记账之前，混在一起记就会「虚增收入 + 漏记负债」且无任何报错。
        if (payment.orderId === null) {
          // 充值路径（F14.1 ② 事务 I）：推进充值单 + 双流水入账
          await this.settleRecharge(payment, paidAt, tx);
          return; // 充值没有订单推进 / 轨迹 / 库存 confirm，事务体到此结束
        }

        // 渠道支付 → 平台现金账户记一笔 ORDER_PAY 的 IN 流水（T061）。
        // 位置是刻意的，两个方向都不能挪：
        // · **必须在 count>0 之后** —— 能走到这里说明这是「首次成功回调」；
        //   重复/并发回调要么在事务外被 SUCCESS 静默返回，要么在这里 count=0 返回，
        //   根本到不了记账，因此记账天然幂等，不需要额外判定。
        // · **必须在订单推进与库存 confirm 之前** —— 记账失败要让**整个事务 B 回滚**。
        //   「订单已 PAID 但钱没记账」是资金黑洞（钱与账对不上且无异常信号），
        //   宁可整笔失败让渠道重发 / 走补偿，也不能让它静默通过。
        await this.recordFundInflow(payment, orderNo, tx);

        // 3) 订单 PENDING_PAYMENT → PAID（同样带 status 条件，count=0 即已被推进过）
        if (payment.orderId !== null) {
          const advanced = await tx.order.updateMany({
            where: { id: payment.orderId, status: OrderStatus.PENDING_PAYMENT },
            data: {
              status: OrderStatus.PAID,
              // 回写支付方式：orders.pay_method 下单时未定（schema 可空），不回写就会出现
              // 「订单 pay_method=null、支付单 channel=MOCK」的脏数据，对账时无法追溯这笔钱走的哪个渠道
              payMethod: payment.channel,
              paidAt,
              version: { increment: 1 },
            },
          });

          // 4) 订单轨迹（只有真正推进了状态才写，避免重复回调刷出多条同向轨迹）
          if (advanced.count > 0) {
            await tx.orderStatusLog.create({
              data: {
                orderId: payment.orderId,
                orderNo,
                fromStatus: OrderStatus.PENDING_PAYMENT,
                toStatus: OrderStatus.PAID,
                operatorType: OperatorType.SYSTEM,
                operatorId: 0n,
                reason: '支付成功',
                extra: { paymentNo, channelTradeNo: input.channelTradeNo },
              },
            });
          }
        }

        // 5) 库存 frozen → sold：**必须传 tx**，否则失败时库存回不去（F6.4）
        if (payment.orderId !== null) {
          const items = await tx.orderItem.findMany({
            where: { orderId: payment.orderId },
            select: ORDER_ITEM_SELECT,
          });
          // 按 sku_id 升序：与下单冻结顺序一致，防多订单并发下的死锁（F5.3）
          const orderedItems = this.sortBySkuId(items as OrderItemRow[]);
          for (const item of orderedItems) {
            // eslint-disable-next-line no-await-in-loop -- 顺序敏感：必须按 sku_id 升序串行，并行会破坏加锁顺序
            await this.stockService.confirm(
              {
                skuId: item.skuId,
                qty: item.quantity,
                bizNo: orderNo,
                operatorType: OperatorType.SYSTEM,
                operatorId: 0n,
                idempotencyKey: null,
              },
              tx,
            );
          }
        }

        // 6) 券核销（T041）
        // TODO(T041)：CouponService 就绪后在此 `LOCKED → USED`（同事务，失败回滚则券回 LOCKED）。
      },
      { label: 'payment.paid' },
    );
  }

  /**
   * 渠道支付入账：平台现金账户记一笔 `ORDER_PAY` 的 IN 流水。
   *
   * @description 三条硬约束（违反任一都是资损事故）：
   * 1. **必须与调用方共用同一个 `tx`**。漏传会让记账跑在独立连接上，
   *    事务 B 回滚时账已经记了 —— **钱凭空多出来**。
   * 2. **幂等键取 `paymentNo`**，撞 `fund_transactions.uk_biz_idem(biz_type, idempotency_key)`
   *    即说明这笔已记过，由 FundService 判定为幂等命中、**绝不重复加钱**（F6.3 第三重保险）。
   * 3. **金额取 `payment.amount`（支付单金额）而非回调入参 `input.amount`**。
   *    两者虽已做过严格相等校验，但**支付单才是权威**（它源自 `orders.pay_amount`），
   *    回调金额是外部输入，永远不能作为记账依据。
   *
   * 4. **`orderId === null` 的支付单（充值场景）不在此记账**。充值与订单支付是**两套完全不同的
   *    口径**：充值是「平台收钱但**欠**用户」，`is_liability = true` 且钱最终要落到用户余额账户；
   *    订单支付是「平台收钱是**收入**」，`is_liability = false` 落到平台现金账户。
   *    若此处统一记成 `ORDER_PAY`，充值的钱会在账面上变成营业收入，而实际平台欠用户一笔钱 ——
   *    **负债表与利润表同时错，且没有任何报错**。
   *    充值入账已随 T070-C 由 {@link PaymentService.settleRecharge} 按 F14.1 ② 承接；
   *    本方法只服务订单支付，充值支付单在 `handlePaidNotify` 分流时就不会进来。
   *
   * 平台现金账户**必须查出来用，不存在就抛错，绝不自动创建**：
   * 它由种子数据预置（T006），自动创建意味着有人在用一个没对过账的账户收钱。
   *
   * @param payment 支付单（提供 paymentNo / orderId / amount / channel）
   * @param orderNo 订单号
   * @param tx 事务 B 的客户端
   * @returns void
   * @throws {BusinessError} 平台现金账户不存在（60001）→ 上层事务整体回滚
   */
  /**
   * 余额支付（同步扣款，F6.6 负债结转对）。
   *
   * @description 余额支付没有渠道异步回调，钱直接来自用户余额，故在用户点击「余额支付」时
   * **同步**完成：校验 → 事务 B 内推进支付单 / 记账结转对 / 推进订单 / 确认库存。
   * 与 {@link PaymentService.handlePaidNotify}（渠道支付走异步回调）是两条入口，不能混用：
   * 余额支付若误走 `handlePaidNotify`，BALANCE 分支只会告警跳过记账、订单却照常推进 ——
   * 留下「订单已 PAID、平台账上却没记这笔负债结转」的资损脏账。
   *
   * 三条铁律（与渠道支付同源）：
   * 1. **必须与调用方共用同一个 `tx`**：`FundService.recordBalancePayment` 漏传 tx 会让记账跑独立连接，
   *    事务 B 回滚时结算流水已落库 —— **钱凭空多出来**。
   * 2. **记账必须排在订单推进与库存 confirm 之前**：记账失败要整笔回滚，
   *    绝不留下「订单已 PAID 但没记负债结转」的脏账。
   * 3. **状态推进一律条件更新**（`WHERE status='PENDING'`），`count=0` 即判定并发 / 重复，
   *    整笔回滚，**绝不带病继续**。
   *
   * 幂等：支付单已 SUCCESS → 直接返回（第一重）；事务内 `updateMany` count=0 → 返回（第二重）。
   * 余额不足由 `FundService` 抛 `BALANCE_NOT_ENOUGH`，向上传播 → 整事务回滚。
   *
   * @param paymentNo 支付单号（由 `createPayment(payMethod=BALANCE)` 创建）
   * @param userId 当前登录用户（只从 auth 取，越权兜底按「不存在」处理）
   * @returns void
   * @throws {NotFoundError} 支付单不存在（40001）/ 不属于该用户（按不存在处理）
   * @throws {BusinessError} 非余额支付单（40005）、支付单已关闭（40003）、已处终态（40004）
   * @throws {BusinessError} 余额不足（61002）→ 整事务回滚
   */
  async payByBalance(paymentNo: string, userId: bigint): Promise<void> {
    // ---------- 阶段 1：事务外只读校验（失败无副作用）----------
    const payment = await this.prisma.payment.findUnique({ where: { paymentNo } });
    if (payment === null) {
      throw new NotFoundError('支付单不存在', { code: ErrorCode.PAYMENT_NOT_FOUND });
    }
    // 越权兜底：查询带 userId，不存在即按「不存在」处理（不泄露支付单是否存在）
    if (payment.userId !== userId) {
      throw new NotFoundError('支付单不存在', { code: ErrorCode.PAYMENT_NOT_FOUND });
    }
    // 余额支付只走本入口，误走回调入口的 BALANCE 单不应在此处理
    if (payment.channel !== PayChannel.BALANCE) {
      throw new BusinessError('该支付单非余额支付，请使用对应渠道支付', {
        code: ErrorCode.PAYMENT_CHANNEL_MISMATCH,
      });
    }
    // 余额支付仅服务订单支付；充值单走充值入账（T070-C），不会以 BALANCE 渠道发起
    if (payment.orderId === null) {
      throw new BusinessError('余额支付仅支持订单支付', { code: ErrorCode.PAYMENT_CHANNEL_MISMATCH });
    }
    // 固化非空 orderId：闭包内 TS 不会保留属性收窄，下面的事务 B 内统一用此局部 const
    const orderId = payment.orderId;
    // 终态拦截（与 handlePaidNotify 同口径，避免被 WHERE status='PENDING' 静默吞掉迟到的重复请求）
    if (payment.status === PayStatus.SUCCESS) {
      return; // 幂等第一重：正常重复请求，静默返回
    }
    if (payment.status === PayStatus.CLOSED) {
      throw new ConflictError('支付单已关闭', { code: ErrorCode.PAYMENT_CLOSED });
    }
    if (payment.status === PayStatus.FAILED || payment.status === PayStatus.REFUNDED) {
      throw new ConflictError('支付单已处终态，不可支付', { code: ErrorCode.PAYMENT_FINAL_STATE });
    }

    // 复验订单仍可支付（用户可能拖到超时）：放到事务外，提前失败不持锁
    await this.loadPayableOrder(userId, payment.orderNo ?? payment.bizNo);

    // ---------- 阶段 2：事务 B ----------
    await withTransaction(
      async (tx) => {
        // 1) 支付单 PENDING → SUCCESS（条件更新即幂等第二重）
        const paidAt = new Date();
        const updated = await tx.payment.updateMany({
          where: { paymentNo, status: PayStatus.PENDING },
          data: {
            status: PayStatus.SUCCESS,
            channelTradeNo: `BALANCE-${paymentNo}`,
            paidAt,
            notifyCount: { increment: 1 },
            lastNotifyAt: paidAt,
          },
        });
        if (updated.count === 0) {
          return; // 并发 / 重复：整笔回滚
        }

        const orderNo = payment.orderNo ?? payment.bizNo;

        // 2) 记账：余额支付结转对（F6.6）—— 必须在订单推进前，失败整笔回滚
        await this.fundService.recordBalancePayment(
          {
            userId,
            amount: payment.amount,
            orderNo,
            paymentNo,
            operatorType: OperatorType.SYSTEM,
            operatorId: 0n,
          },
          tx,
        );

        // 3) 订单 PENDING_PAYMENT → PAID
        const advanced = await tx.order.updateMany({
          where: { id: orderId, status: OrderStatus.PENDING_PAYMENT },
          data: {
            status: OrderStatus.PAID,
            payMethod: payment.channel,
            paidAt,
            version: { increment: 1 },
          },
        });
        if (advanced.count > 0) {
          await tx.orderStatusLog.create({
            data: {
              orderId,
              orderNo,
              fromStatus: OrderStatus.PENDING_PAYMENT,
              toStatus: OrderStatus.PAID,
              operatorType: OperatorType.SYSTEM,
              operatorId: 0n,
              reason: '余额支付成功',
              extra: { paymentNo, channel: 'BALANCE' },
            },
          });
        }

        // 4) 库存 frozen → sold（必须传 tx，否则失败时库存回不去）
        const items = await tx.orderItem.findMany({
          where: { orderId },
          select: ORDER_ITEM_SELECT,
        });
        const orderedItems = this.sortBySkuId(items as OrderItemRow[]);
        for (const item of orderedItems) {
          // eslint-disable-next-line no-await-in-loop -- 顺序敏感：必须按 sku_id 升序串行，并行会破坏加锁顺序
          await this.stockService.confirm(
            {
              skuId: item.skuId,
              qty: item.quantity,
              bizNo: orderNo,
              operatorType: OperatorType.SYSTEM,
              operatorId: 0n,
              idempotencyKey: null,
            },
            tx,
          );
        }
      },
      { label: 'payment.balance_pay' },
    );
  }

  private async recordFundInflow(payment: PaidPayment, orderNo: string, tx: TxClient): Promise<void> {
    // 充值场景（`orderId` 为 NULL，钱挂充值单而非订单）：口径与订单支付完全不同，
    // 记成 ORDER_PAY 会虚增平台收入 + 漏记负债，且无任何报错。
    // 充值入账已由 {@link PaymentService.settleRecharge} 按 F14.1 ② 的双流水口径承接，
    // `handlePaidNotify` 对充值支付单根本不会走到这里；保留这道 guard 属纵深防御 ——
    // 万一将来有调用方绕过分流直接调本方法，也绝不会把充值记成营业收入。
    // 判定放在最前：充值路径根本不需要平台现金账户，避免无谓查询（也避免为此给它兜底建账户）。
    if (payment.orderId === null) {
      logWarn('payment.fund_skipped_recharge', {
        bizNos: { paymentNo: payment.paymentNo, bizNo: payment.bizNo },
        ctx: { amount: payment.amount.toString(), channel: payment.channel },
      });
      return;
    }

    // 余额支付已通过 `payByBalance`（F6.6 结转对）实现，走独立同步入口，不会进入本异步回调路径；
    // 此处仅作纵深防御：若某调用方绕开 payByBalance、直接对 BALANCE 支付单发起回调，
    // 命中即告警并跳过记账（余额支付的正确入口是 payByBalance，那里才扣用户余额）。
    if (payment.channel === PayChannel.BALANCE) {
      logWarn('payment.balance_channel_not_supported', {
        bizNos: { paymentNo: payment.paymentNo, orderNo },
        ctx: { channel: payment.channel },
      });
      return;
    }

    const platformAccount = await tx.fundAccount.findFirst({
      where: { accountType: FundAccountType.PLATFORM_CASH },
      select: { id: true, accountNo: true },
    });
    if (platformAccount === null) {
      throw new BusinessError('平台现金账户不存在，拒绝入账', {
        code: ErrorCode.FUND_RECORD_FAILED,
      });
    }

    await this.fundService.credit(
      {
        accountId: platformAccount.id,
        amount: payment.amount,
        bizType: FundBizType.ORDER_PAY,
        // 订单收款是平台**收入**不是储值，平台不欠用户 → false
        // （口径：充值收款 true / 订单收款 false / 余额消费冲减侧 true，见 FundService 文件头）
        isLiability: false,
        orderNo,
        paymentNo: payment.paymentNo,
        idempotencyKey: payment.paymentNo,
        operatorType: OperatorType.SYSTEM,
        operatorId: 0n,
        remark: `订单支付入账 ${orderNo}`,
      },
      tx,
    );
  }

  /**
   * 充值入账（F14.1 ② 事务 I）：推进充值单 + 双流水（平台现金 IN 负债 +，用户余额 IN）。
   *
   * @description 充值与订单支付的分水岭就一个字段：**`is_liability`**。
   * 充值时平台收了钱但**欠**用户（用户随时可消费 / 可提现），所以平台侧流水
   * `is_liability = true`；订单收款是货款不是储值，`is_liability = false`。
   * 填反了的表现是「负债总额算错但没有任何报错」——F11.5 双视图对账时才会暴露。
   *
   * 三条硬约束（违反任一都是资损事故）：
   * 1. **必须与调用方共用同一个 `tx`**（含 `rechargeOrder` 更新与两次 `credit`）。
   *    漏传会让记账跑在独立连接上，事务回滚时账已经记了 —— **钱凭空多出来**。
   * 2. **充值单推进必须是条件更新（`WHERE status='PENDING'`）且先于记账**。
   *    迟到回调（充值单已被关单/已被并发推进）必须**整笔回滚**：给已关闭的充值单
   *    入账等于白送钱，且关单 job 不会再退这笔钱。
   * 3. **金额恒取 `payment.amount`（支付单金额）**，与订单支付同款铁律 ——
   *    回调金额是外部输入，支付单才是权威（它源自充值单 `pay_amount`）。
   *
   * 幂等三重保险：① 事务外 `SUCCESS` 静默返回；② 支付单 `WHERE status='PENDING'`
   * 条件更新（`count=0` 直接返回，根本到不了这里）；③ 两条流水各自撞
   * `uk_biz_idem(biz_type, idempotency_key)`。
   *
   * 平台现金账户**必须查出来用，不存在就抛错，绝不自动创建**（与订单支付同口径）：
   * 它由种子数据预置（T006），自动创建意味着有人在用一个没对过账的账户收钱。
   * 用户余额账户则走 `getOrCreateAccount`：首充用户此前没有账户，开户是正常业务动作。
   *
   * @param payment 支付单（`bizType=RECHARGE`，提供 rechargeId / userId / bizNo / amount / paymentNo）
   * @param paidAt 支付成功时间（与支付单 `paidAt` 同一时刻，避免两处时间不一致）
   * @param tx 事务 B 的客户端
   * @returns void
   * @throws {NotFoundError} 充值支付单缺少关联充值单（61005）→ 整笔回滚
   * @throws {ConflictError} 充值单已支付 / 已关闭（61006）→ 整笔回滚，钱绝不能进已关充值单
   * @throws {BusinessError} 平台现金账户不存在（60001）→ 整笔回滚
   */
  private async settleRecharge(payment: PaidPayment, paidAt: Date, tx: TxClient): Promise<void> {
    // 0) 关联充值单：RECHARGE 支付单必填（schema:871）。拿不到就不知道钱该进谁的余额 —— 拒绝入账
    const rechargeId = payment.rechargeId;
    if (rechargeId === null) {
      throw new NotFoundError('充值支付单缺少关联充值单，拒绝入账', {
        code: ErrorCode.RECHARGE_NOT_FOUND,
      });
    }
    // RECHARGE 场景 bizNo 即充值单号（schema:869），用它做流水与备注的业务锚点
    const rechargeNo = payment.bizNo;

    // 1) 充值单 PENDING → SUCCESS（条件更新：迟到回调给已关单充值单入账 = 白送钱）
    const advanced = await tx.rechargeOrder.updateMany({
      where: { id: rechargeId, status: RechargeStatus.PENDING },
      data: {
        status: RechargeStatus.SUCCESS,
        paidAt,
        // 回写成功入账的支付单号（schema:971「用于反查与幂等」）
        paymentNo: payment.paymentNo,
      },
    });

    if (advanced.count === 0) {
      logWarn('payment.recharge_not_pending', {
        bizNos: { paymentNo: payment.paymentNo, bizNo: rechargeNo },
        ctx: { rechargeId: rechargeId.toString(), amount: payment.amount.toString() },
      });
      throw new ConflictError('充值单已支付或已关闭，拒绝重复入账', {
        code: ErrorCode.RECHARGE_ALREADY_PAID,
      });
    }

    // 2) 平台现金账户（预置种子数据，不存在即抛错，绝不自动创建）
    const platformAccount = await tx.fundAccount.findFirst({
      where: { accountType: FundAccountType.PLATFORM_CASH },
      select: { id: true, accountNo: true },
    });
    if (platformAccount === null) {
      throw new BusinessError('平台现金账户不存在，拒绝入账', {
        code: ErrorCode.FUND_RECORD_FAILED,
      });
    }

    // 3) 用户余额账户（首充自动开户；并发开户由 FundService 捕获 P2002 后重读兜底）
    const userAccount = await this.fundService.getOrCreateAccount(
      payment.userId,
      FundAccountType.USER_BALANCE,
      tx,
    );

    // 4) 双流水：两条 IN 共享同一 tx_group_no（F14.1 ②），金额恒取支付单金额
    const txGroupNo = generateTxGroupNo();
    const common = {
      amount: payment.amount,
      txGroupNo,
      rechargeNo,
      paymentNo: payment.paymentNo,
      // uk_biz_idem 是 (biz_type, idempotency_key)，两侧 bizType 不同，同键也不撞
      idempotencyKey: payment.paymentNo,
      operatorType: OperatorType.SYSTEM,
      operatorId: 0n,
    };

    // ① 平台侧 IN：现金进平台，但平台**欠**用户 → isLiability = true（与 ORDER_PAY 的唯一区别）
    await this.fundService.credit(
      {
        ...common,
        accountId: platformAccount.id,
        bizType: FundBizType.PLATFORM_RECHARGE_IN,
        isLiability: true,
        counterpartyAccountId: userAccount.id,
        counterpartyAccountNo: userAccount.accountNo,
        remark: `充值入账 ${rechargeNo}`,
      },
      tx,
    );

    // ② 用户侧 IN：余额账户到账（用户余额流水恒 false，不参与平台负债口径）
    await this.fundService.credit(
      {
        ...common,
        accountId: userAccount.id,
        bizType: FundBizType.BALANCE_RECHARGE,
        counterpartyAccountId: platformAccount.id,
        counterpartyAccountNo: platformAccount.accountNo,
        remark: `充值到账 ${rechargeNo}`,
      },
      tx,
    );
  }

  /**
   * 取订单并校验「归属 + 状态 + 未超时」。
   *
   * @description `where` 必须同时带 `orderNo` 与 `userId`——订单是私有数据，
   * 漏了 userId 就是「改一个订单号就能替别人付款」的越权漏洞。
   * @param userId 用户 ID
   * @param orderNo 订单号
   * @returns 待支付且未超时的订单
   * @throws {NotFoundError} 订单不存在或不属该用户（31001）
   * @throws {BusinessError} 订单状态非待支付（31002）、订单已超时（31004）
   */
  private async loadPayableOrder(userId: bigint, orderNo: string) {
    const order = await this.prisma.order.findFirst({ where: { orderNo, userId } });
    if (order === null) {
      throw new NotFoundError('订单不存在', { code: ErrorCode.ORDER_NOT_FOUND });
    }
    if (order.status !== OrderStatus.PENDING_PAYMENT) {
      throw new BusinessError('订单当前状态不可支付', { code: ErrorCode.ORDER_STATUS_INVALID });
    }
    if (order.expireAt.getTime() <= Date.now()) {
      // TODO(T061)：接入 BullMQ 后在此投递超时关单 job（F7），失败仅 warn 不阻塞
      throw new BusinessError('订单已超时关闭，请重新下单', { code: ErrorCode.ORDER_TIMEOUT_CLOSED });
    }
    return order;
  }

  /**
   * 查该订单可复用的支付单。
   *
   * @description v1.1 口径：**1 笔订单 = 1 个有效支付单**。允许对同一订单多次「发起支付」
   * （用户中途放弃收银台再回来），但成功者唯一 —— 已 SUCCESS 的直接返回它，
   * 仍 PENDING 的复用同一张，绝不新建第二张（否则会出现「两笔钱对应一个订单」的对账事故）。
   * @param orderNo 订单号
   * @returns 可复用的支付单；无则返回 null
   */
  private async findReusablePayment(
    orderNo: string,
  ): Promise<{ paymentNo: string; payUrl: string | null; amount: bigint; expireAt: Date | null; channel: PayChannel } | null> {
    const rows = await this.prisma.payment.findMany({
      where: {
        orderNo,
        bizType: PaymentBizType.ORDER,
        status: { in: [...REUSABLE_PAYMENT_STATUS] },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        paymentNo: true,
        payUrl: true,
        amount: true,
        expireAt: true,
        channel: true,
        status: true,
      },
    });

    // 成功单优先：即便存在一张更晚创建的 PENDING 单，也以成功者为准
    const succeeded = rows.find((row) => row.status === PayStatus.SUCCESS);
    const target = succeeded ?? rows[0] ?? null;
    if (target === null) {
      return null;
    }
    return {
      paymentNo: target.paymentNo,
      payUrl: target.payUrl,
      amount: target.amount,
      expireAt: target.expireAt,
      channel: target.channel,
    };
  }

  /**
   * 按 `skuId` 升序返回订单行（bigint 比较，不用减法避免溢出语义）。
   *
   * @param items 订单行
   * @returns 升序副本（不修改入参）
   */
  private sortBySkuId(items: OrderItemRow[]): OrderItemRow[] {
    return [...items].sort((a, b) => (a.skuId < b.skuId ? -1 : a.skuId > b.skuId ? 1 : 0));
  }

  /**
   * 生成收银台地址（经 PaymentRouter，F6.5）。
   *
   * @description 不再手写硬编码与空串：统一委托 {@link buildChannelPayUrl} 按 `channel` 路由。
   * 一期所有渠道走 `MockPaymentAdapter`——MOCK → 前端收银台 `/payment/{paymentNo}`；
   * ALIPAY/WECHAT/BANKCARD → 带渠道标识的 mock 收银台 `/mock-pay/{channel}?paymentNo=...`。
   * 真实渠道适配器注册进 `resolvePaymentAdapter` 后即自动生效，本方法零改动（T061 收口）。
   * @param paymentNo 支付单号
   * @param channel 支付渠道
   * @returns 收银台地址
   */
  private buildPayUrl(paymentNo: string, channel: PayChannel): string {
    return buildChannelPayUrl(channel, { paymentNo });
  }
}

/** 默认单例（供 Controller / Worker 直接消费） */
export const paymentService = new PaymentService();
export default paymentService;
