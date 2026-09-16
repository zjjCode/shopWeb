/**
 * @file web/src/api/client.ts
 * @description Axios 实例、统一响应信封解包、401 自动刷新与重试。
 *
 * 后端约定（server/src/core/response.ts + middlewares/errorHandler.ts）：
 * - 成功：HTTP 200，信封 { code:0, message, data, requestId, timestamp }。
 * - 业务/校验失败：HTTP 对应状态码（400/404/409/500…），信封 code≠0。
 * - 鉴权失败（token 缺失/过期）：HTTP 401，信封 code 为 ACCESS_TOKEN_EXPIRED。
 * - refresh：POST /auth/refresh 从 httpOnly Cookie 取 refreshToken，无需 body；
 *   成功返回新 accessToken，失败（无 Cookie）返回 HTTP 401 且 data.accessToken=''。
 */

import axios, {
  type AxiosError,
  type AxiosInstance,
  type AxiosRequestConfig,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios';
import { clearAccessToken, getAccessToken, setAccessToken } from './token';
import type { ApiResponse } from './types';

/** 解包后的业务异常 */
export interface ApiError extends Error {
  code: number;
  data: unknown;
  status: number;
}

function createApiError(code: number, message: string, data: unknown, status: number): ApiError {
  const err = new Error(message) as ApiError;
  err.code = code;
  err.data = data;
  err.status = status;
  return err;
}

const BASE_URL: string = import.meta.env.VITE_API_BASE ?? '/api';

const http: AxiosInstance = axios.create({
  baseURL: BASE_URL,
  timeout: 15000,
  headers: { 'Content-Type': 'application/json' },
});

/** 未授权回调（由 main.ts 注入：清空登录态并跳转登录页） */
let onUnauthorized: (() => void) | null = null;
export function setOnUnauthorized(cb: () => void): void {
  onUnauthorized = cb;
}

// 请求拦截：Bearer 注入
http.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  const token = getAccessToken();
  if (token) {
    config.headers = config.headers ?? {};
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// refresh 用独立实例（不带拦截器，避免递归）
const rawHttp: AxiosInstance = axios.create({ baseURL: BASE_URL, timeout: 15000 });

let isRefreshing = false;
let pendingQueue: Array<(token: string | null) => void> = [];

async function doRefresh(): Promise<string | null> {
  try {
    const resp = await rawHttp.post<ApiResponse<{ accessToken: string; refreshToken: string; expiresIn: number }>>(
      '/auth/refresh',
    );
    const token = resp.data.data?.accessToken ?? '';
    if (!token) {
      clearAccessToken();
      return null;
    }
    setAccessToken(token);
    return token;
  } catch {
    clearAccessToken();
    return null;
  }
}

// 响应拦截：成功解包 data；失败根据 HTTP 状态决定是否刷新重试
http.interceptors.response.use(
  (response: AxiosResponse) => {
    const body = response.data as Partial<ApiResponse<unknown>>;
    if (body && typeof body.code === 'number' && body.code === 0) {
      return body.data as never;
    }
    throw createApiError(body?.code ?? -1, body?.message ?? '请求失败', body?.data ?? null, response.status);
  },
  async (error: AxiosError<ApiResponse<unknown>>) => {
    const response = error.response;
    const status = response?.status ?? 0;
    const body = response?.data;

    if (status === 401) {
      const original = error.config as (InternalAxiosRequestConfig & { _retry?: boolean }) | undefined;
      if (original && !original._retry) {
        if (isRefreshing) {
          // 已有刷新在途，排队等待
          return new Promise<unknown>((resolve, reject) => {
            pendingQueue.push((token) => {
              if (token) {
                original._retry = true;
                original.headers = original.headers ?? {};
                original.headers.Authorization = `Bearer ${token}`;
                resolve(http(original));
              } else {
                reject(
                  createApiError(body?.code ?? 401, body?.message ?? '登录已失效', body?.data ?? null, 401),
                );
              }
            });
          });
        }
        isRefreshing = true;
        const token = await doRefresh();
        isRefreshing = false;
        if (token) {
          pendingQueue.forEach((cb) => cb(token));
          pendingQueue = [];
          original._retry = true;
          original.headers = original.headers ?? {};
          original.headers.Authorization = `Bearer ${token}`;
          return http(original);
        }
        pendingQueue.forEach((cb) => cb(null));
        pendingQueue = [];
        onUnauthorized?.();
        throw createApiError(body?.code ?? 401, body?.message ?? '登录已失效', body?.data ?? null, 401);
      }
      onUnauthorized?.();
    }

    const code = body?.code ?? (status || -1);
    const message = body?.message ?? error.message ?? '网络错误';
    throw createApiError(code, message, body?.data ?? null, status);
  },
);

/** 统一请求出口：调用方直接拿到解包后的 data（T） */
export async function request<T>(config: AxiosRequestConfig): Promise<T> {
  return (await http.request(config)) as T;
}

export const api = {
  get: <T>(url: string, params?: unknown, config?: AxiosRequestConfig) =>
    request<T>({ ...config, method: 'get', url, params }),
  post: <T>(url: string, data?: unknown, config?: AxiosRequestConfig) =>
    request<T>({ ...config, method: 'post', url, data }),
  patch: <T>(url: string, data?: unknown, config?: AxiosRequestConfig) =>
    request<T>({ ...config, method: 'patch', url, data }),
  put: <T>(url: string, data?: unknown, config?: AxiosRequestConfig) =>
    request<T>({ ...config, method: 'put', url, data }),
  del: <T>(url: string, data?: unknown, config?: AxiosRequestConfig) =>
    request<T>({ ...config, method: 'delete', url, data }),
};

export { http };
