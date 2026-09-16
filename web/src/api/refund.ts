/**
 * @file web/src/api/refund.ts
 * @description 退款接口（申请 / 列表 / 详情）。
 */
import { api } from './client';
import type { ApplyRefundResult, ID, PageResult, RefundRecord, RefundItemLine } from './types';

export type RefundType = 'FULL' | 'PARTIAL';

export interface ApplyRefundPayload {
  orderNo: string;
  type: RefundType;
  amount: number;
  reasonCode?: string | null;
  reasonText?: string | null;
  voucherImages?: string[] | null;
  items?: RefundItemLine[] | null;
}
export interface RefundListQuery {
  page?: number;
  pageSize?: number;
}

export const refundApi = {
  apply: (payload: ApplyRefundPayload) => api.post<ApplyRefundResult>('/refunds', payload),
  list: (query: RefundListQuery = {}) => {
    const params: Record<string, unknown> = {};
    if (query.page != null) params.page = query.page;
    if (query.pageSize != null) params.pageSize = query.pageSize;
    return api.get<PageResult<RefundRecord>>('/refunds', params);
  },
  detail: (refundNo: string) => api.get<RefundRecord>(`/refunds/${refundNo}`),
};

export type { ID };
