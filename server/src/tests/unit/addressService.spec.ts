/**
 * @file server/src/tests/unit/addressService.spec.ts
 * @description 收货地址领域服务单测（假 Prisma 打桩，不连真实 DB）
 * @module tests/unit
 * @see server/src/services/AddressService.ts、docs/04-flows.md（F5 下单流程：T011）
 * @author 软件开发团队
 * @created 2026-09-07
 *
 * 为什么必须有单测：环境无 MySQL / Redis 实例，地址「默认互斥 / 首个自动默认 / 软删 /
 * 越权防护 / 删除后默认递补」这些规则无法靠 tsc 验证，一旦写错就是越权或默认地址丢失。
 * 用注入构造参数的假 Prisma 驱动，不依赖真实实例。
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Address } from '@prisma/client';
import { BusinessError } from '@/core/errors';
import { ErrorCode } from '@/core/errors/errorCodes';
import { AddressService } from '@/services/AddressService';

// config 在模块加载时即被 logger 读取（config.log.level），没有 .env 用假 config 注入固定值，否则套件起不来
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

// 单例在模块加载时会调用 getPrisma()，返回占位对象；事务入口 $transaction 在调用时再回传已初始化的
// fakePrisma。注意：jest.mock 工厂会被 hoist 到文件顶部，不能直接引用下方的 `const fakePrisma`
// （会触发「声明前使用」报错与 TDZ），故改为调用同样会被 hoist 的函数 getFakePrisma() 间接取用。
function getFakePrisma(): FakePrisma {
  return fakePrisma;
}

jest.mock('@/core/prisma', () => ({
  getPrisma: jest.fn(() => ({
    $transaction: (fn: (tx: FakePrisma) => Promise<unknown>) => fn(getFakePrisma()),
  })),
}));

/** 任意入参（测试只断言 where，不强求具体形状） */
type AnyArgs = Record<string, unknown>;

/** 假 address 委托（仅列出 service 实际用到的方法） */
interface FakeAddressDelegate {
  findMany: jest.Mock<(args: AnyArgs) => Promise<Address[]>>;
  findFirst: jest.Mock<(args: AnyArgs) => Promise<Address | null>>;
  count: jest.Mock<(args: AnyArgs) => Promise<number>>;
  create: jest.Mock<(args: AnyArgs) => Promise<Address>>;
  update: jest.Mock<(args: AnyArgs) => Promise<Address>>;
  updateMany: jest.Mock<(args: AnyArgs) => Promise<{ count: number }>>;
  deleteMany: jest.Mock<(args: AnyArgs) => Promise<{ count: number }>>;
}

/** 假 Prisma（含事务入口，事务内回传自身以复用同一份假委托） */
interface FakePrisma {
  $transaction: jest.Mock<(fn: (tx: FakePrisma) => Promise<unknown>) => Promise<unknown>>;
  address: FakeAddressDelegate;
}

/**
 * 构造一个 Address 形态对象（含全部字段，测试只关心其中部分）。
 *
 * @param over 覆盖字段
 * @returns 假 Address
 */
function makeAddr(over: Partial<Address> = {}): Address {
  const now = new Date();
  return {
    id: 1n,
    userId: 1n,
    receiverName: '张三',
    phone: '13800000000',
    provinceCode: '33',
    provinceName: '浙江省',
    cityCode: '3301',
    cityName: '杭州市',
    districtCode: '330106',
    districtName: '西湖区',
    detailAddress: '文三路 100 号',
    tag: null,
    isDefault: false,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    ...over,
  } as unknown as Address;
}

/** 测试用假 Prisma（仅含 address 委托 + 事务入口） */
const fakePrisma: FakePrisma = {
  $transaction: jest.fn<(fn: (tx: FakePrisma) => Promise<unknown>) => Promise<unknown>>(
    async (fn) => fn(fakePrisma),
  ),
  address: {
    findMany: jest.fn<(args: AnyArgs) => Promise<Address[]>>(),
    findFirst: jest.fn<(args: AnyArgs) => Promise<Address | null>>(),
    count: jest.fn<(args: AnyArgs) => Promise<number>>(),
    create: jest.fn<(args: AnyArgs) => Promise<Address>>(),
    update: jest.fn<(args: AnyArgs) => Promise<Address>>(),
    updateMany: jest.fn<(args: AnyArgs) => Promise<{ count: number }>>(),
    deleteMany: jest.fn<(args: AnyArgs) => Promise<{ count: number }>>(),
  },
};

/** 用假 prisma 构造一个 AddressService */
function makeSvc(): AddressService {
  return new AddressService(fakePrisma as unknown as ConstructorParameters<typeof AddressService>[0]);
}

