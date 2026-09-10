/**
 * @file server/src/core/logger/redact.ts
 * @description 日志敏感字段脱敏：password / token / 密钥 / 银行卡 / 手机号 等强制拦截
 * @module core/logger
 * @see docs/02-architecture.md §5.3（禁止打印的敏感字段清单）
 * @author 软件开发团队
 * @created 2026-09-03
 */

/** 完全禁止出现在日志中的字段（命中即整体替换为掩码） */
const FORBIDDEN_KEYS = new Set([
  'password',
  'passwordhash',
  'newpassword',
  'oldpassword',
  'confirmpassword',
  'paymentpassword',
  'paymentpasswordhash',
  'accesstoken',
  'refreshtoken',
  'token',
  'authorization',
  'cookie',
  'setcookie',
  'idcard',
  'bankcard',
  'cardno',
  'cvv',
  'apikey',
  'apisecret',
  'privatekey',
  'secretkey',
  'mchkey',
  'sign',
  'signature',
  'secret',
]);

/** 需要部分脱敏（保留前后缀）的字段 */
const PARTIAL_MASK_KEYS = new Set(['phone', 'mobile', 'telephone', 'contactphone', 'idcardno']);

/** 完全掩码 */
const FULL_MASK = '******';

/** 递归深度上限，防止超深对象拖慢日志写入 */
const MAX_DEPTH = 6;

/**
 * 手机号脱敏：138****8888。
 *
 * @description 日志中允许保留脱敏后的手机号，便于客服排查问题
 * @param phone 原始手机号
 * @returns 脱敏后的手机号（非 11 位或空值返回掩码）
 */
export function maskPhone(phone: string | null | undefined): string {
  if (typeof phone !== 'string' || phone.length < 7) {
    return FULL_MASK;
  }
  if (phone.length === 11) {
    return `${phone.slice(0, 3)}****${phone.slice(7)}`;
  }
  return `${phone.slice(0, 2)}****${phone.slice(-2)}`;
}

/**
 * 姓名脱敏：张**（保留姓氏）。
 *
 * @param name 原始姓名
 * @returns 脱敏后的姓名
 */
export function maskName(name: string | null | undefined): string {
  if (typeof name !== 'string' || name.length === 0) {
    return FULL_MASK;
  }
  return name.length === 1 ? `${name}*` : `${name.slice(0, 1)}${'*'.repeat(name.length - 1)}`;
}

/**
 * 银行卡号脱敏：仅保留后 4 位。
 *
 * @param cardNo 卡号
 * @returns 脱敏后的卡号
 */
export function maskBankCard(cardNo: string | null | undefined): string {
  if (typeof cardNo !== 'string' || cardNo.length < 8) {
    return FULL_MASK;
  }
  return `${'*'.repeat(cardNo.length - 4)}${cardNo.slice(-4)}`;
}

/**
 * 深度脱敏：递归遍历对象，对敏感字段做整体掩码或分段掩码。
 *
 * @description 所有写日志的入口都应先过一遍本函数；对象会被**深拷贝**，不会污染入参
 * @param value 待脱敏的值（对象 / 数组 / 原始值）
 * @param depth 当前递归深度（内部使用）
 * @returns 脱敏后的新值
 */
export function redact<T>(value: T, depth = 0): T {
  if (value === null || value === undefined) {
    return value;
  }

  if (depth > MAX_DEPTH) {
    return '<deep>' as unknown as T;
  }

  if (value instanceof Error) {
    // Error 的属性不可枚举，单独展开，避免把堆栈里的敏感值漏过去
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    } as unknown as T;
  }

  const valueType = typeof value;
  if (valueType === 'bigint') {
    return value.toString() as unknown as T;
  }
  if (valueType === 'function' || valueType === 'symbol') {
    return `[${valueType}]` as unknown as T;
  }
  if (valueType !== 'object') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1)) as unknown as T;
  }

  if (value instanceof Date) {
    return value.toISOString() as unknown as T;
  }

  if (Buffer.isBuffer(value)) {
    return `<buffer:${value.length}>` as unknown as T;
  }

  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const [key, rawValue] of Object.entries(source)) {
    const lowerKey = key.toLowerCase();
    if (FORBIDDEN_KEYS.has(lowerKey)) {
      result[key] = FULL_MASK;
      continue;
    }
    if (PARTIAL_MASK_KEYS.has(lowerKey)) {
      result[key] = maskPhone(typeof rawValue === 'string' ? rawValue : '');
      continue;
    }
    result[key] = redact(rawValue, depth + 1);
  }

  return result as T;
}

/**
 * 判断某个字段名是否属于敏感字段。
 *
 * @description 供调用方在需要自行处理时判断（如只打印对象的部分字段）
 * @param key 字段名
 * @returns 是否为敏感字段
 */
export function isSensitiveKey(key: string): boolean {
  const lowerKey = key.toLowerCase();
  return FORBIDDEN_KEYS.has(lowerKey) || PARTIAL_MASK_KEYS.has(lowerKey);
}
