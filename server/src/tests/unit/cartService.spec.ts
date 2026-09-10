/**
 * @file server/src/tests/unit/cartService.spec.ts
 * @description 购物车领域服务单测（假 Prisma 打桩，不连真实 DB）
 * @module tests/unit
 * @see server/src/services/CartService.ts、docs/04-flows.md:293（F4 购物车）
 * @author 软件开发团队
 * @created 2026-09-07
 *
 * 为什么必须有单测：环境无 MySQL / Redis 实例，购物车「累加不增行 / 失效判定 / 越权防护 /
 * 金额以后端重算为准」这些规则无法靠 tsc 验证，一旦写错就是线上超卖或越权。
 * 用注入构造参数的假 Prisma 驱动，不依赖真实实例。
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ProductStatus, SkuStatus } from '@prisma/client';
import { ConflictError } from '@/core/errors';
import { ErrorCode } from '@/core/errors/errorCodes';
import { type CartItemRow } from '@/repositories/CartRepository';
import { CartService, type CartInvalidReason } from '@/services/CartService';

// config 在模块加载时即校验环境变量并可能 process.exit；测试环境没有 .env，用假 config 注入固定值
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

/** CartService 构造函数第一个参数（DbClient）的类型 */
type CtorPrisma = ConstructorParameters<typeof CartService>[0];

/**
 * `sku.findUnique` 返回的校验投影。
 *
 * 与 `CartService` 内部的 `select` 一一对应（故意**不含** `costPrice`）。
 */
interface SkuShape {
  id: bigint;
  price: bigint;
  status: SkuStatus;
  deletedAt: Date | null;
  product: { status: ProductStatus; deletedAt: Date | null };
  stock: { available: number } | null;
}

/** 列表查询返回的购物车条目形态（与 `listRow` 一致） */
interface CartListRow {
  id: bigint;
  userId: bigint;
  skuId: bigint;
  quantity: number;
  selected: boolean;
  priceSnapshot: bigint;
  createdAt: Date;
  updatedAt: Date;
  sku: SkuShape;
}

/**
 * `cartItem.findUnique` 的返回形态。
 *
 * 加购路径（`addItem`）与改数量路径（`update`）各自 select 的字段不同，
 * 这里取两者的并集 —— 假实现只需满足被调用到的那一条分支即可。
 */
type CartFindUniqueResult =
  | null
  | { id: bigint; quantity: number; priceSnapshot: bigint }
  | {
      id: bigint;
      skuId: bigint;
      quantity: number;
      selected: boolean;
      priceSnapshot: bigint;
      sku: { stock: { available: number } | null };
    };

/** `cartItem.upsert` 入参形态 */
interface UpsertArgs {
  where: { userId_skuId: { userId: bigint; skuId: bigint } };
  create: { userId: bigint; skuId: bigint; quantity: number; priceSnapshot: bigint };
  update: { quantity: number | { increment?: number } };
}

/** 各查询方法的 where 条件（断言越权防护时按具体形状再收窄） */
type WhereArgs = { where?: Record<string, unknown> };

// ---------------------------------------------------------------------------
// 假 Prisma
// ---------------------------------------------------------------------------

/**
 * ⚠️ 为什么每个 `jest.fn` 都必须显式写泛型：
 * 本项目用 jest 29（`@jest/globals`），不带泛型的 `jest.fn()` 会被推断成
 * `Mock<UnknownFunction>`，参数与返回值都退化成 `unknown` / `never` ——
 * 于是 `mockResolvedValue(...)` 与 `mock.calls[0][0].xxx` 全部报 TS2345。
 * 这与 `@types/jest`（双参数写法 `jest.fn<T, Y>()`）不同，别混用。
 */
const fakePrisma = {
  cartItem: {
    findUnique: jest.fn<(args: WhereArgs) => Promise<CartFindUniqueResult>>(),
    findMany: jest.fn<(args: WhereArgs) => Promise<CartListRow[]>>(),
    count: jest.fn<(args: WhereArgs) => Promise<number>>(),
    upsert: jest.fn<(args: UpsertArgs) => Promise<CartItemRow>>(),
    update: jest.fn<(args: WhereArgs & { data?: unknown }) => Promise<CartItemRow>>(),
    deleteMany: jest.fn<(args: WhereArgs) => Promise<{ count: number }>>(),
  },
  sku: {
    findUnique: jest.fn<(args: { where?: { id?: bigint } }) => Promise<SkuShape | null>>(),
  },
};

