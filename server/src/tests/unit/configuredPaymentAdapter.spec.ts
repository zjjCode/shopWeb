/**
 * @file server/src/tests/unit/configuredPaymentAdapter.spec.ts
 * @description 缺口 #2 配置化支付适配器单元测试：provider 解析与收银台地址形态
 * @module tests/unit
 * @see server/src/services/payment/configuredPaymentAdapter.ts
 * @author 软件开发团队
 * @created 2026-09-17
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PayChannel } from '@prisma/client';
import { MockPaymentAdapter } from '@/services/payment/paymentRouter';
import {
  buildConfiguredPayUrl,
  RealPaymentAdapter,
  resolveConfiguredPaymentAdapter,
} from '@/services/payment/configuredPaymentAdapter';

/** 可被测试切换的 provider（getter 延迟读取，避免 jest.mock 工厂在 import 期触发 TDZ） */
let mockPaymentProvider = 'mock';

jest.mock('@/config', () => ({
  config: {
    env: 'test',
    adapter: { payment: { get provider() { return mockPaymentProvider; } } },
    log: { level: 'error', dir: '' },
  },
  isProduction: false,
  isTest: true,
  isDevelopment: false,
}));

describe('缺口 #2 配置化支付适配器（provider=mock）', () => {
  beforeEach(() => {
    mockPaymentProvider = 'mock';
  });

  it('MOCK 渠道 → 前端收银台 /payment/{paymentNo}', () => {
    expect(buildConfiguredPayUrl(PayChannel.MOCK, { paymentNo: 'PAY1' })).toBe('/payment/PAY1');
  });

  it('ALIPAY 渠道（provider=mock）→ 带渠道标识的 mock 收银台 /mock-pay/alipay?paymentNo=', () => {
    expect(buildConfiguredPayUrl(PayChannel.ALIPAY, { paymentNo: 'PAY1' })).toBe(
      '/mock-pay/alipay?paymentNo=PAY1',
    );
  });

  it('resolveConfiguredPaymentAdapter(ALIPAY) 在 mock 下返回 MockPaymentAdapter', () => {
    expect(resolveConfiguredPaymentAdapter(PayChannel.ALIPAY)).toBeInstanceOf(MockPaymentAdapter);
  });
});

describe('缺口 #2 配置化支付适配器（provider=alipay，真实适配器骨架）', () => {
  beforeEach(() => {
    mockPaymentProvider = 'alipay';
  });

  afterEach(() => {
    mockPaymentProvider = 'mock';
  });

  it('resolveConfiguredPaymentAdapter(ALIPAY) 返回 RealPaymentAdapter', () => {
    expect(resolveConfiguredPaymentAdapter(PayChannel.ALIPAY)).toBeInstanceOf(RealPaymentAdapter);
  });

  it('RealPaymentAdapter.createPayment 在缺凭据时抛「未配置凭据」', () => {
    expect(() => buildConfiguredPayUrl(PayChannel.ALIPAY, { paymentNo: 'PAY1' })).toThrow(/未配置凭据/);
  });
});
