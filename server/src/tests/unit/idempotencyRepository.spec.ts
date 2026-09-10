/**
 * @file server/src/tests/unit/idempotencyRepository.spec.ts
 * @description 幂等仓储单测：假 Prisma 驱动，覆盖抢占原子性 / 过期语义 / bigint 序列化 / 状态机边界
 * @module tests/unit
 * @see server/src/repositories/IdempotencyRepository.ts、server/src/middlewares/idempotency.ts
 * @see prisma/schema.prisma:1213（IdempotencyRecord 模型）
 * @author 软件开发团队
 * @created 2026-09-07
 *
 * 为什么必须有单测：环境无 MySQL 实例，而幂等是「不重复下单」这条铁律的唯一承载者。
 * 下面这些规则写错就是资金事故，且 tsc 完全查不出来：
 * - 抢占必须原子（走 `updateMany` 条件更新），read-then-write 在并发下会两个请求都抢成功；
 * - FAILED 必须允许重试（否则首次失败的业务永远卡住）；
 * - 过期记录必须视为不存在（否则旧响应被永久回放）；
 * - 响应快照必须过 bigint 安全序列化（`Json` 列遇 bigint 抛 TypeError，只有真库才炸）；
 * - `fail` 绝不能把 SUCCESS 覆盖成 FAILED（否则打开重复下单的口子）。
 *
 * 边界说明：**真实并发串行化由 MySQL 行锁保证，单元层无法验证**。
 * 本套件验证的是「代码走的是哪条路径、条件是否写对」，这是单元层能且必须守住的边界。
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Prisma } from '@prisma/client';
import { IdempotencyStatus } from '@/constants/enums';
import { IdempotencyRepository } from '@/repositories/IdempotencyRepository';

// config 在模块加载时即校验环境变量并可能 process.exit；测试环境没有 .env，注入固定值
jest.mock('@/config', () => ({
  config: {
    env: 'test',
    redis: { keyPrefix: 'shop' },
    // logger 在 import 时即读 config.log.level 建 winston 实例，缺了会让整个套件起不来
    log: { level: 'error', dir: '' },
  },
  isProduction: false,
  isTest: true,
  isDevelopment: false,
}));

// 单例在模块加载时会调用 getPrisma()，用假实现避免建真实客户端
jest.mock('@/core/prisma', () => ({
  getPrisma: jest.fn(() => ({})),
}));

/**
 * 打桩函数类型。
 *
 * @description 这里必须用 `any` 而非 `unknown`：`@jest/globals` 会把 `Promise<unknown>`
 * 的解析类型推导成 `never`，导致 `mockResolvedValue(...)` 报 TS2345。打桩是通行例外。
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyAsyncFn = (...args: any[]) => Promise<any>;
/* eslint-enable @typescript-eslint/no-explicit-any */

/** 测试用作用域 */
const SCOPE = 'ORDER_CREATE:1';
/** 测试用幂等号 */
const KEY = 'idem-key-0001';

