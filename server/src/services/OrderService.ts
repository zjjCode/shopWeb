/**
 * @file server/src/services/OrderService.ts
 * @description 下单领域服务（事务 A）：前置校验 → 服务端价格重算 → 事务内冻结库存并建单
 * @module services
 * @see docs/04-flows.md F5（363-536 行）：完整时序、CAS 三手段、事务边界与回滚点、幂等保证
 * @see docs/02-architecture.md §5.11（恒等式 E1~E10）
 * @see prisma/schema.prisma（Order / OrderItem / OrderStatusLog / CartItem / Address 模型）
 * @author 软件开发团队
 * @created 2026-09-07
 *
 * 这是全系统最关键的事务。三条铁律（违反任意一条都会造成资金或库存事故）：
 *
 * 1. **金额服务端说了算**：绝不使用购物车里的 `priceSnapshot`，也绝不信任前端传来的任何金额。
 *    一律走 `PriceService.calculate` 用库内实时价重算（F5 阶段 2）。
 * 2. **不超卖**：库存扣减的权威判定是 DB 的 CAS（`WHERE available >= ? AND version = ?`），
 *    Redis 锁只削峰、不是权威。冻结必须**在事务内**执行并把 `tx` 传给 `StockService`，
 *    否则建单失败时已冻结的库存回不去（F5.3）。
 * 3. **不重复下单**：由外层幂等中间件（`@/middlewares/idempotency`）以
 *    `(scope, idempotency_key)` 唯一键抢占保证。业务失败时中间件会把记录置 FAILED 允许重试。
 *
 * 死锁预防：多 SKU 冻结严格按 `sku_id` **升序**处理，保证不同订单对同一批 SKU 的加锁顺序一致（F5.3）。
 *
 * ⚠️ 本期边界（T050 / T051 / T041）：
 * - **券（T041 已接入）**：`couponId` 可选；传入时在事务外解析券优惠（状态/过期/门槛/适用范围），
 *   事务 A 内分两步：`lockForOrder`（UNUSED→LOCKED，建单前、仅 orderNo）先于「冻结库存」（F5.5「先券后库存」），
 *   建单拿到 orderId 后再 `bindForOrder` 写券记录（与建单同事务）。库存冻结失败则整事务回滚、绝不产生待支付订单。
 * - **注册延迟关单 job**：T051 已接入 BullMQ `order-close` 队列（delay = expireAt - now，jobId = orderNo），
 *   注册失败仅 warn、不阻塞下单，靠 cron 兜底扫描补偿（F7.2 / F10）。
 */

import type { Prisma, PrismaClient } from '@prisma/client';
import {
  CancelReason,
  OrderStatus,
  OperatorType,
  PayStatus,
  ProductStatus,
  SkuStatus,
} from '@prisma/client';
import { config } from '@/config';
import { QUEUE_NAMES } from '@/config/constants';
import { BusinessError, ValidationError } from '@/core/errors';
import { ErrorCode } from '@/core/errors/errorCodes';
import { enqueue } from '@/core/queue';
import type { OrderCompletedEvent } from '@/core/eventBus';
import { emit } from '@/core/eventBus';
import { orderNo as generateOrderNo } from '@/core/idGenerator';
import { getPrisma } from '@/core/prisma';
import { withTransaction } from '@/core/transaction';
import { transition } from '@/services/OrderStateMachine';
import { CouponService, type ResolvedCoupon } from '@/services/CouponService';
import {
  FREIGHT_FREE_THRESHOLD_CENTS,
  PriceService,
  type PriceResult,
} from '@/services/PriceService';
import { StockService } from '@/services/StockService';

/** 本服务用到的 Prisma 委托（单测注入假实现时只需实现这些） */
type DbClient = Pick<PrismaClient, 'order' | 'orderItem' | 'orderStatusLog' | 'cartItem' | 'address'>;

/** 下单入参 */
export interface CreateOrderInput {
  /** 收货地址 ID（必须属于当前用户且未软删） */
  addressId: bigint;
  /** 参与结算的购物车条目 ID（必须是已勾选的） */
  cartItemIds: bigint[];
  /** 买家备注（可空） */
  buyerRemark?: string | null;
  /**
   * 优惠券 ID。**本期恒为 null**：券占用（UNUSED → LOCKED）需与建单同事务，
   * 待 T041 CouponService 就绪后补。
   */
  couponId?: bigint | null;
}

/** 下单结果（会写入幂等表的 response_snapshot，用于重复提交时回放） */
export interface CreateOrderResult {
  /** 订单号 */
  orderNo: string;
  /** 应付金额（分，bigint） */
  payAmount: bigint;
  /** 支付超时时间 */
  expireAt: Date;
}

/** 订单列表项中的订单行摘要（C 端「我的订单」首屏展示用） */
export interface OrderItemSummary {
  /** 商品名（下单时快照） */
  productName: string;
  /** 规格摘要（如「颜色:陨石黑 内存:256G」） */
  specDigest: string;
  /** 主图 URL */
  mainImage: string;
  /** 成交单价（分，bigint） */
  unitPrice: bigint;
  /** 数量 */
  quantity: number;
}

/** 订单列表项（C 端「我的订单」列表） */
export interface OrderSummary {
  /** 订单号 */
  orderNo: string;
  /** 订单状态 */
  status: OrderStatus;
  /** 应付金额（分，bigint） */
  payAmount: bigint;
  /** 订单行数量（= items.length） */
  itemCount: number;
  /** 首图（取首行的 mainImage，没有则为 null） */
  thumbnail: string | null;
  /** 下单时间 */
  createdAt: Date;
  /** 订单行摘要（取该订单全部订单行，通常 < 10） */
  items: OrderItemSummary[];
}

