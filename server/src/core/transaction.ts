/**
 * @file server/src/core/transaction.ts
 * @description withTransaction() 封装：超时控制 + 死锁/锁等待重试 + 回滚必记日志
 * @module core
 * @see docs/02-architecture.md §5.3（事务：提交成功 / 回滚必记）、docs/03-database.md §1.4（状态变更原则）
 * @author 软件开发团队
 * @created 2026-09-03
 *
 * 铁律：**事务内禁止任何外部 HTTP 调用**（支付/物流/短信）。
 * 外部调用的耗时不可控，会把数据库行锁持有时间从毫秒级拉到秒级，
 * 在高并发下迅速演化为大面积锁等待甚至死锁。
 * 正确姿势是「事务内落库 → 提交 → 事务外调用 → 回调投递队列再改状态」。
 */

import { Prisma } from '@prisma/client';
import { getPrisma } from '@/core/prisma';
import { logError, logInfo } from '@/core/logger/logger';
import { sleep } from '@/utils/sleep';

/** 事务默认超时（毫秒）：超过则 Prisma 主动回滚，避免长事务拖垮连接池 */
const DEFAULT_TIMEOUT_MS = 10_000;

/** 等待事务开启的最大时长（毫秒） */
const DEFAULT_MAX_WAIT_MS = 5_000;

/** 死锁 / 锁等待超时的最大重试次数 */
const DEFAULT_MAX_RETRIES = 3;

/** MySQL 错误码：1213 死锁、1205 锁等待超时 */
const RETRYABLE_MYSQL_CODES = new Set([1213, 1205]);

/** 事务执行选项 */
export interface TransactionOptions {
  /** 事务超时（毫秒），默认 10000 */
  timeoutMs?: number;
  /** 获取连接的最大等待时长（毫秒），默认 5000 */
  maxWaitMs?: number;
  /** 死锁重试次数（不含首次执行），默认 3 */
  maxRetries?: number;
  /** 隔离级别，默认使用数据库配置（MySQL 默认 REPEATABLE READ） */
  isolationLevel?: Prisma.TransactionIsolationLevel;
  /** 业务标签，写进日志便于定位是哪个用例在开事务 */
  label?: string;
}

/**
 * 判断异常是否为「可重试的并发冲突」。
 *
 * @description 只有死锁与锁等待超时值得重试：这类错误的语义是「本轮竞争失败，重试大概率成功」。
 * 唯一键冲突、业务校验失败重试多少次都是同样的结果，重试只会放大数据库压力。
 * @param error 捕获到的异常
 * @returns 是否可重试
 */
export function isRetryableTransactionError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const candidate = error as { code?: unknown; message?: unknown };

  // Prisma 会把驱动错误码挂在 code 上（如 P2034 事务冲突）
  if (typeof candidate.code === 'string' && candidate.code === 'P2034') {
    return true;
  }
  if (typeof candidate.code === 'number' && RETRYABLE_MYSQL_CODES.has(candidate.code)) {
    return true;
  }

  const message = typeof candidate.message === 'string' ? candidate.message : '';
  return message.includes('Deadlock') || message.includes('Lock wait timeout') || message.includes('deadlock detected');
}

/**
 * 在事务中执行业务回调，遇到死锁/锁等待超时自动重试。
 *
 * 回滚必记日志的原因：
 * 资金类操作回滚意味着「用户看到失败」，但如果没有日志就无法区分
 * 「业务规则拒绝」与「系统异常回滚」，后者才是需要告警的。
 *
 * @param fn 事务回调，入参为事务客户端（**不得在其中发起外部 HTTP 调用**）
 * @param options 事务选项
 * @returns 业务回调的返回值
 * @throws 重试耗尽后抛出最后一次异常，由 errorHandler 统一转为响应
 */
export async function withTransaction<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxWaitMs = DEFAULT_MAX_WAIT_MS,
    maxRetries = DEFAULT_MAX_RETRIES,
    isolationLevel,
    label = 'anonymous',
  } = options;

  const prisma = getPrisma();
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const result = await prisma.$transaction(fn, {
        timeout: timeoutMs,
        maxWait: maxWaitMs,
        ...(isolationLevel !== undefined ? { isolationLevel } : {}),
      });

      logInfo('tx.committed', { ctx: { label, attempt } });
      return result;
    } catch (error) {
      lastError = error;

      if (isRetryableTransactionError(error) && attempt < maxRetries) {
        // 指数退避 + 抖动：并发事务同时重试会再次撞在一起，
        // 加随机抖动让各实例的重试时刻错开，显著提高第二轮成功率
        const backoffMs = 2 ** attempt * 50 + Math.floor(Math.random() * 50);
        logInfo('tx.retrying', {
          ctx: { label, attempt, nextAttempt: attempt + 1, backoffMs, reason: (error as Error).message },
        });
        await sleep(backoffMs);
        continue;
      }

      logError('tx.rolled_back', error, {
        ctx: { label, attempt, retried: attempt > 0, retryable: isRetryableTransactionError(error) },
      });
      throw error;
    }
  }

  // 理论上不可达（循环内必然 return 或 throw），保留以让 TS 确认所有路径都有返回值
  logError('tx.exhausted', lastError, { ctx: { label, maxRetries } });
  throw lastError instanceof Error ? lastError : new Error('事务重试耗尽');
}
