/**
 * @file server/src/core/accountLock.ts
 * @description 账户锁：统一加锁顺序（防死锁）+ FOR UPDATE 行锁封装
 * @module core
 * @see docs/03-database.md §3.6（资金账户）、§1.4（并发更新原则）
 * @author 软件开发团队
 * @created 2026-09-03
 * @updated 2026-09-04
 *
 * 死锁是怎么产生的：
 * 余额消费要同时锁「用户余额账户」和「平台现金账户」两行。
 * 若请求 A 先锁用户、请求 B 先锁平台，两者各持一把锁再等对方的，
 * MySQL 只能回滚其中一个（1213）。这是**加锁顺序不一致**导致的经典死锁。
 *
 * 解法：全局约定「按 account_no 字典序升序加锁」，任何代码路径都走
 * {@link lockAccounts}，顺序就永远一致，死锁在结构上被消除。
 *
 * [2026-09-04 修正] 原生 SQL 字段名 `subject_id` → `user_id`
 * ------------------------------------------------------------------
 * `fund_accounts` 表根本没有 `subject_id` 列（docs/03-database.md §2 中该标识符
 * 出现 0 次，实际字段是 `userId BigInt? @map("user_id")`）。
 *
 * 为什么编译期没抓到：`$queryRaw` 的 SQL 是字符串，结果类型由泛型手工声明，
 * Prisma 与 TypeScript 都**无法校验列名是否真实存在** —— 编译能过、运行时才炸
 * （MySQL 1054 Unknown column）。这是"原生 SQL 不受 Prisma 类型保护"的典型代价：
 * 凡写原生 SQL，字段名必须与 schema 逐字核对，不能凭记忆。
 *
 * 同时修正了平台账户的语义：`PLATFORM_CASH` 的 `user_id` 恒为 **NULL**（见
 * FundAccount 模型注释：「PLATFORM_CASH 恒 NULL；USER_BALANCE 必填且唯一」），
 * 因此传 0 去匹配永远匹配不到。平台账户请改用 {@link lockPlatformCashAccount}。
 */

import { Prisma } from '@prisma/client';
import { ID_PREFIX } from '@/config/constants';
import { BusinessError } from '@/core/errors';
import { ErrorCode } from '@/core/errors/errorCodes';

/**
 * `FundAccountType` 中「归属用户」的账户类型。
 *
 * @description 只有这两类账户持有非 NULL 的 `user_id`，
 * 因此只有它们能走 {@link lockAccountsBySubject} 的「按用户维度定位」路径
 */
const USER_OWNED_ACCOUNT_TYPES: readonly string[] = ['USER_BALANCE', 'POINT'];

/** `fund_accounts` 行锁查询返回的最小字段集 */
export interface LockedAccount {
  /** 账户 ID */
  id: number;
  /** 账户编号（平台现金 / 用户余额） */
  accountNo: string;
  /** 账户类型：PLATFORM_CASH / USER_BALANCE / POINT */
  accountType: string;
  /**
   * 归属用户 ID。
   *
   * @description 对应 `fund_accounts.user_id`：
   *   · USER_BALANCE / POINT 账户 —— 必填，为该用户的 ID
   *   · PLATFORM_CASH 账户 —— 恒为 NULL，此处归一化为 `0`（`Number(null) === 0`）
   */
  userId: number;
  /** 当前余额（分） */
  balance: number;
  /** 冻结余额（分） */
  frozenBalance: number;
  /** 账户状态：ACTIVE / FROZEN */
  status: string;
}

/**
 * 把账户编号按字典序升序排序。
 *
 * @description 全局唯一的加锁顺序约定。入参顺序不影响加锁顺序，
 * 因此调用方可以按业务语义随意传参，不必关心排列
 * @param accountNos 待加锁的账户编号
 * @returns 去重并按字典序升序排列的新数组（不修改入参）
 */
