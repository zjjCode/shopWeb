/**
 * @file server/src/constants/permissions.ts
 * @description 权限点清单（RBAC）：编码常量、模块分组、敏感权限集合、角色默认勾选、缓存 Key
 * @module constants
 * @see docs/03-database.md §3.10（权限点完整清单）
 * @author 软件开发团队
 * @created 2026-09-03
 *
 * 编码格式：`资源:操作`，个别三段式（如 `order:refund:audit`）为历史兼容保留。
 * 业务代码**禁止**硬编码权限字符串，一律引用 {@link PERMISSION}。
 */

import { REDIS_KEY, CACHE_TTL_SECONDS } from '@/config/constants';

/**
 * 权限点编码常量。
 *
 * 与 `permissions` 表的 `code` 字段一一对应，是 `seed` 数据源与运行时校验的唯一权威。
 */
export const PERMISSION = {
  // ---------------- 商品 ----------------
  PRODUCT_LIST: 'product:list',
  PRODUCT_DETAIL: 'product:detail',
  PRODUCT_CREATE: 'product:create',
  PRODUCT_UPDATE: 'product:update',
  PRODUCT_DELETE: 'product:delete',
  PRODUCT_PUBLISH: 'product:publish',

  // ---------------- 分类 ----------------
  CATEGORY_LIST: 'category:list',
  CATEGORY_CREATE: 'category:create',
  CATEGORY_UPDATE: 'category:update',
  CATEGORY_DELETE: 'category:delete',

  // ---------------- SKU ----------------
  SKU_LIST: 'sku:list',
  SKU_UPDATE: 'sku:update',

  // ---------------- 库存 ----------------
  STOCK_LIST: 'stock:list',
  STOCK_ADJUST: 'stock:adjust',

  // ---------------- 订单 ----------------
  ORDER_LIST: 'order:list',
  ORDER_DETAIL: 'order:detail',
  ORDER_SHIP: 'order:ship',
  ORDER_CANCEL: 'order:cancel',
  ORDER_EXPORT: 'order:export',

  // ---------------- 退款 ----------------
  REFUND_LIST: 'refund:list',
  REFUND_DETAIL: 'refund:detail',
  REFUND_AUDIT: 'refund:audit',
  /** 三段式：审核退款（订单详情页的退款审核动作） */
  ORDER_REFUND_AUDIT: 'order:refund:audit',

  // ---------------- 优惠券 ----------------
  COUPON_LIST: 'coupon:list',
  COUPON_CREATE: 'coupon:create',
  COUPON_UPDATE: 'coupon:update',
  COUPON_DELETE: 'coupon:delete',
  COUPON_PUBLISH: 'coupon:publish',
  COUPON_INVALIDATE: 'coupon:invalidate',

  // ---------------- 促销 ----------------
  PROMO_LIST: 'promo:list',
  PROMO_CREATE: 'promo:create',
  PROMO_UPDATE: 'promo:update',
  PROMO_DELETE: 'promo:delete',

  // ---------------- 用户 ----------------
  USER_LIST: 'user:list',
  USER_DETAIL: 'user:detail',
  USER_DISABLE: 'user:disable',

  // ---------------- 余额 ----------------
  BALANCE_LIST: 'balance:list',
  BALANCE_DETAIL: 'balance:detail',
  BALANCE_ADJUST: 'balance:adjust',

  // ---------------- 资金 ----------------
  FUND_LIST: 'fund:list',
  FUND_EXPORT: 'fund:export',
  FUND_RECONCILE: 'fund:reconcile',

  // ---------------- RBAC 角色 ----------------
  RBAC_ROLE_LIST: 'rbac:role:list',
  RBAC_ROLE_CREATE: 'rbac:role:create',
  RBAC_ROLE_UPDATE: 'rbac:role:update',
  RBAC_ROLE_DELETE: 'rbac:role:delete',
  RBAC_ROLE_ASSIGN: 'rbac:role:assign',

  // ---------------- RBAC 管理员 ----------------
  RBAC_ADMIN_LIST: 'rbac:admin:list',
  RBAC_ADMIN_CREATE: 'rbac:admin:create',
  RBAC_ADMIN_UPDATE: 'rbac:admin:update',
  RBAC_ADMIN_DELETE: 'rbac:admin:delete',
  RBAC_ADMIN_RESET_PWD: 'rbac:admin:reset-pwd',

  // ---------------- 支付渠道 ----------------
  PAY_CHANNEL_LIST: 'pay:channel:list',
  PAY_CHANNEL_UPDATE: 'pay:channel:update',
  PAY_CHANNEL_TOGGLE: 'pay:channel:toggle',

  // ---------------- 操作日志 ----------------
  LOG_LIST: 'log:list',
  LOG_DETAIL: 'log:detail',
} as const;

