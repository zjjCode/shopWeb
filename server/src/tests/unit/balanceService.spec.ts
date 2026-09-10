/**
 * @file server/src/tests/unit/balanceService.spec.ts
 * @description BalanceService 单测（假 Prisma + 假 FundService 打桩，不连真实 DB）
 * @module tests/unit
 * @see server/src/services/BalanceService.ts、docs/04-flows.md F6 / F6.6
 * @author 软件开发团队
 * @created 2026-09-09
 *
 * 为什么必须有单测：环境无 MySQL / Redis，余额与流水都是「按用户隔离」的资金数据，
 * 越权红线（where 带 userId）、充值幂等键、事务透传这些规则无法靠 tsc 验证，
 * 一旦写错就是越权看别人流水或渠道重发重复加钱。用注入的假 Prisma + 假 FundService 驱动。
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { AccountStatus, FundAccountType, FundBizType } from '@/constants/enums';
import { ErrorCode } from '@/core/errors/errorCodes';
import { withTransaction } from '@/core/transaction';
import type { FundAccountSnapshot, FundResult, TransferResult, TxClient } from '@/services/FundService';
import { BalanceService } from '@/services/BalanceService';

// config 在模块加载时即建 winston 实例，缺了 log.level 整个套件起不来
jest.mock('@/config', () => ({
  config: {
    env: 'test',
    redis: { keyPrefix: 'shop' },
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

// creditByRecharge 不传 tx 时会自开 withTransaction（真实实现调 getPrisma().$transaction，
// 而 getPrisma 的假实现返回空对象，直接跑会 TypeError）。与 fundService.spec.ts 同法 mock 掉。
jest.mock('@/core/transaction', () => ({
  withTransaction: jest.fn(),
}));

/** BalanceService 构造函数第二个参数（FundService）的类型 */
type CtorFund = ConstructorParameters<typeof BalanceService>[1];

/**
 * 这里必须用 `any` 而非 `unknown`：`@jest/globals` 会把 `Promise<unknown>`
 * 的解析类型推导成 `never`，导致 `mockResolvedValue(...)` 报 TS2345。打桩是通行例外。
 * （同 fundService.spec.ts:74 的既有模式）
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyAsyncFn = (...args: any[]) => Promise<any>;
/* eslint-enable @typescript-eslint/no-explicit-any */

/** 假 Prisma：只实现 BalanceService 自身查询用到的 fundAccount / fundTransaction */
const fakePrisma = {
  fundAccount: {
    findFirst: jest.fn<(args: { where?: { userId?: bigint; accountType?: string }; select?: unknown }) => Promise<
      { id?: bigint; balance?: bigint } | null
    >>(),
  },
  fundTransaction: {
    findMany: jest.fn<(args: unknown) => Promise<unknown[]>>(),
    count: jest.fn<(args: unknown) => Promise<number>>(),
  },
};

/** 假 FundService：只实现被 BalanceService 调用的 credit / getOrCreateAccount */
const fakeFund = {
  getOrCreateAccount: jest.fn<
    (userId: bigint, accountType: string, tx?: unknown) => Promise<FundAccountSnapshot>
  >(),
  credit: jest.fn<(input: Record<string, unknown>, tx?: unknown) => Promise<FundResult>>(),
  debit: jest.fn<(input?: unknown, tx?: unknown) => Promise<FundResult>>(),
  transfer: jest.fn<(input?: unknown, tx?: unknown) => Promise<TransferResult>>(),
};

/** 构造一个账户快照 */
function snapshot(accountNo: string, status: AccountStatus = AccountStatus.ACTIVE): FundAccountSnapshot {
  return {
    id: 1n,
    accountNo,
    accountType: FundAccountType.USER_BALANCE,
    status,
    balance: 0n,
    frozenBalance: 0n,
    version: 0,
  };
}

/** 构造一条记账结果 */
function fundResult(amount: bigint): FundResult {
  return {
    txNo: 'FT-TEST',
    accountId: 1n,
    accountNo: 'BAL-1',
    direction: 'IN',
    amount,
    beforeBalance: 0n,
    afterBalance: amount,
    duplicated: false,
  };
}

/** 用假 prisma + 假 fund 构造一个 BalanceService */
function makeSvc(): BalanceService {
  return new BalanceService(fakePrisma as unknown as ConstructorParameters<typeof BalanceService>[0], fakeFund as unknown as CtorFund);
}

