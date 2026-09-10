/**
 * @file server/src/services/PriceService.ts
 * @description 下单 / 结算页价格重算核心服务：服务端重算金额 + 运费 + 订单级优惠分摊 + 恒等式闸门
 * @module services
 * @see docs/02-architecture.md §5.11（金额处理公约与恒等式 E1~E10）、§11（优惠计算引擎）
 * @see docs/03-database.md:1788（chk_order_amount_identity 四级扣减）、:1829（chk_order_item_payable）、:1833（chk_order_item_discount_bound）
 * @see docs/04-flows.md:546（优惠引擎唯一入口 PriceService.calculate，金额一律服务端算）
 * @author 软件开发团队
 * @created 2026-09-07
 *
 * 为什么必须有这个服务（最小闭环硬约束）：
 * 1. **防价格篡改**：单价只从 DB 读（权威源），前端传来的任何价格一律不认；这是「预览价 ≠ 实付价」
 *    与「改包攥改 POST 金额」两道漏洞的唯一闸口（docs/04-flows.md:546）。
 * 2. **优惠引擎唯一入口**：结算页预览与下单**必须调用同一个 `calculate`**，保证两边算出来的钱一模一样。
 * 3. **运费不参与行分摊**：`Σ payableAmount + freightAmount === payAmount`（docs/03-database.md:889），
 *    这是整张订单最容易写错的地方 —— 把运费塞进某行的 payable 会直接破坏退款分摊公式。
 * 4. **最后一道闸门**：`calculate` 返回前集中 `assertIdentity`，任一条恒等式不平立即抛 `BusinessError`
 *    拒绝下单，宁可让用户重试也绝不让脏金额落库（§5.11「绝不允许带着算错的金额进入下单事务」）。
 *
 * 本期范围（紧扣最小闭环）：不做优惠券 / 促销 / 积分，四个优惠字段恒 0，但字段存在且与 DB
 * 字段一一对应，为 T041 预留。`calculate` 接受可选的 `orderPromoDiscount` 仅用于单测驱动分摊守恒校验，
 * 真实下单路径不传（恒 0）。
 */

import type { PrismaClient } from '@prisma/client';
import { BusinessError, ValidationError } from '@/core/errors';
import { ErrorCode, getErrorMeta } from '@/core/errors/errorCodes';
import { getPrisma } from '@/core/prisma';
import { MoneyUtil } from '@/core/money';

/** 简化的 Prisma 客户端形态（本服务只用到 sku 两个字段的只读查询） */
type DbClient = Pick<PrismaClient, 'sku'>;

/** 下单 / 结算条目（前端只传这两个字段，价格服务端重算） */
export interface PriceCalculateItem {
  skuId: bigint;
  quantity: number;
}

/** calculate 入参 */
export interface PriceCalculateInput {
  items: PriceCalculateItem[];
  /**
   * 订单级促销优惠（v2 四级扣减之一）。**本期恒 0**；为 T041 预留，单测用它驱动分摊守恒校验。
   * 真实下单路径由 PromotionEngine 注入，绝不来自前端。
   */
  orderPromoDiscount?: bigint;
}

/** 单行计算结果（字段对齐 `order_items`，单位：分 / bigint） */
export interface PriceItemResult {
  skuId: bigint;
  quantity: number;
  /** 服务端重算单价（分），绝不返回 costPrice */
  unitPrice: bigint;
  /** 行商品金额 = unitPrice × quantity（分） */
  goodsAmount: bigint;
  /** 行级促销优惠（本期恒 0） */
  promoDiscount: bigint;
  /** 订单级优惠分摊到本行的金额（分） */
  allocatedDiscount: bigint;
  /** 行实付 = goodsAmount - promoDiscount - allocatedDiscount（不含运费，分） */
  payableAmount: bigint;
}

