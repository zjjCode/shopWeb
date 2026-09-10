/**
 * @file server/src/core/logger/logger.ts
 * @description winston 日志实例：JSON 结构化 + 按天切割 + requestId 自动注入 + 敏感字段脱敏
 * @module core
 * @see docs/02-architecture.md §5.3（日志规范）
 * @author 软件开发团队
 * @created 2026-09-03
 *
 * 设计要点：
 * 1. **自定义级别**：winston 内置 npm 级别缺少 `fatal` / `trace`，而配置层允许这两个值，
 *    因此这里显式声明级别表并把 `http` 排在 `info` 与 `debug` 之间 ——
 *    使 `level=info` 时打印访问日志、`level=warn` 时自动静默，无需额外开关；
 * 2. **requestId 自动注入**：在 format 链里读取 AsyncLocalStorage（见 requestContext.ts），
 *    业务代码打日志时无需手动传递链路 ID；
 * 3. **脱敏在入口做**：redact() 只处理普通对象，不能作用于 winston 的 info 对象
 *    （info 带 Symbol 元数据，浅拷贝会丢失），因此脱敏放在 logXxx 入口而非 format 链。
 */

import path from 'node:path';
import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import { config, isDevelopment, isTest } from '@/config';
import { jsonReplacer } from '@/core/response';
import { redact } from './redact';
import { getContext } from './requestContext';

/**
 * 按天轮转 transport 的「公共选项」（不含 `filename` / `stream`）。
 *
 * @description winston-daily-rotate-file v5 的 `DailyRotateFileTransportOptions` 是
 * `RequireOnlyOne<..., 'filename' | 'stream'>`，即一个**联合类型**：
 * 一支要求 `filename: string, stream?: undefined`，另一支要求 `stream, filename?: undefined`。
 * 若把该联合类型直接标注给公共选项再展开，展开结果会带上 `filename: undefined` 那一支，
 * 于是 `{ ...common, filename: 'app-%DATE%.log' }` 会被判成「string 不能赋给 undefined」。
 * 因此公共选项必须 **Omit 掉这两个互斥字段**，把「二选一」的校验留到真正创建 transport 时再做 ——
 * 那里两个字面量都只提供 `filename`，自然命中第一支。
 */
type RotateFileCommonOptions = Omit<DailyRotateFile.GeneralDailyRotateFileTransportOptions, 'filename' | 'stream'>;

/** 结构化日志的固定字段（§5.3 结构化字段表） */
export interface LogFields {
  /** 事件名，如 order.created */
  msg?: string;
  requestId?: string;
  userId?: number;
  adminId?: number;
  role?: string;
  scope?: string;
  method?: string;
  path?: string;
  status?: number;
  durationMs?: number;
  errCode?: number | string;
  errStack?: string;
  bizNos?: Record<string, string>;
  jobName?: string;
  ctx?: unknown;
  [key: string]: unknown;
}

/**
 * 自定义级别表（数值越小越严重）。
 *
 * 比 npm 级别多出 `fatal`（最严重）与 `trace`（最啰嗦），
 * 与 `config/types.ts` 的 `LogLevel` 取值一一对应，避免配置里填了级别却被 winston 忽略。
 */
const LOG_LEVELS: Record<string, number> = {
  fatal: 0,
  error: 1,
  warn: 2,
  info: 3,
  http: 4,
  debug: 5,
  trace: 6,
};

/** 本模块允许的日志级别 */
export type AppLogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'http' | 'debug' | 'trace';

/**
 * 把 AsyncLocalStorage 中的请求上下文注入到每条日志。
 *
 * 为什么放在 format 而不是调用点：上下文在请求处理过程中会被 auth 中间件**就地回填**
 * （如解出 userId 之后），format 在真正写入时才执行，因此能拿到最新的上下文。
 */
const injectContextFormat = winston.format((info) => {
  const context = getContext();
  if (context === undefined) {
    return info;
  }
  info.requestId = context.requestId;
  if (context.userId !== undefined) {
    info.userId = context.userId;
  }
  if (context.adminId !== undefined) {
    info.adminId = context.adminId;
  }
  if (context.role !== undefined) {
    info.role = context.role;
  }
  if (context.scope !== undefined) {
    info.scope = context.scope;
  }
  if (context.jobName !== undefined) {
    info.jobName = context.jobName;
  }
  if (context.bizNos !== undefined) {
    info.bizNos = context.bizNos;
  }
  return info;
});

/**
 * 生产/文件用的 JSON 输出格式。
 *
 * 用 printf 手写 JSON 而不用 `format.json()`，是为了把 winston 的 `message`
 * 映射成 §5.3 约定的 `msg` 字段，并保证 `ts` 是毫秒级 ISO8601。
 */
const jsonOutputFormat = winston.format.printf((info) => {
  const { level, message, timestamp, ...meta } = info;
  const payload: Record<string, unknown> = {
    ts: typeof timestamp === 'string' ? timestamp : new Date().toISOString(),
    level,
    ...meta,
    msg: message,
  };
  return JSON.stringify(payload, jsonReplacer);
});

/**
 * 开发环境控制台格式：单行可读，级别着色。
 */
