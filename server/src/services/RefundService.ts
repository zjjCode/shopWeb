/**
 * @file server/src/services/RefundService.ts
 * @description 退款领域服务：申请退款（建 PENDING 单）、审核（同意 / 驳回）、执行退款（事务 C + 记账）
 * @module services
 * @see docs/04-flows.md F9（1046 行起）：F9.1 时序图 ①②③④、F9.2 失败重试策略、F9.3 按 pay_method 路由退款
 * @see prisma/schema.prisma:989（Refund）、:1055（RefundItem）、:824（OrderStatusLog）、:674（Order）、:778（OrderItem）
 * @author 软件开发团队
 * @created 2026-09-09
 *
 * 这是资金链 T080 退款批次的**领域层**。三条铁律（违反任一都是资损事故）：
 *
 * 1. **钱退了必须有流水**。退款是资金链上最容易出资损的一环：钱退了但流水没记，
 *    或记账方向记反，都会让「平台负债」口径漂移，且**没有任何报错**。
 * 2. **执行退款的全部写操作必须在事务 C 内，且必须传 `tx`**。
 *    漏传 `tx` 会让记账跑在独立连接上 —— 事务回滚时账已经记了，**钱凭空多出来**。
 * 3. **状态推进一律用条件更新**（`WHERE refund_no=? AND status='PROCESSING'`），
 *    `count === 0` 即判定为并发 / 重复，**整笔回滚**，绝不带病继续。
 *
 * ⚠️ `isLiability` 反向结转对（F9.3，本批最容易错的地方）：
 *
 *   余额退款要在同一 `txGroupNo` 下写三条流水：
 *     ① USER_BALANCE `BALANCE_REFUND` IN，`isLiability = false`（用户余额流水恒 false）
 *     ② PLATFORM_CASH `LIABILITY_SETTLE_IN` IN，`isLiability = **true**`（负债增）
 *     ③ PLATFORM_CASH `LIABILITY_SETTLE_OUT` OUT，`isLiability = **false**`（收入减）
 *
 *   ⚠️⚠️ `schema.prisma` 里 `LIABILITY_SETTLE_IN` / `LIABILITY_SETTLE_OUT` 的注释写的是
 *   **支付口径**（IN → is_liability=false「负债转收入」、OUT → is_liability=true「冲减负债」）。
 *   **退款是反向结转，取值必须取反**：`LIABILITY_SETTLE_IN` → true 先写、
 *   `LIABILITY_SETTLE_OUT` → false 后写（负债增 / 收入减），
 *   原文见 `docs/04-flows.md` F9.3 第 1171 行。照抄 schema 注释会把负债方向记反。
 *
 * ⚠️ 本期边界：
 * - **HTTP 路由 / 控制器**：T080-B 已完成（`refund.routes.ts` / `AdminRefundController.ts`），本文件只出领域能力。
 * - **部分退款行级校验与 `refund_items` 落库**：T080-C 已完成——`apply` 现在会做行级校验并把明细
 *   嵌套写入 `refund_items`（`execute` 只**消费**这些明细，空则跳过）。
 * - **渠道退款（refundTo=CHANNEL）不实现**：一期没有 `PaymentAdapter`，无法确认渠道真的退成功。
 *   本批明确抛 `ExternalServiceError` 41004 并中止，**绝不记账**（F9.2「订单状态不变」）。
 * - **不接入 IdempotencyService**：幂等记录收尾留 TODO（T080-B 随队列 Worker 一起接）。
 */

import type { Prisma, PrismaClient } from '@prisma/client';
import {
  OperatorType,
  OrderStatus,
  PayChannel,
  PayStatus,
  RefundStatus,
  RefundTarget,
  RefundType,
} from '@prisma/client';
import {
  BusinessError,
  ConflictError,
  ExternalServiceError,
  NotFoundError,
} from '@/core/errors';
import { ErrorCode } from '@/core/errors/errorCodes';
import { IdGenerator } from '@/core/idGenerator';
import { logWarn } from '@/core/logger/logger';
import { getPrisma } from '@/core/prisma';
import { withTransaction } from '@/core/transaction';
import { FundService, type TxClient } from '@/services/FundService';
import { StockService } from '@/services/StockService';

/** 执行退款时需要的订单行字段（部分退款行级校验 / 整单退自动展开） */
type LoadedOrderItem = {
  id: bigint;
  skuId: bigint;
  quantity: number;
  /** 行实付（分）= goodsAmount - promoDiscount - allocatedDiscount */
  payableAmount: bigint;
  /** 已退数量（部分退款行级校验用） */
  refundedQuantity: number;
  /** 已退金额（分，部分退款行级校验用） */
  refundedAmount: bigint;
  /** 行级促销优惠（整单退原样退回） */
  promoDiscount: bigint;
  /** 行分摊优惠（整单退原样退回） */
  allocatedDiscount: bigint;
};

/** refund_items 可插入行（T080-C，使用 Unchecked 变体：直接写 orderItemId / skuId 标量外键） */
type RefundItemCreate = Prisma.RefundItemUncheckedCreateWithoutRefundInput;

