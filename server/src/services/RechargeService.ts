/**
 * @file server/src/services/RechargeService.ts
 * @description 充值单服务：创建充值单 + 支付单（同事务两表写入），payUrl 占位（mock 收银台）
 * @module services
 * @see docs/04-flows.md F14.1（充值时序图：创建充值单 → 渠道支付 → 回调事务 I 入账）
 * @see docs/04-flows.md F14.2（充值记账与对账要点）
 * @see prisma/schema.prisma:958（RechargeOrder）、:859（Payment）
 * @see src/services/PaymentService.ts（订单支付建单的同类写法）
 * @author 软件开发团队
 * @created 2026-09-09
 *
 * F14.2 四条口径（本文件全部落实）：
 * 1. **充值不能用余额**：payMethod 仅 ALIPAY / WECHAT / BANKCARD（validator 层白名单已挡，
 *    本服务再做一次映射收敛——余额充余额会绕过充值限额、污染负债恒等式）。
 * 2. **不参与优惠**：充值不属于商品交易，无优惠字段，`payAmount = amount`（赠送部分
 *    `giftAmount` 一期恒 0，不由用户支付）。
 * 3. **不冻结余额**：待支付充值单不冻结 `frozen_balance`，扣款是本地事务（T070-C 的回调入账）。
 * 4. **两表写入必须同一事务**：`recharge_orders` + `payments`（bizType=RECHARGE）在一次
 *    `withTransaction` 里落库——半张充值单是脏数据，渠道回调将无从推进。
 *
 * 本期边界（T070-B / T070-C）：
 * - `payUrl` 为 mock 收银台占位地址；接入 PaymentAdapter 托管收银台仍待后续批次（见 buildPayUrl TODO）。
 * - 渠道回调 / 事务 I 双流水入账已随 **T070-C 落地，但不放在本服务**：由
 *   `PaymentService.handlePaidNotify` 按 `orderId === null` 分流到 `settleRecharge`（F14.1 ②）执行
 *   —— 充值入账与支付单推进必须在同一个事务闭包内，拆到本服务反而会把事务边界割裂。
 */

import { PayChannel, PayStatus, PaymentBizType, Prisma, RechargeStatus } from '@prisma/client';
import { ValidationError } from '@/core/errors';
import { ErrorCode } from '@/core/errors/errorCodes';
import { paymentNo as generatePaymentNo, rechargeNo as generateRechargeNo } from '@/core/idGenerator';
import { withTransaction } from '@/core/transaction';
import { buildConfiguredPayUrl } from '@/services/payment/configuredPaymentAdapter';

/** 充值支付方式（与 `balance.validator.ts` 的 RECHARGE_PAY_METHODS 白名单一致） */
export type RechargePayMethod = 'ALIPAY' | 'WECHAT' | 'BANKCARD';

/** payMethod → PayChannel 映射（F14：充值只走外部渠道，刻意没有 BALANCE 分支）。
 * 值类型含 `undefined`：白名单外的字符串（如绕过 validator 直接调 service 传 'BALANCE'）
 * 映射结果为 undefined，由 create() 的纵深防御拦截，而不是静默写出 channel=null 的充值单。 */
const PAY_METHOD_CHANNEL: Record<RechargePayMethod, PayChannel | undefined> = {
  ALIPAY: PayChannel.ALIPAY,
  WECHAT: PayChannel.WECHAT,
  BANKCARD: PayChannel.BANKCARD,
};

/** 充值单支付超时（分钟），与订单关单口径一致（F14.2「过期」行：created + 30min） */
const RECHARGE_EXPIRE_MINUTES = 30;

/** 唯一键冲突重试上限：单号带 6 位随机段，碰撞概率极低，重试一次足够 */
const MAX_UNIQUE_RETRIES = 1;

/** 创建充值单入参 */
export interface CreateRechargeInput {
  /** 充值金额（分，bigint，必须为正） */
  amount: bigint;
  /** 支付方式（仅外部渠道，不含 BALANCE——F14.2 红线） */
  payMethod: RechargePayMethod;
}

/** 创建充值单返回 */
export interface CreateRechargeResult {
  /** 充值单号（RC 前缀，幂等与对账锚点） */
  rechargeNo: string;
  /** 支付单号（payments.payment_no，渠道对账用） */
  paymentNo: string;
  /** 收银台地址（本期为 mock 占位，T070-C 接入托管收银台后替换） */
  payUrl: string;
  /** 充值金额（分，= payAmount，F14.2 不参与优惠） */
  amount: bigint;
  /** 支付超时时间（created + 30min，与充值单一致） */
  expireAt: Date;
}

/**
 * 充值单服务。
 *
 * @description 只做「创建充值单」一件事：金额红线 → 同事务两表落库 → 返回收银台地址。
 * 无状态服务：写操作全部经 `withTransaction` 的 tx 触达（测试缝隙即 withTransaction mock），
 * 不持有 Prisma 客户端字段。渠道回调推进（充值单 SUCCESS + 事务 I 双流水记账）属于
 * T070-C，**绝不**在这里提前实现。
 */
