/**
 * @file server/src/validators/order.validator.ts
 * @description 下单入参的 zod 校验 schema（POST /api/orders）
 * @module validators
 * @see docs/04-flows.md F5（363-536 行）、docs/04-flows.md:358（结算二次校验）
 * @see src/validators/cart.validator.ts（同类写法）
 * @author 软件开发团队
 * @created 2026-09-07
 *
 * 校验边界：
 * - `cartItemIds` 数组长度 1 ~ 100：上限与购物车条目上限一致，避免一次请求塞进
 *   几千条把事务 A 拖垮（事务越长，锁持有越久，死锁与超时的概率越高）；
 * - `addressId` / `couponId` 用 `bigintId` 安全转换（拒绝 0 / 负数 / 小数 / 非数字串）；
 * - 设计 §7.3 要求 strict：未知字段直接 400，不放过拼写错误的字段。
 *
 * ⚠️ **绝不接受任何金额字段**（`payAmount` / `freightAmount` 等）：
 * 金额一律由服务端 `PriceService` 重算（F5 阶段 2）。若这里放开金额入参，
 * 就等于把「价格篡改」的口子开在校验层——strict 会直接拒掉，这是有意为之的红线。
 */

import { z } from 'zod';
import { OrderStatus } from '@prisma/client';
import { LIST_RULE } from '@/constants/bizRules';

/** 单次下单的购物车条目数上限（与购物车条目上限一致，保护事务长度） */
const MAX_ORDER_ITEMS = 100;

/** 买家备注最大长度（与 `orders.buyer_remark` 的 VarChar(255) 对齐） */
const MAX_BUYER_REMARK = 255;

/**
 * 把 `string | number` 安全转成 bigint。
 *
 * @description 拒绝 `0`、负数、小数与非数字字符串——这类值要么查不到，
 * 要么（如 `BigInt('') === 0n`）会命中一个存在但错误的 ID，最难排查。
 * 不用 `z.coerce.bigint()`：`BigInt('abc')` 抛 `SyntaxError`，会绕过 zod 的错误收集变成 500。
 * @returns 校验通过返回 bigint，否则追加 zod issue 并中断
 */
const bigintId = z.union([z.string(), z.number()]).transform((value, ctx) => {
  const text = String(value);
  if (!/^[1-9]\d*$/.test(text)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'ID 格式不正确' });
    return z.NEVER;
  }
  return BigInt(text);
});

/**
 * 下单入参：POST /api/orders
 *
 * @description 只收「选了什么、送到哪、用什么券」，**不收任何金额**。
 */
export const createOrderSchema = z
  .object({
    /** 收货地址 ID（必须属于当前用户，由 service 层带 userId 校验） */
    addressId: bigintId,
    /** 参与结算的购物车条目 ID（必须是已勾选的） */
    cartItemIds: z
      .array(bigintId)
      .min(1, '请选择要结算的商品')
      .max(MAX_ORDER_ITEMS, `单次最多结算 ${MAX_ORDER_ITEMS} 个条目`),
    /** 买家备注（可空） */
    buyerRemark: z
      .string()
      .trim()
      .max(MAX_BUYER_REMARK, `买家备注不可超过 ${MAX_BUYER_REMARK} 字`)
      .nullish(),
    /**
     * 优惠券 ID（可空）。T041 已启用：传入时在 `OrderService` 事务外解析券优惠
     * （状态/过期/门槛/适用范围），事务 A 内占用（UNUSED→LOCKED）并与建单同事务。
     */
    couponId: bigintId.nullish(),
  })
  .strict();

/** 下单入参类型 */
export type CreateOrderInput = z.infer<typeof createOrderSchema>;

/**
 * 取消订单路由参数：POST /api/orders/:orderNo/cancel
 *
 * @description 订单号是字符串业务号（如 `NO...`），不做 bigint 转换。
 */
export const orderNoParamSchema = z
  .object({
    /** 订单号 */
    orderNo: z.string().min(1, '订单号不能为空'),
  })
  .strict();

/** 取消订单路由参数类型 */
export type OrderNoParam = z.infer<typeof orderNoParamSchema>;

