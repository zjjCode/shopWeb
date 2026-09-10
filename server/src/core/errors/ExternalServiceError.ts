/**
 * @file server/src/core/errors/ExternalServiceError.ts
 * @description 第三方服务异常（HTTP 502 / 501 / 504）：支付、物流、短信、客服适配器失败
 * @module core/errors
 * @see docs/02-architecture.md §5.2、§6.1（统一接口契约）
 * @author 软件开发团队
 * @created 2026-09-03
 */

import { AppError, type AppErrorOptions } from './AppError';
import { ErrorCode } from './errorCodes';

/** 适配器类型（§6.1） */
export type AdapterType = 'payment' | 'logistics' | 'support' | 'sms';

/** ExternalServiceError 的构造参数 */
export interface ExternalServiceErrorOptions extends AppErrorOptions {
  code?: number;
}

/**
 * 第三方服务调用失败。
 *
 * 设计要点：
 * 1. 携带 `adapter` 与 `provider`，便于按渠道聚合告警（如「支付宝连续失败」）；
 * 2. `isOperational` 默认 true —— 第三方抖动属于外部环境问题，不应触发代码缺陷告警，
 *    但**是否降级由调用方决定**（例如物流查询失败只影响轨迹展示，不阻断下单）；
 * 3. 适配器内部**不抛裸异常**，网络异常由 Service 捕获后包装为本类（§6.1 失败语义）。
 */
export class ExternalServiceError extends AppError {
  /** 适配器类型 */
  readonly adapter: AdapterType | string;
  /** 渠道标识：mock / alipay / wechat / kuaidi100 ... */
  readonly provider: string;

  /**
   * @param message 提示文案
   * @param adapter 适配器类型
   * @param provider 渠道标识
   * @param options 错误码（默认 80001 支付渠道调用失败）
   */
  constructor(
    message: string,
    adapter: AdapterType | string,
    provider: string,
    options: ExternalServiceErrorOptions = {},
  ) {
    super(message, {
      code: options.code ?? ErrorCode.PAYMENT_CHANNEL_FAILED,
      httpStatus: options.httpStatus ?? 502,
      isOperational: options.isOperational ?? true,
      data: options.data ?? null,
      cause: options.cause,
    });
    this.adapter = adapter;
    this.provider = provider;
  }
}
