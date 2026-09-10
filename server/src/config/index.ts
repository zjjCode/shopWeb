/**
 * @file server/src/config/index.ts
 * @description 配置聚合出口：default → {NODE_ENV} → 环境变量 → 启动校验 → 冻结导出
 * @module config
 * @see docs/02-architecture.md §5.4（配置管理）
 * @author 软件开发团队
 * @created 2026-09-03
 */

import dotenv from 'dotenv';
import defaultConfig from './default';
import developmentConfig from './development';
import testConfig from './test';
import productionConfig from './production';
import { parseEnv } from './env.schema';
import type { AppConfig, DeepPartial } from './types';

// 必须在读取 process.env 之前加载 .env；已存在的环境变量优先级更高，不会被覆盖
dotenv.config();

/**
 * 判断是否为「可合并的普通对象」。
 *
 * @description 内部工具：数组与 null 不参与递归合并，直接整体替换
 * @param value 待判断的值
 * @returns 是否为普通对象
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 深度合并多个配置片段（后者覆盖前者，数组整体替换）。
 *
 * @description 配置分层加载的核心工具
 * @param base 基线配置
 * @param overrides 逐层覆盖的配置片段
 * @returns 合并后的新对象（不修改入参）
 */
export function deepMerge<T>(base: T, ...overrides: DeepPartial<T>[]): T {
  if (!isPlainObject(base)) {
    return base;
  }

  const result: Record<string, unknown> = { ...base };

  for (const override of overrides) {
    if (!isPlainObject(override)) {
      continue;
    }
    for (const [key, value] of Object.entries(override)) {
      if (value === undefined) {
        continue;
      }
      const current = result[key];
      result[key] =
        isPlainObject(value) && isPlainObject(current)
          ? deepMerge(current, value as DeepPartial<typeof current>)
          : value;
    }
  }

  return result as T;
}

/**
 * 递归冻结配置对象。
 *
 * @description 防止运行期被业务代码意外改写配置（尤其限流阈值与金额相关参数）
 * @param value 待冻结的对象
 * @returns 冻结后的对象
 */
function deepFreeze<T>(value: T): T {
  if (!isPlainObject(value) && typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    Object.freeze(value);
    return value;
  }
  if (isPlainObject(value)) {
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
  }
  return Object.freeze(value);
}

/**
 * 把校验后的环境变量映射为配置片段。
 *
 * @description 环境变量是最后一层覆盖，优先级高于环境专属配置文件
 * @param env 校验通过的环境变量
 * @returns 配置片段
 */
