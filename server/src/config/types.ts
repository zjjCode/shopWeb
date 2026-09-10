/**
 * @file server/src/config/types.ts
 * @description 应用配置的类型定义（AppConfig 及其分部）
 * @module config
 * @see docs/02-architecture.md §5.4（配置管理）
 * @author 软件开发团队
 * @created 2026-09-03
 */

/** 运行环境 */
export type AppEnv = 'development' | 'test' | 'production';

/** 库存扣减时机：下单冻结 / 支付后扣减 */
export type StockDeductMode = 'order' | 'pay';

/** 支付渠道路由目标（一期 mock，二 ~ 四期接入真实渠道） */
export type PaymentProvider = 'mock' | 'alipay' | 'wechat' | 'unionpay';

/** 日志级别 */
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

/** JWT 作用域：C 端买家 / 后台管理员（密钥分离，见 §7.1） */
export type TokenScope = 'shop' | 'admin';

/** 单个 JWT 作用域的配置 */
export interface JwtScopeConfig {
  /** access token 签名密钥 */
  accessSecret: string;
  /** refresh token 签名密钥 */
  refreshSecret: string;
  /** access token 有效期（如 '2h'） */
  accessTtl: string;
  /** refresh token 有效期（如 '7d'） */
  refreshTtl: string;
}

/** 应用完整配置（default → 环境配置 → 环境变量 逐层覆盖后冻结） */
export interface AppConfig {
  /** 运行环境 */
  env: AppEnv;
  server: {
    host: string;
    port: number;
    /** 服务自身对外地址（回调地址拼接用） */
    baseUrl: string;
  };
  db: {
    /** Prisma 连接串 mysql://user:pass@host:3306/shop_web */
    url: string;
    /** 慢查询阈值（毫秒），超过打 warn */
    slowQueryMs: number;
  };
  redis: {
    url: string;
    /** Key 前缀（§5.9：shop:{domain}:{...}） */
    keyPrefix: string;
    connectTimeoutMs: number;
    commandTimeoutMs: number;
  };
  jwt: Record<TokenScope, JwtScopeConfig>;
  upload: {
    dir: string;
    /** 单文件字节上限 */
    maxSize: number;
    /** 静态资源访问前缀 */
    baseUrl: string;
  };
  order: {
    /** 下单后支付超时分钟数（默认 30） */
    payTimeoutMinutes: number;
    /** 发货后自动确认收货天数（默认 15） */
    autoConfirmDays: number;
    /** 售后期天数（默认 7） */
    afterSaleDays: number;
  };
  freight: {
    /** 包邮门槛（分，默认 9900） */
    freeThreshold: number;
    /** 不满足门槛时的运费（分，默认 1200） */
    fee: number;
  };
  stock: {
    deductMode: StockDeductMode;
    warningThreshold: number;
  };
  rateLimit: {
    enabled: boolean;
    globalMax: number;
    globalWindowMs: number;
    defaultMax: number;
    defaultWindowMs: number;
  };
  cors: {
    /** 允许跨域的 Origin 白名单 */
    origins: string[];
  };
  point: {
    /** 积分体系开关：一期恒 false（§8） */
    enabled: boolean;
  };
  log: {
    level: LogLevel;
    /** 日志目录，为空则只输出控制台 */
    dir: string;
  };
  web: {
    /** 前端站点地址（mock 收银台 / returnUrl 用） */
    baseUrl: string;
  };
  adapter: {
    payment: {
      provider: PaymentProvider;
    };
  };
  security: {
    /** 全局请求体大小限制（上传路由单独放宽） */
    bodyLimit: string;
    /** express trust proxy 跳数 */
    trustProxy: number;
  };
}

/**
 * 递归可选类型，用于「环境专属配置」与「环境变量覆盖」的部分更新。
 *
 * 数组整体替换而不是逐项合并（例如 cors.origins），避免合并出半旧半新的列表。
 */
export type DeepPartial<T> = T extends readonly (infer U)[]
  ? U[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;
