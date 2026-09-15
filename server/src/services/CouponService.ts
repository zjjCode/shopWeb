/**
 * @file server/src/services/CouponService.ts
 * @description 优惠券服务：领取 / 我的券列表 / 券优惠计算 / 下单占用 / 支付核销 / 取消解冻 / 退款返还
 * @module services
 * @see docs/04-flows.md F13（领取与使用）、F5.5（下单占用与优惠计算）、F13.2（状态机与事务绑定）
 * @see docs/03-database.md §3.8（券状态机表、券模型）
 * @see prisma/schema.prisma:1357（CouponTemplate）、:1435（Coupon）、:1477（CouponUseLog）、:1502（OrderCouponRecord）
 * @author 软件开发团队
 * @created 2026-09-14
 *
 * 券状态机（权威口径，见 enums.ts 注释：AVAILABLE/FROZEN 是文档笔误，代码中禁用）：
 *   — → UNUSED（领取，事务 J）
 *   UNUSED → LOCKED（下单占用，事务 A，与建单同事务）
 *   LOCKED → USED（支付成功核销，事务 B/B'）
 *   LOCKED → UNUSED（取消/超时关单/余额支付失败解冻，事务 D）
 *   USED → UNUSED（整单退款返还，事务 C/C'）
 *   UNUSED → EXPIRED（定时任务批量）
 *   任意 → INVALIDATED（运营作废）
 *
 * 事务红线（与 FundService 同铁律）：占用/核销/释放/返还四个写方法**必须接收 tx 且在调用方事务内执行**，
 * 漏传 → 外部事务回滚时券状态已变 = 一券多用 / 券钱不同步。这四个方法**不**自开事务，调用方必须已在
 * `withTransaction` 内。claim / listMy 是独立事务（各自自开）。
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import { getPrisma } from '@/core/prisma';
import { withTransaction } from '@/core/transaction';
import { BusinessError } from '@/core/errors/BusinessError';
import { ErrorCode } from '@/core/errors/errorCodes';
import { getErrorMeta } from '@/core/errors/errorCodes';
import {
  CouponStatus,
  CouponLogBizType,
  CouponType,
  CouponTemplateStatus,
  CouponValidType,
  OperatorType,
  ScopeType,
} from '@/constants/enums';
import { couponInstanceNo } from '@/core/idGenerator';

/** 本服务用到的 Prisma 委托（单测注入假实现时只需实现这些） */
export type CouponDbClient = Pick<
  PrismaClient,
  'coupon' | 'couponTemplate' | 'couponUseLog' | 'orderCouponRecord' | 'couponTemplateScope' | 'product'
>;

/** 事务客户端类型 */
export type CouponTxClient = Prisma.TransactionClient;

/** 一天的毫秒数 */
const DAY_MS = 86_400_000;

/** 领取结果 */
export interface ClaimCouponResult {
  /** 券实例编号 */
  couponNo: string;
  /** 券状态（恒 UNUSED） */
  status: CouponStatus;
  /** 过期时间 */
  expireAt: Date;
}

/** 我的优惠券摘要（列表返回） */
export interface MyCouponSummary {
  couponId: bigint;
  couponNo: string;
  templateId: bigint;
  templateName: string;
  type: CouponType;
  status: CouponStatus;
  /** 使用门槛（分） */
  thresholdAmount: bigint;
  /** 满减/无门槛券面额（分，可能为 null） */
  discountAmount: bigint | null;
  /** 折扣券折扣率（万分比，可能为 null） */
  discountRate: number | null;
  /** 折扣券封顶（分，可能为 null） */
  maxDiscount: bigint | null;
  /** 适用范围主类型 */
  scopeType: ScopeType;
  claimedAt: Date;
  expireAt: Date;
}

/** 列表筛选 */
export interface ListMyCouponsFilter {
  /** 按状态筛选（「我的优惠券」Tab）；不传返回全部 */
  status?: CouponStatus;
}

/** 下单锁券入参（建单前，仅 orderNo，尚无 orderId） */
export interface LockCouponInput {
  orderNo: string;
  /** 本单券优惠额（分，已分摊到行） */
  discountAmount: bigint;
}

