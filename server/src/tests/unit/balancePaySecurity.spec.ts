/**
 * @file server/src/tests/unit/balancePaySecurity.spec.ts
 * @description 余额支付密码链路（T070）HTTP 级测试：缺密码 / 错密码 / 正确密码 / 未设置
 * @module tests/unit
 * @see server/src/routes/api/payment.routes.ts（balance-pay 装配）、docs/12-phase12-plan.md
 * @author 软件开发团队
 * @created 2026-09-20
 *
 * 用 supertest 跑一条「auth 桩 + validate + requireBalancePassword + 控制器桩」的最小链路，
 * 验证余额支付前支付密码校验真实生效：
 * - 缺 payPassword → 400（validate 字段校验拦截）；
 * - 未设置支付密码（checker=false）→ 409（61009）；
 * - 密码错误（verifier=false）→ 409（61007，BusinessError 默认 httpStatus 即 409）；
 * - 密码正确 → 200（sendOk 包裹，body.code=0）。
 *
 * 说明：真实路由还额外挂了 `auth({scope:'shop'})` 与 `payCreateRateLimit()`，二者在其它测试已覆盖，
 * 本测试聚焦安全收口最核心的 validate + requireBalancePassword 组合。
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Request, Response, NextFunction } from 'express';
import express from 'express';
import request from 'supertest';
import { ErrorCode } from '@/core/errors/errorCodes';
import { requireBalancePassword, setPayPasswordHandlers, type PayPasswordVerifier, type PayPasswordStatusChecker } from '@/middlewares/balancePassword';
import { validate } from '@/middlewares/validate';
import {
  balancePaySchema,
  paymentNoParamSchema,
} from '@/validators/payment.validator';

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

/** 把 withRedis 喂给可控 fakeRedis，且 get 默认返回 null（不锁） */
function useFakeRedis(): void {
  (withRedis as unknown as jest.Mock<AnyAsyncFn>).mockImplementation(
    async (fn: (redis: any) => Promise<any>) => fn(fakeRedis),
  );
}

/** 注册 verifier / checker 桩（避免 bare jest.fn 触发 never 类型陷阱） */
function setHandlers(verifierResolves: boolean, checkerResolves: boolean): void {
  const verifier = jest.fn<AnyAsyncFn>();
  const checker = jest.fn<AnyAsyncFn>();
  verifier.mockResolvedValue(verifierResolves);
  checker.mockResolvedValue(checkerResolves);
  setPayPasswordHandlers(
    verifier as unknown as PayPasswordVerifier,
    checker as unknown as PayPasswordStatusChecker,
  );
}

/** 构造最小链路：auth 桩 + validate + requireBalancePassword + 控制器桩 */
function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.auth = { userId: 1, scope: 'shop', tokenVersion: 1, jti: 'x' };
    next();
  });
  app.post(
    '/payments/:paymentNo/balance-pay',
    validate({ params: paymentNoParamSchema, body: balancePaySchema }),
    requireBalancePassword('payPassword'),
    (_req: Request, res: Response) => res.status(200).json({ ok: true }),
  );
  // 轻量错误处理器：忠实读取 error.httpStatus（ValidationError=400 / BusinessError=409），
  // 不依赖 logger / requestContext，避免测试环境副作用；生产由 errorHandler 兜底。
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = typeof err?.httpStatus === 'number' ? err.httpStatus : 500;
    res
      .status(status)
      .json({ code: err?.code ?? 90007, message: err?.message ?? 'error', data: err?.data ?? null });
  });
  return app;
}

describe('余额支付密码链路（T070）', () => {
  beforeEach(() => {
    fakeRedis.get.mockReset();
    fakeRedis.get.mockResolvedValue(null);
    useFakeRedis();
  });

  it('缺 payPassword → 400（validate 字段校验拦截）', async () => {
    const app = buildApp();
    const res = await request(app).post('/payments/PAY123/balance-pay').send({ foo: 'bar' });
    expect(res.status).toBe(400);
  });

  it('未设置支付密码（checker=false）→ 409（61009）', async () => {
    setHandlers(true, false);
    const app = buildApp();
    const res = await request(app).post('/payments/PAY123/balance-pay').send({ payPassword: 'whatever' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe(ErrorCode.PAY_PASSWORD_NOT_SET);
  });

  it('密码错误（verifier=false）→ 409（61007，body.code 区分）', async () => {
    setHandlers(false, true);
    const app = buildApp();
    const res = await request(app).post('/payments/PAY123/balance-pay').send({ payPassword: 'wrong' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe(ErrorCode.PAY_PASSWORD_INCORRECT);
  });

  it('密码正确 → 200（链路放行到控制器）', async () => {
    setHandlers(true, true);
    const app = buildApp();
    const res = await request(app).post('/payments/PAY123/balance-pay').send({ payPassword: 'correct' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