/** 本服务用到的 Prisma 委托（单测注入假实现时只需实现这些） */
type DbClient = Pick<
  PrismaClient,
  | 'order'
  | 'orderItem'
  | 'orderStatusLog'
  | 'payment'
  | 'refund'
  | 'refundItem'
  | 'fundAccount'
>;

/** 部分退款的单个商品行入参（前端传入，仅 PARTIAL 使用） */
export interface RefundItemInput {
  /** 订单行 ID（必须属于该订单，否则 41002 拒收） */
  orderItemId: bigint;
  /** 本次退款数量（0 < quantity ≤ 该行剩余可退数量） */
  quantity: number;
  /** 本次退款金额（分，bigint；0 < amount ≤ 该行剩余实付） */
  amount: bigint;
}

/** 申请退款入参 */
export interface ApplyRefundInput {
  /** 订单号（必须属于当前用户，见 {@link RefundService.apply} 的越权校验） */
  orderNo: string;
  /** 退款类型：整单退 / 部分退 */
  type: RefundType;
  /** 退款金额（分，bigint；恒 > 0，且 ≤ 订单可退金额） */
  amount: bigint;
  /** 退款原因码（字典常量维护） */
  reasonCode?: string | null;
  /** 退款原因说明 */
  reasonText?: string | null;
  /** 凭证图片 URL 列表 */
  voucherImages?: string[] | null;
  /** 部分退款行明细（仅 PARTIAL 必填；FULL 由 service 自动按订单全行展开，前端传了也忽略） */
  items?: RefundItemInput[] | null;
}

/** 申请退款结果 */
export interface ApplyRefundResult {
  /** 退款单号 */
  refundNo: string;
  /** 退款单状态（恒为 PENDING：申请即进入待审核） */
  status: RefundStatus;
}

/** 执行退款时需要的退款单字段 */
type ExecutingRefund = {
  id: bigint;
  refundNo: string;
  orderId: bigint;
  orderNo: string;
  userId: bigint;
  type: RefundType;
  amount: bigint;
  refundTo: RefundTarget;
};

/** 执行退款时需要的订单字段 */
type ExecutingOrder = {
  id: bigint;
  orderNo: string;
  status: OrderStatus;
  payAmount: bigint;
  refundedAmount: bigint;
};

/** 可申请退款的订单状态集合（F9.1 ①） */
const REFUNDABLE_ORDER_STATUS: readonly OrderStatus[] = [
  OrderStatus.PAID,
  OrderStatus.SHIPPED,
  OrderStatus.COMPLETED,
];

/** 「进行中」的退款单状态：命中即拒绝新建（41003） */
const IN_PROGRESS_REFUND_STATUS: readonly RefundStatus[] = [
  RefundStatus.PENDING,
  RefundStatus.PROCESSING,
];

/** 售后期窗口：完成后 7 天（F9.1 ① `completedAt + 7d < now` → 31005） */
const AFTER_SALE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** 订单行退款回仓入参中的操作人（SYSTEM，ID 恒 0） */
const SYSTEM_OPERATOR_ID = 0n;

/**
 * 退款服务。
 *
 * @description 三个依赖均可注入，单测用假实现打桩验证拒收路径、事务边界与记账方向。
 */
export class RefundService {
  /** Prisma 客户端 */
  private readonly prisma: DbClient;
  /** 库存服务（执行退款时 sold → available） */
  private readonly stockService: StockService;
  /** 资金服务（执行退款时写三条流水） */
  private readonly fundService: FundService;

  /**
   * @param prisma Prisma 客户端，缺省取全局单例
   * @param stockService 库存服务，缺省新建
   * @param fundService 资金服务，缺省新建
   */
  constructor(
    prisma: DbClient = getPrisma(),
    stockService: StockService = new StockService(),
    fundService: FundService = new FundService(),
  ) {
    this.prisma = prisma;
    this.stockService = stockService;
    this.fundService = fundService;
  }