/** 下单绑定券记录入参（建单后，需 orderId 关联） */
export interface BindCouponInput {
  orderId: bigint;
  orderNo: string;
  /** 本单券优惠额（分，已分摊到行） */
  discountAmount: bigint;
}

/** 下单商品行（用于券适用范围与门槛校验） */
export interface OrderCouponItem {
  skuId: bigint;
  productId: bigint;
  /** 行级促销后商品金额（分）= 行原价 - 行促销 - 订单级分摊 */
  payableAmount: bigint;
  /** 商品类目 ID（可选；CATEGORY 范围校验时若缺省则由 CouponService 反查） */
  categoryId?: bigint | null;
}

/** 订单可用券解析结果（供 OrderService 写入订单金额） */
export interface ResolvedCoupon {
  couponId: bigint;
  templateId: bigint;
  /** 计算出的本单券优惠额（分） */
  discountAmount: bigint;
}

/**
 * 优惠券服务。
 *
 * @description 领取/列表为独立事务；占用/核销/释放/返还必须随调用方事务（传 tx）。
 */
export class CouponService {
  private readonly prisma: CouponDbClient;

  constructor(prisma: CouponDbClient = getPrisma() as CouponDbClient) {
    this.prisma = prisma;
  }

  // ==========================================================================
  // 领取优惠券（事务 J，F13.1）
  // ==========================================================================

  /**
   * 领取优惠券。
   *
   * @description 校验模板可领取（CLAIMABLE）→ 限领 → CAS 防超发 → 写券实例(UNUSED) + 轨迹(CLAIM)。
   *   幂等由调用方（Controller）在 scope=COUPON_CLAIM / key={userId}:{templateNo} 抢占（T061 之外暂不强制）。
   * @param userId 用户 ID
   * @param templateNo 券模板编号
   * @returns 券实例编号 / 状态 / 过期时间
   * @throws {BusinessError} 模板不存在(12001) / 不可领取(12002) / 超限领(12003) / 已领完(12002)
   */
  async claim(userId: bigint, templateNo: string): Promise<ClaimCouponResult> {
    const template = await this.prisma.couponTemplate.findUnique({
      where: { templateNo },
    });
    if (template === null) {
      throw new BusinessError('优惠券不存在', {
        code: ErrorCode.COUPON_NOT_FOUND,
        httpStatus: getErrorMeta(ErrorCode.COUPON_NOT_FOUND).httpStatus,
      });
    }
    // 仅 CLAIMABLE 可领；未开始/已暂停/已结束一律不可领
    if (template.status !== CouponTemplateStatus.CLAIMABLE) {
      throw new BusinessError('优惠券暂不可领取', {
        code: ErrorCode.COUPON_SOLD_OUT,
        httpStatus: getErrorMeta(ErrorCode.COUPON_SOLD_OUT).httpStatus,
      });
    }

    // 限领校验：本用户已领取数量（含任意状态的券，防止领完 UNUSED 再领占额度）
    const claimedCount = await this.prisma.coupon.count({
      where: { templateId: template.id, userId },
    });
    if (claimedCount >= template.perLimit) {
      throw new BusinessError('已达该券每人限领上限', {
        code: ErrorCode.COUPON_LIMIT_EXCEEDED,
        httpStatus: getErrorMeta(ErrorCode.COUPON_LIMIT_EXCEEDED).httpStatus,
      });
    }

    const now = new Date();
    const expireAt = this.computeExpireAt(template.validType, template.validEnd, template.validDays, now);

    const couponNo = couponInstanceNo();
    await withTransaction(
      async (tx) => {
        const created = await tx.coupon.create({
          data: {
            couponNo,
            templateId: template.id,
            userId,
            status: CouponStatus.UNUSED,
            claimedAt: now,
            expireAt,
            source: 'CLAIM',
          },
        });

        // CAS 防超发：仅当 issuedCount < totalCount 才 +1；totalCount 为 null 表示不限量
        if (template.totalCount !== null) {
          const bumped = await tx.couponTemplate.updateMany({
            where: { id: template.id, issuedCount: { lt: template.totalCount } },
            data: { issuedCount: { increment: 1 } },
          });
          if (bumped.count === 0) {
            // 并发下被别人领完：回滚（withTransaction 会 rollback），抛已领完
            throw new BusinessError('优惠券已被领完', {
              code: ErrorCode.COUPON_SOLD_OUT,
              httpStatus: getErrorMeta(ErrorCode.COUPON_SOLD_OUT).httpStatus,
            });
          }
        }

        await tx.couponUseLog.create({
          data: {
            couponId: created.id,
            couponNo,
            fromStatus: null,
            toStatus: CouponStatus.UNUSED,
            bizType: CouponLogBizType.CLAIM,
            orderNo: null,
            refundNo: null,
            operatorType: OperatorType.USER,
            operatorId: userId,
            remark: `领取模板 ${template.templateNo}`,
          },
        });

        return created.id;
      },
      { label: 'coupon.claim' },
    );

    return { couponNo, status: CouponStatus.UNUSED, expireAt };
  }

