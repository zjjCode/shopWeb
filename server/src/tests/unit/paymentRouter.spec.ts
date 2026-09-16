/**
 * @file server/src/tests/unit/paymentRouter.spec.ts
 * @description PaymentRouter 单元测试：渠道路由生成的收银台地址形态（F6.5 / T061 收口）
 * @module tests/unit
 * @see server/src/services/payment/paymentRouter.ts
 * @author 软件开发团队
 * @created 2026-09-16
 */

import { describe, expect, it } from '@jest/globals';
import { PayChannel } from '@prisma/client';
import { buildChannelPayUrl, resolvePaymentAdapter } from '@/services/payment/paymentRouter';

describe('PaymentRouter（F6.5 渠道路由）', () => {
  it('MOCK 渠道 → 前端收银台 /payment/{paymentNo}', () => {
    expect(buildChannelPayUrl(PayChannel.MOCK, { paymentNo: 'PAY123' })).toBe('/payment/PAY123');
  });

  it('ALIPAY 渠道 → 带渠道标识的 mock 收银台 /mock-pay/alipay?paymentNo=', () => {
    expect(buildChannelPayUrl(PayChannel.ALIPAY, { paymentNo: 'PAY123' })).toBe('/mock-pay/alipay?paymentNo=PAY123');
  });

  it('WECHAT 渠道 → /mock-pay/wechat?paymentNo=', () => {
    expect(buildChannelPayUrl(PayChannel.WECHAT, { paymentNo: 'PAY123' })).toBe('/mock-pay/wechat?paymentNo=PAY123');
  });

  it('BANKCARD 渠道 → /mock-pay/bankcard?paymentNo=', () => {
    expect(buildChannelPayUrl(PayChannel.BANKCARD, { paymentNo: 'PAY123' })).toBe('/mock-pay/bankcard?paymentNo=PAY123');
  });

  it('resolvePaymentAdapter 返回的适配器携带对应渠道', () => {
    expect(resolvePaymentAdapter(PayChannel.ALIPAY).channel).toBe(PayChannel.ALIPAY);
    expect(resolvePaymentAdapter(PayChannel.WECHAT).channel).toBe(PayChannel.WECHAT);
  });

  it('BALANCE 渠道一期也走 mock 适配器（不报错、返回带标识地址）', () => {
    expect(buildChannelPayUrl(PayChannel.BALANCE, { paymentNo: 'PAY123' })).toBe('/mock-pay/balance?paymentNo=PAY123');
  });
});
