/**
 * @file web/src/api/balance.ts
 * @description 余额接口（查余额 / 流水 / 创建充值单）。
 */
import { api } from './client';
import type { BalanceAccount, BalanceTransaction, PageResult } from './types';

export interface RechargePayload {
  amount: number;
  payMethod: string;
}
export interface TransactionListQuery {
  page?: number;
  pageSize?: number;
}

export const balanceApi = {
  getBalance: () => api.get<BalanceAccount>('/balance'),
  listTransactions: (query: TransactionListQuery = {}) => {
    const params: Record<string, unknown> = {};
    if (query.page != null) params.page = query.page;
    if (query.pageSize != null) params.pageSize = query.pageSize;
    return api.get<PageResult<BalanceTransaction>>('/balance/transactions', params);
  },
  createRecharge: (payload: RechargePayload) =>
    api.post<{ rechargeNo: string; paymentNo: string; amount: number; payUrl: string }>('/balance/recharges', payload),
};