  // ==========================================================================
  // 我的优惠券列表
  // ==========================================================================

  /**
   * 查询当前用户的优惠券列表（按状态 Tab + 有效期升序）。
   *
   * @param userId 用户 ID
   * @param filter 状态筛选（可空）
   * @returns 券摘要数组
   */
  async listMy(userId: bigint, filter?: ListMyCouponsFilter): Promise<MyCouponSummary[]> {
    const rows = await this.prisma.coupon.findMany({
      where: { userId, ...(filter?.status !== undefined ? { status: filter.status } : {}) },
      orderBy: [{ expireAt: 'asc' }],
      include: { template: true },
    });

    return rows.map((row) => ({
      couponId: row.id,
      couponNo: row.couponNo,
      templateId: row.templateId,
      templateName: row.template.name,
      type: row.template.type,
      status: row.status,
      thresholdAmount: row.template.thresholdAmount,
      discountAmount: row.template.discountAmount,
      discountRate: row.template.discountRate,
      maxDiscount: row.template.maxDiscount,
      scopeType: row.template.scopeType,
      claimedAt: row.claimedAt,
      expireAt: row.expireAt,
    }));
  }

  // ==========================================================================
  // 券优惠计算与校验（供下单编排，事务外只读）
  // ==========================================================================

  /**
   * 计算券优惠额（分）。
   *
   * @description 门槛基于**促销后商品金额**（Q-B14）：满减/折扣券要求 promoGoodsAmount ≥ thresholdAmount。
   *   折扣券：discount = min(promoGoodsAmount × rate / 10000, maxDiscount)，且不超过 promoGoodsAmount。
   * @param template 券模板（含 type / thresholdAmount / discountAmount / discountRate / maxDiscount）
   * @param promoGoodsAmount 促销后商品金额（分，= 订单商品金额 - 行促销 - 订单级优惠）
   * @returns 券优惠额（分，恒 ≥ 0，且 ≤ promoGoodsAmount）
   */
  computeDiscount(
    template: {
      type: CouponType;
      thresholdAmount: bigint;
      discountAmount: bigint | null;
      discountRate: number | null;
      maxDiscount: bigint | null;
    },
    promoGoodsAmount: bigint,
  ): bigint {
    if (template.type === CouponType.DISCOUNT) {
      const rate = BigInt(template.discountRate ?? 0);
      const raw = (promoGoodsAmount * rate) / 10000n;
      const capped = template.maxDiscount !== null ? (raw < template.maxDiscount ? raw : template.maxDiscount) : raw;
      return capped < 0n ? 0n : capped > promoGoodsAmount ? promoGoodsAmount : capped;
    }
    // FULL_REDUCE / NO_THRESHOLD 直接取面额（NO_THRESHOLD 的 thresholdAmount 恒 0）
    const amount = template.discountAmount ?? 0n;
    return amount > promoGoodsAmount ? promoGoodsAmount : amount < 0n ? 0n : amount;
  }

