/**
 * @file server/src/crypto.ts
 * @description 密码学工具：sha256 / hmac / 随机串 / 请求体指纹（幂等用）
 * @module utils
 * @see docs/02-architecture.md §5.10（幂等指纹）、§7.5（密码存储）
 * @author 软件开发团队
 * @created 2026-09-03
 */

import { createHash, createHmac, randomBytes, randomInt, randomUUID } from 'node:crypto';

/**
 * 计算 sha256 十六进制摘要。
 *
 * @description 用于密码前置哈希（规避 bcrypt 72 字节截断）与请求体指纹
 * @param input 原始字符串
 * @returns 64 位十六进制摘要
 */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * 计算 HMAC-SHA256 十六进制摘要。
 *
 * @description 第三方回调验签、mock 支付内部签名使用
 * @param payload 待签名内容
 * @param secret 密钥
 * @returns 64 位十六进制摘要
 */
export function hmacSha256Hex(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

/**
 * 安全比较两个字符串（防时序攻击）。
 *
 * @description 用于签名比对：普通 `===` 会在首个不同字节处短路返回，攻击者可据此逐字节爆破签名
 * @param a 字符串一
 * @param b 字符串二
 * @returns 是否相等
 */
export function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < bufA.length; i += 1) {
    // 用异或累积差异，遍历完整长度，不提前退出
    diff |= (bufA[i] ?? 0) ^ (bufB[i] ?? 0);
  }
  return diff === 0;
}

/**
 * 生成指定长度的随机数字串。
 *
 * @description 单号的随机段（防枚举），使用 crypto.randomInt 而非 Math.random
 * @param length 长度
 * @returns 数字字符串（可能以 0 开头，定长）
 */
export function randomDigits(length: number): string {
  let result = '';
  for (let i = 0; i < length; i += 1) {
    result += randomInt(0, 10).toString();
  }
  return result;
}

/**
 * 生成随机十六进制串。
 *
 * @param byteLength 字节数
 * @returns 十六进制字符串
 */
export function randomHex(byteLength = 16): string {
  return randomBytes(byteLength).toString('hex');
}

/**
 * 生成 UUID v4。
 *
 * @description 幂等键（Idempotency-Key）的服务端兜底生成
 * @returns UUID v4 字符串
 */
export function uuidV4(): string {
  return randomUUID();
}
