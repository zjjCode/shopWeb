/**
 * @file server/prisma/seed/fundAccount.seed.ts
 * @description 平台现金账户种子：1 条 PLATFORM_CASH（T006）
 * @module seed
 * @see docs/03-database.md §8.1 #1（平台现金账户）/ §1.3（单号前缀）
 * @author 软件开发团队
 * @created 2026-09-04
 *
 * 设计要点：
 * 1. `accountNo` 引用 `ID_PREFIX.PLATFORM_CASH_ACCOUNT` 常量（'ACC_PLATFORM_CASH'），
 *    不写裸字符串，避免与 `src/config/constants.ts` 的权威前缀脱节。
 * 2. `userId` 恒 `null`：PLATFORM_CASH 为全局账户，模型注释明确「其 userId 恒 NULL」。
 * 3. 金额单位为「分」：balance / frozenBalance / totalIn / totalOut 初始均为 0。
 * 4. 幂等 `upsert`，可重复执行。
 */

import type { PrismaClient } from '@prisma/client';
import { ID_PREFIX } from '@/config/constants';

/**
 * 写入 1 条平台现金账户。
 *
 * @param prisma PrismaClient 实例
 * @returns 写入条数（恒为 1；已存在则为更新后仍存在 1 条）
 */
export async function seedFundAccounts(prisma: PrismaClient): Promise<number> {
  await prisma.fundAccount.upsert({
    where: { accountNo: ID_PREFIX.PLATFORM_CASH_ACCOUNT },
    create: {
      accountNo: ID_PREFIX.PLATFORM_CASH_ACCOUNT,
      accountType: 'PLATFORM_CASH',
      userId: null,
      name: '平台现金账户',
      currency: 'CNY',
      balance: 0,
      frozenBalance: 0,
      totalIn: 0,
      totalOut: 0,
      status: 'ACTIVE',
    },
    update: {
      name: '平台现金账户',
      currency: 'CNY',
      status: 'ACTIVE',
    },
  });

  const count = await prisma.fundAccount.count({ where: { accountType: 'PLATFORM_CASH' } });
  console.warn(`[seed:fund] 平台现金账户 ${count}`);
  return count;
}