/** 订单列表返回（与 `sendPaged` 的 PageResult 对齐，但字段按领域语义命名） */
export interface OrderListResult {
  /** 当前页订单 */
  list: OrderSummary[];
  /** 总条数 */
  total: number;
  /** 当前页码 */
  page: number;
  /** 每页条数 */
  pageSize: number;
  /** 总页数（至少 1） */
  totalPages: number;
}

/** 订单详情中的订单行（含 payableAmount，对账/退款用） */
export interface OrderDetailItem {
  /** SKU 编码 */
  skuCode: string;
  /** 商品名（快照） */
  productName: string;
  /** 规格摘要 */
  specDigest: string;
  /** 主图 URL */
  mainImage: string;
  /** 成交单价（分，bigint） */
  unitPrice: bigint;
  /** 数量 */
  quantity: number;
  /** 本行实付（分，bigint，不含运费） */
  payableAmount: bigint;
}

/** 订单详情中的支付单摘要 */
export interface OrderPaymentSummary {
  /** 支付方式（可空：充值单等场景） */
  payMethod: string | null;
  /** 支付金额（分，bigint） */
  amount: bigint;
  /** 支付状态 */
  status: string;
  /** 支付成功时间（可空） */
  paidAt: Date | null;
}

/** 订单详情中的退款单摘要 */
export interface OrderRefundSummary {
  /** 退款单状态 */
  status: string;
  /** 退款金额（分，bigint） */
  amount: bigint;
  /** 退款类型（FULL / PARTIAL） */
  type: string;
}

/** 订单详情（C 端「订单详情」页） */
export interface OrderDetail {
  /** 订单号 */
  orderNo: string;
  /** 订单状态 */
  status: OrderStatus;
  /** 应付金额（分，bigint） */
  payAmount: bigint;
  /** 下单时间 */
  createdAt: Date;
  /** 订单行 */
  items: OrderDetailItem[];
  /** 关联支付单 */
  payments: OrderPaymentSummary[];
  /** 关联退款单 */
  refunds: OrderRefundSummary[];
}

/** 支付超时时长（分钟）：与 F5「expire_at = NOW() + 30min」一致 */
const PAY_TIMEOUT_MINUTES = 30;

/** 发货后自动确认收货天数（F10：auto_confirm_at = shippedAt + 15 天） */
const AUTO_CONFIRM_DAYS = 15;

/** 确认收货后售后期天数（F10：after_sale_expire_at = completedAt + 7 天） */
const AFTER_SALE_DAYS = 7;

/** 一天的毫秒数 */
const DAY_MS = 86_400_000;

/** 单 SKU 数量上限（与购物车校验一致） */
const MAX_QUANTITY_PER_SKU = 999;

/** 购物车条目连带查询（SKU → 商品，用于快照与在售校验） */
const CART_ITEM_INCLUDE = {
  sku: { include: { product: true } },
} as const;

/** 带类型的购物车条目行 */
type CartItemRow = {
  id: bigint;
  skuId: bigint;
  quantity: number;
  sku: {
    id: bigint;
    productId: bigint;
    skuCode: string;
    specDigest: string;
    imageUrl: string | null;
    price: bigint;
    originalPrice: bigint | null;
    status: SkuStatus;
    product: {
      id: bigint;
      name: string;
      mainImage: string;
      status: ProductStatus;
    } | null;
  } | null;
};

/**
 * 下单服务。
 *
 * @description 三个依赖均可注入，单测用假实现打桩验证事务边界与冻结顺序。
 */
export class OrderService {
  /** Prisma 客户端 */
  private readonly prisma: DbClient;
  /** 库存服务（冻结用） */
  private readonly stockService: StockService;
  /** 计价服务（服务端重算用） */
  private readonly priceService: PriceService;
  /** 优惠券服务（下单占用 / 优惠计算，T041） */
  private readonly couponService: CouponService;

  /**
   * @param prisma Prisma 客户端，缺省取全局单例
   * @param stockService 库存服务，缺省新建
   * @param priceService 计价服务，缺省新建
   * @param couponService 优惠券服务，缺省新建
   */
  constructor(
    prisma: DbClient = getPrisma(),
    stockService: StockService = new StockService(),
    priceService: PriceService = new PriceService(),
    couponService: CouponService = new CouponService(),
  ) {
    this.prisma = prisma;
    this.stockService = stockService;
    this.priceService = priceService;
    this.couponService = couponService;
  }