/** calculate 返回结构（字段对齐 `orders` / `order_items`，单位：分 / bigint） */
export interface PriceResult {
  /** 商品总额（分） */
  goodsAmount: bigint;
  /** 行级促销优惠（v2 四级扣减之一，本期恒 0） */
  rowPromoDiscount: bigint;
  /** 订单级促销优惠（本期恒 0，T041 接入） */
  orderPromoDiscount: bigint;
  /** 优惠券优惠（本期恒 0，T041 接入） */
  couponDiscount: bigint;
  /** 积分抵扣（二阶段，本期恒 0） */
  pointDeductAmount: bigint;
  /** 运费（分） */
  freightAmount: bigint;
  /** 应付金额（分） */
  payAmount: bigint;
  /** 行级明细 */
  items: PriceItemResult[];
}

// ---------------------------------------------------------------------------
// 运费规则（来源：docs/02-architecture.md:1901 ⑤「满 99 包邮，否则 12 元；
// 判定基数 = 促销与券优惠后的商品金额」）
// ---------------------------------------------------------------------------

/** 满额包邮阈值（分）：满 99 元免运费 */
export const FREIGHT_FREE_THRESHOLD_CENTS = 9900n;
/** 固定运费（分）：不满阈值收 12 元 */
export const FREIGHT_FLAT_FEE_CENTS = 1200n;

/** SKU 不存在错误参数（21002，HTTP 404，沿用错误码表登记的语义） */
const SKU_NOT_FOUND_OPTIONS = {
  code: ErrorCode.SKU_NOT_FOUND,
  httpStatus: getErrorMeta(ErrorCode.SKU_NOT_FOUND).httpStatus,
} as const;

/**
 * 金额求和（bigint 版，全程走 MoneyUtil，禁止裸算术）。
 *
 * @param values 金额数组（分）
 * @returns 总和（分，bigint）
 */
function sumB(values: readonly bigint[]): bigint {
  return MoneyUtil.toBigint(MoneyUtil.sum(values), 'sumB');
}

/**
 * 价格重算服务。
 *
 * 计算管道顺序（docs/02-architecture.md §11.1，不可调换）：
 * ① 商品原价小计（服务端重算）→ ② 行级促销（本期 0）→ ③ 优惠券（本期 0）
 * → ④ 订单级优惠分摊到行（allocateBigint，尾差计入权重最大项）→ ⑤ 运费 → ⑥ 恒等式全量校验。
 */
export class PriceService {
  /** 注入的 Prisma 客户端（只用于 sku 只读查询） */
  private readonly prisma: DbClient;

  /**
   * @param prisma Prisma 客户端，缺省时取全局单例（便于单测打桩）
   */
  constructor(prisma: DbClient = getPrisma()) {
    this.prisma = prisma;
  }

  /**
   * 服务端重算下单金额（结算页预览与下单共用的唯一入口）。
   *
   * @description
   * - 单价只从 DB `sku.price` 读，前端传入的价格一律不认（防篡改）；
   * - 只 `select { id, price }`，**绝不返回 `costPrice`**（成本价仅后台可见）；
   * - 订单级优惠（若有）按行金额权重分摊，尾差计入权重最大项，保证 E3 严格成立；
   * - 运费按「满 99 包邮、否则 12 元」计算，**不参与行分摊**；
   * - 返回前集中校验 E1~E7 恒等式，任一条不平立即抛 `BusinessError`。
   * @param input 下单条目（skuId + quantity）+ 可选订单级优惠
   * @returns 完整价格结果（分，bigint）
   * @throws {ValidationError} 入参非法 / 数量为 0 或非法 / 单价为 0 或负 / SKU 不存在
   * @throws {BusinessError} 金额恒等式校验失败（31003，订单金额校验失败）
   */
  async calculate(input: PriceCalculateInput): Promise<PriceResult> {
    const rawItems = input?.items ?? [];
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      throw new ValidationError('下单条目不能为空', { code: ErrorCode.FIELD_FORMAT_INVALID });
    }

