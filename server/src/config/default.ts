/**
 * @file server/src/config/default.ts
 * @description 与环境无关的默认配置（配置加载的第一层，见 §5.4）
 * @module config
 * @see docs/02-architecture.md §5.4
 * @author 软件开发团队
 * @created 2026-09-03
 */

import type { AppConfig } from './types';

/**
 * 默认配置基线。
 *
 * 注意：密钥类字段（jwt.*.Secret、db.url、redis.url）在此留空，
 * 由环境变量补齐并在 env.schema.ts 中做 fail-fast 校验 —— 绝不提供可运行的弱默认值，
 * 否则"忘了配密钥也能启动"，会在生产环境造成签名密钥为固定值的严重漏洞。
 */
export const defaultConfig: AppConfig = {
  env: 'development',
  server: {
    host: '0.0.0.0',
    port: 3000,
    baseUrl: 'http://localhost:3000',
  },
  db: {
    url: '',
    slowQueryMs: 500,
  },
  redis: {
    url: '',
    keyPrefix: 'shop',
    connectTimeoutMs: 3000,
    commandTimeoutMs: 3000,
  },
  jwt: {
    shop: { accessSecret: '', refreshSecret: '', accessTtl: '2h', refreshTtl: '7d' },
    admin: { accessSecret: '', refreshSecret: '', accessTtl: '2h', refreshTtl: '7d' },
  },
  upload: {
    dir: 'uploads',
    maxSize: 5 * 1024 * 1024,
    baseUrl: '/static',
  },
  order: {
    payTimeoutMinutes: 30,
    autoConfirmDays: 15,
    afterSaleDays: 7,
  },
  freight: {
    freeThreshold: 9900,
    fee: 1200,
  },
  stock: {
    deductMode: 'order',
    warningThreshold: 10,
  },
  rateLimit: {
    enabled: true,
    globalMax: 600,
    globalWindowMs: 60_000,
    defaultMax: 120,
    defaultWindowMs: 60_000,
  },
  cors: {
    origins: ['http://localhost:5173'],
  },
  point: {
    enabled: false,
  },
  log: {
    level: 'info',
    dir: 'logs',
  },
  web: {
    baseUrl: 'http://localhost:5173',
  },
  adapter: {
    payment: {
      provider: 'mock',
    },
  },
  security: {
    bodyLimit: '1mb',
    trustProxy: 1,
  },
};

export default defaultConfig;
