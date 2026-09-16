/**
 * @file web/src/api/token.ts
 * @description access token 的本地存储与内存镜像（避免 client 与 store 循环依赖）。
 */

const ACCESS_TOKEN_KEY = 'shop_access_token';

let accessToken: string | null =
  typeof localStorage !== 'undefined' ? localStorage.getItem(ACCESS_TOKEN_KEY) : null;

export function getAccessToken(): string | null {
  return accessToken;
}

export function setAccessToken(token: string | null): void {
  accessToken = token;
  if (typeof localStorage === 'undefined') return;
  if (token) localStorage.setItem(ACCESS_TOKEN_KEY, token);
  else localStorage.removeItem(ACCESS_TOKEN_KEY);
}

export function clearAccessToken(): void {
  setAccessToken(null);
}
