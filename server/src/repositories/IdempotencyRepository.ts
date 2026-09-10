/**
 * @file server/src/repositories/IdempotencyRepository.ts
 * @description 幂等记录数据访问层（`idempotency_records` 表）：DB 版 {@link IdempotencyStore} 实现
 * @module repositories
 * @see docs/02-architecture.md §5.10（幂等设计）
 * @see src/middlewares/idempotency.ts（接口定义与四种命中语义）
 * @see prisma/schema.prisma:1213（IdempotencyRecord 模型，字段名以 @map 后的 snake_case 为准）
 * @author 软件开发团队
 * @created 2026-09-07
 *
 * 为什么必须有这一层：
 * 中间件默认实现 `InMemoryIdempotencyStore` 是**进程内 Map**，两个致命后果 ——
 * ① 多实例部署时每个实例各一份 Map，同一 `Idempotency-Key` 打到不同实例会各下一次单；
 * ② 单实例重启后 Map 清空，客户端重发即重复下单。
 * 而 `OrderService` 把「不重复下单」这条铁律完全押在幂等中间件上，因此生产必须注册本实现。
 *
 * 三条不可动摇的规则：
 *
 * 1. **抢占必须原子**（{@link IdempotencyRepository.tryAcquire}）。
 *    先靠 `uk_scope_key` 唯一键冲突判定「记录是否已存在」，再用**一条带条件的 `updateMany`**
 *    完成重抢。绝不能用 read-then-write（先查再判再写）：并发下两个请求会同时看到 FAILED
 *    然后都抢成功，幂等当场失效。`updateMany` 的 `count` 由 MySQL 行锁保证只有一个为 1。
 *
 * 2. **FAILED 必须允许重试**（中间件文件头第 4 条语义）：首次失败的业务应当可重试，
 *    所以重抢条件是 `status = FAILED OR expireAt < now`，而不是「有记录就拒绝」。
 *
 * 3. **响应快照必须过 bigint 安全序列化**（{@link IdempotencyRepository.complete}）。
 *    `response_snapshot` 是 `Json` 列，Prisma 写 Json 走 `JSON.stringify`，
 *    遇到 `bigint`（金额 / 订单 ID 全是 Prisma BigInt）直接抛
 *    `TypeError: Do not know how to serialize a BigInt`。
 *    ⚠️ 这个异常 **tsc 查不出来、mock 的 prisma 也不会真的序列化**，只有连真库才会炸 ——
 *    所以落库前一律先 `JSON.parse(JSON.stringify(response, jsonReplacer))`。
 *
 * 字段名核对（已逐一回到 prisma/schema.prisma:1213 确认 @map，非凭印象）：
 *   scope              ← IdempotencyRecord.scope              （VarChar(64)，无 @map）
 *   idempotency_key    ← IdempotencyRecord.idempotencyKey     @map("idempotency_key")
 *   request_fingerprint← IdempotencyRecord.requestFingerprint @map("request_fingerprint")
 *   response_snapshot  ← IdempotencyRecord.responseSnapshot   @map("response_snapshot")
 *   status             ← IdempotencyRecord.status             （枚举，无 @map）
 *   expire_at          ← IdempotencyRecord.expireAt           @map("expire_at")
 *   唯一键 uk_scope_key(scope, idempotency_key) → Prisma where 输入名 `scope_idempotencyKey`
 */

import { Prisma, type PrismaClient } from '@prisma/client';
import { IdempotencyStatus } from '@/constants/enums';
import { getPrisma } from '@/core/prisma';
import { jsonReplacer } from '@/core/response';
import type { IdempotencyRecord, IdempotencyStore } from '@/middlewares/idempotency';

/**
 * 简化的 Prisma 客户端形态（本仓储只用到这一个委托）。
 *
 * @description 用 `Pick` 收窄，既满足注入可打桩（单测传假对象），又不把整个 PrismaClient 暴露给仓储层
 */
export type DbClient = Pick<PrismaClient, 'idempotencyRecord'>;

