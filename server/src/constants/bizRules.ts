/**
 * @file server/src/constants/bizRules.ts
 * @description 业务规则常量：运费 / 超时 / 售后 / 自动确认 / 数量上限 / 金额上限
 * @module constants
 * @see docs/01-PRD.md（业务规则）、docs/03-database.md §3.4（金额模型）
 * @author 软件开发团队
 * @created 2026-09-03
 *
 * 分层原则：
 * 本文件只放**不随环境变化**的业务常量（如「售后 7 天」这类写在 PRD 里的规则）；
 * 会随部署环境调整的参数（如超时分钟数、包邮门槛）一律从 `config` 读取。
 * 这样测试改配置不会误改业务规则，运营调阈值也不需要改代码。
 */

import { MONEY } from '@/config/constants';

/**
 * 运费规则。
 *
 * 注意：门槛与运费金额本身是可配置项（见 `config.freight`），
 * 这里只固化「满多少包邮、不满收多少」的**判定语义**，避免出现 `if (amount >= 9900)` 这类魔法数字。
 */
export const FREIGHT_RULE = {
  /**
   * 判定是否包邮。
   *
   * @description 以**商品金额**（`goods_amount - 促销优惠`）而非实付金额判定：
   * 用实付判定会让「用了券刚好低于门槛」的用户被收运费，属于明显的体感 bug
   * @param goodsAmountAfterPromo 促销后的商品金额（分）
   * @param freeThreshold 包邮门槛（分）
   * @returns 是否包邮
   */
  isFreeShipping: (goodsAmountAfterPromo: number, freeThreshold: number): boolean =>
    goodsAmountAfterPromo >= freeThreshold,
} as const;

/** 订单时效规则（天数/分钟数取自 config，这里固化默认兜底值与换算关系） */
export const ORDER_RULE = {
  /** 支付超时（分钟）默认 30 —— config 缺省时的兜底，正常情况下应读 config.order.payTimeoutMinutes */
  PAY_TIMEOUT_MINUTES_DEFAULT: 30,
  /** 发货后自动确认收货（天）默认 15 */
  AUTO_CONFIRM_DAYS_DEFAULT: 15,
  /** 售后期（天）默认 7 */
  AFTER_SALE_DAYS_DEFAULT: 7,
  /** 充值单支付超时（分钟），与订单支付超时同策略 */
  RECHARGE_TIMEOUT_MINUTES_DEFAULT: 30,
  /** 每天的分钟数，用于「天 → 毫秒」换算 */
  MINUTES_PER_DAY: 60 * 24,
} as const;

/** 购物车与下单数量规则 */
export const CART_RULE = {
  /** 单个 SKU 最大购买数量 */
  MAX_QUANTITY_PER_SKU: 999,
  /** 购物车最大条目数 */
  MAX_ITEM_COUNT: 100,
  /** 单次结算最大 SKU 种类数 */
  MAX_SKU_KINDS_PER_ORDER: 100,
} as const;

/** 金额规则（单位：分） */
export const AMOUNT_RULE = {
  /** 单笔金额上限（9000 万元），用于入参防御 */
  MAX_AMOUNT: MONEY.MAX_AMOUNT,
  /** 万分比基数（85 折 = 8500） */
  PERCENT_BASE: MONEY.PERCENT_BASE,
  /** 充值单笔下限（1 元） */
  RECHARGE_MIN_AMOUNT: 100,
  /** 充值单笔上限（50000 元） */
  RECHARGE_MAX_AMOUNT: 5_000_000,
  /** 优惠后金额下限：恒为 0，不允许出现负的实付金额（错误码 12011） */
  MIN_PAYABLE_AMOUNT: 0,
} as const;

/**
 * 四级扣减金额恒等式（docs/03-database.md §3.4）。
 *
 * ```
 * pay_amount = goods_amount
 *            - row_promo_discount      // 行级促销（满折 / 限时折扣）
 *            - order_promo_discount    // 订单级促销（满减，需分摊到行）
 *            - coupon_discount         // 优惠券
 *            - point_deduct_amount     // 积分抵扣（二期，一期恒 0）
 *            + freight_amount
 * ```
 *
 * 三个必须成立的恒等式（下单与退款都要校验）：
 * - E1 `Σ order_items.payable_amount === orders.pay_amount`
 * - E2 `Σ order_items.promo_discount === orders.row_promo_discount`
 * - E3 `Σ order_items.allocated_discount === orders.order_promo_discount + orders.coupon_discount`
 */
export const AMOUNT_IDENTITY = {
  /** 恒等式 E1：行实付合计 = 订单实付 */
  LINE_PAYABLE_SUM: 'Σ order_items.payable_amount === orders.pay_amount',
  /** 恒等式 E2：行级促销合计 = 订单行级促销 */
  ROW_PROMO_SUM: 'Σ order_items.promo_discount === orders.row_promo_discount',
  /** 恒等式 E3：分摊优惠合计 = 订单级促销 + 券 */
  ALLOCATED_SUM: 'Σ order_items.allocated_discount === orders.order_promo_discount + orders.coupon_discount',
  /** 主恒等式：四级扣减 */
  PAY_AMOUNT:
    'pay_amount = goods_amount - row_promo_discount - order_promo_discount - coupon_discount - point_deduct_amount + freight_amount',
} as const;

/** 库存规则 */
export const STOCK_RULE = {
  /** 库存预警阈值默认 10（可在 config 覆盖） */
  WARNING_THRESHOLD_DEFAULT: 10,
  /** 库存 CAS 失败重试次数 */
  CAS_MAX_RETRIES: 3,
} as const;

/** 登录与支付密码安全规则 */
export const SECURITY_RULE = {
  /** 登录连续失败锁定阈值（次） */
  LOGIN_MAX_FAILS: 5,
  /** 登录锁定时长（分钟） */
  LOGIN_LOCK_MINUTES: 15,
  /** 支付密码连续失败锁定阈值（次），复用登录锁定逻辑 */
  PAY_PASSWORD_MAX_FAILS: 5,
  /** 支付密码锁定时长（分钟） */
  PAY_PASSWORD_LOCK_MINUTES: 15,
  /** 密码最小长度 */
  PASSWORD_MIN_LENGTH: 8,
  /** 密码最大长度（超过会被截断，见 utils/hash.ts 的 sha256 前置哈希说明） */
  PASSWORD_MAX_LENGTH: 64,
} as const;

/** 分页与导出规则（与 config/constants.PAGING 保持一致的语义出口） */
export const LIST_RULE = {
  /** 默认页码 */
  DEFAULT_PAGE: 1,
  /** 默认每页条数 */
  DEFAULT_PAGE_SIZE: 20,
  /** 每页最大条数（防止?pageSize=1000000 拖垮数据库） */
  MAX_PAGE_SIZE: 100,
  /** 单次导出最大行数 */
  MAX_EXPORT_ROWS: 50_000,
} as const;
