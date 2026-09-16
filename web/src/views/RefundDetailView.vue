<script setup lang="ts">
/**
 * @file web/src/views/RefundDetailView.vue
 * @description 退款详情：展示退款单全部字段。
 */
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { refundApi, type RefundType } from '@/api/refund';
import type { RefundRecord } from '@/api/types';
import { formatYuan } from '@/utils/money';
import { formatDateTime } from '@/utils/format';

const route = useRoute();
const router = useRouter();

const refundNo = computed(() => String(route.params.refundNo));
const record = ref<RefundRecord | null>(null);
const loading = ref(false);

async function load(): Promise<void> {
  loading.value = true;
  try {
    record.value = await refundApi.detail(refundNo.value);
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '加载失败');
  } finally {
    loading.value = false;
  }
}

function typeText(t: RefundType): string {
  return t === 'FULL' ? '全额' : '部分';
}

function goBack(): void {
  router.push({ name: 'refunds' });
}

onMounted(load);
</script>

<template>
  <div v-loading="loading" class="refund-detail">
    <div class="head">
      <h2 class="title">退款详情</h2>
      <el-button @click="goBack">返回</el-button>
    </div>

    <div v-if="record" class="card-pad">
      <el-descriptions :column="2" border>
        <el-descriptions-item label="退款单号">{{ record.refundNo }}</el-descriptions-item>
        <el-descriptions-item label="订单号">{{ record.orderNo }}</el-descriptions-item>
        <el-descriptions-item label="退款类型">
          <el-tag>{{ typeText(record.type) }}</el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="退款金额">
          <span class="price">{{ formatYuan(record.amount) }}</span>
        </el-descriptions-item>
        <el-descriptions-item label="状态">{{ record.status }}</el-descriptions-item>
        <el-descriptions-item label="退回账户">{{ record.refundTo || '-' }}</el-descriptions-item>
        <el-descriptions-item label="创建时间">{{ formatDateTime(record.createdAt) }}</el-descriptions-item>
        <el-descriptions-item label="退款原因">{{ record.reasonText || '无' }}</el-descriptions-item>
      </el-descriptions>

      <template v-if="record.voucherImages && record.voucherImages.length">
        <h3 class="block-title">凭证图片</h3>
        <div class="vouchers">
          <el-image
            v-for="(url, idx) in record.voucherImages"
            :key="idx"
            :src="url"
            fit="cover"
            class="voucher"
          >
            <template #error>
              <div class="img-fallback">加载失败</div>
            </template>
          </el-image>
        </div>
      </template>

      <template v-if="record.items && record.items.length">
        <h3 class="block-title">退款商品</h3>
        <el-table :data="record.items" class="items-table">
          <el-table-column prop="orderItemId" label="订单项ID" min-width="100" />
          <el-table-column prop="quantity" label="数量" width="90" />
          <el-table-column label="金额" width="120">
            <template #default="{ row }">
              <span class="price">{{ formatYuan(row.amount) }}</span>
            </template>
          </el-table-column>
        </el-table>
      </template>
    </div>

    <div v-else-if="!loading" class="empty-tip">未找到退款单</div>
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
.block-title {
  margin: 24px 0 12px;
}
.vouchers {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}
.voucher {
  width: 120px;
  height: 120px;
  border-radius: 8px;
  background: #fafafa;
}
.img-fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--text-muted);
  font-size: 12px;
}
.items-table {
  margin-top: 8px;
}
</style>
