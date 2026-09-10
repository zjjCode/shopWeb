/**
 * @file server/src/repositories/SkuStockRepository.ts
 * @description SKU 库存数据访问层：CAS 条件更新 + 库存流水写入。
 * @module repositories
 * @see docs/04-flows.md F5.2（CAS 三种手段配合）、F5.3（库存 CAS 与流水必须同事务）
 * @see docs/02-architecture.md:61（权威状态永远在 MySQL，Redis 仅辅助）
 * @see prisma/schema.prisma（SkuStock / StockLog 模型，字段名以 @map 后的 snake_case 为准）
 * @author 软件开发团队
 * @created 2026-09-07
 *
 * ⚠️ 原生 SQL 字段名核对清单（已逐一回到 prisma/schema.prisma 确认 @map，非凭印象）：
 *
 *   sku_stocks 表（模型 SkuStock，@@map("sku_stocks")）：
 *     sku_id          ← SkuStock.skuId          @map("sku_id")           (BigInt, unique)
 *     available       ← SkuStock.available      (Int, 默认 0)
 *     frozen          ← SkuStock.frozen         (Int, 默认 0)
 *     sold            ← SkuStock.sold           (Int, 默认 0)
 *     version         ← SkuStock.version        (Int, 默认 0，乐观锁)
 *     （本批不写 total / warning_threshold / created_at / updated_at，理由见 StockService）
 *
 *   stock_logs 表（模型 StockLog，@@map("stock_logs")）：
 *     sku_id            ← StockLog.skuId            @map("sku_id")
 *     change_type       ← StockLog.changeType       @map("change_type")   （枚举字符串：ORDER_FREEZE / ORDER_CONFIRM / ORDER_RELEASE / REFUND_RETURN）
 *     change_qty        ← StockLog.changeQty        @map("change_qty")    （带符号：冻结 +N / 释放 -N）
 *     before_available  ← StockLog.beforeAvailable  @map("before_available")
 *     after_available   ← StockLog.afterAvailable   @map("after_available")
 *     before_frozen     ← StockLog.beforeFrozen     @map("before_frozen")
 *     after_frozen      ← StockLog.afterFrozen      @map("after_frozen")
 *     before_sold       ← StockLog.beforeSold       @map("before_sold")
 *     after_sold        ← StockLog.afterSold        @map("after_sold")
 *     biz_no            ← StockLog.bizNo            @map("biz_no")         （可空，VARCHAR(64)）
 *     operator_type     ← StockLog.operatorType     @map("operator_type")  （枚举：USER / ADMIN / SYSTEM）
 *     operator_id       ← StockLog.operatorId       @map("operator_id")    （BigInt）
 *     operator_name     ← StockLog.operatorName     @map("operator_name")  （可空，VARCHAR(64)）
 *     reason            ← StockLog.reason           @map("reason")         （可空，VARCHAR(255)）
 *     idempotency_key   ← StockLog.idempotencyKey   @map("idempotency_key")（可空，VARCHAR(128)；唯一索引 uk_sku_idem(sku_id, idempotency_key) 允许多个 NULL）
 *
 * 注意：$executeRaw / $queryRaw 不受 Prisma 类型检查保护，字段名写错时「编译能过、运行时炸」。
 * 上面每一行都来自 schema.prisma 的 @map，请勿凭记忆改动。
 */

import { Prisma, type PrismaClient } from '@prisma/client';
import { getPrisma } from '@/core/prisma';

/** 事务客户端或普通客户端（读场景可在事务外用普通 client） */
export type DbClient = PrismaClient | Prisma.TransactionClient;

/** 库存三段快照（读 getCurrent 时返回） */
export interface StockSnapshot {
  /** 可用库存（可售） */
  available: number;
  /** 冻结库存（待支付订单占用） */
  frozen: number;
  /** 已售库存（已支付出库） */
  sold: number;
  /** 乐观锁版本号 */
  version: number;
}

