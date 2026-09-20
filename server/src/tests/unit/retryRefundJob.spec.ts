/**
 * @file server/src/tests/unit/retryRefundJob.spec.ts
 * @description 退款重试 Job + 分布式锁单元测试（T080-D / T091）
 * @module tests/unit
 * @see server/src/jobs/handlers/retryRefund.job.ts、server/src/core/distLock.ts
 * @author 软件开发团队
 * @created 2026-09-18
 *
 * 覆盖：
 * 1. scanFailedRefunds：扫描条件（status=FAILED / retry_count<MAX / nextRetryAt<=now）、排序、分页正确。
 * 2. retryRefund：透传 refundService.retry 的结果字面量。
 * 3. tryAcquireLock：Redis 不可用/命令失败 → 降级放行(true)；持锁成功(true)/被占用(false)。
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { getPrisma } from '@/core/prisma';
import { getRedis } from '@/core/redis';
import { tryAcquireLock } from '@/core/distLock';
import { scanFailedRefunds, retryRefund } from '@/jobs/handlers/retryRefund.job';
import { refundService } from '@/services/RefundService';
import { REFUND_RULE } from '@/constants/bizRules';

jest.mock('@/config', () => ({
  config: {
    env: 'test',
    redis: { keyPrefix: 'shop' },
    log: { level: 'error', dir: '' },
  },
  isProduction: false,
  isTest: true,
  isDevelopment: false,
}));

jest.mock('@/core/prisma', () => ({
  getPrisma: jest.fn(() => ({})),
}));

jest.mock('@/core/redis', () => ({
  getRedis: jest.fn(),
}));

// 隔离真实 refundService 单例构造（避免触发 FundService / Prisma 初始化），
// 用可控的假 retry 替代。RefundService 类本身本测试无需。
jest.mock('@/services/RefundService', () => ({
  RefundService: class {},
  refundService: { retry: jest.fn() },
}));

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyAsyncFn = (...args: any[]) => Promise<any>;
/* eslint-enable @typescript-eslint/no-explicit-any */

describe('退款重试 Job + 分布式锁（T080-D / T091）', () => {
const prismaMock = getPrisma as unknown as jest.Mock;
const redisMock = getRedis as unknown as jest.Mock;
const retryFn = refundService.retry as unknown as jest.Mock<AnyAsyncFn>;

  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.mockReturnValue({ refund: { findMany: jest.fn<AnyAsyncFn>() } });
  });

  // --------------------------------------------------------------------------
  // scanFailedRefunds
  // --------------------------------------------------------------------------

  it('scanFailedRefunds：扫描条件 / 排序 / 分页正确，且排除已超 RETRY_MAX 的终态单', async () => {
    const findMany = jest.fn<AnyAsyncFn>().mockResolvedValue([
      { refundNo: 'R1' },
      { refundNo: 'R2' },
    ]);
    prismaMock.mockReturnValue({ refund: { findMany } });

    const result = await scanFailedRefunds(5);

    expect(result).toEqual(['R1', 'R2']);
    const arg = findMany.mock.calls[0]?.[0] as {
      where: { status: string; retryCount: { lt: number }; nextRetryAt: { lte: Date } };
      orderBy: { nextRetryAt: 'asc' | 'desc' };
      take: number;
    };
    expect(arg.where.status).toBe('FAILED');
    expect(arg.where.retryCount).toEqual({ lt: REFUND_RULE.RETRY_MAX });
    expect(arg.where.nextRetryAt.lte).toBeInstanceOf(Date);
    expect(arg.orderBy.nextRetryAt).toBe('asc');
    expect(arg.take).toBe(5);
  });

  // --------------------------------------------------------------------------
  // retryRefund 包装
  // --------------------------------------------------------------------------

  it("retryRefund：透传 refundService.retry 的结果字面量", async () => {
    retryFn.mockResolvedValue('retried');

    const result = await retryRefund('R9');

    expect(result).toBe('retried');
    expect(retryFn).toHaveBeenCalledWith('R9');
  });

  // --------------------------------------------------------------------------
  // tryAcquireLock
  // --------------------------------------------------------------------------

  it('tryAcquireLock：Redis 不可用 → 降级放行 true', async () => {
    redisMock.mockReturnValue(null);

    expect(await tryAcquireLock('job:retry-refund')).toBe(true);
  });

  it('tryAcquireLock：SET NX 返回 OK → 获取成功 true', async () => {
    const set = jest.fn<AnyAsyncFn>().mockResolvedValue('OK');
    redisMock.mockReturnValue({ set });

    const got = await tryAcquireLock('job:retry-refund', 90_000);

    expect(got).toBe(true);
    expect(set).toHaveBeenCalledWith('shop:lock:job:retry-refund', '1', 'PX', 90_000, 'NX');
  });

  it('tryAcquireLock：SET NX 返回 null（被占用）→ false', async () => {
    const set = jest.fn<AnyAsyncFn>().mockResolvedValue(null);
    redisMock.mockReturnValue({ set });

    expect(await tryAcquireLock('job:retry-refund')).toBe(false);
  });

  it('tryAcquireLock：命令抛错 → 降级放行 true', async () => {
    const set = jest.fn<AnyAsyncFn>().mockRejectedValue(new Error('redis down'));
    redisMock.mockReturnValue({ set });

    expect(await tryAcquireLock('job:retry-refund')).toBe(true);
  });
});
