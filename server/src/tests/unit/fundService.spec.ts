/**
 * @file server/src/tests/unit/fundService.spec.ts
 * @description 资金记账服务单测：假 Prisma 驱动，覆盖防超扣 / 事务红线 / 幂等 / 结转对 / bigint 类型红线
 * @module tests/unit
 * @see server/src/services/FundService.ts、docs/04-flows.md F6.2 / F6.6
 * @see prisma/schema.prisma:1092（FundAccount）、:1134（FundTransaction）
 * @author 软件开发团队
 * @created 2026-09-07
 *
 * 为什么必须有单测：环境无 MySQL 实例，而记账是资金链的地基。
 * 下面这些规则写错就是资损事故，且 tsc 完全查不出来：
 * - 出账必须带 `balance >= amount` 条件更新（read-then-write 在并发下必然超扣）；
 * - 条件更新 `count === 0` 必须抛错（否则流水写了、余额没扣，账目直接裂开）；
 * - 所有写操作必须发生在传入的 `tx` 上（退回默认 client 会让外部事务回滚失效）；
 * - 金额必须是 bigint（分），落到库里的不能是 number；
 * - 转账必须先 IN 后 OUT、两条流水共享 `txGroupNo`。
 *
 * 边界说明：**真实行锁串行化由 MySQL `FOR UPDATE` 保证，单元层无法验证**。
 * 本套件验证的是「代码走的是哪条路径、条件是否写对、写在哪一个 client 上」。
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Prisma } from '@prisma/client';
import {
  AccountStatus,
  FundAccountType,
  FundBizType,
  FundDirection,
  OperatorType,
} from '@/constants/enums';
import { ErrorCode } from '@/core/errors/errorCodes';
import { withTransaction } from '@/core/transaction';
import { FundService, type PostFundInput } from '@/services/FundService';

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

// 事务在这里被接管：由测试决定「执行闭包并传入假 tx」还是「直接抛错模拟回滚」
jest.mock('@/core/transaction', () => ({
  withTransaction: jest.fn(),
}));

/**
 * 事务闭包的假 tx。
 *
 * @description `FundService` 在事务内一律通过 `tx.xxx` 写库（不是外部单例），
 * 所以假 tx 必须提供自己的委托，且**与默认 client 是两套独立对象** ——
 * 只有这样才能断言「写操作没退回默认 client」。在 `beforeEach` 里重建。
 */
let FAKE_TX: Record<string, unknown>;

/**
 * 打桩函数类型。
 *
 * @description 这里必须用 `any` 而非 `unknown`：`@jest/globals` 会把 `Promise<unknown>`
 * 的解析类型推导成 `never`，导致 `mockResolvedValue(...)` 报 TS2345。打桩是通行例外。
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyAsyncFn = (...args: any[]) => Promise<any>;
/* eslint-enable @typescript-eslint/no-explicit-any */

/** 假客户端里 `fundAccount` / `fundTransaction` 两个委托的形状 */
interface Delegates {
  fundAccount: {
    findUnique: jest.Mock<AnyAsyncFn>;
    findFirst: jest.Mock<AnyAsyncFn>;
    create: jest.Mock<AnyAsyncFn>;
    updateMany: jest.Mock<AnyAsyncFn>;
  };
  fundTransaction: {
    create: jest.Mock<AnyAsyncFn>;
    findUnique: jest.Mock<AnyAsyncFn>;
  };
  $queryRaw: jest.Mock<AnyAsyncFn>;
}

/** 构造一套独立的假委托（默认 client 与假 tx 各一套，互不共享） */
function makeDelegates(): Delegates {
  return {
    fundAccount: {
      findUnique: jest.fn<AnyAsyncFn>(),
      findFirst: jest.fn<AnyAsyncFn>(),
      create: jest.fn<AnyAsyncFn>(),
      updateMany: jest.fn<AnyAsyncFn>(),
    },
    fundTransaction: {
      create: jest.fn<AnyAsyncFn>(),
      findUnique: jest.fn<AnyAsyncFn>(),
    },
    $queryRaw: jest.fn<AnyAsyncFn>(),
  };
}

/** 平台现金账户 */
const PLATFORM = { id: 1n, accountNo: 'ACC_PLATFORM_CASH' };
/** 用户余额账户 */
const USER = { id: 2n, accountNo: 'UB20260907000000000001' };