  /**
   * 申请退款（建 PENDING 单，**不扣钱、不改订单状态**）。
   *
   * @description 全程事务外只读校验，任一失败即抛错且不写库 —— 「申请」只是建一张待审核单，
   * 单表单行写入本身即原子，开事务只会无谓拉长锁持有时间。
   *
   * 校验顺序（F9.1 ①）不可调整：先定归属（防越权探测）→ 再看状态 → 再看售后期 →
   * 再看是否已有进行中退款单 → 最后才校验金额。金额校验放最后是因为它最「轻」，
   * 而越权 / 状态 / 并发这三类是最需要**尽早失败**的。
   *
   * @param userId 用户 ID
   * @param dto 申请退款入参
   * @returns 退款单号与状态（恒 PENDING）
   * @throws {NotFoundError} 订单不存在或不属该用户（31001）
   * @throws {BusinessError} 订单状态不可退（31002）、超出售后期（31005）、退款金额非正（90002）
   * @throws {ConflictError} 存在进行中退款单（41003）、退款金额超额（41002）
   */
  async apply(userId: bigint, dto: ApplyRefundInput): Promise<ApplyRefundResult> {
    // ---------- 1~3：订单归属 + 状态 + 售后期 ----------
    const order = await this.loadRefundableOrder(userId, dto.orderNo);

    // ---------- 3.5：读取订单行（部分退款行级校验 / 整单退自动展开都依赖它）----------
    const orderItems = await this.loadOrderItems(order.id);

    // ---------- 4：是否已有进行中的退款单 ----------
    const inProgress = await this.prisma.refund.findFirst({
      where: { orderId: order.id, status: { in: [...IN_PROGRESS_REFUND_STATUS] } },
      select: { id: true },
    });
    if (inProgress !== null) {
      throw new ConflictError('存在进行中的退款单，请勿重复申请', {
        code: ErrorCode.REFUND_IN_PROGRESS,
      });
    }

    // ---------- 5：金额为正（controller 已校验，service 层纵深防御）----------
    // 纵深防御不是重复劳动：`apply` 是领域层入口，未来可能被 Worker / 补偿任务直接调用，
    // 届时没有 controller 那层校验。金额非正一旦落库就是一条「退 0 分 / 退负数」的脏单。
    if (dto.amount <= 0n) {
      throw new BusinessError('退款金额必须大于 0', { code: ErrorCode.FIELD_FORMAT_INVALID });
    }

    // ---------- 6：不超过可退金额 ----------
    const refundable = order.payAmount - order.refundedAmount;
    if (dto.amount > refundable) {
      throw new ConflictError('退款金额超过可退金额', {
        code: ErrorCode.REFUND_AMOUNT_EXCEEDED,
      });
    }

    // ---------- 6.5：行级校验 + 展开 refund_items（T080-C）----------
    // 整单退：按订单全行自动展开（金额按比例折算、尾差归最后一行，保证 Σ 行金额 == 退款总额）；
    // 部分退：逐行校验「数量 / 金额不超该行可退」，且各行金额之和必须等于退款总额
    // （钱不能有缺口也不能多退）。校验出的行明细随退款单一并落入 refund_items。
    const refundItems = this.buildRefundItems(orderItems, dto);

    // ---------- 7：建 PENDING 单（含 refund_items 嵌套写入，单条 Prisma 调用即原子）----------
    const refundNo = IdGenerator.refundNo();
    const created = await this.prisma.refund.create({
      data: {
        refundNo,
        orderId: order.id,
        orderNo: order.orderNo,
        userId,
        type: dto.type,
        amount: dto.amount,
        // ⚠️ 退款去向**由订单 payMethod 映射**，绝不信前端入参：
        // 用户把「渠道支付」的订单伪造成「退余额」，等于把平台现金变成自己的余额。
        refundTo: this.resolveRefundTarget(order.payMethod),
        status: RefundStatus.PENDING,
        reasonCode: dto.reasonCode ?? null,
        reasonText: dto.reasonText ?? null,
        voucherImages: dto.voucherImages ?? undefined,
        // 退款行明细：整单退自动展开全行，部分退由前端指定并经行级校验；
        // 嵌套 create 与退款主表同属一次 Prisma 写入，要么都成要么都不成。
        items: { create: refundItems },
      } as Prisma.RefundUncheckedCreateInput,
    });

    return { refundNo: created.refundNo, status: created.status };
  }

