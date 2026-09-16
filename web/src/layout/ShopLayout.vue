<script setup lang="ts">
/**
 * @file web/src/layout/ShopLayout.vue
 * @description C 端商城布局：顶部导航（Logo、购物车角标、用户菜单）+ 路由出口。
 */
import { computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useAuthStore } from '@/stores/auth';
import { useCartStore } from '@/stores/cart';

const router = useRouter();
const auth = useAuthStore();
const cart = useCartStore();

const nickname = computed(() => auth.nickname);
const cartBadge = computed(() => cart.cartBadge);

onMounted(async () => {
  if (auth.isLoggedIn) {
    await auth.fetchProfile();
    await cart.fetchCart();
  }
});

async function handleLogout(): Promise<void> {
  try {
    await ElMessageBox.confirm('确定要退出登录吗？', '提示', { type: 'warning' });
  } catch {
    return;
  }
  await auth.logout();
  cart.clear();
  ElMessage.success('已退出登录');
  router.push({ name: 'home' });
}

function goProfile(): void {
  router.push({ name: 'profile' });
}
</script>

<template>
  <div class="shop-layout">
    <header class="topbar">
      <div class="container topbar-inner">
        <div class="logo" @click="router.push({ name: 'home' })">🛍️ 商城</div>
        <nav class="nav">
          <router-link :to="{ name: 'home' }">首页</router-link>
          <router-link v-if="auth.isLoggedIn" :to="{ name: 'orders' }">我的订单</router-link>
          <router-link v-if="auth.isLoggedIn" :to="{ name: 'refunds' }">退款</router-link>
          <router-link v-if="auth.isLoggedIn" :to="{ name: 'balance' }">余额</router-link>
          <router-link v-if="auth.isLoggedIn" :to="{ name: 'address' }">地址</router-link>
        </nav>
        <div class="actions">
          <router-link :to="{ name: 'cart' }" class="cart-link">
            购物车
            <el-badge v-if="cartBadge > 0" :value="cartBadge" class="cart-badge" />
          </router-link>
          <template v-if="auth.isLoggedIn">
            <span class="user" @click="goProfile">{{ nickname }}</span>
            <el-button text type="danger" @click="handleLogout">退出</el-button>
          </template>
          <template v-else>
            <router-link :to="{ name: 'login' }">登录</router-link>
            <router-link :to="{ name: 'register' }">注册</router-link>
          </template>
        </div>
      </div>
    </header>
    <main class="container page">
      <router-view />
    </main>
  </div>
</template>

<style scoped>
.shop-layout {
  min-height: 100vh;
}
.topbar {
  background: #fff;
  border-bottom: 1px solid var(--border);
  position: sticky;
  top: 0;
  z-index: 100;
}
.topbar-inner {
  display: flex;
  align-items: center;
  height: 56px;
  gap: 24px;
}
.logo {
  font-size: 20px;
  font-weight: 700;
  cursor: pointer;
  white-space: nowrap;
}
.nav {
  display: flex;
  gap: 20px;
  flex: 1;
}
.nav a {
  color: var(--text-secondary);
}
.nav a.router-link-active {
  color: var(--brand);
  font-weight: 600;
}
.actions {
  display: flex;
  align-items: center;
  gap: 16px;
}
.cart-link {
  position: relative;
  color: var(--text-secondary);
}
.user {
  cursor: pointer;
  color: var(--text);
}
</style>