  /**
   * 校验并解析订单可用券（事务外只读，下单前置）。
   *
   * @description 校验：券存在且归属当前用户 → 状态必须为 UNUSED → 未过期 → 门槛满足（promoGoodsAmount ≥ threshold）
   *   → 适用范围命中（按 scopeType 校验商品/类目）。返回券优惠额供 OrderService 写入订单。
   * @param userId 用户 ID
   * @param couponId 券实例 ID
   * @param items 下单商品行（含促销后 payableAmount 与商品/类目 ID）
   * @returns 解析结果（券 ID / 模板 ID / 优惠额）
   * @throws {BusinessError} 券不存在/已用/被占用/过期/作废/门槛未达/不适用
   */
  async resolveForOrder(
    userId: bigint,
    couponId: bigint,
    items: OrderCouponItem[],
  ): Promise<ResolvedCoupon> {
    const coupon = await this.prisma.coupon.findUnique({
      where: { id: couponId },
      include: { template: true },
    });
    if (coupon === null) {
      throw new BusinessError('优惠券不存在', {
        code: ErrorCode.COUPON_NOT_FOUND,
        httpStatus: getErrorMeta(ErrorCode.COUPON_NOT_FOUND).httpStatus,
      });
    }
    if (coupon.userId !== userId) {
      throw new BusinessError('优惠券不存在', {
        code: ErrorCode.COUPON_NOT_FOUND,
        httpStatus: getErrorMeta(ErrorCode.COUPON_NOT_FOUND).httpStatus,
      });
    }

    // 状态校验
    switch (coupon.status) {
      case CouponStatus.USED:
        throw new BusinessError('优惠券已使用', {
          code: ErrorCode.COUPON_USED,
          httpStatus: getErrorMeta(ErrorCode.COUPON_USED).httpStatus,
        });
      case CouponStatus.LOCKED:
        throw new BusinessError('优惠券正被其他订单占用', {
          code: ErrorCode.COUPON_FROZEN,
          httpStatus: getErrorMeta(ErrorCode.COUPON_FROZEN).httpStatus,
        });
      case CouponStatus.EXPIRED:
        throw new BusinessError('优惠券已过期', {
          code: ErrorCode.COUPON_EXPIRED,
          httpStatus: getErrorMeta(ErrorCode.COUPON_EXPIRED).httpStatus,
        });
      case CouponStatus.INVALIDATED:
        throw new BusinessError('优惠券已作废', {
          code: ErrorCode.COUPON_INVALIDATED,
          httpStatus: getErrorMeta(ErrorCode.COUPON_INVALIDATED).httpStatus,
        });
      case CouponStatus.UNUSED:
        break;
      default:
        throw new BusinessError('优惠券状态异常', {
          code: ErrorCode.COUPON_NOT_FOUND,
          httpStatus: getErrorMeta(ErrorCode.COUPON_NOT_FOUND).httpStatus,
        });
    }

    // 过期校验
    if (coupon.expireAt.getTime() <= Date.now()) {
      throw new BusinessError('优惠券已过期', {
        code: ErrorCode.COUPON_EXPIRED,
        httpStatus: getErrorMeta(ErrorCode.COUPON_EXPIRED).httpStatus,
      });
    }

    const promoGoodsAmount = items.reduce((sum, it) => sum + it.payableAmount, 0n);
    const discount = this.computeDiscount(coupon.template, promoGoodsAmount);

    // 门槛校验（满减/折扣券 thresholdAmount > 0）
    if (coupon.template.thresholdAmount > 0n && promoGoodsAmount < coupon.template.thresholdAmount) {
      throw new BusinessError('订单金额未达该券使用门槛', {
        code: ErrorCode.COUPON_THRESHOLD_NOT_MET,
        httpStatus: getErrorMeta(ErrorCode.COUPON_THRESHOLD_NOT_MET).httpStatus,
      });
    }

    // 适用范围校验
    const applicable = await this.isApplicable(coupon.template.id, coupon.template.scopeType, items);
    if (!applicable) {
      throw new BusinessError('该券不适用于订单内商品', {
        code: ErrorCode.COUPON_NOT_APPLICABLE,
        httpStatus: getErrorMeta(ErrorCode.COUPON_NOT_APPLICABLE).httpStatus,
      });
    }

    return { couponId: coupon.id, templateId: coupon.templateId, discountAmount: discount };
  }

  // ==========================================================================
  // 下单占用（事务 A，UNUSED → LOCKED）—— 必传 tx，拆为「锁券行」+「绑定券记录」两步
  // ==========================================================================

