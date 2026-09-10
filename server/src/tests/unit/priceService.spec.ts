/**
 * @file server/src/tests/unit/priceService.spec.ts
 * @description PriceService 价格重算单测（假 Prisma 打桩，不连真实 DB）
 * @module tests/unit
 * @see server/src/services/PriceService.ts、docs/02-architecture.md §5.11 / §11、docs/03-database.md §3.4
 * @author 软件开发团队
 * @created 2026-09-07
 *
 * 为什么必须有单测：环境无 MySQL 实例，金额恒等式（E1~E7）、运费规则、分摊守恒这些规则
 * 无法靠 tsc 验证，一旦写错就是「预览价 ≠ 实付价」或退款算不清。用注入构造参数的假 Prisma 驱动，
 * 不依赖真实实例。先读 cartService.spec.ts 趟平的坑（config.log.level 必填、jest 29 泛型写法等）。
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { BusinessError, ValidationError } from '@/core/errors';
import { ErrorCode } from '@/core/errors/errorCodes';
import { MoneyUtil } from '@/core/money';
import { PriceService, type PriceResult } from '@/services/PriceService';

// config 在模块加载时即校验并建 winston 实例，缺了 log.level 整个套件起不来
jest.mock('@/config', () => ({
  config: {
    env: 'test',
    redis: { keyPrefix: 'shop' },
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

/** PriceService 构造函数第一个参数（DbClient）的类型 */
type CtorPrisma = ConstructorParameters<typeof PriceService>[0];

/** sku.findMany 返回形态（与 calculate 内 select 一致，刻意不含 costPrice） */
interface SkuShape {
  id: bigint;
  price: bigint;
}

// ---------------------------------------------------------------------------
// 假 Prisma（只实现 calculate 用到的 sku.findMany）
// ---------------------------------------------------------------------------

const fakePrisma = {
  sku: {
    findMany: jest.fn<(args: { where?: { id?: { in?: bigint[] } } }) => Promise<SkuShape[]>>(),
  },
};

/** 价格表：skuId -> 单价（分），只放表里的 SKU 视为「存在」 */
const priceTable = new Map<bigint, bigint>();

