/**
 * @file server/src/services/StockService.ts
 * @description 库存服务：下单冻结 / 支付确认 / 取消释放 / 退款回仓 四个闭环操作的 CAS 实现。
 * @module services
 * @see docs/04-flows.md F5.2（CAS 三种手段）、F5.3（库存 CAS 与流水同事务）
 * @see docs/02-architecture.md:61（权威状态永远在 MySQL，Redis 仅辅助）
 * @see docs/03-database.md（SkuStock / StockLog 模型与恒等式 total = available + frozen + sold）
 * @author 软件开发团队
 * @created 2026-09-07
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 设计取舍（本批明确不做的事，留待后续补齐）：
 *
 * 1. **不做 Redis 分布式锁**。本批只实现 DB 层的 CAS 权威判定 + 乐观锁 version。
 *    Redis 锁（docs/04-flows.md F5.1 的 `shop:lock:sku:{skuId}`）**只削峰排队**，
 *    它只影响「谁先抢到」，不影响正确性——判定闸门永远在 DB 的 `WHERE <source> >= ?`。
 *    即使 Redis 故障丢锁，也不会超卖（docs/04-flows.md:497）。
 *    → 后续补充点：在 StockService.freeze 入口加 `SET NX PX` 排队 + Lua 校验 DEL，
 *      并把多 SKU 场景的加锁顺序固定为「先券后库存、库存内按 sku_id 升序」防死锁。
 *
 * 2. **不做 MANUAL_IN / MANUAL_LOSS / MANUAL_CHECK**。那是后台批次调库存的入口（需填 reason、
 *    可能改动 total）。本批 4 个操作都只是 available / frozen / sold 三者在内部搬家，
 *    **恒等式 total = available + frozen + sold 始终不变**，total 仅在 MANUAL_* 时才变。
 *
 * 三条铁律（来自 docs/02-architecture.md:61 与 F5.2）：
 *   - 资金/库存/订单状态的权威源永远是 MySQL，Redis 只做性能与并发辅助。
 *   - Redis 锁只削峰，不是权威；判定仍在 DB。
 *   - 数据库还有 `CHECK (available >= 0)` 兜底，触发即 Bug（本批逻辑保证不会出现负数）。
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { StockChangeType } from '@prisma/client';
import type { OperatorType } from '@prisma/client';
import { ConflictError } from '@/core/errors';
import { ErrorCode } from '@/core/errors/errorCodes';
import { withTransaction } from '@/core/transaction';
import { getPrisma } from '@/core/prisma';
import {
  SkuStockRepository,
  type DbClient,
} from '@/repositories/SkuStockRepository';

/** 库存操作入参（4 个写操作共用） */
export interface StockOpInput {
  /** SKU 主键 */
  skuId: bigint;
  /** 变动数量（正整数） */
  qty: number;
  /** 业务单号（订单号 / 退款单号），写入 stock_logs.biz_no */
  bizNo: string;
  /** 操作人类型（USER / ADMIN / SYSTEM） */
  operatorType: OperatorType;
  /** 操作人 ID（SYSTEM 时填 0） */
  operatorId: bigint;
  /** 操作人名称（可空） */
  operatorName?: string | null;
  /** 变更原因（可空） */
  reason?: string | null;
  /** 幂等号（可空；传 null/不传表示不限制，依赖 uk_sku_idem 允许多个 NULL） */
  idempotencyKey?: string | null;
}

/** 库存操作返回（含变动前后三段值与版本，便于调用方校验恒等式） */
export interface StockResult {
  skuId: bigint;
  changeType: StockChangeType;
  /** 变动数量（带符号，与 change_type 语义一致） */
  changeQty: number;
  beforeAvailable: number;
  afterAvailable: number;
  beforeFrozen: number;
  afterFrozen: number;
  beforeSold: number;
  afterSold: number;
  /** 总量（恒等式：before/after 的 available+frozen+sold 都等于它） */
  total: number;
  version: number;
}

/** 只读库存视图（getStock 返回） */
export interface StockView {
  available: number;
  frozen: number;
  sold: number;
}

export class StockService {
  /** 注入的 Prisma 客户端（读场景与兜底用） */
  private readonly prisma: DbClient;
  /** 注入的库存仓储（单测可替换为 fake） */
  private readonly repo: SkuStockRepository;

  /**
   * @param prisma Prisma 客户端，缺省取全局单例
   * @param repo 库存仓储，缺省按 prisma 新建（可被单测打桩替换）
   */
  constructor(prisma: DbClient = getPrisma(), repo: SkuStockRepository = new SkuStockRepository(prisma)) {
    this.prisma = prisma;
    this.repo = repo;
  }

