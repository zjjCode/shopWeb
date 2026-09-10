/**
 * @file server/src/config/production.ts
 * @description 生产环境专属配置覆盖（配置加载第二层）
 * @module config
 * @see docs/02-architecture.md §5.4、§6.5（生产环境保护）
 * @author 软件开发团队
 * @created 2026-09-03
 */

import type { AppConfig, DeepPartial } from './types';

/**
 * 生产环境覆盖项。
 *
 * 只放「必须不同」的项：日志级别、限流开启。
 * 支付渠道**不在此写死** —— 它来自环境变量 `SHOP__ADAPTER__PAYMENT__PROVIDER`，
 * 由 `config/index.ts` 在启动时校验「生产环境不得启用 mock」（错误码 70010 的启动期防护）。
 */
export const productionConfig: DeepPartial<AppConfig> = {
  env: 'production',
  log: {
    level: 'info',
    dir: 'logs',
  },
  rateLimit: {
    enabled: true,
  },
};

export default productionConfig;
