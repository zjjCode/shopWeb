/**
 * @file server/src/constants/enums.ts
 * @description 业务枚举常量：与 Prisma schema 的 enum 一一对应，禁止在业务代码里硬编码状态字符串
 * @module constants
 * @see docs/03-database.md §1.1（枚举定义）
 * @author 软件开发团队
 * @created 2026-09-03
 *
 * 为什么要用 `as const` 对象而不是 TypeScript `enum`：
 * 1. `as const` 对象可以直接 `Object.values()` 做运行时校验（zod 白名单、seed 数据校验都要用），
 *    而 TS `enum` 编译后是双向映射对象，values 里会混入数字键，容易踩坑；
 * 2. 值类型收窄为字面量联合，写错状态名在编译期就会报错。
 *
 * 维护纪律：Prisma schema 增删枚举值时，**必须同步修改本文件**，
 * 否则编译期不会报错，但运行期会写到库里不存在的值。
 */

// ============================================================================
// 用户与权限域
// ============================================================================

/** 用户角色（C 端） */
export const UserRole = {
  USER: 'USER',
  ADMIN: 'ADMIN',
  SUPER_ADMIN: 'SUPER_ADMIN',
} as const;
export type UserRole = (typeof UserRole)[keyof typeof UserRole];

/** 用户状态 */
export const UserStatus = {
  ACTIVE: 'ACTIVE',
  DISABLED: 'DISABLED',
} as const;
export type UserStatus = (typeof UserStatus)[keyof typeof UserStatus];

/** RBAC 角色状态 */
export const RoleStatus = {
  ENABLED: 'ENABLED',
  DISABLED: 'DISABLED',
} as const;
export type RoleStatus = (typeof RoleStatus)[keyof typeof RoleStatus];

/** 数据权限范围（一期两档） */
export const DataScope = {
  /** 全部数据 */
  ALL: 'ALL',
  /** 仅自己创建的数据（查询层统一注入 creator_id 过滤） */
  SELF: 'SELF',
} as const;
export type DataScope = (typeof DataScope)[keyof typeof DataScope];

/** 后台管理员状态 */
export const AdminStatus = {
  ACTIVE: 'ACTIVE',
  DISABLED: 'DISABLED',
} as const;
export type AdminStatus = (typeof AdminStatus)[keyof typeof AdminStatus];

/** 操作人类型（资金流水 / 库存流水 / 订单轨迹共用） */
export const OperatorType = {
  USER: 'USER',
  ADMIN: 'ADMIN',
  SYSTEM: 'SYSTEM',
} as const;
export type OperatorType = (typeof OperatorType)[keyof typeof OperatorType];

/** Token 主体类型（C 端用户 / 后台管理员，复用 refresh_tokens 表） */
export const SubjectType = {
  USER: 'USER',
  ADMIN: 'ADMIN',
} as const;
export type SubjectType = (typeof SubjectType)[keyof typeof SubjectType];

/** 后台操作结果（操作日志） */
export const OpResult = {
  SUCCESS: 'SUCCESS',
  FAIL: 'FAIL',
} as const;
export type OpResult = (typeof OpResult)[keyof typeof OpResult];

// ============================================================================
// 商品域
// ============================================================================

/** 商品分类状态 */
export const CategoryStatus = {
  ENABLED: 'ENABLED',
  DISABLED: 'DISABLED',
} as const;
export type CategoryStatus = (typeof CategoryStatus)[keyof typeof CategoryStatus];

/**
 * 商品（SPU）状态。
 *
 * DRAFT / PENDING_AUDIT 为审核流预留（PRD P1），一期使用 ON_SALE / OFF_SALE。
 */
export const ProductStatus = {
  DRAFT: 'DRAFT',
  PENDING_AUDIT: 'PENDING_AUDIT',
  ON_SALE: 'ON_SALE',
  OFF_SALE: 'OFF_SALE',
} as const;
export type ProductStatus = (typeof ProductStatus)[keyof typeof ProductStatus];

/** SKU 状态 */
export const SkuStatus = {
  ENABLED: 'ENABLED',
  DISABLED: 'DISABLED',
} as const;
export type SkuStatus = (typeof SkuStatus)[keyof typeof SkuStatus];

