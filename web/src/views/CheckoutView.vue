<script setup lang="ts">
/**
 * @file web/src/views/CheckoutView.vue
 * @description 结算页：选地址、确认已勾选有效购物车项、提交订单。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, type FormInstance, type FormRules } from 'element-plus';
import { addressApi, type AddressPayload } from '@/api/address';
import { orderApi } from '@/api/order';
import { useCartStore } from '@/stores/cart';
import { useOrderStore, type SessionOrderItem } from '@/stores/order';
import type { Address } from '@/api/types';
import { formatYuan } from '@/utils/money';

const router = useRouter();
const cart = useCartStore();
const orderStore = useOrderStore();

const addresses = ref<Address[]>([]);
const selectedAddressId = ref<number | null>(null);
const buyerRemark = ref('');
const submitting = ref(false);

const selectedItems = computed(() =>
  cart.validItems.filter((i) => i.selected && !i.invalid),
);

/** 地址弹窗（仅新增，无行政区划接口，省/市/区用普通输入） */
const dialogVisible = ref(false);
const addressFormRef = ref<FormInstance>();
const addressSubmitting = ref(false);

function emptyAddressForm(): AddressPayload {
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

const addressForm = reactive<AddressPayload>(emptyAddressForm());

const addressRules: FormRules<AddressPayload> = {
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

async function loadAddresses(): Promise<void> {
  try {
    const list = await addressApi.list();
    addresses.value = list;
    const def = list.find((a) => a.isDefault) ?? list[0];
    selectedAddressId.value = def ? def.id : null;
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '加载地址失败');
  }
}

function openCreateAddress(): void {
  Object.assign(addressForm, emptyAddressForm());
  dialogVisible.value = true;
}

async function saveAddress(): Promise<void> {
  const valid = await addressFormRef.value?.validate().catch(() => false);
  if (!valid) return;
  addressSubmitting.value = true;
  try {
    const payload: AddressPayload = {
      ...addressForm,
      provinceCode: addressForm.provinceName,
      cityCode: addressForm.cityName,
      districtCode: addressForm.districtName,
    };
    await addressApi.create(payload);
    ElMessage.success('地址已新增');
    dialogVisible.value = false;
    await loadAddresses();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '保存失败');
  } finally {
    addressSubmitting.value = false;
  }
}

async function submitOrder(): Promise<void> {
  if (!selectedAddressId.value) {
    ElMessage.warning('请选择收货地址');
    return;
  }
  if (selectedItems.value.length === 0) {
    ElMessage.warning('购物车中没有可结算的商品');
    return;
  }
  submitting.value = true;
  try {
    const cartItemIds = selectedItems.value.map((i) => i.id);
    const res = await orderApi.create({
      addressId: selectedAddressId.value,
      cartItemIds,
      buyerRemark: buyerRemark.value || null,
    });
    const items: SessionOrderItem[] = selectedItems.value.map((i) => ({
      skuId: i.skuId,
      name: `SKU #${i.skuId}`,
      image: null,
      price: i.price,
      quantity: i.quantity,
    }));
    orderStore.addOrder({
      orderNo: res.orderNo,
      payAmount: res.payAmount,
      expireAt: res.expireAt,
      status: 'PENDING_PAYMENT',
      createdAt: new Date().toISOString(),
      items,
    });
    await cart.fetchCart();
    router.push({ name: 'pay', params: { orderNo: res.orderNo } });
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '提交订单失败');
  } finally {
    submitting.value = false;
  }
}

onMounted(async () => {
  await cart.fetchCart();
  await loadAddresses();
});
</script>

