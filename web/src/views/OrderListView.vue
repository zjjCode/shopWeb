<script setup lang="ts">
/**
 * @file web/src/views/OrderListView.vue
 * @description 我的订单（前端会话内订单，后端暂无列表接口）。
 */
import { computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { orderApi } from '@/api/order';
import { useOrderStore, type SessionOrder } from '@/stores/order';
import type { OrderStatus } from '@/api/types';
import { formatYuan } from '@/utils/money';
import { formatDateTime } from '@/utils/format';

const router = useRouter();
const orderStore = useOrderStore();

const orders = computed(() => orderStore.orders);

onMounted(() => {
  orderStore.fetchOrders();
});

const statusText: Record<OrderStatus, string> = {
  PENDING_PAYMENT: '待支付',
  PAID: '已支付',
  SHIPPED: '已发货',
  COMPLETED: '已完成',
  CANCELLED: '已取消',
  REFUNDING: '退款中',
  REFUNDED: '已退款',
};

const statusType: Record<OrderStatus, '' | 'success' | 'warning' | 'info' | 'danger'> = {
  PENDING_PAYMENT: 'warning',
  PAID: '',
  SHIPPED: '',
  COMPLETED: 'success',
  CANCELLED: 'info',
  REFUNDING: 'danger',
  REFUNDED: 'info',
};

async function payOrder(order: SessionOrder): Promise<void> {
  router.push({ name: 'pay', params: { orderNo: order.orderNo } });
}

async function cancelOrder(order: SessionOrder): Promise<void> {
  try {
    await ElMessageBox.confirm('确定取消该订单吗？', '提示', { type: 'warning' });
  } catch {
    return;
  }
  try {
    await orderApi.cancel(order.orderNo);
    orderStore.setStatus(order.orderNo, 'CANCELLED');
    ElMessage.success('订单已取消');
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '取消失败');
  }
}

async function confirmReceive(order: SessionOrder): Promise<void> {
  try {
    await orderApi.confirm(order.orderNo);
    orderStore.setStatus(order.orderNo, 'COMPLETED');
    ElMessage.success('已确认收货');
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '操作失败');
  }
}

function goRefund(): void {
  router.push({ name: 'refunds' });
}
</script>

<template>
  <div class="orders">
    <h2 class="title">我的订单</h2>

    <el-alert
      class="alert"
      title="当前为前端会话内订单，后端暂未提供订单列表接口，刷新页面后订单将清空。"
      type="info"
      :closable="false"
      show-icon
    />

    <div v-if="orders.length === 0" class="empty-tip">还没有订单，去商城逛逛吧～</div>

    <div v-for="order in orders" :key="order.orderNo" class="card-pad order-card">
      <div class="order-head">
        <span>订单号：{{ order.orderNo }}</span>
        <span class="text-muted">{{ formatDateTime(order.createdAt) }}</span>
        <el-tag :type="statusType[order.status]">{{ statusText[order.status] }}</el-tag>
        <span class="order-amount">应付：<span class="price">{{ formatYuan(order.payAmount) }}</span></span>
      </div>

      <div class="order-items">
        <div v-for="(item, idx) in order.items" :key="idx" class="order-item">
          <el-image :src="item.image ?? ''" fit="cover" class="item-img">
            <template #error>
              <div class="img-fallback">-</div>
            </template>
          </el-image>
          <div class="item-name">{{ item.name }}</div>
          <div class="text-muted">x{{ item.quantity }}</div>
          <div class="price">{{ formatYuan(item.price) }}</div>
        </div>
      </div>

      <div class="order-actions">
        <el-button
          v-if="order.status === 'PENDING_PAYMENT'"
          type="primary"
          size="small"
          @click="payOrder(order)"
        >
          去支付
        </el-button>
        <el-button
          v-if="order.status === 'PENDING_PAYMENT'"
          size="small"
          @click="cancelOrder(order)"
        >
          取消
        </el-button>
        <el-button
          v-if="order.status === 'SHIPPED'"
          type="success"
          size="small"
          @click="confirmReceive(order)"
        >
          确认收货
        </el-button>
        <el-button
          v-if="['PAID', 'SHIPPED', 'COMPLETED'].includes(order.status)"
          size="small"
          @click="goRefund"
        >
          申请退款
        </el-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.title {
  margin: 0 0 16px;
}
.alert {
  margin-bottom: 16px;
}
.order-card {
  margin-bottom: 16px;
}
.order-head {
  display: flex;
  align-items: center;
  gap: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border);
}
.order-amount {
  margin-left: auto;
}
.order-items {
  padding: 12px 0;
}
.order-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 0;
}
.item-img {
  width: 48px;
  height: 48px;
  border-radius: 6px;
  background: #fafafa;
}
.img-fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--text-muted);
}
.item-name {
  flex: 1;
}
.order-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  border-top: 1px solid var(--border);
  padding-top: 12px;
}
</style>
