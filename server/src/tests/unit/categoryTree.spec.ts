/**
 * @file server/src/tests/unit/categoryTree.spec.ts
 * @description 分类树组装 + CacheService 降级/BigInt 序列化单测
 * @module tests/unit
 * @see server/src/services/CategoryService.ts、server/src/services/CacheService.ts
 * @see docs/02-architecture.md:61（Redis 非权威源）、docs/03-database.md（Category 模型）
 * @author 软件开发团队
 * @created 2026-09-06
 *
 * 为什么必须有单测：环境无 MySQL / Redis 实例，分类树是「商品浏览」闭环的第一环，
 * 其**孤儿节点**与**排序稳定性**两处逻辑无法靠 tsc 验证，一旦出错就是线上崩溃或前端错乱。
 * 用纯函数 `buildCategoryTree` + 假 Redis 驱动，不依赖真实实例。
 */

import { describe, expect, it, jest } from '@jest/globals';

// config 在模块加载时即校验环境变量并可能 process.exit；测试环境没有 .env，
// 因此用假 config 注入固定前缀，避免加载真实配置
jest.mock('@/config', () => ({
  config: {
    env: 'test',
    redis: { keyPrefix: 'shop' },
    // logger 在 import 时即读 config.log.level 建 winston 实例，缺了会让整个套件起不来
    log: { level: 'error', dir: '' },
  },
  isProduction: false,
  isTest: true,
  isDevelopment: false,
}));

// 单例在模块加载时会调用 getPrisma()，用假实现避免建真实客户端
jest.mock('@/core/prisma', () => ({
  getPrisma: jest.fn(() => ({})),
}));

// CacheService 的默认 provider 取的是这里的 getRedis，默认返回 null（模拟「无 Redis 实例」）
jest.mock('@/core/redis', () => ({
  getRedis: jest.fn(() => null),
}));

import type { Redis } from 'ioredis';
import { REDIS_KEY } from '@/config/constants';
import { CacheService } from '@/services/CacheService';
import { buildCategoryTree, type CategoryRow } from '@/services/CategoryService';

// ---------------------------------------------------------------------------
// 测试数据
// ---------------------------------------------------------------------------

/**
 * 构造一行分类记录。
 *
 * @param overrides 覆盖字段
 * @returns 分类行
 */
function row(overrides: Partial<CategoryRow> & Pick<CategoryRow, 'id'>): CategoryRow {
  return {
    parentId: null,
    name: `分类${overrides.id}`,
    level: 1,
    path: `/${overrides.id}/`,
    sort: 0,
    icon: null,
    ...overrides,
  };
}

/** 三级结构：手机数码 → 智能手机 → 旗舰机；家用电器 → 空调 */
function threeLevelRows(): CategoryRow[] {
  return [
    row({ id: 1n, name: '手机数码', sort: 1 }),
    row({ id: 2n, parentId: 1n, name: '智能手机', level: 2, path: '/1/2/', sort: 1 }),
    row({ id: 4n, parentId: 2n, name: '旗舰机', level: 3, path: '/1/2/4/', sort: 1 }),
    row({ id: 3n, parentId: 1n, name: '游戏手机', level: 2, path: '/1/3/', sort: 2 }),
    row({ id: 5n, name: '家用电器', sort: 2 }),
    row({ id: 6n, parentId: 5n, name: '空调', level: 2, path: '/5/6/', sort: 1 }),
  ];
}

/**
 * 递归收集树中所有节点的名称（用于断言「某个节点是否还存在于树中」）。
 *
 * @param nodes 节点数组
 * @returns 名称数组
 */
function collectNames(nodes: ReturnType<typeof buildCategoryTree>['tree']): string[] {
  return nodes.flatMap((node) => [node.name, ...collectNames(node.children)]);
}

/**
 * 取树中某节点的名称路径（用于断言层级关系）。
 *
 * @param nodes 节点数组
 * @returns 形如 `手机数码 > 智能手机 > 旗舰机` 的路径数组
 */
