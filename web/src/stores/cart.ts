/**
 * @file web/src/stores/cart.ts
 * @description 购物车 store（列表、加购、改数量/勾选、删除、合计）。
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { cartApi, type AddCartItemPayload, type UpdateCartItemPayload } from '@/api/cart';
import type { CartItemView, Cents, ID } from '@/api/types';

export const useCartStore = defineStore('cart', () => {
  const validItems = ref<CartItemView[]>([]);
  const invalidItems = ref<CartItemView[]>([]);
  const totalAmount = ref<Cents>(0);
  const loading = ref(false);

  const selectedTotal = computed<Cents>(() =>
    validItems.value.filter((i) => i.selected && !i.invalid).reduce((sum, i) => sum + i.price * i.quantity, 0),
  );
  const selectedCount = computed<number>(() =>
    validItems.value.filter((i) => i.selected && !i.invalid).reduce((sum, i) => sum + i.quantity, 0),
  );
  const cartBadge = computed<number>(() =>
    validItems.value.filter((i) => !i.invalid).reduce((sum, i) => sum + i.quantity, 0),
  );

  async function fetchCart(): Promise<void> {
    loading.value = true;
    try {
      const result = await cartApi.list();
      validItems.value = result.valid;
      invalidItems.value = result.invalid;
      totalAmount.value = result.totalAmount;
    } finally {
      loading.value = false;
    }
  }

  async function addItem(payload: AddCartItemPayload): Promise<void> {
    await cartApi.addItem(payload);
    await fetchCart();
  }

  async function updateItem(id: ID, payload: UpdateCartItemPayload): Promise<void> {
    await cartApi.updateItem(id, payload);
    await fetchCart();
  }

  async function removeItems(ids: ID[]): Promise<void> {
    if (ids.length === 0) return;
    await cartApi.removeItems(ids);
    await fetchCart();
  }

  function clear(): void {
    validItems.value = [];
    invalidItems.value = [];
    totalAmount.value = 0;
  }

  return {
    validItems,
    invalidItems,
    totalAmount,
    loading,
    selectedTotal,
    selectedCount,
    cartBadge,
    fetchCart,
    addItem,
    updateItem,
    removeItems,
    clear,
  };
});