/**
 * 接口 {@link IdempotencyRecord.fingerprint} 允许 `null`，而 DB 列 `request_fingerprint`
 * 是 **NOT NULL** 的 `VarChar(64)`。这里的转换规则（双向，必须成对出现）：
 * - 写入（{@link IdempotencyRepository.toDbFingerprint}）：`null` → 空串 `''`；
 * - 读回（{@link IdempotencyRepository.fromDbFingerprint}）：空串 `''` → `null`。
 *
 * 选空串而不是 `'NONE'` / `'NULL'` 这类哨兵值的原因：指纹本身是 sha256 十六进制串
 * （长度恒 32/64、字符集合固定 `[0-9a-f]`），空串与之**不可能冲突**，无需额外约定哨兵语义。
 */
const EMPTY_FINGERPRINT = '';

/** `get` 的查询投影：只取接口需要的四个字段 */
const RECORD_SELECT = {
  status: true,
  requestFingerprint: true,
  responseSnapshot: true,
  expireAt: true,
} as const;

/**
 * 判断异常是否为 Prisma 唯一键冲突（P2002）。
 *
 * @description 只有 P2002 表示「记录已存在、可走重抢分支」，其余（连库失败、字段超长、
 * 超时）必须原样抛出 —— 吞掉它们会让「数据库故障」被误判成「并发抢占失败」，
 * 客户端收到 409 后无限重试，真正的故障反而被掩盖。
 * @param error 捕获到的异常
 * @returns 是否为唯一键冲突
 */
function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/**
 * 幂等记录仓储（DB 版 {@link IdempotencyStore}）。
 *
 * @description 由 `src/app.ts` 在装配阶段通过 `setIdempotencyStore(new IdempotencyRepository())` 注册。
 * 本类不持有连接状态，`new` 出来不连库，因此无 MySQL 环境下也不会报错。
 */
export class IdempotencyRepository implements IdempotencyStore {
  /** 注入的 Prisma 客户端 */
  private readonly prisma: DbClient;

  /**
   * @param prisma Prisma 客户端，缺省取全局单例
   */
  constructor(prisma: DbClient = getPrisma()) {
    this.prisma = prisma;
  }

  /**
   * 查询幂等记录。
   *
   * @description **已过期（`expireAt <= now`）的记录一律视为不存在并返回 null**。
   * 否则过期的 SUCCESS 记录会被永久回放，用户拿到的永远是几天前的旧响应；
   * 而且过期记录本就应该被 {@link tryAcquire} 重抢覆盖掉，读出来只会造成语义打架。
   * @param scope 业务类型（如 `ORDER_CREATE:1`）
   * @param key 幂等号
   * @returns 记录；不存在或已过期返回 null
   */
  async get(scope: string, key: string): Promise<IdempotencyRecord | null> {
    const row = await this.prisma.idempotencyRecord.findUnique({
      where: { scope_idempotencyKey: { scope, idempotencyKey: key } },
      select: RECORD_SELECT,
    });

    if (row === null) {
      return null;
    }
    if (row.expireAt.getTime() <= Date.now()) {
      return null;
    }

    return {
      status: row.status,
      fingerprint: this.fromDbFingerprint(row.requestFingerprint),
      response: row.responseSnapshot,
    };
  }