/** upsert 内存态：key = `${userId}:${skuId}` → 行，用于证明「同 SKU 不增行」 */
const upsertStore = new Map<string, CartItemRow>();

// ---------------------------------------------------------------------------
// 测试数据构造
// ---------------------------------------------------------------------------

function makeRow(over: Partial<CartItemRow> = {}): CartItemRow {
  return {
    id: 1n,
    userId: 1n,
    skuId: 1n,
    quantity: 1,
    selected: true,
    priceSnapshot: 1000n,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

/** findSkuForAdd 返回的 SKU 校验投影（默认可售） */
function buildSku(over: Partial<SkuShape> = {}): SkuShape {
  return {
    id: 1n,
    price: 1000n,
    status: SkuStatus.ENABLED,
    deletedAt: null,
    product: { status: ProductStatus.ON_SALE, deletedAt: null },
    stock: { available: 100 },
    ...over,
  };
}

/** 列表查询返回的购物车条目（默认有效：SKU 在售、商品在售、库存充足） */
function listRow(over: Partial<{
  id: bigint;
  userId: bigint;
  skuId: bigint;
  quantity: number;
  selected: boolean;
  priceSnapshot: bigint;
  sku: {
    id: bigint;
    price: bigint;
    status: SkuStatus;
    deletedAt: Date | null;
    product: { status: ProductStatus; deletedAt: Date | null };
    stock: { available: number } | null;
  };
}> = {}): {
  id: bigint;
  userId: bigint;
  skuId: bigint;
  quantity: number;
  selected: boolean;
  priceSnapshot: bigint;
  createdAt: Date;
  updatedAt: Date;
  sku: {
    id: bigint;
    price: bigint;
    status: SkuStatus;
    deletedAt: Date | null;
    product: { status: ProductStatus; deletedAt: Date | null };
    stock: { available: number } | null;
  };
} {
  return {
    id: 1n,
    userId: 1n,
    skuId: 1n,
    quantity: 2,
    selected: true,
    priceSnapshot: 1000n,
    createdAt: new Date(),
    updatedAt: new Date(),
    sku: {
      id: 1n,
      price: 1000n,
      status: SkuStatus.ENABLED,
      deletedAt: null,
      product: { status: ProductStatus.ON_SALE, deletedAt: null },
      stock: { available: 100 },
    },
    ...over,
  };
}

/** 构造四种失效 SKU 形态之一 */
function invalidSkuShape(reason: CartInvalidReason): {
  id: bigint;
  price: bigint;
  status: SkuStatus;
  deletedAt: Date | null;
  product: { status: ProductStatus; deletedAt: Date | null };
  stock: { available: number } | null;
} {
  const base = buildSku();
  switch (reason) {
    case 'DELETED':
      return { ...base, deletedAt: new Date('2026-01-01') };
    case 'SKU_DISABLED':
      return { ...base, status: SkuStatus.DISABLED };
    case 'PRODUCT_OFF_SALE':
      return { ...base, product: { status: ProductStatus.OFF_SALE, deletedAt: null } };
    case 'STOCK_NOT_ENOUGH':
      return { ...base, stock: { available: 1 } };
    default:
      return base;
  }
}

/** 递归查找对象中是否含指定 key（用于「绝不返回 costPrice」锁死） */
function hasKey(obj: unknown, key: string): boolean {
  if (obj === null || typeof obj !== 'object') {
    return false;
  }
  if (Array.isArray(obj)) {
    return obj.some((item) => hasKey(item, key));
  }
  const record = obj as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, key)) {
    return true;
  }
  return Object.values(record).some((value) => hasKey(value, key));
}

/** 用假 prisma 构造一个 CartService */
function makeSvc(): CartService {
  return new CartService(fakePrisma as unknown as CtorPrisma);
}

// ---------------------------------------------------------------------------
// 默认打桩（每个用例前重置，避免互相污染）
// ---------------------------------------------------------------------------