function flattenPaths(nodes: ReturnType<typeof buildCategoryTree>['tree']): string[] {
  return nodes.flatMap((node) =>
    node.children.length === 0
      ? [node.name]
      : node.children.flatMap((child) =>
          child.children.length === 0
            ? [`${node.name} > ${child.name}`]
            : child.children.map((leaf) => `${node.name} > ${child.name} > ${leaf.name}`),
        ),
  );
}

// ---------------------------------------------------------------------------
// 假 Redis
// ---------------------------------------------------------------------------

/**
 * 构造一个 Map 支撑的假 Redis（仅实现 CacheService 用到的 4 个命令）。
 *
 * @returns store（可直接读写底层数据）与 calls（可断言调用参数）
 */
function buildFakeRedis() {
  const store = new Map<string, string>();

  const get = jest.fn<(key: string) => Promise<string | null>>(async (key) => store.get(key) ?? null);
  const set = jest.fn<(key: string, value: string, mode: string, ttl: number) => Promise<'OK'>>(
    async (key, value) => {
      store.set(key, value);
      return 'OK';
    },
  );
  const del = jest.fn<(...keys: string[]) => Promise<number>>(async (...keys) => {
    let removed = 0;
    for (const key of keys) {
      if (store.delete(key)) {
        removed += 1;
      }
    }
    return removed;
  });
  const scan = jest.fn<(cursor: string, ...args: unknown[]) => Promise<[string, string[]]>>();

  return { store, calls: { get, set, del, scan }, redis: { get, set, del, scan } as unknown as Redis };
}

// ---------------------------------------------------------------------------
// 分类树组装
// ---------------------------------------------------------------------------