export function sortAccountNosForLock(accountNos: readonly string[]): string[] {
  return Array.from(new Set(accountNos)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * 按统一顺序锁定多行账户（SELECT ... FOR UPDATE）。
 *
 * 为什么用 `$queryRaw` 而不是 `findMany`：
 * Prisma 的查询方法无法表达 `FOR UPDATE`，而行锁是余额扣减正确性的唯一保障 ——
 * 不加锁的「读余额 → 判断 → 写余额」在并发下会超卖。
 *
 * @description 必须在事务内调用（`tx` 由 {@link withTransaction} 提供），
 * 否则 `FOR UPDATE` 在语句执行完即释放，锁不住任何东西
 * @param tx 事务客户端
 * @param accountNos 需要加锁的账户编号（顺序无关，内部统一排序）
 * @returns 按「入参顺序」排列的账户行（调用方按业务语义取用，无需关心加锁顺序）
 * @throws {BusinessError} 账户不存在或数量不足时抛出（账户缺失属异常，正常应在开户时创建）
 */
export async function lockAccounts(
  tx: Prisma.TransactionClient,
  accountNos: readonly string[],
): Promise<LockedAccount[]> {
  if (accountNos.length === 0) {
    return [];
  }

  const orderedNos = sortAccountNosForLock(accountNos);

  // 列名必须与 prisma/schema.prisma 的 model FundAccount 逐字一致：
  // id / account_no / account_type / user_id / balance / frozen_balance / status
  const rows = await tx.$queryRaw<
    {
      id: bigint;
      account_no: string;
      account_type: string;
      user_id: bigint | null;
      balance: bigint;
      frozen_balance: bigint;
      status: string;
    }[]
  >(
    Prisma.sql`
      SELECT id, account_no, account_type, user_id, balance, frozen_balance, status
      FROM fund_accounts
      WHERE account_no IN (${Prisma.join(orderedNos.map((no) => Prisma.sql`${no}`))})
      ORDER BY account_no ASC
      FOR UPDATE
    `,
  );

  if (rows.length !== orderedNos.length) {
    const found = new Set(rows.map((row) => row.account_no));
    const missing = orderedNos.filter((no) => !found.has(no));
    // 账户缺失意味着开户流程有漏洞，继续走下去会记出「无主流水」，必须立刻中断
    throw new BusinessError('资金账户不存在，无法完成记账', {
      code: ErrorCode.BALANCE_ACCOUNT_NOT_FOUND,
      data: { missingAccountNos: missing },
    });
  }

  const byNo = new Map<string, LockedAccount>();
  for (const row of rows) {
    byNo.set(row.account_no, {
      id: Number(row.id),
      accountNo: row.account_no,
      accountType: row.account_type,
      // PLATFORM_CASH 的 user_id 为 NULL，Number(null) === 0，即「无归属用户」
      userId: Number(row.user_id ?? 0),
      balance: Number(row.balance),
      frozenBalance: Number(row.frozen_balance),
      status: row.status,
    });
  }

  // 还原成调用方传入的顺序：加锁顺序是内部实现细节，不应泄漏给业务代码
  return accountNos.map((no) => {
    const account = byNo.get(no);
    if (account === undefined) {
      throw new BusinessError('资金账户不存在，无法完成记账', {
        code: ErrorCode.BALANCE_ACCOUNT_NOT_FOUND,
        data: { missingAccountNos: [no] },
      });
    }
    return account;
  });
}

/**
 * 锁定平台现金账户。
 *
 * @description 平台账户的 `user_id` 恒为 NULL，**不能**用「按用户维度」的方式定位，
 * 只能按固定的 `account_no`（`ACC_PLATFORM_CASH`）加锁
 * @param tx 事务客户端
 * @returns 平台现金账户行
 */
export function lockPlatformCashAccount(tx: Prisma.TransactionClient): Promise<LockedAccount[]> {
  return lockAccounts(tx, [ID_PREFIX.PLATFORM_CASH_ACCOUNT]);
}

/**
 * 锁定单个用户的余额账户。
 *
 * @param tx 事务客户端
 * @param userId 用户 ID
 * @returns 用户余额账户行
 */
export function lockUserBalanceAccount(tx: Prisma.TransactionClient, userId: number): Promise<LockedAccount[]> {
  return lockAccountsBySubject(tx, 'USER_BALANCE', userId);
}

/**
 * 按「账户类型 + 归属用户 ID」锁定账户。
 *
 * ⚠️ 适用范围：**只用于用户维度账户**（`USER_BALANCE` / `POINT`）。
 * `PLATFORM_CASH` 账户的 `user_id` **恒为 NULL**（见 docs/03-database.md §2
 * model FundAccount：「PLATFORM_CASH 恒 NULL；USER_BALANCE 必填且唯一」），
 * 用任何 userId 去匹配都查不到 —— 平台账户请改用 {@link lockPlatformCashAccount}
 * （按固定 `account_no` 定位）。本函数在入口处直接拒绝 `PLATFORM_CASH`，
 * 避免误用后只抛出语义模糊的「账户不存在」，掩盖真正的用法错误。
 *
 * @description 用于只知道 userId 而不知道 account_no 的场景；
 * 内部先解析出 account_no 再走统一排序的 {@link lockAccounts}
 * @param tx 事务客户端
 * @param accountType 账户类型，**仅支持 USER_BALANCE / POINT**
 * @param userId 归属用户 ID
 * @returns 账户行
 * @throws {BusinessError} 传入 PLATFORM_CASH 时抛出（用法错误）；账户不存在时抛出
 */
export async function lockAccountsBySubject(
  tx: Prisma.TransactionClient,
  accountType: string,
  userId: number,
): Promise<LockedAccount[]> {
  // 防御：平台账户不归属任何用户，此路径永远查不到，直接点明正确用法
  if (accountType === 'PLATFORM_CASH') {
    throw new BusinessError('平台现金账户不归属任何用户，请使用 lockPlatformCashAccount 加锁', {
      code: ErrorCode.BALANCE_ACCOUNT_NOT_FOUND,
      data: { accountType, userId },
    });
  }

  const rows = await tx.$queryRaw<{ account_no: string }[]>(
    Prisma.sql`
      SELECT account_no
      FROM fund_accounts
      WHERE account_type = ${accountType} AND user_id = ${userId}
      LIMIT 1
    `,
  );

  const accountNo = rows[0]?.account_no;
  if (accountNo === undefined) {
    throw new BusinessError('资金账户不存在，无法完成记账', {
      code: ErrorCode.BALANCE_ACCOUNT_NOT_FOUND,
      data: { accountType, userId },
    });
  }

  return lockAccounts(tx, [accountNo]);
}

/**
 * 锁定订单行（`SELECT ... FOR UPDATE`）。
 *
 * @description 订单状态机与账户记账经常同时出现在同一个事务里
 * （如「余额支付」= 改订单状态 + 扣余额）。这两类资源也必须按固定顺序加锁，
 * 约定：**先锁订单、再锁账户**，与 {@link lockAccounts} 组合即可保证全局无环
 * @param tx 事务客户端
 * @param orderNo 订单号
 * @returns 订单行（id / order_no / status / pay_amount）
 * @throws {BusinessError} 订单不存在时抛出
 */
export async function lockOrderByNo(
  tx: Prisma.TransactionClient,
  orderNo: string,
): Promise<{ id: number; orderNo: string; status: string; payAmount: number }> {
  const rows = await tx.$queryRaw<{ id: bigint; order_no: string; status: string; pay_amount: bigint }[]>(
    Prisma.sql`
      SELECT id, order_no, status, pay_amount
      FROM orders
      WHERE order_no = ${orderNo}
      LIMIT 1
      FOR UPDATE
    `,
  );

  const row = rows[0];
  if (row === undefined) {
    throw new BusinessError('订单不存在', { code: ErrorCode.ORDER_NOT_FOUND });
  }

  return {
    id: Number(row.id),
    orderNo: row.order_no,
    status: row.status,
    payAmount: Number(row.pay_amount),
  };
}

/**
 * 判断账户类型是否为「归属用户」的账户。
 *
 * @description 供调用方在拼装加锁清单前自检，避免把 PLATFORM_CASH
 * 误传给 {@link lockAccountsBySubject}
 * @param accountType 账户类型
 * @returns 该类型账户是否归属某个具体用户
 */
export function isUserOwnedAccountType(accountType: string): boolean {
  return USER_OWNED_ACCOUNT_TYPES.includes(accountType);
}
