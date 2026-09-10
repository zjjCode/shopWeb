/**
 * @file server/src/middlewares/balancePassword.ts
 * @description 支付密码校验：余额支付 / 余额提现前的二次确认，含连续失败锁定
 * @module middlewares
 * @see docs/03-database.md §3.11（余额 / 充值域）、错误码 61007 / 61008 / 61009
 * @author 软件开发团队
 * @created 2026-09-03
 *
 * 为什么锁定计数放 Redis 而不是数据库：
 * 计数是「高频、可丢失、有时效」的数据。写库既给主库添压力，
 * 又需要额外的定时任务清理过期计数；而 Redis 的 `SETEX` 天然带过期，
 * 即使 Redis 重启导致计数清零，最坏结果也只是「锁定被提前解除」，安全方向上是可接受的降级。
 */

import type { RequestHandler } from 'express';
import { REDIS_KEY } from '@/config/constants';
import { SECURITY_RULE } from '@/constants/bizRules';
import { BusinessError, AuthError } from '@/core/errors';
import { ErrorCode } from '@/core/errors/errorCodes';
import { withRedis } from '@/core/redis';

/** 支付密码校验器：由服务层注册，中间件不直接查库（分层铁律） */
export type PayPasswordVerifier = (userId: number, payPassword: string) => Promise<boolean>;

/** 支付密码状态查询器：判断用户是否已设置支付密码 */
export type PayPasswordStatusChecker = (userId: number) => Promise<boolean>;

/** 已注册的校验器 / 状态查询器 */
let passwordVerifier: PayPasswordVerifier | null = null;
let statusChecker: PayPasswordStatusChecker | null = null;

/**
 * 注册支付密码校验器。
 *
 * @param verifier 校验器实现（应使用 `utils/hash.ts` 的 comparePassword）
 * @param checker 状态查询器实现
 */
export function setPayPasswordHandlers(verifier: PayPasswordVerifier, checker: PayPasswordStatusChecker): void {
  passwordVerifier = verifier;
  statusChecker = checker;
}

/**
 * 构造连续失败计数的 Redis Key。
 *
 * @param userId 用户 ID
 * @returns 缓存 Key
 */
function failCountKey(userId: number): string {
  return `${REDIS_KEY.PREFIX}:paypwd:fails:${userId}`;
}

/** 锁定窗口时长（秒） */
const LOCK_WINDOW_SECONDS = SECURITY_RULE.PAY_PASSWORD_LOCK_MINUTES * 60;

/**
 * 支付密码校验中间件。
 *
 * @description 校验顺序：锁定检查 → 是否已设置 → 密码比对。
 * 失败计数在密码**正确**时清零，避免用户输错几次成功后下次直接被锁
 * @param fieldName 请求体中支付密码的字段名，默认 `payPassword`
 * @returns Express 中间件
 */
export function requireBalancePassword(fieldName = 'payPassword'): RequestHandler {
  return (req, _res, next) => {
    void (async () => {
      try {
        const principal = req.auth;
        if (principal === undefined) {
          next(AuthError.unauthorized('请先登录', ErrorCode.ACCESS_TOKEN_EXPIRED));
          return;
        }

        if (passwordVerifier === null || statusChecker === null) {
          next(
            new BusinessError('支付密码校验器未注册，无法完成校验', {
              code: ErrorCode.SYSTEM_INTERNAL,
            }),
          );
          return;
        }

        const userId = principal.userId;
        const failKey = failCountKey(userId);

        // 1) 先查锁定：已被锁时不再校验密码，避免给攻击者「边试边看错误码」的机会
        const fails = await withRedis((redis) => redis.get(failKey), null);
        if (fails !== null && Number(fails) >= SECURITY_RULE.PAY_PASSWORD_MAX_FAILS) {
          next(
            new BusinessError('支付密码错误次数过多，账户已临时锁定', {
              code: ErrorCode.PAY_PASSWORD_LOCKED,
            }),
          );
          return;
        }

        // 2) 是否已设置支付密码
        const hasPassword = await statusChecker(userId);
        if (!hasPassword) {
          next(new BusinessError('未设置支付密码，请先设置', { code: ErrorCode.PAY_PASSWORD_NOT_SET }));
          return;
        }

        // 3) 比对密码
        const body = req.body as Record<string, unknown>;
        const supplied = body[fieldName];
        if (typeof supplied !== 'string' || supplied.length === 0) {
          next(new BusinessError('请输入支付密码', { code: ErrorCode.PAY_PASSWORD_NOT_SET }));
          return;
        }

        const matched = await passwordVerifier(userId, supplied);
        if (!matched) {
          // incr + 首次设置过期：两步必须都做，只有 incr 会让计数永久累积（用户永远解不开）
          await withRedis(async (redis) => {
            const count = await redis.incr(failKey);
            if (count === 1) {
              await redis.expire(failKey, LOCK_WINDOW_SECONDS);
            }
            return count;
          }, null);

          // 不提示剩余次数：提示「还可尝试 2 次」会帮助攻击者评估继续爆破的价值
          next(new BusinessError('支付密码错误', { code: ErrorCode.PAY_PASSWORD_INCORRECT }));
          return;
        }

        await withRedis((redis) => redis.del(failKey), null);
        next();
      } catch (error) {
        next(error);
      }
    })();
  };
}

/**
 * 清除用户的支付密码失败计数。
 *
 * @description 管理员重置密码、用户通过短信验证身份后调用，用于提前解除锁定
 * @param userId 用户 ID
 * @returns Promise，删除完成后 resolve
 */
export async function clearPayPasswordFails(userId: number): Promise<void> {
  await withRedis((redis) => redis.del(failCountKey(userId)), null);
}
