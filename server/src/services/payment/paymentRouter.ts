/**
 * @file server/src/services/payment/paymentRouter.ts
 * @description 渠道路由（F6.5）：按 `PayChannel` 解析支付适配器，统一生成收银台地址。
 * @module services/payment
 * @see docs/04-flows.md F6.5（渠道路由：PaymentRouter 按 payMethod 分发适配器）
 * @see server/src/services/PaymentService.ts（订单支付建单复用本路由）
 * @see server/src/services/RechargeService.ts（充值建单复用本路由）
 * @author 软件开发团队
 * @created 2026-09-16
 *
 * 本期定位（T061 收口）：
 * - 这是「充值 / 订单支付的真实渠道链路」的**路由骨架**。此前 `PaymentService.buildPayUrl`
 *   对真实渠道一律返回空串（见旧 TODO）、`RechargeService.buildPayUrl` 硬编码 `/mock-pay?paymentNo=`
 *   （渠道无关），两者都不走渠道——这就是 backlog 里「充值实际支付链路（CHANNEL）一期未接」的根因。
 * - 本文件把「渠道 → 收银台地址」这件事收敛到一个可测试的纯函数上：MOCK 走前端收银台
 *   `/payment/{paymentNo}`；真实渠道（ALIPAY/WECHAT/BANKCARD）在离线环境下返回**带渠道标识的
 *   mock 收银台** `/mock-pay/{channel}?paymentNo=...`，让「创建充值单 → 拉起支付 → 回调入账」整条
 *   链路在 mock 模式下按渠道贯通（充值入账仍由 `PaymentService.handlePaidNotify` 的 `settleRecharge` 承接）。
 *
 * ⚠️ 安全红线（§6.7 与 F6.5）：**绝不明文把真实渠道静默降级成 MOCK**。这里返回的 mock 地址
 * 显式带渠道前缀（`/mock-pay/alipay` 而非 `/payment/`），前端据此明确知道「这是模拟收银台」，
 * 不会把假地址当成真渠道回调。真实渠道接入时，新增 `RealPaymentAdapter` 注册进
 * `resolvePaymentAdapter` 即可，无需改动任何调用方。
 */

import { PayChannel } from '@prisma/client';

/** 适配器建单入参（与渠道无关，由路由统一透传） */
export interface CreatePaymentParams {
  /** 支付单号（对账锚点，必填） */
  paymentNo: string;
  /** 应付金额（分，bigint）——真实适配器生成下单参数 / 二维码金额用 */
  amount?: bigint;
  /** 商品标题 / 订单标题（渠道下单必填，mock 仅透传） */
  subject?: string;
  /** 支付超时时间（mock 仅透传） */
  expireAt?: Date | null;
  /** 渠道回调地址（真实适配器注册 webhook 用） */
  notifyUrl?: string;
}

/** 支付适配器：每个渠道一个实现，唯一职责是把建单参数变成收银台地址。 */
export interface PaymentAdapter {
  /** 适配器服务的渠道 */
  readonly channel: PayChannel;
  /** 生成收银台地址（同步：mock 无需网络；真实适配器内可异步化，但路由层统一返回同步结果） */
  createPayment(input: CreatePaymentParams): { payUrl: string };
}

/**
 * Mock 支付适配器（覆盖全部渠道的离线形态）。
 *
 * @description 渠道无关的离线实现：MOCK 返回前端收银台 `/payment/{paymentNo}`；
 * 真实渠道返回带渠道标识的 mock 收银台 `/mock-pay/{channel}?paymentNo=...`。
 * 显式带渠道前缀是 §6.7 红线要求——**不**把真实渠道伪装成 MOCK 前端收银台。
 */
export class MockPaymentAdapter implements PaymentAdapter {
  readonly channel: PayChannel;

  constructor(channel: PayChannel) {
    this.channel = channel;
  }

  createPayment(input: CreatePaymentParams): { payUrl: string } {
    if (this.channel === PayChannel.MOCK) {
      return { payUrl: `/payment/${input.paymentNo}` };
    }
    // 真实渠道离线占位：带渠道前缀，明确是模拟收银台
    return { payUrl: `/mock-pay/${this.channel.toLowerCase()}?paymentNo=${input.paymentNo}` };
  }
}

/**
 * 按渠道解析适配器（F6.5 路由核心）。
 *
 * @description 一期默认全部走 {@link MockPaymentAdapter}：离线环境没有真实渠道凭据，
 * 但路由骨架已就位。真实渠道接入时在此注册 `RealPaymentAdapter`
 * （如 `if (channel === PayChannel.ALIPAY && alipayConfig.enabled) return new AlipayAdapter()`），
 * 调用方（`PaymentService` / `RechargeService`）零改动。
 * @param channel 支付渠道
 * @returns 对应渠道的适配器
 */
export function resolvePaymentAdapter(channel: PayChannel): PaymentAdapter {
  // 一期：所有渠道统一走 mock 适配器（渠道化但不对接真实网关）
  return new MockPaymentAdapter(channel);
}

/**
 * 便捷方法：直接拿渠道化的收银台地址。
 *
 * @description `PaymentService.buildPayUrl` 与 `RechargeService.buildPayUrl` 都委托到这里，
 * 保证两条建单链路用同一套渠道路由，行为一致、可单测。
 * @param channel 支付渠道
 * @param params 建单参数
 * @returns 收银台地址（MOCK 为 `/payment/{paymentNo}`；真实渠道为 `/mock-pay/{channel}?paymentNo=...`）
 */
export function buildChannelPayUrl(channel: PayChannel, params: CreatePaymentParams): string {
  return resolvePaymentAdapter(channel).createPayment(params).payUrl;
}