    // 1. 入参兜底校验 + 同 SKU 数量聚合（防重复下单行 / 重复读价）
    const bySku = new Map<bigint, number>();
    for (const it of rawItems) {
      if (typeof it.skuId !== 'bigint' || it.skuId <= 0n) {
        throw new ValidationError('skuId 非法（必须为正整数 bigint）', { code: ErrorCode.FIELD_FORMAT_INVALID });
      }
      // 不信任上游：quantity 必须为正整型
      if (!Number.isInteger(it.quantity) || it.quantity <= 0) {
        throw new ValidationError('数量必须为正整数', { code: ErrorCode.FIELD_FORMAT_INVALID });
      }
      bySku.set(it.skuId, (bySku.get(it.skuId) ?? 0) + it.quantity);
    }

    const skuIds = [...bySku.keys()];

    // 2. 价格从 DB 读（权威源，防篡改）；显式 select，绝不返回 costPrice
    const skus = await this.prisma.sku.findMany({
      where: { id: { in: skuIds } },
      select: { id: true, price: true },
    });
    const priceMap = new Map<bigint, bigint>();
    for (const s of skus) {
      priceMap.set(s.id, MoneyUtil.toBigint(s.price, 'sku.price'));
    }
    // 任一 skuId 在库中不存在 → SKU_NOT_FOUND（越权 / 误传防护）
    for (const id of skuIds) {
      if (!priceMap.has(id)) {
        throw new BusinessError('SKU 不存在', SKU_NOT_FOUND_OPTIONS);
      }
    }

    // 3. 本期优惠 / 抵扣恒 0（字段为 T041 预留）。订单级优惠允许由单测注入以驱动分摊校验。
    const rowPromoDiscount = 0n;
    const couponDiscount = 0n;
    const pointDeductAmount = 0n;
    const orderPromoDiscount = MoneyUtil.toBigint(input.orderPromoDiscount ?? 0n, 'orderPromoDiscount');
    if (orderPromoDiscount < 0n) {
      throw new ValidationError('订单级优惠不能为负', { code: ErrorCode.FIELD_FORMAT_INVALID });
    }

    // 4. 逐行计算原价小计（单价 × 数量，全程 MoneyUtil）
    const items: PriceItemResult[] = [];
    let goodsAmount = 0n;
    for (const [skuId, quantity] of bySku) {
      const unitPrice = priceMap.get(skuId)!;
      // 单价为 0 / 负 → 拒绝（不产生 NaN 或负金额脏数据）
      if (unitPrice <= 0n) {
        throw new ValidationError('SKU 售价非法（必须为正数）', { code: ErrorCode.FIELD_FORMAT_INVALID });
      }
      const lineGoods = MoneyUtil.toBigint(MoneyUtil.multiply(unitPrice, quantity), 'lineGoods');
      items.push({
        skuId,
        quantity,
        unitPrice,
        goodsAmount: lineGoods,
        promoDiscount: 0n,
        allocatedDiscount: 0n,
        payableAmount: lineGoods, // 占位，分摊后重算
      });
      goodsAmount = MoneyUtil.toBigint(MoneyUtil.add(goodsAmount, lineGoods), 'goodsAmount');
    }

    // 5. 订单级优惠分摊到行（尾差计入权重最大项，保证 E3 严格成立）
    //    权重 = 行金额 - 行促销（本期行促销为 0 → 权重 = 行金额），与 MoneyUtil.allocate 文档一致
    const weights = items.map((it) =>
      MoneyUtil.toBigint(MoneyUtil.subtract(it.goodsAmount, it.promoDiscount), 'weight'),
    );
    const allocated =
      orderPromoDiscount === 0n
        ? items.map(() => 0n)
        : MoneyUtil.allocateBigint(orderPromoDiscount, weights);

    let allocatedSum = 0n;
    items.forEach((it, idx) => {
      it.allocatedDiscount = allocated[idx] ?? 0n;
      // 行实付 = 行金额 - 行促销 - 行分摊（对应 DB chk_order_item_payable）
      it.payableAmount = MoneyUtil.toBigint(
        MoneyUtil.subtract(it.goodsAmount, MoneyUtil.add(it.promoDiscount, it.allocatedDiscount)),
        'payable',
      );
      allocatedSum = MoneyUtil.toBigint(MoneyUtil.add(allocatedSum, it.allocatedDiscount), 'allocatedSum');
    });