  /**
   * 下单锁券行（事务 A 第一步，建单前，仅用 orderNo）。
   *
   * @description 条件更新 `UNUSED → LOCKED WHERE id AND userId AND status='UNUSED'`；affectedRows=0 即被并发占用 → 12007。
   *   同时写 coupon_use_logs(LOCK)。**不写 order_coupon_records**（此时尚无 orderId）。
   *   顺序上必须先于「冻结库存」（F5.5「先券后库存」），再先于「建单」——
   *   这样「库存冻结失败」时事务回滚不会留下待支付订单（资金安全铁律）。
   * @param couponId 券实例 ID
   * @param userId 用户 ID
   * @param input 锁券入参（orderNo / discountAmount）
   * @param tx 事务客户端（必传，不可缺省）
   * @throws {BusinessError} 并发占用(12007) / 券不存在(12001)
   */
  async lockForOrder(
    couponId: bigint,
    userId: bigint,
    input: LockCouponInput,
    tx: CouponTxClient,
  ): Promise<void> {
    const coupon = await tx.coupon.findUnique({
      where: { id: couponId },
      include: { template: true },
    });
    if (coupon === null || coupon.userId !== userId) {
      throw new BusinessError('优惠券不存在', {
        code: ErrorCode.COUPON_NOT_FOUND,
        httpStatus: getErrorMeta(ErrorCode.COUPON_NOT_FOUND).httpStatus,
      });
    }

    const locked = await tx.coupon.updateMany({
      where: { id: couponId, userId, status: CouponStatus.UNUSED },
      data: {
        status: CouponStatus.LOCKED,
        lockedAt: new Date(),
        lockedOrderNo: input.orderNo,
      },
    });
    if (locked.count === 0) {
      // 并发：已被别的订单占用（或已非 UNUSED）
      throw new BusinessError('优惠券正被其他订单占用', {
        code: ErrorCode.COUPON_FROZEN,
        httpStatus: getErrorMeta(ErrorCode.COUPON_FROZEN).httpStatus,
      });
    }

    await tx.couponUseLog.create({
      data: {
        couponId,
        couponNo: coupon.couponNo,
        fromStatus: CouponStatus.UNUSED,
        toStatus: CouponStatus.LOCKED,
        bizType: CouponLogBizType.LOCK,
        orderNo: input.orderNo,
        refundNo: null,
        operatorType: OperatorType.USER,
        operatorId: userId,
        remark: `下单占用 ${input.orderNo}`,
      },
    });
  }

  /**
   * 下单绑定券记录（事务 A 第二步，建单后，需 orderId）。
   *
   * @description 写 order_coupon_records（含券快照），将券与订单主键关联。
   *   必须在 order.create 之后调用（此时才有 autoincrement 的 orderId）；券行已在 lockForOrder 锁定。
   * @param couponId 券实例 ID
   * @param userId 用户 ID
   * @param input 绑定入参（orderId / orderNo / discountAmount）
   * @param tx 事务客户端（必传，不可缺省）
   */
  async bindForOrder(
    couponId: bigint,
    userId: bigint,
    input: BindCouponInput,
    tx: CouponTxClient,
  ): Promise<void> {
    const coupon = await tx.coupon.findUnique({
      where: { id: couponId },
      include: { template: true },
    });
    if (coupon === null || coupon.userId !== userId) {
      // 理论不可达：lockForOrder 已校验并锁定；兜底跳过避免脏数据
      return;
    }

    await tx.orderCouponRecord.create({
      data: {
        orderNo: input.orderNo,
        orderId: input.orderId,
        couponId,
        templateId: coupon.templateId,
        userId,
        discountAmount: input.discountAmount,
        snapshot: {
          name: coupon.template.name,
          type: coupon.template.type,
          thresholdAmount: coupon.template.thresholdAmount.toString(),
          discountAmount: coupon.template.discountAmount?.toString() ?? null,
          discountRate: coupon.template.discountRate,
          maxDiscount: coupon.template.maxDiscount?.toString() ?? null,
          scopeType: coupon.template.scopeType,
        },
      },
    });
  }

  // ==========================================================================
  // 支付成功核销（事务 B/B'，LOCKED → USED）—— 必传 tx
  // ==========================================================================