  /**
   * 审核退款（同意 / 驳回）。
   *
   * @description 两处刻意的设计：
   * 1. **条件更新是并发闸门**：`UPDATE ... WHERE refund_no=? AND status='PENDING'`，
   *    `count === 0` 说明已被并发审核过（或状态已漂移），直接抛 409。
   *    先 SELECT 再 UPDATE 在并发下必然重复审核 —— 两个管理员同时点「同意」就会写两遍。
   * 2. **写操作包在事务内**：驳回要「改退款单 + 插订单轨迹」两步，
   *    只改状态没留痕会让售后追溯断链；只留痕没改状态更糟。两步必须同生共死。
   *
   * ⚠️ **订单状态一律不变**（F9.1 ② / F9.2「订单状态不变」）：
   * 审核只是售后流程的内部推进，钱还没退，订单该是什么状态就是什么状态。
   * 驳回时插入的轨迹 `from` 与 `to` **都是订单原状态**（表示「看了一眼，没动」）。
   *
   * @param adminId 审核管理员 ID
   * @param refundNo 退款单号
   * @param approve 是否同意（true = PROCESSING，false = REJECTED）
   * @param remark 审核备注（驳回时写入 `rejectedReason`）
   * @returns void
   * @throws {NotFoundError} 退款单不存在（41001）
   * @throws {ConflictError} 退款单非待审核状态（41003）、并发重复审核（41003）
   */
  async audit(
    adminId: bigint,
    refundNo: string,
    approve: boolean,
    remark?: string | null,
  ): Promise<void> {
    // 事务外只读：定位退款单 + 状态闸门（失败无副作用）
    const refund = await this.prisma.refund.findUnique({ where: { refundNo } });
    if (refund === null) {
      throw new NotFoundError('退款单不存在', { code: ErrorCode.REFUND_NOT_FOUND });
    }
    if (refund.status !== RefundStatus.PENDING) {
      throw new ConflictError('退款单不是待审核状态，无法审核', {
        code: ErrorCode.REFUND_IN_PROGRESS,
      });
    }

    const auditAt = new Date();

    await withTransaction(
      async (tx) => {
        const updated = await tx.refund.updateMany({
          where: { refundNo, status: RefundStatus.PENDING },
          data: approve
            ? {
                status: RefundStatus.PROCESSING,
                auditBy: adminId,
                auditAt,
                auditRemark: remark ?? null,
              }
            : {
                status: RefundStatus.REJECTED,
                auditBy: adminId,
                auditAt,
                rejectedReason: remark ?? null,
              },
        });

        // 并发重复审核：另一个请求刚把 PENDING 改掉，本次条件更新落空 → 拒绝，绝不静默成功
        if (updated.count === 0) {
          throw new ConflictError('退款单已被处理，请勿重复审核', {
            code: ErrorCode.REFUND_IN_PROGRESS,
          });
        }

        if (approve) {
          return; // 同意只推进退款单，订单状态不动、不留轨迹（钱还没退）
        }

        // 驳回：补一条「看了一眼但没动」的轨迹，to = 订单原状态
        const order = await tx.order.findUnique({
          where: { id: refund.orderId },
          select: { status: true },
        });
        if (order === null) {
          throw new NotFoundError('订单不存在', { code: ErrorCode.ORDER_NOT_FOUND });
        }

        await tx.orderStatusLog.create({
          data: {
            orderId: refund.orderId,
            orderNo: refund.orderNo,
            fromStatus: order.status,
            toStatus: order.status,
            operatorType: OperatorType.ADMIN,
            operatorId: adminId,
            reason: '退款驳回',
            remark: remark ?? '退款驳回',
            extra: { refundNo },
          },
        });
      },
      { label: 'refund.audit' },
    );
  }

