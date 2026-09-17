/**
 * @file server/src/tests/unit/refundAdapter.spec.ts
 * @description 缺口 #3 渠道退款适配器单元测试：路由解析与「未配置凭据」中止行为
 * @module tests/unit
 * @see server/src/services/payment/refundAdapter.ts
 * @author 软件开发团队
 * @created 2026-09-17
 *
 * ⚠️ 本套件刻意 **不** `jest.mock('@/config')`：`refundAdapter.ts` 是 CONFIG-FREE 的
 * （provider 由调用方透传），这样单测它时无需配置桩，也验证「适配器本身不耦合配置」。
 */

import { describe, expect, it } from '@jest/globals';
import { PayChannel } from '@prisma/client';
import { ErrorCode } from '@/core/errors/errorCodes';
import { MockRefundAdapter, RealRefundAdapter, resolveRefundAdapter } from '@/services/payment/refundAdapter';

/** 一个最小合法退款入参（channel 由入参决定，金额等字段仅透传） */
function refundInput(channel: PayChannel) {
  return {
    refundNo: 'SR20260910000000000001',
    paymentNo: 'PAY20260910000000000001',
    amount: 10000n,
    channel,
    reason: '用户申请退款',
  };
}

describe('缺口 #3 渠道退款适配器（CONFIG-FREE）', () => {
  it('provider=mock → MockRefundAdapter，refund 抛 ExternalServiceError 41004（渠道退款未实现）', async () => {
    const adapter = resolveRefundAdapter(PayChannel.ALIPAY, 'mock');
    expect(adapter).toBeInstanceOf(MockRefundAdapter);

    await expect(adapter.refund(refundInput(PayChannel.ALIPAY))).rejects.toMatchObject({
      code: ErrorCode.REFUND_EXEC_FAILED,
    });
  });

  it('provider=alipay → RealRefundAdapter，refund 抛「未配置凭据」', async () => {
    const adapter = resolveRefundAdapter(PayChannel.ALIPAY, 'alipay');
    expect(adapter).toBeInstanceOf(RealRefundAdapter);

    await expect(adapter.refund(refundInput(PayChannel.ALIPAY))).rejects.toThrow(/未配置凭据/);
  });

  it('provider=unionpay → RealRefundAdapter（同样未配置凭据中止，不静默降级）', async () => {
    const adapter = resolveRefundAdapter(PayChannel.WECHAT, 'unionpay');
    expect(adapter).toBeInstanceOf(RealRefundAdapter);

    await expect(adapter.refund(refundInput(PayChannel.WECHAT))).rejects.toThrow(/未配置凭据/);
  });
});