  /**
   * 支付成功核销券（按订单号定位，与支付入账同事务）。
   *
   * @description 幂等：券已 USED 直接跳过；LOCKED → USED + usedAt + 模板 usedCount+1 + 轨迹(USE)。
   *   找不到 order_coupon_records（无券订单）直接跳过。
   * @param orderNo 订单号
   * @param tx 事务客户端（必传）
   */
  async markUsedByOrderNo(orderNo: string, tx: CouponTxClient): Promise<void> {
    const record = await tx.orderCouponRecord.findUnique({ where: { orderNo } });
    if (record === null) {
      return; // 本单无券，幂等跳过
    }
    const coupon = await tx.coupon.findUnique({ where: { id: record.couponId } });
    if (coupon === null) {
      return;
    }
    if (coupon.status === CouponStatus.USED) {
      return; // 已核销，幂等跳过（重复回调）
    }
    if (coupon.status !== CouponStatus.LOCKED) {
      // 非 LOCKED（如 UNUSED，说明占用环节未生效）—— 不允许直接核销，交由业务一致性校验
      throw new BusinessError('优惠券状态异常，无法核销', {
        code: ErrorCode.COUPON_FROZEN,
        httpStatus: getErrorMeta(ErrorCode.COUPON_FROZEN).httpStatus,
      });
    }

    await tx.coupon.updateMany({
      where: { id: record.couponId, status: CouponStatus.LOCKED },
      data: {
        status: CouponStatus.USED,
        usedAt: new Date(),
        usedOrderNo: orderNo,
        lockedAt: null,
        lockedOrderNo: null,
      },
    });
    await tx.couponTemplate.updateMany({
      where: { id: record.templateId },
      data: { usedCount: { increment: 1 } },
    });
    await tx.couponUseLog.create({
      data: {
        couponId: record.couponId,
        couponNo: coupon.couponNo,
        fromStatus: CouponStatus.LOCKED,
        toStatus: CouponStatus.USED,
        bizType: CouponLogBizType.USE,
        orderNo,
        refundNo: null,
        operatorType: OperatorType.SYSTEM,
        operatorId: 0n,
        remark: `支付核销 ${orderNo}`,
      },
    });
  }

  // ==========================================================================
  // 取消 / 超时关单解冻（事务 D，LOCKED → UNUSED）—— 必传 tx
  // ==========================================================================

  /**
   * 取消 / 超时关单解冻券（按订单号定位，与关单同事务）。
   *
   * @description 幂等：券已 UNUSED / 无记录直接跳过；仅 LOCKED → UNUSED + 清锁定信息 + 轨迹(UNLOCK)。
   * @param orderNo 订单号
   * @param tx 事务客户端（必传）
   */
  async releaseByOrderNo(orderNo: string, tx: CouponTxClient): Promise<void> {
    const record = await tx.orderCouponRecord.findUnique({ where: { orderNo } });
    if (record === null) {
      return;
    }
    const coupon = await tx.coupon.findUnique({ where: { id: record.couponId } });
    if (coupon === null || coupon.status === CouponStatus.UNUSED) {
      return; // 已解冻或无券，幂等跳过
    }
    if (coupon.status !== CouponStatus.LOCKED) {
      return; // USED（已支付）等情况不在此解冻，交由退款链路处理
    }

    await tx.coupon.updateMany({
      where: { id: record.couponId, status: CouponStatus.LOCKED },
      data: { status: CouponStatus.UNUSED, lockedAt: null, lockedOrderNo: null },
    });
    await tx.couponUseLog.create({
      data: {
        couponId: record.couponId,
        couponNo: coupon.couponNo,
        fromStatus: CouponStatus.LOCKED,
        toStatus: CouponStatus.UNUSED,
        bizType: CouponLogBizType.UNLOCK,
        orderNo,
        refundNo: null,
        operatorType: OperatorType.SYSTEM,
        operatorId: 0n,
        remark: `取消/关单解冻 ${orderNo}`,
      },
    });
  }

  // ==========================================================================
  // 整单退款返还（事务 C/C'，USED → UNUSED）—— 必传 tx
  // ==========================================================================

