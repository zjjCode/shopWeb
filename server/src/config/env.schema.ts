/**
 * @file server/src/config/env.schema.ts
 * @description 环境变量 zod schema + fail-fast 校验（缺失关键配置直接退出进程）
 * @module config
 * @see docs/02-architecture.md §5.4（启动 fail-fast 校验）
 * @author 软件开发团队
 * @created 2026-09-03
 */

import { z } from 'zod';

/**
 * 布尔型环境变量转换。
 *
 * 为什么不用 `z.coerce.boolean()`：它把字符串 `'false'` 也转成 `true`（JS 非空字符串即真值），
 * 会导致 `SHOP__RATE_LIMIT__ENABLED=false` 反而打开限流，属于典型的隐蔽配置陷阱。
 */
const boolFromEnv = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .default('false')
  .transform((value) => value === 'true' || value === '1' || value === 'yes');

/**
 * 环境变量 schema。
 *
 * 约定：
 * 1. 密钥、连接串一类「缺了就不能正确运行」的配置**不给默认值**，缺失即退出；
 * 2. 业务参数（超时时长、运费、限流阈值）给安全默认值，降低本地启动成本；
 * 3. 所有对外暴露的数值统一用 `z.coerce.number()`，环境变量天然是字符串。
 */
export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  SHOP__SERVER__HOST: z.string().min(1).default('0.0.0.0'),
  SHOP__SERVER__PORT: z.coerce.number().int().positive().default(3000),
  SHOP__SERVER__BASE_URL: z.string().url().default('http://localhost:3000'),

  SHOP__DB__URL: z.string().url(),
  SHOP__DB__SLOW_QUERY_MS: z.coerce.number().int().positive().default(500),

  SHOP__REDIS__URL: z.string().url(),
  SHOP__REDIS__KEY_PREFIX: z.string().min(1).default('shop'),
  SHOP__REDIS__CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),
  SHOP__REDIS__COMMAND_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),

  SHOP__JWT__ACCESS_SECRET: z.string().min(32),
  SHOP__JWT__REFRESH_SECRET: z.string().min(32),
  SHOP__JWT__ADMIN_ACCESS_SECRET: z.string().min(32),
  SHOP__JWT__ADMIN_REFRESH_SECRET: z.string().min(32),
  SHOP__JWT__ACCESS_TTL: z.string().min(1).default('2h'),
  SHOP__JWT__REFRESH_TTL: z.string().min(1).default('7d'),

  SHOP__UPLOAD__DIR: z.string().min(1).default('uploads'),
  SHOP__UPLOAD__MAX_SIZE: z.coerce.number().int().positive().default(5 * 1024 * 1024),
  SHOP__UPLOAD__BASE_URL: z.string().min(1).default('/static'),

  SHOP__ADAPTER__PAYMENT__PROVIDER: z.enum(['mock', 'alipay', 'wechat', 'unionpay']).default('mock'),

  SHOP__ORDER__PAY_TIMEOUT_MINUTES: z.coerce.number().int().positive().default(30),
  SHOP__ORDER__AUTO_CONFIRM_DAYS: z.coerce.number().int().positive().default(15),
  SHOP__ORDER__AFTER_SALE_DAYS: z.coerce.number().int().positive().default(7),

  SHOP__FREIGHT__FREE_THRESHOLD: z.coerce.number().int().nonnegative().default(9900),
  SHOP__FREIGHT__FEE: z.coerce.number().int().nonnegative().default(1200),

  SHOP__STOCK__DEDUCT_MODE: z.enum(['order', 'pay']).default('order'),
  SHOP__STOCK__WARNING_THRESHOLD: z.coerce.number().int().nonnegative().default(10),

  SHOP__RATE_LIMIT__ENABLED: boolFromEnv,
  SHOP__RATE_LIMIT__GLOBAL_MAX: z.coerce.number().int().positive().default(600),
  SHOP__RATE_LIMIT__GLOBAL_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  SHOP__RATE_LIMIT__DEFAULT_MAX: z.coerce.number().int().positive().default(120),
  SHOP__RATE_LIMIT__DEFAULT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),

  SHOP__CORS__ORIGINS: z.string().default('http://localhost:5173'),

  SHOP__LOG__LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  SHOP__LOG__DIR: z.string().default('logs'),

  SHOP__WEB__BASE_URL: z.string().url().default('http://localhost:5173'),

  SHOP__POINT__ENABLED: boolFromEnv,
});

/** 校验通过后的环境变量类型 */
export type Env = z.infer<typeof EnvSchema>;

/** 校验失败项：字段路径 + 期望说明 + 实际值（密钥只显示长度，不回显内容） */
export interface EnvIssue {
  field: string;
  expected: string;
  received: string;
}

/** 敏感字段：报错时禁止回显原始值，防止密钥被打进日志 */
const SECRET_FIELDS = new Set([
  'SHOP__DB__URL',
  'SHOP__REDIS__URL',
  'SHOP__JWT__ACCESS_SECRET',
  'SHOP__JWT__REFRESH_SECRET',
  'SHOP__JWT__ADMIN_ACCESS_SECRET',
  'SHOP__JWT__ADMIN_REFRESH_SECRET',
]);

/**
 * 把 zod 的 issue 列表收敛成人类可读的清单。
 *
 * @description 内部工具：格式化校验失败信息
 * @param issues zod 校验问题列表
 * @returns 格式化后的失败项
 */
function formatIssues(issues: z.ZodIssue[]): EnvIssue[] {
  return issues.map((issue) => {
    const field = issue.path.join('.') || '(root)';
    const raw = issue.path.length > 0 ? process.env[String(issue.path[0])] : undefined;
    const received = SECRET_FIELDS.has(field)
      ? `<hidden:${typeof raw === 'string' ? raw.length : 0} chars>`
      : raw === undefined
        ? '<missing>'
        : `<${typeof raw}>`;
    return { field, expected: issue.message, received };
  });
}

/**
 * 打印配置校验失败清单并**终止进程**。
 *
 * @description fail-fast：配置不全时绝不带着错误配置启动，否则会在运行期以更隐蔽的方式炸掉
 *  @param issues 校验失败项
 * @throws {never} 永不返回，内部调用 process.exit(1)
 */
export function exitWithEnvError(issues: z.ZodIssue[]): never {
  const formatted = formatIssues(issues);
  const width = Math.max(...formatted.map((item) => item.field.length), 12);

  const lines = formatted.map(
    (item) => `  ${item.field.padEnd(width)}  expected: ${item.expected}  received: ${item.received}`,
  );

  // 这里不能用 logger：logger 依赖 config，而 config 正在校验中，会形成循环依赖
  console.error('');
  console.error('  ✖ 环境变量校验失败，服务拒绝启动（Fail-Fast）');
  console.error('');
  console.error(lines.join('\n'));
  console.error('');
  console.error('  请复制 server/.env.example 为 server/.env 并补全缺失项后重启。');
  console.error('  字段说明见 docs/02-architecture.md §5.4 环境变量命名规范。');
  console.error('');

  process.exit(1);
}

/**
 * 解析并校验环境变量。
 *
 * @description 唯一的环境变量入口，校验失败直接退出进程
 * @param source 环境变量来源，默认 `process.env`（测试时可注入）
 * @returns 校验通过且带类型的环境变量对象
 * @throws {never} 校验失败时调用 {@link exitWithEnvError} 退出进程
 */
export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    exitWithEnvError(parsed.error.issues);
  }
  return parsed.data;
}