/** 库存变动类型 */
export const StockChangeType = {
  /** 下单冻结：available → frozen */
  ORDER_FREEZE: 'ORDER_FREEZE',
  /** 支付确认：frozen → sold */
  ORDER_CONFIRM: 'ORDER_CONFIRM',
  /** 取消/超时释放：frozen → available */
  ORDER_RELEASE: 'ORDER_RELEASE',
  /** 退款回仓：sold → available */
  REFUND_RETURN: 'REFUND_RETURN',
  /** 手工入库：→ available */
  MANUAL_IN: 'MANUAL_IN',
  /** 手工报损：available → 出账 */
  MANUAL_LOSS: 'MANUAL_LOSS',
  /** 盘点修正（可正可负，修正 available） */
  MANUAL_CHECK: 'MANUAL_CHECK',
} as const;
export type StockChangeType = (typeof StockChangeType)[keyof typeof StockChangeType];

// ============================================================================
// 订单域
// ============================================================================

/** 订单状态 */
export const OrderStatus = {
  /** 待支付 */
  PENDING_PAYMENT: 'PENDING_PAYMENT',
  /** 已支付（待发货） */
  PAID: 'PAID',
  /** 已发货（待收货） */
  SHIPPED: 'SHIPPED',
  /** 已完成 */
  COMPLETED: 'COMPLETED',
  /** 已取消 */
  CANCELLED: 'CANCELLED',
  /** 退款中 */
  REFUNDING: 'REFUNDING',
  /** 已退款 */
  REFUNDED: 'REFUNDED',
} as const;
export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

/** 订单取消原因 */
export const CancelReason = {
  USER_CANCEL: 'USER_CANCEL',
  ADMIN_CANCEL: 'ADMIN_CANCEL',
  TIMEOUT: 'TIMEOUT',
  SYSTEM: 'SYSTEM',
} as const;
export type CancelReason = (typeof CancelReason)[keyof typeof CancelReason];

// ============================================================================
// 支付 / 退款域
// ============================================================================

/**
 * 支付渠道。
 *
 * BALANCE（余额）为本地记账，不走外部渠道，因此没有回调、也不需要验签。
 */
export const PayChannel = {
  /** 模拟支付（沙箱 / 生产降级） */
  MOCK: 'MOCK',
  /** 支付宝 */
  ALIPAY: 'ALIPAY',
  /** 微信支付 */
  WECHAT: 'WECHAT',
  /** 银行卡（聚合支付服务商：网关支付 / 快捷支付） */
  BANKCARD: 'BANKCARD',
  /** 用户余额（本地事务，无外部调用） */
  BALANCE: 'BALANCE',
} as const;
export type PayChannel = (typeof PayChannel)[keyof typeof PayChannel];

/** 子支付方式（同一渠道下的不同支付场景） */
export const SubChannel = {
  /** 支付宝 PC 网页支付 / 银行卡网关 */
  WEB: 'WEB',
  /** 支付宝当面付扫码 / 微信 Native */
  SCAN: 'SCAN',
  /** 微信内 / 公众号 */
  JSAPI: 'JSAPI',
  /** 非微信手机浏览器 */
  H5: 'H5',
  /** 银行卡网关支付（跳转聚合商收银台选银行） */
  GATEWAY: 'GATEWAY',
  /** 银行卡快捷支付（绑卡 + 短信） */
  QUICK: 'QUICK',
  /** 余额支付（与 channel=BALANCE 配对） */
  BALANCE: 'BALANCE',
} as const;
export type SubChannel = (typeof SubChannel)[keyof typeof SubChannel];

/** 支付单业务类型：一张 payments 表同时承载「订单支付」与「余额充值」 */
export const PaymentBizType = {
  /** 订单支付（关联 orders.order_no） */
  ORDER: 'ORDER',
  /** 余额充值（关联 recharge_orders.recharge_no） */
  RECHARGE: 'RECHARGE',
} as const;
export type PaymentBizType = (typeof PaymentBizType)[keyof typeof PaymentBizType];

/** 充值单状态 */
export const RechargeStatus = {
  /** 待支付 */
  PENDING: 'PENDING',
  /** 充值成功（余额已到账） */
  SUCCESS: 'SUCCESS',
  /** 已关闭（超时 30 分钟 / 用户取消） */
  CLOSED: 'CLOSED',
} as const;
export type RechargeStatus = (typeof RechargeStatus)[keyof typeof RechargeStatus];

/** 支付单状态 */
export const PayStatus = {
  /** 待支付 */
  PENDING: 'PENDING',
  /** 支付成功 */
  SUCCESS: 'SUCCESS',
  /** 已关闭 */
  CLOSED: 'CLOSED',
  /** 支付失败 */
  FAILED: 'FAILED',
  /** 已全额退款 */
  REFUNDED: 'REFUNDED',
} as const;
export type PayStatus = (typeof PayStatus)[keyof typeof PayStatus];

