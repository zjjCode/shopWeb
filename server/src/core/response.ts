/**
 * @file server/src/core/response.ts
 * @description 统一响应构造：ok / fail / paginate 信封 + BigInt 安全序列化（Prisma bigint → number）
 * @module core
 * @see docs/02-architecture.md §5.1（统一响应格式）、docs/03-database.md §1.2（金额精度）
 * @author 软件开发团队
 * @created 2026-09-03
 *
 * 为什么必须自带 BigInt replacer：
 * Prisma 读 MySQL `BIGINT` 返回 JS `bigint`，而 `JSON.stringify` 遇到 bigint 直接抛
 * `TypeError: Do not know how to serialize a BigInt`。金额字段全是 BIGINT（单位「分」），
 * 不处理会让所有带金额的接口 500。这里统一在序列化层转换，
 * 业务代码不必在每个 DTO 里手动 `Number(x)`。
 */

import type { Response } from 'express';
import { getRequestId } from '@/core/logger/requestContext';
import type { ApiResponse, PageResult } from '@/types/common';

/** 成功时的固定文案 */
export const OK_MESSAGE = 'OK';

/** JS 安全整数上限：9,007,199,254,740,991 分 ≈ 90 万亿元（§1.2，业务不可能触及） */
const MAX_SAFE_CENTS = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * JSON 序列化 replacer：bigint → number，超安全范围降级为字符串。
 *
 * @description 作为 `JSON.stringify` 的第二参数使用；同时被日志模块复用来序列化上下文
 * @param _key 当前键名（未使用）
 * @param value 当前值
 * @returns 可安全序列化的值
 */
export function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') {
    // 超出安全整数范围的金额绝不能静默转 number（会丢精度），降级为字符串由前端按字符串处理
    return value > MAX_SAFE_CENTS || value < -MAX_SAFE_CENTS ? value.toString() : Number(value);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return value;
}

/**
 * 安全序列化（内置 bigint 处理）。
 *
 * @param value 待序列化的值
 * @param space 缩进空格数
 * @returns JSON 字符串
 */
export function safeStringify(value: unknown, space?: number): string {
  return JSON.stringify(value, jsonReplacer, space);
}

/**
 * 把对象规约为「可 JSON 序列化的纯对象」。
 *
 * @description 用于日志上下文与审计快照：先序列化再反序列化，天然剔除 undefined / 函数 / Symbol
 * @param value 任意值
 * @returns 规约后的同类型值
 */
export function toPlainJson<T>(value: T): T {
  return JSON.parse(safeStringify(value)) as T;
}

/**
 * 解析 JSON 文本，失败返回 null 而不是抛异常。
 *
 * @description 第三方回调报文、缓存里的快照解析失败时应降级而不是让请求 500
 * @param text 待解析文本
 * @returns 解析结果或 null
 */
export function parseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * 构造成功响应信封。
 *
 * @param data 业务数据
 * @param message 提示文案，默认 OK
 * @param requestId 链路 ID，缺省时取当前上下文
 * @returns 统一响应体
 */
export function buildOk<T>(data: T, message = OK_MESSAGE, requestId = getRequestId()): ApiResponse<T> {
  return {
    code: 0,
    message,
    data: data ?? null,
    requestId,
    timestamp: Date.now(),
  };
}

/**
 * 构造失败响应信封。
 *
 * @param code 业务错误码
 * @param message 提示文案
 * @param data 错误详情（字段级 errors[]、库存不足明细等）
 * @param requestId 链路 ID
 * @returns 统一响应体
 */
export function buildFail(
  code: number,
  message: string,
  data: unknown = null,
  requestId = getRequestId(),
): ApiResponse<unknown> {
  return {
    code,
    message,
    data: data ?? null,
    requestId,
    timestamp: Date.now(),
  };
}

/**
 * 构造分页信封。
 *
 * @description `totalPages = Math.ceil(total / pageSize)`；`pageSize` 为 0 时恒为 0（防御除零）
 * @param list 当前页数据
 * @param total 总条数
 * @param page 当前页码
 * @param pageSize 每页条数
 * @returns 分页结果
 */
export function buildPage<T>(list: T[], total: number, page: number, pageSize: number): PageResult<T> {
  return {
    list,
    total,
    page,
    pageSize,
    totalPages: pageSize > 0 ? Math.ceil(total / pageSize) : 0,
  };
}

/**
 * 取响应使用的 requestId。
 *
 * @description 优先用 requestId 中间件写入 `req.requestId`，保证响应体与响应头完全一致
 * @param res Express 响应对象
 * @returns 链路 ID
 */
function resolveRequestId(res: Response): string {
  return res.req.requestId ?? getRequestId();
}

/**
 * 发送成功响应。
 *
 * @param res Express 响应对象
 * @param data 业务数据
 * @param message 提示文案
 * @param status HTTP 状态码，默认 200
 * @returns void
 */
export function sendOk<T>(res: Response, data: T, message = OK_MESSAGE, status = 200): void {
  res.status(status).json(buildOk(data, message, resolveRequestId(res)));
}

/**
 * 发送创建成功响应（HTTP 201）。
 *
 * @param res Express 响应对象
 * @param data 新建资源
 * @param message 提示文案
 * @returns void
 */
export function sendCreated<T>(res: Response, data: T, message = '创建成功'): void {
  sendOk(res, data, message, 201);
}

/**
 * 发送失败响应。
 *
 * @param res Express 响应对象
 * @param code 业务错误码
 * @param message 提示文案
 * @param data 错误详情
 * @param status HTTP 状态码
 * @returns void
 */
export function sendFail(res: Response, code: number, message: string, data: unknown = null, status = 400): void {
  res.status(status).json(buildFail(code, message, data, resolveRequestId(res)));
}

/**
 * 发送分页响应。
 *
 * @param res Express 响应对象
 * @param list 当前页数据
 * @param total 总条数
 * @param page 当前页码
 * @param pageSize 每页条数
 * @param message 提示文案
 * @returns void
 */
export function sendPaged<T>(
  res: Response,
  list: T[],
  total: number,
  page: number,
  pageSize: number,
  message = OK_MESSAGE,
): void {
  sendOk(res, buildPage(list, total, page, pageSize), message);
}