  /**
   * 执行退款（事务 C）。
   *
   * @description 全流程在 `withTransaction` 内，**任何一步失败整笔回滚**：
   * 「订单已 REFUNDED 但钱没记流水」是资金黑洞（钱与账对不上且无异常信号），
   * 宁可整笔失败让上层重试 / 走补偿，也不能让它静默通过。
   *
   * 顺序（F9.1 ④ 步骤 1~7，渠道分支除外，见下）：
   *   1. 条件更新退款单 `PROCESSING → SUCCESS`（`count=0` → 抛错回滚，并发 / 重复）
   *   2. 订单 `refunded_amount += amount`，达标则置 `REFUNDED`
   *   3. 插订单轨迹（`from`=原状态、`to`=REFUNDED、`operator_type=SYSTEM`）
   *   4. 逐退款行累加 `order_items.refunded_quantity/amount` + 库存 `refundReturn`
   *   5. `payments` SUCCESS → REFUNDED
   *   6. 记账（BALANCE 三条流水 / CHANNEL 中止）
   *   7. 幂等记录收尾（TODO：T080-B）
   *
   * ⚠️ 渠道退款（`refundTo=CHANNEL`）的分支判定被**提前到步骤 1 之后、步骤 2 之前**：
   * 一期没有 `PaymentAdapter`，无法确认渠道真的退成功，只能中止。
   * 放在记账位（步骤 6）在语义上等价（同一事务回滚），但会让 `orders` / `payments`
   * 在回滚前先被改写一次；提前中止可让「订单状态不变、支付单不变」在单元层即可验证。
   *
   * @param refundNo 退款单号
   * @returns void
   * @throws {ConflictError} 退款单非 PROCESSING 或已被并发处理（41003）→ 整笔回滚
   * @throws {ExternalServiceError} 渠道退款未实现（41004）→ 整笔回滚，绝不记账
   * @throws {BusinessError} 平台现金账户不存在（60001）→ 整笔回滚
   */
  async execute(refundNo: string): Promise<void> {
    await withTransaction(
      async (tx) => {
        // ---------- 步骤 1：退款单 PROCESSING → SUCCESS（条件更新即幂等闸门）----------
        const advanced = await tx.refund.updateMany({
          where: { refundNo, status: RefundStatus.PROCESSING },
          data: { status: RefundStatus.SUCCESS, refundedAt: new Date() },
        });
        if (advanced.count === 0) {
          // 并发 / 重复执行：钱只能退一次，条件更新落空即整笔回滚
          throw new ConflictError('退款单不是退款中状态，可能已被并发处理', {
            code: ErrorCode.REFUND_IN_PROGRESS,
          });
        }

        // 在事务内读退款单（而不是事务外）：拿到的是状态锁之后的数据，避免读到过期快照
        const refund = await this.loadExecutingRefund(tx, refundNo);

        // ---------- 步骤 6（提前）：渠道退款中止 ----------
        // TODO(T080-B)：接入 PaymentAdapter 后在此调 `adapter.refund({refundNo, paymentNo, amount, reason})`，
        // 成功拿到 channelRefundNo 再继续下面的订单推进与记账；失败则按 F9.2 写
        // `status=FAILED` + `fail_reason` + 指数退避 `next_retry_at`，**订单状态不变**。
        if (refund.refundTo === RefundTarget.CHANNEL) {
          logWarn('refund.channel_unsupported', {
            bizNos: { refundNo, orderNo: refund.orderNo },
            ctx: { amount: refund.amount.toString() },
          });
          throw new ExternalServiceError(
            '渠道退款未实现：一期缺少 PaymentAdapter，无法确认渠道退款结果',
            'payment',
            'channel',
            { code: ErrorCode.REFUND_EXEC_FAILED },
          );
        }

        const order = await this.loadExecutingOrder(tx, refund.orderId);

        // ---------- 步骤 2：订单累计退款额 + 状态推进 ----------
        // 整单退直接 REFUNDED；部分退保持原状态，**仅当累计退款额达到实付**才置 REFUNDED（F9.2）
        const accumulated = order.refundedAmount + refund.amount;
        const shouldMarkRefunded =
          refund.type === RefundType.FULL || accumulated >= order.payAmount;

        await tx.order.updateMany({
          where: { id: order.id },
          data: {
            refundedAmount: { increment: refund.amount },
            ...(shouldMarkRefunded ? { status: OrderStatus.REFUNDED } : {}),
            version: { increment: 1 },
          },
        });

        // ---------- 步骤 3：订单轨迹 ----------
        await tx.orderStatusLog.create({
          data: {
            orderId: order.id,
            orderNo: order.orderNo,
            fromStatus: order.status,
            toStatus: OrderStatus.REFUNDED,
            operatorType: OperatorType.SYSTEM,
            operatorId: SYSTEM_OPERATOR_ID,
            reason: '退款成功',
            extra: { refundNo },
          },
        });

        // ---------- 步骤 4：逐退款行累加 + 库存回仓 ----------
        await this.refundOrderItems(tx, refund);

        // ---------- 步骤 5：支付单 SUCCESS → REFUNDED ----------
        await tx.payment.updateMany({
          where: { orderId: order.id, status: PayStatus.SUCCESS },
          data: { status: PayStatus.REFUNDED },
        });

        // ---------- 步骤 6：记账（BALANCE 三条流水）----------
        // 委托 FundService.recordBalanceRefund：负债结转对的「方向 / isLiability / 先 IN 后 OUT」
        // 只在 FundService 一处实现并被单测覆盖，避免 RefundService 与 PaymentService 各写一套导致漂移。
        // 必须传 tx：漏传会让记账跑独立连接 → 事务 C 回滚时账已记 → 钱凭空多出来（资损）。
        await this.fundService.recordBalanceRefund(
          {
            userId: refund.userId,
            amount: refund.amount,
            orderNo: order.orderNo,
            refundNo: refund.refundNo,
            operatorType: OperatorType.SYSTEM,
            operatorId: SYSTEM_OPERATOR_ID,
          },
          tx,
        );

        // ---------- 步骤 7：幂等记录收尾 ----------
        // TODO(T080-B)：IdempotencyService 接入后在此把 scope=REFUND_EXEC / key=REFUND_EXEC:{refundNo}
        // 的记录置 SUCCESS（F9.1 ③🛡 与 ④ 最后一步）。本批只做领域层，不依赖外部幂等组件。
      },
      { label: 'refund.execute' },
    );
  }

  /**
   * 查询单笔退款详情（用户视角，越权兜底）。
   *
   * @description `where` 必须同时带 `refundNo` 与 `userId`——退款单是私有数据。
   * 查不到时统一抛 NotFoundError（不区分「不存在」与「不属于你」），
   * 否则攻击者可用响应差异探测哪些退款单号真实存在。
   * 含退款行明细 `items`（T080-C 接入后才有数据，空数组亦合法）。
   * @param userId 用户 ID
   * @param refundNo 退款单号
   * @returns 退款单详情（含 items）
   * @throws {NotFoundError} 退款单不存在或不属该用户（41001）
   */
  async getByNo(userId: bigint, refundNo: string) {
    const refund = await this.prisma.refund.findFirst({
      where: { refundNo, userId },
      include: { items: { orderBy: { id: 'asc' } } },
    });
    if (refund === null) {
      throw new NotFoundError('退款单不存在', { code: ErrorCode.REFUND_NOT_FOUND });
    }
    return refund;
  }