/** 退款类型 */
export const RefundType = {
  FULL: 'FULL',
  PARTIAL: 'PARTIAL',
} as const;
export type RefundType = (typeof RefundType)[keyof typeof RefundType];

/** 退款单状态 */
export const RefundStatus = {
  /** 待审核 */
  PENDING: 'PENDING',
  /** 已驳回 */
  REJECTED: 'REJECTED',
  /** 退款中（已调渠道） */
  PROCESSING: 'PROCESSING',
  /** 退款成功 */
  SUCCESS: 'SUCCESS',
  /** 退款失败（可重试） */
  FAILED: 'FAILED',
} as const;
export type RefundStatus = (typeof RefundStatus)[keyof typeof RefundStatus];

/** 退款去向（单一支付方式下退款去向唯一，不存在拆分） */
export const RefundTarget = {
  /** 退回用户余额账户（本地事务，即时到账） */
  BALANCE: 'BALANCE',
  /** 原路退回原渠道（调渠道 refund） */
  CHANNEL: 'CHANNEL',
} as const;
export type RefundTarget = (typeof RefundTarget)[keyof typeof RefundTarget];

/** 渠道回调处理状态（回调接口只落日志 + 投递队列，由 Worker 消费） */
export const PaymentNotifyStatus = {
  /** 已收回调（已落 integration_call_logs） */
  RECEIVED: 'RECEIVED',
  /** 已投递 BullMQ */
  QUEUED: 'QUEUED',
  /** Worker 已成功消费并完成入账事务 */
  CONSUMED: 'CONSUMED',
  /** 重复通知被幂等跳过 */
  SKIPPED: 'SKIPPED',
  /** 重试耗尽，进入死信，需人工介入 */
  DEAD: 'DEAD',
} as const;
export type PaymentNotifyStatus = (typeof PaymentNotifyStatus)[keyof typeof PaymentNotifyStatus];

// ============================================================================
// 资金域
// ============================================================================

/** 资金方向：IN = 入账，OUT = 出账 */
export const FundDirection = {
  IN: 'IN',
  OUT: 'OUT',
} as const;
export type FundDirection = (typeof FundDirection)[keyof typeof FundDirection];

/**
 * 资金业务类型。
 *
 * ⚠️ `LIABILITY_SETTLE_OUT` 必须**晚于** `LIABILITY_SETTLE_IN` 写入（先 IN 后 OUT），
 * 否则中间态可能触发 `fund_accounts` 的 `CHECK(balance >= 0)`。详见 §3.6.4。
 */
export const FundBizType = {
  // ---- 订单 / 退款 / 调账（记在 PLATFORM_CASH 账户）----
  /** 渠道支付订单入账（IN） */
  ORDER_PAY: 'ORDER_PAY',
  /** 订单整单退款（OUT） */
  ORDER_REFUND: 'ORDER_REFUND',
  /** 订单部分退款（OUT） */
  ORDER_REFUND_PART: 'ORDER_REFUND_PART',
  /** 已支付订单取消退款（OUT） */
  ORDER_CANCEL_REFUND: 'ORDER_CANCEL_REFUND',
  /** 支付渠道手续费（OUT） */
  CHANNEL_FEE: 'CHANNEL_FEE',
  /** 运费补收（IN） */
  FREIGHT_ADD: 'FREIGHT_ADD',
  /** 运费退还（OUT） */
  FREIGHT_REFUND: 'FREIGHT_REFUND',
  /** 手工调账-补记（IN） */
  MANUAL_ADJUST_IN: 'MANUAL_ADJUST_IN',
  /** 手工调账-冲减（OUT） */
  MANUAL_ADJUST_OUT: 'MANUAL_ADJUST_OUT',
  /** 冲正流水（与原流水反向，related_tx_no 必填） */
  REVERSAL: 'REVERSAL',

  // ---- 充值侧 ----
  /** 充值：平台账户收到渠道款项（IN，is_liability=true，是负债不是收入） */
  PLATFORM_RECHARGE_IN: 'PLATFORM_RECHARGE_IN',
  /** 充值：用户余额账户入账（IN） */
  BALANCE_RECHARGE: 'BALANCE_RECHARGE',
  /** 充值赠送：用户余额账户入账（IN，对应平台侧记营销费用，不进收入） */
  BALANCE_GIFT: 'BALANCE_GIFT',

  // ---- 消费 / 退款侧（USER_BALANCE 账户）----
  /** 余额支付订单（OUT） */
  BALANCE_CONSUME: 'BALANCE_CONSUME',
  /** 余额支付失败/关单回滚（IN） */
  BALANCE_ROLLBACK: 'BALANCE_ROLLBACK',
  /** 退款退回余额（IN） */
  BALANCE_REFUND: 'BALANCE_REFUND',
  /** 余额手工调账-补记（IN，super_admin，必填原因） */
  BALANCE_ADJUST_IN: 'BALANCE_ADJUST_IN',
  /** 余额手工调账-冲减（OUT，super_admin，必填原因） */
  BALANCE_ADJUST_OUT: 'BALANCE_ADJUST_OUT',
  /** 余额提现（OUT，一期不做，占位） */
  BALANCE_WITHDRAW: 'BALANCE_WITHDRAW',

  // ---- 负债结转对（记在 PLATFORM_CASH 账户，必须成对、共享 tx_group_no）----
  /** 结转：负债转收入（IN，is_liability=false，先写） */
  LIABILITY_SETTLE_IN: 'LIABILITY_SETTLE_IN',
  /** 结转：冲减负债（OUT，is_liability=true，后写） */
  LIABILITY_SETTLE_OUT: 'LIABILITY_SETTLE_OUT',
} as const;
export type FundBizType = (typeof FundBizType)[keyof typeof FundBizType];

