/**
 * @file server/src/validators/address.validator.ts
 * @description 收货地址入参的 zod 校验 schema（新增 / 修改 / 删除 / 设为默认）
 * @module validators
 * @see docs/04-flows.md（F5 下单流程：T011 收货地址是下单必要前置）、prisma/schema.prisma（Address 模型）
 * @see src/validators/cart.validator.ts（同类写法：bigintId 安全转换）
 * @author 软件开发团队
 * @created 2026-09-07
 *
 * 校验边界（与 Address 模型字段一一对应）：
 * - 姓名 `receiverName` 1~64；手机 `phone` 中国大陆 11 位（1[3-9]\d{9}）；
 * - 省/市/区 code 与 name 均必填（下单时需完整行政区划，缺一项无法发货）；
 * - 详细地址 `detailAddress` 5~100 字（沿用错误码 `ADDRESS_DETAIL_LENGTH` 的登记文案）；
 * - `tag` 只能是 HOME / COMPANY / SCHOOL 或 null（清空标签）；
 * - `isDefault` 布尔；修改时所有字段可选但**不能全都不传**（refine 兜住）。
 *
 * ⚠️ ID 转换沿用 `cart.validator.ts` 的 `bigintId`：不用 `z.coerce.bigint()`，
 * `BigInt('abc')` 抛 `SyntaxError` 会绕过 zod 错误收集变成 500。
 */

import { z } from 'zod';

/** 手机号：中国大陆 11 位 */
const PHONE_RE = /^1[3-9]\d{9}$/;
/** 详细地址长度上下限（与 ADDRESS_DETAIL_LENGTH 文案一致） */
const DETAIL_MIN = 5;
const DETAIL_MAX = 100;

/**
 * 把 `string | number` 安全转成 bigint（拒绝 0 / 负数 / 小数 / 非数字串）。
 *
 * @see src/validators/cart.validator.ts:37
 */
const bigintId = z.union([z.string(), z.number()]).transform((value, ctx) => {
  const text = String(value);
  if (!/^[1-9]\d*$/.test(text)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'ID 格式不正确' });
    return z.NEVER;
  }
  return BigInt(text);
});

/** 标签枚举（与 Address 模型注释一致） */
const addressTag = z.enum(['HOME', 'COMPANY', 'SCHOOL']).nullable().optional();

/** 地址字段公共约束（新增时全必填） */
const baseFields = {
  receiverName: z.string().min(1, '收货人姓名不可为空').max(64, '收货人姓名最长 64 字'),
  phone: z.string().regex(PHONE_RE, '手机号格式不正确'),
  provinceCode: z.string().min(1, '省份编码不可为空').max(20),
  provinceName: z.string().min(1, '省份名称不可为空').max(64),
  cityCode: z.string().min(1, '城市编码不可为空').max(20),
  cityName: z.string().min(1, '城市名称不可为空').max(64),
  districtCode: z.string().min(1, '区/县编码不可为空').max(20),
  districtName: z.string().min(1, '区/县名称不可为空').max(64),
  detailAddress: z
    .string()
    .min(DETAIL_MIN, `详细地址需 ${DETAIL_MIN}-${DETAIL_MAX} 字`)
    .max(DETAIL_MAX, `详细地址需 ${DETAIL_MIN}-${DETAIL_MAX} 字`),
  tag: addressTag,
  isDefault: z.boolean().optional(),
};

/** 新增入参：POST /api/addresses */
export const createAddressSchema = z.object(baseFields).strict();

/** 修改入参：PATCH /api/addresses/:id（全字段可选，但至少一个） */
export const updateAddressSchema = z
  .object({
    receiverName: baseFields.receiverName.optional(),
    phone: baseFields.phone.optional(),
    provinceCode: baseFields.provinceCode.optional(),
    provinceName: baseFields.provinceName.optional(),
    cityCode: baseFields.cityCode.optional(),
    cityName: baseFields.cityName.optional(),
    districtCode: baseFields.districtCode.optional(),
    districtName: baseFields.districtName.optional(),
    detailAddress: baseFields.detailAddress.optional(),
    tag: addressTag,
    isDefault: z.boolean().optional(),
  })
  .strict()
  .refine(
    (data) =>
      Object.keys(data).length > 0,
    { message: '至少需传一个要修改的字段' },
  );

/** 路径参数：地址 ID（列表/修改/删除/设为默认共用） */
export const addressIdParamSchema = z.object({ id: bigintId });

/** 新增入参类型 */
export type CreateAddressInput = z.infer<typeof createAddressSchema>;
/** 修改入参类型 */
export type UpdateAddressInput = z.infer<typeof updateAddressSchema>;
/** 地址 ID 路径参数类型 */
export type AddressIdParam = z.infer<typeof addressIdParamSchema>;