/** 取某 mock 最近一次调用的 where（越权防护断言用） */
function lastWhere(mock: { mock: { calls: unknown[][] } }, index = 0): AnyArgs {
  const call = mock.mock.calls[mock.mock.calls.length - 1 - index]?.[0] as AnyArgs | undefined;
  return (call?.where ?? {}) as AnyArgs;
}

// ---------------------------------------------------------------------------
// 默认打桩（每个用例前重置，避免互相污染）
// ---------------------------------------------------------------------------

beforeEach(() => {
  fakePrisma.address.findMany.mockReset();
  fakePrisma.address.findFirst.mockReset();
  fakePrisma.address.count.mockReset();
  fakePrisma.address.create.mockReset();
  fakePrisma.address.update.mockReset();
  fakePrisma.address.updateMany.mockReset();

  // findOwned / findFirst 默认返回一条「非默认、有效」的地址
  fakePrisma.address.findFirst.mockResolvedValue(makeAddr({ id: 1n, userId: 1n, isDefault: false }));
  // 列表默认空
  fakePrisma.address.findMany.mockResolvedValue([]);
  // 默认已有 1 条有效地址（首个自动默认之外的常规场景）
  fakePrisma.address.count.mockResolvedValue(1);
  // create / update 默认原样返回（会被用例覆盖）
  fakePrisma.address.create.mockImplementation(async (args: AnyArgs) => makeAddr(args.data as Partial<Address>));
  fakePrisma.address.update.mockImplementation(async (args: AnyArgs) => makeAddr(args.data as Partial<Address>));
  fakePrisma.address.updateMany.mockResolvedValue({ count: 1 });
});

// ---------------------------------------------------------------------------
// 越权防护：每个查询都带 userId
// ---------------------------------------------------------------------------

