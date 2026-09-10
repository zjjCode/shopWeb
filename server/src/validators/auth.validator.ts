/**
 * @file server/src/validators/auth.validator.ts
 * @description 认证相关入参的 zod 校验 schema（注册 / 登录）
 * @module validators
 * @see docs/07（开发规范：参数校验用 zod）、src/middlewares/validate.ts
 * @author 软件开发团队
 * @created 2026-09-05
 *
 * 校验边界：
 * - 手机号：中国大陆手机号正则（1[3-9] 开头 + 11 位）。
 * - 密码：长度 8~64，常量取自 `@/utils/hash` 的 `PASSWORD_MIN_LENGTH` / `PASSWORD_MAX_LENGTH`。
 * - 仅做长度校验（与规格一致）；复杂度要求由业务层 `isPasswordStrong` 另行把关。
 */

import { z } from 'zod';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@/utils/hash';

/** 中国大陆手机号正则 */
const CN_MOBILE_PATTERN = /^1[3-9]\d{9}$/;

/** 注册入参 schema */
export const registerSchema = z.object({
  phone: z.string().regex(CN_MOBILE_PATTERN, '手机号格式不正确'),
  password: z.string().min(PASSWORD_MIN_LENGTH, `密码长度需至少 ${PASSWORD_MIN_LENGTH} 位`).max(PASSWORD_MAX_LENGTH, `密码长度不可超过 ${PASSWORD_MAX_LENGTH} 位`),
  nickname: z.string().min(1, '昵称不可为空').max(64, '昵称长度不可超过 64 位'),
});

/** 登录入参 schema */
export const loginSchema = z.object({
  phone: z.string().regex(CN_MOBILE_PATTERN, '手机号格式不正确'),
  password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
});

/** 注册入参类型 */
export type RegisterInputDTO = z.infer<typeof registerSchema>;
/** 登录入参类型 */
export type LoginInputDTO = z.infer<typeof loginSchema>;
