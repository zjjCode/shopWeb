/**
 * @file web/src/api/cart.ts
 * @description 购物车接口（列表 / 加购 / 改数量·勾选 / 批量删除 / 未登录合并）。
 */
import { api } from './client';
import type { CartListResult, ID } from './types';

export interface AddCartItemPayload {
  skuId: ID;
  quantity: number;
}
export interface UpdateCartItemPayload {
  quantity?: number;
  selected?: boolean;
}
export interface MergeCartPayload {
  items: { skuId: ID; quantity: number }[];
}

export const cartApi = {
  list: () => api.get<CartListResult>('/cart'),
  addItem: (payload: AddCartItemPayload) => api.post<unknown>('/cart/items', payload),
  updateItem: (id: ID, payload: UpdateCartItemPayload) =>
    api.patch<unknown>(`/cart/items/${id}`, payload),
  removeItems: (ids: ID[]) => api.del<unknown>('/cart/items', { ids }),
  merge: (payload: MergeCartPayload) => api.post<unknown>('/cart/merge', payload),
};
