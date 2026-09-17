<script setup lang="ts">
/**
 * @file web/src/views/MockPayView.vue
 * @description 充值渠道模拟收银台。
 *
 * 消费后端渠道化 payUrl（/mock-pay/:channel?paymentNo=...）：展示应付金额与渠道，
 * 用户点击「确认支付」后调用 mock 回调端点（POST /api/payments/:paymentNo/mock-paid），
 * 由 PaymentService.handlePaidNotify 按 orderId===null 分流到 settleRecharge 入账，
 * 充值金额写入用户余额账户，随后回跳余额页刷新。
 *
 * 说明（mock 形态）：真实渠道收银台由渠道网关托管、金额从网关会话获取；离线 mock 没有
 * 该 GET 端点，故金额由跳转时附带（amount 必须与支付单严格相等才能入账，详见 PaymentService 金额校验）。
 */
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { paymentApi } from '@/api/payment';
import { formatYuan } from '@/utils/money';

const route = useRoute();
const router = useRouter();

const channel = computed(() => String(route.params.channel ?? '').toUpperCase());
const paymentNo = computed(() => String(route.query.paymentNo ?? ''));
const amount = computed<number>(() => Number(route.query.amount ?? 0));
const rechargeNo = computed(() => String(route.query.rechargeNo ?? ''));

const CHANNEL_LABEL: Record<string, string> = {
  ALIPAY: '支付宝',
  WECHAT: '微信支付',
  BANKCARD: '银行卡',
};
const channelLabel = computed(() => (CHANNEL_LABEL[channel.value] ?? channel.value) || '支付渠道');

const paying = ref(false);
const invalid = ref(false);

onMounted(() => {
  if (!paymentNo.value || !amount.value) {
    invalid.value = true;
    ElMessage.error('收银台参数缺失，请重新发起充值');
  }
});

async function confirmPay(): Promise<void> {
  if (paying.value || invalid.value) return;
  paying.value = true;
  try {
    await paymentApi.mockPaid(paymentNo.value, amount.value);
    ElMessage.success('充值成功，余额已到账');
    router.replace({ name: 'balance' });
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '支付失败');
  } finally {
    paying.value = false;
  }
}

function cancel(): void {
  router.replace({ name: 'balance' });
}
</script>

<template>
  <div class="pay">
    <h2 class="title">收银台</h2>
    <div class="card-pad pay-card">
      <div class="channel-tag">{{ channelLabel }}（模拟收银台）</div>

      <template v-if="!invalid">
        <div v-if="rechargeNo" class="recharge-no text-muted">充值单号：{{ rechargeNo }}</div>
        <div class="amount">
          应付金额：<span class="price">{{ formatYuan(amount) }}</span>
        </div>
        <p class="text-muted tip">
          这是离线模拟收银台，点击下方按钮即模拟「渠道已收款」并触发入账，余额将实时增加。
        </p>
        <div class="methods">
          <el-button type="primary" :loading="paying" @click="confirmPay">确认支付</el-button>
          <el-button :disabled="paying" @click="cancel">取消</el-button>
        </div>
      </template>

      <el-empty v-else description="收银台参数缺失，请返回重新发起充值">
        <el-button @click="cancel">返回余额</el-button>
      </el-empty>
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
.channel-tag {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 12px;
}
.recharge-no {
  margin-bottom: 12px;
}
.amount {
  font-size: 18px;
  margin-bottom: 16px;
}
.tip {
  margin-bottom: 24px;
  line-height: 1.6;
}
.methods {
  display: flex;
  gap: 16px;
}
</style>