    // 6. 全部优惠合计（v2 四级：行促销 + 订单级 + 券 + 积分）
    const discountTotal = sumB([rowPromoDiscount, orderPromoDiscount, couponDiscount, pointDeductAmount]);

    // 7. 运费（docs/02-architecture.md:1901 ⑤）：判定基数 = 所有优惠后的商品金额（本期 = goodsAmount）
    //    ⚠️ 运费不参与行分摊，单独成项
    const freightBase = MoneyUtil.toBigint(MoneyUtil.subtract(goodsAmount, discountTotal), 'freightBase');
    const freightAmount = freightBase >= FREIGHT_FREE_THRESHOLD_CENTS ? 0n : FREIGHT_FLAT_FEE_CENTS;

    // 8. 应付（v2 四级扣减，docs/03-database.md:1790 chk_order_amount_identity）
    const payAmount = MoneyUtil.toBigint(
      MoneyUtil.add(MoneyUtil.subtract(goodsAmount, discountTotal), freightAmount),
      'payAmount',
    );

    const result: PriceResult = {
      goodsAmount,
      rowPromoDiscount,
      orderPromoDiscount,
      couponDiscount,
      pointDeductAmount,
      freightAmount,
      payAmount,
      items,
    };

    // 9. 最后一道闸门：集中校验恒等式，任一条不平即抛错
    this.assertIdentities(result, { allocatedSum, discountTotal });

