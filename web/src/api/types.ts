/**
 * @file web/src/api/types.ts
 * @description 后端统一响应与各领域 DTO 的前端类型映射。
 *
 * 注意序列化约定（与 server/src/core/response.ts 的 jsonReplacer 对应）：
 * - 服务端 bigint（ID、金额「分」）在 JSON 中序列化为 number（超安全范围则为 string），
 *   因此前端统一用 number 表示 ID 与金额；金额单位为「分」。
 * - Date 序列化为 ISO 字符串。
 * - 分类树节点 id 服务端显式转成 string，前端在 category api 中归一化为 number。
 */

/** 统一响应信封（server: ApiResponse<T>） */
export interface ApiResponse<T> {
  code: number;
  message: string;
  data: T | null;
  requestId: string;
  timestamp: number;
}

/** 分页信封（server: PageResult<T>，由 sendPaged 输出） */
export interface PageResult<T> {
  list: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/** 业务 ID（JSON 中的 bigint → number） */
export type ID = number;
/** 金额（单位：分） */
export type Cents = number;

/** 登录 / 注册返回的用户信息 */
export interface AuthUser {
  id: ID;
  phone: string;
  nickname: string;
  role: string;
  status: string;
}

/** 登录 / 注册 / 刷新返回 */
export interface AuthResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: AuthUser;
}

/** 刷新 token 返回（refresh 接口 data 不含 user） */
export interface RefreshResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

/** 用户资料（GET /api/auth/profile） */
export interface ProfileResult extends AuthUser {}

/** 分类树节点（GET /api/categories/tree → { list: CategoryNode[] }） */
export interface CategoryNode {
  id: ID;
  parentId: ID | null;
  name: string;
  level: number;
  path: string;
  sort: number;
  icon: string | null;
  children: CategoryNode[];
}

/** 商品列表项（GET /api/products → PageResult<ProductListItem>） */
export interface ProductListItem {
  id: ID;
  categoryId: ID;
  name: string;
  subTitle: string | null;
  mainImage: string;
  minPrice: Cents;
  maxPrice: Cents;
  totalSales: number;
}

/** 商品详情（GET /api/products/:id） */
export interface ProductSkuItem {
  id: ID;
  specValues: Record<string, string> | unknown;
  price: Cents;
  originalPrice: Cents | null;
  imageUrl: string | null;
}
export interface ProductImageItem {
  id: ID;
  url: string;
  sort: number;
}
export interface ProductSpecItem {
  id: ID;
  name: string;
  values: unknown;
  sort: number;
}
export interface ProductDetail {
  product: {
    id: ID;
    categoryId: ID;
    name: string;
    subTitle: string | null;
    mainImage: string;
    detail: string | null;
    minPrice: Cents;
    maxPrice: Cents;
    totalSales: number;
  };
  images: ProductImageItem[];
  specs: ProductSpecItem[];
  skus: ProductSkuItem[];
}

/** 购物车列表（GET /api/cart → CartListResult） */
export type CartInvalidReason =
  | 'DELETED'
  | 'SKU_DISABLED'
  | 'PRODUCT_OFF_SALE'
  | 'STOCK_NOT_ENOUGH';
export interface CartItemView {
  id: ID;
  skuId: ID;
  quantity: number;
  selected: boolean;
  priceSnapshot: Cents;
  price: Cents;
  skuStatus: string;
  available: number;
  invalid: boolean;
  invalidReason: CartInvalidReason | null;
  priceChanged: boolean;
  /** 商品名称 */
  name: string;
  /** 展示图（SKU 图优先，回退商品主图） */
  image: string;
  /** 规格摘要（如「颜色:陨石黑|版本:8G+128G」） */
  spec: string;
}
export interface CartListResult {
  valid: CartItemView[];
  invalid: CartItemView[];
  totalAmount: Cents;
}

/** 下单（POST /api/orders → CreateOrderResult） */
export interface CreateOrderResult {
  orderNo: string;
  payAmount: Cents;
  expireAt: string;
}

/** 订单状态（与后端 OrderStatus 枚举一一对应，7 个合法值） */
export type OrderStatus =
  | 'PENDING_PAYMENT'
  | 'PAID'
  | 'SHIPPED'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'REFUNDING'
  | 'REFUNDED';

/** 订单列表项中的订单行摘要 */
export interface OrderItemSummary {
  productName: string;
  specDigest: string;
  mainImage: string;
  unitPrice: Cents;
  quantity: number;
}

/** 订单列表项（GET /api/orders → PageResult<OrderSummary>） */
export interface OrderSummary {
  orderNo: string;
  status: OrderStatus;
  payAmount: Cents;
  itemCount: number;
  thumbnail: string | null;
  createdAt: string;
  items: OrderItemSummary[];
}

/** 订单列表查询参数（GET /api/orders） */
export interface OrderListQuery {
  status?: OrderStatus;
  page?: number;
  pageSize?: number;
}

/** 订单详情订单行（GET /api/orders/:orderNo） */
export interface OrderDetailItem {
  skuCode: string;
  productName: string;
  specDigest: string;
  mainImage: string;
  unitPrice: Cents;
  quantity: number;
  payableAmount: Cents;
}

/** 订单详情支付单摘要 */
export interface OrderPaymentSummary {
  payMethod: string | null;
  amount: Cents;
  status: string;
  paidAt: string | null;
}

/** 订单详情退款单摘要 */
export interface OrderRefundSummary {
  status: string;
  amount: Cents;
  type: string;
}

/** 订单详情（GET /api/orders/:orderNo） */
export interface OrderDetail {
  orderNo: string;
  status: OrderStatus;
  payAmount: Cents;
  createdAt: string;
  items: OrderDetailItem[];
  payments: OrderPaymentSummary[];
  refunds: OrderRefundSummary[];
}

/** 发起支付（POST /api/payments → CreatePaymentResult） */
export interface CreatePaymentResult {
  paymentNo: string;
  payUrl: string;
  amount: Cents;
  expireAt: string | null;
}

/** 申请退款（POST /api/refunds → ApplyRefundResult） */
export interface ApplyRefundResult {
  refundNo: string;
  status: string;
}

/** 退款列表项 / 详情（GET /api/refunds、GET /api/refunds/:refundNo） */
export interface RefundItemLine {
  orderItemId: ID;
  quantity: number;
  amount: Cents;
}
export interface RefundRecord {
  refundNo: string;
  orderNo: string;
  type: 'FULL' | 'PARTIAL';
  amount: Cents;
  status: string;
  refundTo: string;
  reasonText: string | null;
  voucherImages: string[] | null;
  createdAt: string;
  items: RefundItemLine[] | null;
}

/** 收货地址（address 接口） */
export interface Address {
  id: ID;
  userId: ID;
  receiverName: string;
  phone: string;
  provinceCode: string;
  provinceName: string;
  cityCode: string;
  cityName: string;
  districtCode: string;
  districtName: string;
  detailAddress: string;
  tag: 'HOME' | 'COMPANY' | 'SCHOOL' | null;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 余额账户（GET /api/balance） */
export interface BalanceAccount {
  accountNo: string;
  balance: Cents;
  status: string;
}

/** 余额流水（GET /api/balance/transactions → PageResult<BalanceTransaction>） */
export interface BalanceTransaction {
  id: ID;
  txNo: string;
  accountType: string;
  amount: Cents;
  direction: 'IN' | 'OUT';
  beforeBalance: Cents;
  afterBalance: Cents;
  bizType: string;
  createdAt: string;
}