  /**
   * 整单退款返还券（按订单号定位，与退款出账同事务）。
   *
   * @description 仅整单退款(FULL)调用：USED → UNUSED + 清核销信息；回写 order_coupon_records.restored_at / restored_refund_no
   *   + 轨迹(RESTORE)。部分退款不退券（一期一单一券）。幂等：非 USED / 无记录跳过。
   * @param orderNo 订单号
   * @param refundNo 退款单号
   * @param tx 事务客户端（必传）
   */
  async restoreByOrderNo(orderNo: string, refundNo: string, tx: CouponTxClient): Promise<void> {
    const record = await tx.orderCouponRecord.findUnique({ where: { orderNo } });
    if (record === null) {
      return;
    }
    const coupon = await tx.coupon.findUnique({ where: { id: record.couponId } });
    if (coupon === null || coupon.status !== CouponStatus.USED) {
      return; // 非已核销 / 无券，幂等跳过
    }

    await tx.coupon.updateMany({
      where: { id: record.couponId, status: CouponStatus.USED },
      data: { status: CouponStatus.UNUSED, usedAt: null, usedOrderNo: null },
    });
    await tx.orderCouponRecord.updateMany({
      where: { orderNo },
      data: { restoredAt: new Date(), restoredRefundNo: refundNo },
    });
    await tx.couponUseLog.create({
      data: {
        couponId: record.couponId,
        couponNo: coupon.couponNo,
        fromStatus: CouponStatus.USED,
        toStatus: CouponStatus.UNUSED,
        bizType: CouponLogBizType.RESTORE,
        orderNo,
        refundNo,
        operatorType: OperatorType.SYSTEM,
        operatorId: 0n,
        remark: `整单退款返还 ${refundNo}`,
      },
    });
  }

  // ==========================================================================
  // 私有工具
  // ==========================================================================

  /**
   * 计算券过期时间。
   *
   * @param validType 有效期策略
   * @param validEnd FIXED_RANGE 的结束时间（可能 null）
   * @param validDays AFTER_CLAIM 的领取后有效天数（可能 null）
   * @param claimedAt 领取时间
   * @returns 过期时间
   */
  private computeExpireAt(
    validType: CouponValidType,
    validEnd: Date | null,
    validDays: number | null,
    claimedAt: Date,
  ): Date {
    if (validType === CouponValidType.AFTER_CLAIM) {
      const days = validDays ?? 0;
      return new Date(claimedAt.getTime() + days * DAY_MS);
    }
    // FIXED_RANGE：取模板 validEnd；缺失时兜底 30 天
    return validEnd ?? new Date(claimedAt.getTime() + 30 * DAY_MS);
  }

  /**
   * 适用范围命中校验。
   *
   * @param templateId 模板 ID
   * @param scopeType 适用范围主类型
   * @param items 下单商品行
   * @returns 是否适用
   */
  private async isApplicable(
    templateId: bigint,
    scopeType: ScopeType,
    items: OrderCouponItem[],
  ): Promise<boolean> {
    if (items.length === 0) {
      return false;
    }
    if (scopeType === ScopeType.ALL) {
      return true;
    }

    const scopes = await this.prisma.couponTemplateScope.findMany({
      where: { templateId },
    });
    if (scopes.length === 0) {
      // 模板标了非 ALL 却无明细：视为不适用（数据不完整，拒绝使用比错用更安全）
      return false;
    }
    const targetIds = new Set(scopes.map((s) => s.targetId));

    if (scopeType === ScopeType.PRODUCT) {
      return items.some((it) => targetIds.has(it.productId));
    }
    if (scopeType === ScopeType.EXCLUDE_PRODUCT) {
      return !items.some((it) => targetIds.has(it.productId));
    }
    // CATEGORY：需要商品类目 ID；缺省则反查 product.categoryId
    const categoryIds = await this.resolveCategoryIds(items);
    return items.some((it) => {
      const cid = it.categoryId ?? categoryIds.get(it.productId);
      return cid !== undefined && cid !== null && targetIds.has(cid);
    });
  }

  /**
   * 反查商品类目 ID（仅当 order item 未携带 categoryId 时）。
   *
   * @param items 下单商品行
   * @returns productId → categoryId 映射
   */
  private async resolveCategoryIds(items: OrderCouponItem[]): Promise<Map<bigint, bigint>> {
    const missing = items.filter((it) => it.categoryId === undefined || it.categoryId === null);
    if (missing.length === 0) {
      return new Map();
    }
    const productIds = missing.map((it) => it.productId);
    const products = await this.prisma.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, categoryId: true },
    });
    return new Map(products.map((p) => [p.id, p.categoryId]));
  }
}