describe('AddressService 越权防护', () => {
  it('list 的 where 必须带 userId 与 deletedAt:null', async () => {
    const svc = makeSvc();
    await svc.list(1n);
    const where = lastWhere(fakePrisma.address.findMany);
    expect(where.userId).toBe(1n);
    expect(where.deletedAt).toBeNull();
  });

  it('findOwned（修改/删除/设为默认前）where 同时带 id 与 userId 与 deletedAt:null', async () => {
    const svc = makeSvc();
    // update 成功路径：先 findOwned 取现有（带 userId）
    fakePrisma.address.findFirst.mockResolvedValue(makeAddr({ id: 5n, userId: 1n, isDefault: false }));
    await svc.update(1n, 5n, { receiverName: '李四' });
    const where = lastWhere(fakePrisma.address.findFirst);
    expect(where.userId).toBe(1n);
    expect(where.id).toBe(5n);
    expect(where.deletedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 首个地址自动默认 + 默认地址互斥
// ---------------------------------------------------------------------------

describe('AddressService 默认地址互斥', () => {
  it('首个地址（count=0）即便未要求也自动设为默认', async () => {
    const svc = makeSvc();
    fakePrisma.address.count.mockResolvedValue(0); // 没有任何地址

    await svc.create(1n, {
      receiverName: '张三',
      phone: '13800000000',
      provinceCode: '33',
      provinceName: '浙江省',
      cityCode: '3301',
      cityName: '杭州市',
      districtCode: '330106',
      districtName: '西湖区',
      detailAddress: '文三路 100 号',
      tag: null,
      isDefault: false, // 显式不要默认
    });

    // 事务内先取消其它默认，再新建（isDefault=true）
    expect(fakePrisma.address.updateMany).toHaveBeenCalled();
    const created = fakePrisma.address.create.mock.calls[0]?.[0]?.data as { isDefault?: boolean };
    expect(created.isDefault).toBe(true);
  });

  it('已有地址时新建并设为默认 → 取消旧的默认，新地址成为唯一默认', async () => {
    const svc = makeSvc();
    fakePrisma.address.count.mockResolvedValue(1); // 已有 1 条

    await svc.create(1n, {
      receiverName: '张三',
      phone: '13800000000',
      provinceCode: '33',
      provinceName: '浙江省',
      cityCode: '3301',
      cityName: '杭州市',
      districtCode: '330106',
      districtName: '西湖区',
      detailAddress: '文三路 100 号',
      tag: null,
      isDefault: true, // 要求成为默认
    });

    // 事务内取消其它默认：where 必须带 userId 且 isDefault:true（互斥核心）
    const cancelWhere = (fakePrisma.address.updateMany.mock.calls[0]?.[0]?.where ?? {}) as {
      userId?: bigint;
      isDefault?: boolean;
    };
    expect(cancelWhere.userId).toBe(1n);
    expect(cancelWhere.isDefault).toBe(true);

    const created = fakePrisma.address.create.mock.calls[0]?.[0]?.data as { isDefault?: boolean };
    expect(created.isDefault).toBe(true);
  });

  it('非默认新增（已存在其它地址）不触发取消默认，直接建 isDefault=false', async () => {
    const svc = makeSvc();
    fakePrisma.address.count.mockResolvedValue(1);

    await svc.create(1n, {
      receiverName: '张三',
      phone: '13800000000',
      provinceCode: '33',
      provinceName: '浙江省',
      cityCode: '3301',
      cityName: '杭州市',
      districtCode: '330106',
      districtName: '西湖区',
      detailAddress: '文三路 100 号',
      tag: null,
      // 不传 isDefault
    });

    expect(fakePrisma.address.updateMany).not.toHaveBeenCalled();
    const created = fakePrisma.address.create.mock.calls[0]?.[0]?.data as { isDefault?: boolean };
    expect(created.isDefault).toBe(false);
  });

  it('setDefault 事务内先取消其它默认（排除自己），再置本条默认', async () => {
    const svc = makeSvc();
    // 当前默认是 id=2，要切到 id=5
    fakePrisma.address.findFirst.mockResolvedValue(makeAddr({ id: 5n, userId: 1n, isDefault: false }));

    await svc.setDefault(1n, 5n);

    const cancelWhere = (fakePrisma.address.updateMany.mock.calls[0]?.[0]?.where ?? {}) as {
      userId?: bigint;
      isDefault?: boolean;
      id?: { not?: bigint };
    };
    expect(cancelWhere.userId).toBe(1n);
    expect(cancelWhere.isDefault).toBe(true);
    expect(cancelWhere.id?.not).toBe(5n); // 排除自己，避免把自己也取消

    const updateData = (fakePrisma.address.update.mock.calls[0]?.[0]?.data ?? {}) as { isDefault?: boolean };
    expect(updateData.isDefault).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 软删 + 删除后默认地址自动递补
// ---------------------------------------------------------------------------

describe('AddressService 软删与默认地址递补', () => {
  it('删除非默认地址 → 软删（update 置 deletedAt，绝不物理 delete）', async () => {
    const svc = makeSvc();
    fakePrisma.address.findFirst.mockResolvedValue(makeAddr({ id: 5n, userId: 1n, isDefault: false }));

    await svc.remove(1n, 5n);

    expect(fakePrisma.address.deleteMany).not.toHaveBeenCalled(); // 没有物理删除
    const updateData = (fakePrisma.address.update.mock.calls[0]?.[0]?.data ?? {}) as { deletedAt?: unknown };
    expect(updateData.deletedAt).toBeInstanceOf(Date);
  });

  it('删除默认地址且仍有其它有效地址 → 自动把最近创建的一个递补为默认', async () => {
    const svc = makeSvc();
    fakePrisma.address.findFirst
      // 第一次：findOwned 取到待删地址（是默认）
      .mockResolvedValueOnce(makeAddr({ id: 5n, userId: 1n, isDefault: true }))
      // 第二次：递补查找，命中 id=9n 这条
      .mockResolvedValueOnce(makeAddr({ id: 9n, userId: 1n, isDefault: false }));
    fakePrisma.address.update.mockResolvedValue(makeAddr({ id: 5n, isDefault: false }));

    await svc.remove(1n, 5n);

    // 递补查询：按 createdAt 倒序取「其余有效地址」，且带 userId（越权防护）
    const successorArgs = (fakePrisma.address.findFirst.mock.calls[1]?.[0] ?? {}) as {
      where?: { userId?: bigint; deletedAt?: unknown; id?: { not?: bigint } };
      orderBy?: { createdAt?: string };
    };
    expect(successorArgs.where?.userId).toBe(1n);
    expect(successorArgs.where?.deletedAt).toBeNull();
    expect(successorArgs.where?.id?.not).toBe(5n); // 排除自己
    expect(successorArgs.orderBy).toEqual({ createdAt: 'desc' }); // 最近创建的一个

    // 递补动作：把 successor 置为默认（第二次 update）
    const promotion = fakePrisma.address.update.mock.calls
      .map((c) => c[0] as { where?: { id?: bigint }; data?: { isDefault?: boolean } })
      .find((a) => a.where?.id === 9n);
    expect(promotion?.data?.isDefault).toBe(true);
  });

  it('删除默认地址时先软删再递补，且把自己置为非默认（避免瞬时两个默认）', async () => {
    const svc = makeSvc();
    fakePrisma.address.findFirst
      .mockResolvedValueOnce(makeAddr({ id: 5n, userId: 1n, isDefault: true }))
      .mockResolvedValueOnce(makeAddr({ id: 9n, userId: 1n, isDefault: false }));
    fakePrisma.address.update.mockResolvedValue(makeAddr({ id: 5n, isDefault: false }));

    await svc.remove(1n, 5n);

    const first = fakePrisma.address.update.mock.calls[0]?.[0] as {
      where?: { id?: bigint };
      data?: { deletedAt?: unknown; isDefault?: boolean };
    };
    expect(first?.where?.id).toBe(5n);
    expect(first?.data?.deletedAt).toBeInstanceOf(Date);
    expect(first?.data?.isDefault).toBe(false); // 同时解除默认，避免瞬时两个默认
  });

  it('删除默认地址且是最后一个 → 直接软删，不做递补', async () => {
    const svc = makeSvc();
    fakePrisma.address.findFirst
      .mockResolvedValueOnce(makeAddr({ id: 5n, userId: 1n, isDefault: true }))
      .mockResolvedValueOnce(null); // 没有其它有效地址可递补
    fakePrisma.address.update.mockResolvedValue(makeAddr({ id: 5n, isDefault: false }));

    await svc.remove(1n, 5n);

    // 只发生一次 update（软删本身），没有第二次递补写
    expect(fakePrisma.address.update).toHaveBeenCalledTimes(1);
    const updateData = (fakePrisma.address.update.mock.calls[0]?.[0]?.data ?? {}) as { deletedAt?: unknown };
    expect(updateData.deletedAt).toBeInstanceOf(Date);
  });

  it('列表不返回已软删：findMany 的 where 带 deletedAt:null（由查询过滤保证）', async () => {
    const svc = makeSvc();
    fakePrisma.address.findMany.mockResolvedValue([
      makeAddr({ id: 1n, userId: 1n }), // 有效
    ]);
    const list = await svc.list(1n);
    expect(list).toHaveLength(1);
    const where = lastWhere(fakePrisma.address.findMany);
    expect(where.deletedAt).toBeNull(); // 已软删的不会进结果
  });
});

// ---------------------------------------------------------------------------
// 不存在 / 越权拒绝
// ---------------------------------------------------------------------------

describe('AddressService 不存在处理', () => {
  it('修改一个不存在/非自己的地址 → 抛 ADDRESS_NOT_FOUND（11001）', async () => {
    const svc = makeSvc();
    fakePrisma.address.findFirst.mockResolvedValue(null); // 找不到

    await expect(svc.update(1n, 5n, { receiverName: '李四' })).rejects.toBeInstanceOf(BusinessError);
    await expect(svc.update(1n, 5n, { receiverName: '李四' })).rejects.toMatchObject({
      code: ErrorCode.ADDRESS_NOT_FOUND,
    });
  });

  it('删除一个不存在/非自己的地址 → 抛 ADDRESS_NOT_FOUND（11001）', async () => {
    const svc = makeSvc();
    fakePrisma.address.findFirst.mockResolvedValue(null);

    await expect(svc.remove(1n, 5n)).rejects.toMatchObject({ code: ErrorCode.ADDRESS_NOT_FOUND });
    expect(fakePrisma.address.update).not.toHaveBeenCalled();
  });

  it('设为默认一个不存在的地址 → 抛 ADDRESS_NOT_FOUND（11001）', async () => {
    const svc = makeSvc();
    fakePrisma.address.findFirst.mockResolvedValue(null);

    await expect(svc.setDefault(1n, 5n)).rejects.toMatchObject({ code: ErrorCode.ADDRESS_NOT_FOUND });
  });
});

// ---------------------------------------------------------------------------
// 普通修改（不触碰默认标记）
// ---------------------------------------------------------------------------

describe('AddressService 普通修改', () => {
  it('只改 receiverName → 走普通 update，isDefault 不被改变', async () => {
    const svc = makeSvc();
    fakePrisma.address.findFirst.mockResolvedValue(makeAddr({ id: 5n, userId: 1n, isDefault: true }));

    await svc.update(1n, 5n, { receiverName: '王五' });

    // 未触发默认互斥事务
    expect(fakePrisma.address.updateMany).not.toHaveBeenCalled();
    const data = (fakePrisma.address.update.mock.calls[0]?.[0]?.data ?? {}) as Record<string, unknown>;
    expect(data.receiverName).toBe('王五');
    expect(data.isDefault).toBeUndefined(); // 没传就不改默认标记
  });
});
