<script setup lang="ts">
/**
 * @file web/src/views/ProductDetailView.vue
 * @description 商品详情：主图、规格选择、数量、加入购物车 / 立即购买。
 */
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { productApi } from '@/api/product';
import { useCartStore } from '@/stores/cart';
import type { ProductDetail, ProductSkuItem, ProductSpecItem } from '@/api/types';
import { formatYuan } from '@/utils/money';

const route = useRoute();
const router = useRouter();
const cart = useCartStore();

const detail = ref<ProductDetail | null>(null);
const loading = ref(false);
const activeImage = ref('');
const quantity = ref(1);

/** 规格维度 -> 选中值 */
const selectedSpecs = ref<Record<string, string>>({});

const product = computed(() => detail.value?.product ?? null);
const images = computed(() => detail.value?.images ?? []);
const specs = computed<ProductSpecItem[]>(() => detail.value?.specs ?? []);
const skus = computed<ProductSkuItem[]>(() => detail.value?.skus ?? []);

/** 每个规格维度的可选值 */
const specOptions = computed(() => {
  const map: Record<string, string[]> = {};
  for (const spec of specs.value) {
    const values = spec.values as string[] | undefined;
    map[spec.name] = Array.isArray(values) ? values : [];
  }
  return map;
});

/** 当前选中的 SKU */
const currentSku = computed<ProductSkuItem | null>(() => {
  if (skus.value.length === 0) return null;
  if (specs.value.length === 0) return skus.value[0];
  const sel = selectedSpecs.value;
  const keys = Object.keys(sel);
  if (keys.some((k) => !sel[k])) return null;
  const matched = skus.value.find((sku) => {
    const sv = sku.specValues as Record<string, string> | undefined;
    if (!sv) return false;
    return keys.every((k) => sv[k] === sel[k]);
  });
  return matched ?? null;
});

const detailHtml = computed(() => product.value?.detail ?? '');

async function loadDetail(): Promise<void> {
  const id = Number(route.params.id);
  if (!Number.isFinite(id) || id <= 0) return;
  loading.value = true;
  try {
    const data = await productApi.detail(id);
    detail.value = data;
    const init: Record<string, string> = {};
    for (const spec of data.specs) {
      const values = spec.values as string[] | undefined;
      if (Array.isArray(values) && values.length) init[spec.name] = values[0];
    }
    selectedSpecs.value = init;
    activeImage.value = data.product.mainImage || data.images[0]?.url || '';
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '加载商品失败');
  } finally {
    loading.value = false;
  }
}

function selectImage(url: string): void {
  activeImage.value = url;
}

async function addToCart(): Promise<void> {
  const sku = currentSku.value;
  if (!sku) {
    ElMessage.warning('请选择商品规格');
    return;
  }
  try {
    await cart.addItem({ skuId: sku.id, quantity: quantity.value });
    ElMessage.success('已加入购物车');
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '加入购物车失败');
  }
}

async function buyNow(): Promise<void> {
  const sku = currentSku.value;
  if (!sku) {
    ElMessage.warning('请选择商品规格');
    return;
  }
  try {
    await cart.addItem({ skuId: sku.id, quantity: quantity.value });
    router.push({ name: 'checkout' });
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '操作失败');
  }
}

onMounted(loadDetail);
</script>

<template>
  <div v-loading="loading" class="detail">
    <div v-if="product" class="detail-body card-pad">
      <div class="gallery">
        <el-image :src="activeImage" fit="cover" class="main-img">
          <template #error>
            <div class="img-fallback">暂无图片</div>
          </template>
        </el-image>
        <div v-if="images.length" class="thumbs">
          <el-image
            v-for="img in images"
            :key="img.id"
            :src="img.url"
            fit="cover"
            class="thumb"
            :class="{ active: img.url === activeImage }"
            @click="selectImage(img.url)"
          >
            <template #error>
              <div class="img-fallback small">-</div>
            </template>
          </el-image>
        </div>
      </div>

      <div class="info">
        <h1 class="name">{{ product.name }}</h1>
        <p v-if="product.subTitle" class="subtitle text-muted">{{ product.subTitle }}</p>

        <div class="price-block">
          <span v-if="currentSku" class="price now">{{ formatYuan(currentSku.price) }}</span>
          <template v-else>
            <span class="price now">{{ formatYuan(product.minPrice) }}</span>
            <span v-if="product.maxPrice > product.minPrice" class="price-range">
              ~ {{ formatYuan(product.maxPrice) }}
            </span>
          </template>
          <span v-if="currentSku && currentSku.originalPrice" class="original text-muted">
            原价 {{ formatYuan(currentSku.originalPrice) }}
          </span>
        </div>

        <div v-if="specs.length" class="specs">
          <div v-for="spec in specs" :key="spec.id" class="spec-row">
            <span class="spec-name">{{ spec.name }}</span>
            <el-radio-group v-model="selectedSpecs[spec.name]">
              <el-radio-button
                v-for="val in specOptions[spec.name]"
                :key="val"
                :value="val"
              >
                {{ val }}
              </el-radio-button>
            </el-radio-group>
          </div>
        </div>

        <div class="qty-row">
          <span class="spec-name">数量</span>
          <el-input-number v-model="quantity" :min="1" :max="99" />
        </div>

        <div class="actions">
          <el-button @click="addToCart">加入购物车</el-button>
          <el-button type="primary" @click="buyNow">立即购买</el-button>
        </div>
      </div>
    </div>

    <div v-if="product" class="detail-content card-pad">
      <h3>商品详情</h3>
      <!-- 后端返回的富文本，仅展示，不进行二次处理 -->
      <div class="rich" v-html="detailHtml"></div>
    </div>

    <div v-if="!loading && !product" class="empty-tip">商品不存在或已下架</div>
  </div>
</template>

<style scoped>
.detail-body {
  display: flex;
  gap: 32px;
}
.gallery {
  width: 360px;
  flex-shrink: 0;
}
.main-img {
  width: 360px;
  height: 360px;
  border-radius: 8px;
  background: #fafafa;
}
.img-fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--text-muted);
}
.img-fallback.small {
  font-size: 12px;
}
.thumbs {
  display: flex;
  gap: 8px;
  margin-top: 8px;
  flex-wrap: wrap;
}
.thumb {
  width: 64px;
  height: 64px;
  border-radius: 6px;
  border: 2px solid transparent;
  cursor: pointer;
  background: #fafafa;
}
.thumb.active {
  border-color: var(--brand);
}
.info {
  flex: 1;
  min-width: 0;
}
.name {
  margin: 0 0 8px;
  font-size: 22px;
}
.subtitle {
  margin: 0 0 16px;
}
.price-block {
  background: #fff7f7;
  border-radius: 8px;
  padding: 16px;
  margin-bottom: 16px;
}
.price.now {
  font-size: 26px;
  margin-right: 8px;
}
.price-range {
  color: var(--brand);
  font-weight: 600;
  margin-right: 8px;
}
.original {
  text-decoration: line-through;
}
.specs {
  margin-bottom: 16px;
}
.spec-row {
  display: flex;
  align-items: center;
  margin-bottom: 12px;
  gap: 12px;
}
.spec-name {
  width: 56px;
  color: var(--text-secondary);
  flex-shrink: 0;
}
.sku-status {
  margin-bottom: 16px;
}
.qty-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 24px;
}
.actions {
  display: flex;
  gap: 16px;
}
.detail-content {
  margin-top: 16px;
}
.rich :deep(img) {
  max-width: 100%;
}
</style>
