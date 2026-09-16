<script setup lang="ts">
/**
 * @file web/src/views/BalanceView.vue
 * @description 我的余额：账户余额、流水、充值。
 */
import { onMounted, reactive, ref } from 'vue';
import { ElMessage, type FormInstance, type FormRules } from 'element-plus';
import { balanceApi } from '@/api/balance';
import type { BalanceAccount, BalanceTransaction } from '@/api/types';
import { formatYuan, parseYuanToFen } from '@/utils/money';
import { formatDateTime } from '@/utils/format';

const account = ref<BalanceAccount | null>(null);
const transactions = ref<BalanceTransaction[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(10);
const loading = ref(false);
const txLoading = ref(false);

const dialogVisible = ref(false);
const formRef = ref<FormInstance>();
const submitting = ref(false);

interface RechargeForm {
  amountYuan: number;
  payMethod: string;
}

const form = reactive<RechargeForm>({ amountYuan: 0, payMethod: 'ALIPAY' });

const rules: FormRules<RechargeForm> = {
  amountYuan: [{ required: true, message: '请输入充值金额', trigger: 'blur' }],
};

async function loadBalance(): Promise<void> {
  loading.value = true;
  try {
    account.value = await balanceApi.getBalance();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '加载余额失败');
  } finally {
    loading.value = false;
  }
}

async function loadTransactions(): Promise<void> {
  txLoading.value = true;
  try {
    const res = await balanceApi.listTransactions({ page: page.value, pageSize: pageSize.value });
    transactions.value = res.list;
    total.value = res.total;
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '加载流水失败');
  } finally {
    txLoading.value = false;
  }
}

function openRecharge(): void {
  form.amountYuan = 0;
  form.payMethod = 'ALIPAY';
  dialogVisible.value = true;
}

async function submitRecharge(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false);
  if (!valid) return;
  submitting.value = true;
  try {
    await balanceApi.createRecharge({ amount: parseYuanToFen(form.amountYuan), payMethod: form.payMethod });
    ElMessage.success('充值单已创建，实际支付链路为后续任务');
    dialogVisible.value = false;
    await loadBalance();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '充值失败');
  } finally {
    submitting.value = false;
  }
}

function onPageChange(p: number): void {
  page.value = p;
  loadTransactions();
}

onMounted(() => {
  loadBalance();
  loadTransactions();
});
</script>

<template>
  <div class="balance">
    <h2 class="title">我的余额</h2>

    <div v-loading="loading" class="card-pad balance-card">
      <div class="balance-row">
        <div>
          <div class="text-muted">账户号</div>
          <div class="account-no">{{ account?.accountNo ?? '-' }}</div>
        </div>
        <div class="balance-amount">
          <span class="text-muted">可用余额</span>
          <div class="price amount">{{ account ? formatYuan(account.balance) : '-' }}</div>
        </div>
        <el-button type="primary" @click="openRecharge">充值</el-button>
      </div>
    </div>

    <div v-loading="txLoading" class="card-pad">
      <h3 class="block-title">交易流水</h3>
      <el-table v-if="transactions.length" :data="transactions">
        <el-table-column prop="txNo" label="流水号" min-width="170" />
        <el-table-column prop="bizType" label="业务类型" width="120" />
        <el-table-column label="方向" width="90">
          <template #default="{ row }">
            <el-tag :type="row.direction === 'IN' ? 'success' : 'danger'">
              {{ row.direction === 'IN' ? '收入' : '支出' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="金额" width="120">
          <template #default="{ row }">
            <span :class="row.direction === 'IN' ? 'in' : 'out'">{{ formatYuan(row.amount) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="变动前" width="120">
          <template #default="{ row }">{{ formatYuan(row.beforeBalance) }}</template>
        </el-table-column>
        <el-table-column label="变动后" width="120">
          <template #default="{ row }">{{ formatYuan(row.afterBalance) }}</template>
        </el-table-column>
        <el-table-column label="时间" min-width="160">
          <template #default="{ row }">{{ formatDateTime(row.createdAt) }}</template>
        </el-table-column>
      </el-table>
      <div v-else class="empty-tip">暂无交易流水</div>

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

    <el-dialog v-model="dialogVisible" title="余额充值" width="420px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="80px">
        <el-form-item label="充值金额" prop="amountYuan">
          <el-input-number v-model="form.amountYuan" :min="0" :precision="2" :step="10" />
          <span class="unit">元</span>
        </el-form-item>
        <el-form-item label="支付方式">
          <el-select v-model="form.payMethod">
            <el-option label="支付宝" value="ALIPAY" />
            <el-option label="微信" value="WECHAT" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitRecharge">创建充值单</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.title {
  margin: 0 0 16px;
}
.balance-card {
  margin-bottom: 16px;
}
.balance-row {
  display: flex;
  align-items: center;
  gap: 32px;
}
.account-no {
  font-size: 16px;
  font-weight: 600;
  margin-top: 4px;
}
.balance-amount {
  margin-left: auto;
  text-align: right;
}
.amount {
  font-size: 24px;
  margin-top: 4px;
}
.block-title {
  margin: 0 0 12px;
}
.in {
  color: var(--brand);
}
.out {
  color: #67c23a;
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
