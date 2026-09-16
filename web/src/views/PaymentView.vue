<script setup lang="ts">
/**
 * @file web/src/views/PaymentView.vue
 * @description 收银台：余额支付 / 模拟支付，支付成功后回写订单状态。
 */
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { paymentApi, type PayMethod } from '@/api/payment';
import { useOrderStore } from '@/stores/order';
import { formatYuan } from '@/utils/money';

const route = useRoute();
const router = useRouter();
const orderStore = useOrderStore();

const orderNo = computed(() => String(route.params.orderNo));
const order = computed(() => orderStore.getOrder(orderNo.value));
const payAmount = computed(() => order.value?.payAmount ?? 0);

const paying = ref(false);
/** 模拟支付是否已发起、等待用户点击「模拟支付成功」 */
const mockPending = ref(false);
const currentPaymentNo = ref<string | null>(null);
const currentAmount = ref(0);

async function pay(method: PayMethod): Promise<void> {
  if (paying.value) return;
  paying.value = true;
  try {
    const res = await paymentApi.create(orderNo.value, method);
    orderStore.setPaymentNo(orderNo.value, res.paymentNo);
    currentPaymentNo.value = res.paymentNo;
    currentAmount.value = res.amount;
    if (method === 'BALANCE') {
      await paymentApi.balancePay(res.paymentNo);
      finishPaid();
    } else {
      mockPending.value = true;
    }
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '发起支付失败');
  } finally {
    paying.value = false;
  }
}

async function confirmMock(): Promise<void> {
  if (!currentPaymentNo.value) return;
  paying.value = true;
  try {
    await paymentApi.mockPaid(currentPaymentNo.value, currentAmount.value);
    finishPaid();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '支付失败');
  } finally {
    paying.value = false;
  }
}

function finishPaid(): void {
  orderStore.setStatus(orderNo.value, 'PAID');
  ElMessage.success('支付成功');
  router.push({ name: 'orders' });
}

onMounted(() => {
  if (!order.value) {
    ElMessage.warning('未找到订单信息，请重新下单');
  }
});
</script>

<template>
  <div class="pay">
    <h2 class="title">收银台</h2>
    <div class="card-pad pay-card">
      <div class="order-no text-muted">订单号：{{ orderNo }}</div>
      <div class="amount">
        应付金额：<span class="price">{{ formatYuan(payAmount) }}</span>
      </div>

      <div class="methods">
        <el-button type="primary" :loading="paying && !mockPending" @click="pay('BALANCE')">
          余额支付
        </el-button>
        <el-button :loading="paying && !mockPending" @click="pay('MOCK')">
          模拟支付
        </el-button>
      </div>

      <div v-if="mockPending" class="mock-tip">
        <p class="text-muted">已创建模拟支付单，点击下方按钮完成支付。</p>
        <el-button type="success" :loading="paying" @click="confirmMock">模拟支付成功</el-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.title {
  margin: 0 0 16px;
}
.pay-card {
  max-width: 480px;
}
.order-no {
  margin-bottom: 12px;
}
.amount {
  font-size: 18px;
  margin-bottom: 24px;
}
.methods {
  display: flex;
  gap: 16px;
}
.mock-tip {
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid var(--border);
}
</style>
