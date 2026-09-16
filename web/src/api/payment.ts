/**
 * @file web/src/api/payment.ts
 * @description 支付接口（发起支付 / mock 确认 / 余额支付）。
 *
 * payMethod 本期仅 MOCK / BALANCE 可用；CHANNEL 三方渠道待后续接入。
 */
import { api } from './client';
import type { CreatePaymentResult } from './types';

export type PayMethod = 'MOCK' | 'BALANCE';

export const paymentApi = {
  create: (orderNo: string, payMethod: PayMethod) =>
    api.post<CreatePaymentResult>('/payments', { orderNo, payMethod }),
  /** 仅非生产环境注册：模拟渠道回调 */
  mockPaid: (paymentNo: string, amount: number) =>
    api.post<unknown>(`/payments/${paymentNo}/mock-paid`, { amount }),
  /** 余额支付（全环境可用） */
  balancePay: (paymentNo: string) => api.post<unknown>(`/payments/${paymentNo}/balance-pay`),
};