function mapEnvToConfig(env: ReturnType<typeof parseEnv>): DeepPartial<AppConfig> {
  return {
    env: env.NODE_ENV,
    server: {
      host: env.SHOP__SERVER__HOST,
      port: env.SHOP__SERVER__PORT,
      baseUrl: env.SHOP__SERVER__BASE_URL,
    },
    db: {
      url: env.SHOP__DB__URL,
      slowQueryMs: env.SHOP__DB__SLOW_QUERY_MS,
    },
    redis: {
      url: env.SHOP__REDIS__URL,
      keyPrefix: env.SHOP__REDIS__KEY_PREFIX,
      connectTimeoutMs: env.SHOP__REDIS__CONNECT_TIMEOUT_MS,
      commandTimeoutMs: env.SHOP__REDIS__COMMAND_TIMEOUT_MS,
    },
    jwt: {
      shop: {
        accessSecret: env.SHOP__JWT__ACCESS_SECRET,
        refreshSecret: env.SHOP__JWT__REFRESH_SECRET,
        accessTtl: env.SHOP__JWT__ACCESS_TTL,
        refreshTtl: env.SHOP__JWT__REFRESH_TTL,
      },
      admin: {
        accessSecret: env.SHOP__JWT__ADMIN_ACCESS_SECRET,
        refreshSecret: env.SHOP__JWT__ADMIN_REFRESH_SECRET,
        accessTtl: env.SHOP__JWT__ACCESS_TTL,
        refreshTtl: env.SHOP__JWT__REFRESH_TTL,
      },
    },
    upload: {
      dir: env.SHOP__UPLOAD__DIR,
      maxSize: env.SHOP__UPLOAD__MAX_SIZE,
      baseUrl: env.SHOP__UPLOAD__BASE_URL,
    },
    order: {
      payTimeoutMinutes: env.SHOP__ORDER__PAY_TIMEOUT_MINUTES,
      autoConfirmDays: env.SHOP__ORDER__AUTO_CONFIRM_DAYS,
      afterSaleDays: env.SHOP__ORDER__AFTER_SALE_DAYS,
    },
    freight: {
      freeThreshold: env.SHOP__FREIGHT__FREE_THRESHOLD,
      fee: env.SHOP__FREIGHT__FEE,
    },
    stock: {
      deductMode: env.SHOP__STOCK__DEDUCT_MODE,
      warningThreshold: env.SHOP__STOCK__WARNING_THRESHOLD,
    },
    rateLimit: {
      enabled: env.SHOP__RATE_LIMIT__ENABLED,
      globalMax: env.SHOP__RATE_LIMIT__GLOBAL_MAX,
      globalWindowMs: env.SHOP__RATE_LIMIT__GLOBAL_WINDOW_MS,
      defaultMax: env.SHOP__RATE_LIMIT__DEFAULT_MAX,
      defaultWindowMs: env.SHOP__RATE_LIMIT__DEFAULT_WINDOW_MS,
    },
    cors: {
      origins: env.SHOP__CORS__ORIGINS.split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    },
    point: {
      enabled: env.SHOP__POINT__ENABLED,
    },
    log: {
      level: env.SHOP__LOG__LEVEL,
      dir: env.SHOP__LOG__DIR,
    },
    web: {
      baseUrl: env.SHOP__WEB__BASE_URL,
    },
    adapter: {
      payment: {
        provider: env.SHOP__ADAPTER__PAYMENT__PROVIDER,
      },
    },
  };
}

/** 按 NODE_ENV 选择环境专属配置 */
function pickEnvConfig(env: ReturnType<typeof parseEnv>): DeepPartial<AppConfig> {
  switch (env.NODE_ENV) {
    case 'production':
      return productionConfig;
    case 'test':
      return testConfig;
    default:
      return developmentConfig;
  }
}

/**
 * 生产环境保护：模拟支付渠道在生产环境一律拒绝启动（§6.5 / 错误码 70010）。
 *
 * @description 误用 mock 会让真实订单产生"已支付"状态却没有一分钱入账，属于资金事故，必须在启动期拦住
 * @param merged 合并后的配置
 * @throws {never} 命中保护条件时退出进程
 */
function assertProductionSafety(merged: AppConfig): void {
  if (merged.env !== 'production') {
    return;
  }
  if (merged.adapter.payment.provider === 'mock') {
    console.error('');
    console.error('  ✖ 生产环境不允许启用模拟支付渠道（错误码 70010）');
    console.error('    请将 SHOP__ADAPTER__PAYMENT__PROVIDER 设置为 alipay / wechat / unionpay 后重启。');
    console.error('');
    process.exit(1);
  }
  if (merged.jwt.shop.accessSecret.length < 32 || merged.jwt.admin.accessSecret.length < 32) {
    console.error('');
    console.error('  ✖ 生产环境 JWT 密钥长度不得小于 32 位');
    console.error('');
    process.exit(1);
  }
}

// 副作用即 fail-fast：import 本模块就会完成「加载 → 校验 → 冻结」，配置不正确进程直接退出
const env = parseEnv();
const merged = deepMerge(defaultConfig, pickEnvConfig(env), mapEnvToConfig(env));
assertProductionSafety(merged);

/** 全局唯一配置对象（深度冻结，运行期只读） */
export const config: AppConfig = deepFreeze(merged);

/** 环境判定快捷方式 */
export const isProduction = config.env === 'production';
export const isTest = config.env === 'test';
export const isDevelopment = config.env === 'development';

export type { AppConfig, DeepPartial } from './types';
export { parseEnv } from './env.schema';
export default config;
