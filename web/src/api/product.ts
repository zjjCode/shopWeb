/**
 * @file web/src/api/product.ts
 * @description 商品浏览接口（列表 / 详情）。
 */
import { api } from './client';
import type { ID, PageResult, ProductDetail, ProductListItem } from './types';

export interface ProductListQuery {
  page?: number;
  pageSize?: number;
  categoryId?: ID | null;
  keyword?: string | null;
  sortField?: 'createdAt' | 'price' | 'sales' | 'sort' | null;
  sortOrder?: 'asc' | 'desc' | null;
}

export const productApi = {
  list: (query: ProductListQuery = {}) => {
    const params: Record<string, unknown> = {};
    if (query.page != null) params.page = query.page;
    if (query.pageSize != null) params.pageSize = query.pageSize;
    if (query.categoryId != null) params.categoryId = query.categoryId;
    if (query.keyword) params.keyword = query.keyword;
    if (query.sortField) params.sortField = query.sortField;
    if (query.sortOrder) params.sortOrder = query.sortOrder;
    return api.get<PageResult<ProductListItem>>('/products', params);
  },
  detail: (id: ID) => api.get<ProductDetail>(`/products/${id}`),
};