/**
 * 账户类型。
 *
 * 平台现金账户全局 1 条，其「余额」= 平台实际持有的现金；
 * 用户余额负债账户每用户 1 条，其「余额」= 平台对该用户的负债。
 */
export const FundAccountType = {
  /** 平台现金账户（全局 1 条） */
  PLATFORM_CASH: 'PLATFORM_CASH',
  /** 用户余额负债账户（每用户 1 条） */
  USER_BALANCE: 'USER_BALANCE',
  /** 二阶段积分账户预留 */
  POINT: 'POINT',
} as const;
export type FundAccountType = (typeof FundAccountType)[keyof typeof FundAccountType];

/** 资金账户状态（FROZEN 用于风控/争议场景冻结用户余额） */
export const AccountStatus = {
  ACTIVE: 'ACTIVE',
  FROZEN: 'FROZEN',
} as const;
export type AccountStatus = (typeof AccountStatus)[keyof typeof AccountStatus];

// ============================================================================
// 优惠券 / 促销域
// ============================================================================

/** 券类型 */
export const CouponType = {
  /** 满减券：threshold_amount(>0) + discount_amount(分) */
  FULL_REDUCE: 'FULL_REDUCE',
  /** 折扣券：threshold_amount + discount_rate(万分比) + max_discount(必填) */
  DISCOUNT: 'DISCOUNT',
  /** 无门槛券：threshold_amount 恒 0 + discount_amount(分) */
  NO_THRESHOLD: 'NO_THRESHOLD',
} as const;
export type CouponType = (typeof CouponType)[keyof typeof CouponType];

/** 券有效期策略（两种互斥） */
export const CouponValidType = {
  /** 固定时间段：valid_start ~ valid_end */
  FIXED_RANGE: 'FIXED_RANGE',
  /** 领取后 N 天有效：valid_days，领取时算 expire_at */
  AFTER_CLAIM: 'AFTER_CLAIM',
} as const;
export type CouponValidType = (typeof CouponValidType)[keyof typeof CouponValidType];

/** 券模板状态（运营侧生命周期） */
export const CouponTemplateStatus = {
  /** 未开始（已创建但未到 claim_start_at） */
  NOT_START: 'NOT_START',
  /** 可领取 */
  CLAIMABLE: 'CLAIMABLE',
  /** 已暂停（运营手动） */
  PAUSED: 'PAUSED',
  /** 已结束（到 claim_end_at 或发完） */
  ENDED: 'ENDED',
} as const;
export type CouponTemplateStatus = (typeof CouponTemplateStatus)[keyof typeof CouponTemplateStatus];

/**
 * 券实例状态（用户侧生命周期）。
 *
 * ⚠️ 权威口径：`UNUSED / LOCKED / USED / EXPIRED / INVALIDATED`。
 * `02-architecture.md` §11.4 中出现的 `AVAILABLE` / `FROZEN` 是文档笔误，代码中不得使用。
 */
