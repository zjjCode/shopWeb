/**
 * @file web/src/api/auth.ts
 * @description 认证相关接口（注册 / 登录 / 刷新 / 登出 / 资料）。
 */
import { api } from './client';
import type { AuthResult, AuthUser, RefreshResult } from './types';

export interface LoginPayload {
  phone: string;
  password: string;
}
export interface RegisterPayload {
  phone: string;
  password: string;
  nickname: string;
}

export const authApi = {
  register: (payload: RegisterPayload) => api.post<AuthResult>('/auth/register', payload),
  login: (payload: LoginPayload) => api.post<AuthResult>('/auth/login', payload),
  refresh: () => api.post<RefreshResult>('/auth/refresh'),
  logout: () => api.post<null>('/auth/logout'),
  profile: () => api.get<AuthUser>('/auth/profile'),
};
