/**
 * @file server/src/core/prisma.ts
 * @description PrismaClient 单例：进程级复用 + 慢查询告警 + 优雅断连
 * @module core
 * @see docs/02-architecture.md §5.3（分层记录点：事务与慢查询）
 * @author 软件开发团队
 * @created 2026-09-03
 *
 * 为什么必须用单例：
 * 每个 PrismaClient 都持有独立连接池，热重载（nodemon）或按请求 new 会迅速打满
 * MySQL 的 `max_connections`，表现为「本地跑一会儿就连不上库」。
 * 这里挂在 globalThis 上，使 dev 热重载复用同一实例。
 */

import { Prisma, PrismaClient } from '@prisma/client';
import { config } from '@/config';
import { logWarn } from '@/core/logger/logger';

/** 挂在 globalThis 上的实例缓存键（避免热重载重复建连接池） */
const PRISMA_GLOBAL_KEY = '__shopPrismaClient__';

/** globalThis 上挂载 Prisma 实例的类型形状 */
type PrismaGlobalHolder = typeof globalThis & { [PRISMA_GLOBAL_KEY]?: PrismaClient };

/**
 * 创建并装配一个 PrismaClient。
 *
 * @description 慢查询用 event 形式订阅：只在超过阈值时打 warn，
 * 避免每档 SQL 都输出导致日志被正常查询淹没
 * @returns 装配完成的客户端
 */
function createPrismaClient(): PrismaClient {
  const client = new PrismaClient({
    log: [
      { emit: 'event', level: 'query' },
      { emit: 'stdout', level: 'warn' },
      { emit: 'stdout', level: 'error' },
    ],
  });

  client.$on('query', (event: Prisma.QueryEvent) => {
    if (event.duration < config.db.slowQueryMs) {
      return;
    }
    // 参数里可能含手机号等敏感信息，只打 SQL 结构与耗时，不打 params
    logWarn('db.slow_query', {
      durationMs: event.duration,
      ctx: { query: event.query.slice(0, 1000) },
    });
  });

  return client;
}

/**
 * 获取 PrismaClient 单例（懒创建）。
 *
 * @description 首次调用才真正建连接池，保证 import 本模块不产生副作用
 * @returns PrismaClient 实例
 */
export function getPrisma(): PrismaClient {
  const holder = globalThis as PrismaGlobalHolder;
  const existing = holder[PRISMA_GLOBAL_KEY];
  if (existing !== undefined) {
    return existing;
  }
  const client = createPrismaClient();
  holder[PRISMA_GLOBAL_KEY] = client;
  return client;
}

/**
 * 建立数据库连接并校验可达性。
 *
 * @description 放在 server.ts 启动流程里：库连不上要在 listen 之前失败，
 * 而不是等第一个请求进来才 500（fail-fast）
 * @returns Promise，连接成功时 resolve
 * @throws 连接失败时抛出原始错误，由调用方决定是否退出进程
 */
export async function connectPrisma(): Promise<void> {
  await getPrisma().$connect();
}

/**
 * 断开数据库连接。
 *
 * @description 优雅退出时调用；未断连会让进程挂着不退出
 * @returns Promise，断开完成后 resolve
 */
export async function disconnectPrisma(): Promise<void> {
  const holder = globalThis as PrismaGlobalHolder;
  const client = holder[PRISMA_GLOBAL_KEY];
  if (client === undefined) {
    return;
  }
  await client.$disconnect();
  delete holder[PRISMA_GLOBAL_KEY];
}

/**
 * 校验数据库连接是否正常。
 *
 * @description 供健康检查接口（/healthz）使用
 * @returns 数据库可达时 true
 */
export async function isPrismaHealthy(): Promise<boolean> {
  try {
    await getPrisma().$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