const prettyOutputFormat = winston.format.printf((info) => {
  const { level, message, timestamp, ...meta } = info;
  const metaText = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta, jsonReplacer)}` : '';
  return `${String(timestamp)} ${level} ${String(message)}${metaText}`;
});

/**
 * 构造控制台 transport。
 *
 * @returns winston 控制台 transport
 */
function buildConsoleTransport(): winston.transport {
  return new winston.transports.Console({
    level: config.log.level,
    format: winston.format.combine(
      winston.format.timestamp({ format: () => new Date().toISOString() }),
      injectContextFormat(),
      isDevelopment
        ? winston.format.combine(winston.format.colorize({ level: true }), prettyOutputFormat)
        : jsonOutputFormat,
    ),
  });
}

/**
 * 构造按天轮转的文件 transport 列表（§5.3 日志落地）。
 *
 * app 日志保留 14 天（info 及以上），error 日志保留 30 天。
 * 测试环境或 `log.dir` 为空时**不写文件**，避免测试残留与容器只读文件系统报错。
 *
 * 文件名用 `filename` 的 `%DATE%` 占位符实现按天分文件（`level` 各自独立，
 * 因此无需 v4 的 `levelMutator` —— 该选项在 v5 已移除，且 winston 的 LoggerOptions 也不接受）。
 *
 * @returns 文件 transport 列表，可能为空数组
 */
function buildFileTransports(): winston.transport[] {
  if (isTest || config.log.dir.length === 0) {
    return [];
  }

  const dirname = path.resolve(process.cwd(), config.log.dir);
  const common: RotateFileCommonOptions = {
    dirname,
    datePattern: 'YYYY-MM-DD',
    zippedArchive: true,
    maxSize: '100m',
    auditFile: path.join(dirname, '.audit.json'),
  };

  return [
    new DailyRotateFile({ ...common, filename: 'app-%DATE%.log', level: 'info', maxFiles: '14d' }),
    new DailyRotateFile({ ...common, filename: 'error-%DATE%.log', level: 'error', maxFiles: '30d' }),
  ];
}

/** 全局日志实例（进程级单例） */
export const logger: winston.Logger = winston.createLogger({
  level: config.log.level,
  levels: LOG_LEVELS,
  exitOnError: false,
  // 进程级固定字段，便于多服务日志聚合时区分来源
  defaultMeta: { service: 'shop-web-server', env: config.env },
  transports: [buildConsoleTransport(), ...buildFileTransports()],
});

/**
 * 创建带固定绑定的子日志器。
 *
 * @description 模块级使用：`const log = createLogger('OrderService')`，便于按模块过滤日志；
 * 子日志器继承父级的 format 与 transport，因此同样具备 requestId 注入能力
 * @param module 模块名
 * @param bindings 额外的固定字段
 * @returns 子日志器
 */
export function createLogger(module: string, bindings: LogFields = {}): winston.Logger {
  return logger.child({ module, ...bindings });
}

/**
 * 统一的日志写入入口。
 *
 * @description 所有 logXxx 都走这里，保证「脱敏 + 事件名映射到 msg」只实现一次
 * @param level 日志级别
 * @param event 事件名
 * @param fields 结构化字段
 */
function write(level: AppLogLevel, event: string, fields: LogFields): void {
  logger.log({
    level,
    message: event,
    ...(redact(fields) as Record<string, unknown>),
  });
}

/**
 * 记录致命日志（fatal 级）。
 *
 * @param event 事件名
 * @param fields 结构化字段
 */
export function logFatal(event: string, fields: LogFields = {}): void {
  write('fatal', event, fields);
}

/**
 * 记录业务动作日志（info 级）。
 *
 * @description 服务层关键动作统一走此入口，自动脱敏上下文
 * @param event 事件名，如 `order.created`
 * @param fields 结构化字段
 */
export function logInfo(event: string, fields: LogFields = {}): void {
  write('info', event, fields);
}

/**
 * 记录业务拒绝或降级日志（warn 级）。
 *
 * @description 库存不足、状态非法、Redis 降级等「预期内的异常」用 warn，不打扰 error 告警
 * @param event 事件名
 * @param fields 结构化字段
 */
export function logWarn(event: string, fields: LogFields = {}): void {
  write('warn', event, fields);
}

/**
 * 记录错误日志（error 级，含堆栈）。
 *
 * @description 仅 error 级别打印 stack（§5.3），errCode 便于按错误码聚合告警
 * @param event 事件名
 * @param error 错误对象
 * @param fields 结构化字段
 */
export function logError(event: string, error: unknown, fields: LogFields = {}): void {
  const isError = error instanceof Error;
  write('error', event, {
    errMessage: isError ? error.message : String(error),
    errStack: isError ? error.stack : undefined,
    ...fields,
  });
}

/**
 * 记录 HTTP 访问日志（http 级）。
 *
 * @description 仅中间件层使用（§5.3 分层记录点）；业务代码请用 logInfo / logWarn / logError
 * @param fields 访问日志字段（内部统一脱敏）
 */
export function logHttp(fields: LogFields): void {
  write('http', typeof fields.msg === 'string' ? fields.msg : 'http.request', fields);
}

/**
 * 记录调试日志（debug 级）。
 *
 * @param event 事件名
 * @param fields 结构化字段
 */
export function logDebug(event: string, fields: LogFields = {}): void {
  write('debug', event, fields);
}

/**
 * 记录跟踪日志（trace 级，最啰嗦）。
 *
 * @param event 事件名
 * @param fields 结构化字段
 */
export function logTrace(event: string, fields: LogFields = {}): void {
  write('trace', event, fields);
}

/**
 * 关闭日志实例并等待缓冲落盘。
 *
 * @description 优雅退出时调用（见 server.ts）：进程直接退出会丢掉最后几条日志，
 * 而支付回调这类关键日志丢了就无法对账，因此退出前必须 flush
 * @returns Promise，全部 transport 关闭后 resolve
 */
export function closeLogger(): Promise<void> {
  return new Promise<void>((resolve) => {
    logger.on('finish', () => resolve());
    logger.end();
  });
}

export default logger;