  /**
   * 下单冻结：available → frozen（ORDER_FREEZE）。
   *
   * 源字段判定 `available >= qty`；CAS 成功则 available -= qty、frozen += qty、version += 1。
   *
   * @param input 操作入参
   * @param tx 可选事务客户端（下单同事务时由调用方传入；不传则本服务开启新事务）
   * @returns 变动结果
   * @throws {ConflictError} 50001 库存不足 / 50002 版本冲突
   */
  async freeze(input: StockOpInput, tx?: DbClient): Promise<StockResult> {
    if (tx) {
      return this.doFreeze(tx, input);
    }
    return withTransaction((t) => this.doFreeze(t, input), { label: 'stock.freeze' });
  }

  /**
   * 支付确认：frozen → sold（ORDER_CONFIRM）。
   *
   * 源字段判定 `frozen >= qty`；CAS 成功则 frozen -= qty、sold += qty、version += 1。
   *
   * @param input 操作入参
   * @param tx 可选事务客户端
   * @returns 变动结果
   * @throws {ConflictError} 50001 库存不足（frozen < qty）/ 50002 版本冲突
   */
  async confirm(input: StockOpInput, tx?: DbClient): Promise<StockResult> {
    if (tx) {
      return this.doConfirm(tx, input);
    }
    return withTransaction((t) => this.doConfirm(t, input), { label: 'stock.confirm' });
  }

  /**
   * 取消 / 超时释放：frozen → available（ORDER_RELEASE）。
   *
   * 源字段判定 `frozen >= qty`；CAS 成功则 frozen -= qty、available += qty、version += 1。
   *
   * @param input 操作入参
   * @param tx 可选事务客户端
   * @returns 变动结果
   * @throws {ConflictError} 50001 库存不足（frozen < qty）/ 50002 版本冲突
   */
  async release(input: StockOpInput, tx?: DbClient): Promise<StockResult> {
    if (tx) {
      return this.doRelease(tx, input);
    }
    return withTransaction((t) => this.doRelease(t, input), { label: 'stock.release' });
  }

  /**
   * 退款回仓：sold → available（REFUND_RETURN）。
   *
   * 源字段判定 `sold >= qty`；CAS 成功则 sold -= qty、available += qty、version += 1。
   *
   * ⚠️ 最易错处：源字段必须是 `sold` 而非 `available`。若误判 available，则「available 充足但
   *    sold 不足」时会错误放行，造成库存凭空增加（凭空多出可售库存）。
   *
   * @param input 操作入参
   * @param tx 可选事务客户端
   * @returns 变动结果
   * @throws {ConflictError} 50001 库存不足（sold < qty）/ 50002 版本冲突
   */
  async refundReturn(input: StockOpInput, tx?: DbClient): Promise<StockResult> {
    if (tx) {
      return this.doRefund(tx, input);
    }
    return withTransaction((t) => this.doRefund(t, input), { label: 'stock.refund' });
  }

  /**
   * 只读：查询某 SKU 的库存三段值。
   *
   * 行为定义：**库存行不存在时返回 null**（不抛异常）。调用方据此自行判断是否 库存不足。
   * （注意：本服务的写操作会把「行不存在」视为 available=frozen=sold=0，从而走 库存不足 分支。）
   *
   * @param skuId SKU 主键
   * @returns { available, frozen, sold } 或 null
   */
  async getStock(skuId: bigint): Promise<StockView | null> {
    const row = await this.repo.findBySkuId(this.prisma, skuId);
    if (row === null) {
      return null;
    }
    return { available: row.available, frozen: row.frozen, sold: row.sold };
  }

  // --------------------------------------------------------------------------
  // 私有实现
  // --------------------------------------------------------------------------