describe('buildCategoryTree', () => {
  it('平铺列表 → 三级树：层级与父子关系正确，叶子节点 children 为空数组', () => {
    const { tree, orphanIds } = buildCategoryTree(threeLevelRows());

    expect(orphanIds).toEqual([]);
    // 只有两个一级分类
    expect(tree).toHaveLength(2);
    expect(tree.map((node) => node.name)).toEqual(['手机数码', '家用电器']);
    // level / parentId 透传正确
    expect(tree[0]?.level).toBe(1);
    expect(tree[0]?.parentId).toBeNull();
    expect(tree[0]?.children.map((child) => child.name)).toEqual(['智能手机', '游戏手机']);
    // 三级节点挂在正确的二级节点下
    expect(tree[0]?.children[0]?.children.map((leaf) => leaf.name)).toEqual(['旗舰机']);
    expect(tree[0]?.children[0]?.children[0]?.level).toBe(3);
    expect(tree[0]?.children[0]?.children[0]?.path).toBe('/1/2/4/');
    // 叶子节点必须有 children: []（前端靠它判断是否可展开）
    expect(tree[0]?.children[1]?.children).toEqual([]);
    expect(tree[1]?.children[0]?.children).toEqual([]);
    // 入参顺序打乱后层级关系依然正确
    expect(flattenPaths(tree)).toEqual([
      '手机数码 > 智能手机 > 旗舰机',
      '手机数码 > 游戏手机',
      '家用电器 > 空调',
    ]);
  });

  it('孤儿节点不崩溃：parentId 指向不存在的父级时，该节点与其子树一并隐藏并记录 orphanIds', () => {
    // 2 的父级 999 不存在；3 的父级 2 存在于结果集，但因 2 未挂到根上而整体隐藏
    const rows = [
      row({ id: 1n, name: '手机数码', sort: 1 }),
      row({ id: 2n, parentId: 999n, name: '孤儿二级', level: 2, path: '/999/2/', sort: 1 }),
      row({ id: 3n, parentId: 2n, name: '孤儿三级', level: 3, path: '/999/2/3/', sort: 1 }),
    ];

    // 关键在于「不抛异常」：裸写 map[parentId].children.push 会在这里 TypeError
    let result: ReturnType<typeof buildCategoryTree>;
    expect(() => {
      result = buildCategoryTree(rows);
    }).not.toThrow();

    expect(result!.tree).toHaveLength(1);
    expect(result!.tree[0]?.name).toBe('手机数码');
    expect(result!.orphanIds).toEqual(['2']);
    // 后代因父节点未挂到根上而自然隐藏（父级禁用即子树下架的语义）
    expect(collectNames(result!.tree)).toEqual(['手机数码']);
  });

  it('孤儿节点不崩溃：父级被禁用 / 已软删（不在结果集）时，其下的二级与三级分类一并隐藏', () => {
    // 模拟 DB 层已按 status=ENABLED AND deleted_at IS NULL 过滤掉父级 5
    const rows = [
      row({ id: 1n, name: '手机数码', sort: 1 }),
      row({ id: 6n, parentId: 5n, name: '空调', level: 2, path: '/5/6/', sort: 1 }),
      row({ id: 7n, parentId: 6n, name: '挂机空调', level: 3, path: '/5/6/7/', sort: 1 }),
    ];

    const { tree, orphanIds } = buildCategoryTree(rows);

    expect(tree).toHaveLength(1);
    expect(orphanIds).toEqual(['6']);
    expect(tree[0]?.children).toEqual([]);
  });

  it('排序稳定性：sort 升序；同 sort 时按 id 升序（一级与子级均成立）', () => {
    const rows = [
      row({ id: 3n, name: 'C', sort: 5 }),
      row({ id: 1n, name: 'A', sort: 5 }),
      row({ id: 2n, name: 'B', sort: 2 }),
      row({ id: 9n, parentId: 1n, name: 'A-9', level: 2, sort: 0 }),
      row({ id: 7n, parentId: 1n, name: 'A-7', level: 2, sort: 0 }),
    ];

    const { tree } = buildCategoryTree(rows);

    // 一级：sort 2 的 B 在前，sort 5 的 A(1) / C(3) 按 id 升序
    expect(tree.map((node) => node.name)).toEqual(['B', 'A', 'C']);
    // 子级：同 sort 0 → id 7 在 id 9 之前
    expect(tree[1]?.children.map((child) => child.name)).toEqual(['A-7', 'A-9']);
  });

  it('边界：空列表返回空树；仅一级分类时每个节点 children 为空数组', () => {
    expect(buildCategoryTree([])).toEqual({ tree: [], orphanIds: [] });

    const only = buildCategoryTree([row({ id: 1n, name: '手机数码' }), row({ id: 2n, name: '家用电器' })]);
    expect(only.tree).toHaveLength(2);
    expect(only.tree.every((node) => node.children.length === 0)).toBe(true);
    expect(only.orphanIds).toEqual([]);
  });

  it('边界：不修改入参数组（排序在副本上进行）', () => {
    const rows = [row({ id: 3n, sort: 5 }), row({ id: 1n, sort: 1 })];
    const snapshot = rows.map((item) => item.id);

    buildCategoryTree(rows);

    expect(rows.map((item) => item.id)).toEqual(snapshot);
  });
});

// ---------------------------------------------------------------------------
// CacheService
// ---------------------------------------------------------------------------