/** 用假 prisma 构造一个 PriceService */
function makeSvc(): PriceService {
  return new PriceService(fakePrisma as unknown as CtorPrisma);
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

// ---------------------------------------------------------------------------
// 默认打桩（每个用例前重置，避免互相污染）
// ---------------------------------------------------------------------------

beforeEach(() => {
  priceTable.clear();
  // 只返回价格表中存在的 SKU（缺失即「SKU 不存在」）
  fakePrisma.sku.findMany.mockImplementation(async (args: { where?: { id?: { in?: bigint[] } } }) => {
    const ids = args?.where?.id?.in ?? [];
    return ids
      .filter((id) => priceTable.has(id))
      .map((id) => ({ id, price: priceTable.get(id) ?? 0n }));
  });
});

// ---------------------------------------------------------------------------
// 1. 无优惠：商品总额 / 应付 = 商品 + 运费
// ---------------------------------------------------------------------------

describe('PriceService.calculate 基础金额', () => {
  it('无优惠时：goodsAmount = Σ(单价 × 数量)，payAmount = goodsAmount + freightAmount', async () => {
    const svc = makeSvc();
    // sku1: 1000 分 × 2 = 2000；sku2: 500 分 × 3 = 1500 → goods = 3500（< 9900 → 运费 1200）
    priceTable.set(1n, 1000n).set(2n, 500n);

    const r = await svc.calculate({ items: [
      { skuId: 1n, quantity: 2 },
      { skuId: 2n, quantity: 3 },
    ] });

    expect(r.goodsAmount).toBe(3500n);
    expect(r.freightAmount).toBe(1200n);
    expect(r.payAmount).toBe(4700n); // 3500 + 1200
    // 各行小计正确
    const sku1 = r.items.find((i) => i.skuId === 1n)!;
    const sku2 = r.items.find((i) => i.skuId === 2n)!;
    expect(sku1.goodsAmount).toBe(2000n);
    expect(sku2.goodsAmount).toBe(1500n);
    expect(sku1.payableAmount).toBe(2000n);
    expect(sku2.payableAmount).toBe(1500n);
  });

  it('四个优惠字段本期恒为 0，且字段存在', async () => {
    const svc = makeSvc();
    priceTable.set(1n, 1000n);

    const r = await svc.calculate({ items: [{ skuId: 1n, quantity: 1 }] });

    expect(r.rowPromoDiscount).toBe(0n);
    expect(r.orderPromoDiscount).toBe(0n);
    expect(r.couponDiscount).toBe(0n);
    expect(r.pointDeductAmount).toBe(0n);
  });
});

// ---------------------------------------------------------------------------
// 2. 运费不参与行分摊（最易错处，单独锁死）
// ---------------------------------------------------------------------------

describe('PriceService 运费规则', () => {
  it('运费不参与行分摊：Σ payableAmount + freightAmount === payAmount', async () => {
    const svc = makeSvc();
    priceTable.set(1n, 1000n).set(2n, 500n);

    const r = await svc.calculate({ items: [
      { skuId: 1n, quantity: 2 },
      { skuId: 2n, quantity: 3 },
    ] });

    const sumPayable = r.items.reduce((acc, i) => acc + i.payableAmount, 0n);
    expect(sumPayable + r.freightAmount).toBe(r.payAmount);
  });

  it('满额免运费：刚好 9900 分（= 99 元）→ 运费 0', async () => {
    const svc = makeSvc();
    priceTable.set(10n, 9900n);
    const r = await svc.calculate({ items: [{ skuId: 10n, quantity: 1 }] });
    expect(r.goodsAmount).toBe(9900n);
    expect(r.freightAmount).toBe(0n);
    expect(r.payAmount).toBe(9900n);
  });

  it('满额免运费边界：差 1 分（9899）→ 收 1200 运费', async () => {
    const svc = makeSvc();
    priceTable.set(11n, 9899n);
    const r = await svc.calculate({ items: [{ skuId: 11n, quantity: 1 }] });
    expect(r.goodsAmount).toBe(9899n);
    expect(r.freightAmount).toBe(1200n);
    expect(r.payAmount).toBe(11099n);
  });

  it('满额免运费边界：超过阈值（9901）→ 运费 0', async () => {
    const svc = makeSvc();
    priceTable.set(12n, 9901n);
    const r = await svc.calculate({ items: [{ skuId: 12n, quantity: 1 }] });
    expect(r.goodsAmount).toBe(9901n);
    expect(r.freightAmount).toBe(0n);
    expect(r.payAmount).toBe(9901n);
  });
});

// ---------------------------------------------------------------------------
// 3. 多条目恒等式全部成立（E1~E7）
// ---------------------------------------------------------------------------

describe('PriceService 多条目恒等式', () => {
  it('5 个条目时 calculate 不抛错，且核心恒等式成立', async () => {
    const svc = makeSvc();
    // 价格刻意取不整的数，验证 bigint 运算无精度丢失
    priceTable.set(1n, 1999n).set(2n, 2500n).set(3n, 3333n).set(4n, 4100n).set(5n, 7799n);

    const r = await svc.calculate({ items: [
      { skuId: 1n, quantity: 1 },
      { skuId: 2n, quantity: 2 },
      { skuId: 3n, quantity: 1 },
      { skuId: 4n, quantity: 3 },
      { skuId: 5n, quantity: 1 },
    ] });

    // E1：goodsAmount = Σ 行小计
    const sumGoods = r.items.reduce((acc, i) => acc + i.goodsAmount, 0n);
    expect(sumGoods).toBe(r.goodsAmount);
    // E4_FREIGHT：Σ payable + freight = pay
    const sumPayable = r.items.reduce((acc, i) => acc + i.payableAmount, 0n);
    expect(sumPayable + r.freightAmount).toBe(r.payAmount);
    // E4：pay = goods - 优惠 + freight（本期优惠 0）
    expect(r.goodsAmount + r.freightAmount).toBe(r.payAmount);
    // E7：Σ payable = goods - 优惠
    expect(sumPayable).toBe(r.goodsAmount);
    // 每行 payable = goods - promo - allocated（本期均为 0）
    for (const it of r.items) {
      expect(it.payableAmount).toBe(it.goodsAmount - it.promoDiscount - it.allocatedDiscount);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. 分摊守恒（订单级优惠分摊到行，尾差计入权重最大项）
// ---------------------------------------------------------------------------

describe('PriceService 订单级优惠分摊守恒', () => {
  it('100 分分摊到 3 行（每行 100，总权重 300）→ Σ 分摊 === 100，尾差 1 分计入权重最大行', async () => {
    const svc = makeSvc();
    // 3 行 goods 均为 100，总权重 300；优惠 100 不可被 3 整除（每行列 33，余 1）
    priceTable.set(1n, 100n).set(2n, 100n).set(3n, 100n);

    const r = await svc.calculate({
      items: [
        { skuId: 1n, quantity: 1 },
        { skuId: 2n, quantity: 1 },
        { skuId: 3n, quantity: 1 },
      ],
      orderPromoDiscount: 100n,
    });

    // E3_ORDER：Σ 分摊 === 优惠总额（守恒，无一分漂移）
    const allocatedSum = r.items.reduce((acc, i) => acc + i.allocatedDiscount, 0n);
    expect(allocatedSum).toBe(100n);
    expect(r.orderPromoDiscount).toBe(100n);

    // 尾差计入权重最大项：本例三行权重相等（均为 100），按「权重并列取行号最小」规则尾差落在第 0 行
    expect(r.items[0]?.allocatedDiscount).toBe(34n); // 33 + 1 尾差
    expect(r.items[1]?.allocatedDiscount).toBe(33n);
    expect(r.items[2]?.allocatedDiscount).toBe(33n);

    // 行内守恒：每行 promo(0) + allocated <= goods(100)
    for (const it of r.items) {
      expect(it.promoDiscount + it.allocatedDiscount <= it.goodsAmount).toBe(true);
    }
    // 行实付 = goods - allocated，且 Σ payable + freight = pay 仍成立
    const sumPayable = r.items.reduce((acc, i) => acc + i.payableAmount, 0n);
    expect(sumPayable + r.freightAmount).toBe(r.payAmount);
  });

  it('尾差计入权重严格最大项：权重 [10,20,30] 总权 60，优惠 50 不可整除 → 尾数落到权重 30 的行', async () => {
    const svc = makeSvc();
    priceTable.set(1n, 10n).set(2n, 20n).set(3n, 30n);

    const r = await svc.calculate({
      items: [
        { skuId: 1n, quantity: 1 },
        { skuId: 2n, quantity: 1 },
        { skuId: 3n, quantity: 1 },
      ],
      // 50 <= 60（不超过总权重，否则 MoneyUtil.allocateBigint 直接抛错），且不能被 3 整除
      orderPromoDiscount: 50n,
    });

    const allocatedSum = r.items.reduce((acc, i) => acc + i.allocatedDiscount, 0n);
    expect(allocatedSum).toBe(50n);
    // 第 2 行（权重 30，最大）拿到尾差：分摊结果 [8,16,26]
    expect(r.items[0]?.allocatedDiscount).toBe(8n);
    expect(r.items[1]?.allocatedDiscount).toBe(16n);
    expect(r.items[2]?.allocatedDiscount).toBe(26n);
    // 行内守恒仍成立
    for (const it of r.items) {
      expect(it.promoDiscount + it.allocatedDiscount <= it.goodsAmount).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. 非法值 / 边界：拒绝而非产生 NaN 或负金额
// ---------------------------------------------------------------------------

describe('PriceService 入参校验', () => {
  it('数量为 0 → 抛 ValidationError', async () => {
    const svc = makeSvc();
    priceTable.set(1n, 1000n);
    await expect(svc.calculate({ items: [{ skuId: 1n, quantity: 0 }] })).rejects.toBeInstanceOf(ValidationError);
  });

  it('数量为负 → 抛 ValidationError', async () => {
    const svc = makeSvc();
    priceTable.set(1n, 1000n);
    await expect(svc.calculate({ items: [{ skuId: 1n, quantity: -3 }] })).rejects.toBeInstanceOf(ValidationError);
  });

  it('数量非整数 → 抛 ValidationError', async () => {
    const svc = makeSvc();
    priceTable.set(1n, 1000n);
    await expect(svc.calculate({ items: [{ skuId: 1n, quantity: 1.5 }] })).rejects.toBeInstanceOf(ValidationError);
  });

  it('单价为 0 的 SKU → 抛 ValidationError（不产生脏数据）', async () => {
    const svc = makeSvc();
    priceTable.set(1n, 0n);
    await expect(svc.calculate({ items: [{ skuId: 1n, quantity: 1 }] })).rejects.toBeInstanceOf(ValidationError);
  });

  it('SKU 在库中不存在 → 抛 BusinessError(SKU_NOT_FOUND, 21002)', async () => {
    const svc = makeSvc();
    // 不在 priceTable 中 → findMany 不返回 → 视为不存在
    await expect(svc.calculate({ items: [{ skuId: 999n, quantity: 1 }] })).rejects.toMatchObject({
      code: ErrorCode.SKU_NOT_FOUND,
    });
  });

  it('空条目列表 → 抛 ValidationError', async () => {
    const svc = makeSvc();
    await expect(svc.calculate({ items: [] })).rejects.toBeInstanceOf(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// 6. 安全：绝不返回 costPrice
// ---------------------------------------------------------------------------

describe('PriceService 结果安全', () => {
  it('返回结果不含 costPrice（成本价仅后台可见）', async () => {
    const svc = makeSvc();
    priceTable.set(1n, 1000n).set(2n, 500n);

    const r: PriceResult = await svc.calculate({ items: [
      { skuId: 1n, quantity: 2 },
      { skuId: 2n, quantity: 3 },
    ] });

    expect(hasKey(r, 'costPrice')).toBe(false);
    expect(hasKey(r, 'cost_price')).toBe(false);
  });

  it('单价确实来自 DB 而非外部（DB 改价即生效，验证服务端重算）', async () => {
    const svc = makeSvc();
    priceTable.set(1n, 1234n);
    const r = await svc.calculate({ items: [{ skuId: 1n, quantity: 2 }] });
    expect(r.items[0]?.unitPrice).toBe(1234n);
    expect(r.items[0]?.goodsAmount).toBe(2468n);
  });
});

// ---------------------------------------------------------------------------
// 7. 恒等式闸门：账目不平 → 抛错而非返回脏数据
// ---------------------------------------------------------------------------

describe('PriceService 恒等式闸门', () => {
  it('强制让 assertIdentity 失败 → calculate 抛 BusinessError 而非返回脏数据', async () => {
    const svc = makeSvc();
    priceTable.set(1n, 1000n);

    // 白盒：让最后一道闸门的任一恒等式断言抛错，验证 calculate 会向上传播拒绝下单
    const spy = jest
      .spyOn(MoneyUtil, 'assertIdentity')
      .mockImplementation(() => {
        throw new BusinessError('金额恒等式校验失败', { code: ErrorCode.ORDER_AMOUNT_INVALID });
      });

    await expect(svc.calculate({ items: [{ skuId: 1n, quantity: 1 }] })).rejects.toBeInstanceOf(BusinessError);

    spy.mockRestore();
  });
});
