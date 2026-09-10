/**
 * @file server/src/utils/paging.ts
 * @description 分页参数归一化：页码/条数校验 + Prisma skip/take 换算 + 排序字段白名单校验
 * @module utils
 * @see docs/02-architecture.md §5.7（分页封装）
 * @author 软件开发团队
 * @created 2026-09-03
 *
 * 为什么排序字段必须走白名单：
 * `orderBy` 直接来自 query，若原样拼进 Prisma 会被注入任意字段（甚至关系字段），
 * 既能探测表结构，也能构造出拖垮数据库的大排序。因此必须由路由显式声明允许排序的列。
 */

import { PAGING } from '@/config/constants';
import { LIST_RULE } from '@/constants/bizRules';
import type { PageParams } from '@/types/common';

/** 原始分页入参（通常来自 `req.query`，值可能是字符串或字符串数组） */
export interface RawPagingQuery {
  page?: unknown;
  pageSize?: unknown;
  /** 每页条数的别名，兼容前端 `size` / `limit` 命名习惯 */
  size?: unknown;
  limit?: unknown;
}

/** 排序方向 */
export type SortOrder = 'asc' | 'desc';

/** 归一化后的排序参数 */
export interface SortParams {
  /** 通过白名单校验的排序字段 */
  field: string;
  /** 排序方向 */
  order: SortOrder;
}

/**
 * 把未知类型的入参解析成正整数。
 *
 * @description 非法值（NaN / 负数 / 超大值 / 数组）一律回退到默认值，
 * 绝不让 `?page=-1` 之类的参数拼进 SQL
 * @param value 原始入参
 * @param defaultValue 非法时的默认值
 * @param max 允许的最大值
 * @returns 合法的正整数
 */
function toPositiveInt(value: unknown, defaultValue: number, max: number): number {
  const numeric = typeof value === 'string' ? Number(value.trim()) : typeof value === 'number' ? value : Number.NaN;

  if (!Number.isInteger(numeric) || numeric < 1) {
    return defaultValue;
  }
  return Math.min(numeric, max);
}

/**
 * 归一化分页参数。
 *
 * @description `pageSize` 超过 {@link LIST_RULE.MAX_PAGE_SIZE} 时**截断而非报错**：
 * 前端偶发传大值时直接拒绝会让用户看到莫名其妙的失败，截断是更稳妥的体验；
 * 但截断要发生在服务端，避免 `?pageSize=1000000` 拖垮数据库
 * @param query 原始查询参数
 * @returns 归一化后的分页参数（含 Prisma 的 skip / take）
 */
export function normalizePaging(query: RawPagingQuery = {}): PageParams {
  const page = toPositiveInt(query.page, PAGING.DEFAULT_PAGE, 1_000_000);
  const rawSize = query.pageSize ?? query.size ?? query.limit;
  const pageSize = toPositiveInt(rawSize, PAGING.DEFAULT_PAGE_SIZE, LIST_RULE.MAX_PAGE_SIZE);

  return {
    page,
    pageSize,
    skip: (page - 1) * pageSize,
    take: pageSize,
  };
}

/**
 * 归一化排序参数（字段名走白名单）。
 *
 * @param rawField 原始排序字段名
 * @param rawOrder 原始排序方向
 * @param allowedFields 允许排序的字段白名单
 * @param defaultField 未指定或非法时使用的默认字段
 * @param defaultOrder 默认排序方向，默认 desc
 * @returns 归一化后的排序参数
 */
export function normalizeSort(
  rawField: unknown,
  rawOrder: unknown,
  allowedFields: readonly string[],
  defaultField: string,
  defaultOrder: SortOrder = 'desc',
): SortParams {
  const field = typeof rawField === 'string' && allowedFields.includes(rawField) ? rawField : defaultField;
  const order: SortOrder = typeof rawOrder === 'string' && rawOrder.toLowerCase() === 'asc' ? 'asc' : defaultOrder;
  return { field, order };
}

/**
 * 计算分页总页数。
 *
 * @param total 总条数
 * @param pageSize 每页条数
 * @returns 总页数（pageSize 为 0 时返回 0，防御除零）
 */
export function calcTotalPages(total: number, pageSize: number): number {
  if (pageSize <= 0) {
    return 0;
  }
  return Math.ceil(total / pageSize);
}