  /**
   * 创建订单（事务 A）。
   *
   * @param userId 用户 ID
   * @param input 下单入参
   * @returns 订单号 / 应付金额 / 超时时间
   * @throws {BusinessError} 地址不存在（11001）、存在失效商品（30005）、数量非法（30002/30003）、
   *                         商品已下架（21001）、SKU 不可用（21002）、库存不足（50001/50002）、
   *                         金额恒等式不成立（31003）
   */
  async createOrder(userId: bigint, input: CreateOrderInput): Promise<CreateOrderResult> {
    // ---------- 阶段 1：前置校验（事务外，只读，失败无副作用）----------
    const address = await this.loadAddress(userId, input.addressId);
    const cartItems = await this.loadCartItems(userId, input.cartItemIds);
    this.assertItemsSellable(cartItems);

    // ---------- 阶段 2：服务端价格重算（事务外，绝不信任前端金额）----------
    const price = await this.priceService.calculate({
      items: cartItems.map((it) => ({ skuId: it.skuId, quantity: it.quantity })),
    });

    // 券优惠（事务外只读解析：状态/过期/门槛/适用范围；返回券优惠额，异常在事务外抛出无副作用）
    let resolvedCoupon: ResolvedCoupon | null = null;
    if (input.couponId != null && input.couponId > 0n) {
      const payableBySku = new Map(price.items.map((pi) => [pi.skuId.toString(), pi.payableAmount]));
      const couponItems = cartItems.map((it) => ({
        skuId: it.skuId,
        productId: it.sku?.product?.id ?? 0n,
        payableAmount: payableBySku.get(it.skuId.toString()) ?? 0n,
      }));
      resolvedCoupon = await this.couponService.resolveForOrder(userId, input.couponId, couponItems);
    }
    // 含券最终价：应付 = 重算应付 - 券优惠（恒等式 E1 已含 couponDiscount）
    const orderPrice: PriceResult = {
      ...price,
      items: price.items.map((it) => ({ ...it })),
      couponDiscount: resolvedCoupon?.discountAmount ?? 0n,
      payAmount: price.payAmount - (resolvedCoupon?.discountAmount ?? 0n),
    };

    // 券优惠按行实付比例分摊到订单行（保证 E7：Σ行实付 + 运费 == 应付，且行级金额可独立对账/退款）。
    // 必须在 resolveForOrder 之后（门槛基于促销后金额，与券分摊无关）、assertAmountIdentity 之前。
    if (resolvedCoupon !== null && orderPrice.couponDiscount > 0n) {
      this.allocateCoupon(orderPrice.items, orderPrice.couponDiscount);
    }

    // 重算后立刻断言恒等式，避免把错误金额带进事务（F5 阶段 2 的 alt 分支）
    this.assertAmountIdentity(orderPrice);

    // ---------- 阶段 3：事务 A ----------
    const orderNo = generateOrderNo();
    const expireAt = new Date(Date.now() + PAY_TIMEOUT_MINUTES * 60 * 1000);

    // 按 sku_id 升序冻结：固定加锁顺序，防多订单并发下的死锁（F5.3）
    const orderedItems = [...cartItems].sort((a, b) => (a.skuId < b.skuId ? -1 : a.skuId > b.skuId ? 1 : 0));

    await withTransaction(
      async (tx) => {
        // 1) 锁券行（先券后库存，F5.5：必须在冻结库存之前、建单之前；无券则跳过）
        //    仅 UNUSED→LOCKED + 轨迹，此时尚无 orderId，故不写 order_coupon_records。
        //    锁券失败（并发占用 / 非本人）直接抛错，后续冻结与建单都不会执行，事务整体回滚。
        if (resolvedCoupon !== null) {
          await this.couponService.lockForOrder(
            resolvedCoupon.couponId,
            userId,
            { orderNo, discountAmount: resolvedCoupon.discountAmount },
            tx,
          );
        }

        // 2) 冻结库存（在事务内，tx 必须传下去；按 sku_id 升序，防并发死锁 F5.3）。
        //    必须先于建单：库存不足时冻结抛错，建单/锁券随事务回滚，绝不留「没库存却待支付」的订单（资金铁律）。
        for (const item of orderedItems) {
          // eslint-disable-next-line no-await-in-loop -- 顺序敏感：必须按 sku_id 升序串行，并行会破坏加锁顺序
          await this.stockService.freeze(
            {
              skuId: item.skuId,
              qty: item.quantity,
              bizNo: orderNo,
              operatorType: OperatorType.USER,
              operatorId: userId,
              idempotencyKey: null,
            },
            tx,
          );
        }

        // 3) 建单（地址在此刻固化为快照，之后删改地址不影响历史订单；金额含券优惠）
        const order = await tx.order.create({
          data: {
            orderNo,
            userId,
            status: OrderStatus.PENDING_PAYMENT,
            goodsAmount: orderPrice.goodsAmount,
            freightAmount: orderPrice.freightAmount,
            rowPromoDiscount: orderPrice.rowPromoDiscount,
            orderPromoDiscount: orderPrice.orderPromoDiscount,
            couponDiscount: orderPrice.couponDiscount,
            pointDeductAmount: orderPrice.pointDeductAmount,
            payAmount: orderPrice.payAmount,
            freeThreshold: FREIGHT_FREE_THRESHOLD_CENTS,
            receiverName: address.receiverName,
            receiverPhone: address.phone,
            receiverProvince: address.provinceName,
            receiverCity: address.cityName,
            receiverDistrict: address.districtName,
            receiverAddress: address.detailAddress,
            addressTag: address.tag,
            buyerRemark: input.buyerRemark ?? null,
            expireAt,
          },
        });

        // 4) 绑定券记录（建单后才有 orderId，与建单同事务；无券则跳过）
        if (resolvedCoupon !== null) {
          await this.couponService.bindForOrder(
            resolvedCoupon.couponId,
            userId,
            { orderId: order.id, orderNo, discountAmount: resolvedCoupon.discountAmount },
            tx,
          );
        }

        // 5) 订单行：按 PriceService 返回的行明细写快照与分摊结果
        const priceBySku = new Map(orderPrice.items.map((pi) => [pi.skuId.toString(), pi]));
        for (const item of cartItems) {
          const row = priceBySku.get(item.skuId.toString());
          if (row === undefined || item.sku === null || item.sku.product === null) {
            // 理论上不可达：阶段 1 已校验过可卖性，阶段 2 也必然产出对应行
            throw new BusinessError('订单行数据缺失，请重试', {
              code: ErrorCode.CART_HAS_INVALID_ITEMS,
              httpStatus: 409,
            });
          }
          // eslint-disable-next-line no-await-in-loop -- 行数少且需保持与购物车一致的顺序
          await tx.orderItem.create({
            data: {
              orderId: order.id,
              productId: item.sku.productId,
              skuId: item.skuId,
              skuCode: item.sku.skuCode,
              productName: item.sku.product.name,
              specDigest: item.sku.specDigest,
              mainImage: item.sku.imageUrl ?? item.sku.product.mainImage,
              unitPrice: row.unitPrice,
              originalPrice: item.sku.originalPrice,
              quantity: row.quantity,
              goodsAmount: row.goodsAmount,
              promoDiscount: row.promoDiscount,
              allocatedDiscount: row.allocatedDiscount,
              payableAmount: row.payableAmount,
            },
          });
        }

        // 6) 订单轨迹（只增不改不删，fromStatus 为 NULL 表示创建）
        await tx.orderStatusLog.create({
          data: {
            orderId: order.id,
            orderNo,
            fromStatus: null,
            toStatus: OrderStatus.PENDING_PAYMENT,
            operatorType: OperatorType.USER,
            operatorId: userId,
          },
        });

        // 7) 清理已结算的购物车条目（带 userId 防越权）
        await tx.cartItem.deleteMany({
          where: { id: { in: cartItems.map((it) => it.id) }, userId },
        });
      },
      { label: 'order.create' },
    );

    // ---------- 阶段 4：事务提交后 ----------
    // 注册延迟关单 job（F10 触发方式 A）：delay = expireAt - now，jobId = orderNo 天然去重。
    // 投递失败仅 warn 不抛错（不阻塞下单），靠 cron 兜底扫描补偿（F7.2 / F10）。
    if (config.env !== 'test') {
      const delayMs = Math.max(0, expireAt.getTime() - Date.now());
      void enqueue(QUEUE_NAMES.ORDER_CLOSE, 'closeTimeoutOrder', { orderNo }, { jobId: orderNo, delayMs });
    }

    return { orderNo, payAmount: orderPrice.payAmount, expireAt };
  }