  /**
   * 查询当前用户的退款列表（分页）。
   *
   * @description 按创建时间倒序，越权红线由 `where.userId` 兜底。
   * 列表不含行明细（明细走详情接口），只返回退款单主表字段，避免大分页拖垮 DB。
   * @param userId 用户 ID
   * @param input 分页参数（page / pageSize）
   * @returns { list, total }
   */
  async listByUser(
    userId: bigint,
    input: { page?: number; pageSize?: number } = {},
  ): Promise<{ list: unknown[]; total: number }> {
    const page = input.page ?? 1;
    const pageSize = input.pageSize ?? 20;
    const skip = Math.max(0, (page - 1) * pageSize);

    const [rows, total] = await Promise.all([
      this.prisma.refund.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
      }),
      this.prisma.refund.count({ where: { userId } }),
    ]);

    return { list: rows, total };
  }

  /**
   * 渠道退款执行失败后，将退款单标记 FAILED（订单状态不变）。
   *
   * @description ⚠️ **仅作为 `execute` 抛 `ExternalServiceError(4104)` 后的补偿写**，
   * 由 HTTP 层（admin 审核端点）在捕获到该异常后调用。`execute` 自身的事务已回滚，
   * 此时退款单停留在 PROCESSING，本方法用条件更新把它置为 FAILED 并记录失败原因，
   * 供 F9.2 的重试 Worker（T080-C 之后）按 `next_retry_at` 指数退避重投。
   * 条件更新 `where { refundNo, status: PROCESSING }` 保证并发下不会误改已 SUCCESS / REJECTED 的单。
   * @param refundNo 退款单号
   * @param reason 失败原因（来自 ExternalServiceError.message）
   * @returns void
   */
  async markChannelFailed(refundNo: string, reason: string): Promise<void> {
    await this.prisma.refund.updateMany({
      where: { refundNo, status: RefundStatus.PROCESSING },
      data: { status: RefundStatus.FAILED, failReason: reason, retryCount: { increment: 1 } },
    });
  }

  // --------------------------------------------------------------------------
  // 私有实现
  // --------------------------------------------------------------------------

  /**
   * 取订单并校验「归属 + 可退状态 + 未超售后期」。
   *
   * @description `where` 必须同时带 `orderNo` 与 `userId`——订单是私有数据。
   * 漏了 `userId` 就是「改一个订单号就能替别人申请退款」的越权漏洞；
   * 反过来，查不到时也**统一抛 NotFoundError**（不区分「不存在」与「不属于你」），
   * 否则攻击者可用响应差异探测哪些订单号真实存在。
   * @param userId 用户 ID
   * @param orderNo 订单号
   * @returns 可申请退款的订单
   * @throws {NotFoundError} 订单不存在或不属该用户（31001）
   * @throws {BusinessError} 订单状态不可退（31002）、超出售后期（31005）
   */
  private async loadRefundableOrder(userId: bigint, orderNo: string) {
    const order = await this.prisma.order.findFirst({ where: { orderNo, userId } });
    if (order === null) {
      throw new NotFoundError('订单不存在', { code: ErrorCode.ORDER_NOT_FOUND });
    }

    if (!REFUNDABLE_ORDER_STATUS.includes(order.status)) {
      throw new BusinessError('订单当前状态不可申请退款', {
        code: ErrorCode.ORDER_STATUS_INVALID,
      });
    }

    // 售后期只对「已完成」生效：completedAt + 7d 之后不再受理（`schema:732` 同口径）
    if (order.status === OrderStatus.COMPLETED) {
      // completedAt 为空属数据异常（理论上 COMPLETED 必填），按「未超期」放行，
      // 不让异常数据把用户的正当售后诉求挡在门外；异常本身由对账任务发现。
      const completedAt = order.completedAt;
      if (completedAt !== null && completedAt.getTime() + AFTER_SALE_WINDOW_MS < Date.now()) {
        throw new BusinessError('订单已超出售后期，无法申请退款', {
          code: ErrorCode.ORDER_AFTER_SALE_EXPIRED,
        });
      }
    }

    return order;
  }

  /**
   * 读取订单行（含行级已退量 / 已退额，用于部分退款行级校验与整单退自动展开）。
   *
   * @param orderId 订单 ID
   * @returns 订单行列表（按 id 升序）
   */
  private async loadOrderItems(orderId: bigint): Promise<LoadedOrderItem[]> {
    return this.prisma.orderItem.findMany({
      where: { orderId },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        skuId: true,
        quantity: true,
        payableAmount: true,
        refundedQuantity: true,
        refundedAmount: true,
        promoDiscount: true,
        allocatedDiscount: true,
      },
    });
  }

  /**
   * 根据退款类型构建 refund_items（T080-C 行级）。
   *
   * @description 整单退 → {@link buildFullRefundItems}；部分退 → {@link buildPartialRefundItems}。
   * @param orderItems 订单行
   * @param dto 申请入参（含 type 与可选 items）
   * @returns 可直插 refund_items 的行数据
   */
  private buildRefundItems(orderItems: LoadedOrderItem[], dto: ApplyRefundInput): RefundItemCreate[] {
    return dto.type === RefundType.FULL
      ? this.buildFullRefundItems(orderItems, dto.amount)
      : this.buildPartialRefundItems(orderItems, dto.items ?? [], dto.amount);
  }

  /**
   * 整单退：按订单全行「剩余可退」自动展开为 refund_items。
   *
   * @description 每行退款数量 = 行剩余数量（quantity - refundedQuantity）；
   * 每行退款金额 = 行剩余实付（payableAmount - refundedAmount）按比例折算到本次退款总额，
   * **向下取整**，**尾差归最后一行**，保证 Σ 行金额 === refund.amount（钱不丢不重）。
   * 无剩余可退行（如已全部退完）→ 41002 拒收。
   * @param orderItems 订单行
   * @param amount 整单退款总额（分）
   * @returns refund_items 行数据
   * @throws {ConflictError} 无可退商品行（41002）
   */
  private buildFullRefundItems(orderItems: LoadedOrderItem[], amount: bigint): RefundItemCreate[] {
    const eligible = orderItems
      .map((oi) => ({
        oi,
        remainingQty: oi.quantity - oi.refundedQuantity,
        remainingPayable: oi.payableAmount - oi.refundedAmount,
      }))
      .filter((x) => x.remainingQty > 0 && x.remainingPayable > 0);

    if (eligible.length === 0) {
      throw new ConflictError('订单没有可退款的商品行', { code: ErrorCode.REFUND_AMOUNT_EXCEEDED });
    }

    const remainingTotal = eligible.reduce((sum, x) => sum + x.remainingPayable, 0n);
    let allocated = 0n;

    return eligible.map((x, idx) => {
      const isLast = idx === eligible.length - 1;
      // 按比例折算：非末行直接 floor 除法；末行吃掉尾差，保证 Σ === amount
      const lineAmount = isLast ? amount - allocated : (x.remainingPayable * amount) / remainingTotal;
      allocated += lineAmount;
      return {
        orderItemId: x.oi.id,
        skuId: x.oi.skuId,
        quantity: x.remainingQty,
        amount: lineAmount,
        promoDiscountRefund: x.oi.promoDiscount,
        allocatedDiscountRefund: x.oi.allocatedDiscount,
      };
    });
  }

  /**
   * 部分退款：逐行校验「数量 / 金额不超该行可退」，且 Σ 行金额 === 退款总额。
   *
   * @description 资金安全红线（T080-C 核心）：
   * - 每行必须属于该订单（防止伪造成别人的行）；
   * - 0 < 数量 ≤ 行剩余数量；0 < 金额 ≤ 行剩余实付；
   * - **Σ 行金额必须 === refund.amount**：前端报的「总退多少」与「每行退多少」必须自洽，
   *   否则要么钱退少了（用户亏）、要么退多了（平台亏）。
   * @param orderItems 订单行
   * @param items 前端传入的部分退款行（含 orderItemId / quantity / amount）
   * @param amount 退款总额（分）
   * @returns refund_items 行数据
   * @throws {BusinessError} 未指定行 / 数量或金额非法（90002）
   * @throws {ConflictError} 行不属于订单 / 超退（41002）
   */
  private buildPartialRefundItems(
    orderItems: LoadedOrderItem[],
    items: RefundItemInput[],
    amount: bigint,
  ): RefundItemCreate[] {
    if (items.length === 0) {
      throw new BusinessError('部分退款必须指定退款商品行', { code: ErrorCode.FIELD_FORMAT_INVALID });
    }

    const byId = new Map(orderItems.map((oi) => [oi.id, oi] as const));
    const result: RefundItemCreate[] = [];
    let sum = 0n;

    for (const it of items) {
      const oi = byId.get(it.orderItemId);
      if (oi === undefined) {
        throw new ConflictError('退款行不属于该订单', { code: ErrorCode.REFUND_AMOUNT_EXCEEDED });
      }

      const remainingQty = oi.quantity - oi.refundedQuantity;
      const remainingPayable = oi.payableAmount - oi.refundedAmount;

      if (it.quantity <= 0) {
        throw new BusinessError('退款数量必须大于 0', { code: ErrorCode.FIELD_FORMAT_INVALID });
      }
      if (it.quantity > remainingQty) {
        throw new ConflictError('退款数量超过该行可退数量', { code: ErrorCode.REFUND_AMOUNT_EXCEEDED });
      }
      if (it.amount <= 0n) {
        throw new BusinessError('退款金额必须大于 0', { code: ErrorCode.FIELD_FORMAT_INVALID });
      }
      if (it.amount > remainingPayable) {
        throw new ConflictError('退款金额超过该行可退金额', { code: ErrorCode.REFUND_AMOUNT_EXCEEDED });
      }

      result.push({
        orderItemId: oi.id,
        skuId: oi.skuId,
        quantity: it.quantity,
        amount: it.amount,
        promoDiscountRefund: 0n,
        allocatedDiscountRefund: 0n,
      });
      sum += it.amount;
    }

    if (sum !== amount) {
      throw new ConflictError('部分退款各行金额之和必须等于退款总额', {
        code: ErrorCode.REFUND_AMOUNT_EXCEEDED,
      });
    }

    return result;
  }

  /**
   * 由订单支付方式映射退款去向。
   *
   * @description **单一来源原则**：`payMethod = BALANCE` 说明钱是从用户余额扣的，
   * 退款只能回余额；其余渠道（MOCK / ALIPAY / WECHAT / BANKCARD）原路退回渠道。
   * v1.1 取消混合支付后一笔退款只有一个去向，不存在按段拆分。
   * `payMethod` 为 NULL（下单未定、理论上支付成功后已回写）时按**渠道**处理 ——
   * 保守取值：退渠道需要人工 / 适配器确认，不会凭空把平台现金变成用户余额。
   * @param payMethod 订单支付方式（可空）
   * @returns 退款去向
   */
  private resolveRefundTarget(payMethod: PayChannel | null): RefundTarget {
    return payMethod === PayChannel.BALANCE ? RefundTarget.BALANCE : RefundTarget.CHANNEL;
  }

  /**
   * 事务内读退款单。
   *
   * @param tx 事务 C 的客户端
   * @param refundNo 退款单号
   * @returns 执行退款所需的退款单字段
   * @throws {NotFoundError} 退款单不存在（41001）
   */
  private async loadExecutingRefund(tx: TxClient, refundNo: string): Promise<ExecutingRefund> {
    const refund = await tx.refund.findUnique({ where: { refundNo } });
    if (refund === null) {
      throw new NotFoundError('退款单不存在', { code: ErrorCode.REFUND_NOT_FOUND });
    }
    return {
      id: refund.id,
      refundNo: refund.refundNo,
      orderId: refund.orderId,
      orderNo: refund.orderNo,
      userId: refund.userId,
      type: refund.type,
      amount: refund.amount,
      refundTo: refund.refundTo,
    };
  }

  /**
   * 事务内读订单。
   *
   * @param tx 事务 C 的客户端
   * @param orderId 订单 ID
   * @returns 执行退款所需的订单字段
   * @throws {NotFoundError} 订单不存在（31001）
   */
  private async loadExecutingOrder(tx: TxClient, orderId: bigint): Promise<ExecutingOrder> {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: { id: true, orderNo: true, status: true, payAmount: true, refundedAmount: true },
    });
    if (order === null) {
      throw new NotFoundError('订单不存在', { code: ErrorCode.ORDER_NOT_FOUND });
    }
    return {
      id: order.id,
      orderNo: order.orderNo,
      status: order.status,
      payAmount: order.payAmount,
      refundedAmount: order.refundedAmount,
    };
  }

  /**
   * 逐退款行：累加 `order_items` 已退数量 / 金额，并回仓库存。
   *
   * @description 两个「必须传 `tx`」的点，漏一个都是资损：
   * - `orderItem.updateMany`：漏传会让「已退数量」跑在独立连接上，事务回滚后订单行显示
   *   已退 N 件但钱没退，**用户可就同一行再次申请退款**（超退）。
   * - `stockService.refundReturn`：漏传则库存 `sold → available` 跑独立连接，
   *   事务回滚后货已回仓但钱没退，**白送一件货**。
   *
   * 行明细为空（整单退未落 `refund_items`、或 T080-C 未接入）时本方法是 no-op ——
   * 订单行累计与库存回仓留给 T080-C 按行级口径补全，**不在此处兜底造数据**。
   *
   * T080-C 已完成：`apply` 侧已做行级校验并把明细落入 `refund_items`，本方法只负责消费。
   *
   * @param tx 事务 C 的客户端
   * @param refund 退款单
   * @returns void
   */
  private async refundOrderItems(tx: TxClient, refund: ExecutingRefund): Promise<void> {
    const items = await tx.refundItem.findMany({
      where: { refundId: refund.id },
      select: { orderItemId: true, skuId: true, quantity: true, amount: true },
    });

    // 按 sku_id 升序：与下单冻结 / 支付确认的加锁顺序一致，防多订单并发下的死锁（F5.3）
    const ordered = [...items].sort((a, b) => (a.skuId < b.skuId ? -1 : a.skuId > b.skuId ? 1 : 0));

    for (const item of ordered) {
      // eslint-disable-next-line no-await-in-loop -- 顺序敏感：必须按 sku_id 升序串行，并行会破坏加锁顺序
      await tx.orderItem.updateMany({
        where: { id: item.orderItemId },
        data: {
          refundedQuantity: { increment: item.quantity },
          refundedAmount: { increment: item.amount },
        },
      });
      // eslint-disable-next-line no-await-in-loop -- 顺序敏感：与上面的行更新严格配对串行
      await this.stockService.refundReturn(
        {
          skuId: item.skuId,
          qty: item.quantity,
          bizNo: refund.refundNo,
          operatorType: OperatorType.SYSTEM,
          operatorId: SYSTEM_OPERATOR_ID,
          idempotencyKey: null,
        },
        tx,
      );
    }
  }

}

/** 默认单例（供 Controller / Worker 直接消费，T080-B 接入） */
export const refundService = new RefundService();
export default refundService;
