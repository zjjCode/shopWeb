/**
 * @file server/src/services/payment/configuredPaymentAdapter.ts
 * @description 配置驱动的支付适配器解析（缺口 #2）：按 `config.adapter.payment.provider`
 *   在 MOCK / 真实渠道适配器之间分发，统一生成收银台地址。
 * @module services/payment
 * @see server/src/services/payment/paymentRouter.ts（基础路由与 MockPaymentAdapter）
 * @see server/src/config/index.ts（adapter.payment.provider）
 * @see docs/04-flows.md F6.5（渠道路由）
 * @author 软件开发团队
 * @created 2026-09-17
 *
 * 这是「充值 / 订单支付的真实渠道链路」的**配置化收口**：`provider` 来自环境变量
 * `SHOP__ADAPTER__PAYMENT__PROVIDER`（默认 `mock`）。本文件把「读配置 → 选适配器 → 出收银台地址」
 * 收敛成一个入口，调用方（`PaymentService` / `RechargeService`）只认 `buildConfiguredPayUrl`，
 * 不感知渠道与 provider，零改动即可在真实凭据就绪后切到 `RealPaymentAdapter`。
 *
 * ⚠️ 安全红线（§6.7 与 F6.5）：**绝不明文把真实渠道静默降级成 MOCK**。
 * `provider==='mock'` 时走 `MockPaymentAdapter`，其地址显式带 `/mock-pay/{channel}` 前缀，
 * 前端据此明确知道「这是模拟收银台」，不会把假地址当成真渠道回调。真实适配器在凭据缺失时
 * **直接抛错**而不是伪造一个 mock 地址——宁可建单失败，也不让资金链路产生歧义。
 */

import { PayChannel } from '@prisma/client';
import { config } from '@/config';
import { ErrorCode, ExternalServiceError } from '@/core/errors';
import {
  type CreatePaymentParams,
  MockPaymentAdapter,
  type PaymentAdapter,
} from './paymentRouter';

/** 渠道适配器未就绪时的错误码（第三方适配器段 80xxx） */
const ADAPTER_UNCONFIGURED_CODE = ErrorCode.ADAPTER_NOT_IMPLEMENTED;

/**
 * 真实支付适配器（本期占位，缺口 #2 的真实凭据接入批次替换实现）。
 *
 * @description 真实渠道（alipay / wechat / unionpay）在仓库内没有凭据，本期**不能**伪造
 * 一个真实收银台地址。`createPayment` 必须抛错，让建单在领域层失败并向上传播，
 * 而不是返回一个看起来像真的、实则无法回调的假地址（那会制造资金歧义，违反 §6.7 红线）。
 *
 * 真实实现（下一批）：在构造函数里注入对应渠道的密钥/网关客户端，于 `createPayment` 内
 * 对 `subject / amount / notifyUrl` 等参数做签名，返回网关侧的收银台 URL（或拉起 SDK 所需的 token）。
 */
export class RealPaymentAdapter implements PaymentAdapter {
  readonly channel: PayChannel;
  readonly provider: string;

  constructor(channel: PayChannel, provider: string) {
    this.channel = channel;
    this.provider = provider;
  }

  createPayment(_input: CreatePaymentParams): { payUrl: string } {
    throw new ExternalServiceError(
      '真实支付渠道未配置凭据，无法生成收银台地址',
      'payment',
      this.provider,
      { code: ADAPTER_UNCONFIGURED_CODE },
    );
    // 真实实现将在此对入参签名并返回网关收银台地址，例如：
    //   return { payUrl: this.gateway.buildCashierUrl({ channel, ...signed }) };
  }
}

/**
 * 按配置解析支付适配器（F6.5 配置化路由核心）。
 *
 * @description `provider` 缺省或显式为 `mock` 时走 {@link MockPaymentAdapter}（离线、渠道化但不对接网关）；
 * 其余（`alipay` / `wechat` / `unionpay`）走 {@link RealPaymentAdapter}。凭据缺失时真实适配器抛错，
 * 不做任何静默降级。调用方零感知。
 * @param channel 支付渠道
 * @returns 对应渠道与 provider 的适配器
 */
export function resolveConfiguredPaymentAdapter(channel: PayChannel): PaymentAdapter {
  const provider = config.adapter?.payment?.provider ?? 'mock';
  return provider === 'mock' ? new MockPaymentAdapter(channel) : new RealPaymentAdapter(channel, provider);
}

/**
 * 便捷方法：直接拿配置化的收银台地址。
 *
 * @description `PaymentService.buildPayUrl` 与 `RechargeService.buildPayUrl` 委托到这里，
 * 保证两条建单链路用同一套配置化渠道路由，行为一致、可单测。
 * @param channel 支付渠道
 * @param params 建单参数
 * @returns 收银台地址（MOCK 为 `/payment/{paymentNo}`；真实渠道在凭据就绪前抛错）
 */
export function buildConfiguredPayUrl(channel: PayChannel, params: CreatePaymentParams): string {
  return resolveConfiguredPaymentAdapter(channel).createPayment(params).payUrl;
}
