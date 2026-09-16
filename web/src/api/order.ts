/**
 * @file web/src/api/order.ts
 * @description 订单接口（下单 / 取消 / 确认收货）。
 *
 * 注：当前 C 端未提供「订单列表 / 详情」GET 端点，订单展示由前端
 * session 级 order store 承载（见 stores/order.ts）。
 */
import { api } from './client';
import type {
  CreateOrderResult,
  ID,
  OrderDetail,
  OrderListQuery,
  OrderSummary,
  PageResult,
} from './types';

export interface CreateOrderPayload {
  addressId: ID;
  cartItemIds: ID[];
  buyerRemark?: string | null;
  couponId?: ID | null;
}
export interface CancelOrderPayload {
  reason?: string | null;
}

export const orderApi = {
  create: (payload: CreateOrderPayload) => api.post<CreateOrderResult>('/orders', payload),
  cancel: (orderNo: string, payload: CancelOrderPayload = {}) =>
    api.post<unknown>(`/orders/${orderNo}/cancel`, payload),
  confirm: (orderNo: string) => api.post<unknown>(`/orders/${orderNo}/confirm`),
  /** 订单列表（分页读）：GET /api/orders */
  list: (query: OrderListQuery = {}) => api.get<PageResult<OrderSummary>>('/orders', query),
  /** 订单详情：GET /api/orders/:orderNo */
  detail: (orderNo: string) => api.get<OrderDetail>(`/orders/${orderNo}`),
};
