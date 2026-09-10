/**
 * @file server/src/tests/unit/stockCas.spec.ts
 * @description 库存 CAS（下单冻结 / 支付确认 / 取消释放 / 退款回仓）单测。
 * @module tests/unit
 * @see server/src/services/StockService.ts、server/src/repositories/SkuStockRepository.ts
 * @see docs/04-flows.md F5.2（CAS 权威判定 + 乐观锁）、docs/03-database.md（恒等式）
 * @author 软件开发团队
 * @created 2026-09-07
 *
 * 沙箱约束：环境无 MySQL / Redis 实例，本套件用**假仓储（fake repo）**打桩，
 * 不连真实 DB。核心验证点：CAS 参数（源字段判定 / 增量 / WHERE 条件）正确、
 * 库存流水六段值完整、50001 库存不足 vs 50002 版本冲突区分、恒等式保持。
 */

import { describe, expect, it, jest } from '@jest/globals';
import { OperatorType, StockChangeType } from '@prisma/client';

// config 在模块加载时即校验环境变量并可能 process.exit；测试环境没有 .env，用假 config 注入固定前缀
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

// StockService 默认走 getRedis 仅用于 Redis 锁（本批未实现），这里返回 null（模拟「无 Redis 实例」）
jest.mock('@/core/redis', () => ({
  getRedis: jest.fn(() => null),
}));

import type { DbClient, SkuStockRepository } from '@/repositories/SkuStockRepository';
import type {
  CasUpdateParams,
  StockLogInsert,
  StockRecord,
  StockSnapshot,
} from '@/repositories/SkuStockRepository';
import { ErrorCode } from '@/core/errors/errorCodes';
import { getPrisma } from '@/core/prisma';
import { StockService, type StockOpInput } from '@/services/StockService';

/** 构造一个假仓储（所有方法可桩），断言时检查调用参数 */
function buildFakeRepo() {
  const findForUpdate = jest.fn<(tx: DbClient, skuId: bigint) => Promise<StockSnapshot | null>>();
  const findBySkuId = jest.fn<(tx: DbClient, skuId: bigint) => Promise<StockRecord | null>>();
  const casUpdate = jest.fn<(tx: DbClient, p: CasUpdateParams) => Promise<number>>();
  const insertLog = jest.fn<(tx: DbClient, l: StockLogInsert) => Promise<void>>();

  const repo = {
    findForUpdate,
    findBySkuId,
    casUpdate,
    insertLog,
  } as unknown as SkuStockRepository;

  return { repo, findForUpdate, findBySkuId, casUpdate, insertLog };
}

/** 测试用事务客户端占位（fake repo 不读它） */
const TX = {} as unknown as DbClient;

/** 构造库存快照 */
function snap(overrides: Partial<StockSnapshot> = {}): StockSnapshot {
  return { available: 10, frozen: 0, sold: 0, version: 1, ...overrides };
}

/** 构造标准操作入参 */
function op(overrides: Partial<StockOpInput> = {}): StockOpInput {
  return {
    skuId: 100n,
    qty: 3,
    bizNo: 'ORD-20260907-001',
    operatorType: OperatorType.USER,
    operatorId: 7n,
    operatorName: 'tester',
    reason: null,
    idempotencyKey: null,
    ...overrides,
  };
}

