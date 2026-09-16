<script setup lang="ts">
/**
 * @file web/src/views/ProfileView.vue
 * @description 个人中心：展示用户信息、退出登录。
 */
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { useCartStore } from '@/stores/cart';

const router = useRouter();
const auth = useAuthStore();
const cart = useCartStore();

const user = computed(() => auth.user);

const roleText = computed(() => {
  const r = user.value?.role;
  if (r === 'ADMIN') return '管理员';
  if (r === 'MERCHANT') return '商家';
  return '普通用户';
});

const statusText = computed(() => {
  const s = user.value?.status;
  if (s === 'DISABLED') return '已禁用';
  if (s === 'FROZEN') return '已冻结';
  return '正常';
});

async function logout(): Promise<void> {
  await auth.logout();
  cart.clear();
  router.push({ name: 'home' });
}
</script>

<template>
  <div class="profile">
    <h2 class="title">个人中心</h2>

    <div class="card-pad">
      <div v-if="user" class="profile-info">
        <el-avatar :size="64" class="avatar">{{ user.nickname.charAt(0) }}</el-avatar>
        <div class="fields">
          <div class="field"><span class="label">昵称</span><span>{{ user.nickname }}</span></div>
          <div class="field"><span class="label">手机号</span><span>{{ user.phone }}</span></div>
          <div class="field"><span class="label">角色</span><span>{{ roleText }}</span></div>
          <div class="field"><span class="label">状态</span><span>{{ statusText }}</span></div>
        </div>
      </div>
      <div v-else class="text-muted">未登录</div>

      <div class="actions">
        <el-button type="danger" @click="logout">退出登录</el-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.title {
  margin: 0 0 16px;
}
.profile-info {
  display: flex;
  align-items: center;
  gap: 24px;
}
.avatar {
  background: var(--brand);
  color: #fff;
  font-size: 24px;
}
.fields {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px 32px;
}
.field {
  display: flex;
  gap: 8px;
}
.label {
  color: var(--text-muted);
  width: 48px;
}
.actions {
  margin-top: 24px;
}
</style>
