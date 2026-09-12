/**
 * @file server/src/server.ts
 * @description 服务启动入口：配置校验 → 依赖连通性 → listen → 优雅退出 → 兜底异常处理
 * @module server
 * @see docs/02-architecture.md §5.4（启动 fail-fast）、§5.5（中间件顺序）、§5.10（优雅退出）
 * @author 软件开发团队
 * @created 2026-09-04
 *
 * 启动与退出的核心原则：
 * 1. **fail-fast**：配置不全、数据库连不上，一律在 `listen` 之前退出。
 *    带着错误配置启动，只会让故障推迟到第一个请求才暴露，且表现为更难排查的 500；
 * 2. **优雅退出**：收到 SIGTERM 后先停止接收新连接 → 等在途请求跑完 → 再关依赖 → 最后退出。
 *    直接 `process.exit(0)` 会截断正在进行的下单/支付事务，产生「钱扣了单没建」的资金事故；
 * 3. **兜底**：`uncaughtException` / `unhandledRejection` 后进程已处于不确定状态，
 *    记录日志后按退出码 1 走同一套优雅退出流程 —— 只记日志不退出会留下僵尸实例。
 */

import type { Server } from 'node:http';

import { config } from '@/config';
import { parseEnv } from '@/config/env.schema';
import { closeLogger, logError, logFatal, logInfo, logWarn } from '@/core/logger/logger';
import { connectPrisma, disconnectPrisma } from '@/core/prisma';
import { closeQueues } from '@/core/queue';
import { closeRedis } from '@/core/redis';
import { startScheduler, stopScheduler } from '@/jobs/scheduler';
import { sleep } from '@/utils/sleep';
import { createApp } from '@/app';

/** 等待在途请求的超时上限（毫秒）：超时后强制断开连接，避免进程永远退不掉 */
const SHUTDOWN_TIMEOUT_MS = 15_000;

/** 在途请求轮询间隔（毫秒） */
const INFLIGHT_POLL_INTERVAL_MS = 100;

/** keep-alive 连接空闲超时：略大于常见网关（60s）的空闲超时 */
const KEEP_ALIVE_TIMEOUT_MS = 65_000;

/**
 * 请求头接收超时。
 *
 * @description 必须**大于** keepAliveTimeout，否则 Node 会在 keep-alive 连接等待下一个请求时
 * 先触发 headersTimeout，控制台刷满 `ERR_HTTP_REQUEST_TIMEOUT`
 */
const HEADERS_TIMEOUT_MS = 66_000;

/** 单个请求的完整处理超时（毫秒），兜住失控的慢查询与外部调用 */
const REQUEST_TIMEOUT_MS = 60_000;

/** 当前 HTTP 服务实例（供优雅退出使用） */
let httpServer: Server | null = null;

/** 正在处理的请求数（用于等待在途请求） */
let activeRequests = 0;

/** 是否正在退出：SIGTERM 连发两次时不重复执行清理 */
let shuttingDown = false;

/**
 * 等待在途请求处理完毕。
 *
 * @description 只用 `res.once('close')` 计数：
 * 正常完成会依次触发 `finish` → `close`，客户端提前断开只触发 `close`，
 * 若两个事件都监听会重复扣减导致计数变负，退出流程被永久挂起。
 * @param timeoutMs 最长等待时间
 * @returns Promise，请求清零或超时后 resolve
 */
async function waitForInflightRequests(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (activeRequests > 0) {
    if (Date.now() >= deadline) {
      // 超时不再等待：强制断开所有连接，宁可丢掉这几个请求也要让进程退出，
      // 否则滚动发布时旧实例一直挂着，新版本永远起不来
      logWarn('server.shutdown_inflight_timeout', { activeRequests, timeoutMs });
      httpServer?.closeAllConnections();
      return;
    }
    await sleep(INFLIGHT_POLL_INTERVAL_MS);
  }
}

/**
 * 关闭单个依赖，失败只记录不抛出。
 *
 * @description 清理阶段任何一个依赖报错都不能阻断后续清理：
 * 例如 Redis 已经不可用了，仍然必须把 Prisma 连接关掉并 flush 日志
 * @param name 依赖名（用于日志定位）
 * @param close 关闭函数
 * @returns Promise，始终 resolve
 */
async function safeClose(name: string, close: () => Promise<void>): Promise<void> {
  try {
    await close();
  } catch (error) {
    logError(`server.close_failed:${name}`, error);
  }
}