/** 构造 Prisma P2002 唯一键冲突异常 */
function uniqueViolation(): unknown {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed on uk_scope_key', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

/**
 * 取 `create` 调用参数。
 *
 * @description 值一律是 `unknown`：假 Prisma 的入参形状由各用例自行断言，
 * 这里若放宽成 `any` 会触发 `no-explicit-any`（本项目仅 {@link AnyAsyncFn} 一处允许 `any`）。
 */
function createArg(mock: jest.Mock<AnyAsyncFn>): { data: Record<string, unknown> } {
  return mock.mock.calls[0]?.[0] as { data: Record<string, unknown> };
}

/** 取 `updateMany` 调用参数（同上，值类型为 `unknown`） */
function updateArg(
  mock: jest.Mock<AnyAsyncFn>,
  index = 0,
): { where: Record<string, unknown>; data: Record<string, unknown> } {
  return mock.mock.calls[index]?.[0] as {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  };
}

describe('IdempotencyRepository 幂等仓储（DB 版）', () => {
  /** 假 Prisma：只实现本仓储用到的 idempotencyRecord 委托 */
  let prisma: {
    idempotencyRecord: {
      findUnique: jest.Mock<AnyAsyncFn>;
      create: jest.Mock<AnyAsyncFn>;
      updateMany: jest.Mock<AnyAsyncFn>;
    };
  };
  /** 被测试对象 */
  let repo: IdempotencyRepository;

  beforeEach(() => {
    jest.clearAllMocks();

    prisma = {
      idempotencyRecord: {
        findUnique: jest.fn<AnyAsyncFn>(),
        create: jest.fn<AnyAsyncFn>(),
        updateMany: jest.fn<AnyAsyncFn>(),
      },
    };

    prisma.idempotencyRecord.create.mockResolvedValue({ id: 1n });
    prisma.idempotencyRecord.updateMany.mockResolvedValue({ count: 0 });
    prisma.idempotencyRecord.findUnique.mockResolvedValue(null);

    repo = new IdempotencyRepository(prisma as never);
  });

  // --------------------------------------------------------------------------
  // tryAcquire
  // --------------------------------------------------------------------------

  it('首次抢占 → true（INSERT 命中，不走重抢分支）', async () => {
    const ok = await repo.tryAcquire(SCOPE, KEY, 'fp-1', 60);

    expect(ok).toBe(true);
    expect(prisma.idempotencyRecord.create).toHaveBeenCalledTimes(1);
    expect(prisma.idempotencyRecord.updateMany).not.toHaveBeenCalled(); // 首次无需重抢
  });

  it('首次抢占写入 PROCESSING 与正确的过期时间', async () => {
    const before = Date.now();
    await repo.tryAcquire(SCOPE, KEY, 'fp-1', 600);

    const { data } = createArg(prisma.idempotencyRecord.create);
    expect(data.scope).toBe(SCOPE);
    expect(data.idempotencyKey).toBe(KEY);
    expect(data.status).toBe(IdempotencyStatus.PROCESSING);
    expect((data.expireAt as Date).getTime()).toBeGreaterThanOrEqual(before + 600_000);
  });

  it('已存在 PROCESSING → false（并发请求不能重复执行业务）', async () => {
    prisma.idempotencyRecord.create.mockRejectedValue(uniqueViolation());
    prisma.idempotencyRecord.updateMany.mockResolvedValue({ count: 0 }); // PROCESSING 不满足重抢条件

    const ok = await repo.tryAcquire(SCOPE, KEY, 'fp-1', 60);

    expect(ok).toBe(false);
  });

  it('已存在 SUCCESS → false（已成功的业务绝不允许再执行）', async () => {
    prisma.idempotencyRecord.create.mockRejectedValue(uniqueViolation());
    prisma.idempotencyRecord.updateMany.mockResolvedValue({ count: 0 });

    const ok = await repo.tryAcquire(SCOPE, KEY, 'fp-1', 60);

    expect(ok).toBe(false);
    // 关键：重抢条件里绝不能出现 SUCCESS，否则「已下单成功」会被重置成可重抢
    const { where } = updateArg(prisma.idempotencyRecord.updateMany);
    expect(JSON.stringify(where.OR)).not.toContain('SUCCESS');
  });

  it('已存在 FAILED → true（允许重试），且旧 responseSnapshot 被清空、指纹被刷新', async () => {
    prisma.idempotencyRecord.create.mockRejectedValue(uniqueViolation());
    prisma.idempotencyRecord.updateMany.mockResolvedValue({ count: 1 });

    const ok = await repo.tryAcquire(SCOPE, KEY, 'fp-2', 60);

    expect(ok).toBe(true);
    const { where, data } = updateArg(prisma.idempotencyRecord.updateMany);
    // FAILED 必须出现在重抢条件里，否则首次失败的业务永远卡住
    expect(where.OR).toEqual(
      expect.arrayContaining([{ status: IdempotencyStatus.FAILED }]),
    );
    expect(data.status).toBe(IdempotencyStatus.PROCESSING);
    expect(data.requestFingerprint).toBe('fp-2'); // 重试的是新请求，指纹必须刷新
    expect(data.responseSnapshot).toBe(Prisma.DbNull); // 旧快照必须清掉，否则会回放上一次的结果
  });

  it('记录已过期 → true（允许重新抢占）', async () => {
    prisma.idempotencyRecord.create.mockRejectedValue(uniqueViolation());
    prisma.idempotencyRecord.updateMany.mockResolvedValue({ count: 1 });

    const ok = await repo.tryAcquire(SCOPE, KEY, 'fp-3', 60);

    expect(ok).toBe(true);
    const { where } = updateArg(prisma.idempotencyRecord.updateMany);
    expect(where.OR).toEqual(
      expect.arrayContaining([{ expireAt: { lt: expect.any(Date) } }]),
    );
  });

  it('并发抢占：两个同时发生的 tryAcquire 只有一个 true，且走的是 updateMany 原子路径', async () => {
    // 两次 INSERT 都撞唯一键
    prisma.idempotencyRecord.create.mockRejectedValue(uniqueViolation());
    // MySQL 行锁保证只有第一个 updateMany 拿到 count=1
    prisma.idempotencyRecord.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    const [first, second] = await Promise.all([
      repo.tryAcquire(SCOPE, KEY, 'fp-1', 60),
      repo.tryAcquire(SCOPE, KEY, 'fp-1', 60),
    ]);

    expect([first, second].filter((r) => r === true)).toHaveLength(1);

    // 关键：抢占期间绝不能先读后写（read-then-write 在并发下会两个都成功）
    expect(prisma.idempotencyRecord.findUnique).not.toHaveBeenCalled();
    expect(prisma.idempotencyRecord.updateMany).toHaveBeenCalledTimes(2);
  });

  it('非唯一键冲突的数据库异常原样抛出（连接失败不能被吞成「抢占失败」）', async () => {
    prisma.idempotencyRecord.create.mockRejectedValue(new Error('connect ECONNREFUSED'));

    await expect(repo.tryAcquire(SCOPE, KEY, 'fp-1', 60)).rejects.toThrow('connect ECONNREFUSED');
    // 吞掉真实故障会让客户端收到 409 后无限重试，故障反而被掩盖
    expect(prisma.idempotencyRecord.updateMany).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // get
  // --------------------------------------------------------------------------

  it('get：过期记录返回 null（否则旧响应会被永久回放）', async () => {
    prisma.idempotencyRecord.findUnique.mockResolvedValue({
      status: IdempotencyStatus.SUCCESS,
      requestFingerprint: 'fp-1',
      responseSnapshot: { code: 0, data: { orderId: 1 } },
      expireAt: new Date(Date.now() - 1_000), // 已过期
    });

    const rec = await repo.get(SCOPE, KEY);

    expect(rec).toBeNull();
  });

  it('get：未过期记录正常返回，且 DB 空串指纹还原为 null', async () => {
    prisma.idempotencyRecord.findUnique.mockResolvedValue({
      status: IdempotencyStatus.PROCESSING,
      requestFingerprint: '', // DB 列 NOT NULL，空值存为空串
      responseSnapshot: null,
      expireAt: new Date(Date.now() + 60_000),
    });

    const rec = await repo.get(SCOPE, KEY);

    expect(rec).not.toBeNull();
    expect(rec?.status).toBe(IdempotencyStatus.PROCESSING);
    expect(rec?.fingerprint).toBeNull(); // 空串 → null，还原接口层可空语义
  });

  it('get：查询走 uk_scope_key 复合唯一键（scope + idempotencyKey）', async () => {
    prisma.idempotencyRecord.findUnique.mockResolvedValue(null);

    await repo.get(SCOPE, KEY);

    const arg = prisma.idempotencyRecord.findUnique.mock.calls[0]?.[0] as {
      where: { scope_idempotencyKey: { scope: string; idempotencyKey: string } };
    };
    expect(arg.where.scope_idempotencyKey.scope).toBe(SCOPE);
    expect(arg.where.scope_idempotencyKey.idempotencyKey).toBe(KEY);
  });

  // --------------------------------------------------------------------------
  // complete
  // --------------------------------------------------------------------------

  it('complete：响应含 bigint 不抛错，落库值已转为 number（Json 列遇 bigint 会炸）', async () => {
    const response = {
      code: 0,
      message: 'OK',
      data: { orderId: 9001n, payAmount: 123n, orderNo: 'SO20260907000001123456' },
    };

    // 无 jsonReplacer 时这里会抛 TypeError: Do not know how to serialize a BigInt
    await expect(repo.complete(SCOPE, KEY, response)).resolves.toBeUndefined();

    const { data } = updateArg(prisma.idempotencyRecord.updateMany);
    const snapshot = data.responseSnapshot as {
      data: { orderId: unknown; payAmount: unknown };
    };
    expect(typeof snapshot.data.orderId).not.toBe('bigint');
    expect(typeof snapshot.data.payAmount).not.toBe('bigint');
    expect(snapshot.data.payAmount).toBe(123);
    expect(snapshot.data.orderId).toBe(9001);
  });

  it('complete：超安全整数范围的 bigint 降级为字符串（不静默丢精度）', async () => {
    const response = { data: { amount: BigInt(Number.MAX_SAFE_INTEGER) + 1n } };

    await expect(repo.complete(SCOPE, KEY, response)).resolves.toBeUndefined();

    const { data } = updateArg(prisma.idempotencyRecord.updateMany);
    const snapshot = data.responseSnapshot as { data: { amount: unknown } };
    expect(snapshot.data.amount).toBe('9007199254740992');
  });

  it('complete 后 get 返回 SUCCESS 且 response 就是首次响应', async () => {
    const firstResponse = { code: 0, data: { orderNo: 'SO20260907000001123456', payAmount: 9900n } };
    await repo.complete(SCOPE, KEY, firstResponse);

    const { data } = updateArg(prisma.idempotencyRecord.updateMany);
    // 模拟 DB 读回刚落库的记录
    prisma.idempotencyRecord.findUnique.mockResolvedValue({
      status: data.status,
      requestFingerprint: 'fp-1',
      responseSnapshot: data.responseSnapshot,
      expireAt: new Date(Date.now() + 60_000),
    });

    const rec = await repo.get(SCOPE, KEY);

    expect(rec?.status).toBe(IdempotencyStatus.SUCCESS);
    expect(rec?.response).toEqual({ code: 0, data: { orderNo: 'SO20260907000001123456', payAmount: 9900 } });
  });

  // --------------------------------------------------------------------------
  // fail
  // --------------------------------------------------------------------------

  it('fail：只在 PROCESSING 时置 FAILED，绝不覆盖 SUCCESS', async () => {
    await repo.fail(SCOPE, KEY);

    const { where, data } = updateArg(prisma.idempotencyRecord.updateMany);
    expect(where.status).toBe(IdempotencyStatus.PROCESSING); // 漏了就会把 SUCCESS 重置成可重试
    expect(where.scope).toBe(SCOPE);
    expect(where.idempotencyKey).toBe(KEY);
    expect(data.status).toBe(IdempotencyStatus.FAILED);
  });

  it('fail 之后可重新抢占（FAILED → 允许重试的完整闭环）', async () => {
    await repo.fail(SCOPE, KEY);

    prisma.idempotencyRecord.create.mockRejectedValue(uniqueViolation());
    prisma.idempotencyRecord.updateMany.mockResolvedValue({ count: 1 });

    const ok = await repo.tryAcquire(SCOPE, KEY, 'fp-2', 60);

    expect(ok).toBe(true);
  });
});