    return result;
  }

  /**
   * 集中校验金额恒等式（E1~E7），任一条不成立立即抛 `BusinessError` 拒绝返回结果。
   *
   * @description 以 docs/02-architecture.md §5.11 的 E1~E10 与 §11.1 计算管道为准：
   * - E1：商品总额 = 各行原价小计之和；
   * - 行级守恒（对应 DB chk_order_item_payable / chk_order_item_discount_bound）：
   *   每行 payable = goods - promo - allocated，且 promo + allocated <= goods；
   * - E3(v2)：行级优惠汇总 = 订单级优惠，且 Σ allocatedDiscount = orderPromoDiscount；
   * - E4(v2)：运费不参与行分摊 → Σ payable + freight = pay；pay = goods - 全部优惠 + freight；
   * - E5(v2)：全部优惠 <= 商品金额（运费不参与优惠）；
   * - E6：pay >= 0 且 pay >= freight；
   * - E7(v2)：Σ payable = goods - 全部优惠。
   * @param r 价格结果
   * @param ctx 校验上下文（分摊合计 / 优惠合计）
   */
  private assertIdentities(r: PriceResult, ctx: { allocatedSum: bigint; discountTotal: bigint }): void {
    const sumItemGoods = sumB(r.items.map((i) => i.goodsAmount));
    const sumItemPayable = sumB(r.items.map((i) => i.payableAmount));
    const sumItemPromo = sumB(r.items.map((i) => i.promoDiscount));
    const sumItemAlloc = sumB(r.items.map((i) => i.allocatedDiscount));

    // E1：商品总额 = 各行原价小计之和（用服务端重算的价，不信前端）
    MoneyUtil.assertIdentity('E1', sumItemGoods, r.goodsAmount, {
      items: r.items.map((i) => ({ skuId: i.skuId, goodsAmount: i.goodsAmount })),
    });

    // 行级恒等式（逐行）：对应 DB chk_order_item_payable / chk_order_item_discount_bound ④
    r.items.forEach((it, idx) => {
      const expectPayable = MoneyUtil.toBigint(
        MoneyUtil.subtract(it.goodsAmount, MoneyUtil.add(it.promoDiscount, it.allocatedDiscount)),
        'expectPayable',
      );
      MoneyUtil.assertIdentity(`ROW_PAYABLE#${idx}`, it.payableAmount, expectPayable, { skuId: it.skuId });
      // 行内守恒：promo + allocated <= goods（否则会出现负金额行）
      const lineDiscount = MoneyUtil.toBigint(MoneyUtil.add(it.promoDiscount, it.allocatedDiscount), 'lineDiscount');
      if (lineDiscount > it.goodsAmount) {
        throw new BusinessError(`行内优惠超过商品金额（skuId=${it.skuId}）`, {
          code: ErrorCode.ORDER_AMOUNT_INVALID,
          data: { skuId: it.skuId, lineDiscount, goodsAmount: it.goodsAmount },
        });
      }
      // 行金额非负（单价 > 0 已保证，这里再兜底）
      if (it.payableAmount < 0n || it.goodsAmount < 0n || it.unitPrice < 0n) {
        throw new BusinessError('出现负金额行', { code: ErrorCode.ORDER_AMOUNT_INVALID });
      }
    });

    // E3(v2)：行级优惠汇总 = 订单级促销；Σ allocatedDiscount = 订单级优惠（分摊守恒前提）
    MoneyUtil.assertIdentity('E3_ROW', sumItemPromo, r.rowPromoDiscount, { sumItemPromo });
    MoneyUtil.assertIdentity('E3_ORDER', sumItemAlloc, ctx.allocatedSum, { sumItemAlloc, allocatedSum: ctx.allocatedSum });
    MoneyUtil.assertIdentity('E3_ORDER_INPUT', sumItemAlloc, r.orderPromoDiscount, {
      sumItemAlloc,
      orderPromoDiscount: r.orderPromoDiscount,
    });

    // E4(v2, 运费不参与行分摊)：Σ payableAmount + freightAmount === payAmount
    MoneyUtil.assertIdentity(
      'E4_FREIGHT',
      MoneyUtil.toBigint(MoneyUtil.add(sumItemPayable, r.freightAmount), 'sumPayFreight'),
      r.payAmount,
      { sumItemPayable, freight: r.freightAmount },
    );

    // E4(v2)：pay = goods - 全部优惠 + freight（docs/03-database.md:1790）
    MoneyUtil.assertIdentity(
      'E4',
      r.payAmount,
      MoneyUtil.toBigint(MoneyUtil.add(MoneyUtil.subtract(r.goodsAmount, ctx.discountTotal), r.freightAmount), 'expectPay'),
      { discountTotal: ctx.discountTotal, freight: r.freightAmount },
    );

    // E5(v2)：全部优惠 <= 商品金额（运费不参与优惠），超出则账目不平
    if (ctx.discountTotal > r.goodsAmount) {
      throw new BusinessError('优惠总额超过商品金额', {
        code: ErrorCode.ORDER_AMOUNT_INVALID,
        data: { discountTotal: ctx.discountTotal, goodsAmount: r.goodsAmount },
      });
    }

    // E6：pay >= 0 且 pay >= freight（至少覆盖运费）
    if (r.payAmount < 0n || r.payAmount < r.freightAmount) {
      throw new BusinessError('应付金额不合法（为负或不足以覆盖运费）', {
        code: ErrorCode.ORDER_AMOUNT_INVALID,
      });
    }

    // E7(v2)：Σ payableAmount = goods - 全部优惠（行实付之和 = 商品金额 - 优惠）
    MoneyUtil.assertIdentity(
      'E7',
      sumItemPayable,
      MoneyUtil.toBigint(MoneyUtil.subtract(r.goodsAmount, ctx.discountTotal), 'expectSumPay'),
      { discountTotal: ctx.discountTotal },
    );

    // 综合：所有对外金额非负
    const allNonNegative = [
      r.goodsAmount,
      r.rowPromoDiscount,
      r.orderPromoDiscount,
      r.couponDiscount,
      r.pointDeductAmount,
      r.freightAmount,
      r.payAmount,
    ].every((v) => v >= 0n);
    if (!allNonNegative) {
      throw new BusinessError('存在负金额', { code: ErrorCode.ORDER_AMOUNT_INVALID });
    }
  }
}

/** 默认单例（供 Controller / 结算页消费） */
export const priceService = new PriceService();
export default priceService;
