/**
 * @file server/src/core/errors/errorCodes.ts
 * @description 错误码常量表 + 码 → {HTTP 状态, 默认文案} 映射
 * @module core/errors
 * @see docs/02-architecture.md §5.2（异常体系与错误码）
 * @author 软件开发团队
 * @created 2026-09-03
 *
 * 分段规则（§5.2）：
 *  0      成功
 *  10xxx  用户与认证        11xxx 收货地址      12xxx [v2] 优惠券与促销
 *  20xxx  商品分类          21xxx 商品与 SKU    30xxx 购物车      31xxx 订单
 *  40xxx  支付              41xxx 退款          50xxx 库存
 *  60xxx  资金与对账        61xxx [v2] 余额与充值
 *  70xxx  后台管理与权限（含 RBAC）              80xxx 第三方适配器  90xxx 系统与通用
 */

/**
 * 错误码常量。
 *
 * 命名规则：<域>_<语义>，如 `ORDER_STATUS_INVALID`。
 * 业务代码**禁止**直接写数字字面量，一律引用本常量，便于全局检索与重构。
 */
export const ErrorCode = {
  /** 成功 */
  SUCCESS: 0,

  // ---------------- 10xxx 用户与认证 ----------------
  PHONE_INVALID: 10001,
  PHONE_REGISTERED: 10002,
  BAD_CREDENTIALS: 10003,
  ACCOUNT_DISABLED: 10004,
  ACCESS_TOKEN_EXPIRED: 10005,
  REFRESH_TOKEN_REVOKED: 10006,
  REFRESH_TOKEN_EXPIRED: 10007,
  REFRESH_TOKEN_REPLAYED: 10008,
  RESOURCE_FORBIDDEN: 10009,
  PERMISSION_DENIED: 10010,
  LOGIN_TOO_MANY_ATTEMPTS: 10011,

  // ---------------- 11xxx 收货地址 ----------------
  ADDRESS_NOT_FOUND: 11001,
  ADDRESS_IN_USE: 11002,
  ADDRESS_DETAIL_LENGTH: 11003,

  // ---------------- 12xxx [v2] 优惠券与促销 ----------------
  COUPON_NOT_FOUND: 12001,
  COUPON_SOLD_OUT: 12002,
  COUPON_LIMIT_EXCEEDED: 12003,
  COUPON_USED: 12004,
  COUPON_EXPIRED: 12005,
  COUPON_INVALIDATED: 12006,
  COUPON_FROZEN: 12007,
  COUPON_THRESHOLD_NOT_MET: 12008,
  COUPON_NOT_APPLICABLE: 12009,
  COUPON_ONLY_ONE_PER_ORDER: 12010,
  COUPON_AMOUNT_NEGATIVE: 12011,
  PROMOTION_NOT_FOUND: 12012,
  PROMOTION_TIME_CONFLICT: 12013,
  PROMOTION_RULE_INVALID: 12014,

  // ---------------- 20xxx 商品分类 ----------------
  CATEGORY_NOT_FOUND: 20001,
  CATEGORY_LEVEL_EXCEEDED: 20002,
  CATEGORY_HAS_PRODUCTS: 20003,

  // ---------------- 21xxx 商品与 SKU ----------------
  PRODUCT_NOT_FOUND: 21001,
  SKU_NOT_FOUND: 21002,
  SKU_CODE_DUPLICATED: 21003,
  SKU_SPEC_DUPLICATED: 21004,
  PRODUCT_HAS_OPEN_ORDERS: 21005,

  // ---------------- 30xxx 购物车 ----------------
  CART_ITEM_NOT_FOUND: 30001,
  CART_QUANTITY_INVALID: 30002,
  CART_ITEM_QUANTITY_LIMIT: 30003,
  CART_ITEM_COUNT_LIMIT: 30004,
  CART_HAS_INVALID_ITEMS: 30005,

  // ---------------- 31xxx 订单 ----------------
  ORDER_NOT_FOUND: 31001,
  ORDER_STATUS_INVALID: 31002,
  ORDER_AMOUNT_INVALID: 31003,
  ORDER_TIMEOUT_CLOSED: 31004,
  ORDER_AFTER_SALE_EXPIRED: 31005,
  ORDER_CANCELED: 31006,
  ORDER_PAY_TIMEOUT: 31007,

  // ---------------- 40xxx 支付 ----------------
  PAYMENT_NOT_FOUND: 40001,
  PAYMENT_AMOUNT_MISMATCH: 40002,
  PAYMENT_CLOSED: 40003,
  PAYMENT_FINAL_STATE: 40004,
  PAYMENT_CHANNEL_MISMATCH: 40005,

  // ---------------- 41xxx 退款 ----------------
  REFUND_NOT_FOUND: 41001,
  REFUND_AMOUNT_EXCEEDED: 41002,
  REFUND_IN_PROGRESS: 41003,
  REFUND_EXEC_FAILED: 41004,

  // ---------------- 50xxx 库存 ----------------
  STOCK_NOT_ENOUGH: 50001,
  STOCK_CONFLICT: 50002,
  STOCK_ADJUST_REASON_REQUIRED: 50003,
  STOCK_NEGATIVE: 50004,

  // ---------------- 60xxx 资金与对账 ----------------
  FUND_RECORD_FAILED: 60001,
  FUND_TX_IMMUTABLE: 60002,
  FUND_REVERSAL_NEEDS_ORIGIN: 60003,
  FUND_RECONCILE_MISMATCH: 60004,
  FUND_ADJUST_REASON_REQUIRED: 60005,

  // ---------------- 61xxx [v2] 余额与充值 ----------------
  BALANCE_ACCOUNT_NOT_FOUND: 61001,
  BALANCE_NOT_ENOUGH: 61002,
  BALANCE_ACCOUNT_FROZEN: 61003,
  RECHARGE_AMOUNT_INVALID: 61004,
  RECHARGE_NOT_FOUND: 61005,
  RECHARGE_ALREADY_PAID: 61006,
  PAY_PASSWORD_INCORRECT: 61007,
  PAY_PASSWORD_LOCKED: 61008,
  PAY_PASSWORD_NOT_SET: 61009,
  BALANCE_NEGATIVE: 61010,

  // ---------------- 70xxx 后台管理与权限 ----------------
  SUPER_ADMIN_ONLY: 70001,
  ADMIN_NOT_FOUND: 70002,
  SENSITIVE_OPERATION_CONFIRM: 70003,
  ROLE_NOT_FOUND: 70004,
  ROLE_BUILTIN_IMMUTABLE: 70005,
  ROLE_HAS_ADMINS: 70006,
  LAST_SUPER_ADMIN_UNBINDABLE: 70007,
  PERMISSION_NOT_FOUND: 70008,
  PAY_CHANNEL_CONFIG_INCOMPLETE: 70009,
  MOCK_CHANNEL_FORBIDDEN_IN_PROD: 70010,

  // ---------------- 80xxx 第三方适配器 ----------------
  PAYMENT_CHANNEL_FAILED: 80001,
  LOGISTICS_QUERY_FAILED: 80002,
  SMS_SEND_FAILED: 80003,
  ADAPTER_NOT_IMPLEMENTED: 80004,
  ADAPTER_TIMEOUT: 80005,

  // ---------------- 90xxx 系统与通用 ----------------
  VALIDATION_FAILED: 90001,
  FIELD_FORMAT_INVALID: 90002,
  ROUTE_NOT_FOUND: 90003,
  TOO_MANY_REQUESTS: 90004,
  IDEMPOTENT_PROCESSING: 90005,
  IDEMPOTENT_FINGERPRINT_MISMATCH: 90006,
  SYSTEM_INTERNAL: 90007,
  DEPENDENCY_UNAVAILABLE: 90008,
} as const;

