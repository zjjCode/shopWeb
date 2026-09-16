<script setup lang="ts">
/**
 * @file web/src/views/AddressView.vue
 * @description 收货地址管理：列表、新增、编辑、删除、设为默认。
 */
import { onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus';
import { addressApi, type AddressTag, type AddressPayload } from '@/api/address';
import type { Address } from '@/api/types';

const list = ref<Address[]>([]);
const loading = ref(false);

const dialogVisible = ref(false);
const formRef = ref<FormInstance>();
const editingId = ref<number | null>(null);
const submitting = ref(false);

function emptyForm(): AddressPayload {
  return {
    receiverName: '',
    phone: '',
    provinceCode: '',
    provinceName: '',
    cityCode: '',
    cityName: '',
    districtCode: '',
    districtName: '',
    detailAddress: '',
    tag: null,
    isDefault: false,
  };
}

const form = reactive<AddressPayload>(emptyForm());

const rules: FormRules<AddressPayload> = {
  receiverName: [{ required: true, message: '请输入收货人', trigger: 'blur' }],
  phone: [
    { required: true, message: '请输入手机号', trigger: 'blur' },
    { pattern: /^1[3-9]\d{9}$/, message: '手机号格式不正确', trigger: 'blur' },
  ],
  provinceName: [{ required: true, message: '请输入省份', trigger: 'blur' }],
  cityName: [{ required: true, message: '请输入城市', trigger: 'blur' }],
  districtName: [{ required: true, message: '请输入区/县', trigger: 'blur' }],
  detailAddress: [{ required: true, message: '请输入详细地址', trigger: 'blur' }],
};

async function load(): Promise<void> {
  loading.value = true;
  try {
    list.value = await addressApi.list();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '加载失败');
  } finally {
    loading.value = false;
  }
}

function openCreate(): void {
  editingId.value = null;
  Object.assign(form, emptyForm());
  dialogVisible.value = true;
}

function openEdit(addr: Address): void {
  editingId.value = addr.id;
  Object.assign(form, {
    receiverName: addr.receiverName,
    phone: addr.phone,
    provinceCode: addr.provinceCode,
    provinceName: addr.provinceName,
    cityCode: addr.cityCode,
    cityName: addr.cityName,
    districtCode: addr.districtCode,
    districtName: addr.districtName,
    detailAddress: addr.detailAddress,
    tag: addr.tag,
    isDefault: addr.isDefault,
  });
  dialogVisible.value = true;
}

async function save(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false);
  if (!valid) return;
  const payload: AddressPayload = {
    ...form,
    provinceCode: form.provinceName,
    cityCode: form.cityName,
    districtCode: form.districtName,
  };
  submitting.value = true;
  try {
    if (editingId.value != null) {
      await addressApi.update(editingId.value, payload);
      ElMessage.success('已更新');
    } else {
      await addressApi.create(payload);
      ElMessage.success('已新增');
    }
    dialogVisible.value = false;
    await load();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '保存失败');
  } finally {
    submitting.value = false;
  }
}

async function remove(addr: Address): Promise<void> {
  try {
    await ElMessageBox.confirm(`确定删除「${addr.receiverName}」的地址吗？`, '提示', { type: 'warning' });
  } catch {
    return;
  }
  try {
    await addressApi.remove(addr.id);
    ElMessage.success('已删除');
    await load();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '删除失败');
  }
}

async function setDefault(addr: Address): Promise<void> {
  try {
    await addressApi.setDefault(addr.id);
    ElMessage.success('已设为默认');
    await load();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '操作失败');
  }
}

function tagText(tag: AddressTag): string {
  if (tag === 'HOME') return '家';
  if (tag === 'COMPANY') return '公司';
  if (tag === 'SCHOOL') return '学校';
  return '';
}

onMounted(load);
</script>

<template>
  <div class="address">
    <div class="head">
      <h2 class="title">收货地址</h2>
      <el-button type="primary" @click="openCreate">新增地址</el-button>
    </div>

    <div v-loading="loading" class="card-pad">
      <el-table v-if="list.length" :data="list">
        <el-table-column prop="receiverName" label="收货人" width="100" />
        <el-table-column prop="phone" label="手机" width="140" />
        <el-table-column label="地址">
          <template #default="{ row }">
            {{ row.provinceName }}{{ row.cityName }}{{ row.districtName }} {{ row.detailAddress }}
          </template>
        </el-table-column>
        <el-table-column label="标签" width="90">
          <template #default="{ row }">
            <el-tag v-if="row.tag">{{ tagText(row.tag) }}</el-tag>
            <span v-else class="text-muted">-</span>
          </template>
        </el-table-column>
        <el-table-column label="默认" width="90">
          <template #default="{ row }">
            <el-tag v-if="row.isDefault" type="success">默认</el-tag>
            <span v-else class="text-muted">否</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="220">
          <template #default="{ row }">
            <el-button text type="primary" @click="openEdit(row)">编辑</el-button>
            <el-button text type="primary" :disabled="row.isDefault" @click="setDefault(row)">设为默认</el-button>
            <el-button text type="danger" @click="remove(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <div v-else class="empty-tip">暂无收货地址</div>
    </div>

    <el-dialog v-model="dialogVisible" :title="editingId != null ? '编辑地址' : '新增地址'" width="480px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="80px">
        <el-form-item label="收货人" prop="receiverName">
          <el-input v-model="form.receiverName" placeholder="收货人姓名" />
        </el-form-item>
        <el-form-item label="手机号" prop="phone">
          <el-input v-model="form.phone" placeholder="手机号" maxlength="11" />
        </el-form-item>
        <el-form-item label="省份" prop="provinceName">
          <el-input v-model="form.provinceName" placeholder="省份" />
        </el-form-item>
        <el-form-item label="城市" prop="cityName">
          <el-input v-model="form.cityName" placeholder="城市" />
        </el-form-item>
        <el-form-item label="区/县" prop="districtName">
          <el-input v-model="form.districtName" placeholder="区/县" />
        </el-form-item>
        <el-form-item label="详细地址" prop="detailAddress">
          <el-input v-model="form.detailAddress" type="textarea" :rows="2" placeholder="街道、门牌号等" />
        </el-form-item>
        <el-form-item label="标签">
          <el-select v-model="form.tag" placeholder="选择标签" clearable>
            <el-option label="家" value="HOME" />
            <el-option label="公司" value="COMPANY" />
            <el-option label="学校" value="SCHOOL" />
          </el-select>
        </el-form-item>
        <el-form-item label="设为默认">
          <el-switch v-model="form.isDefault" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}
.title {
  margin: 0;
}
</style>