  // ==========================================================================
  // 取消 / 超时关单（F8 / F10）
  // ==========================================================================

  /**
   * 超时关单（系统触发）：PENDING_PAYMENT → CANCELLED（F10）。
   *
   * 同事务副作用：**释放冻结库存**（`frozen → available`，ORDER_RELEASE）+ **解冻券**
   * （`LOCKED → UNUSED`，`CouponService.releaseByOrderNo`，T041）+ **关闭待支付支付单**
   * （若有；下单即支付场景下此时通常尚无支付单）。**无资金流水**。
   *
   * 幂等保障（F7.2 / F10）：
   * - 进入事务前先 `WHERE status='PENDING_PAYMENT'` 预筛，已支付/已取消/已关单的直接跳过；
   * - 事务内状态更新仍带 `WHERE status='PENDING_PAYMENT'`，`affectedRows = 0` 视为并发已变、幂等跳过，
   *   绝不会重复释放库存。
   *
   * @param orderNo 订单号
   * @returns `{ skipped: true }` 表示订单不存在或已不在待支付态（幂等跳过）
   */
  async closeByTimeout(orderNo: string): Promise<{ skipped: boolean }> {
    const order = await this.prisma.order.findFirst({
      where: { orderNo },
      select: { id: true, status: true },
    });
    if (order === null || order.status !== OrderStatus.PENDING_PAYMENT) {
      return { skipped: true };
    }

    const affected = await withTransaction(
      async (tx) => {
        const n = await transition(tx, {
          orderId: order.id,
          orderNo,
          fromStatus: OrderStatus.PENDING_PAYMENT,
          toStatus: OrderStatus.CANCELLED,
          operatorType: OperatorType.SYSTEM,
          operatorId: 0n,
          reason: CancelReason.TIMEOUT,
          extraData: { cancelReason: CancelReason.TIMEOUT, cancelledAt: new Date() },
        });
        if (n === 0) {
          return 0;
        }
        await this.releaseFrozenStock(tx, order.id, orderNo, OperatorType.SYSTEM, 0n, CancelReason.TIMEOUT);
        await this.closePendingPayments(tx, order.id);
        // 解冻被占用的券（T041：下单占用 UNUSED→LOCKED，关单需退回 UNUSED；无券记录/已解冻均幂等跳过）
        await this.couponService.releaseByOrderNo(orderNo, tx);
        return n;
      },
      { label: 'order.closeTimeout' },
    );

    return { skipped: affected === 0 };
  }

  // ==========================================================================
  // 发货 / 确认收货 / 自动确认（F10）
  // ==========================================================================

  /**
   * 管理员发货（F10 ①）：PAID → SHIPPED。
   *
   * @description 写入物流公司编码/名称/运单号 + `autoConfirmAt = shippedAt + 15 天`；
   * 仅 `PAID` 可发货（非 PAID 抛 31002），订单不存在抛 31001。
   * 事务提交后 best-effort 投递延迟自动确认 job（delay = 15 天，jobId = orderNo 去重），
   * 投递失败仅 warn（不阻塞发货），靠 cron 兜底扫描补偿（F7.2 / F10）。
   * @param adminId 管理员 ID
   * @param orderNo 订单号
   * @param dto 物流信息（companyCode / companyName / trackingNo / remark）
   * @throws {BusinessError} 31001 订单不存在；31002 状态不允许发货
   */
  async ship(
    adminId: bigint,
    orderNo: string,
    dto: { companyCode: string; companyName: string; trackingNo: string; remark?: string | null },
  ): Promise<void> {
    const order = await this.prisma.order.findFirst({
      where: { orderNo },
      select: { id: true, status: true },
    });
    if (order === null) {
      throw new BusinessError('订单不存在', { code: ErrorCode.ORDER_NOT_FOUND, httpStatus: 404 });
    }
    if (order.status !== OrderStatus.PAID) {
      throw new BusinessError('仅已支付订单可发货', {
        code: ErrorCode.ORDER_STATUS_INVALID,
        httpStatus: 409,
      });
    }

    const shippedAt = new Date();
    const autoConfirmAt = new Date(shippedAt.getTime() + AUTO_CONFIRM_DAYS * DAY_MS);

    const affected = await withTransaction(
      async (tx) => {
        const n = await transition(tx, {
          orderId: order.id,
          orderNo,
          fromStatus: OrderStatus.PAID,
          toStatus: OrderStatus.SHIPPED,
          operatorType: OperatorType.ADMIN,
          operatorId: adminId,
          reason: dto.remark ?? null,
          logExtra: { logisticsNo: dto.trackingNo },
          extraData: {
            shippedAt,
            logisticsCompanyCode: dto.companyCode,
            logisticsCompanyName: dto.companyName,
            logisticsNo: dto.trackingNo,
            autoConfirmAt,
          },
        });
        return n;
      },
      { label: 'order.ship' },
    );

    if (affected === 0) {
      // 并发已变（极端情况）：幂等跳过，不二次投递
      return;
    }

    // 事务提交后：注册延迟自动确认 job（F10 触发方式 A）
    if (config.env !== 'test') {
      const delayMs = Math.max(0, autoConfirmAt.getTime() - Date.now());
      void enqueue(QUEUE_NAMES.ORDER_AUTO_CONFIRM, 'autoConfirmReceipt', { orderNo }, { jobId: orderNo, delayMs });
    }
  }