beforeEach(() => {
  upsertStore.clear();

  // SKU 默认可售、库存充足
  fakePrisma.sku.findUnique.mockImplementation(async (args: { where?: { id?: bigint } }) =>
    buildSku({ id: args?.where?.id ?? 1n }),
  );
  // 购物车条目默认不存在（findByUserSku / findById 都走 findUnique）
  fakePrisma.cartItem.findUnique.mockResolvedValue(null);
  fakePrisma.cartItem.findMany.mockResolvedValue([]);
  fakePrisma.cartItem.count.mockResolvedValue(0);
  fakePrisma.cartItem.deleteMany.mockResolvedValue({ count: 0 });
  fakePrisma.cartItem.update.mockResolvedValue(makeRow());

  // upsert 内存态：证明「同 SKU 累加不增行」
  fakePrisma.cartItem.upsert.mockImplementation(async (args: {
    where: { userId_skuId: { userId: bigint; skuId: bigint } };
    create: { userId: bigint; skuId: bigint; quantity: number; priceSnapshot: bigint };
    update: { quantity: number | { increment?: number } };
  }) => {
    const { userId, skuId } = args.where.userId_skuId;
    const key = `${userId}:${skuId}`;
    const existing = upsertStore.get(key);
    if (existing === undefined) {
      const row = makeRow({
        userId,
        skuId,
        quantity: args.create.quantity,
        priceSnapshot: args.create.priceSnapshot,
      });
      upsertStore.set(key, row);
      return row;
    }
    const q = args.update.quantity as number | { increment?: number };
    const newQty =
      typeof q === 'object' && q !== null && 'increment' in q
        ? existing.quantity + ((q.increment as number) ?? 0)
        : (q as number);
    const row = { ...existing, quantity: newQty };
    upsertStore.set(key, row);
    return row;
  });
});

// ---------------------------------------------------------------------------
// 加购 addItem
// ---------------------------------------------------------------------------