/** 构造 `SELECT ... FOR UPDATE` 的返回行（列名 snake_case，与 DB 一致） */
function makeLockRow(
  overrides: { id?: bigint; status?: AccountStatus; balance?: bigint; accountNo?: string } = {},
) {
  return [
    {
      id: overrides.id ?? USER.id,
      account_no: overrides.accountNo ?? USER.accountNo,
      account_type: FundAccountType.USER_BALANCE,
      status: (overrides.status ?? AccountStatus.ACTIVE) as string,
      balance: overrides.balance ?? 10_000n,
      frozen_balance: 0n,
      version: 0,
    },
  ];
}

/** 构造 Prisma P2002 唯一键冲突异常 */
function uniqueViolation(): unknown {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
  });
}

/** 基础记账入参 */
function baseInput(overrides: Partial<PostFundInput> = {}): PostFundInput {
  return {
    accountId: USER.id,
    amount: 1_000n,
    bizType: FundBizType.ORDER_PAY,
    operatorType: OperatorType.SYSTEM,
    operatorId: 0n,
    ...overrides,
  };
}

describe('FundService 资金记账', () => {
  /** 默认（非事务）客户端：用例 7 要断言它**没有**被调用 */
  let defaultClient: Delegates;
  /** 假 tx 的委托 */
  let txClient: Delegates;
  /** 被测试对象（默认 client） */
  let svc: FundService;

  beforeEach(() => {
    jest.clearAllMocks();

    defaultClient = makeDelegates();
    txClient = makeDelegates();

    FAKE_TX = {
      __fakeTx: true,
      fundAccount: txClient.fundAccount,
      fundTransaction: txClient.fundTransaction,
      $queryRaw: txClient.$queryRaw,
    };

    (withTransaction as unknown as jest.Mock<AnyAsyncFn>).mockImplementation(async (fn) =>
      fn(FAKE_TX),
    );

    // 两套 client 的默认返回保持一致
    for (const client of [defaultClient, txClient]) {
      client.$queryRaw.mockResolvedValue(makeLockRow());
      client.fundAccount.updateMany.mockResolvedValue({ count: 1 });
      client.fundTransaction.create.mockResolvedValue({ txNo: 'FT2026090700000001' });
      client.fundAccount.findUnique.mockResolvedValue(null);
      client.fundAccount.findFirst.mockResolvedValue(PLATFORM);
    }

    svc = new FundService(defaultClient as never);
  });

  // --------------------------------------------------------------------------
  // credit / debit
  // --------------------------------------------------------------------------

  it('入账：balance / totalIn 正确递增，流水 direction=IN，before/after 正确', async () => {
    txClient.$queryRaw.mockResolvedValue(makeLockRow({ balance: 10_000n }));

    const result = await svc.credit(baseInput({ amount: 1_000n }), FAKE_TX as never);

    const updateArg = txClient.fundAccount.updateMany.mock.calls[0]?.[0] as {
      data: { balance: { increment: bigint }; totalIn: { increment: bigint } };
    };
    expect(updateArg.data.balance.increment).toBe(1_000n);
    expect(updateArg.data.totalIn.increment).toBe(1_000n);

    const txArg = txClient.fundTransaction.create.mock.calls[0]?.[0] as {
      data: { direction: string; beforeBalance: bigint; afterBalance: bigint };
    };
    expect(txArg.data.direction).toBe(FundDirection.IN);
    expect(txArg.data.beforeBalance).toBe(10_000n);
    expect(txArg.data.afterBalance).toBe(11_000n);

    expect(result.beforeBalance).toBe(10_000n);
    expect(result.afterBalance).toBe(11_000n);
    expect(result.duplicated).toBe(false);
  });

  it('出账：balance / totalOut 正确，余额不足抛错（61002）', async () => {
    txClient.$queryRaw.mockResolvedValue(makeLockRow({ balance: 500n }));

    await expect(svc.debit(baseInput({ amount: 1_000n }), FAKE_TX as never)).rejects.toMatchObject({
      code: ErrorCode.BALANCE_NOT_ENOUGH,
    });

    // 关键：余额不足时绝不写流水、绝不更新余额
    expect(txClient.fundTransaction.create).not.toHaveBeenCalled();
    expect(txClient.fundAccount.updateMany).not.toHaveBeenCalled();
  });

  it('防超扣红线：出账的 updateMany.where 必须带 balance: { gte: amount }', async () => {
    txClient.$queryRaw.mockResolvedValue(makeLockRow({ balance: 10_000n }));

    await svc.debit(baseInput({ amount: 3_000n }), FAKE_TX as never);

    const arg = txClient.fundAccount.updateMany.mock.calls[0]?.[0] as {
      where: { id: bigint; balance?: { gte: bigint } };
      data: { balance: { decrement: bigint }; totalOut: { increment: bigint } };
    };
    // 漏了这个条件就是 read-then-write，并发下必然超扣（资金事故）
    expect(arg.where.id).toBe(USER.id);
    expect(arg.where.balance).toEqual({ gte: 3_000n });
    expect(arg.data.balance.decrement).toBe(3_000n);
    expect(arg.data.totalOut.increment).toBe(3_000n);
  });

  it('并发出账：条件更新 count=0 → 抛错，余额与流水都不落库', async () => {
    txClient.$queryRaw.mockResolvedValue(makeLockRow({ balance: 10_000n }));
    txClient.fundAccount.updateMany.mockResolvedValue({ count: 0 }); // 并发抢先扣走了

    await expect(svc.debit(baseInput({ amount: 1_000n }), FAKE_TX as never)).rejects.toMatchObject({
      code: ErrorCode.BALANCE_NOT_ENOUGH,
    });

    // 流水确实写了（在同一事务内会随之回滚），但绝不能当作成功返回
    expect(txClient.fundTransaction.create).toHaveBeenCalledTimes(1);
    expect(txClient.fundAccount.updateMany).toHaveBeenCalledTimes(1);
  });

  it('类型红线：落库 amount / beforeBalance / afterBalance 全是 bigint 而非 number', async () => {
    txClient.$queryRaw.mockResolvedValue(makeLockRow({ balance: 10_000n }));

    await svc.credit(baseInput({ amount: 1_000n }), FAKE_TX as never);

    const txArg = txClient.fundTransaction.create.mock.calls[0]?.[0] as {
      data: { amount: unknown; beforeBalance: unknown; afterBalance: unknown };
    };
    expect(typeof txArg.data.amount).toBe('bigint');
    expect(typeof txArg.data.beforeBalance).toBe('bigint');
    expect(typeof txArg.data.afterBalance).toBe('bigint');

    const updateArg = txClient.fundAccount.updateMany.mock.calls[0]?.[0] as {
      data: { balance: { increment: unknown } };
    };
    expect(typeof updateArg.data.balance.increment).toBe('bigint');
  });

  it('金额非正数 → 拒绝记账（90002），绝不写库', async () => {
    await expect(svc.credit(baseInput({ amount: 0n }), FAKE_TX as never)).rejects.toMatchObject({
      code: ErrorCode.FIELD_FORMAT_INVALID,
    });
    await expect(svc.debit(baseInput({ amount: -1n }), FAKE_TX as never)).rejects.toMatchObject({
      code: ErrorCode.FIELD_FORMAT_INVALID,
    });
    expect(txClient.fundTransaction.create).not.toHaveBeenCalled();
    expect(txClient.fundAccount.updateMany).not.toHaveBeenCalled();
  });

  it('账户不存在 → 拒绝记账（61001）', async () => {
    txClient.$queryRaw.mockResolvedValue([]);

    await expect(svc.credit(baseInput(), FAKE_TX as never)).rejects.toMatchObject({
      code: ErrorCode.BALANCE_ACCOUNT_NOT_FOUND,
    });
    expect(txClient.fundTransaction.create).not.toHaveBeenCalled();
  });

  it('账户已冻结（status=FROZEN）→ 拒绝记账（61003）', async () => {
    txClient.$queryRaw.mockResolvedValue(makeLockRow({ status: AccountStatus.FROZEN }));

    await expect(svc.debit(baseInput(), FAKE_TX as never)).rejects.toMatchObject({
      code: ErrorCode.BALANCE_ACCOUNT_FROZEN,
    });
    expect(txClient.fundTransaction.create).not.toHaveBeenCalled();
    expect(txClient.fundAccount.updateMany).not.toHaveBeenCalled();
  });

  it('行锁：记账前必须 SELECT ... FOR UPDATE（否则 before/after 快照会错）', async () => {
    await svc.debit(baseInput(), FAKE_TX as never);

    const sql = txClient.$queryRaw.mock.calls[0]?.[0] as TemplateStringsArray | string[];
    const text = Array.isArray(sql) || typeof sql === 'object' ? (sql as string[]).join('?') : String(sql);
    expect(text.toUpperCase()).toContain('FOR UPDATE');
    expect(text.toUpperCase()).toContain('FUND_ACCOUNTS');
  });

  // --------------------------------------------------------------------------
  // 幂等
  // --------------------------------------------------------------------------

  it('幂等：同一 txNo 重复入账只记一次（P2002 → 返回已有流水，不重复加余额）', async () => {
    txClient.$queryRaw.mockResolvedValue(makeLockRow({ balance: 10_000n }));
    // 第二次插入撞 tx_no 唯一键
    txClient.fundTransaction.create
      .mockResolvedValueOnce({ txNo: 'FT-FIXED-001' })
      .mockRejectedValueOnce(uniqueViolation());

    const first = await svc.credit(baseInput({ txNo: 'FT-FIXED-001' }), FAKE_TX as never);
    const second = await svc.credit(baseInput({ txNo: 'FT-FIXED-001' }), FAKE_TX as never);

    expect(first.duplicated).toBe(false);
    expect(second.duplicated).toBe(true);
    expect(second.txNo).toBe('FT-FIXED-001');
    // 关键：幂等命中时绝不第二次动余额
    expect(txClient.fundAccount.updateMany).toHaveBeenCalledTimes(1);
  });

  it('幂等：非 P2002 的插入异常原样抛出（不能被误判成幂等命中）', async () => {
    txClient.fundTransaction.create.mockRejectedValue(new Error('deadlock found'));

    await expect(svc.credit(baseInput(), FAKE_TX as never)).rejects.toThrow('deadlock found');
    expect(txClient.fundAccount.updateMany).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // 事务红线
  // --------------------------------------------------------------------------

  it('事务红线：传入 tx 时所有写操作都在 tx 上，绝不退回默认 client', async () => {
    txClient.$queryRaw.mockResolvedValue(makeLockRow());

    await svc.credit(baseInput(), FAKE_TX as never);

    expect(txClient.$queryRaw).toHaveBeenCalled();
    expect(txClient.fundTransaction.create).toHaveBeenCalled();
    expect(txClient.fundAccount.updateMany).toHaveBeenCalled();

    // 默认 client 一次都不能被调用，否则外部事务回滚时账务回不去
    expect(defaultClient.$queryRaw).not.toHaveBeenCalled();
    expect(defaultClient.fundTransaction.create).not.toHaveBeenCalled();
    expect(defaultClient.fundAccount.updateMany).not.toHaveBeenCalled();
  });

  it('事务红线：debit 同样只写 tx', async () => {
    txClient.$queryRaw.mockResolvedValue(makeLockRow());

    await svc.debit(baseInput(), FAKE_TX as never);

    expect(defaultClient.fundAccount.updateMany).not.toHaveBeenCalled();
    expect(defaultClient.fundTransaction.create).not.toHaveBeenCalled();
    expect(defaultClient.$queryRaw).not.toHaveBeenCalled();
  });

  it('事务红线：credit 不传 tx 时自开事务（label=fund.credit），不退回默认 client', async () => {
    txClient.$queryRaw.mockResolvedValue(makeLockRow());

    await svc.credit(baseInput());

    expect(withTransaction).toHaveBeenCalledTimes(1);
    const options = (withTransaction as unknown as jest.Mock<AnyAsyncFn>).mock.calls[0]?.[1] as {
      label: string;
    };
    expect(options.label).toBe('fund.credit');

    // 行锁与余额更新都发生在新开事务的 client 上，默认 client 一次都没碰
    expect(txClient.$queryRaw).toHaveBeenCalled();
    expect(txClient.fundAccount.updateMany).toHaveBeenCalled();
    expect(defaultClient.$queryRaw).not.toHaveBeenCalled();
    expect(defaultClient.fundAccount.updateMany).not.toHaveBeenCalled();
  });

  it('事务红线：debit 不传 tx 时自开事务（label=fund.debit），不退回默认 client', async () => {
    txClient.$queryRaw.mockResolvedValue(makeLockRow());

    await svc.debit(baseInput());

    expect(withTransaction).toHaveBeenCalledTimes(1);
    const options = (withTransaction as unknown as jest.Mock<AnyAsyncFn>).mock.calls[0]?.[1] as {
      label: string;
    };
    expect(options.label).toBe('fund.debit');

    expect(txClient.$queryRaw).toHaveBeenCalled();
    expect(txClient.fundAccount.updateMany).toHaveBeenCalled();
    expect(defaultClient.$queryRaw).not.toHaveBeenCalled();
    expect(defaultClient.fundAccount.updateMany).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // transfer
  // --------------------------------------------------------------------------

  it('转账：一个 txGroupNo 下两笔流水（先 IN 后 OUT），两个账户余额都正确变化', async () => {
    // 按锁读的 accountId 返回对应账户行（模板字符串的第二个实参即 ${accountId}）
    txClient.$queryRaw.mockImplementation(async (...args: unknown[]) => {
      const accountId = args[1] as bigint;
      return accountId === PLATFORM.id
        ? makeLockRow({ id: PLATFORM.id, accountNo: PLATFORM.accountNo, balance: 0n })
        : makeLockRow({ id: USER.id, balance: 20_000n });
    });

    const result = await svc.transfer(
      {
        fromAccountId: USER.id,
        toAccountId: PLATFORM.id,
        amount: 5_000n,
        bizType: FundBizType.BALANCE_CONSUME,
        inBizType: FundBizType.LIABILITY_SETTLE_IN,
        operatorType: OperatorType.SYSTEM,
        operatorId: 0n,
      },
      FAKE_TX as never,
    );

    // 同一个交易组号绑定结转对（FundResult 不暴露 txGroupNo，故直接断言落库的 create 入参）
    expect(result.txGroupNo).toEqual(expect.any(String));
    const inTx = txClient.fundTransaction.create.mock.calls[0]?.[0] as {
      data: { txGroupNo: string; direction: string; accountId: bigint; beforeBalance: bigint; afterBalance: bigint };
    };
    const outTx = txClient.fundTransaction.create.mock.calls[1]?.[0] as {
      data: { txGroupNo: string; direction: string; accountId: bigint; beforeBalance: bigint; afterBalance: bigint };
    };
    expect(inTx.data.direction).toBe(FundDirection.IN);
    expect(outTx.data.direction).toBe(FundDirection.OUT);
    expect(inTx.data.txGroupNo).toBe(result.txGroupNo);
    expect(outTx.data.txGroupNo).toBe(result.txGroupNo);

    // 入账侧（平台）：0 → 5000；出账侧（用户）：20000 → 15000
    expect(inTx.data.accountId).toBe(PLATFORM.id);
    expect(inTx.data.beforeBalance).toBe(0n);
    expect(inTx.data.afterBalance).toBe(5_000n);
    expect(outTx.data.accountId).toBe(USER.id);
    expect(outTx.data.beforeBalance).toBe(20_000n);
    expect(outTx.data.afterBalance).toBe(15_000n);

    expect(txClient.fundAccount.updateMany).toHaveBeenCalledTimes(2);
  });

  it('转账：出账方余额不足 → 抛错，入账侧不落余额（同事务回滚）', async () => {
    txClient.$queryRaw.mockImplementation(async (...args: unknown[]) => {
      const accountId = args[1] as bigint;
      return accountId === PLATFORM.id
        ? makeLockRow({ id: PLATFORM.id, accountNo: PLATFORM.accountNo, balance: 0n })
        : makeLockRow({ id: USER.id, balance: 100n }); // 用户余额 1 分，转 5000 分必失败
    });

    await expect(
      svc.transfer(
        {
          fromAccountId: USER.id,
          toAccountId: PLATFORM.id,
          amount: 5_000n,
          bizType: FundBizType.BALANCE_CONSUME,
          operatorType: OperatorType.SYSTEM,
          operatorId: 0n,
        },
        FAKE_TX as never,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.BALANCE_NOT_ENOUGH });

    // 出账侧抛错 → 整个事务回滚，入账侧的余额变更在 DB 层一并回滚（单元层只能断言未走到出账更新）
    expect(txClient.fundAccount.updateMany).toHaveBeenCalledTimes(1); // 只有入账侧那次
    expect(txClient.fundTransaction.create).toHaveBeenCalledTimes(1);
  });

  it('转账：未传 tx 时自开事务（保证两条流水 + 两个余额变更原子）', async () => {
    txClient.$queryRaw.mockResolvedValue(makeLockRow({ balance: 20_000n }));

    await svc.transfer({
      fromAccountId: USER.id,
      toAccountId: PLATFORM.id,
      amount: 5_000n,
      bizType: FundBizType.BALANCE_CONSUME,
      operatorType: OperatorType.SYSTEM,
      operatorId: 0n,
    });

    expect(withTransaction).toHaveBeenCalledTimes(1);
    const options = (withTransaction as unknown as jest.Mock<AnyAsyncFn>).mock.calls[0]?.[1] as {
      label: string;
    };
    expect(options.label).toBe('fund.transfer');
  });

  it('转账：收付账户相同 → 拒绝（90002）', async () => {
    await expect(
      svc.transfer(
        {
          fromAccountId: USER.id,
          toAccountId: USER.id,
          amount: 100n,
          bizType: FundBizType.BALANCE_CONSUME,
          operatorType: OperatorType.SYSTEM,
          operatorId: 0n,
        },
        FAKE_TX as never,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.FIELD_FORMAT_INVALID });
    expect(txClient.fundTransaction.create).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // getOrCreateAccount
  // --------------------------------------------------------------------------

  it('getOrCreateAccount：按 uk_user_account 命中已有账户，不新建', async () => {
    const existing = {
      id: 2n,
      accountNo: USER.accountNo,
      accountType: FundAccountType.USER_BALANCE,
      status: AccountStatus.ACTIVE,
      balance: 12_345n,
      frozenBalance: 0n,
      version: 3,
    };
    txClient.fundAccount.findUnique.mockResolvedValue(existing);

    const account = await svc.getOrCreateAccount(1n, FundAccountType.USER_BALANCE, FAKE_TX as never);

    expect(account.id).toBe(2n);
    expect(account.balance).toBe(12_345n);
    const arg = txClient.fundAccount.findUnique.mock.calls[0]?.[0] as {
      where: { userId_accountType: { userId: bigint; accountType: string } };
    };
    expect(arg.where.userId_accountType.userId).toBe(1n);
    expect(arg.where.userId_accountType.accountType).toBe(FundAccountType.USER_BALANCE);
    expect(txClient.fundAccount.create).not.toHaveBeenCalled();
  });

  it('getOrCreateAccount：不存在时开户，账户号确定性生成（重试不会产生第二个账号）', async () => {
    txClient.fundAccount.findUnique.mockResolvedValue(null);
    txClient.fundAccount.create.mockResolvedValue({
      id: 9n,
      accountNo: 'UB20260907000000000001',
      accountType: FundAccountType.USER_BALANCE,
      status: AccountStatus.ACTIVE,
      balance: 0n,
      frozenBalance: 0n,
      version: 0,
    });

    const account = await svc.getOrCreateAccount(1n, FundAccountType.USER_BALANCE, FAKE_TX as never);

    expect(account.id).toBe(9n);
    const arg = txClient.fundAccount.create.mock.calls[0]?.[0] as {
      data: { accountNo: string; accountType: string; userId: bigint; balance: bigint };
    };
    expect(arg.data.accountNo).toContain('UB');
    expect(arg.data.userId).toBe(1n);
    expect(arg.data.balance).toBe(0n);
  });

  it('getOrCreateAccount：并发开户撞 uk_user_account → 重读返回，不抛错', async () => {
    txClient.fundAccount.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 9n,
        accountNo: USER.accountNo,
        accountType: FundAccountType.USER_BALANCE,
        status: AccountStatus.ACTIVE,
        balance: 0n,
        frozenBalance: 0n,
        version: 0,
      });
    txClient.fundAccount.create.mockRejectedValue(uniqueViolation());

    const account = await svc.getOrCreateAccount(1n, FundAccountType.USER_BALANCE, FAKE_TX as never);

    expect(account.id).toBe(9n);
  });

  it('getOrCreateAccount：PLATFORM_CASH 被显式拒绝（userId=NULL 会绕过唯一约束）', async () => {
    await expect(
      svc.getOrCreateAccount(0n, FundAccountType.PLATFORM_CASH, FAKE_TX as never),
    ).rejects.toMatchObject({ code: ErrorCode.FUND_RECORD_FAILED });
    expect(txClient.fundAccount.create).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // 余额支付 / 退款结算原语（F6.6 / F9.3 负债结转对）
  // --------------------------------------------------------------------------

  /** 用户余额账户快照（getOrCreateAccount 命中已有账户，不新建） */
  const USER_SNAPSHOT = {
    id: USER.id,
    accountNo: USER.accountNo,
    accountType: FundAccountType.USER_BALANCE,
    status: AccountStatus.ACTIVE,
    balance: 100_000n,
    frozenBalance: 0n,
    version: 0,
  };

  /** 按账户 id 返回对应的 FOR UPDATE 锁行（用户 / 平台两套余额） */
  const settleLockRows = (): void => {
    txClient.$queryRaw.mockImplementation(async (...args: unknown[]) => {
      const accountId = args[1] as bigint;
      return accountId === PLATFORM.id
        ? makeLockRow({ id: PLATFORM.id, accountNo: PLATFORM.accountNo, balance: 50_000n })
        : makeLockRow({ id: USER.id, balance: 100_000n });
    });
  };

  it('recordBalancePayment：写三条流水，方向/isLiability/账户/对手方/orderNo/paymentNo 正确，且全走 tx', async () => {
    txClient.fundAccount.findUnique.mockResolvedValue(USER_SNAPSHOT);
    txClient.fundAccount.findFirst.mockResolvedValue({ id: PLATFORM.id, accountNo: PLATFORM.accountNo });
    settleLockRows();

    const result = await svc.recordBalancePayment(
      {
        userId: 7n,
        amount: 2_000n,
        orderNo: 'SO2026091000000001',
        paymentNo: 'P2026091000000001',
        operatorType: OperatorType.SYSTEM,
        operatorId: 0n,
      },
      FAKE_TX as never,
    );

    // 三条流水共享同一 txGroupNo
    expect(result.txGroupNo).toEqual(expect.any(String));
    const [userTx, platInTx, platOutTx] = txClient.fundTransaction.create.mock.calls.map(
      (c) => (c[0] as { data: Record<string, unknown> }).data,
    );
    expect(userTx.txGroupNo).toBe(result.txGroupNo);
    expect(platInTx.txGroupNo).toBe(result.txGroupNo);
    expect(platOutTx.txGroupNo).toBe(result.txGroupNo);

    // ① 用户余额 OUT（BALANCE_CONSUME，恒 false）
    expect(userTx.direction).toBe(FundDirection.OUT);
    expect(userTx.bizType).toBe(FundBizType.BALANCE_CONSUME);
    expect(userTx.isLiability).toBe(false);
    expect(userTx.accountId).toBe(USER.id);
    expect(userTx.counterpartyAccountId).toBe(PLATFORM.id);
    expect(userTx.orderNo).toBe('SO2026091000000001');
    expect(userTx.paymentNo).toBe('P2026091000000001');

    // ② 平台结转 IN（LIABILITY_SETTLE_IN，支付口径 isLiability=false：负债转收入）
    expect(platInTx.direction).toBe(FundDirection.IN);
    expect(platInTx.bizType).toBe(FundBizType.LIABILITY_SETTLE_IN);
    expect(platInTx.isLiability).toBe(false);
    expect(platInTx.accountId).toBe(PLATFORM.id);
    expect(platInTx.counterpartyAccountId).toBe(USER.id);

    // ③ 平台结转 OUT（LIABILITY_SETTLE_OUT，支付口径 isLiability=true：冲减负债）
    expect(platOutTx.direction).toBe(FundDirection.OUT);
    expect(platOutTx.bizType).toBe(FundBizType.LIABILITY_SETTLE_OUT);
    expect(platOutTx.isLiability).toBe(true);
    expect(platOutTx.accountId).toBe(PLATFORM.id);
    expect(platOutTx.counterpartyAccountId).toBe(USER.id);
    expect(platOutTx.paymentNo).toBe('P2026091000000001');

    // 事务红线：全写 tx，默认 client 零调用
    expect(defaultClient.fundTransaction.create).not.toHaveBeenCalled();
    expect(defaultClient.fundAccount.updateMany).not.toHaveBeenCalled();
    expect(defaultClient.fundAccount.findUnique).not.toHaveBeenCalled();
  });

  it('recordBalanceRefund：反向结转对（与支付口径取反）—— BALANCE_REFUND=false、LIABILITY_SETTLE_IN=**true**、LIABILITY_SETTLE_OUT=**false**，方向 IN/IN/OUT', async () => {
    txClient.fundAccount.findUnique.mockResolvedValue(USER_SNAPSHOT);
    txClient.fundAccount.findFirst.mockResolvedValue({ id: PLATFORM.id, accountNo: PLATFORM.accountNo });
    settleLockRows();

    const result = await svc.recordBalanceRefund(
      {
        userId: 7n,
        amount: 2_000n,
        orderNo: 'SO2026091000000001',
        refundNo: 'SR2026091000000001',
        operatorType: OperatorType.SYSTEM,
        operatorId: 0n,
      },
      FAKE_TX as never,
    );

    const [userTx, platInTx, platOutTx] = txClient.fundTransaction.create.mock.calls.map(
      (c) => (c[0] as { data: Record<string, unknown> }).data,
    );

    // ① 用户余额 IN（BALANCE_REFUND，恒 false）
    expect(userTx.direction).toBe(FundDirection.IN);
    expect(userTx.bizType).toBe(FundBizType.BALANCE_REFUND);
    expect(userTx.isLiability).toBe(false);
    expect(userTx.accountId).toBe(USER.id);
    expect(userTx.counterpartyAccountId).toBe(PLATFORM.id);
    expect(userTx.refundNo).toBe('SR2026091000000001');

    // ② 平台结转 IN（⚠️ 反向结转：isLiability=true 负债增）
    expect(platInTx.direction).toBe(FundDirection.IN);
    expect(platInTx.bizType).toBe(FundBizType.LIABILITY_SETTLE_IN);
    expect(platInTx.isLiability).toBe(true);
    expect(platInTx.accountId).toBe(PLATFORM.id);
    expect(platInTx.counterpartyAccountId).toBe(USER.id);

    // ③ 平台结转 OUT（⚠️ 反向结转：isLiability=false 收入减）
    expect(platOutTx.direction).toBe(FundDirection.OUT);
    expect(platOutTx.bizType).toBe(FundBizType.LIABILITY_SETTLE_OUT);
    expect(platOutTx.isLiability).toBe(false);
    expect(platOutTx.accountId).toBe(PLATFORM.id);
    expect(platOutTx.counterpartyAccountId).toBe(USER.id);

    expect(result.txGroupNo).toEqual(expect.any(String));

    // 事务红线：全写 tx
    expect(defaultClient.fundTransaction.create).not.toHaveBeenCalled();
    expect(defaultClient.fundAccount.updateMany).not.toHaveBeenCalled();
  });

  it('recordBalancePayment：用户余额不足 → 抛 61002，且不写任何流水（事务回滚）', async () => {
    txClient.fundAccount.findUnique.mockResolvedValue(USER_SNAPSHOT);
    txClient.fundAccount.findFirst.mockResolvedValue({ id: PLATFORM.id, accountNo: PLATFORM.accountNo });
    // 用户余额锁行只有 500 分，支付 1000 分必失败
    txClient.$queryRaw.mockImplementation(async (...args: unknown[]) => {
      const accountId = args[1] as bigint;
      return accountId === PLATFORM.id
        ? makeLockRow({ id: PLATFORM.id, accountNo: PLATFORM.accountNo, balance: 50_000n })
        : makeLockRow({ id: USER.id, balance: 500n });
    });

    await expect(
      svc.recordBalancePayment(
        {
          userId: 7n,
          amount: 1_000n,
          orderNo: 'SO2026091000000001',
          paymentNo: 'P2026091000000001',
          operatorType: OperatorType.SYSTEM,
          operatorId: 0n,
        },
        FAKE_TX as never,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.BALANCE_NOT_ENOUGH });

    // 余额不足在 doPost 内于「写流水」之前即抛错：不落任何流水、不动任何余额
    expect(txClient.fundTransaction.create).not.toHaveBeenCalled();
    expect(txClient.fundAccount.updateMany).not.toHaveBeenCalled();
  });

  it('recordBalancePayment：平台现金账户不存在 → 抛 60001，绝不自动创建', async () => {
    txClient.fundAccount.findUnique.mockResolvedValue(USER_SNAPSHOT);
    txClient.fundAccount.findFirst.mockResolvedValue(null); // 平台账户缺失

    await expect(
      svc.recordBalancePayment(
        {
          userId: 7n,
          amount: 1_000n,
          orderNo: 'SO2026091000000001',
          paymentNo: 'P2026091000000001',
          operatorType: OperatorType.SYSTEM,
          operatorId: 0n,
        },
        FAKE_TX as never,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.FUND_RECORD_FAILED });

    expect(txClient.fundTransaction.create).not.toHaveBeenCalled();
  });
});