  /**
   * 用户确认收货（F10 ③）：SHIPPED → COMPLETED。
   *
   * @description 完成后 `afterSaleExpireAt = completedAt + 7 天`（售后期）。
   * 越权防护：`where` 必须带 `userId`，越权或缺单统一 31001；仅 `SHIPPED` 可确认（否则 31002）。
   * 事务提交后 `eventBus.emit('order.completed')` —— 一期为空监听器（二阶段在此发放积分，见 `02-architecture.md` §8）。
   * @param userId 用户 ID（只从 `req.auth` 取，绝不从 body 读）
   * @param orderNo 订单号
   * @throws {BusinessError} 31001 订单不存在/不属于该用户；31002 状态不允许确认收货
   */
  async confirmReceipt(userId: bigint, orderNo: string): Promise<void> {
    const order = await this.prisma.order.findFirst({
      where: { orderNo, userId },
      select: { id: true, status: true, userId: true, payAmount: true },
    });
    if (order === null) {
      throw new BusinessError('订单不存在', { code: ErrorCode.ORDER_NOT_FOUND, httpStatus: 404 });
    }
    if (order.status !== OrderStatus.SHIPPED) {
      throw new BusinessError('仅已发货订单可确认收货', {
        code: ErrorCode.ORDER_STATUS_INVALID,
        httpStatus: 409,
      });
    }

    const completedAt = new Date();
    const afterSaleExpireAt = new Date(completedAt.getTime() + AFTER_SALE_DAYS * DAY_MS);

    const affected = await withTransaction(
      async (tx) => {
        const n = await transition(tx, {
          orderId: order.id,
          orderNo,
          fromStatus: OrderStatus.SHIPPED,
          toStatus: OrderStatus.COMPLETED,
          operatorType: OperatorType.USER,
          operatorId: userId,
          extraData: { completedAt, afterSaleExpireAt },
        });
        return n;
      },
      { label: 'order.confirmReceipt' },
    );

    if (affected === 0) {
      return; // 并发已变，幂等跳过
    }

    // 事务提交后：积分发放钩子（一期空实现）
    const payload: OrderCompletedEvent = {
      orderId: Number(order.id),
      orderNo,
      userId: Number(order.userId),
      payAmount: Number(order.payAmount),
      completedAt,
    };
    emit('order.completed', payload);
  }

  /**
   * 系统自动确认收货（F10 ④）：SHIPPED → COMPLETED（SYSTEM，reason=AUTO_CONFIRM）。
   *
   * @description 由 BullMQ 延迟 job（发货时注册）或 cron 兜底扫描调用。
   * 无前置查询（靠条件更新 + `affectedRows` 幂等），已非 SHIPPED 的视为 skipped。
   * @param orderNo 订单号
   * @returns `{ skipped: true }` 表示订单不存在或已不在已发货态（幂等跳过）
   */
  async autoConfirm(orderNo: string): Promise<{ skipped: boolean }> {
    const order = await this.prisma.order.findFirst({
      where: { orderNo },
      select: { id: true, status: true },
    });
    if (order === null || order.status !== OrderStatus.SHIPPED) {
      return { skipped: true };
    }

    const completedAt = new Date();
    const afterSaleExpireAt = new Date(completedAt.getTime() + AFTER_SALE_DAYS * DAY_MS);

    const affected = await withTransaction(
      async (tx) => {
        const n = await transition(tx, {
          orderId: order.id,
          orderNo,
          fromStatus: OrderStatus.SHIPPED,
          toStatus: OrderStatus.COMPLETED,
          operatorType: OperatorType.SYSTEM,
          operatorId: 0n,
          reason: 'AUTO_CONFIRM',
          extraData: { completedAt, afterSaleExpireAt },
        });
        // 自动确认不发放积分钩子（仅用户主动确认走积分，设计约定）；如二阶段需统一，可在此补 emit
        return n;
      },
      { label: 'order.autoConfirm' },
    );

    return { skipped: affected === 0 };
  }

  /**
   * 扫描「已发货且超过自动确认时间」的订单（F7.2 / F10 兜底扫描条件）。
   *
   * @description `WHERE status='SHIPPED' AND auto_confirm_at < NOW()`，走 `idx_status_autoconfirm` 索引；
   * 按 `id` 升序分页。`LIMIT` 由调用方传入（默认 500）。
   * @param limit 单批上限
  /**
   * 查询当前用户的订单列表（C 端「我的订单」）。
   *
   * @description 越权防护：查询 `where` 强制带 `userId`，软删（`deletedAt`）订单不返回；
   * `status` 可选，传了则按状态过滤（枚举值已由校验层保证合法）。
   * 排序：下单时间倒序、主键倒序——保证分页稳定，避免同毫秒订单乱序翻页。
   * 列表项只取首行主图作缩略图，订单行全量返回（通常 < 10）以满足首屏展示。
   * @param userId 用户 ID（只从 `req.auth` 取，绝不从 body 读）
   * @param params 过滤与分页参数（status 可选；page/pageSize 已由 `pagination()` 归一化）
   * @returns 当前页订单摘要 + 总条数 + 总页数
   */
  async listOrders(
    userId: bigint,
    params: { status?: OrderStatus; page: number; pageSize: number },
  ): Promise<OrderListResult> {
    const { status, page, pageSize } = params;
    const where: Prisma.OrderWhereInput = {
      userId,
      deletedAt: null,
      ...(status ? { status } : {}),
    };
    const orderBy: Prisma.OrderOrderByWithRelationInput = { createdAt: 'desc', id: 'desc' };

    const [total, rows] = await Promise.all([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({
        where,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          items: {
            orderBy: { id: 'asc' },
            select: {
              productName: true,
              specDigest: true,
              mainImage: true,
              unitPrice: true,
              quantity: true,
            },
          },
        },
      }),
    ]);