// ---------------------------------------------------------------------------
// 默认打桩（每个用例前重置）
// ---------------------------------------------------------------------------

beforeEach(() => {
  // withTransaction 直通：fn(占位 tx)。BalanceService 的 run 只把 tx 透传给 fakeFund 打桩，不读其形状
  (withTransaction as unknown as jest.Mock<AnyAsyncFn>).mockImplementation(async (fn) =>
    fn({} as TxClient),
  );

  fakePrisma.fundAccount.findFirst.mockResolvedValue(null);
  fakePrisma.fundTransaction.findMany.mockResolvedValue([]);
  fakePrisma.fundTransaction.count.mockResolvedValue(0);

  fakeFund.getOrCreateAccount.mockImplementation(async (userId: bigint) =>
    snapshot(`BAL-${userId.toString()}`),
  );
  fakeFund.credit.mockImplementation(async (input: Record<string, unknown>) =>
    fundResult((input.amount as bigint) ?? 0n),
  );
  fakeFund.debit.mockResolvedValue(fundResult(0n));
  fakeFund.transfer.mockResolvedValue({ credit: fundResult(0n), debit: fundResult(0n), txGroupNo: 'G1' });
});

// ---------------------------------------------------------------------------
// 1. 开户
// ---------------------------------------------------------------------------

describe('BalanceService.getOrCreateAccount', () => {
  it('首次调用创建账户，账户号确定性生成（同 userId 两次调用得到同一账号）', async () => {
    const svc = makeSvc();
    const a = await svc.getOrCreateAccount(1n);
    const b = await svc.getOrCreateAccount(1n);
    expect(a.accountNo).toBe('BAL-1');
    expect(b.accountNo).toBe('BAL-1');
  });

  it('重复调用不新建（uk_user_account 命中即复用）：两次都命中同一 userId，返回同一账号', async () => {
    const svc = makeSvc();
    await svc.getOrCreateAccount(1n);
    await svc.getOrCreateAccount(1n);
    expect(fakeFund.getOrCreateAccount).toHaveBeenCalledTimes(2);
    // 两次入参的 userId / accountType 一致（唯一约束命中复用）
    const first = fakeFund.getOrCreateAccount.mock.calls[0];
    const second = fakeFund.getOrCreateAccount.mock.calls[1];
    expect(first?.[0]).toBe(1n);
    expect(second?.[0]).toBe(1n);
    expect(first?.[1]).toBe(FundAccountType.USER_BALANCE);
  });
});

// ---------------------------------------------------------------------------
// 2. 查余额
// ---------------------------------------------------------------------------

describe('BalanceService.getBalance', () => {
  it('返回正确余额，类型是 bigint', async () => {
    const svc = makeSvc();
    fakePrisma.fundAccount.findFirst.mockResolvedValue({ balance: 5000n });
    const bal = await svc.getBalance(1n);
    expect(bal).toBe(5000n);
    expect(typeof bal).toBe('bigint');
  });

  it('账户不存在 → 抛 61001', async () => {
    const svc = makeSvc();
    fakePrisma.fundAccount.findFirst.mockResolvedValue(null);
    await expect(svc.getBalance(1n)).rejects.toMatchObject({ code: ErrorCode.BALANCE_ACCOUNT_NOT_FOUND });
  });
});

// ---------------------------------------------------------------------------
// 3. 流水明细 + 越权红线
// ---------------------------------------------------------------------------

describe('BalanceService.listTransactions', () => {
  it('越权红线：账户解析的 where 必须带 userId（断言具体值）', async () => {
    const svc = makeSvc();
    fakePrisma.fundAccount.findFirst.mockResolvedValue({ id: 9n });
    await svc.listTransactions(1n, { page: 1, pageSize: 10 });

    const where = fakePrisma.fundAccount.findFirst.mock.calls[0]?.[0]?.where;
    expect(where).toBeDefined();
    expect(where?.userId).toBe(1n);
    expect(where?.accountType).toBe(FundAccountType.USER_BALANCE);
  });

  it('分页参数正确透传（skip / take 计算正确）', async () => {
    const svc = makeSvc();
    fakePrisma.fundAccount.findFirst.mockResolvedValue({ id: 9n });
    await svc.listTransactions(1n, { page: 3, pageSize: 15 });

    const fmArgs = fakePrisma.fundTransaction.findMany.mock.calls[0]?.[0] as {
      where?: unknown;
      skip?: number;
      take?: number;
    };
    expect(fmArgs.skip).toBe((3 - 1) * 15); // 30
    expect(fmArgs.take).toBe(15);
    // 流水查询按解析出的 accountId 过滤（fund_transactions 无 userId 列，靠账户归属锚定）
    expect((fmArgs.where as { accountId?: bigint }).accountId).toBe(9n);
  });

  it('返回 { list, total } 结构，空列表不报错', async () => {
    const svc = makeSvc();
    fakePrisma.fundAccount.findFirst.mockResolvedValue({ id: 9n });
    fakePrisma.fundTransaction.findMany.mockResolvedValue([]);
    fakePrisma.fundTransaction.count.mockResolvedValue(0);

    const r = await svc.listTransactions(1n);
    expect(r).toEqual({ list: [], total: 0 });
  });
});

