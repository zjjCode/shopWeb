/**
 * @file web/src/stores/order.ts
 * @description 会话级订单 store。
 *
 * 当前 C 端未提供「订单列表 / 详情」GET 端点，故前端用 session 内存记录
 * 本次会话创建的订单，支撑「我的订单」展示与退款/支付回跳。刷新页面后清空属预期。
 */
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { orderApi } from '@/api/order';
import type { Cents, ID, OrderListQuery, OrderStatus, OrderSummary } from '@/api/types';

export interface SessionOrderItem {
  skuId: ID;
  name: string;
  image: string | null;
  price: Cents;
  quantity: number;
}

export interface SessionOrder {
  orderNo: string;
  payAmount: Cents;
  expireAt: string;
  status: OrderStatus;
  createdAt: string;
  items: SessionOrderItem[];
  paymentNo?: string;
}

export const useOrderStore = defineStore('order', () => {
  const orders = ref<SessionOrder[]>([]);

  function addOrder(order: SessionOrder): void {
    const idx = orders.value.findIndex((o) => o.orderNo === order.orderNo);
    if (idx >= 0) orders.value[idx] = order;
    else orders.value.unshift(order);
  }

  function getOrder(orderNo: string): SessionOrder | undefined {
    return orders.value.find((o) => o.orderNo === orderNo);
  }

  function setStatus(orderNo: string, status: OrderStatus): void {
    const order = getOrder(orderNo);
    if (order) order.status = status;
  }

  function setPaymentNo(orderNo: string, paymentNo: string): void {
    const order = getOrder(orderNo);
    if (order) order.paymentNo = paymentNo;
  }

  /** 从后端拉取当前用户的订单列表（真实数据源），覆盖本地列表 */
  async function fetchOrders(query: OrderListQuery = {}): Promise<void> {
    const page = await orderApi.list(query);
    orders.value = page.list.map(toSessionOrder);
  }

  /** 后端 OrderSummary → 本地 SessionOrder（字段对齐：mainImage→image 等） */
  function toSessionOrder(s: OrderSummary): SessionOrder {
    return {
      orderNo: s.orderNo,
      payAmount: s.payAmount,
      expireAt: '',
      status: s.status,
      createdAt: s.createdAt,
      items: s.items.map((it) => ({
        skuId: 0,
        name: it.productName,
        image: it.mainImage,
        price: it.unitPrice,
        quantity: it.quantity,
      })),
      paymentNo: undefined,
    };
  }

  return { orders, addOrder, getOrder, setStatus, setPaymentNo, fetchOrders };
});
