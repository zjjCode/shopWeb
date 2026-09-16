<script setup lang="ts">
/**
 * @file web/src/views/LoginView.vue
 * @description 登录页：手机号 + 密码，登录成功后回跳 redirect 或首页。
 */
import { reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, type FormInstance, type FormRules } from 'element-plus';
import { useAuthStore } from '@/stores/auth';
import type { LoginPayload } from '@/api/auth';

const router = useRouter();
const route = useRoute();
const auth = useAuthStore();

interface LoginForm {
  phone: string;
  password: string;
}

const form = reactive<LoginForm>({ phone: '', password: '' });
const formRef = ref<FormInstance>();
const submitting = ref(false);

const rules: FormRules<LoginForm> = {
  phone: [
    { required: true, message: '请输入手机号', trigger: 'blur' },
    { pattern: /^1[3-9]\d{9}$/, message: '手机号格式不正确', trigger: 'blur' },
  ],
  password: [{ required: true, message: '请输入密码', trigger: 'blur' }],
};

async function handleSubmit(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false);
  if (!valid) return;
  submitting.value = true;
  try {
    const payload: LoginPayload = { phone: form.phone, password: form.password };
    await auth.login(payload);
    ElMessage.success('登录成功');
    const redirect = route.query.redirect;
    router.push(typeof redirect === 'string' && redirect ? redirect : { name: 'home' });
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '登录失败');
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="auth-page">
    <div class="card-pad auth-card">
      <h2 class="auth-title">登录商城</h2>
      <el-form ref="formRef" :model="form" :rules="rules" label-position="top" @submit.prevent>
        <el-form-item label="手机号" prop="phone">
          <el-input v-model="form.phone" placeholder="请输入手机号" maxlength="11" clearable />
        </el-form-item>
        <el-form-item label="密码" prop="password">
          <el-input v-model="form.password" type="password" placeholder="请输入密码" show-password @keyup.enter="handleSubmit" />
        </el-form-item>
        <el-button type="primary" class="auth-submit" :loading="submitting" @click="handleSubmit">登录</el-button>
      </el-form>
      <div class="auth-footer">
        还没有账号？<router-link :to="{ name: 'register' }">去注册</router-link>
      </div>
    </div>
  </div>
</template>

<style scoped>
.auth-page {
  display: flex;
  justify-content: center;
  padding: 40px 0;
}
.auth-card {
  width: 360px;
  max-width: 100%;
}
.auth-title {
  margin: 0 0 20px;
  font-size: 22px;
  text-align: center;
}
.auth-submit {
  width: 100%;
}
.auth-footer {
  margin-top: 16px;
  text-align: center;
  color: var(--text-muted);
}
.auth-footer a {
  color: var(--brand);
}
</style>