// ---------------------------------------------------------------------------
// 4. 充值入账
// ---------------------------------------------------------------------------

describe('BalanceService.creditByRecharge', () => {
  it('充值入账：调 FundService.credit，金额 / 幂等键 / 业务类型正确', async () => {
    const svc = makeSvc();
    const r = await svc.creditByRecharge(1n, { amount: 1000n, rechargeNo: 'R1' });

    expect(fakeFund.credit).toHaveBeenCalledTimes(1);
    const callInput = fakeFund.credit.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callInput.amount).toBe(1000n);
    expect(callInput.idempotencyKey).toBe('R1');
    expect(callInput.bizType).toBe(FundBizType.BALANCE_RECHARGE);
    expect(r.amount).toBe(1000n);
  });

  it('幂等红线：同一 rechargeNo 重复充值，FundService.credit 收到的 idempotencyKey 相同', async () => {
    const svc = makeSvc();
    await svc.creditByRecharge(1n, { amount: 1000n, rechargeNo: 'R1' });
    await svc.creditByRecharge(1n, { amount: 1000n, rechargeNo: 'R1' });

    const k1 = fakeFund.credit.mock.calls[0]?.[0]?.idempotencyKey;
    const k2 = fakeFund.credit.mock.calls[1]?.[0]?.idempotencyKey;
    expect(k1).toBe('R1');
    expect(k2).toBe('R1');
  });

  it('金额 ≤ 0 → 抛 90002，且 FundService.credit 一次都没被调用', async () => {
    const svc = makeSvc();
    await expect(svc.creditByRecharge(1n, { amount: 0n, rechargeNo: 'R1' })).rejects.toMatchObject({
      code: ErrorCode.FIELD_FORMAT_INVALID,
    });
    await expect(svc.creditByRecharge(1n, { amount: -5n, rechargeNo: 'R1' })).rejects.toMatchObject({
      code: ErrorCode.FIELD_FORMAT_INVALID,
    });
    expect(fakeFund.credit).not.toHaveBeenCalled();
  });

  it('账户冻结 → 抛 61003，且 FundService.credit 未被调用', async () => {
    const svc = makeSvc();
    fakeFund.getOrCreateAccount.mockResolvedValue(snapshot('BAL-1', AccountStatus.FROZEN));
    await expect(svc.creditByRecharge(1n, { amount: 1000n, rechargeNo: 'R1' })).rejects.toMatchObject({
      code: ErrorCode.BALANCE_ACCOUNT_FROZEN,
    });
    expect(fakeFund.credit).not.toHaveBeenCalled();
  });

  it('事务红线：传入 tx 时，tx 被原样透传给 FundService.credit', async () => {
    const svc = makeSvc();
    const fakeTx = {} as TxClient;
    await svc.creditByRecharge(1n, { amount: 1000n, rechargeNo: 'R1' }, fakeTx);

    expect(fakeFund.credit).toHaveBeenCalledTimes(1);
    // 第二个入参即透传的事务客户端
    expect(fakeFund.credit.mock.calls[0]?.[1]).toBe(fakeTx);
    // 开户解析账户也用同一 tx
    expect(fakeFund.getOrCreateAccount.mock.calls[0]?.[2]).toBe(fakeTx);
  });

  it('事务红线（反向）：不传 tx 时自开 withTransaction，label 为 balance.recharge', async () => {
    const svc = makeSvc();
    await svc.creditByRecharge(1n, { amount: 1000n, rechargeNo: 'R1' });

    expect(withTransaction).toHaveBeenCalledTimes(1);
    const options = (withTransaction as unknown as jest.Mock<AnyAsyncFn>).mock.calls[0]?.[1] as {
      label?: string;
    };
    expect(options.label).toBe('balance.recharge');
  });
});
