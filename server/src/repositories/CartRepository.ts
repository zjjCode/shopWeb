/**
 * @file server/src/repositories/CartRepository.ts
 * @description 购物车数据访问层：只做「购物车条目」及关联 SKU / 商品 / 库存的读与写
 * @module repositories
 * @see docs/04-flows.md:293（F4 购物车）、prisma/schema.prisma（CartItem 模型）
 * @author 软件开发团队
 * @created 2026-09-07
 *
 * 分层铁律：本文件**只**与 Prisma 打交道，不含任何业务规则（上限 / 失效判定 / 金额计算
 * 都交给 {@link CartService}）。所有查询都显式带 `userId`，购物车是用户的私有数据，
 * 漏写 where 条件就是越权漏洞。
 */

import type { Prisma, PrismaClient } from '@prisma/client';
import { getPrisma } from '@/core/prisma';

/**
 * 简化的 Prisma 客户端形态（本仓储只用到这两个委托）。
 *
 * @description 用 `Pick` 收窄，既满足注入可打桩（测试传假对象），又避免把整个 PrismaClient
 * 暴露给仓储层。`sku` 委托用于加购前的状态 / 库存校验，`cartItem` 用于条目的增删改查
 */
export type DbClient = Pick<PrismaClient, 'cartItem' | 'sku'>;

/** 一条购物车条目（不含关联）的扁平形态 */
export interface CartItemRow {
  id: bigint;
  userId: bigint;
  skuId: bigint;
  quantity: number;
  selected: boolean;
  priceSnapshot: bigint;
  createdAt: Date;
  updatedAt: Date;
}

/** `findByUserSku` 的返回：只取累加 / 上限判定所需的字段 */
export interface CartItemIdentity {
  id: bigint;
  quantity: number;
  priceSnapshot: bigint;
}

/** `findById` 的返回：带 SKU 的库存，用于改数量前的库存校验 */
export interface CartItemWithSkuStock {
  id: bigint;
  skuId: bigint;
  quantity: number;
  selected: boolean;
  priceSnapshot: bigint;
  sku: { stock: { available: number } | null };
}

/** 列表查询的关联形态（JOIN skus / products / sku_stocks 的投影） */
export type CartItemListRow = Prisma.CartItemGetPayload<{
  include: {
    sku: {
      select: {
        id: true;
        price: true;
        status: true;
        deletedAt: true;
        product: { select: { status: true; deletedAt: true } };
        stock: { select: { available: true } };
      };
    };
  };
}>;

/** 加购前校验 SKU 用的投影（含商品状态与库存，但不含 `costPrice`） */
export type CartSkuCheckRow = Prisma.SkuGetPayload<{
  select: {
    id: true;
    price: true;
    status: true;
    deletedAt: true;
    product: { select: { status: true; deletedAt: true } };
    stock: { select: { available: true } };
  };
}>;