/** 错误码联合类型 */
export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/** 单个错误码的元信息 */
export interface ErrorMeta {
  /** 对应的 HTTP 状态码（表达语义大类） */
  httpStatus: number;
  /** 默认中文文案，可直接展示给用户 */
  message: string;
}

/**
 * 错误码 → 元信息映射表（一期全量，与 §5.2 错误码分配表一一对应）。
 *
 * HTTP 状态码与业务 code 是**双轨制**：HTTP 表达语义大类（前端拦截器按此分派），
 * code 表达具体错误（前端按此做细分处理）。
 */
export const ERROR_META: Record<ErrorCodeValue, ErrorMeta> = {
  [ErrorCode.SUCCESS]: { httpStatus: 200, message: 'OK' },

  [ErrorCode.PHONE_INVALID]: { httpStatus: 400, message: '手机号格式不正确' },
  [ErrorCode.PHONE_REGISTERED]: { httpStatus: 409, message: '手机号已注册' },
  [ErrorCode.BAD_CREDENTIALS]: { httpStatus: 401, message: '账号或密码错误' },
  [ErrorCode.ACCOUNT_DISABLED]: { httpStatus: 403, message: '账号已被禁用' },
  [ErrorCode.ACCESS_TOKEN_EXPIRED]: { httpStatus: 401, message: '登录已失效，请重新登录' },
  [ErrorCode.REFRESH_TOKEN_REVOKED]: { httpStatus: 401, message: 'Refresh Token 无效或已吊销' },
  [ErrorCode.REFRESH_TOKEN_EXPIRED]: { httpStatus: 401, message: 'Refresh Token 已过期' },
  [ErrorCode.REFRESH_TOKEN_REPLAYED]: { httpStatus: 401, message: '检测到 Token 重放，已吊销该设备会话' },
  [ErrorCode.RESOURCE_FORBIDDEN]: { httpStatus: 403, message: '无权访问该资源' },
  [ErrorCode.PERMISSION_DENIED]: { httpStatus: 403, message: '需要更高权限' },
  [ErrorCode.LOGIN_TOO_MANY_ATTEMPTS]: { httpStatus: 429, message: '登录尝试过于频繁，请 15 分钟后再试' },

  [ErrorCode.ADDRESS_NOT_FOUND]: { httpStatus: 404, message: '收货地址不存在' },
  [ErrorCode.ADDRESS_IN_USE]: { httpStatus: 409, message: '该地址存在进行中订单，不可删除' },
  [ErrorCode.ADDRESS_DETAIL_LENGTH]: { httpStatus: 400, message: '详细地址长度需在 5-100 字之间' },

  [ErrorCode.COUPON_NOT_FOUND]: { httpStatus: 404, message: '优惠券不存在' },
  [ErrorCode.COUPON_SOLD_OUT]: { httpStatus: 409, message: '优惠券已被领完' },
  [ErrorCode.COUPON_LIMIT_EXCEEDED]: { httpStatus: 409, message: '已达该券每人限领上限' },
  [ErrorCode.COUPON_USED]: { httpStatus: 409, message: '优惠券已使用' },
  [ErrorCode.COUPON_EXPIRED]: { httpStatus: 409, message: '优惠券已过期' },
  [ErrorCode.COUPON_INVALIDATED]: { httpStatus: 409, message: '优惠券已作废' },
  [ErrorCode.COUPON_FROZEN]: { httpStatus: 409, message: '优惠券正被其他订单占用' },
  [ErrorCode.COUPON_THRESHOLD_NOT_MET]: { httpStatus: 422, message: '订单金额未达该券使用门槛' },
  [ErrorCode.COUPON_NOT_APPLICABLE]: { httpStatus: 422, message: '该券不适用于订单内商品' },
  [ErrorCode.COUPON_ONLY_ONE_PER_ORDER]: { httpStatus: 409, message: '一笔订单仅可使用一张优惠券' },
  [ErrorCode.COUPON_AMOUNT_NEGATIVE]: { httpStatus: 422, message: '优惠后金额不可为负' },
  [ErrorCode.PROMOTION_NOT_FOUND]: { httpStatus: 404, message: '促销活动不存在或已结束' },
  [ErrorCode.PROMOTION_TIME_CONFLICT]: { httpStatus: 409, message: '活动时间区间与已有活动冲突' },
  [ErrorCode.PROMOTION_RULE_INVALID]: { httpStatus: 400, message: '活动规则参数不合法' },

  [ErrorCode.CATEGORY_NOT_FOUND]: { httpStatus: 404, message: '分类不存在' },
  [ErrorCode.CATEGORY_LEVEL_EXCEEDED]: { httpStatus: 409, message: '最多支持三级分类' },
  [ErrorCode.CATEGORY_HAS_PRODUCTS]: { httpStatus: 409, message: '该分类下存在商品，请先移除' },

  [ErrorCode.PRODUCT_NOT_FOUND]: { httpStatus: 404, message: '商品不存在或已下架' },
  [ErrorCode.SKU_NOT_FOUND]: { httpStatus: 404, message: 'SKU 不存在' },
  [ErrorCode.SKU_CODE_DUPLICATED]: { httpStatus: 409, message: 'SKU 编码已存在' },
  [ErrorCode.SKU_SPEC_DUPLICATED]: { httpStatus: 409, message: '同一商品下规格组合重复' },
  [ErrorCode.PRODUCT_HAS_OPEN_ORDERS]: { httpStatus: 409, message: '该商品存在未完结订单，不可删除' },

  [ErrorCode.CART_ITEM_NOT_FOUND]: { httpStatus: 404, message: '购物车条目不存在' },
  [ErrorCode.CART_QUANTITY_INVALID]: { httpStatus: 400, message: '数量必须大于 0' },
  [ErrorCode.CART_ITEM_QUANTITY_LIMIT]: { httpStatus: 409, message: '单个 SKU 数量不可超过 999' },
  [ErrorCode.CART_ITEM_COUNT_LIMIT]: { httpStatus: 409, message: '购物车条目不可超过 100 条' },
  [ErrorCode.CART_HAS_INVALID_ITEMS]: { httpStatus: 409, message: '存在失效商品，请处理后结算' },

  [ErrorCode.ORDER_NOT_FOUND]: { httpStatus: 404, message: '订单不存在' },
  [ErrorCode.ORDER_STATUS_INVALID]: { httpStatus: 409, message: '订单当前状态不允许该操作' },
  [ErrorCode.ORDER_AMOUNT_INVALID]: { httpStatus: 409, message: '订单金额校验失败' },
  [ErrorCode.ORDER_TIMEOUT_CLOSED]: { httpStatus: 409, message: '订单已超时关闭' },
  [ErrorCode.ORDER_AFTER_SALE_EXPIRED]: { httpStatus: 409, message: '超出售后期，无法申请退款' },
  [ErrorCode.ORDER_CANCELED]: { httpStatus: 409, message: '订单已取消' },
  [ErrorCode.ORDER_PAY_TIMEOUT]: { httpStatus: 400, message: '请先在 30 分钟内完成支付' },

  [ErrorCode.PAYMENT_NOT_FOUND]: { httpStatus: 404, message: '支付单不存在' },
  [ErrorCode.PAYMENT_AMOUNT_MISMATCH]: { httpStatus: 409, message: '支付金额与订单金额不一致' },
  [ErrorCode.PAYMENT_CLOSED]: { httpStatus: 409, message: '支付单已关闭' },
  [ErrorCode.PAYMENT_FINAL_STATE]: { httpStatus: 409, message: '支付单状态已终态' },
  [ErrorCode.PAYMENT_CHANNEL_MISMATCH]: { httpStatus: 409, message: '该支付单支付方式与请求不匹配' },

  [ErrorCode.REFUND_NOT_FOUND]: { httpStatus: 404, message: '退款单不存在' },
  [ErrorCode.REFUND_AMOUNT_EXCEEDED]: { httpStatus: 409, message: '退款金额超过可退金额' },
  [ErrorCode.REFUND_IN_PROGRESS]: { httpStatus: 409, message: '存在进行中的退款单' },
  [ErrorCode.REFUND_EXEC_FAILED]: { httpStatus: 502, message: '退款执行失败，请稍后重试' },

  [ErrorCode.STOCK_NOT_ENOUGH]: { httpStatus: 409, message: '库存不足' },
  [ErrorCode.STOCK_CONFLICT]: { httpStatus: 409, message: '库存变更冲突，请重试' },
  [ErrorCode.STOCK_ADJUST_REASON_REQUIRED]: { httpStatus: 400, message: '库存调整必须填写原因' },
  [ErrorCode.STOCK_NEGATIVE]: { httpStatus: 409, message: '库存调整后不能为负数' },

  [ErrorCode.FUND_RECORD_FAILED]: { httpStatus: 409, message: '资金流水记账失败' },
  [ErrorCode.FUND_TX_IMMUTABLE]: { httpStatus: 409, message: '不支持直接修改或删除资金流水' },
  [ErrorCode.FUND_REVERSAL_NEEDS_ORIGIN]: { httpStatus: 409, message: '冲正流水必须关联原流水号' },
  [ErrorCode.FUND_RECONCILE_MISMATCH]: { httpStatus: 422, message: '对账不平：实付金额与流水净额不一致' },
  [ErrorCode.FUND_ADJUST_REASON_REQUIRED]: { httpStatus: 409, message: '手工调账必须填写原因' },

  [ErrorCode.BALANCE_ACCOUNT_NOT_FOUND]: { httpStatus: 404, message: '余额账户不存在' },
  [ErrorCode.BALANCE_NOT_ENOUGH]: { httpStatus: 409, message: '余额不足' },
  [ErrorCode.BALANCE_ACCOUNT_FROZEN]: { httpStatus: 409, message: '余额账户已冻结' },
  [ErrorCode.RECHARGE_AMOUNT_INVALID]: { httpStatus: 400, message: '充值金额需在 1 元 ~ 50000 元之间' },
  [ErrorCode.RECHARGE_NOT_FOUND]: { httpStatus: 404, message: '充值单不存在或已关闭' },
  [ErrorCode.RECHARGE_ALREADY_PAID]: { httpStatus: 409, message: '充值单已支付，不可重复支付' },
  [ErrorCode.PAY_PASSWORD_INCORRECT]: { httpStatus: 401, message: '支付密码错误' },
  [ErrorCode.PAY_PASSWORD_LOCKED]: { httpStatus: 429, message: '支付密码错误次数过多，账户已临时锁定' },
  [ErrorCode.PAY_PASSWORD_NOT_SET]: { httpStatus: 409, message: '未设置支付密码，请先设置' },
  [ErrorCode.BALANCE_NEGATIVE]: { httpStatus: 409, message: '余额账户余额不可为负' },

  [ErrorCode.SUPER_ADMIN_ONLY]: { httpStatus: 403, message: '仅超级管理员可执行该操作' },
  [ErrorCode.ADMIN_NOT_FOUND]: { httpStatus: 404, message: '管理员不存在' },
  [ErrorCode.SENSITIVE_OPERATION_CONFIRM]: { httpStatus: 409, message: '敏感操作需要二次确认' },
  [ErrorCode.ROLE_NOT_FOUND]: { httpStatus: 404, message: '角色不存在' },
  [ErrorCode.ROLE_BUILTIN_IMMUTABLE]: { httpStatus: 409, message: '内置角色不可删除或修改权限' },
  [ErrorCode.ROLE_HAS_ADMINS]: { httpStatus: 409, message: '该角色下存在管理员，不可删除' },
  [ErrorCode.LAST_SUPER_ADMIN_UNBINDABLE]: { httpStatus: 409, message: '不可解绑最后一个超级管理员' },
  [ErrorCode.PERMISSION_NOT_FOUND]: { httpStatus: 404, message: '权限点不存在' },
  [ErrorCode.PAY_CHANNEL_CONFIG_INCOMPLETE]: { httpStatus: 409, message: '该支付渠道配置不完整，无法启用' },
  [ErrorCode.MOCK_CHANNEL_FORBIDDEN_IN_PROD]: { httpStatus: 403, message: '生产环境不允许启用模拟支付渠道' },

  [ErrorCode.PAYMENT_CHANNEL_FAILED]: { httpStatus: 502, message: '支付渠道调用失败' },
  [ErrorCode.LOGISTICS_QUERY_FAILED]: { httpStatus: 502, message: '物流查询失败' },
  [ErrorCode.SMS_SEND_FAILED]: { httpStatus: 502, message: '短信发送失败' },
  [ErrorCode.ADAPTER_NOT_IMPLEMENTED]: { httpStatus: 501, message: '该适配器实现尚未接入' },
  [ErrorCode.ADAPTER_TIMEOUT]: { httpStatus: 504, message: '第三方调用超时' },

  [ErrorCode.VALIDATION_FAILED]: { httpStatus: 400, message: '参数校验失败' },
  [ErrorCode.FIELD_FORMAT_INVALID]: { httpStatus: 400, message: '字段格式错误' },
  [ErrorCode.ROUTE_NOT_FOUND]: { httpStatus: 404, message: '接口不存在' },
  [ErrorCode.TOO_MANY_REQUESTS]: { httpStatus: 429, message: '请求过于频繁，请稍后再试' },
  [ErrorCode.IDEMPOTENT_PROCESSING]: { httpStatus: 409, message: '请求正在处理中，请稍后查询结果' },
  [ErrorCode.IDEMPOTENT_FINGERPRINT_MISMATCH]: { httpStatus: 409, message: '幂等号已被使用且参数不一致' },
  [ErrorCode.SYSTEM_INTERNAL]: { httpStatus: 500, message: '服务内部错误' },
  [ErrorCode.DEPENDENCY_UNAVAILABLE]: { httpStatus: 503, message: '依赖服务不可用' },
};

/** 兜底元信息：未登记的错误码按内部错误处理 */
const FALLBACK_META: ErrorMeta = ERROR_META[ErrorCode.SYSTEM_INTERNAL];

/**
 * 查询错误码元信息。
 *
 * @description 未登记的错误码一律按 500 + '服务内部错误' 处理，避免把未知码当成 200
 * @param code 业务错误码
 * @returns 错误码对应的 HTTP 状态与默认文案
 */
export function getErrorMeta(code: number): ErrorMeta {
  return ERROR_META[code as ErrorCodeValue] ?? FALLBACK_META;
}

/**
 * 判断错误码是否已登记。
 *
 * @param code 业务错误码
 * @returns 是否已登记
 */
export function isKnownErrorCode(code: number): boolean {
  return Object.prototype.hasOwnProperty.call(ERROR_META, code);
}
