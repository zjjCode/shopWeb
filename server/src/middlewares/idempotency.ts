/**
 * @file server/src/middlewares/idempotency.ts
 * @description 幂等中间件：Idempotency-Key 抢占 + 请求指纹校验 + 首次结果回放
 * @module middlewares
 * @see docs/02-architecture.md §5.10（幂等设计）
 * @author 软件开发团队
 * @created 2026-09-03
 *
 * 四种命中语义（必须严格区分，否则会出资金事故）：
 * 1. 无记录      → 抢占 PROCESSING 并执行；
 * 2. PROCESSING  → 返回 409 + 90005「请求正在处理中」（**不能**回放，结果尚不存在）；
 * 3. SUCCESS     → 回放首次响应（**必须**先比对指纹，防止同一幂等号被复用在不同请求上）；
 * 4. FAILED      → 允许重新执行（首次失败的业务应当可重试）。
 *
 * 为什么必须比对指纹：
 * 客户端（或重放攻击）复用同一个幂等号提交**不同**的订单金额，
 * 若直接回放首次结果，用户会拿到「第一次下单成功」的响应，却以为第二次也成功了。
 * 指纹不一致必须报 90006 而不是静默回放。
 */

import type { RequestHandler } from 'express';
import { HEADER, IDEMPOTENT_SCOPE } from '@/config/constants';
import { IdempotencyStatus } from '@/constants/enums';
import { AppError, ValidationError } from '@/core/errors';
import { ErrorCode } from '@/core/errors/errorCodes';
import { logInfo, logWarn } from '@/core/logger/logger';
import { sendOk } from '@/core/response';
import { buildRequestFingerprint, isFingerprintMatched } from '@/utils/fingerprint';

/** 幂等记录 */
export interface IdempotencyRecord {
  /** 记录状态 */
  status: IdempotencyStatus;
  /** 首次请求的指纹 */
  fingerprint: string | null;
  /** 首次成功响应的完整信封（用于回放） */
  response: unknown;
}

/**
 * 幂等存储接口。
 *
 * 由 `repositories/idempotencyRepository` 实现并注册（对应 `idempotency_records` 表，
 * 唯一键 `(scope, idempotency_key)`，抢占靠唯一键冲突判定）。
 * 默认实现是进程内 Map，**仅适用于单实例开发环境**。
 */
export interface IdempotencyStore {
  /** 查询记录 */
  get(scope: string, key: string): Promise<IdempotencyRecord | null>;
  /** 抢占：成功返回 true，已存在返回 false（必须是原子操作） */
  tryAcquire(scope: string, key: string, fingerprint: string, ttlSeconds: number): Promise<boolean>;
  /** 标记成功并保存首次响应 */
  complete(scope: string, key: string, response: unknown): Promise<void>;
  /** 标记失败，允许后续重试 */
  fail(scope: string, key: string): Promise<void>;
}

/** 幂等记录保留时长（秒）：7 天，覆盖渠道最大重发窗口 */
const DEFAULT_TTL_SECONDS = 7 * 24 * 3_600;

/**
 * 进程内默认存储。
 *
 * ⚠️ 仅限单实例开发环境：多实例部署时每个实例各有一份 Map，
 * 幂等形同虚设。生产必须调用 {@link setIdempotencyStore} 注册数据库实现。
 */
class InMemoryIdempotencyStore implements IdempotencyStore {
  /** 记录表：scope:key → 记录 */
  private readonly records = new Map<string, IdempotencyRecord>();

  /**
   * 查询记录。
   *
   * @param scope 业务类型
   * @param key 幂等号
   * @returns 记录或 null
   */
  async get(scope: string, key: string): Promise<IdempotencyRecord | null> {
    return this.records.get(`${scope}:${key}`) ?? null;
  }

  /**
   * 抢占记录。
   *
   * @param scope 业务类型
   * @param key 幂等号
   * @param fingerprint 请求指纹
   * @param _ttlSeconds 保留时长（内存实现不感知过期）
   * @returns 是否抢占成功
   */
  async tryAcquire(scope: string, key: string, fingerprint: string, _ttlSeconds: number): Promise<boolean> {
    const id = `${scope}:${key}`;
    if (this.records.has(id)) {
      return false;
    }
    this.records.set(id, { status: IdempotencyStatus.PROCESSING, fingerprint, response: null });
    return true;
  }

  /**
   * 标记成功。
   *
   * @param scope 业务类型
   * @param key 幂等号
   * @param response 首次响应信封
   */
  async complete(scope: string, key: string, response: unknown): Promise<void> {
    const id = `${scope}:${key}`;
    const existing = this.records.get(id);
    this.records.set(id, {
      status: IdempotencyStatus.SUCCESS,
      fingerprint: existing?.fingerprint ?? null,
      response,
    });
  }

  /**
   * 标记失败。
   *
   * @param scope 业务类型
   * @param key 幂等号
   */
  async fail(scope: string, key: string): Promise<void> {
    const id = `${scope}:${key}`;
    const existing = this.records.get(id);
    this.records.set(id, {
      status: IdempotencyStatus.FAILED,
      fingerprint: existing?.fingerprint ?? null,
      response: null,
    });
  }
}

