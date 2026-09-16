<script setup lang="ts">
/**
 * @file web/src/views/RegisterView.vue
 * @description 注册页：手机号 + 密码 + 昵称，注册成功后跳登录页。
 */
import { reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, type FormInstance, type FormRules } from 'element-plus';
import { useAuthStore } from '@/stores/auth';
import type { RegisterPayload } from '@/api/auth';

const router = useRouter();
const auth = useAuthStore();

interface RegisterForm {
  phone: string;
  password: string;
  nickname: string;
}

const form = reactive<RegisterForm>({ phone: '', password: '', nickname: '' });
const formRef = ref<FormInstance>();
const submitting = ref(false);

const rules: FormRules<RegisterForm> = {
  phone: [
    { required: true, message: '请输入手机号', trigger: 'blur' },
    { pattern: /^1[3-9]\d{9}$/, message: '手机号格式不正确', trigger: 'blur' },
  ],
  password: [{ required: true, message: '请输入密码', trigger: 'blur' }],
  nickname: [{ required: true, message: '请输入昵称', trigger: 'blur' }],
};

async function handleSubmit(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false);
  if (!valid) return;
  submitting.value = true;
  try {
    const payload: RegisterPayload = {
      phone: form.phone,
      password: form.password,
      nickname: form.nickname,
    };
    await auth.register(payload);
    ElMessage.success('注册成功，请登录');
    router.push({ name: 'login' });
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '注册失败');
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="auth-page">
    <div class="card-pad auth-card">
      <h2 class="auth-title">注册账号</h2>
      <el-form ref="formRef" :model="form" :rules="rules" label-position="top" @submit.prevent>
        <el-form-item label="手机号" prop="phone">
          <el-input v-model="form.phone" placeholder="请输入手机号" maxlength="11" clearable />
        </el-form-item>
        <el-form-item label="昵称" prop="nickname">
          <el-input v-model="form.nickname" placeholder="请输入昵称" maxlength="20" clearable />
        </el-form-item>
        <el-form-item label="密码" prop="password">
          <el-input v-model="form.password" type="password" placeholder="请输入密码" show-password @keyup.enter="handleSubmit" />
        </el-form-item>
        <el-button type="primary" class="auth-submit" :loading="submitting" @click="handleSubmit">注册</el-button>
      </el-form>
      <div class="auth-footer">
        已有账号？<router-link :to="{ name: 'login' }">去登录</router-link>
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
