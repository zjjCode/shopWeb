/**
 * @file server/src/config/constants.ts
 * @description 业务常量集中地：超时时长 / 运费规则 / 限流阈值 / Redis Key / 队列名 / 积分开关
 * @module config
 * @see docs/02-architecture.md §5.9（Key 命名规范）、§10.1（队列清单）
 * @author 软件开发团队
 * @created 2026-09-03
 */

/** JWT 作用域（C 端 shop / 后台 admin），密钥与作用范围分离 */
export const TOKEN_SCOPE = {
  SHOP: 'shop',
  ADMIN: 'admin',
} as const;

/** HTTP 请求头常量 */
export const HEADER = {
  /** 全链路追踪 ID */
  REQUEST_ID: 'X-Request-Id',
  /** 幂等键（下单/支付/退款/库存调整必传） */
  IDEMPOTENCY_KEY: 'Idempotency-Key',
  /** 限流重试提示 */
  RETRY_AFTER: 'Retry-After',
  AUTHORIZATION: 'Authorization',
} as const;

/** 金额常量：全链路以「分」为单位，比例用万分比 */
export const MONEY = {
  /** 单位：分 */
  UNIT: 'cent',
  /** 万分比基数（85 折 = 8500） */
  PERCENT_BASE: 10000,
  /** 单笔最大金额（分），用于入参防御：9000 万元 */
  MAX_AMOUNT: 900_000_000_000,
} as const;

/** 分页默认值与上限（§5.7） */
export const PAGING = {
  DEFAULT_PAGE: 1,
  DEFAULT_PAGE_SIZE: 20,
  MAX_PAGE_SIZE: 100,
} as const;

/** 限流阈值表（§5.8 默认阈值表），窗口单位毫秒 */
export const RATE_LIMIT_PRESETS = {
  /** 全局兜底：单 IP 600 次 / 分钟 */
  GLOBAL: { max: 600, windowMs: 60_000 },
  /** 默认接口：120 次 / 分钟 */
  DEFAULT: { max: 120, windowMs: 60_000 },
  /** 注册：5 次 / 小时 */
  REGISTER: { max: 5, windowMs: 3_600_000 },
  /** 登录：10 次 / 15 分钟 */
  LOGIN: { max: 10, windowMs: 900_000 },
  /** 短信：10 次 / 24 小时 */
  SMS: { max: 10, windowMs: 86_400_000 },
  /** 下单提交：10 次 / 分钟 */
  ORDER_CREATE: { max: 10, windowMs: 60_000 },
  /** 支付发起：20 次 / 分钟 */
  PAY_CREATE: { max: 20, windowMs: 60_000 },
  /** 支付回调：200 次 / 分钟（渠道 IP 可豁免） */
  PAY_CALLBACK: { max: 200, windowMs: 60_000 },
  /** 退款申请：5 次 / 小时 */
  REFUND_APPLY: { max: 5, windowMs: 3_600_000 },
  /** 文件上传：20 次 / 分钟 */
  UPLOAD: { max: 20, windowMs: 60_000 },
  /** 后台写操作：60 次 / 分钟 */
  ADMIN_WRITE: { max: 60, windowMs: 60_000 },
  /** 后台导出：10 次 / 小时 */
  ADMIN_EXPORT: { max: 10, windowMs: 3_600_000 },
} as const;

/** 限流 Key 前缀（§5.9：`shop:rl:{scope}:{id}:{route}`） */
export const RATE_LIMIT_KEY = {
  GLOBAL: 'rl:global',
  IP: 'rl:ip',
  USER: 'rl:user',
  ADMIN: 'rl:admin',
  ROUTE: 'rl:route',
} as const;

/** Redis Key 前缀与 TTL（§5.9 Key 命名规范，全部带 TTL，锁除外） */
export const REDIS_KEY = {
  PREFIX: 'shop',
  /** 幂等前置快拦 */
  IDEMPOTENT: 'idem',
  /** 热点 SKU 互斥锁（仅削峰，权威是 DB CAS） */
  LOCK_SKU: 'lock:sku',
  /** 定时任务选主锁 */
  LOCK_JOB: 'lock:job',
  /** 余额账户削峰锁（权威仍是 FOR UPDATE） */
  LOCK_ACCOUNT: 'lock:account',
  CACHE_CATEGORY_TREE: 'cache:category:tree',
  CACHE_PRODUCT: 'cache:product',
  CACHE_SKU_PRICE: 'cache:sku:price',
  CACHE_LOGISTICS: 'cache:logistics',
  /** 管理员权限点集合（敏感权限绕过此缓存实时查库） */
  RBAC_PERMS: 'rbac:perms',
  CACHE_PAY_METHODS: 'cache:pay:methods',
  CACHE_COUPON_AVAILABLE: 'cache:coupon:available',
} as const;

