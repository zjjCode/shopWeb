/**
 * @file server/src/controllers/admin/AdminAuthController.ts
 * @description 后台认证控制器：/admin/auth/* 的请求处理（登录/登出/刷新/资料）
 * @module controllers/admin
 * @see docs/04-flows.md F1（后台登录时序）、docs/02-architecture.md §5.5（分层铁律）
 * @author 软件开发团队
 * @created 2026-09-05
 *
 * 与 C 端控制器实现保持一致（refresh token 走 Cookie、access token 走 Bearer 头），
 * 仅 path / scope 不同。失败锁定在 service 层走 DB 字段（见 AdminAuthService）。
 */

import type { Request, Response } from 'express';
import { config, isProduction } from '@/config';
import { sendOk } from '@/core/response';
import { parseTtlToSeconds } from '@/services/TokenService';
import { adminAuthService } from '@/services/AdminAuthService';

/** refresh token Cookie 名称 */
const REFRESH_COOKIE = 'refreshToken';

/** 解析 Cookie 头 */
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

/** 写入 refresh token Cookie（后台路径） */
function setRefreshCookie(res: Response, token: string): void {
  const maxAgeSeconds = parseTtlToSeconds(config.jwt.admin.refreshTtl);
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/admin/auth/refresh',
    maxAge: maxAgeSeconds * 1000,
  });
}

/** 清除 refresh token Cookie（后台路径） */
function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/admin/auth/refresh',
  });
}

/**
 * 后台认证控制器。
 */
export class AdminAuthController {
  /** 登录 */
  async login(req: Request, res: Response): Promise<void> {
    const { username, password } = req.body as { username: string; password: string };
    const result = await adminAuthService.login(
      { username, password },
      { ip: req.ip, userAgent: req.header('user-agent') },
    );
    setRefreshCookie(res, result.refreshToken);
    sendOk(res, {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresIn: result.expiresIn,
      admin: {
        id: result.id,
        username: result.username,
        realName: result.realName,
        isSuperAdmin: result.isSuperAdmin,
        roles: result.roles,
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
    const result = await adminAuthService.refresh(refreshToken);
    setRefreshCookie(res, result.refreshToken);
    sendOk(res, {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresIn: result.expiresIn,
    });
  }

  /** 登出（需 access token） */
  async logout(req: Request, res: Response): Promise<void> {
    const refreshToken = parseCookies(req)[REFRESH_COOKIE];
    await adminAuthService.logout(req.auth!.userId, refreshToken);
    clearRefreshCookie(res);
    sendOk(res, null, '已退出登录');
  }

  /** 当前管理员资料（需 access token） */
  async profile(req: Request, res: Response): Promise<void> {
    const profile = await adminAuthService.getProfile(req.auth!.userId);
    sendOk(res, profile);
  }
}

/** 默认单例 */
export const adminAuthController = new AdminAuthController();

export default adminAuthController;
