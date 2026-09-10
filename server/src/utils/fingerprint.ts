/**
 * @file server/src/utils/fingerprint.ts
 * @description 请求指纹：对「方法 + 路径 + 规范化请求体」做 sha256，用于幂等一致性校验
 * @module utils
 * @see docs/02-architecture.md §5.10（幂等设计）
 * @author 软件开发团队
 * @created 2026-09-03
 *
 * 幂等的四种命中语义：
 * 1. 无记录 → 抢占（写 PROCESSING）并执行；
 * 2. PROCESSING → 返回 409 + 90005「请求正在处理中」；
 * 3. SUCCESS → 直接回放首次结果；
 * 4. FAILED → 允许重新执行。
 *
 * 其中「回放」要求同一幂等号对应的请求参数必须一致，否则就是客户端复用错了幂等号 ——
 * 指纹就是用来证明「这次请求和第一次是不是同一件事」的。
 */

import { sha256Hex } from '@/utils/crypto';

/** 参与指纹计算时应忽略的字段（每次请求都不同，但业务语义相同） */
const IGNORED_KEYS: ReadonlySet<string> = new Set([
  'timestamp',
  'nonce',
  'sign',
  'signature',
  'requestId',
  'requestid',
]);

/**
 * 递归规范化请求体：剔除易变字段、按键名排序。
 *
 * 为什么必须排序：`{a:1,b:2}` 与 `{b:2,a:1}` 语义完全相同，
 * 但 `JSON.stringify` 结果不同，会让同一个业务请求算出两个指纹，
 * 导致第二次请求被误判为「幂等号被复用但参数不一致」（错误码 90006）。
 *
 * @param value 任意值
 * @returns 规范化后的值
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }

  if (typeof value === 'object' && value !== null) {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (IGNORED_KEYS.has(key.toLowerCase())) {
        continue;
      }
      const item = source[key];
      if (item === undefined) {
        continue;
      }
      result[key] = canonicalize(item);
    }
    return result;
  }

  return value;
}

/**
 * 计算请求指纹。
 *
 * @description 指纹 = sha256(方法 | 路径 | 规范化请求体)，取十六进制小写
 * @param method HTTP 方法
 * @param path 请求路径（**不含** query，避免前端多余的跟踪参数导致指纹漂移）
 * @param body 请求体（对象或原始字符串）
 * @returns 64 位十六进制指纹
 */
export function buildRequestFingerprint(method: string, path: string, body: unknown): string {
  const normalizedBody =
    typeof body === 'string' ? body : JSON.stringify(canonicalize(body) ?? null);

  return sha256Hex(`${method.toUpperCase()}|${path}|${normalizedBody}`);
}

/**
 * 校验两次请求的指纹是否一致。
 *
 * @param stored 首次请求落库的指纹
 * @param current 本次请求计算出的指纹
 * @returns 一致时 true
 */
export function isFingerprintMatched(stored: string | null | undefined, current: string): boolean {
  if (typeof stored !== 'string' || stored.length === 0) {
    // 历史数据没有指纹（灰度期）时放行，避免把老请求全部打成 90006
    return true;
  }
  return stored === current;
}