/**
 * 优雅退出。
 *
 * 顺序：停止收新请求 → 回收空闲连接 → 等在途请求 → 关队列 → 关 Redis → 关 Prisma
 * → 记完成日志 → flush 日志 → exit。
 *
 * @param signal 触发来源（SIGTERM / SIGINT / uncaughtException ...）
 * @param exitCode 进程退出码，正常退出 0，异常兜底退出 1
 * @returns Promise，退出前 resolve（进程会在随后 exit）
 */
async function shutdown(signal: string, exitCode = 0): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  logInfo('server.shutdown_start', { signal, activeRequests });

  const server = httpServer;
  if (server !== null) {
    // 停止监听新连接（已有连接不受影响）
    server.close();
    // 立刻回收 keep-alive 空闲连接：否则等待期间连接一直空转占着端口
    server.closeIdleConnections();
    await waitForInflightRequests(SHUTDOWN_TIMEOUT_MS);
  }

  // 先停「生产侧」：不再接新的异步任务，避免关闭过程中又产生新任务
  await safeClose('scheduler', stopScheduler);
  await safeClose('queue', closeQueues);
  await safeClose('redis', closeRedis);
  await safeClose('prisma', disconnectPrisma);

  logInfo('server.shutdown_done', { signal, exitCode });
  // 日志必须最后关：进程直接退出会丢掉最后几条缓冲日志，
  // 而支付回调这类关键日志丢了就无法对账
  await safeClose('logger', closeLogger);

  process.exit(exitCode);
}

/**
 * 注册进程级异常兜底。
 *
 * @description `uncaughtException` 之后进程状态已不可信，继续服务可能写出脏数据；
 * 这里统一记 fatal 日志后走优雅退出（在途请求仍有机会完成），而不是直接 exit。
 */
function registerProcessGuards(): void {
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });

  process.on('uncaughtException', (error: Error) => {
    logFatal('process.uncaught_exception', {
      errMessage: error.message,
      errStack: error.stack,
    });
    void shutdown('uncaughtException', 1);
  });

  process.on('unhandledRejection', (reason: unknown) => {
    logFatal('process.unhandled_rejection', {
      errMessage: reason instanceof Error ? reason.message : String(reason),
      errStack: reason instanceof Error ? reason.stack : undefined,
    });
    void shutdown('unhandledRejection', 1);
  });
}

/**
 * 启动服务。
 *
 * @description 流程：环境变量 fail-fast → 数据库连通性校验 → 装配 app → listen → 注册退出钩子。
 * 任一步失败都会抛出，由调用方记录 fatal 日志并以退出码 1 结束进程。
 * @returns Promise，listen 成功后 resolve
 * @throws 配置校验失败、数据库不可达时抛出
 */
export async function bootstrap(): Promise<void> {
  // 1. 配置 fail-fast：import 配置模块时已校验一次，这里显式再调一次，
  //    保证「配置错误」的报错永远排在其他启动日志之前，不会被淹没
  parseEnv();

  // 2. 数据库连通性：连不上要在 listen 之前失败，而不是等第一个请求进来才 500
  await connectPrisma();

  const app = createApp();

  httpServer = app.listen(config.server.port, config.server.host, () => {
    logInfo('server.started', {
      host: config.server.host,
      port: config.server.port,
      env: config.env,
      pid: process.pid,
      node: process.version,
    });
  });

  // 在途请求计数：注册在 express 的 request 监听器之后，同一轮 emit 内同步执行，
  // 因此计数一定早于任何异步业务处理
  httpServer.on('request', (_req, res) => {
    activeRequests += 1;
    res.once('close', () => {
      activeRequests -= 1;
    });
  });

  httpServer.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  httpServer.headersTimeout = HEADERS_TIMEOUT_MS;
  httpServer.requestTimeout = REQUEST_TIMEOUT_MS;

  // 启动异步任务调度器（超时关单 Worker + cron 兜底扫描；测试环境自动跳过）
  startScheduler();

  registerProcessGuards();
}

// 启动失败只可能是「配置 / 依赖」问题，此时 logger 可能还没就绪，
// 因此同时写一条 fatal 日志和一行 stderr，保证任何情况下都能看到原因
bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  logFatal('server.bootstrap_failed', {
    errMessage: message,
    errStack: error instanceof Error ? error.stack : undefined,
  });
  process.exit(1);
});