/** 权限点编码联合类型 */
export type PermissionCode = (typeof PERMISSION)[keyof typeof PERMISSION];

/** 权限模块 → 该模块下的权限点编码（与 docs/03-database.md §3.10 表格逐行对应） */
export const PERMISSION_MODULES: Record<string, readonly PermissionCode[]> = {
  product: [
    PERMISSION.PRODUCT_LIST,
    PERMISSION.PRODUCT_DETAIL,
    PERMISSION.PRODUCT_CREATE,
    PERMISSION.PRODUCT_UPDATE,
    PERMISSION.PRODUCT_DELETE,
    PERMISSION.PRODUCT_PUBLISH,
  ],
  category: [
    PERMISSION.CATEGORY_LIST,
    PERMISSION.CATEGORY_CREATE,
    PERMISSION.CATEGORY_UPDATE,
    PERMISSION.CATEGORY_DELETE,
  ],
  sku: [PERMISSION.SKU_LIST, PERMISSION.SKU_UPDATE],
  stock: [PERMISSION.STOCK_LIST, PERMISSION.STOCK_ADJUST],
  order: [
    PERMISSION.ORDER_LIST,
    PERMISSION.ORDER_DETAIL,
    PERMISSION.ORDER_SHIP,
    PERMISSION.ORDER_CANCEL,
    PERMISSION.ORDER_EXPORT,
  ],
  refund: [
    PERMISSION.REFUND_LIST,
    PERMISSION.REFUND_DETAIL,
    PERMISSION.REFUND_AUDIT,
    PERMISSION.ORDER_REFUND_AUDIT,
  ],
  coupon: [
    PERMISSION.COUPON_LIST,
    PERMISSION.COUPON_CREATE,
    PERMISSION.COUPON_UPDATE,
    PERMISSION.COUPON_DELETE,
    PERMISSION.COUPON_PUBLISH,
    PERMISSION.COUPON_INVALIDATE,
  ],
  promo: [PERMISSION.PROMO_LIST, PERMISSION.PROMO_CREATE, PERMISSION.PROMO_UPDATE, PERMISSION.PROMO_DELETE],
  user: [PERMISSION.USER_LIST, PERMISSION.USER_DETAIL, PERMISSION.USER_DISABLE],
  balance: [PERMISSION.BALANCE_LIST, PERMISSION.BALANCE_DETAIL, PERMISSION.BALANCE_ADJUST],
  fund: [PERMISSION.FUND_LIST, PERMISSION.FUND_EXPORT, PERMISSION.FUND_RECONCILE],
  'rbac:role': [
    PERMISSION.RBAC_ROLE_LIST,
    PERMISSION.RBAC_ROLE_CREATE,
    PERMISSION.RBAC_ROLE_UPDATE,
    PERMISSION.RBAC_ROLE_DELETE,
    PERMISSION.RBAC_ROLE_ASSIGN,
  ],
  'rbac:admin': [
    PERMISSION.RBAC_ADMIN_LIST,
    PERMISSION.RBAC_ADMIN_CREATE,
    PERMISSION.RBAC_ADMIN_UPDATE,
    PERMISSION.RBAC_ADMIN_DELETE,
    PERMISSION.RBAC_ADMIN_RESET_PWD,
  ],
  'pay:channel': [PERMISSION.PAY_CHANNEL_LIST, PERMISSION.PAY_CHANNEL_UPDATE, PERMISSION.PAY_CHANNEL_TOGGLE],
  log: [PERMISSION.LOG_LIST, PERMISSION.LOG_DETAIL],
};

