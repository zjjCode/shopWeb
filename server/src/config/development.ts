/**
 * @file server/src/config/development.ts
 * @description 开发环境专属配置覆盖（配置加载第二层）
 * @module config
 * @see docs/02-architecture.md §5.4
 * @author 软件开发团队
 * @created 2026-09-03
 */

import type { AppConfig, DeepPartial } from './types';

/**
 * 开发环境覆盖项。
 *
 * 开发态追求「可观测」：日志降到 debug、关闭全局限流的严苛阈值、允许 mock 支付渠道。
 */
export const developmentConfig: DeepPartial<AppConfig> = {
  env: 'development',
  log: {
    level: 'debug',
    dir: 'logs',
  },
  rateLimit: {
    // 本地调试（尤其并发脚本）很容易触发限流，放宽到不干扰开发
    enabled: false,
  },
  adapter: {
    payment: {
      provider: 'mock',
    },
  },
};

export default developmentConfig;