describe('CartService.addItem', () => {
  it('同 SKU 累加不增行：连续两次加购同一 SKU → 只有一条记录，quantity 累加', async () => {
    const svc = makeSvc();

    // 第一次：新 SKU（findByUserSku 返回 null）
    fakePrisma.cartItem.findUnique.mockResolvedValue(null);
    const r1 = await svc.addItem(1n, 1n, 3);
    expect(r1.quantity).toBe(3);

    // 第二次：同 SKU 已存在（findByUserSku 返回现有条目，走累加分支）
    fakePrisma.cartItem.findUnique.mockResolvedValue({ id: 1n, quantity: 3, priceSnapshot: 1000n });
    const r2 = await svc.addItem(1n, 1n, 2);
    expect(r2.quantity).toBe(5);

    // 关键：upsert 被调用两次，但内存态只有一行（不增行）
    expect(fakePrisma.cartItem.upsert).toHaveBeenCalledTimes(2);
    expect(upsertStore.size).toBe(1);
    expect(upsertStore.get('1:1')?.quantity).toBe(5);
  });

  it('首次加购写入 priceSnapshot = sku.price', async () => {
    const svc = makeSvc();
    fakePrisma.sku.findUnique.mockResolvedValue(buildSku({ price: 1234n }));
    fakePrisma.cartItem.findUnique.mockResolvedValue(null);

    const row = await svc.addItem(1n, 1n, 2);
    expect(row.priceSnapshot).toBe(1234n);
    // 仓库 create 也写入了相同快照
    expect(fakePrisma.cartItem.upsert.mock.calls[0]?.[0]?.create?.priceSnapshot).toBe(1234n);
  });

  it('库存不足 → 抛库存不足错误（50001），且没有写入购物车', async () => {
    const svc = makeSvc();
    fakePrisma.sku.findUnique.mockResolvedValue(buildSku({ stock: { available: 2 } }));

    await expect(svc.addItem(1n, 1n, 5)).rejects.toMatchObject({ code: ErrorCode.STOCK_NOT_ENOUGH });
    expect(fakePrisma.cartItem.upsert).not.toHaveBeenCalled();
  });

  it('SKU 停用 → 抛 SKU_NOT_FOUND（21002），且没有写入', async () => {
    const svc = makeSvc();
    fakePrisma.sku.findUnique.mockResolvedValue(buildSku({ status: SkuStatus.DISABLED }));

    await expect(svc.addItem(1n, 1n, 1)).rejects.toMatchObject({ code: ErrorCode.SKU_NOT_FOUND });
    expect(fakePrisma.cartItem.upsert).not.toHaveBeenCalled();
  });

  it('商品下架 → 抛 PRODUCT_NOT_FOUND（21001），且没有写入', async () => {
    const svc = makeSvc();
    fakePrisma.sku.findUnique.mockResolvedValue(
      buildSku({ product: { status: ProductStatus.OFF_SALE, deletedAt: null } }),
    );

    await expect(svc.addItem(1n, 1n, 1)).rejects.toMatchObject({ code: ErrorCode.PRODUCT_NOT_FOUND });
    expect(fakePrisma.cartItem.upsert).not.toHaveBeenCalled();
  });

  it('单 SKU 超 999 → 抛 CART_ITEM_QUANTITY_LIMIT（30003），没有写入', async () => {
    const svc = makeSvc();
    // 已有 990，再加 20 → 1010 > 999
    fakePrisma.cartItem.findUnique.mockResolvedValue({ id: 1n, quantity: 990, priceSnapshot: 1000n });
    fakePrisma.sku.findUnique.mockResolvedValue(buildSku({ stock: { available: 9999 } }));

    await expect(svc.addItem(1n, 1n, 20)).rejects.toMatchObject({ code: ErrorCode.CART_ITEM_QUANTITY_LIMIT });
    expect(fakePrisma.cartItem.upsert).not.toHaveBeenCalled();
  });

  it('总条目超 100 → 抛 CART_ITEM_COUNT_LIMIT（30004），没有写入', async () => {
    const svc = makeSvc();
    fakePrisma.cartItem.findUnique.mockResolvedValue(null); // 新 SKU
    fakePrisma.cartItem.count.mockResolvedValue(100);

    await expect(svc.addItem(1n, 1n, 1)).rejects.toMatchObject({ code: ErrorCode.CART_ITEM_COUNT_LIMIT });
    expect(fakePrisma.cartItem.upsert).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 列表实时校验 listWithValidation
// ---------------------------------------------------------------------------

describe('CartService.listWithValidation', () => {
  it('四种失效（商品下架 / SKU 停用 / 库存不足 / 已软删）各一条 → 全进 invalid', async () => {
    const svc = makeSvc();
    const rows = [
      listRow({ id: 1n, sku: invalidSkuShape('PRODUCT_OFF_SALE') }),
      listRow({ id: 2n, sku: invalidSkuShape('SKU_DISABLED') }),
      listRow({ id: 3n, quantity: 2, sku: invalidSkuShape('STOCK_NOT_ENOUGH') }),
      listRow({ id: 4n, sku: invalidSkuShape('DELETED') }),
    ];
    fakePrisma.cartItem.findMany.mockResolvedValue(rows);

    const { valid, invalid } = await svc.listWithValidation(1n);
    expect(invalid).toHaveLength(4);
    expect(valid).toHaveLength(0);
    expect(invalid.map((v) => v.invalidReason).sort()).toEqual(
      ['DELETED', 'PRODUCT_OFF_SALE', 'SKU_DISABLED', 'STOCK_NOT_ENOUGH'].sort(),
    );
  });

  it('未失效且库存充足 → 进 valid', async () => {
    const svc = makeSvc();
    fakePrisma.cartItem.findMany.mockResolvedValue([listRow({ id: 1n })]);

    const { valid, invalid } = await svc.listWithValidation(1n);
    expect(valid).toHaveLength(1);
    expect(invalid).toHaveLength(0);
    expect(valid[0]?.invalid).toBe(false);
  });

  it('价格变动检测：price != priceSnapshot → priceChanged=true；相等 → false', async () => {
    const svc = makeSvc();
    const changed = listRow({ id: 1n, priceSnapshot: 800n, sku: buildSku({ price: 1000n }) });
    const unchanged = listRow({ id: 2n, priceSnapshot: 1000n, sku: buildSku({ price: 1000n }) });
    fakePrisma.cartItem.findMany.mockResolvedValue([changed, unchanged]);

    const { valid } = await svc.listWithValidation(1n);
    const byId = new Map(valid.map((v) => [v.id, v]));
    expect(byId.get(1n)?.priceChanged).toBe(true);
    expect(byId.get(2n)?.priceChanged).toBe(false);
  });

  it('totalAmount 只累加勾选且有效的条目（未勾选 / 失效 / 勾选有效 三类）', async () => {
    const svc = makeSvc();
    const unselected = listRow({ id: 1n, selected: false, quantity: 2, sku: buildSku({ price: 1000n }) });
    const selectedInvalid = listRow({ id: 2n, selected: true, quantity: 3, sku: invalidSkuShape('STOCK_NOT_ENOUGH') });
    const selectedValid = listRow({ id: 3n, selected: true, quantity: 2, sku: buildSku({ price: 1000n }) });
    fakePrisma.cartItem.findMany.mockResolvedValue([unselected, selectedInvalid, selectedValid]);

    const { totalAmount } = await svc.listWithValidation(1n);
    // 仅 selectedValid 计入：1000 * 2 = 2000（分）
    expect(totalAmount).toBe(2000n);
  });

  it('totalAmount 用当前价而非快照价（以后端重算价为准）', async () => {
    const svc = makeSvc();
    // 快照价 500，当前价 1000，数量 2 → 必须按 1000 算 = 2000，而不是 1000
    const row = listRow({ id: 1n, priceSnapshot: 500n, quantity: 2, sku: buildSku({ price: 1000n }) });
    fakePrisma.cartItem.findMany.mockResolvedValue([row]);

    const { totalAmount } = await svc.listWithValidation(1n);
    expect(totalAmount).toBe(2000n);
  });
});

// ---------------------------------------------------------------------------
// 改数量 / 删除 update / remove（越权防护）
// ---------------------------------------------------------------------------

describe('CartService.update / remove', () => {
  it('改数量超可用库存 → 抛库存不足（50001），原记录未被修改', async () => {
    const svc = makeSvc();
    // findById（带 userId）返回库存仅 5 的条目
    fakePrisma.cartItem.findUnique.mockResolvedValue({
      id: 5n,
      skuId: 1n,
      quantity: 1,
      selected: true,
      priceSnapshot: 1000n,
      sku: { stock: { available: 5 } },
    });

    await expect(svc.update(1n, 5n, { quantity: 10 })).rejects.toBeInstanceOf(ConflictError);
    // 原记录未被修改：update 压根没被调用
    expect(fakePrisma.cartItem.update).not.toHaveBeenCalled();
  });

  it('update / remove 必须带 userId 条件（越权防护锁死）', async () => {
    const svc = makeSvc();

    // update 成功路径：库存充足
    fakePrisma.cartItem.findUnique.mockResolvedValue({
      id: 5n,
      skuId: 1n,
      quantity: 1,
      selected: true,
      priceSnapshot: 1000n,
      sku: { stock: { available: 100 } },
    });
    await svc.update(1n, 5n, { quantity: 3 });
    // 收窄成具体形状再断言：这样「漏了 userId 条件」会编译不过，而不只是运行期失败
    const updateWhere = (fakePrisma.cartItem.update.mock.calls[0]?.[0]?.where ?? {}) as {
      userId?: bigint;
      id?: bigint;
    };
    expect(updateWhere.userId).toBe(1n); // 必须带 userId
    expect(updateWhere.id).toBe(5n);

    // remove：where 同时含 id(in) 与 userId
    await svc.remove(1n, [7n, 8n]);
    const deleteWhere = (fakePrisma.cartItem.deleteMany.mock.calls[0]?.[0]?.where ?? {}) as {
      userId?: bigint;
      id?: { in?: bigint[] };
    };
    expect(deleteWhere.userId).toBe(1n); // 只能删自己的
    expect(deleteWhere.id?.in).toEqual([7n, 8n]);
  });
});

// ---------------------------------------------------------------------------
// 未登录购物车合并 mergeGuestCart
// ---------------------------------------------------------------------------

describe('CartService.mergeGuestCart', () => {
  it('同 SKU 累加且封顶 999；失效 SKU 进 skipped 且 reason 明确', async () => {
    const svc = makeSvc();

    // skuId=1 可售且库存充足；skuId=2 已停用（应进 skipped）
    fakePrisma.sku.findUnique.mockImplementation(async (args: { where?: { id?: bigint } }) => {
      const id = args?.where?.id ?? 1n;
      if (id === 2n) {
        return buildSku({ id: 2n, status: SkuStatus.DISABLED });
      }
      return buildSku({ id, stock: { available: 9999 } });
    });
    // 服务端尚无该 SKU 的购物车条目
    fakePrisma.cartItem.findUnique.mockResolvedValue(null);

    const result = await svc.mergeGuestCart(1n, [
      { skuId: 1n, quantity: 500 },
      { skuId: 1n, quantity: 600 }, // 同 SKU 累加 = 1100 → 封顶 999
      { skuId: 2n, quantity: 1 }, // 失效 SKU
    ]);

    expect(result.merged).toBe(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toEqual({ skuId: 2n, reason: 'SKU_DISABLED' });
    // skuId=1 封顶 999
    expect(upsertStore.get('1:1')?.quantity).toBe(999);
  });
});

// ---------------------------------------------------------------------------
// 安全：绝不返回 costPrice
// ---------------------------------------------------------------------------

describe('CartService 结果安全', () => {
  it('返回结果不含 costPrice（成本价仅后台可见）', async () => {
    const svc = makeSvc();
    fakePrisma.cartItem.findMany.mockResolvedValue([listRow({ id: 1n })]);

    const { valid, invalid } = await svc.listWithValidation(1n);
    for (const item of [...valid, ...invalid]) {
      expect(hasKey(item, 'costPrice')).toBe(false);
    }
  });
});
