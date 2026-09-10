/**
 * @file server/src/types/common.ts
 * @description 通用类型：统一响应体 / 分页信封 / 认证主体 / 分页参数
 * @module types
 * @see docs/02-architecture.md §5.1（统一响应格式）、§5.7（分页封装）
 * @author 软件开发团队
 * @created 2026-09-03
 */

import type { TokenScope } from '@/config/types';

/**
 * 统一响应信封。
 *
 * HTTP status 表达语义大类，`code` 表达具体错误（双轨制，§5.1）。
 */
export interface ApiResponse<T = unknown> {
  /** 0 = 成功，非 0 = 业务/系统错误码 */
  code: number;
  /** 可直接展示给用户的中文提示 */
  message: string;
  /** 业务数据；出错时为错误详情对象或 null */
  data: T | null;
  /** 全链路追踪 ID，与响应头 X-Request-Id 一致 */
  requestId: string;
  /** 服务器毫秒时间戳 */
  timestamp: number;
}

/** 分页信封（成功响应的 data 固定为此结构，§5.7） */
export interface PageResult<T> {
  list: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/** 归一化后的分页参数（含 Prisma 的 skip/take） */
export interface PageParams {
  page: number;
  pageSize: number;
  skip: number;
  take: number;
}

/** 认证主体（由 auth 中间件解析 JWT 后挂载到 req.auth） */
export interface AuthPrincipal {
  /** C 端用户 ID 或后台管理员 ID */
  userId: number;
  /** 角色标识（C 端为 'USER'，后台为角色编码集合中的主角色） */
  role?: string;
  /** JWT 作用域：shop = C 端买家，admin = 后台管理员 */
  scope: TokenScope;
  /** token 版本号，用于强制下线 */
  tokenVersion: number;
  /** JWT ID，便于吊销与审计 */
  jti?: string;
}
