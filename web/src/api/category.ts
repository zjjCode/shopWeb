/**
 * @file web/src/api/category.ts
 * @description 分类树接口（GET /api/categories/tree）。
 *
 * 注：后端 CategoryNode.id 显式序列化为 string，前端归一化为 number 以保持 ID 类型统一。
 */
import { api } from './client';
import type { CategoryNode, ID } from './types';

interface RawCategoryNode {
  id: string;
  parentId: string | null;
  name: string;
  level: number;
  path: string;
  sort: number;
  icon: string | null;
  children: RawCategoryNode[];
}

function normalizeNode(node: RawCategoryNode): CategoryNode {
  return {
    id: Number(node.id),
    parentId: node.parentId === null ? null : Number(node.parentId),
    name: node.name,
    level: node.level,
    path: node.path,
    sort: node.sort,
    icon: node.icon,
    children: node.children.map(normalizeNode),
  };
}

export const categoryApi = {
  tree: async (): Promise<CategoryNode[]> => {
    const data = await api.get<{ list: RawCategoryNode[] }>('/categories/tree');
    return (data.list ?? []).map(normalizeNode);
  },
};

export type { ID };
