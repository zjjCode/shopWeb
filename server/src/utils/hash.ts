/**
 * @file server/src/utils/hash.ts
 * @description 密码工具：bcrypt(sha256(password), cost=12) —— 规避 bcrypt 72 字节截断
 * @module utils
 * @see docs/02-architecture.md §7.5（密码存储与敏感数据）
 * @author 软件开发团队
 * @created 2026-09-03
 */

import bcrypt from 'bcrypt';
import { sha256Hex } from './crypto';

/** bcrypt 计算成本：PRD 与架构文档明确 cost = 12 */
export const BCRYPT_COST = 12;

/** 密码强度要求 */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 64;

/**
 * 对明文密码做 sha256 前置哈希。
 *
 * 为什么必须先 sha256 再 bcrypt（§7.5）：
 * bcrypt 只取输入的前 **72 字节**，超过部分被静默截断。中文或长密码很容易超过 72 字节，
 * 导致「密码后 30 位随便改都能登录」的严重漏洞。sha256 输出恒为 64 字节十六进制串，
 * 既规避截断，又保持定长。
 *
 * @param plainPassword 明文密码
 * @returns 64 位十六进制摘要
 */
export function preHashPassword(plainPassword: string): string {
  return sha256Hex(plainPassword);
}

/**
 * 生成密码哈希。
 *
 * @param plainPassword 明文密码
 * @returns bcrypt 哈希串（含 salt 与 cost，可直接入库）
 * @throws {Error} 明文为空或超长时抛出
 */
export async function hashPassword(plainPassword: string): Promise<string> {
  assertPlainPassword(plainPassword);
  return bcrypt.hash(preHashPassword(plainPassword), BCRYPT_COST);
}

/**
 * 校验密码。
 *
 * @description 哈希校验失败（哈希串被破坏）时返回 false 而不是抛错，避免把内部异常暴露为 500
 * @param plainPassword 明文密码
 * @param passwordHash 库中存储的哈希
 * @returns 是否匹配
 */
export async function comparePassword(plainPassword: string, passwordHash: string): Promise<boolean> {
  if (typeof plainPassword !== 'string' || plainPassword.length === 0) {
    return false;
  }
  if (typeof passwordHash !== 'string' || passwordHash.length === 0) {
    return false;
  }
  try {
    return await bcrypt.compare(preHashPassword(plainPassword), passwordHash);
  } catch {
    return false;
  }
}

/**
 * 校验密码强度：8~64 位且同时包含字母与数字。
 *
 * @param plainPassword 明文密码
 * @returns 是否符合强度要求
 */
export function isPasswordStrong(plainPassword: string): boolean {
  if (typeof plainPassword !== 'string') {
    return false;
  }
  if (plainPassword.length < PASSWORD_MIN_LENGTH || plainPassword.length > PASSWORD_MAX_LENGTH) {
    return false;
  }
  return /[A-Za-z]/.test(plainPassword) && /\d/.test(plainPassword);
}

/**
 * 断言明文密码合法。
 *
 * @param plainPassword 明文密码
 * @throws {Error} 长度不合法时抛出
 */
export function assertPlainPassword(plainPassword: string): void {
  if (typeof plainPassword !== 'string' || plainPassword.length === 0) {
    throw new Error('密码不能为空');
  }
  if (plainPassword.length > PASSWORD_MAX_LENGTH) {
    throw new Error(`密码长度不能超过 ${PASSWORD_MAX_LENGTH} 位`);
  }
}