/** 当前使用的存储实现 */
let store: IdempotencyStore = new InMemoryIdempotencyStore();

/**
 * 注册幂等存储实现。
 *
 * @description 应在应用装配阶段调用，接入数据库实现以支撑多实例部署
 * @param next 存储实现
 */
export function setIdempotencyStore(next: IdempotencyStore): void {
  store = next;
}

/**
 * 获取当前幂等存储实现。
 *
 * @returns 当前存储实现
 */
export function getIdempotencyStore(): IdempotencyStore {
  return store;
}

/** 幂等中间件选项 */
export interface IdempotencyOptions {
  /** 业务类型（参与唯一键），默认 `ORDER_CREATE` */
  scope?: string;
  /** 是否强制要求携带幂等号，默认 true */
  required?: boolean;
  /** 记录保留时长（秒），默认 7 天 */
  ttlSeconds?: number;
  /** 是否参与指纹计算的路径前缀（用于同一路由多场景区分） */
  pathOverride?: string;
}

/**
 * 幂等中间件。
 *
 * 实现要点：
 * - 只在**成功响应**（2xx）时落 SUCCESS，失败响应落 FAILED 以便客户端重试；
 * - 通过包装 `res.json` 捕获首次响应体，回放时原样返回，保证客户端拿到字节级一致的结果；
 * - 幂等号取自请求头，客户端不传且 `required` 时直接 400，避免「没幂等保护的写接口」悄悄上线。
 *
 * @param options 幂等选项
 * @returns Express 中间件
 */
export function idempotency(options: IdempotencyOptions = {}): RequestHandler {
  const { scope = IDEMPOTENT_SCOPE.ORDER_CREATE, required = true, ttlSeconds = DEFAULT_TTL_SECONDS } = options;

  return (req, res, next) => {
    void (async () => {
      try {
        const key = req.header(HEADER.IDEMPOTENCY_KEY);

        if (typeof key !== 'string' || key.trim().length === 0) {
          if (!required) {
            next();
            return;
          }
          next(
            ValidationError.fromFieldErrors([
              { field: HEADER.IDEMPOTENCY_KEY, message: '缺少幂等号', code: ErrorCode.VALIDATION_FAILED },
            ]),
          );
          return;
        }

        const idempotencyKey = key.trim();
        req.idempotencyKey = idempotencyKey;

        // 指纹不含 query：前端常带 utm / 时间戳等跟踪参数，会让同一笔业务算出不同指纹
        const fingerprint = buildRequestFingerprint(req.method, options.pathOverride ?? req.path, req.body);

        const existing = await store.get(scope, idempotencyKey);

        if (existing !== null) {
          if (existing.status === IdempotencyStatus.PROCESSING) {
            // 首次请求还在处理中：回放一个「尚不存在的结果」是错的，只能让客户端稍后查询
            logInfo('idempotency.processing', { ctx: { scope, idempotencyKey } });
            next(new AppError('请求正在处理中，请稍后查询结果', { code: ErrorCode.IDEMPOTENT_PROCESSING }));
            return;
          }

          if (existing.status === IdempotencyStatus.SUCCESS) {
            if (!isFingerprintMatched(existing.fingerprint, fingerprint)) {
              logWarn('idempotency.fingerprint_mismatch', { ctx: { scope, idempotencyKey } });
              next(
                new AppError('幂等号已被使用且参数不一致', { code: ErrorCode.IDEMPOTENT_FINGERPRINT_MISMATCH }),
              );
              return;
            }

            // 回放：直接把首次信封写回，不再进入控制器（业务绝不能执行第二次）
            logInfo('idempotency.replayed', { ctx: { scope, idempotencyKey } });
            res.status(200).json(existing.response);
            return;
          }

          // FAILED：允许重新执行，继续走抢占流程
        }

        const acquired = await store.tryAcquire(scope, idempotencyKey, fingerprint, ttlSeconds);
        if (!acquired) {
          // 抢占失败说明并发的同一请求刚抢到，按 PROCESSING 语义处理
          next(new AppError('请求正在处理中，请稍后查询结果', { code: ErrorCode.IDEMPOTENT_PROCESSING }));
          return;
        }

        // 包装 res.json 以捕获首次响应体。
        // 为什么不用 res.on('finish')：finish 时拿不到已序列化的 body，
        // 而回放必须返回与首次完全一致的内容（含 requestId 之外的所有字段）。
        const originalJson = res.json.bind(res);
        res.json = ((payload: unknown) => {
          const status = res.statusCode;
          void (async () => {
            try {
              if (status >= 200 && status < 300) {
                await store.complete(scope, idempotencyKey, payload);
              } else {
                await store.fail(scope, idempotencyKey);
              }
            } catch (error) {
              logWarn('idempotency.persist_failed', {
                ctx: { scope, idempotencyKey, reason: (error as Error).message },
              });
            }
          })();
          return originalJson(payload);
        }) as typeof res.json;

        next();
      } catch (error) {
        next(error);
      }
    })();
  };
}

/**
 * 直接发送幂等回放响应（供控制器在自管响应时使用）。
 *
 * @param res Express 响应对象
 * @param response 首次响应信封
 */
export function sendReplayed(res: Parameters<typeof sendOk>[0], response: unknown): void {
  res.status(200).json(response);
}