describe('CacheService', () => {
  it('Key 统一由 buildKey 生成，前缀与命名空间取自配置与 REDIS_KEY 常量', () => {
    const cache = new CacheService(() => null);

    expect(cache.buildKey(REDIS_KEY.CACHE_CATEGORY_TREE)).toBe('shop:cache:category:tree');
    expect(cache.buildKey(REDIS_KEY.CACHE_PRODUCT, 123)).toBe('shop:cache:product:123');
  });

  it('BigInt 金额字段写入缓存不爆炸：落库文本可被 JSON.parse，取回后为 number', async () => {
    const { redis, store, calls } = buildFakeRedis();
    const cache = new CacheService(() => redis);
    const key = 'shop:cache:sku:price:10';

    // 9900n 是「分」。JSON.stringify 遇到 bigint 会直接抛 TypeError，必须被 safeStringify 兜住
    await expect(cache.set(key, { skuId: '10', price: 9900n, stock: 5 }, 60)).resolves.toBe(true);

    const raw = store.get(key);
    expect(typeof raw).toBe('string');
    expect(() => JSON.parse(raw as string)).not.toThrow();

    const back = await cache.get<{ skuId: string; price: number; stock: number }>(key);
    expect(back).toEqual({ skuId: '10', price: 9900, stock: 5 });
    // TTL 必须显式下发（§5.9：缓存键全部带 TTL）
    expect(calls.set).toHaveBeenCalledWith(key, expect.any(String), 'EX', 60);
  });

  it('缓存旁路：命中时不回源；未命中时回源并回填', async () => {
    const { redis, store } = buildFakeRedis();
    const cache = new CacheService(() => redis);
    let loadCount = 0;

    const load = async (): Promise<{ list: number[] }> => {
      loadCount += 1;
      return { list: [1, 2, 3] };
    };

    const first = await cache.getOrSet('shop:cache:category:tree', 600, load);
    const second = await cache.getOrSet('shop:cache:category:tree', 600, load);

    expect(first).toEqual({ list: [1, 2, 3] });
    expect(second).toEqual(first);
    // 第二次命中缓存，不再查库
    expect(loadCount).toBe(1);
    expect(store.has('shop:cache:category:tree')).toBe(true);
  });

  it('降级：Redis 不可用时 get 返回 null、set 返回 false，但 getOrSet 仍会回源', async () => {
    const cache = new CacheService(() => null);

    await expect(cache.get('shop:cache:category:tree')).resolves.toBeNull();
    await expect(cache.set('shop:cache:category:tree', { a: 1 }, 600)).resolves.toBe(false);
    await expect(cache.del('shop:cache:category:tree')).resolves.toBe(0);

    // 关键：没有 Redis 不等于查不到数据，回源必须照常执行
    await expect(cache.getOrSet('shop:cache:category:tree', 600, async () => 'from-db')).resolves.toBe('from-db');
  });

  it('降级：Redis 命令抛错（连接被拒）时静默降级，不向上抛异常', async () => {
    const { redis, calls } = buildFakeRedis();
    calls.get.mockImplementation(async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:6379');
    });
    calls.set.mockImplementation(async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:6379');
    });

    const cache = new CacheService(() => redis);

    await expect(cache.get('shop:cache:category:tree')).resolves.toBeNull();
    await expect(cache.set('shop:cache:category:tree', { a: 1 }, 600)).resolves.toBe(false);
    await expect(cache.getOrSet('shop:cache:category:tree', 600, async () => 'from-db')).resolves.toBe('from-db');
  });

  it('降级：provider 自身抛错时同样不崩（client() 兜住）', async () => {
    const cache = new CacheService(() => {
      throw new Error('boom');
    });

    await expect(cache.get('shop:cache:category:tree')).resolves.toBeNull();
    await expect(cache.set('shop:cache:category:tree', 1, 600)).resolves.toBe(false);
  });

  it('delByPattern 用 SCAN 增量迭代并按模式删除，不影响同名空间外的键', async () => {
    const { redis, store, calls } = buildFakeRedis();
    store.set('shop:cache:product:1', 'a');
    store.set('shop:cache:product:2', 'b');
    store.set('shop:cache:category:tree', 'c');
    calls.scan.mockImplementation(
      async (_cursor: string, ...args: unknown[]): Promise<[string, string[]]> => {
        // 假实现：忽略参数，直接返回一轮匹配的键（游标归零表示迭代结束）
        expect(args[0]).toBe('MATCH');
        return ['0', [...store.keys()].filter((key) => key.startsWith('shop:cache:product:'))];
      },
    );

    const cache = new CacheService(() => redis);
    const removed = await cache.delByPattern('shop:cache:product:*');

    expect(removed).toBe(2);
    expect(store.has('shop:cache:product:1')).toBe(false);
    expect(store.has('shop:cache:product:2')).toBe(false);
    expect(store.has('shop:cache:category:tree')).toBe(true);
  });

  it('缓存内容损坏（非 JSON）时 get 返回 null 而不是抛错', async () => {
    const { redis, store } = buildFakeRedis();
    store.set('shop:cache:category:tree', '{not-json');

    const cache = new CacheService(() => redis);

    await expect(cache.get('shop:cache:category:tree')).resolves.toBeNull();
  });
});