export const CouponStatus = {
  /** 已领取·未使用 */
  UNUSED: 'UNUSED',
  /** 已占用·锁定（提交订单时占用，与订单同事务） */
  LOCKED: 'LOCKED',
  /** 已使用（支付成功） */
  USED: 'USED',
  /** 已过期（定时任务批量置位） */
  EXPIRED: 'EXPIRED',
  /** 已作废（运营整批作废） */
  INVALIDATED: 'INVALIDATED',
} as const;
export type CouponStatus = (typeof CouponStatus)[keyof typeof CouponStatus];

/** 券轨迹业务动作 */
export const CouponLogBizType = {
  /** 领取 */
  CLAIM: 'CLAIM',
  /** 下单占用 */
  LOCK: 'LOCK',
  /** 解冻（取消/超时/支付失败） */
  UNLOCK: 'UNLOCK',
  /** 核销（支付成功） */
  USE: 'USE',
  /** 退款返还（整单退款） */
  RESTORE: 'RESTORE',
  /** 过期 */
  EXPIRE: 'EXPIRE',
  /** 运营作废 */
  INVALIDATE: 'INVALIDATE',
} as const;
export type CouponLogBizType = (typeof CouponLogBizType)[keyof typeof CouponLogBizType];

/** 适用范围类型（券模板与促销活动共用语义，各自一张关联表） */
export const ScopeType = {
  /** 全场通用 */
  ALL: 'ALL',
  /** 指定分类 */
  CATEGORY: 'CATEGORY',
  /** 指定商品（SPU） */
  PRODUCT: 'PRODUCT',
  /** 排除商品（SKU/SPU 黑名单） */
  EXCLUDE_PRODUCT: 'EXCLUDE_PRODUCT',
} as const;
export type ScopeType = (typeof ScopeType)[keyof typeof ScopeType];

/** 促销活动类型 */
export const PromotionType = {
  /** 满减：订单级，满 N 分减 M 分，可阶梯 */
  FULL_REDUCE: 'FULL_REDUCE',
  /** 满折：行级，参与商品打 X 折（discount_rate 万分比） */
  FULL_DISCOUNT: 'FULL_DISCOUNT',
  /** 限时折扣：行级，指定商品按折扣价/固定价销售 */
  FLASH_SALE: 'FLASH_SALE',
} as const;
export type PromotionType = (typeof PromotionType)[keyof typeof PromotionType];

/**
 * 促销活动作用层级。
 *
 * 这是金额分摊的分水岭：ORDER 级优惠**必须**分摊到行（退款按行计算），
 * ROW 级优惠天然归属该行，无需分摊。
 */
export const PromotionLevel = {
  /** 订单级（满减）：优惠需分摊到行 */
  ORDER: 'ORDER',
  /** 行级（满折 / 限时折扣）：天然归属该行，无需分摊 */
  ROW: 'ROW',
} as const;
export type PromotionLevel = (typeof PromotionLevel)[keyof typeof PromotionLevel];

/** 促销活动状态 */
export const PromotionStatus = {
  /** 草稿 */
  DRAFT: 'DRAFT',
  /** 已启用 */
  ENABLED: 'ENABLED',
  /** 已停用 */
  DISABLED: 'DISABLED',
  /** 已结束 */
  ENDED: 'ENDED',
} as const;
export type PromotionStatus = (typeof PromotionStatus)[keyof typeof PromotionStatus];

// ============================================================================
// 系统 / 基础设施域
// ============================================================================

/** 支付方式（后台可配置）状态 */
export const PaymentMethodStatus = {
  /** 正常，可选 */
  NORMAL: 'NORMAL',
  /** 维护中（展示但不可选，带提示文案） */
  MAINTAINING: 'MAINTAINING',
} as const;
export type PaymentMethodStatus = (typeof PaymentMethodStatus)[keyof typeof PaymentMethodStatus];

/** 幂等记录状态 */
export const IdempotencyStatus = {
  PROCESSING: 'PROCESSING',
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
} as const;
export type IdempotencyStatus = (typeof IdempotencyStatus)[keyof typeof IdempotencyStatus];

/** 文件存储类型 */
export const StorageType = {
  LOCAL: 'LOCAL',
  OSS: 'OSS',
} as const;
export type StorageType = (typeof StorageType)[keyof typeof StorageType];

/** 第三方适配器类型 */
export const AdapterType = {
  PAYMENT: 'PAYMENT',
  LOGISTICS: 'LOGISTICS',
  SUPPORT: 'SUPPORT',
  SMS: 'SMS',
} as const;
export type AdapterType = (typeof AdapterType)[keyof typeof AdapterType];