    const list: OrderSummary[] = rows.map((order) => {
      const items: OrderItemSummary[] = order.items.map((item) => ({
        productName: item.productName,
        specDigest: item.specDigest,
        mainImage: item.mainImage,
        unitPrice: item.unitPrice,
        quantity: item.quantity,
      }));
      return {
        orderNo: order.orderNo,
        status: order.status,
        payAmount: order.payAmount,
        itemCount: items.length,
        thumbnail: items[0]?.mainImage ?? null,
        createdAt: order.createdAt,
        items,
      };
    });

    return {
      list,
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  }

  /**
   * 查询订单详情（C 端「订单详情」页）。
   *
   * @description 越权防护：查询 `where` 强制带 `userId` + 软删过滤，越权或缺单统一抛 31001
   * （与列表一致，不暴露订单是否存在）。关联支付单、退款单一并查出，避免前端多次往返。
   * @param userId 用户 ID（只从 `req.auth` 取）
   * @param orderNo 订单号
   * @returns 订单详情（含订单行、支付单、退款单）
   * @throws {BusinessError} 31001 订单不存在 / 不属于该用户
   */
  async getOrderDetail(userId: bigint, orderNo: string): Promise<OrderDetail> {
    const order = await this.prisma.order.findFirst({
      where: { orderNo, userId, deletedAt: null },
      include: {
        items: {
          orderBy: { id: 'asc' },
          select: {
            skuCode: true,
            productName: true,
            specDigest: true,
            mainImage: true,
            unitPrice: true,
            quantity: true,
            payableAmount: true,
          },
        },
        payments: {
          select: {
            channel: true,
            amount: true,
            status: true,
            paidAt: true,
          },
        },
        refunds: {
          select: {
            status: true,
            amount: true,
            type: true,
          },
        },
      },
    });

    if (!order) {
      throw new BusinessError('订单不存在', { code: ErrorCode.ORDER_NOT_FOUND, httpStatus: 404 });
    }

    const items: OrderDetailItem[] = order.items.map((item) => ({
      skuCode: item.skuCode,
      productName: item.productName,
      specDigest: item.specDigest,
      mainImage: item.mainImage,
      unitPrice: item.unitPrice,
      quantity: item.quantity,
      payableAmount: item.payableAmount,
    }));

    const payments: OrderPaymentSummary[] = order.payments.map((payment) => ({
      payMethod: payment.channel,
      amount: payment.amount,
      status: payment.status,
      paidAt: payment.paidAt,
    }));

    const refunds: OrderRefundSummary[] = order.refunds.map((refund) => ({
      status: refund.status,
      amount: refund.amount,
      type: refund.type,
    }));

    return {
      orderNo: order.orderNo,
      status: order.status,
      payAmount: order.payAmount,
      createdAt: order.createdAt,
      items,
      payments,
      refunds,
    };
  }

  /**
   * 待自动确认收货扫描（定时任务调用）。
   *
   * @returns 待自动确认的订单号列表
   */
  async scanReceivableOrders(limit: number = 500): Promise<string[]> {
    const rows = await this.prisma.order.findMany({
      where: {
        status: OrderStatus.SHIPPED,
        autoConfirmAt: { lt: new Date() },
      },
      select: { orderNo: true },
      orderBy: { id: 'asc' },
      take: limit,
    });
    return rows.map((row) => row.orderNo);
  }

  /**
   * 用户取消「待支付」订单（F8 路径 1）。
   *
   * @description 越权防护：查询 `where` 必须带 `userId`，越权或缺单统一返回 31001（不暴露订单是否存在）。
   * 本期仅允许 `PENDING_PAYMENT` 取消——已支付取消必须走退款流程（F9），留待后续任务。
   * @param userId 用户 ID（只从 `req.auth` 取，绝不从 body 读）
   * @param orderNo 订单号
   * @param reason 取消原因（可空）
   * @throws {BusinessError} 31001 订单不存在/不属于该用户；31002 状态不允许取消
   */
  async cancelByUser(userId: bigint, orderNo: string, reason?: string | null): Promise<void> {
    await this.cancel({
      orderNo,
      requireUserId: userId,
      operatorType: OperatorType.USER,
      operatorId: userId,
      cancelReason: CancelReason.USER_CANCEL,
      reason,
    });
  }

  /**
   * 管理员取消「待支付」订单（F8 路径 3 的子集）。
   *
   * @description 本期仅允许 `PENDING_PAYMENT` 取消（PAID/SHIPPED 取消需触发退款，见 F9，留待后续任务）。
   * @param adminId 管理员 ID
   * @param orderNo 订单号
   * @param reason 取消原因（可空）
   * @throws {BusinessError} 31001 订单不存在；31002 状态不允许取消
   */
  async cancelByAdmin(adminId: bigint, orderNo: string, reason?: string | null): Promise<void> {
    await this.cancel({
      orderNo,
      requireUserId: null,
      operatorType: OperatorType.ADMIN,
      operatorId: adminId,
      cancelReason: CancelReason.ADMIN_CANCEL,
      reason,
    });
  }

