<script setup lang="ts">
/**
 * @file web/src/views/CartView.vue
 * @description 购物车：有效项（勾选/改数量/删除）、失效项、底部结算。
 */
import { computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useCartStore } from '@/stores/cart';
import type { CartItemView, CartInvalidReason } from '@/api/types';
import { formatYuan } from '@/utils/money';

const router = useRouter();
const cart = useCartStore();

const invalidReasonText: Record<CartInvalidReason, string> = {
  DELETED: '商品已下架',
  SKU_DISABLED: '规格已失效',
  PRODUCT_OFF_SALE: '商品已停售',
  STOCK_NOT_ENOUGH: '库存不足',
};

const allSelected = computed({
  get: () => cart.validItems.length > 0 && cart.validItems.every((i) => i.selected),
  set: (val: boolean) => {
    cart.validItems.forEach((i) => {
      if (i.selected !== val) void cart.updateItem(i.id, { selected: val });
    });
  },
});

async function toggleSelect(item: CartItemView): Promise<void> {
  try {
    await cart.updateItem(item.id, { selected: !item.selected });
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '操作失败');
  }
}

async function changeQuantity(item: CartItemView, qty: number): Promise<void> {
  try {
    await cart.updateItem(item.id, { quantity: qty });
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '操作失败');
  }
}

async function removeItem(id: number): Promise<void> {
  try {
    await ElMessageBox.confirm('确定从购物车移除该商品吗？', '提示', { type: 'warning' });
  } catch {
    return;
  }
  try {
    await cart.removeItems([id]);
    ElMessage.success('已移除');
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '删除失败');
  }
}

async function clearInvalid(): Promise<void> {
  const ids = cart.invalidItems.map((i) => i.id);
  if (ids.length === 0) return;
  try {
    await cart.removeItems(ids);
    ElMessage.success('已清空失效商品');
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '删除失败');
  }
}

function goCheckout(): void {
  router.push({ name: 'checkout' });
}

function isEmpty(): boolean {
  return cart.validItems.length === 0 && cart.invalidItems.length === 0;
}

onMounted(() => {
  void cart.fetchCart();
});
</script>

<template>
  <div class="cart">
    <h2 class="title">购物车</h2>

    <div v-if="isEmpty()" class="empty-tip">购物车还是空的，去逛逛吧～</div>

    <template v-else>
      <div v-if="cart.validItems.length" class="card-pad section">
        <div class="sec-head">
          <el-checkbox v-model="allSelected">全选</el-checkbox>
          <span class="text-muted">有效商品（{{ cart.validItems.length }}）</span>
        </div>
        <div v-for="item in cart.validItems" :key="item.id" class="cart-item" :class="{ off: item.priceChanged }">
          <el-checkbox :model-value="item.selected" @change="toggleSelect(item)" />
          <div class="item-main">
            <div class="item-name">SKU #{{ item.skuId }}</div>
            <div v-if="item.priceChanged" class="text-muted">价格已更新</div>
          </div>
          <div class="item-price price">{{ formatYuan(item.price) }}</div>
          <el-input-number :model-value="item.quantity" :min="1" :max="99" size="small" @change="(q: number) => changeQuantity(item, q)" />
          <div class="item-sub price">{{ formatYuan(item.price * item.quantity) }}</div>
          <el-button text type="danger" @click="removeItem(item.id)">删除</el-button>
        </div>
      </div>

      <div v-if="cart.invalidItems.length" class="card-pad section">
        <div class="sec-head">
          <span class="text-muted">失效商品（{{ cart.invalidItems.length }}）</span>
          <el-button text type="danger" @click="clearInvalid">清空失效</el-button>
        </div>
        <div v-for="item in cart.invalidItems" :key="item.id" class="cart-item invalid">
          <div class="item-main">
            <div class="item-name">SKU #{{ item.skuId }}</div>
            <div class="reason text-muted">
              失效原因：{{ item.invalidReason ? invalidReasonText[item.invalidReason] : '未知' }}
            </div>
          </div>
          <div class="item-price text-muted">{{ formatYuan(item.price) }}</div>
          <div class="item-sub text-muted">x{{ item.quantity }}</div>
          <el-button text type="danger" @click="removeItem(item.id)">删除</el-button>
        </div>
      </div>

      <div class="card-pad footer-bar">
        <el-checkbox v-model="allSelected">全选</el-checkbox>
        <div class="footer-right">
          <span>已选 <b>{{ cart.selectedCount }}</b> 件</span>
          <span class="total-label">合计：<span class="price">{{ formatYuan(cart.selectedTotal) }}</span></span>
          <el-button type="primary" :disabled="cart.selectedCount === 0" @click="goCheckout">去结算</el-button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.title {
  margin: 0 0 16px;
}
.section {
  margin-bottom: 16px;
}
.sec-head {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}
.cart-item {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 12px 0;
  border-top: 1px solid var(--border);
}
.cart-item.invalid {
  opacity: 0.6;
}
.item-main {
  flex: 1;
  min-width: 0;
}
.item-name {
  font-weight: 600;
}
.reason {
  font-size: 12px;
  margin-top: 4px;
}
.item-price {
  width: 90px;
  text-align: right;
}
.item-sub {
  width: 90px;
  text-align: right;
}
.footer-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  position: sticky;
  bottom: 0;
}
.footer-right {
  display: flex;
  align-items: center;
  gap: 16px;
}
.total-label {
  font-size: 14px;
}
</style>