  /**
   * 公共执行骨架：读快照 → 计算前后三段值 → CAS → 写流水。
   *
   * @param tx 事务客户端
   * @param input 操作入参
   * @param changeType 变动类型枚举
   * @param sourceField 权威判定源字段
   * @param deltas 三段增量 {available, frozen, sold}（带符号）
   * @returns 变动结果
   */
  private async execute(
    tx: DbClient,
    input: StockOpInput,
    changeType: StockChangeType,
    sourceField: 'available' | 'frozen' | 'sold',
    deltas: { available: number; frozen: number; sold: number },
  ): Promise<StockResult> {
    // 1. 读当前快照；行不存在视为全 0（available=frozen=sold=0, version=0）→ 会走 库存不足 分支
    const snap = (await this.repo.findForUpdate(tx, input.skuId)) ?? {
      available: 0,
      frozen: 0,
      sold: 0,
      version: 0,
    };

    // 计算变动前后三段值（恒等：total 不变，因为 available+frozen+sold 的增量和为 0）
    const beforeAvailable = snap.available;
    const beforeFrozen = snap.frozen;
    const beforeSold = snap.sold;
    const afterAvailable = beforeAvailable + deltas.available;
    const afterFrozen = beforeFrozen + deltas.frozen;
    const afterSold = beforeSold + deltas.sold;
    const total = beforeAvailable + beforeFrozen + beforeSold;

    // 2. CAS 条件更新（权威判定 + 乐观锁）。源字段值用于失败时的语义区分。
    const affected = await this.repo.casUpdate(tx, {
      skuId: input.skuId,
      sourceField,
      sourceRequired: input.qty,
      version: snap.version,
      availableDelta: deltas.available,
      frozenDelta: deltas.frozen,
      soldDelta: deltas.sold,
    });

    // 3. 失败分支：区分「库存不足」与「版本冲突」
    if (affected === 0) {
      const sourceValue = snap[sourceField];
      if (sourceValue < input.qty) {
        // 真实库存（源字段）不足以满足本次扣减
        throw new ConflictError('库存不足', { code: ErrorCode.STOCK_NOT_ENOUGH });
      }
      // 源字段充足但 version 不匹配 → 并发覆盖（乐观锁冲突）
      throw new ConflictError('库存变更冲突，请重试', { code: ErrorCode.STOCK_CONFLICT });
    }

    // 4. 写库存流水（六段前后值 + 带符号 changeQty）。失败扣减不会走到这里（上面已抛错）。
    await this.repo.insertLog(tx, {
      skuId: input.skuId,
      changeType,
      changeQty: this.signedQty(changeType, input.qty),
      beforeAvailable,
      afterAvailable,
      beforeFrozen,
      afterFrozen,
      beforeSold,
      afterSold,
      bizNo: input.bizNo,
      operatorType: input.operatorType,
      operatorId: input.operatorId,
      operatorName: input.operatorName ?? null,
      reason: input.reason ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
    });

    // 5. 返回结果（version 已 +1，见 CAS SQL）
    return {
      skuId: input.skuId,
      changeType,
      changeQty: this.signedQty(changeType, input.qty),
      beforeAvailable,
      afterAvailable,
      beforeFrozen,
      afterFrozen,
      beforeSold,
      afterSold,
      total,
      version: snap.version + 1,
    };
  }

  /** 下单冻结：available -, frozen + */
  private doFreeze(tx: DbClient, input: StockOpInput): Promise<StockResult> {
    return this.execute(tx, input, StockChangeType.ORDER_FREEZE, 'available', {
      available: -input.qty,
      frozen: input.qty,
      sold: 0,
    });
  }

  /** 支付确认：frozen -, sold + */
  private doConfirm(tx: DbClient, input: StockOpInput): Promise<StockResult> {
    return this.execute(tx, input, StockChangeType.ORDER_CONFIRM, 'frozen', {
      available: 0,
      frozen: -input.qty,
      sold: input.qty,
    });
  }

  /** 取消释放：frozen -, available + */
  private doRelease(tx: DbClient, input: StockOpInput): Promise<StockResult> {
    return this.execute(tx, input, StockChangeType.ORDER_RELEASE, 'frozen', {
      available: input.qty,
      frozen: -input.qty,
      sold: 0,
    });
  }

  /** 退款回仓：sold -, available + */
  private doRefund(tx: DbClient, input: StockOpInput): Promise<StockResult> {
    return this.execute(tx, input, StockChangeType.REFUND_RETURN, 'sold', {
      available: input.qty,
      frozen: 0,
      sold: -input.qty,
    });
  }

  /**
   * 带符号的 change_qty：冻结类（ORDER_FREEZE）为 +qty（占用增加），
   * 释放/回仓类为 -qty（占用减少）。与 StockLog.change_qty 注释语义一致。
   *
   * @param changeType 变动类型
   * @param qty 数量
   * @returns 带符号数量
   */
  private signedQty(changeType: StockChangeType, qty: number): number {
    return changeType === StockChangeType.ORDER_FREEZE ? qty : -qty;
  }
}

/** 默认单例 */
export const stockService = new StockService();

export default stockService;