  /**
   * 抢占幂等记录（**原子**）。
   *
   * 两阶段：
   * 1. `INSERT` 成功 → 首次抢占，直接返回 `true`；
   * 2. 撞 `uk_scope_key`（P2002）→ 记录已存在，改用**一条带条件的 `updateMany`** 重抢：
   *    仅当 `status = FAILED`（允许失败重试）或 `expireAt < now`（记录已过期）时才置回 PROCESSING，
   *    `count > 0` 即抢到。当前是 PROCESSING / SUCCESS 时 `count === 0`，返回 `false`。
   *
   * 为什么不能用 read-then-write：两个并发请求会同时读到 FAILED，然后都判定「可重抢」并各自
   * 写入，幂等当场失效。`updateMany` 的 `WHERE` 判定与写入在同一条 SQL 内，由 MySQL 行锁串行化。
   *
   * 重抢时必须清空 `responseSnapshot` 并刷新 `requestFingerprint`：
   * 重试的是**新的请求**，留着上一次的快照会让后续 `get` 回放出一个与本次请求不符的旧响应。
   *
   * @param scope 业务类型
   * @param key 幂等号
   * @param fingerprint 请求指纹（可为 null，写入时按 {@link EMPTY_FINGERPRINT} 规则转空串）
   * @param ttlSeconds 保留时长（秒）
   * @returns 是否抢占成功
   * @throws 非唯一键冲突的数据库异常原样抛出（连接失败 / 超时等不应被吞成「抢占失败」）
   */
  async tryAcquire(scope: string, key: string, fingerprint: string, ttlSeconds: number): Promise<boolean> {
    const now = new Date();
    const expireAt = new Date(now.getTime() + ttlSeconds * 1_000);

    try {
      await this.prisma.idempotencyRecord.create({
        data: {
          scope,
          idempotencyKey: key,
          requestFingerprint: this.toDbFingerprint(fingerprint),
          status: IdempotencyStatus.PROCESSING,
          expireAt,
        },
      });
      return true;
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
    }

    // 记录已存在：原子条件更新重抢（FAILED 允许重试 / 已过期可重新抢占）
    const updated = await this.prisma.idempotencyRecord.updateMany({
      where: {
        scope,
        idempotencyKey: key,
        OR: [{ status: IdempotencyStatus.FAILED }, { expireAt: { lt: now } }],
      },
      data: {
        status: IdempotencyStatus.PROCESSING,
        requestFingerprint: this.toDbFingerprint(fingerprint),
        responseSnapshot: Prisma.DbNull,
        expireAt,
      },
    });

    return updated.count > 0;
  }

  /**
   * 标记成功并保存首次响应快照。
   *
   * @description ⚠️ 落库前**必须**过一遍 bigint 安全序列化：响应信封里的 `orderId` / `amount`
   * 等字段是 Prisma `BigInt`（JS `bigint`），而 `response_snapshot` 是 `Json` 列，
   * Prisma 写 Json 走原生 `JSON.stringify`，遇到 bigint 直接抛
   * `TypeError: Do not know how to serialize a BigInt`。这个异常在 tsc 与 mock 单测下
   * 都不会暴露，只有连真库才炸，属于典型运行时事故。
   * {@link jsonReplacer} 把 bigint 转成 number，超出 `Number.MAX_SAFE_INTEGER` 时降级为字符串。
   * @param scope 业务类型
   * @param key 幂等号
   * @param response 首次成功响应的完整信封
   * @returns void
   */
  async complete(scope: string, key: string, response: unknown): Promise<void> {
    const snapshot = JSON.parse(JSON.stringify(response, jsonReplacer)) as Prisma.InputJsonValue;

    await this.prisma.idempotencyRecord.updateMany({
      where: { scope, idempotencyKey: key },
      data: { status: IdempotencyStatus.SUCCESS, responseSnapshot: snapshot },
    });
  }

  /**
   * 标记失败，允许后续重试。
   *
   * @description **只在 `status = PROCESSING` 时置 FAILED**。绝不无条件覆盖 ——
   * 那会把「已成功下单」的 SUCCESS 记录被后续一次失败请求重置成可重试，
   * 等于亲手打开重复下单的口子（客户端重试一次就多下一单）。
   * @param scope 业务类型
   * @param key 幂等号
   * @returns void
   */
  async fail(scope: string, key: string): Promise<void> {
    await this.prisma.idempotencyRecord.updateMany({
      where: { scope, idempotencyKey: key, status: IdempotencyStatus.PROCESSING },
      data: { status: IdempotencyStatus.FAILED },
    });
  }

  /**
   * 指纹写库转换：`null` → 空串（DB 列 NOT NULL）。
   *
   * @param fingerprint 接口层指纹（可为 null）
   * @returns 落库值
   */
  private toDbFingerprint(fingerprint: string | null): string {
    return fingerprint ?? EMPTY_FINGERPRINT;
  }

  /**
   * 指纹读回转换：空串 → `null`（还原接口层的可空语义）。
   *
   * @param value DB 中的指纹列值
   * @returns 接口层指纹
   */
  private fromDbFingerprint(value: string): string | null {
    return value === EMPTY_FINGERPRINT ? null : value;
  }
}
