/**
 * @file web/src/router/index.ts
 * @description 路由表与全局前置守卫（登录态校验）。
 */
import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import { useAuthStore } from '@/stores/auth';

const routes: RouteRecordRaw[] = [
  { path: '/login', name: 'login', component: () => import('@/views/LoginView.vue'), meta: { title: '登录' } },
  { path: '/register', name: 'register', component: () => import('@/views/RegisterView.vue'), meta: { title: '注册' } },
  {
    path: '/',
    component: () => import('@/layout/ShopLayout.vue'),
    children: [
      { path: '', redirect: { name: 'home' } },
      { path: 'home', name: 'home', component: () => import('@/views/HomeView.vue'), meta: { title: '商城首页' } },
      { path: 'product/:id', name: 'product', component: () => import('@/views/ProductDetailView.vue'), meta: { title: '商品详情' } },
      { path: 'cart', name: 'cart', component: () => import('@/views/CartView.vue'), meta: { requiresAuth: true, title: '购物车' } },
      { path: 'checkout', name: 'checkout', component: () => import('@/views/CheckoutView.vue'), meta: { requiresAuth: true, title: '结算' } },
      { path: 'orders', name: 'orders', component: () => import('@/views/OrderListView.vue'), meta: { requiresAuth: true, title: '我的订单' } },
      { path: 'order/:orderNo/pay', name: 'pay', component: () => import('@/views/PaymentView.vue'), meta: { requiresAuth: true, title: '收银台' } },
      { path: 'refunds', name: 'refunds', component: () => import('@/views/RefundListView.vue'), meta: { requiresAuth: true, title: '我的退款' } },
      { path: 'refund/:refundNo', name: 'refund-detail', component: () => import('@/views/RefundDetailView.vue'), meta: { requiresAuth: true, title: '退款详情' } },
      { path: 'address', name: 'address', component: () => import('@/views/AddressView.vue'), meta: { requiresAuth: true, title: '收货地址' } },
      { path: 'balance', name: 'balance', component: () => import('@/views/BalanceView.vue'), meta: { requiresAuth: true, title: '我的余额' } },
      { path: 'profile', name: 'profile', component: () => import('@/views/ProfileView.vue'), meta: { requiresAuth: true, title: '个人中心' } },
    ],
  },
  { path: '/:pathMatch(.*)*', redirect: { name: 'home' } },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.beforeEach((to) => {
  const auth = useAuthStore();
  if (to.meta.requiresAuth && !auth.isLoggedIn) {
    return { name: 'login', query: { redirect: to.fullPath } };
  }
  return true;
});

router.afterEach((to) => {
  const title = (to.meta.title as string) ?? '电商商城';
  document.title = `${title} · 电商商城系统`;
});

export default router;
