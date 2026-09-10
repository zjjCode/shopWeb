/**
 * @file server/src/utils/mask.ts
 * @description 数据脱敏：手机号 / 姓名 / 银行卡 / 身份证 / 邮箱 / 地址（对外展示与导出场景）
 * @module utils
 * @see docs/02-architecture.md §5.3（禁止打印的敏感字段清单）
 * @author 软件开发团队
 * @created 2026-09-03
 *
 * 与 `core/logger/redact.ts` 的分工：
 * `redact.ts` 是**日志侧**的通用递归脱敏（按 key 名拦截整棵对象树）；
 * 本文件是**业务侧**的定向脱敏（确定字段、确定格式，用于 API 响应与 Excel 导出）。
 * 基础能力（手机号 / 姓名 / 银行卡）复用 `redact.ts` 的实现，此处只做再导出与补充，
 * 避免出现两套不一致的脱敏规则。
 */

import { isSensitiveKey, maskBankCard, maskName, maskPhone } from '@/core/logger/redact';

// 先 import 再 export：单纯的 `export { x } from '...'` 只做转发，
// 不会把标识符引入本模块作用域，下方 maskByField 引用时会报 TS2304
export { maskPhone, maskName, maskBankCard, isSensitiveKey };

/**
 * 脱敏身份证号：保留前 1 位与后 1 位，中间打星。
 *
 * @description 身份证属《个人信息保护法》定义的敏感个人信息，默认**全量脱敏**，
 * 仅在实名核验等必要场景才由后端完整读取，且不得写入日志
 * @param idCard 身份证号
 * @returns 脱敏后的字符串；空输入返回空串
 */
export function maskIdCard(idCard: string | null | undefined): string {
  if (typeof idCard !== 'string' || idCard.length === 0) {
    return '';
  }
  if (idCard.length <= 2) {
    return `${idCard.slice(0, 1)}*`;
  }
  return `${idCard.slice(0, 1)}${'*'.repeat(idCard.length - 2)}${idCard.slice(-1)}`;
}

/**
 * 脱敏邮箱：保留首字符与域名，中间打星。
 *
 * @param email 邮箱地址
 * @returns 脱敏后的字符串；非邮箱格式时原样返回（避免把非法值伪装成合法邮箱）
 */
export function maskEmail(email: string | null | undefined): string {
  if (typeof email !== 'string' || !email.includes('@')) {
    return typeof email === 'string' ? email : '';
  }

  const atIndex = email.indexOf('@');
  const local = email.slice(0, atIndex);
  const domain = email.slice(atIndex);

  if (local.length <= 1) {
    return `*${domain}`;
  }
  return `${local.slice(0, 1)}${'*'.repeat(Math.min(local.length - 1, 6))}${domain}`;
}

/**
 * 脱敏收货地址：保留前 6 个字符（通常到区县），其余打星。
 *
 * @description 详细地址到门牌号可定位到具体住户，导出给第三方物流之外的一律脱敏
 * @param address 详细地址
 * @param keepLength 保留的前缀长度，默认 6
 * @returns 脱敏后的字符串
 */
export function maskAddress(address: string | null | undefined, keepLength = 6): string {
  if (typeof address !== 'string' || address.length === 0) {
    return '';
  }
  const keep = Math.max(0, Math.min(keepLength, address.length));
  return `${address.slice(0, keep)}${'*'.repeat(address.length - keep)}`;
}

/**
 * 按字段名自动选择脱敏策略。
 *
 * @description 用于「动态字段」场景（如导出时按列配置脱敏），
 * 已知字段请直接调用对应的 mask 函数以获得更好的类型提示
 * @param field 字段名
 * @param value 原始值
 * @returns 脱敏后的字符串
 */
export function maskByField(field: string, value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  const lower = field.toLowerCase();

  if (lower.includes('idcard') || lower.includes('id_card')) {
    return maskIdCard(text);
  }
  if (lower.includes('bankcard') || lower.includes('bank_card') || lower.includes('cardno')) {
    return maskBankCard(text);
  }
  if (lower.includes('email')) {
    return maskEmail(text);
  }
  if (lower.includes('phone') || lower.includes('mobile') || lower.includes('tel')) {
    return maskPhone(text);
  }
  if (lower.includes('address')) {
    return maskAddress(text);
  }
  if (lower.includes('name')) {
    return maskName(text);
  }
  return text;
}
