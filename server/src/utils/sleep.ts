/**
 * @file server/src/utils/sleep.ts
 * @description 延时与超时工具：重试退避、并发节流、超时竞速
 * @module utils
 * @author 软件开发团队
 * @created 2026-09-03
 */

/**
 * 延时指定毫秒。
 *
 * @description 用于重试退避与削峰；**禁止**在事务内调用（会延长行锁持有时间）
 * @param ms 延时毫秒数
 * @returns Promise，延时结束后 resolve
 */
export function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 带抖动的指数退避延时。
 *
 * 为什么要加抖动：多个并发请求因同一原因失败后，若按固定间隔重试会**同时**再次冲击数据库，
 * 形成「重试风暴」。加随机量把重试时刻打散，第二轮成功率显著提升。
 *
 * @param attempt 当前重试序号（从 0 开始）
 * @param baseMs 基础延时（毫秒），默认 50
 * @param maxMs 延时上限（毫秒），默认 2000
 * @returns Promise，延时结束后 resolve
 */
export async function backoff(attempt: number, baseMs = 50, maxMs = 2_000): Promise<void> {
  const exponential = baseMs * 2 ** attempt;
  const capped = Math.min(exponential, maxMs);
  // 抖动范围取 capped 的一半，既打散重试时刻又不至于让延时失控
  const jitter = Math.floor(Math.random() * (capped / 2));
  await sleep(capped / 2 + jitter);
}

/**
 * 为 Promise 套上超时。
 *
 * @description 用于隔离不可控的外部调用（第三方适配器）。
 * 注意：**超时只中断等待，不会取消已经发出去的请求**，
 * 因此支付类接口必须用幂等号保证「超时重试」不会重复扣款
 * @param promise 原始 Promise
 * @param timeoutMs 超时毫秒数
 * @param message 超时错误信息
 * @returns 在超时前完成则返回原结果
 * @throws {Error} 超时时抛出
 */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message = '操作超时'): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${message}（超时 ${timeoutMs}ms）`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }) as Promise<T>;
}