describe('StockService CAS', () => {
  it('freeze 成功：CAS 参数正确（available−N、frozen+N、version+1、WHERE sku_id AND available>=N AND version），且写了一条 ORDER_FREEZE 流水', async () => {
    const { repo, findForUpdate, casUpdate, insertLog } = buildFakeRepo();
    findForUpdate.mockResolvedValue(snap({ available: 10, frozen: 0, sold: 0, version: 1 }));
    casUpdate.mockResolvedValue(1);
    insertLog.mockResolvedValue(undefined);

    const svc = new StockService(getPrisma(), repo);
    const res = await svc.freeze(op({ qty: 3 }), TX);

    // CAS 参数断言：源字段 available、require=3、版本 1、增量 available -3 / frozen +3 / sold 0
    expect(casUpdate).toHaveBeenCalledTimes(1);
    expect(casUpdate.mock.calls[0]![1]).toEqual({
      skuId: 100n,
      sourceField: 'available',
      sourceRequired: 3,
      version: 1,
      availableDelta: -3,
      frozenDelta: 3,
      soldDelta: 0,
    });

    // 流水断言：change_type=ORDER_FREEZE，六段前后值正确，change_qty 带符号 +3
    expect(insertLog).toHaveBeenCalledTimes(1);
    const log = insertLog.mock.calls[0]![1];
    expect(log.changeType).toBe(StockChangeType.ORDER_FREEZE); // = 'ORDER_FREEZE'
    expect(log.changeQty).toBe(3);
    expect(log.beforeAvailable).toBe(10);
    expect(log.afterAvailable).toBe(7);
    expect(log.beforeFrozen).toBe(0);
    expect(log.afterFrozen).toBe(3);
    expect(log.beforeSold).toBe(0);
    expect(log.afterSold).toBe(0);
    expect(log.bizNo).toBe('ORD-20260907-001');
    expect(log.operatorType).toBe(OperatorType.USER); // = 'USER'
    expect(log.operatorId).toBe(7n);

    // 返回结果三段值正确，version 已 +1
    expect(res.afterAvailable).toBe(7);
    expect(res.afterFrozen).toBe(3);
    expect(res.version).toBe(2);
  });

  it('freeze 库存不足：available < N → CAS 返回 0 → 抛 50001，且不写流水', async () => {
    const { repo, findForUpdate, casUpdate, insertLog } = buildFakeRepo();
    findForUpdate.mockResolvedValue(snap({ available: 2, frozen: 0, sold: 0, version: 1 })); // available 2 < qty 5
    casUpdate.mockResolvedValue(0);
    insertLog.mockResolvedValue(undefined);

    const svc = new StockService(getPrisma(), repo);
    await expect(svc.freeze(op({ qty: 5 }), TX)).rejects.toMatchObject({
      code: ErrorCode.STOCK_NOT_ENOUGH,
    });
    // 失败扣减不能留流水
    expect(insertLog).not.toHaveBeenCalled();
  });

  it('freeze 版本冲突：available >= N 但 CAS 返回 0 → 抛 50002，与库存不足是不同错误码', async () => {
    const { repo, findForUpdate, casUpdate, insertLog } = buildFakeRepo();
    findForUpdate.mockResolvedValue(snap({ available: 10, frozen: 0, sold: 0, version: 1 })); // available 充足
    casUpdate.mockResolvedValue(0); // 模拟 version 被并发改写 → 乐观锁冲突
    insertLog.mockResolvedValue(undefined);

    const svc = new StockService(getPrisma(), repo);
    const err = await svc.freeze(op({ qty: 3 }), TX).catch((e) => e);
    expect(err).toMatchObject({ code: ErrorCode.STOCK_CONFLICT });

    // 与库存不足区分
    expect(err.code).not.toBe(ErrorCode.STOCK_NOT_ENOUGH);
    expect(insertLog).not.toHaveBeenCalled();
  });

  it('confirm / release / refundReturn 各自由正确的源字段判定（confirm 判 frozen、release 判 frozen、refundReturn 判 sold）', async () => {
    const svc = (repo: SkuStockRepository) => new StockService(getPrisma(), repo);

    // confirm：frozen -, sold +；判 frozen
    {
      const { repo, findForUpdate, casUpdate, insertLog } = buildFakeRepo();
      findForUpdate.mockResolvedValue(snap({ available: 10, frozen: 5, sold: 2, version: 1 }));
      casUpdate.mockResolvedValue(1);
      insertLog.mockResolvedValue(undefined);
      await svc(repo).confirm(op({ qty: 3 }), TX);
      expect(casUpdate.mock.calls[0]![1]).toMatchObject({
        sourceField: 'frozen',
        sourceRequired: 3,
        availableDelta: 0,
        frozenDelta: -3,
        soldDelta: 3,
      });
      expect(insertLog.mock.calls[0]![1].changeType).toBe(StockChangeType.ORDER_CONFIRM);
      expect(insertLog.mock.calls[0]![1].changeQty).toBe(-3);
    }

    // release：frozen -, available +；判 frozen
    {
      const { repo, findForUpdate, casUpdate, insertLog } = buildFakeRepo();
      findForUpdate.mockResolvedValue(snap({ available: 7, frozen: 3, sold: 2, version: 1 }));
      casUpdate.mockResolvedValue(1);
      insertLog.mockResolvedValue(undefined);
      await svc(repo).release(op({ qty: 3 }), TX);
      expect(casUpdate.mock.calls[0]![1]).toMatchObject({
        sourceField: 'frozen',
        sourceRequired: 3,
        availableDelta: 3,
        frozenDelta: -3,
        soldDelta: 0,
      });
      expect(insertLog.mock.calls[0]![1].changeType).toBe(StockChangeType.ORDER_RELEASE);
    }

    // refundReturn：sold -, available +；判 sold
    {
      const { repo, findForUpdate, casUpdate, insertLog } = buildFakeRepo();
      findForUpdate.mockResolvedValue(snap({ available: 7, frozen: 0, sold: 5, version: 1 }));
      casUpdate.mockResolvedValue(1);
      insertLog.mockResolvedValue(undefined);
      await svc(repo).refundReturn(op({ qty: 3 }), TX);
      expect(casUpdate.mock.calls[0]![1]).toMatchObject({
        sourceField: 'sold',
        sourceRequired: 3,
        availableDelta: 3,
        frozenDelta: 0,
        soldDelta: -3,
      });
      expect(insertLog.mock.calls[0]![1].changeType).toBe(StockChangeType.REFUND_RETURN);
    }
  });

  it('退款回仓易错点：available 充足但 sold 不足时必须判 库存不足（不能因 available 放行凭空加库存）', async () => {
    const { repo, findForUpdate, casUpdate, insertLog } = buildFakeRepo();
    // available 高达 100，但 sold 只有 2，退款 5 件 → 应判 库存不足
    findForUpdate.mockResolvedValue(snap({ available: 100, frozen: 0, sold: 2, version: 1 }));
    casUpdate.mockResolvedValue(0);
    insertLog.mockResolvedValue(undefined);

    const svc = new StockService(getPrisma(), repo);
    await expect(svc.refundReturn(op({ qty: 5 }), TX)).rejects.toMatchObject({
      code: ErrorCode.STOCK_NOT_ENOUGH,
    });
    // 关键是 CAS 用的是 sourceField='sold' 而非 'available'
    expect(casUpdate.mock.calls[0]![1].sourceField).toBe('sold');
    expect(insertLog).not.toHaveBeenCalled();
  });

  it('恒等式保持：4 个操作后 total 不变，available + frozen + sold 仍等于 total', async () => {
    const cases: Array<{
      method: 'freeze' | 'confirm' | 'release' | 'refundReturn';
      snap: StockSnapshot;
      qty: number;
    }> = [
      { method: 'freeze', snap: snap({ available: 10, frozen: 0, sold: 0, version: 1 }), qty: 3 },
      { method: 'confirm', snap: snap({ available: 10, frozen: 5, sold: 2, version: 1 }), qty: 2 },
      { method: 'release', snap: snap({ available: 7, frozen: 3, sold: 2, version: 1 }), qty: 3 },
      { method: 'refundReturn', snap: snap({ available: 7, frozen: 0, sold: 5, version: 1 }), qty: 4 },
    ];

    for (const c of cases) {
      const { repo, findForUpdate, casUpdate, insertLog } = buildFakeRepo();
      findForUpdate.mockResolvedValue({ ...c.snap });
      casUpdate.mockResolvedValue(1);
      insertLog.mockResolvedValue(undefined);
      const svc = new StockService(getPrisma(), repo);

      const res = await svc[c.method](op({ qty: c.qty }), TX);

      const beforeTotal = c.snap.available + c.snap.frozen + c.snap.sold;
      const afterTotal = res.afterAvailable + res.afterFrozen + res.afterSold;
      expect(res.total).toBe(beforeTotal); // total 字段与 before 三段和一致
      expect(afterTotal).toBe(beforeTotal); // 操作前后 total 不变（恒等式）
      expect(insertLog).toHaveBeenCalled(); // 成功才写流水
    }
  });

  it('流水字段完整性：六段 before/after 全部写入且 change_qty 符号正确（以 refundReturn 为例）', async () => {
    const { repo, findForUpdate, casUpdate, insertLog } = buildFakeRepo();
    findForUpdate.mockResolvedValue(snap({ available: 7, frozen: 0, sold: 5, version: 1 }));
    casUpdate.mockResolvedValue(1);
    insertLog.mockResolvedValue(undefined);

    const svc = new StockService(getPrisma(), repo);
    const res = await svc.refundReturn(op({ qty: 3 }), TX);

    const log = insertLog.mock.calls[0]![1];
    expect(log.beforeAvailable).toBe(7);
    expect(log.afterAvailable).toBe(10);
    expect(log.beforeFrozen).toBe(0);
    expect(log.afterFrozen).toBe(0);
    expect(log.beforeSold).toBe(5);
    expect(log.afterSold).toBe(2);
    expect(log.changeQty).toBe(-3); // 回仓：占用减少，带负号
    // 结果与流水前后值一致
    expect(res.beforeAvailable).toBe(log.beforeAvailable);
    expect(res.afterAvailable).toBe(log.afterAvailable);
    expect(res.beforeFrozen).toBe(log.beforeFrozen);
    expect(res.afterFrozen).toBe(log.afterFrozen);
    expect(res.beforeSold).toBe(log.beforeSold);
    expect(res.afterSold).toBe(log.afterSold);
  });

  it('idempotencyKey 写入 idempotency_key（未传时为 NULL）', async () => {
    // 传入幂等号
    {
      const { repo, findForUpdate, casUpdate, insertLog } = buildFakeRepo();
      findForUpdate.mockResolvedValue(snap({ available: 10, frozen: 0, sold: 0, version: 1 }));
      casUpdate.mockResolvedValue(1);
      insertLog.mockResolvedValue(undefined);
      const svc = new StockService(getPrisma(), repo);
      await svc.freeze(op({ idempotencyKey: 'idem-001' }), TX);
      expect(insertLog.mock.calls[0]![1].idempotencyKey).toBe('idem-001');
    }
    // 未传 → NULL
    {
      const { repo, findForUpdate, casUpdate, insertLog } = buildFakeRepo();
      findForUpdate.mockResolvedValue(snap({ available: 10, frozen: 0, sold: 0, version: 1 }));
      casUpdate.mockResolvedValue(1);
      insertLog.mockResolvedValue(undefined);
      const svc = new StockService(getPrisma(), repo);
      await svc.freeze(op({ idempotencyKey: undefined }), TX);
      expect(insertLog.mock.calls[0]![1].idempotencyKey).toBeNull();
    }
  });

  it('库存行不存在：freeze 按「库存不足」（available=0）处理，不抛未捕获异常，且不写流水', async () => {
    const { repo, findForUpdate, casUpdate, insertLog } = buildFakeRepo();
    findForUpdate.mockResolvedValue(null); // 行不存在
    casUpdate.mockResolvedValue(0); // available 实际为 0 < qty
    insertLog.mockResolvedValue(undefined);

    const svc = new StockService(getPrisma(), repo);
    await expect(svc.freeze(op({ qty: 1 }), TX)).rejects.toMatchObject({
      code: ErrorCode.STOCK_NOT_ENOUGH,
    });
    // 仍会发起一次 CAS（源字段 available=0 < 1），但返回 0 后进入 库存不足 分支
    expect(casUpdate).toHaveBeenCalledTimes(1);
    expect(casUpdate.mock.calls[0]![1].sourceField).toBe('available');
    expect(insertLog).not.toHaveBeenCalled();
  });

  it('getStock：行存在返回三段值，行不存在返回 null（行为明确、不抛异常）', async () => {
    const { repo, findBySkuId } = buildFakeRepo();
    findBySkuId.mockResolvedValue({ available: 8, frozen: 2, sold: 1, version: 3, total: 11 });
    const svc = new StockService(getPrisma(), repo);
    expect(await svc.getStock(100n)).toEqual({ available: 8, frozen: 2, sold: 1 });

    findBySkuId.mockResolvedValue(null);
    expect(await svc.getStock(999n)).toBeNull();
  });
});
