/**
 * @file server/src/validators/payPassword.validator.ts
 * @description 支付密码入参的 zod 校验 schema（首次设置 / 修改）
 * @module validators
 * @see docs/12-phase12-plan.md（T070 支付密码接线）、server/src/services/PayPasswordService.ts
 * @author 软件开发团队
 * @created 2026-09-20
 *
 * 校验边界：
 * - 复用 `utils/hash.ts` 的 `isPasswordStrong` 做强度校验（8~64 位且同时包含字母和数字），
 *   与登录密码同一套强度规则，避免两套标准分裂。
 * - `modify` 必须带 `oldPayPassword`（原密码），由服务层校验原密码正确后才允许改；
 *   `set` 不接收旧密码（首次设置时本就没有）。
 */

import { z } from 'zod';
import { isPasswordStrong } from '@/utils/hash';

/** 支付密码字段：必填 + 强度校验 */
const payPasswordField = z
  .string({ required_error: '请输入支付密码' })
  .min(1, '请输入支付密码')
  .max(64, '支付密码长度不能超过 64 位')
  .refine(isPasswordStrong, '支付密码需为 8~64 位且同时包含字母和数字');

/**
 * 首次设置支付密码入参：POST /api/user/pay-password
 */
export const setPayPasswordSchema = z
  .object({
    /** 新支付密码（明文，强度需满足 isPasswordStrong） */
    payPassword: payPasswordField,
  })
  .strict();

/**
 * 修改支付密码入参：PUT /api/user/pay-password
 */
export const modifyPayPasswordSchema = z
  .object({
    /** 原支付密码（用于校验身份，防越权改密） */
    oldPayPassword: z.string({ required_error: '请输入原支付密码' }).min(1, '请输入原支付密码'),
    /** 新支付密码（明文，强度需满足 isPasswordStrong） */
    payPassword: payPasswordField,
  })
  .strict();

/** 首次设置入参类型 */
export type SetPayPasswordInput = z.infer<typeof setPayPasswordSchema>;
/** 修改入参类型 */
export type ModifyPayPasswordInput = z.infer<typeof modifyPayPasswordSchema>;
