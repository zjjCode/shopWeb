/**
 * @file server/src/services/CategoryService.ts
 * @description 商品分类服务：三级分类树查询（一次性查库 + 内存组装）+ Redis 缓存
 * @module services
 * @see docs/02-architecture.md §5.5（分层）、§5.9（Key 命名与 TTL）、docs/03-database.md（Category 模型）
 * @see docs/04-flows.md:230（分类树 GET /api/categories/tree）
 * @author 软件开发团队
 * @created 2026-09-06
 *
 * 分层铁律：本服务**不接触** Express 的 req/res，只做查询与组装，响应由 Controller 包装。
 *
 * 性能与正确性要点：
 * 1. **一次性查库 + 内存组装树**，禁止按 parentId 递归查询（N+1）；
 * 2. **孤儿节点必须处理**：`map[parentId].children.push(node)` 这类写法在 parentId 指向
 *    「不存在 / 已软删 / 已禁用」的父级时会因 `undefined` 直接崩溃——见 {@link buildCategoryTree}；
 * 3. 缓存 TTL 10 分钟（docs/02-architecture.md:1239：分类树 10min / 商品 5min / 价格 60s），
 *    且 Redis 不可用时降级查库（{@link CacheService} 的 `getOrSet` 保证不阻断）。
 */

import type { PrismaClient } from '@prisma/client';
import { CategoryStatus } from '@prisma/client';
import { CACHE_TTL_SECONDS, REDIS_KEY } from '@/config/constants';
import { logWarn } from '@/core/logger/logger';
import { getPrisma } from '@/core/prisma';
import { cacheService, type CacheService } from './CacheService';

/** 分类树节点（对外输出形态） */
export interface CategoryNode {
  /** 分类 ID（bigint 转字符串，避免 JSON 序列化 bigint 报错） */
  id: string;
  /** 父分类 ID，一级为 null */
  parentId: string | null;
  /** 分类名 */
  name: string;
  /** 层级：1 / 2 / 3 */
  level: number;
  /** 层级路径，如 `/1/12/123/` */
  path: string;
  /** 排序号（升序） */
  sort: number;
  /** 图标 URL，可空 */
  icon: string | null;
  /** 子分类（三级树的叶子节点为空数组） */
  children: CategoryNode[];
}

/** 装配树的输入行：`categories` 表的字段子集 */
export interface CategoryRow {
  id: bigint;
  parentId: bigint | null;
  name: string;
  level: number;
  path: string;
  sort: number;
  icon: string | null;
}

/** 分类树组装结果 */
export interface CategoryTreeResult {
  /** 一级分类为根节点的树 */
  tree: CategoryNode[];
  /**
   * 直接父级缺失的分类 ID（孤儿）。
   *
   * 注意：**不含**因祖先缺失而被连带隐藏的后代——后代的父级是存在于结果集中的，
   * 只是整棵子树没有挂到根上。这符合「父级禁用/删除 → 子树整体不展示」的语义。
   */
  orphanIds: string[];
}

/** 简化的 Prisma 客户端形态（本服务只用到 category 委托） */
type DbClient = Pick<PrismaClient, 'category'>;

/**
 * 把平铺的分类列表组装成三级树（纯函数，便于单测）。
 *
 * @description 两趟扫描：
 * 1. 先按 `sort` 升序、`id` 升序稳定排序，并为每行建节点存入 `Map`（O(n)）；
 * 2. 再遍历一遍挂父子：`parentId` 为 null 的进 roots，其余按 id 找父节点（O(1) 命中）。
 * 全程无递归、无 N+1。
 *
 * **孤儿节点处理（明确选择：跳过，连同其子树一起不展示）**：
 * `parentId` 指向的分类不在结果集里（不存在 / 已软删 / 已禁用）时，
 * 直接丢弃该节点并记录到 {@link CategoryTreeResult.orphanIds}，其后代因父节点未挂到根上
 * 而自然一并隐藏。理由：
 * - **与电商惯例一致**：父级禁用或删除，语义上就是整棵子树下架；把二级分类「降级为一级」
 *   会让已下架品类的商品重新出现在首页导航，属于脏数据外泄；
 * - **`path` 与 `level` 已不可信**：父级缺失意味着 `/1/2/3/` 与 `level` 的对应关系断裂，
 *   降级为一级会输出「level=2 却挂在根下」的畸形节点，前端面包屑与层级筛选会错；
 * - **可观测**：孤儿 ID 会由 {@link CategoryService} 打 warn 日志，便于运营修数据；
 *   若选择静默降级，这类数据质量问题将永远无人发现。
 *
 * 另：即便数据存在环（a→b→a）也不会死循环——本函数不递归，环上的节点只是进不了 roots。
 *
 * @param rows 平铺的分类行（**不会**被本函数修改）
 * @returns 树与孤儿 ID 列表
 */
