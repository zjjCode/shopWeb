/**
 * @file server/tests/setup.ts
 * @description Jest 全局初始化脚本（由 jest.config.ts 的 setupFilesAfterEnv 引入）
 * @module tests
 * @author 软件开发团队
 * @created 2026-09-04
 *
 * 职责边界：
 * 这里只放**全局且与具体用例无关**的初始化（时区、环境标记）。
 * 各用例需要的环境变量、数据库夹具、Redis 连接请在对应 spec 内自行注入，
 * 不要堆到这里 —— 全局状态越多，用例之间越容易互相污染。
 *
 * 注意：本文件位于 `tests/` 而非 `src/`，不受 `tsconfig.json`（rootDir: src）编译约束，
 * 由 ts-jest 单独处理。
 */

// 固定时区：金额与时间计算全部依赖 Asia/Shanghai（§1.2），
// 不固定会导致同一份用例在不同开发机上得到不同结果
process.env.TZ = 'Asia/Shanghai';

// 标记为测试环境：让 config 走 test 分支（限流关闭、日志只输出控制台）
process.env.NODE_ENV = 'test';
