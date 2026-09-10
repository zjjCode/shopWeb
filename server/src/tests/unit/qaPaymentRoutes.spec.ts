/**
 * @file server/src/tests/unit/qaPaymentRoutes.spec.ts
 * @description QA 独立验证：支付路由的**装配期**生产安全（mock 确认端点在生产环境不得注册）
 * @module tests/unit
 * @see server/src/routes/api/payment.routes.ts、docs/02-architecture.md §6.7（mock 红线）
 * @author QA（software-qa-engineer）
 * @created 2026-09-08
 *
 * 为什么单独成文件：
 * `isProduction` 是 `@/config` 的**模块加载期常量**，要验证「生产环境不注册 mock 端点」
 * 必须在隔离的模块注册表里重新装配路由（`jest.isolateModules` + `jest.doMock`）。
 * 一旦本文件在顶层 import 了任何会连带加载 `@/config` 的模块（例如 `@/services/PaymentService`
 * → `@/core/logger/logger` → `@/config`），`@/config` 就会先落进**外层**注册表，
 * 之后沙箱内的 `doMock` 不再生效，两个环境会拿到同一份 `isProduction` —— 测试会假绿。
 * 因此本文件刻意**只** import 路由装配函数本身。
 *
 * 这里的断言不是「进了处理器再抛错」，而是「**路由表里根本没有这一条**」：
 * 前者仍会进入路由匹配、留下访问日志与限流计数，后者才是设计要求的「装配期就不注册」。
 */

import { describe, expect, it, jest } from '@jest/globals';
import type { Router } from 'express';

/**
 * 配置桩工厂（**必须是函数声明**：`jest.mock` 会被提升到 import 之前执行）。
 *
 * @param isProduction 是否模拟生产环境
 * @returns 配置桩
 */
function buildConfigStub(isProduction: boolean) {
  return {
    config: {
      env: isProduction ? 'production' : 'test',
      redis: { keyPrefix: 'shop' },
      order: { payTimeoutMinutes: 30, autoConfirmDays: 15, afterSaleDays: 7 },
      freight: { freeThreshold: 9900, fee: 1200 },
      jwt: {
        shop: { accessSecret: 'x'.repeat(32), refreshSecret: 'x'.repeat(32), accessTtl: '2h', refreshTtl: '7d' },
        admin: { accessSecret: 'x'.repeat(32), refreshSecret: 'x'.repeat(32), accessTtl: '2h', refreshTtl: '7d' },
      },
      rateLimit: { enabled: false, globalMax: 600, globalWindowMs: 60_000, defaultMax: 120, defaultWindowMs: 60_000 },
      security: { bodyLimit: '1mb', trustProxy: 1 },
      // logger 在 import 时即读 config.log.level 建 winston 实例，缺了会让整个套件起不来
      log: { level: 'error', dir: '' },
    },
    isProduction,
    isTest: !isProduction,
    isDevelopment: false,
  };
}

// config 在模块加载时即校验环境变量并可能 process.exit；测试环境没有 .env，注入固定值
jest.mock('@/config', () => buildConfigStub(false));

/** mock 确认端点的路径（生产环境绝对不能出现） */
const MOCK_PAID_PATH = '/payments/:paymentNo/mock-paid';

describe('支付路由装配：mock 确认端点的生产红线', () => {
  /**
   * 收集 Router 上已注册的 POST 路径。
   *
   * @param router Express Router
   * @returns POST 路径数组
   */
  function postPaths(router: Router): string[] {
    // Express 的 Layer 结构未对外导出类型，这里按运行期形状读取（只读，不改行为）
    const stack = (router as unknown as { stack: unknown[] }).stack;
    const paths: string[] = [];
    for (const layer of stack) {
      const route = (layer as { route?: { path: string; stack: Array<{ method?: string }> } }).route;
      if (route === undefined) {
        continue;
      }
      if (route.stack.some((s) => s.method === 'post')) {
        paths.push(route.path);
      }
    }
    return paths;
  }

  /**
   * 在隔离的模块注册表里按给定环境重新装配支付路由。
   *
   * @description 只有重建注册表才能影响 `isProduction`——
   * 这正是生产环境真实发生的事：**进程启动时定生死**，运行期改不了。
   * @param isProduction 是否生产环境
   * @returns 路由表
   */
  function buildRouterWith(isProduction: boolean): Router {
    let router: Router | undefined;
    jest.isolateModules(() => {
      jest.doMock('@/config', () => buildConfigStub(isProduction));
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require('@/routes/api/payment.routes') as { createPaymentRouter: () => Router };
      router = mod.createPaymentRouter();
    });
    if (router === undefined) {
      throw new Error('路由装配失败');
    }
    return router;
  }

  it('非生产环境：注册 mock 确认端点（本地联调与演示需要）', () => {
    expect(postPaths(buildRouterWith(false))).toContain(MOCK_PAID_PATH);
  });

  it('⚠️ 生产环境：mock 确认端点**不在路由表中**（装配期就不注册，请求落到兜底 404）', () => {
    const paths = postPaths(buildRouterWith(true));
    expect(paths).not.toContain(MOCK_PAID_PATH);
    // 正常的发起支付端点必须在，否则生产就彻底没法支付了
    expect(paths).toContain('/payments');
  });

  it('发起支付端点在两种环境下都注册（别因环境判定误伤正常支付）', () => {
    expect(postPaths(buildRouterWith(false))).toContain('/payments');
    expect(postPaths(buildRouterWith(true))).toContain('/payments');
  });
});
