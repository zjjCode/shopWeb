<script setup lang="ts">
/**
 * @file web/src/views/RefundListView.vue
 * @description 我的退款：列表 + 申请退款弹窗。
 */
import { onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, type FormInstance, type FormRules } from 'element-plus';
import { refundApi, type RefundType } from '@/api/refund';
import type { RefundRecord } from '@/api/types';
import { formatYuan, parseYuanToFen } from '@/utils/money';
import { formatDateTime } from '@/utils/format';

const route = useRoute();
const router = useRouter();

const list = ref<RefundRecord[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(10);
const loading = ref(false);

const dialogVisible = ref(false);
const formRef = ref<FormInstance>();
const submitting = ref(false);

interface RefundForm {
  orderNo: string;
  type: RefundType;
  amountYuan: number;
  reasonText: string;
}

const form = reactive<RefundForm>({
  orderNo: '',
  type: 'FULL',
  amountYuan: 0,
  reasonText: '',
});

const rules: FormRules<RefundForm> = {
  orderNo: [{ required: true, message: '请输入订单号', trigger: 'blur' }],
  amountYuan: [{ required: true, message: '请输入退款金额', trigger: 'blur' }],
};

async function loadList(): Promise<void> {
  loading.value = true;
  try {
    const res = await refundApi.list({ page: page.value, pageSize: pageSize.value });
    list.value = res.list;
    total.value = res.total;
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '加载失败');
  } finally {
    loading.value = false;
  }
}

function goDetail(refundNo: string): void {
  router.push({ name: 'refund-detail', params: { refundNo } });
}

function openApply(): void {
  form.orderNo = typeof route.query.orderNo === 'string' ? route.query.orderNo : '';
  form.type = 'FULL';
  form.amountYuan = 0;
  form.reasonText = '';
  dialogVisible.value = true;
}

async function submitApply(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false);
  if (!valid) return;
  submitting.value = true;
  try {
    await refundApi.apply({
      orderNo: form.orderNo,
      type: form.type,
      amount: parseYuanToFen(form.amountYuan),
      reasonText: form.reasonText || null,
    });
    ElMessage.success('退款申请已提交');
    dialogVisible.value = false;
    await loadList();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '提交失败');
  } finally {
    submitting.value = false;
  }
}

function typeText(t: RefundType): string {
  return t === 'FULL' ? '全额' : '部分';
}

function onPageChange(p: number): void {
  page.value = p;
  loadList();
}

onMounted(loadList);
</script>

<template>
  <div class="refunds">
    <div class="head">
      <h2 class="title">我的退款</h2>
      <el-button type="primary" @click="openApply">申请退款</el-button>
    </div>

    <div v-loading="loading" class="card-pad">
      <el-table v-if="list.length" :data="list" @row-click="(row: RefundRecord) => goDetail(row.refundNo)">
        <el-table-column prop="refundNo" label="退款单号" min-width="160" />
        <el-table-column prop="orderNo" label="订单号" min-width="160" />
        <el-table-column label="类型" width="90">
          <template #default="{ row }">
            <el-tag>{{ typeText(row.type) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="金额" width="120">
          <template #default="{ row }">
            <span class="price">{{ formatYuan(row.amount) }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="status" label="状态" width="100" />
        <el-table-column label="创建时间" min-width="160">
          <template #default="{ row }">{{ formatDateTime(row.createdAt) }}</template>
        </el-table-column>
      </el-table>
      <div v-else class="empty-tip">暂无退款记录</div>

      <el-pagination
        v-if="total > pageSize"
        class="pager"
        :current-page="page"
        :page-size="pageSize"
        :total="total"
        layout="total, prev, pager, next"
        @current-change="onPageChange"
      />
    </div>

    <el-dialog v-model="dialogVisible" title="申请退款" width="480px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="80px">
        <el-form-item label="订单号" prop="orderNo">
          <el-input v-model="form.orderNo" placeholder="请输入要退款的订单号" />
        </el-form-item>
        <el-form-item label="退款类型" prop="type">
          <el-radio-group v-model="form.type">
            <el-radio-button value="FULL">全额</el-radio-button>
            <el-radio-button value="PARTIAL">部分</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="退款金额" prop="amountYuan">
          <el-input-number v-model="form.amountYuan" :min="0" :precision="2" :step="1" />
          <span class="unit">元</span>
        </el-form-item>
        <el-form-item label="退款原因">
          <el-input v-model="form.reasonText" type="textarea" :rows="3" placeholder="选填" maxlength="200" show-word-limit />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitApply">提交</el-button>
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
.pager {
  justify-content: center;
  margin-top: 16px;
}
.unit {
  margin-left: 8px;
  color: var(--text-muted);
}
</style>