/**
 * 敏感权限集合（§3.10 标注 ✅ 的权限点）。
 *
 * 敏感权限的特殊处理：
 * 1. 每次校验**实时查库**，不读 Redis 缓存 —— 权限被回收后必须立即生效，
 *    缓存带来的几十秒延迟足以让一个刚被撤权的管理员划走一笔钱；
 * 2. 命中时写操作日志（谁在什么时候动了什么）。
 */
export const SENSITIVE_PERMISSIONS: ReadonlySet<string> = new Set<string>([
  PERMISSION.STOCK_ADJUST,
  PERMISSION.REFUND_AUDIT,
  PERMISSION.ORDER_REFUND_AUDIT,
  PERMISSION.USER_DISABLE,
  PERMISSION.BALANCE_ADJUST,
  PERMISSION.FUND_RECONCILE,
  ...PERMISSION_MODULES['rbac:role'],
  ...PERMISSION_MODULES['rbac:admin'],
  ...PERMISSION_MODULES['pay:channel'],
]);

/** 全部权限点（扁平列表，供 seed 与「超级管理员全量勾选」使用） */
export const ALL_PERMISSIONS: readonly PermissionCode[] = Object.values(PERMISSION_MODULES).flat();

/**
 * `ADMIN` 角色默认勾选的权限。
 *
 * 规则（§3.10 注）：默认勾选除 `rbac:*` / `balance:adjust` / `fund:reconcile` / `pay:channel:*` 之外的全部。
 * 即普通管理员能管业务，但不能动权限体系、不能调账、不能对账、不能改支付渠道。
 */
export const ADMIN_DEFAULT_PERMISSIONS: readonly PermissionCode[] = ALL_PERMISSIONS.filter((code) => {
  if (SENSITIVE_PERMISSIONS.has(code)) {
    return false;
  }
  return !code.startsWith('rbac:') && !code.startsWith('pay:channel:');
});

/**
 * 判断权限点是否为敏感权限。
 *
 * @param code 权限点编码
 * @returns 是否敏感
 */
export function isSensitivePermission(code: string): boolean {
  return SENSITIVE_PERMISSIONS.has(code);
}

/**
 * 校验权限点编码是否合法（在清单内）。
 *
 * @description 用于接口入参校验：防止往 `role_permissions` 里塞入不存在的编码
 * @param code 待校验的编码
 * @returns 是否合法
 */
export function isValidPermissionCode(code: string): boolean {
  return (ALL_PERMISSIONS as readonly string[]).includes(code);
}

/**
 * 构造管理员权限集合的缓存 Key。
 *
 * @description 统一前缀 `shop:rbac:perms:{adminUserId}`（§5.9）。
 * ⚠️ **敏感权限不走此缓存**，见 {@link SENSITIVE_PERMISSIONS} 的说明
 * @param adminUserId 管理员 ID
 * @returns 缓存 Key
 */
export function rbacPermsCacheKey(adminUserId: number | string): string {
  return `${REDIS_KEY.PREFIX}:${REDIS_KEY.RBAC_PERMS}:${adminUserId}`;
}

/** 管理员权限缓存 TTL（秒）：短 TTL 是「性能」与「撤权及时性」的折中 */
export const RBAC_PERMS_CACHE_TTL_SECONDS: number = CACHE_TTL_SECONDS.RBAC_PERMS;