/** 带 total 的库存视图（findBySkuId 返回，供只读查询与恒等式校验） */
export interface StockRecord extends StockSnapshot {
  /** 总量 = available + frozen + sold */
  total: number;
}

/**
 * CAS 更新参数。
 *
 * 设计要点：不拼「available = available - ?」这种算式，而是把**增量（delta）**显式传进来，
 * 这样单测能直接断言「freeze 时 availableDelta = -N、frozenDelta = +N」，而无需解析 SQL 文本。
 * 真实执行时仍拼成 `available = available + ${availableDelta}` 的形式（等价）。
 */
export interface CasUpdateParams {
  /** SKU 主键 */
  skuId: bigint;
  /**
   * 权威判定所用的源字段。
   * freeze  → 'available'（判 available >= N）
   * confirm → 'frozen'   （判 frozen   >= N）
   * release → 'frozen'   （判 frozen   >= N）
   * refund  → 'sold'     （判 sold     >= N）
   * ⚠️ 绝不可一律判 available，否则退款回仓会在 available 充足但 sold 不足时错误放行 → 库存凭空增加
   */
  sourceField: 'available' | 'frozen' | 'sold';
  /** WHERE `<sourceField> >= ?` 的值（即 N） */
  sourceRequired: number;
  /** WHERE version = ? 的值（乐观锁） */
  version: number;
  /** available = available + availableDelta */
  availableDelta: number;
  /** frozen = frozen + frozenDelta */
  frozenDelta: number;
  /** sold = sold + soldDelta */
  soldDelta: number;
}

/** 库存流水插入参数 */
export interface StockLogInsert {
  skuId: bigint;
  /** 变动类型（枚举字符串） */
  changeType: string;
  /** 变动数量（带符号） */
  changeQty: number;
  beforeAvailable: number;
  afterAvailable: number;
  beforeFrozen: number;
  afterFrozen: number;
  beforeSold: number;
  afterSold: number;
  /** 业务单号（可空） */
  bizNo: string | null;
  /** 操作人类型（枚举字符串） */
  operatorType: string;
  /** 操作人 ID（SYSTEM 时填 0） */
  operatorId: bigint;
  /** 操作人名称（可空） */
  operatorName: string | null;
  /** 原因（可空） */
  reason: string | null;
  /** 幂等号（可空；传 null 表示不限制） */
  idempotencyKey: string | null;
}

/**
 * SKU 库存仓储。
 *
 * 所有**写方法**（casUpdate / insertLog）都接收 `tx: DbClient` 参数，
 * 这样下单服务可以把同一个事务客户端传进来，保证「CAS 扣减」与「流水插入」同事务
 * （docs/04-flows.md:520：任一 SKU 失败 → 整事务回滚）。读方法同样接收 tx，便于在事务内一致性读。
 */
export class SkuStockRepository {
  /**
   * @param _prisma Prisma 客户端（普通或事务），缺省取全局单例；仅作占位，
   *                各写/读方法均接收 `tx` 参数，优先使用调用方传入的事务客户端
   */
  constructor(_prisma: DbClient = getPrisma()) {
    void _prisma;
  }

  /**
   * 读取库存三段快照（available / frozen / sold / version）。
   *
   * 用于 CAS 前的「读当前 version」与源字段判定；行不存在时返回 null（调用方按 available=0 处理 → 库存不足）。
   * SQL：`SELECT available, frozen, sold, version FROM sku_stocks WHERE sku_id = ?`
   * 列名来源：sku_stocks.available/frozen/sold/version（均无 @map，列名即字段名）。
   *
   * @param tx 事务/普通客户端
   * @param skuId SKU 主键
   * @returns 快照或 null（行不存在）
   */
  async findForUpdate(tx: DbClient, skuId: bigint): Promise<StockSnapshot | null> {
    const rows = await tx.$queryRaw<Array<{
      available: number;
      frozen: number;
      sold: number;
      version: number;
    }>>`
      SELECT available, frozen, sold, version
        FROM sku_stocks
       WHERE sku_id = ${skuId}
    `;
    if (rows.length === 0) {
      return null;
    }
    const row = rows[0]!;
    return {
      available: row.available,
      frozen: row.frozen,
      sold: row.sold,
      version: row.version,
    };
  }

