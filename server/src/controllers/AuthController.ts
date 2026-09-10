/**
 * @file server/src/controllers/AuthController.ts
 * @description C 端认证控制器：/api/auth/* 的请求处理（注册/登录/刷新/登出/资料）
 * @module controllers
 * @see docs/04-flows.md F1、docs/02-architecture.md §5.5（分层：routes → controllers → services）
 * @author 软件开发团队
 * @created 2026-09-05
 *
 * 分层铁律：控制器**只做**参数整理、调用 service、组装响应，**禁止直接写 Prisma 查询**。
 * refresh token 传输：httpOnly + Secure(生产) + SameSite=Lax Cookie，仅 refresh 路径可用；
 * access token 走 `Authorization: Bearer` 头。本控制器同时把 refreshToken 放入响应体（按 §5.5 约定）。
 */

import type { Request, Response } from 'express';
import { config, isProduction } from '@/config';
import { sendCreated, sendOk } from '@/core/response';
import { parseTtlToSeconds } from '@/services/TokenService';
import { authService } from '@/services/AuthService';

/** refresh token Cookie 名称 */
const REFRESH_COOKIE = 'refreshToken';

/**
 * 解析 Cookie 头（避免引入额外中间件，仅取 refreshToken）。
 *
 * @param req Express 请求
 * @returns cookie 键值对
 */
function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.cookie;
  if (typeof header !== 'string' || header.length === 0) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) {
      continue;
    }
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key.length > 0) {
      result[key] = decodeURIComponent(value);
    }
  }
  return result;
}

/**
 * 写入 refresh token Cookie。
 *
 * @param res Express 响应
 * @param token refresh token 明文
 * @param isAdmin 是否后台（决定 Cookie path）
 * @returns void
 */
function setRefreshCookie(res: Response, token: string, isAdmin: boolean): void {
  const scope = isAdmin ? 'admin' : 'shop';
  const maxAgeSeconds = parseTtlToSeconds(config.jwt[scope].refreshTtl);
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: isAdmin ? '/admin/auth/refresh' : '/api/auth/refresh',
    maxAge: maxAgeSeconds * 1000,
  });
}

/**
 * 清除 refresh token Cookie。
 *
 * @param res Express 响应
 * @param isAdmin 是否后台
 * @returns void
 */
function clearRefreshCookie(res: Response, isAdmin: boolean): void {
  res.clearCookie(REFRESH_COOKIE, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: isAdmin ? '/admin/auth/refresh' : '/api/auth/refresh',
  });
}

/**
 * C 端认证控制器。
 */
export class AuthController {
  /** 注册 */
  async register(req: Request, res: Response): Promise<void> {
    const { phone, password, nickname } = req.body as { phone: string; password: string; nickname: string };
    const result = await authService.register(
      { phone, password, nickname },
      { ip: req.ip, userAgent: req.header('user-agent') },
    );
    setRefreshCookie(res, result.refreshToken, false);
    sendCreated(res, {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresIn: result.expiresIn,
      user: {
        id: result.id,
        phone: result.phone,
        nickname: result.nickname,
        role: result.role,
        status: result.status,
      },
    });
  }

  /** 登录 */
  async login(req: Request, res: Response): Promise<void> {
    const { phone, password } = req.body as { phone: string; password: string };
    const result = await authService.login({ phone, password }, { ip: req.ip, userAgent: req.header('user-agent') });
    setRefreshCookie(res, result.refreshToken, false);
    sendOk(res, {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresIn: result.expiresIn,
      user: {
        id: result.id,
        phone: result.phone,
        nickname: result.nickname,
        role: result.role,
        status: result.status,
      },
    });
  }

  /** 刷新 token（refresh token 取自 Cookie；无需 access token） */
  async refresh(req: Request, res: Response): Promise<void> {
    const refreshToken = parseCookies(req)[REFRESH_COOKIE];
    if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
      sendOk(res, { accessToken: '', refreshToken: '', expiresIn: 0 }, '缺少刷新令牌', 401);
      return;
    }
    const result = await authService.refresh(refreshToken);
    setRefreshCookie(res, result.refreshToken, false);
    sendOk(res, {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresIn: result.expiresIn,
    });
  }

  /** 登出（需 access token；吊销 family + tokenVersion++） */
  async logout(req: Request, res: Response): Promise<void> {
    const refreshToken = parseCookies(req)[REFRESH_COOKIE];
    await authService.logout(req.auth!.userId, refreshToken);
    clearRefreshCookie(res, false);
    sendOk(res, null, '已退出登录');
  }

  /** 当前用户资料（需 access token） */
  async profile(req: Request, res: Response): Promise<void> {
    const profile = await authService.getProfile(req.auth!.userId);
    sendOk(res, profile);
  }
}

/** 默认单例 */
export const authController = new AuthController();

export default authController;
