/**
 * @file web/src/main.ts
 * @description 前端应用入口（阶段 0 占位实现）
 * @module web
 * @see docs/02-architecture.md §4（前端目录结构）
 * @author 软件开发团队
 * @created 2026-09-03
 *
 * 说明：本文件在 T001 阶段仅负责「能跑起来」。
 * T100（C 端页面）/ T101（后台页面）阶段会依次接入：
 *   - Pinia（stores/）
 *   - Vue Router 4 + 全局守卫（router/）
 *   - Element Plus 按需引入
 *   - 全局样式 styles/index.scss
 */

import { createApp } from 'vue';
import App from './App.vue';

const app = createApp(App);

app.mount('#app');
