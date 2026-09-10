/**
 * @file server/src/config/test.ts
 * @description 测试环境专属配置覆盖（配置加载第二层）
 * @module config
 * @see docs/02-architecture.md §5.4
 * @author 软件开发团队
 * @created 2026-09-03
 */

import type { AppConfig, DeepPartial } from './types';

/**
 * 测试环境覆盖项。
 *
 * 测试态追求「确定性」：日志只到 warn（避免噪声）、限流关闭（否则并发用例互相干扰）、
 * 日志不落盘（测试跑完不留文件）。
 */
export const testConfig: DeepPartial<AppConfig> = {
  env: 'test',
  log: {
    level: 'warn',
    dir: '',
  },
  rateLimit: {
    enabled: false,
  },
  adapter: {
    payment: {
      provider: 'mock',
    },
  },
};

export default testConfig;
