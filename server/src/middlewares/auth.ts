/**
 * @file server/src/middlewares/auth.ts
 * @description JWT 认证中间件：解析 access token → req.auth（支持强制 / 可选两种模式）
 * @module middlewares
 * @see docs/02-architecture.md §5.5（第 7 个中间件）、§7.1（双作用域密钥）
 * @author 软件开发团队
 * @created 2026-09-03
 *
 * 双作用域设计（§7.1）：
 * C 端买家与后台管理员**使用不同的签名密钥**（`SHOP__JWT__ACCESS_SECRET` vs `SHOP__JWT__ADMIN_ACCESS_SECRET`）。
 * 这样即使 C 端 token 被盗，攻击者也无法用它访问 `/admin/*` ——
 * 靠 `scope` 字段判断是不够的，签名密钥分离才是真正的边界。
 */

import type { RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '@/config';
import type { TokenScope } from '@/config/types';
import { HEADER } from '@/config/constants';
import { AuthError } from '@/core/errors';
import { ErrorCode } from '@/core/errors/errorCodes';
import { patchContext } from '@/core/logger/requestContext';
import type { AuthPrincipal } from '@/types/common';

/**
 * access token 的载荷结构。
 *
 * `tv` = tokenVersion：用户改密 / 强制下线时递增，旧 token 即使未过期也失效。
 */
export interface AccessTokenClaims {
  /** 主体 ID（用户 ID 或管理员 ID） */
  sub: string;
  /** 签发作用域 */
  scope: TokenScope;
  /** 角色标识（C 端为 'USER'，后台为主角色编码） */
  role?: string;
  /** token 版本号，用于强制下线 */
  tv?: number;
  /** JWT ID，便于吊销与审计 */
  jti?: string;
  /** 签发时间（秒） */
  iat?: number;
  /** 过期时间（秒） */
  exp?: number;
}

/** 认证中间件选项 */
export interface AuthOptions {
  /** 期望的 token 作用域，默认 shop（C 端） */
  scope?: TokenScope;
  /** 是否强制要求登录，默认 true */
  required?: boolean;
}

/** `Bearer ` 前缀的长度，用于截取 token 主体 */
const BEARER_PREFIX_LENGTH = 7;

/**
 * 从 Authorization 头提取 token。
 *
 * @description 只认 `Bearer ` 一种形式：放宽到「裸 token」会让前端把 token 塞进 URL 的习惯蔓延，
 * 而 URL 会被 Nginx access log、浏览器历史、Referer 头完整记录
 * @param header Authorization 头原始值
 * @returns token 字符串；格式不符时返回 null
 */
export function extractBearerToken(header: string | undefined): string | null {
  if (typeof header !== 'string' || header.length === 0) {
    return null;
  }
  if (!header.startsWith('Bearer ')) {
    return null;
  }
  const token = header.slice(BEARER_PREFIX_LENGTH).trim();
  return token.length > 0 ? token : null;
}

/**
 * 校验 token 并解析出认证主体。
 *
 * @param token JWT 字符串
 * @param scope 期望的作用域
 * @returns 认证主体
 * @throws {AuthError} token 过期、签名不符或作用域不匹配
 */
export function verifyAccessToken(token: string, scope: TokenScope): AuthPrincipal {
  const secret = config.jwt[scope].accessSecret;

  let claims: AccessTokenClaims;
  try {
    claims = jwt.verify(token, secret) as AccessTokenClaims;
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw AuthError.unauthorized('登录已失效，请重新登录', ErrorCode.ACCESS_TOKEN_EXPIRED);
    }
    // 签名不符 / 被篡改 / 用错作用域的密钥，一律归为「登录失效」，
    // 不区分具体原因 —— 细分错误码等于告诉攻击者的 token 为什么不对
    throw AuthError.unauthorized('登录已失效，请重新登录', ErrorCode.ACCESS_TOKEN_EXPIRED);
  }

  if (claims.scope !== scope) {
    throw AuthError.forbidden('需要更高权限', ErrorCode.PERMISSION_DENIED);
  }

  const userId = Number(claims.sub);
  if (!Number.isInteger(userId) || userId <= 0) {
    throw AuthError.unauthorized('登录已失效，请重新登录', ErrorCode.ACCESS_TOKEN_EXPIRED);
  }

  return {
    userId,
    role: claims.role,
    scope: claims.scope,
    tokenVersion: claims.tv ?? 0,
    jti: claims.jti,
  };
}

/**
 * 认证中间件。
 *
 * @description 成功后把主体挂到 `req.auth`，并**就地回填日志上下文**（userId / role / scope），
 * 使后续所有日志自动带上操作主体，业务代码无需手动传参
 * @param options 认证选项，见 {@link AuthOptions}
 * @returns Express 中间件
 */
export function auth(options: AuthOptions = {}): RequestHandler {
  const { scope = 'shop', required = true } = options;

  return (req, _res, next) => {
    const token = extractBearerToken(req.header(HEADER.AUTHORIZATION));

    if (token === null) {
      if (!required) {
        next();
        return;
      }
      next(AuthError.unauthorized('未提供访问令牌', ErrorCode.ACCESS_TOKEN_EXPIRED));
      return;
    }

    try {
      const principal = verifyAccessToken(token, scope);
      req.auth = principal;

      patchContext({
        userId: principal.userId,
        role: principal.role,
        scope: principal.scope,
      });

      next();
    } catch (error) {
      next(error);
    }
  };
}

/**
 * 可选认证中间件：有 token 就解析，没有也放行。
 *
 * @description 用于「登录与否都能看，但登录后内容不同」的接口（商品详情、首页）。
 * 注意：**解析失败（过期/篡改）时不会静默放行**，仍然抛 401 ——
 * 否则用户拿着过期 token 会看到一个「既没登录又没报错」的诡异状态
 * @param scope 期望的作用域，默认 shop
 * @returns Express 中间件
 */
export function optionalAuth(scope: TokenScope = 'shop'): RequestHandler {
  return auth({ scope, required: false });
}
