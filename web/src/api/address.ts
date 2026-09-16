/**
 * @file web/src/api/address.ts
 * @description 收货地址接口（列表 / 新增 / 修改 / 删除 / 设为默认）。
 */
import { api } from './client';
import type { Address, ID } from './types';

export type AddressTag = 'HOME' | 'COMPANY' | 'SCHOOL' | null;

export interface AddressPayload {
  receiverName: string;
  phone: string;
  provinceCode: string;
  provinceName: string;
  cityCode: string;
  cityName: string;
  districtCode: string;
  districtName: string;
  detailAddress: string;
  tag?: AddressTag;
  isDefault?: boolean;
}

export const addressApi = {
  list: () => api.get<Address[]>('/addresses'),
  create: (payload: AddressPayload) => api.post<Address>('/addresses', payload),
  update: (id: ID, payload: Partial<AddressPayload>) =>
    api.patch<Address>(`/addresses/${id}`, payload),
  remove: (id: ID) => api.del<unknown>(`/addresses/${id}`),
  setDefault: (id: ID) => api.put<unknown>(`/addresses/${id}/default`),
};
