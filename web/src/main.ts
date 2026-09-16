/**
 * @file web/src/main.ts
 * @description 前端应用入口：注册 Pinia、Vue Router、Element Plus。
 */
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import App from './App.vue';
import router from './router';
import { setOnUnauthorized } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import './styles/index.scss';

const app = createApp(App);
const pinia = createPinia();
app.use(pinia);
app.use(router);
app.use(ElementPlus);

const auth = useAuthStore();
setOnUnauthorized(() => {
  auth.handleUnauthorized();
  if (router.currentRoute.value.name !== 'login' && router.currentRoute.value.name !== 'register') {
    router.push({ name: 'login', query: { redirect: router.currentRoute.value.fullPath } });
  }
});

app.mount('#app');