  /**
   * 取消的内部实现（PENDING_PAYMENT → CANCELLED）。
   *
   * @description 与 `closeByTimeout` 共用同一套「条件更新 + 释放冻结 + 关闭待支付单」逻辑，
   * 仅操作人/原因不同。越权防护由 `requireUserId` 决定：`null` 表示不校验归属（管理员）。
   * @param params 取消参数
   * @throws {BusinessError} 31001 / 31002
   */
  private async cancel(params: {
    orderNo: string;
    requireUserId: bigint | null;
    operatorType: OperatorType;
    operatorId: bigint;
    cancelReason: CancelReason;
    reason?: string | null;
  }): Promise<void> {
    const where =
      params.requireUserId === null
        ? { orderNo: params.orderNo }
        : { orderNo: params.orderNo, userId: params.requireUserId };

    const order = await this.prisma.order.findFirst({
      where,
      select: { id: true, status: true },
    });
    if (order === null) {
      // 用户路径不暴露订单是否存在（越权防护）；复用 31001
      throw new BusinessError('订单不存在', { code: ErrorCode.ORDER_NOT_FOUND, httpStatus: 404 });
    }
    if (order.status !== OrderStatus.PENDING_PAYMENT) {
      // 本期仅支持「待支付」取消；已支付取消需走退款（F9），不在本任务范围
      throw new BusinessError('订单当前状态不允许取消', {
        code: ErrorCode.ORDER_STATUS_INVALID,
        httpStatus: 409,
      });
    }

    await withTransaction(
      async (tx) => {
        const n = await transition(tx, {
          orderId: order.id,
          orderNo: params.orderNo,
          fromStatus: OrderStatus.PENDING_PAYMENT,
          toStatus: OrderStatus.CANCELLED,
          operatorType: params.operatorType,
          operatorId: params.operatorId,
          reason: params.reason ?? params.cancelReason,
          extraData: {
            cancelReason: params.cancelReason,
            cancelledAt: new Date(),
          },
        });
        if (n === 0) {
          return; // 并发已变，幂等跳过
        }
        await this.releaseFrozenStock(
          tx,
          order.id,
          params.orderNo,
          params.operatorType,
          params.operatorId,
          params.cancelReason,
        );
        await this.closePendingPayments(tx, order.id);
        // 解冻被占用的券（T041：与关单同逻辑，LOCKED→UNUSED，幂等跳过）
        await this.couponService.releaseByOrderNo(params.orderNo, tx);
      },
      { label: 'order.cancel' },
    );
  }

  /**
   * 释放某订单的全部冻结库存（按 sku_id 升序，与冻结顺序一致，防死锁）。
   *
   * @param tx 事务客户端
   * @param orderId 订单主键
   * @param orderNo 订单号（写入 stock_logs.biz_no）
   * @param operatorType 操作人类型
   * @param operatorId 操作人 ID
   * @param reason 释放原因（TIMEOUT / USER_CANCEL / ADMIN_CANCEL）
   */
  private async releaseFrozenStock(
    tx: Prisma.TransactionClient,
    orderId: bigint,
    orderNo: string,
    operatorType: OperatorType,
    operatorId: bigint,
    reason: CancelReason,
  ): Promise<void> {
    const items = await tx.orderItem.findMany({
      where: { orderId },
      select: { skuId: true, quantity: true },
      orderBy: { skuId: 'asc' },
    });
    for (const it of items) {
      // eslint-disable-next-line no-await-in-loop -- 必须按 sku_id 升序串行，与冻结顺序一致
      await this.stockService.release(
        {
          skuId: it.skuId,
          qty: it.quantity,
          bizNo: orderNo,
          operatorType,
          operatorId,
          reason,
        },
        tx,
      );
    }
  }

  /**
   * 关闭订单关联、仍处待支付的支付单（F10：UPDATE payments SET status='CLOSED'）。
   *
   * @description 下单即支付模式下，关单时通常尚无支付单（影响 0 行，幂等无害）；
   * 若用户已发起支付但未完成，此处将其关闭，渠道侧超时后自动关闭。
   * @param tx 事务客户端
   * @param orderId 订单主键
   */
  private async closePendingPayments(
    tx: Prisma.TransactionClient,
    orderId: bigint,
  ): Promise<void> {
    await tx.payment.updateMany({
      where: { orderId, status: PayStatus.PENDING },
      data: { status: PayStatus.CLOSED, closedAt: new Date() },
    });
  }

  /**
   * 取收货地址并校验归属。
   *
   * @description `where` 必须同时带 `id` 与 `userId` 与 `deletedAt: null`——
   * 地址是私有数据，漏了 userId 就是「改一个 id 就能用别人地址下单」的越权漏洞。
   * @param userId 用户 ID
   * @param addressId 地址 ID
   * @returns 地址记录
   * @throws {BusinessError} 地址不存在或不属该用户（11001）
   */
  private async loadAddress(userId: bigint, addressId: bigint) {
    const address = await this.prisma.address.findFirst({
      where: { id: addressId, userId, deletedAt: null },
    });
    if (address === null) {
      throw new BusinessError('收货地址不存在', {
        code: ErrorCode.ADDRESS_NOT_FOUND,
        httpStatus: 404,
      });
    }
    return address;
  }

