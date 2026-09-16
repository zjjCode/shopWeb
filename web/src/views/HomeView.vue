<script setup lang="ts">
/**
 * @file web/src/views/HomeView.vue
 * @description 商城首页：左侧三级分类、顶部搜索与排序、商品网格分页。
 */
import { onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { categoryApi } from '@/api/category';
import { productApi } from '@/api/product';
import type { CategoryNode, ProductListItem } from '@/api/types';
import { formatYuan } from '@/utils/money';

const router = useRouter();

interface ProductQuery {
  page: number;
  pageSize: number;
  categoryId: number | null;
  keyword: string;
  sortField: 'createdAt' | 'price' | 'sales' | 'sort' | null;
  sortOrder: 'asc' | 'desc' | null;
}

const query = reactive<ProductQuery>({
  page: 1,
  pageSize: 12,
  categoryId: null,
  keyword: '',
  sortField: null,
  sortOrder: null,
});

const sortOption = ref<'default' | 'price-asc' | 'price-desc' | 'sales-desc'>('default');

const categories = ref<CategoryNode[]>([]);
const products = ref<ProductListItem[]>([]);
const total = ref(0);
const loading = ref(false);

async function loadCategories(): Promise<void> {
  try {
    categories.value = await categoryApi.tree();
  } catch {
    categories.value = [];
  }
}

async function loadProducts(): Promise<void> {
  loading.value = true;
  try {
    const res = await productApi.list({
      page: query.page,
      pageSize: query.pageSize,
      categoryId: query.categoryId,
      keyword: query.keyword || null,
      sortField: query.sortField,
      sortOrder: query.sortOrder,
    });
    products.value = res.list;
    total.value = res.total;
  } finally {
    loading.value = false;
  }
}

function selectCategory(id: number): void {
  query.categoryId = id;
  query.page = 1;
  loadProducts();
}

function resetCategory(): void {
  query.categoryId = null;
  query.page = 1;
  loadProducts();
}

function onSearch(): void {
  query.page = 1;
  loadProducts();
}

function onSortChange(): void {
  switch (sortOption.value) {
    case 'price-asc':
      query.sortField = 'price';
      query.sortOrder = 'asc';
      break;
    case 'price-desc':
      query.sortField = 'price';
      query.sortOrder = 'desc';
      break;
    case 'sales-desc':
      query.sortField = 'sales';
      query.sortOrder = 'desc';
      break;
    default:
      query.sortField = null;
      query.sortOrder = null;
  }
  query.page = 1;
  loadProducts();
}

function onPageChange(page: number): void {
  query.page = page;
  loadProducts();
}

function goProduct(id: number): void {
  router.push({ name: 'product', params: { id } });
}

onMounted(() => {
  loadCategories();
  loadProducts();
});
</script>

<template>
  <div class="home">
    <div class="home-body">
      <aside class="cats card-pad">
        <div class="cat-title">全部分类</div>
        <div class="cat-all" :class="{ active: query.categoryId === null }" @click="resetCategory">全部商品</div>
        <ul class="cat-l1">
          <li v-for="c1 in categories" :key="c1.id">
            <div class="cat-link" :class="{ active: query.categoryId === c1.id }" @click="selectCategory(c1.id)">
              {{ c1.name }}
            </div>
            <ul v-if="c1.children.length" class="cat-l2">
              <li v-for="c2 in c1.children" :key="c2.id">
                <div class="cat-link" :class="{ active: query.categoryId === c2.id }" @click="selectCategory(c2.id)">
                  {{ c2.name }}
                </div>
                <ul v-if="c2.children.length" class="cat-l3">
                  <li v-for="c3 in c2.children" :key="c3.id">
                    <span class="cat-link" :class="{ active: query.categoryId === c3.id }" @click="selectCategory(c3.id)">
                      {{ c3.name }}
                    </span>
                  </li>
                </ul>
              </li>
            </ul>
          </li>
        </ul>
      </aside>

      <section class="content">
        <div class="toolbar card-pad">
          <el-input
            v-model="query.keyword"
            placeholder="搜索商品"
            clearable
            class="search-input"
            @keyup.enter="onSearch"
          >
            <template #append>
              <el-button @click="onSearch">搜索</el-button>
            </template>
          </el-input>
          <el-select v-model="sortOption" class="sort-select" @change="onSortChange">
            <el-option label="综合" value="default" />
            <el-option label="价格升序" value="price-asc" />
            <el-option label="价格降序" value="price-desc" />
            <el-option label="销量优先" value="sales-desc" />
          </el-select>
        </div>

        <div v-loading="loading" class="product-area">
          <div v-if="products.length" class="product-grid">
            <div v-for="p in products" :key="p.id" class="product-card" @click="goProduct(p.id)">
              <el-image :src="p.mainImage" fit="cover" class="product-img">
                <template #error>
                  <div class="img-fallback">暂无图片</div>
                </template>
              </el-image>
              <div class="product-name" :title="p.name">{{ p.name }}</div>
              <div class="product-price price">
                {{ formatYuan(p.minPrice) }}
                <span v-if="p.maxPrice > p.minPrice"> ~ {{ formatYuan(p.maxPrice) }}</span>
              </div>
              <div class="product-sales text-muted">已售 {{ p.totalSales }}</div>
            </div>
          </div>
          <div v-else class="empty-tip">暂无商品</div>

          <el-pagination
            class="pager"
            :current-page="query.page"
            :page-size="query.pageSize"
            :total="total"
            layout="total, prev, pager, next"
            @current-change="onPageChange"
          />
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.home-body {
  display: flex;
  gap: 16px;
  align-items: flex-start;
}
.cats {
  width: 220px;
  flex-shrink: 0;
  max-height: 70vh;
  overflow: auto;
}
.cat-title {
  font-weight: 600;
  margin-bottom: 8px;
}
.cat-all {
  cursor: pointer;
  padding: 6px 8px;
  border-radius: 4px;
  color: var(--text-secondary);
  margin-bottom: 8px;
}
.cat-link {
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 4px;
  color: var(--text-secondary);
}
.cat-link:hover {
  color: var(--brand);
}
.cat-link.active {
  color: #fff;
  background: var(--brand);
}
.cat-l1 > li {
  margin-bottom: 6px;
}
.cat-l2 {
  margin: 2px 0 2px 12px;
}
.cat-l3 {
  margin: 2px 0 2px 12px;
}
.content {
  flex: 1;
  min-width: 0;
}
.toolbar {
  display: flex;
  gap: 12px;
  margin-bottom: 16px;
}
.search-input {
  width: 320px;
}
.sort-select {
  width: 140px;
}
.product-area {
  min-height: 300px;
}
.product-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 16px;
}
.product-card {
  background: #fff;
  border-radius: 8px;
  padding: 12px;
  cursor: pointer;
  transition: box-shadow 0.2s;
}
.product-card:hover {
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08);
}
.product-img {
  width: 100%;
  height: 160px;
  border-radius: 6px;
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
.product-name {
  margin: 8px 0 4px;
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.product-price {
  font-size: 16px;
}
.product-sales {
  font-size: 12px;
  margin-top: 4px;
}
.pager {
  justify-content: center;
  margin-top: 20px;
}
</style>
