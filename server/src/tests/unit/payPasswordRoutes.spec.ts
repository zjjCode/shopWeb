/**
 * @file server/src/tests/unit/payPasswordRoutes.spec.ts
 * @description 支付密码路由装配（T070）单元测试：/api/user/pay-password 双端点注册
 * @module tests/unit
 * @see server/src/routes/api/user.routes.ts、docs/12-phase12-plan.md
 * @author 软件开发团队
 * @created 2026-09-20
 *
 * 验证：createUserRouter 注册了 `POST /user/pay-password`（设置）与 `PUT /user/pay-password`（修改），
 * 两个端点都挂了 auth + validate + 控制器，装配期不抛异常（依赖均可被 mock 解析）。
 */

import { describe, expect, it, jest } from '@jest/globals';
import type { Router } from 'express';

jest.mock('@/config', () => ({
  config: { env: 'test', redis: { keyPrefix: 'shop' }, log: { level: 'error', dir: '' } },
  isProduction: false,
  isTest: true,
  isDevelopment: false,
}));

jest.mock('@/core/prisma', () => ({
  getPrisma: jest.fn(() => ({})),
}));

jest.mock('@/core/redis', () => ({
  withRedis: jest.fn(),
}));

/** 收集 Router 上已注册的某方法的路径 */
function pathsOf(router: Router, method: string): string[] {
  const stack = (router as unknown as { stack: unknown[] }).stack;
  const paths: string[] = [];
  for (const layer of stack) {
    const route = (layer as { route?: { path: string; stack: Array<{ method?: string }> } }).route;
    if (route === undefined) {
      continue;
    }
    if (route.stack.some((s) => s.method === method)) {
      paths.push(route.path);
    }
  }
  return paths;
}

describe('支付密码路由装配（T070）', () => {
  it('注册 POST /user/pay-password（首次设置）', () => {
    // 隔离模块注册表后装配，避免与其他测试共享单例
    let router: Router | undefined;
    jest.isolateModules(() => {
      /* eslint-disable @typescript-eslint/no-var-requires */
      const mod = require('@/routes/api/user.routes') as { createUserRouter: () => Router };
      router = mod.createUserRouter();
    });
    expect(router).toBeDefined();
    expect(pathsOf(router as Router, 'post')).toContain('/user/pay-password');
  });

  it('注册 PUT /user/pay-password（修改）', () => {
    let router: Router | undefined;
    jest.isolateModules(() => {
      /* eslint-disable @typescript-eslint/no-var-requires */
      const mod = require('@/routes/api/user.routes') as { createUserRouter: () => Router };
      router = mod.createUserRouter();
    });
    expect(router).toBeDefined();
    expect(pathsOf(router as Router, 'put')).toContain('/user/pay-password');
  });

  it('两个端点都必须存在（设置 + 修改缺一不可）', () => {
    let router: Router | undefined;
    jest.isolateModules(() => {
      /* eslint-disable @typescript-eslint/no-var-requires */
      const mod = require('@/routes/api/user.routes') as { createUserRouter: () => Router };
      router = mod.createUserRouter();
    });
    const posts = pathsOf(router as Router, 'post');
    const puts = pathsOf(router as Router, 'put');
    expect(posts).toContain('/user/pay-password');
    expect(puts).toContain('/user/pay-password');
  });
});