/** upsert / merge 复用的 select：绝不挑 `costPrice`（成本价仅后台可见） */
const CART_ITEM_SELECT = {
  id: true,
  userId: true,
  skuId: true,
  quantity: true,
  selected: true,
  priceSnapshot: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * 购物车仓储。
 */
export class CartRepository {
  /** 注入的 Prisma 客户端（仅 cartItem / sku 两个委托） */
  private readonly prisma: DbClient;

  /**
   * @param prisma Prisma 客户端，缺省时取全局单例
   */
  constructor(prisma: DbClient = getPrisma()) {
    this.prisma = prisma;
  }

  /**
   * 按 `(userId, skuId)` 查单条。
   *
   * @description **必须带 userId**（私有数据）；返回 `uk_user_sku` 命中的唯一行
   * @param userId 用户 ID
   * @param skuId SKU ID
   * @returns 命中条目（id / quantity / priceSnapshot），未命中返回 null
   */
  async findByUserSku(userId: bigint, skuId: bigint): Promise<CartItemIdentity | null> {
    return this.prisma.cartItem.findUnique({
      where: { userId_skuId: { userId, skuId } },
      select: { id: true, quantity: true, priceSnapshot: true },
    });
  }

  /**
   * 按 `(userId, id)` 查单条（带 SKU 库存），供改数量前的库存校验。
   *
   * @description where 同时含 `id` 与 `userId` —— 漏掉 userId 就能改到别人的购物车，越权
   * @param userId 用户 ID
   * @param id 条目 ID
   * @returns 命中条目，未命中返回 null
   */
  async findById(userId: bigint, id: bigint): Promise<CartItemWithSkuStock | null> {
    return this.prisma.cartItem.findUnique({
      where: { id, userId },
      select: {
        id: true,
        skuId: true,
        quantity: true,
        selected: true,
        priceSnapshot: true,
        sku: { select: { stock: { select: { available: true } } } },
      },
    });
  }

  /**
   * 查某用户的购物车列表（带 SKU / 商品 / 库存关联，按 `updated_at` DESC）。
   *
   * @description where 仅 `userId`；select 显式排除 `costPrice`，杜绝成本价泄露
   * @param userId 用户 ID
   * @returns 条目列表（含关联投影）
   */
  async listByUser(userId: bigint): Promise<CartItemListRow[]> {
    return this.prisma.cartItem.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
      include: {
        sku: {
          select: {
            id: true,
            price: true,
            status: true,
            deletedAt: true,
            product: { select: { status: true, deletedAt: true } },
            stock: { select: { available: true } },
          },
        },
      },
    });
  }

  /**
   * 统计某用户的购物车条目数（用于「总条目 ≤ 100」上限）。
   *
   * @param userId 用户 ID
   * @returns 条目数量
   */
  async countByUser(userId: bigint): Promise<number> {
    return this.prisma.cartItem.count({ where: { userId } });
  }

  /**
   * 加购 upsert：「同 SKU 累加不增行」。
   *
   * @description 依赖 `uk_user_sku (user_id, sku_id)`：
   * - 不存在 → 插入新行（quantity = 入参，默认 selected = true，写入价格快照）；
   * - 已存在 → `quantity = quantity + VALUES(quantity)`（累加，**不新增行**，且不改 priceSnapshot，
   *   以便列表接口正确检测「价格已变动」）
   * @param userId 用户 ID
   * @param skuId SKU ID
   * @param quantity 本次加购数量（会被累加到已有数量上）
   * @param priceSnapshot 加购时 SKU 售价快照（分）
   * @returns 写入后的条目
   */
  async addOrIncrement(
    userId: bigint,
    skuId: bigint,
    quantity: number,
    priceSnapshot: bigint,
  ): Promise<CartItemRow> {
    const result = await this.prisma.cartItem.upsert({
      where: { userId_skuId: { userId, skuId } },
      create: { userId, skuId, quantity, priceSnapshot, selected: true },
      update: { quantity: { increment: quantity } },
      select: CART_ITEM_SELECT,
    });
    return result as CartItemRow;
  }

  /**
   * 合并 upsert（登录后合并未登录购物车）：绝对数量写入并封顶 999。
   *
   * @description 与 {@link addOrIncrement} 不同，这里是「set」语义（`update: { quantity }` 绝对值），
   * 由调用方先算好 `LEAST(已有 + 新增, 999)` 再传入，避免「先读后写」之间的并发累加误差被放大。
   * 仍依赖 `uk_user_sku` 保证同 SKU 不增行
   * @param userId 用户 ID
   * @param skuId SKU ID
   * @param quantity 合并后的绝对数量（已封顶 999）
   * @param priceSnapshot 当前 SKU 售价快照（分）
   * @returns 写入后的条目
   */
  async mergeSet(
    userId: bigint,
    skuId: bigint,
    quantity: number,
    priceSnapshot: bigint,
  ): Promise<CartItemRow> {
    const result = await this.prisma.cartItem.upsert({
      where: { userId_skuId: { userId, skuId } },
      create: { userId, skuId, quantity, priceSnapshot, selected: true },
      update: { quantity },
      select: CART_ITEM_SELECT,
    });
    return result as CartItemRow;
  }

  /**
   * 按 `(id, userId)` 更新数量 / 勾选。
   *
   * @description **where 必须带 userId**，否则任意用户都能改别人的购物车条目（越权写）
   * @param userId 用户 ID（越权防护条件，不可省略）
   * @param id 条目 ID
   * @param data 待更新字段（quantity / selected，由服务层校验后传入）
   * @returns 更新后的条目
   */
  async update(userId: bigint, id: bigint, data: { quantity?: number; selected?: boolean }): Promise<CartItemRow> {
    const result = await this.prisma.cartItem.update({
      where: { id, userId },
      data,
      select: CART_ITEM_SELECT,
    });
    return result as CartItemRow;
  }

  /**
   * 按 `id[] + userId` 批量删除。
   *
   * @description **where 同时带 `id(in)` 与 `userId`** —— 漏掉 userId 等于「凭一组 id 删全库购物车」
   * @param userId 用户 ID（越权防护条件，不可省略）
   * @param ids 待删除条目 ID 列表
   * @returns 实际删除条数
   */
  async remove(userId: bigint, ids: bigint[]): Promise<number> {
    const result = await this.prisma.cartItem.deleteMany({
      where: { id: { in: ids }, userId },
    });
    return result.count;
  }

  /**
   * 加购前校验 SKU 状态 / 商品状态 / 可用库存。
   *
   * @description 一次查出 SKU（含商品与库存投影），select 不含 `costPrice`。
   * 软删 / 停用 / 下架 / 库存不足的语义判定在 {@link CartService} 完成，本方法只负责取数
   * @param skuId SKU ID
   * @returns SKU 校验投影；SKU 不存在返回 null
   */
  async findSkuForAdd(skuId: bigint): Promise<CartSkuCheckRow | null> {
    return this.prisma.sku.findUnique({
      where: { id: skuId },
      select: {
        id: true,
        price: true,
        status: true,
        deletedAt: true,
        product: { select: { status: true, deletedAt: true } },
        stock: { select: { available: true } },
      },
    });
  }
}