<template>
  <div class="checkout">
    <h2 class="title">结算</h2>

    <div v-if="selectedItems.length === 0" class="empty-tip">没有可结算的商品，请先在购物车勾选。</div>

    <template v-else>
      <div class="card-pad section">
        <div class="sec-head">
          <span class="sec-title">收货地址</span>
          <el-button text type="primary" @click="openCreateAddress">新增地址</el-button>
        </div>
        <div v-if="addresses.length === 0" class="text-muted">暂无地址，请先新增收货地址。</div>
        <div v-else class="addr-list">
          <div
            v-for="addr in addresses"
            :key="addr.id"
            class="addr-item"
            :class="{ active: selectedAddressId === addr.id }"
            @click="selectedAddressId = addr.id"
          >
            <div class="addr-top">
              <b>{{ addr.receiverName }}</b>
              <span class="text-muted">{{ addr.phone }}</span>
              <el-tag v-if="addr.isDefault" size="small" type="success">默认</el-tag>
            </div>
            <div class="text-muted">
              {{ addr.provinceName }}{{ addr.cityName }}{{ addr.districtName }} {{ addr.detailAddress }}
            </div>
          </div>
        </div>
      </div>

      <div class="card-pad section">
        <div class="sec-title">商品清单</div>
        <div v-for="item in selectedItems" :key="item.id" class="order-item">
          <div class="item-name">SKU #{{ item.skuId }}</div>
          <div class="item-price price">{{ formatYuan(item.price) }}</div>
          <div class="text-muted">x{{ item.quantity }}</div>
          <div class="item-sub price">{{ formatYuan(item.price * item.quantity) }}</div>
        </div>
        <div class="order-total">
          合计：<span class="price">{{ formatYuan(cart.selectedTotal) }}</span>
        </div>
      </div>

      <div class="card-pad section">
        <div class="sec-title">买家备注</div>
        <el-input
          v-model="buyerRemark"
          type="textarea"
          :rows="3"
          placeholder="选填，给卖家留言"
          maxlength="200"
          show-word-limit
        />
      </div>

      <div class="card-pad footer-bar">
        <span class="total-label">应付：<span class="price">{{ formatYuan(cart.selectedTotal) }}</span></span>
        <el-button type="primary" :loading="submitting" @click="submitOrder">提交订单</el-button>
      </div>
    </template>

    <el-dialog v-model="dialogVisible" title="新增收货地址" width="480px">
      <el-form ref="addressFormRef" :model="addressForm" :rules="addressRules" label-width="80px">
        <el-form-item label="收货人" prop="receiverName">
          <el-input v-model="addressForm.receiverName" placeholder="收货人姓名" />
        </el-form-item>
        <el-form-item label="手机号" prop="phone">
          <el-input v-model="addressForm.phone" placeholder="手机号" maxlength="11" />
        </el-form-item>
        <el-form-item label="省份" prop="provinceName">
          <el-input v-model="addressForm.provinceName" placeholder="省份" />
        </el-form-item>
        <el-form-item label="城市" prop="cityName">
          <el-input v-model="addressForm.cityName" placeholder="城市" />
        </el-form-item>
        <el-form-item label="区/县" prop="districtName">
          <el-input v-model="addressForm.districtName" placeholder="区/县" />
        </el-form-item>
        <el-form-item label="详细地址" prop="detailAddress">
          <el-input v-model="addressForm.detailAddress" type="textarea" :rows="2" placeholder="街道、门牌号等" />
        </el-form-item>
        <el-form-item label="标签">
          <el-select v-model="addressForm.tag" placeholder="选择标签" clearable>
            <el-option label="家" value="HOME" />
            <el-option label="公司" value="COMPANY" />
            <el-option label="学校" value="SCHOOL" />
          </el-select>
        </el-form-item>
        <el-form-item label="设为默认">
          <el-switch v-model="addressForm.isDefault" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="addressSubmitting" @click="saveAddress">保存</el-button>
      </template>
    </el-dialog>
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
  justify-content: space-between;
  margin-bottom: 12px;
}
.sec-title {
  font-weight: 600;
  margin-bottom: 12px;
  display: block;
}
.addr-list {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
}
.addr-item {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  cursor: pointer;
}
.addr-item.active {
  border-color: var(--brand);
  background: #fff7f7;
}
.addr-top {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.order-item {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 10px 0;
  border-top: 1px solid var(--border);
}
.item-name {
  flex: 1;
}
.item-price {
  width: 90px;
  text-align: right;
}
.item-sub {
  width: 90px;
  text-align: right;
}
.order-total {
  text-align: right;
  margin-top: 12px;
}
.footer-bar {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 16px;
}
.total-label {
  font-size: 14px;
}
</style>
