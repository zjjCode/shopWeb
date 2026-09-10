/// <reference types="vite/client" />

/**
 * @file web/src/env.d.ts
 * @description Vite 环境变量与 .vue 单文件组件的类型声明
 * @module web
 * @author 软件开发团队
 * @created 2026-09-03
 */

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>;
  export default component;
}

interface ImportMetaEnv {
  /** 接口基地址：开发环境为 /api（走 Vite 代理），生产环境为完整域名 */
  readonly VITE_API_BASE: string;
  /** 站点标题 */
  readonly VITE_APP_TITLE: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
