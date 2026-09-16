/**
 * @file web/src/stores/auth.ts
 * @description 登录态 store（access token、用户信息、登录/注册/登出/资料）。
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { authApi, type LoginPayload, type RegisterPayload } from '@/api/auth';
import type { AuthUser } from '@/api/types';
import { clearAccessToken, getAccessToken, setAccessToken } from '@/api/token';

export const useAuthStore = defineStore('auth', () => {
  const token = ref<string | null>(getAccessToken());
  const user = ref<AuthUser | null>(null);

  const isLoggedIn = computed(() => !!token.value);
  const nickname = computed(() => user.value?.nickname ?? '游客');

  function applyAuthResult(result: { accessToken: string; user: AuthUser }): void {
    setAccessToken(result.accessToken);
    token.value = result.accessToken;
    user.value = result.user;
  }

  async function login(payload: LoginPayload): Promise<void> {
    const result = await authApi.login(payload);
    applyAuthResult(result);
  }

  async function register(payload: RegisterPayload): Promise<void> {
    const result = await authApi.register(payload);
    applyAuthResult(result);
  }

  async function fetchProfile(): Promise<void> {
    if (!token.value) return;
    try {
      user.value = await authApi.profile();
    } catch {
      /* 资料拉取失败不阻塞页面，交由 401 流程处理 */
    }
  }

  async function logout(): Promise<void> {
    try {
      await authApi.logout();
    } catch {
      /* 忽略登出接口错误 */
    }
    clearAccessToken();
    token.value = null;
    user.value = null;
  }

  function handleUnauthorized(): void {
    clearAccessToken();
    token.value = null;
    user.value = null;
  }

  return { token, user, isLoggedIn, nickname, login, register, fetchProfile, logout, handleUnauthorized };
});
