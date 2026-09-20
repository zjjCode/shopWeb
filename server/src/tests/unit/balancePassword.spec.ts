/**
 * @file server/src/tests/unit/balancePassword.spec.ts
 * @description 支付密码校验中间件（T070）单元测试：校验顺序编排 + Redis 失败计数全分支
 * @module tests/unit
 * @see server/src/middlewares/balancePassword.ts、docs/12-phase12-plan.md
 * @author 软件开发团队
 * @created 2026-09-20
 *
 * 覆盖 requireBalancePassword 的中间件逻辑：
 * 1. 未登录 → ACCESS_TOKEN_EXPIRED（10005）；
 * 2. 已锁定（Redis 失败计数 >= 5）→ PAY_PASSWORD_LOCKED（61008）；
 * 3. 未设置支付密码 → PAY_PASSWORD_NOT_SET（61009）；
 * 4. 缺少 payPassword 字段 → PAY_PASSWORD_NOT_SET（61009，请输入支付密码）；
 * 5. 密码错误 → PAY_PASSWORD_INCORRECT（61007）且 Redis incr + expire 被调用；
 * 6. 密码正确 → next() 且 Redis del（清除失败计数）被调用。
 *
 * 策略：mock `@/core/redis` 的 withRedis，注入可控的 fakeRedis；用 setPayPasswordHandlers
 * 注入 verifier / checker 桩，逐分支验证 next 收到的错误码。
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Request, Response } from 'express';
import { ErrorCode } from '@/core/errors/errorCodes';
import { requireBalancePassword, setPayPasswordHandlers } from '@/middlewares/balancePassword';

jest.mock('@/config', () => ({
  config: { env: 'test', redis: { keyPrefix: 'shop' }, log: { level: 'error', dir: '' } },
  isProduction: false,
  isTest: true,
  isDevelopment: false,
}));

jest.mock('@/core/prisma', () => ({
  getPrisma: jest.fn(() => ({})),
}));

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyAsyncFn = (...args: any[]) => Promise<any>;

const fakeRedis = {
  get: jest.fn<AnyAsyncFn>().mockResolvedValue(null),
  incr: jest.fn<AnyAsyncFn>().mockResolvedValue(1),
  expire: jest.fn<AnyAsyncFn>().mockResolvedValue(1),
  del: jest.fn<AnyAsyncFn>().mockResolvedValue(1),
};

jest.mock('@/core/redis', () => ({
  withRedis: jest.fn(),
}));

import { withRedis } from '@/core/redis';

/** 让 withRedis 把回调喂给我们的 fakeRedis */
function useFakeRedis(): void {
  (withRedis as unknown as jest.Mock<AnyAsyncFn>).mockImplementation(
    async (fn: (redis: any) => Promise<any>) => fn(fakeRedis),
  );
}

/** 构造一个带 auth 的请求对象 */
function authedReq(body: Record<string, unknown>): Request {
  return {
    auth: { userId: 1, scope: 'shop', tokenVersion: 1, jti: 'x' },
    body,
  } as unknown as Request;
}

/** 等待中间件内部 async IIFE 跑完 */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('requireBalancePassword 中间件（T070）', () => {
  let verifier: jest.Mock<AnyAsyncFn>;
  let checker: jest.Mock<AnyAsyncFn>;

  beforeEach(() => {
    verifier = jest.fn<AnyAsyncFn>();
    checker = jest.fn<AnyAsyncFn>();
    setPayPasswordHandlers(verifier as any, checker as any);
    useFakeRedis();
    fakeRedis.get.mockReset();
    fakeRedis.incr.mockClear();
    fakeRedis.expire.mockClear();
    fakeRedis.del.mockClear();
  });

  it('未登录 → ACCESS_TOKEN_EXPIRED（10005）', async () => {
    const req = { auth: undefined, body: { payPassword: 'x' } } as unknown as Request;
    const res = {} as Response;
    const next = jest.fn();

    requireBalancePassword('payPassword')(req, res, next);
    await flush();

    expect(next).toHaveBeenCalledTimes(1);
    expect((next as jest.Mock).mock.calls[0][0]).toMatchObject({ code: ErrorCode.ACCESS_TOKEN_EXPIRED });
  });

  it('已锁定（失败计数 >= 5）→ PAY_PASSWORD_LOCKED（61008）', async () => {
    fakeRedis.get.mockResolvedValue('5'); // >= SECURITY_RULE.PAY_PASSWORD_MAX_FAILS(5)
    checker.mockResolvedValue(true);
    const req = authedReq({ payPassword: 'x' });
    const next = jest.fn();

    requireBalancePassword('payPassword')(req, {} as Response, next);
    await flush();

    expect(next).toHaveBeenCalledTimes(1);
    expect((next as jest.Mock).mock.calls[0][0]).toMatchObject({ code: ErrorCode.PAY_PASSWORD_LOCKED });
    expect(checker).not.toHaveBeenCalled();
  });

  it('未设置支付密码 → PAY_PASSWORD_NOT_SET（61009）', async () => {
    fakeRedis.get.mockResolvedValue(null);
    checker.mockResolvedValue(false);
    const req = authedReq({ payPassword: 'x' });
    const next = jest.fn();

    requireBalancePassword('payPassword')(req, {} as Response, next);
    await flush();

    expect(next).toHaveBeenCalledTimes(1);
    expect((next as jest.Mock).mock.calls[0][0]).toMatchObject({ code: ErrorCode.PAY_PASSWORD_NOT_SET });
    expect(verifier).not.toHaveBeenCalled();
  });

  it('缺少 payPassword 字段 → PAY_PASSWORD_NOT_SET（6099，请输入支付密码）', async () => {
    fakeRedis.get.mockResolvedValue(null);
    checker.mockResolvedValue(true);
    const req = authedReq({}); // 没有 payPassword
    const next = jest.fn();

    requireBalancePassword('payPassword')(req, {} as Response, next);
    await flush();

    expect(next).toHaveBeenCalledTimes(1);
    expect((next as jest.Mock).mock.calls[0][0]).toMatchObject({ code: ErrorCode.PAY_PASSWORD_NOT_SET });
  });

  it('密码错误 → PAY_PASSWORD_INCORRECT（61007）且累加失败计数', async () => {
    fakeRedis.get.mockResolvedValue(null);
    checker.mockResolvedValue(true);
    verifier.mockResolvedValue(false);
    const req = authedReq({ payPassword: 'wrong' });
    const next = jest.fn();

    requireBalancePassword('payPassword')(req, {} as Response, next);
    await flush();

    expect(next).toHaveBeenCalledTimes(1);
    expect((next as jest.Mock).mock.calls[0][0]).toMatchObject({ code: ErrorCode.PAY_PASSWORD_INCORRECT });
    expect(fakeRedis.incr).toHaveBeenCalledTimes(1);
    expect(fakeRedis.expire).toHaveBeenCalledTimes(1);
  });

  it('密码正确 → next() 且清除失败计数', async () => {
    fakeRedis.get.mockResolvedValue(null);
    checker.mockResolvedValue(true);
    verifier.mockResolvedValue(true);
    const req = authedReq({ payPassword: 'correct' });
    const next = jest.fn();

    requireBalancePassword('payPassword')(req, {} as Response, next);
    await flush();

    expect(next).toHaveBeenCalledTimes(1);
    expect((next as jest.Mock).mock.calls[0][0]).toBeUndefined();
    expect(fakeRedis.del).toHaveBeenCalledTimes(1);
  });
});