/**
 * 取消订单入参（body）：POST /api/orders/:orderNo/cancel
 *
 * @description 仅收可选取消原因；严格 unknown 字段 400（§7.3）。
 */
export const cancelOrderSchema = z
  .object({
    /** 取消原因（可空，用于轨迹与售后复盘） */
    reason: z
      .string()
      .trim()
      .max(255, '取消原因不可超过 255 字')
      .nullish(),
  })
  .strict();

/** 取消订单入参类型 */
export type CancelOrderInput = z.infer<typeof cancelOrderSchema>;

/**
 * 发货入参（body）：POST /admin/orders/:orderNo/ship（F10 ①）
 *
 * @description 物流公司编码/名称/运单号为必填；管理员备注可空。
 * 严格 unknown 字段 400（§7.3）。
 */
export const shipOrderSchema = z
  .object({
    /** 物流公司编码（如 SF / YTO，对应 `logistics_company_code` VarChar(32)） */
    companyCode: z
      .string()
      .trim()
      .min(1, '物流公司编码不能为空')
      .max(32, '物流公司编码不可超过 32 字'),
    /** 物流公司名称（对应 `logistics_company_name` VarChar(64)） */
    companyName: z
      .string()
      .trim()
      .min(1, '物流公司名称不能为空')
      .max(64, '物流公司名称不可超过 64 字'),
    /** 运单号（对应 `logistics_no` VarChar(64)） */
    trackingNo: z
      .string()
      .trim()
      .min(1, '运单号不能为空')
      .max(64, '运单号不可超过 64 字'),
    /** 管理员发货备注（可空，对应 `admin_remark` VarChar(255)） */
    remark: z
      .string()
      .trim()
      .max(255, '发货备注不可超过 255 字')
      .nullish(),
  })
  .strict();

/** 发货入参类型 */
export type ShipOrderBody = z.infer<typeof shipOrderSchema>;

/**
 * query 入参归一化：字符串去空格，空串 → `undefined`（等价于「未传」）。
 *
 * @description 与 `product.validator.ts` 同语义：前端拼串时偶发带出空值（如 `?status=`），
 * 不应被当成「非法枚举」打回，而应等价于「不按状态过滤」
 * @param value 原始入参
 * @returns 归一化后的值
 */
function normalizeText(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * 构造分页类正整数参数（page / pageSize）。
 *
 * @description 非法值统一由 zod 产出 400；合法缺省时回退默认分页（与列表读接口的严格策略一致）
 * @param label 中文名，用于错误文案
 * @param max 允许的最大值
 * @param defaultValue 未传时使用的值
 * @returns zod schema（输出 number）
 */
function positiveInt(label: string, max: number, defaultValue: number) {
  return z.preprocess(
    normalizeText,
    z.coerce
      .number()
      .int(`${label}必须是整数`)
      .min(1, `${label}必须大于 0`)
      .max(max, `${label}不可超过 ${max}`)
      .default(defaultValue),
  );
}

/**
 * 订单列表查询（query）：GET /api/orders
 *
 * @description `page` / `pageSize` 必须进 schema（严格未知字段 400），
 * 这样 `validate` 先于 `pagination()` 跑时，`pagination()` 才能读到转换后的 number。
 * `status` 可选，传了则按合法 `OrderStatus` 枚举过滤（非法枚举直接 400）。
 * @see src/routes/api/product.routes.ts（同款中间件顺序与严格策略）
 */
export const orderListQuerySchema = z
  .object({
    page: positiveInt('页码', 1_000_000, LIST_RULE.DEFAULT_PAGE),
    pageSize: positiveInt('每页条数', LIST_RULE.MAX_PAGE_SIZE, LIST_RULE.DEFAULT_PAGE_SIZE),
    /** 订单状态过滤：空串等价于不传；非法枚举 400 */
    status: z.preprocess(normalizeText, z.nativeEnum(OrderStatus).optional()),
  })
  .strict();

/** 订单列表查询类型（校验并回写后的形态） */
export type OrderListQuery = z.infer<typeof orderListQuerySchema>;