export function buildCategoryTree(rows: readonly CategoryRow[]): CategoryTreeResult {
  // 稳序：sort 升序，同 sort 按 id 升序，保证同一份数据每次输出完全一致（利于缓存与前端 diff）
  const ordered = [...rows].sort(compareCategory);

  const nodeById = new Map<string, CategoryNode>();
  for (const row of ordered) {
    nodeById.set(String(row.id), toNode(row));
  }

  const tree: CategoryNode[] = [];
  const orphanIds: string[] = [];

  for (const row of ordered) {
    const node = nodeById.get(String(row.id));
    if (node === undefined) {
      continue;
    }
    if (row.parentId === null) {
      tree.push(node);
      continue;
    }
    const parent = nodeById.get(String(row.parentId));
    if (parent === undefined) {
      // 父级不在结果集 → 孤儿：跳过（子树随之隐藏），绝不做 `parent.children.push` 的裸调用
      orphanIds.push(String(row.id));
      continue;
    }
    parent.children.push(node);
  }

  return { tree, orphanIds };
}

/**
 * 分类排序比较器：`sort` 升序，同 `sort` 按 `id` 升序。
 *
 * @param a 分类行
 * @param b 分类行
 * @returns 负数 / 0 / 正数
 */
function compareCategory(a: CategoryRow, b: CategoryRow): number {
  if (a.sort !== b.sort) {
    return a.sort - b.sort;
  }
  // bigint 不支持相减后直接返回（结果仍是 bigint），必须显式比较
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * 把一行记录转成对外节点（ID 转字符串，children 初始化为空数组）。
 *
 * @param row 分类行
 * @returns 树节点
 */
function toNode(row: CategoryRow): CategoryNode {
  return {
    id: String(row.id),
    parentId: row.parentId === null ? null : String(row.parentId),
    name: row.name,
    level: row.level,
    path: row.path,
    sort: row.sort,
    icon: row.icon,
    children: [],
  };
}

/**
 * 商品分类服务。
 */
export class CategoryService {
  /** 注入的 Prisma 客户端 */
  private readonly prisma: DbClient;
  /** 注入的缓存服务 */
  private readonly cache: CacheService;

  /**
   * @param prisma Prisma 客户端，缺省时取全局单例
   * @param cache 缓存服务，缺省时取全局单例
   */
  constructor(prisma: DbClient = getPrisma(), cache: CacheService = cacheService) {
    this.prisma = prisma;
    this.cache = cache;
  }

  /**
   * 查询三级分类树（走缓存）。
   *
   * @description 缓存旁路：命中直接返回；未命中查库组装后回填，TTL 10 分钟。
   * Redis 不可用时 {@link CacheService.getOrSet} 会照常回源，**不会**因为没缓存就查不到分类
   * @returns 一级分类为根的树（每个节点含 children）
   */
  async getTree(): Promise<CategoryNode[]> {
    const cacheKey = this.cache.buildKey(REDIS_KEY.CACHE_CATEGORY_TREE);
    return this.cache.getOrSet(cacheKey, CACHE_TTL_SECONDS.CATEGORY_TREE, () => this.queryTree());
  }

  /**
   * 查库并组装树（不读缓存，供回源与后台场景使用）。
   *
   * @description 只查 `status=ENABLED` 且未软删的分类；排序下推给 DB（有 `idx_status_level_sort`
   * 与 `idx_parent_sort` 索引可用），内存侧 {@link buildCategoryTree} 再兜一次稳序
   * @returns 分类树
   */
  async queryTree(): Promise<CategoryNode[]> {
    const rows = await this.prisma.category.findMany({
      where: { status: CategoryStatus.ENABLED, deletedAt: null },
      orderBy: [{ sort: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        parentId: true,
        name: true,
        level: true,
        path: true,
        sort: true,
        icon: true,
      },
    });

    const { tree, orphanIds } = buildCategoryTree(rows);
    if (orphanIds.length > 0) {
      // 孤儿是数据质量问题，不阻断请求，但要留痕供运营修正
      logWarn('category.orphan_nodes', {
        ctx: { count: orphanIds.length, ids: orphanIds.slice(0, 20) },
      });
    }
    return tree;
  }
}

/** 默认单例 */
export const categoryService = new CategoryService();

export default categoryService;