  /**
   * 取参与结算的购物车条目，并校验「请求条数 == 命中条数」。
   *
   * @description 只查 `selected = true` 且属该用户的条目。若返回的条数与请求 ID 数不一致，
   * 说明有条目已被删除、未勾选、或不属于当前用户——一律按「存在失效商品」拒绝，
   * 绝不静默少结算几件（否则用户会「付了钱但少收到货」）。
   * @param userId 用户 ID
   * @param cartItemIds 购物车条目 ID
   * @returns 条目行（含 SKU 与商品）
   * @throws {BusinessError} 存在失效商品（30005）
   */
  private async loadCartItems(userId: bigint, cartItemIds: bigint[]): Promise<CartItemRow[]> {
    if (cartItemIds.length === 0) {
      throw new ValidationError('请选择要结算的商品', {
        code: ErrorCode.CART_HAS_INVALID_ITEMS,
      });
    }

    const rows = await this.prisma.cartItem.findMany({
      where: { id: { in: cartItemIds }, userId, selected: true },
      include: CART_ITEM_INCLUDE,
    });

    if (rows.length !== cartItemIds.length) {
      throw new BusinessError('存在失效商品，请处理后结算', {
        code: ErrorCode.CART_HAS_INVALID_ITEMS,
        httpStatus: 409,
      });
    }

    return rows as unknown as CartItemRow[];
  }

  /**
   * 校验每个条目的可卖性：SKU 启用、商品在售、数量合法。
   *
   * @param items 购物车条目
   * @throws {BusinessError} 商品已下架（21001）/ SKU 不可用（21002）/ 数量非法（30002/30003）
   */
  private assertItemsSellable(items: CartItemRow[]): void {
    for (const item of items) {
      if (item.sku === null || item.sku.product === null) {
        throw new BusinessError('商品不存在或已下架', {
          code: ErrorCode.PRODUCT_NOT_FOUND,
          httpStatus: 404,
        });
      }
      if (item.sku.status !== SkuStatus.ENABLED) {
        throw new BusinessError('SKU 不存在', { code: ErrorCode.SKU_NOT_FOUND, httpStatus: 404 });
      }
      if (item.sku.product.status !== ProductStatus.ON_SALE) {
        throw new BusinessError('商品不存在或已下架', {
          code: ErrorCode.PRODUCT_NOT_FOUND,
          httpStatus: 404,
        });
      }
      if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
        throw new ValidationError('数量必须大于 0', { code: ErrorCode.CART_QUANTITY_INVALID });
      }
      if (item.quantity > MAX_QUANTITY_PER_SKU) {
        throw new BusinessError('单个 SKU 数量不可超过 999', {
          code: ErrorCode.CART_ITEM_QUANTITY_LIMIT,
          httpStatus: 409,
        });
      }
    }
  }

  /**
   * 将券优惠按比例分摊到各订单行（修改行实付与行已分摊）。
   *
   * @description 券是订单级优惠，但必须落到行上才能保持 E7（`Σ行实付 + 运费 == 应付`）成立，
   * 也便于后续按行对账 / 退款。`computeDiscount` 已保证券优惠 ≤ 促销后商品金额，故分摊无溢出；
   * 按比例取整的零头归末行吸收。
   * @param items 订单行（会被原地修改 payableAmount / allocatedDiscount）
   * @param couponDiscount 券优惠额（分）
   */
  private allocateCoupon(items: PriceResult['items'], couponDiscount: bigint): void {
    const totalPayable = items.reduce<bigint>((acc, it) => acc + it.payableAmount, 0n);
    if (totalPayable <= 0n) {
      return;
    }
    let remaining = couponDiscount;
    for (let i = 0; i < items.length; i++) {
      const it = items[i]!;
      // 末行吸收取整零头，保证 Σ分摊 == 券优惠
      const share = i === items.length - 1 ? remaining : (couponDiscount * it.payableAmount) / totalPayable;
      const applied = share > it.payableAmount ? it.payableAmount : share;
      it.payableAmount = it.payableAmount - applied;
      it.allocatedDiscount = it.allocatedDiscount + applied;
      remaining = remaining - applied;
    }
  }

  /**
   * 断言服务端重算结果的金额恒等式（F5 阶段 2）。
   *
   * @description 三条必须成立，任一条不成立说明计价引擎有 Bug，绝不能带进事务：
   * - E1：`应付 = 商品总额 - 行级促销 - 订单级促销 - 券 - 积分抵扣 + 运费`
   * - E7：`Σ 行实付 + 运费 == 应付`（运费不参与行分摊）
   * - 非负：任何折扣与运费都不得为负
   * @param price 计价结果
   * @throws {ValidationError} 金额校验失败（31003）
   */
  private assertAmountIdentity(price: PriceResult): void {
    const fail = (reason: string): never => {
      throw new ValidationError(`订单金额校验失败：${reason}`, {
        code: ErrorCode.ORDER_AMOUNT_INVALID,
      });
    };

    const negative =
      price.goodsAmount < 0n ||
      price.rowPromoDiscount < 0n ||
      price.orderPromoDiscount < 0n ||
      price.couponDiscount < 0n ||
      price.pointDeductAmount < 0n ||
      price.freightAmount < 0n ||
      price.payAmount < 0n;
    if (negative) {
      fail('金额出现负值');
    }

    // E1：应付 = 商品 - 各类优惠 + 运费（全程 bigint，不用浮点也不用 number）
    const expectedPay =
      price.goodsAmount -
      price.rowPromoDiscount -
      price.orderPromoDiscount -
      price.couponDiscount -
      price.pointDeductAmount +
      price.freightAmount;
    if (expectedPay !== price.payAmount) {
      fail(`应付金额与恒等式不符（期望 ${expectedPay}，实际 ${price.payAmount}）`);
    }

    // E7：行实付之和 + 运费 == 应付（运费不参与行分摊）
    // 这里用 bigint 原生加法而非 MoneyUtil.add：后者返回 number，与 bigint 不可比较，
    // 且分单位的金额在 bigint 下不存在精度与溢出问题。
    const sumPayable = price.items.reduce<bigint>((acc, it) => acc + it.payableAmount, 0n);
    if (sumPayable + price.freightAmount !== price.payAmount) {
      fail(`行实付合计 + 运费 != 应付（${sumPayable} + ${price.freightAmount} != ${price.payAmount}）`);
    }
  }
}

/** 默认单例（供 Controller 直接消费） */
export const orderService = new OrderService();
export default orderService;