  /**
   * 只读查询：按 sku_id 读取完整库存记录（含 total），不存在返回 null。
   *
   * @param tx 事务/普通客户端
   * @param skuId SKU 主键
   * @returns 库存记录或 null
   */
  async findBySkuId(tx: DbClient, skuId: bigint): Promise<StockRecord | null> {
    const rows = await tx.$queryRaw<Array<{
      available: number;
      frozen: number;
      sold: number;
      version: number;
      total: number;
    }>>`
      SELECT available, frozen, sold, version, total
        FROM sku_stocks
       WHERE sku_id = ${skuId}
    `;
    if (rows.length === 0) {
      return null;
    }
    const row = rows[0]!;
    return {
      available: row.available,
      frozen: row.frozen,
      sold: row.sold,
      version: row.version,
      total: row.total,
    };
  }

  /**
   * CAS 条件更新（权威判定 + 乐观锁）。
   *
   * 一次 SQL 完成「判定 + 扣减」，无任何读改写窗口：
   *
   * ```sql
   * UPDATE sku_stocks
   *    SET available = available + ${availableDelta},
   *        frozen    = frozen    + ${frozenDelta},
   *        sold      = sold      + ${soldDelta},
   *        version   = version   + 1
   *  WHERE sku_id      = ${skuId}
   *    AND ${sourceField} >= ${sourceRequired}   -- 权威判定：防超卖最后一道闸门
   *    AND version      = ${version}             -- 乐观锁：防并发覆盖 / ABA
   * ```
   * affectedRows = 1 → 成功；= 0 → 库存不足（sourceField < N）或版本冲突（并发覆盖）。
   *
   * ⚠️ `sourceField` 是列名（标识符），必须用 `Prisma.raw` 注入；不能用 `${}` 值占位（会被引号包裹成字符串常量）。
   * 列名来源：sku_stocks.sku_id / available / frozen / sold / version（均无 @map）。
   *
   * @param tx 事务/普通客户端
   * @param params CAS 参数
   * @returns 受影响行数（0 或 1）
   */
  async casUpdate(tx: DbClient, params: CasUpdateParams): Promise<number> {
    const affected = await tx.$executeRaw`
      UPDATE sku_stocks
         SET available = available + ${params.availableDelta},
             frozen    = frozen    + ${params.frozenDelta},
             sold      = sold      + ${params.soldDelta},
             version   = version   + 1
       WHERE sku_id  = ${params.skuId}
         AND ${Prisma.raw(params.sourceField)} >= ${params.sourceRequired}
         AND version  = ${params.version}
    `;
    return affected;
  }

  /**
   * 写入一条库存流水（变动前后三段值）。
   *
   * SQL 列名来源（逐一对应 StockLog 的 @map）：
   *   sku_id / change_type / change_qty /
   *   before_available / after_available / before_frozen / after_frozen / before_sold / after_sold /
   *   biz_no / operator_type / operator_id / operator_name / reason / idempotency_key
   * （均见 prisma/schema.prisma StockLog 模型定义）
   *
   * @param tx 事务/普通客户端
   * @param log 流水参数
   */
  async insertLog(tx: DbClient, log: StockLogInsert): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO stock_logs (
        sku_id, change_type, change_qty,
        before_available, after_available,
        before_frozen, after_frozen,
        before_sold, after_sold,
        biz_no, operator_type, operator_id, operator_name, reason, idempotency_key
      ) VALUES (
        ${log.skuId}, ${log.changeType}, ${log.changeQty},
        ${log.beforeAvailable}, ${log.afterAvailable},
        ${log.beforeFrozen}, ${log.afterFrozen},
        ${log.beforeSold}, ${log.afterSold},
        ${log.bizNo}, ${log.operatorType}, ${log.operatorId}, ${log.operatorName}, ${log.reason}, ${log.idempotencyKey}
      )
    `;
  }
}