/** 缓存 TTL（秒） */
export const CACHE_TTL_SECONDS = {
  CATEGORY_TREE: 600,
  PRODUCT: 300,
  SKU_PRICE: 60,
  LOGISTICS: 1800,
  RBAC_PERMS: 60,
  PAY_METHODS: 60,
  COUPON_AVAILABLE: 60,
} as const;

/** 分布式锁 TTL（毫秒） */
export const LOCK_TTL_MS = {
  SKU: 10_000,
  JOB: 55_000,
  ACCOUNT: 10_000,
} as const;

/** BullMQ 队列名（§10.1 队列清单） */
export const QUEUE_NAMES = {
  /** 支付回调入账 */
  PAYMENT_CALLBACK: 'payment-callback',
  /** 退款执行（渠道调用在事务外） */
  REFUND_EXEC: 'refund-exec',
  /** 超时关单（延迟任务 + cron 兜底） */
  ORDER_CLOSE: 'order-close',
  /** 自动确认收货 */
  ORDER_AUTO_CONFIRM: 'order-auto-confirm',
  /** 通知（失败不影响主流程） */
  NOTIFY: 'notify',
} as const;

/** 队列并发与重试策略（§10.1） */
export const QUEUE_LIMITS = {
  [QUEUE_NAMES.PAYMENT_CALLBACK]: { concurrency: 5, attempts: 5 },
  [QUEUE_NAMES.REFUND_EXEC]: { concurrency: 3, attempts: 5 },
  [QUEUE_NAMES.ORDER_CLOSE]: { concurrency: 3, attempts: 3 },
  [QUEUE_NAMES.ORDER_AUTO_CONFIRM]: { concurrency: 2, attempts: 3 },
  [QUEUE_NAMES.NOTIFY]: { concurrency: 10, attempts: 3 },
} as const;

/**
 * 支付回调队列的重试退避阶梯：2s / 8s / 32s / 2m / 8m（§10.1）。
 *
 * BullMQ 内置 exponential 退避是 `delay * 2^n`，得不到这个阶梯，
 * 因此这里保留阶梯常量，由 Worker 注册 custom backoffStrategy 时使用（T060 落地）。
 */
export const CALLBACK_BACKOFF_DELAYS_MS = [2_000, 8_000, 32_000, 120_000, 480_000] as const;

/** 通知队列退避（失败仅告警，不阻塞） */
export const DEFAULT_BACKOFF_DELAY_MS = 2_000;

/** 单号前缀（docs/03-database.md §1.3） */
export const ID_PREFIX = {
  ORDER: 'SO',
  PAYMENT: 'PAY',
  REFUND: 'SR',
  FUND_TX: 'FT',
  RECHARGE: 'RC',
  COUPON_TEMPLATE: 'CT',
  COUPON_INSTANCE: 'CP',
  PROMOTION: 'PM',
  TX_GROUP: 'TG',
  USER_BALANCE_ACCOUNT: 'UB',
  /** 平台现金账户（唯一） */
  PLATFORM_CASH_ACCOUNT: 'ACC_PLATFORM_CASH',
} as const;

/** 幂等 scope（§5.10：`业务类型 + 主体ID`） */
export const IDEMPOTENT_SCOPE = {
  ORDER_CREATE: 'ORDER_CREATE',
  PAY_CREATE: 'PAY_CREATE',
  PAY_CALLBACK: 'PAY',
  REFUND_APPLY: 'REFUND_APPLY',
  STOCK_ADJUST: 'STOCK_ADJUST',
  RECHARGE_CREATE: 'RECHARGE_CREATE',
} as const;

/** 积分体系开关（§8：二期实现，一期恒 false，此处仅作为代码短路的判断源） */
export const POINT_ENABLED = false;
