/**
 * @file server/jest.config.ts
 * @description Jest 配置：ts-jest preset + node 环境 + `@/` 路径别名映射
 * @module tests
 * @see docs/02-architecture.md §5.14（测试策略）
 * @author 软件开发团队
 * @created 2026-09-04
 *
 * 为什么必须是 `jest.config.ts` 而不是 `jest.config.js`：
 * 项目全量 TypeScript，配置文件同样应该享受类型检查 ——
 * Jest 的配置项拼错（`setupFilesAfterEnv` 写成 `setupFilesAfterEach` 这类）在 JS 里是静默失效，
 * 在 TS 里会直接编译报错。
 */

import type { Config } from 'jest';

const config: Config = {
  /** ts-jest preset：把 .ts 交给 ts-jest 编译并做逐文件类型检查 */
  preset: 'ts-jest',
  /** 后端无 DOM，node 环境即可 */
  testEnvironment: 'node',

  /** 测试代码的两个来源：就近单元测试（src/tests）+ 端到端用例（tests） */
  roots: ['<rootDir>/src', '<rootDir>/tests'],
  testMatch: ['**/*.spec.ts'],

  /**
   * 每个测试文件在「测试框架安装完成之后、用例执行之前」执行的初始化脚本。
   *
   * 注意：Jest 的选项名是 `setupFilesAfterEnv`（`setupFiles` 在框架安装**之前**执行），
   * 没有 `setupFilesAfterEach` 这个选项，写错不会报错但也不会生效。
   */
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],

  moduleFileExtensions: ['ts', 'js', 'json'],
  /** 与 tsconfig.json 的 paths 保持一致，否则 `@/core/money` 在运行时解析不到 */
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },

  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.json',
        /** 只做转译与类型检查，不开 isolatedModules，保证类型错误不被跳过 */
        isolatedModules: false,
      },
    ],
  },

  /** 每个用例文件之间自动清理 mock，避免用例互相污染 */
  clearMocks: true,
  restoreMocks: true,
  /** 单测默认 10s 足够；集成用例请在文件内单独放大 */
  testTimeout: 10_000,

  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts', '!src/types/**', '!src/tests/**', '!src/server.ts'],
  coverageDirectory: '<rootDir>/coverage',
};

export default config;