export class RechargeService {
  /**
   * 创建充值单（PENDING）+ 支付单（PENDING），两表同事务。
   *
   * @description
   * - 金额 ≤ 0 直接拒绝（61004），**不开事务、不写任何表**（validator 已挡一次，这里是
   *   service 级双保险——绕过 HTTP 直接调 service 的调用方同样被拦）；
   * - 唯一键冲突（recharge_no / payment_no 随机段碰撞）→ 重新生成单号整单重试一次；
   *   重试必须重跑整个事务（两表都用新单号重写），不能只重写一张表。
   * @param userId 用户 ID
   * @param input 充值入参（金额 / 支付方式）
   * @returns 充值单号 / 支付单号 / 收银台地址 / 金额 / 过期时间
   * @throws {ValidationError} 金额非正（61004）
   */
  async create(userId: bigint, input: CreateRechargeInput): Promise<CreateRechargeResult> {
    // 金额红线：先拦，绝不带着非法金额开事务
    if (input.amount <= 0n) {
      throw new ValidationError('充值金额必须为正数（单位：分）', {
        code: ErrorCode.RECHARGE_AMOUNT_INVALID,
      });
    }

    // 支付方式红线（纵深防御）：validator 白名单是第一道闸门，这里挡「绕过 HTTP 直接调
    // service」的内部调用方——PAY_METHOD_CHANNEL 刻意没有 BALANCE 分支（F14.2），
    // 映射不到即非法，与金额同款「不开事务、不写任何表」。
    const channel = PAY_METHOD_CHANNEL[input.payMethod];
    if (channel === undefined) {
      throw new ValidationError('充值仅支持支付宝 / 微信 / 银行卡支付（余额不可用于充值）', {
        code: ErrorCode.FIELD_FORMAT_INVALID,
      });
    }

    for (let attempt = 0; ; attempt += 1) {
      try {
        // 单号在事务闭包内生成：重试时自然拿到全新单号
        return await withTransaction((tx) => this.persist(tx, userId, input, channel), {
          label: 'recharge.create',
        });
      } catch (error) {
        if (attempt < MAX_UNIQUE_RETRIES && this.isUniqueViolation(error)) {
          continue;
        }
        throw error;
      }
    }
  }

  /**
   * 事务内落库：recharge_orders + payments 各写一行，同生共死。
   *
   * @param tx 事务客户端（由 withTransaction 提供，两表写入必须都走它）
   * @param userId 用户 ID
   * @param input 充值入参
   * @param channel 已由 create() 解析并验证过的支付渠道（非空）
   * @returns 创建结果
   */
  private async persist(
    tx: Prisma.TransactionClient,
    userId: bigint,
    input: CreateRechargeInput,
    channel: PayChannel,
  ): Promise<CreateRechargeResult> {
    const rechargeNo = generateRechargeNo();
    const paymentNo = generatePaymentNo();
    const expireAt = new Date(Date.now() + RECHARGE_EXPIRE_MINUTES * 60 * 1000);
    const payUrl = this.buildPayUrl(paymentNo, channel);

    // 两表写入必须同一事务（F14.1 ①）：任何一张失败整体回滚，不留半张充值单
    const recharge = await tx.rechargeOrder.create({
      data: {
        rechargeNo,
        userId,
        amount: input.amount,
        // F14.2：不参与优惠、不冻结余额，payAmount = amount（赠送部分一期恒 0，不由用户支付）
        payAmount: input.amount,
        status: RechargeStatus.PENDING,
        channel,
        expireAt,
      },
    });

    await tx.payment.create({
      data: {
        paymentNo,
        userId,
        bizType: PaymentBizType.RECHARGE,
        // 业务单号 = 充值单号（RECHARGE 场景 bizNo 填 recharge_no，见 schema:869）
        bizNo: rechargeNo,
        // 关联刚创建的充值单（bizType=RECHARGE 时必填，见 schema:871）
        rechargeId: recharge.id,
        channel,
        amount: input.amount,
        status: PayStatus.PENDING,
        payUrl,
        expireAt,
      },
    });

    return { rechargeNo, paymentNo, payUrl, amount: input.amount, expireAt };
  }

  /**
   * 渠道化收银台地址（经 PaymentRouter）。
   *
   * @description 不再硬编码 `/mock-pay?paymentNo=`，而是按 `channel` 走 {@link buildChannelPayUrl}
   * （F6.5 渠道路由）：MOCK → `/payment/{paymentNo}`；ALIPAY/WECHAT/BANKCARD →
   * `/mock-pay/{channel}?paymentNo=...`。这是「充值实际支付链路（CHANNEL）一期未接」收口的关键一步
   * —— 充值单从此携带真实渠道标识的收银台地址，配合 `PaymentService.handlePaidNotify` 的
   * `settleRecharge` 入账，整条链路在 mock 模式下按渠道贯通。
   * 真实渠道接入时只需在 `resolvePaymentAdapter` 注册 `RealPaymentAdapter`，本方法零改动。
   * @param paymentNo 支付单号
   * @param channel 支付渠道（ALIPAY / WECHAT / BANKCARD / MOCK）
   * @returns 渠道化收银台地址
   */
  private buildPayUrl(paymentNo: string, channel: PayChannel): string {
    return buildConfiguredPayUrl(channel, { paymentNo });
  }

  /**
   * Prisma 唯一键冲突（P2002）判定。
   *
   * @description 唯一键只有两处：`recharge_orders.recharge_no` 与 `payments.payment_no`，
   * 都由单号随机段碰撞产生，重试即解。
   * @param error 捕获到的异常
   * @returns 是否唯一键冲突
   */
  private isUniqueViolation(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
  }
}

/** 默认单例（供 Controller 消费） */
export const rechargeService = new RechargeService();
export default rechargeService;
