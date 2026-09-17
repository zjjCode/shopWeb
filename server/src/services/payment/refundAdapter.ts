/**
 * @file server/src/services/payment/refundAdapter.ts
 * @description 渠道退款适配器（缺口 #3）：按 `PayChannel` 解析退款适配器，统一封装「调渠道退款」。
 * @module services/payment
 * @see server/src/services/RefundService.ts（execute 的 CHANNEL 分支委托本适配器的 refund）
 * @see docs/04-flows.md F9.3（按 pay_method 路由退款：CHANNEL 原路退回）
 * @author 软件开发团队
 * @created 2026-09-17
 *
 * ⚠️ **本文件刻意 CONFIG-FREE**：不 import `@/config`，才能在被单测时无需 `jest.mock('@/config')`，
 * 也避免把 provider 解析耦合进适配器本身。`provider` 由调用方（`RefundService.paymentProvider`）
 * 读配置后透传进来，适配器只负责「拿到 provider + channel 选实现」。
 *
 * ⚠️ 安全红线（§6.7 与 F9.3）：**绝不明文把真实渠道静默降级成 MOCK**。
 * `MockRefundAdapter.refund()` 一期直接抛 `ExternalServiceError` 41004（渠道退款未实现），
 * 让整笔退款事务回滚、绝不记账、订单状态不变——与既有测试与领域约定完全一致。
 * 真实适配器在凭据缺失时同样**直接抛错**，而不是假装退成功。
 */

import { PayChannel } from '@prisma/client';
import { ErrorCode, ExternalServiceError } from '@/core/errors';

/** 退款适配器建单入参（与渠道无关，由路由统一透传） */
export interface RefundAdapterInput {
  /** 退款单号（对账锚点，必填） */
  refundNo: string;
  /** 关联支付单号（真实渠道退款必填，mock 透传；退款单无支付单时可为 null） */
  paymentNo: string | null;
  /** 退款金额（分，bigint） */
  amount: bigint;
  /** 退款渠道（由 order.payMethod 映射） */
  channel: PayChannel;
  /** 退款原因（渠道退款备注用） */
  reason?: string;
}

/** 退款适配器：每个渠道一个实现，唯一职责是调渠道把这笔钱退出去。 */
export interface RefundAdapter {
  /** 适配器服务的渠道 */
  readonly channel: PayChannel;
  /** 执行渠道退款，成功返回渠道侧退款单号 */
  refund(input: RefundAdapterInput): Promise<{ channelRefundNo: string }>;
}

/**
 * Mock 渠道退款适配器（一期占位，缺口 #3 收口）。
 *
 * @description 一期没有真实 `PaymentAdapter`，无法确认渠道真的把款退成功，
 * 只能抛 `ExternalServiceError` 41004 中止——这**保留既有行为**：整笔退款事务回滚、
 * 绝不记账、订单状态不变（F9.2）。真实凭据就绪后由 `RealRefundAdapter` 替换。
 */
export class MockRefundAdapter implements RefundAdapter {
  readonly channel: PayChannel;

  constructor(channel: PayChannel) {
    this.channel = channel;
  }

  async refund(_input: RefundAdapterInput): Promise<{ channelRefundNo: string }> {
    throw new ExternalServiceError(
      '渠道退款未实现：一期缺少真实 PaymentAdapter，无法确认渠道退款结果',
      'payment',
      'channel',
      { code: ErrorCode.REFUND_EXEC_FAILED },
    );
  }
}

/**
 * 真实渠道退款适配器（本期占位，缺口 #3 的真实凭据接入批次替换实现）。
 *
 * @description 真实渠道在仓库内没有凭据，本期**不能**假装退成功。`refund` 直接抛错，
 * 让退款事务回滚，不做任何静默降级——宁可退款失败待人工处理，也不制造「钱已退但没退」的歧义。
 *
 * 真实实现（下一批）：在构造函数里注入对应渠道的密钥/网关客户端，于 `refund` 内调用
 * 渠道退款 API，成功拿回 `channelRefundNo` 写入 `refunds.channel_refund_no`。
 */
export class RealRefundAdapter implements RefundAdapter {
  readonly channel: PayChannel;
  readonly provider: string;

  constructor(channel: PayChannel, provider: string) {
    this.channel = channel;
    this.provider = provider;
  }

  async refund(_input: RefundAdapterInput): Promise<{ channelRefundNo: string }> {
    throw new ExternalServiceError('真实渠道退款未配置凭据', 'payment', this.provider, {
      code: ErrorCode.ADAPTER_NOT_IMPLEMENTED,
    });
  }
}

/**
 * 按渠道与 provider 解析退款适配器（F9.3 路由核心，CONFIG-FREE）。
 *
 * @description `provider` 缺省或显式为 `mock` 时走 {@link MockRefundAdapter}（抛 41004 中止）；
 * 其余（`alipay` / `wechat` / `unionpay`）走 {@link RealRefundAdapter}（凭据缺失抛错）。
 * 二者都不做静默降级。provider 由调用方读配置后透传，适配器本身不感知配置。
 * @param channel 退款渠道
 * @param provider 支付 provider（mock / alipay / wechat / unionpay）
 * @returns 对应渠道与 provider 的退款适配器
 */
export function resolveRefundAdapter(channel: PayChannel, provider: string): RefundAdapter {
  return provider === 'mock' ? new MockRefundAdapter(channel) : new RealRefundAdapter(channel, provider);
}
