/**
 * @file server/src/tests/unit/tokenService.spec.ts
 * @description TokenService 单测：refresh token 轮换 / 重放检测 / 过期 / 只存哈希
 * @module tests/unit
 * @see server/src/services/TokenService.ts、docs/02-architecture.md §7.1（token 家族与重放吊销）
 * @author 软件开发团队
 * @created 2026-09-05
 *
 * 安全敏感逻辑必须有单测覆盖，不能只靠 tsc：
 * refresh token 的「轮换 + 重放吊销整族」是认证模块的防线，本用例覆盖四种关键路径。
 * 用注入的假 Prisma 客户端驱动，不依赖真实 MySQL / Redis。
 */

import { describe, expect, it, jest } from '@jest/globals';

// config 在模块加载时即校验环境变量并可能 process.exit；测试环境没有 .env，
// 因此用假 config 注入固定密钥与 TTL，避免加载真实配置。
jest.mock('@/config', () => ({
  config: {
    env: 'test',
    jwt: {
      shop: {
        accessSecret: 'shop-access-secret-for-test-min-32-bytes-long!!!',
        refreshSecret: 'shop-refresh-secret-for-test-min-32-bytes-long!!',
        accessTtl: '2h',
        refreshTtl: '7d',
      },
      admin: {
        accessSecret: 'admin-access-secret-for-test-min-32-bytes-long!!',
        refreshSecret: 'admin-refresh-secret-for-test-min-32-bytes-long!',
        accessTtl: '2h',
        refreshTtl: '7d',
      },
    },
    redis: { keyPrefix: 'shop' },
  },
  isProduction: false,
  isTest: true,
  isDevelopment: false,
}));

// 单例 TokenService 在模块加载时会调用 getPrisma()，用假实现避免建真实客户端
jest.mock('@/core/prisma', () => ({
  getPrisma: jest.fn(() => ({})),
}));

import { SubjectType } from '@prisma/client';
import { ErrorCode } from '@/core/errors/errorCodes';
import { TokenService } from '@/services/TokenService';
import { sha256Hex } from '@/utils/crypto';

/** refresh_tokens 记录形态（与 TokenService 内部读取的字段对应） */
interface FakeRefreshRecord {
  id: bigint;
  subjectType: SubjectType;
  userId: bigint | null;
  adminId: bigint | null;
  familyId: string;
  userAgent: string | null;
  ip: string | null;
  expiresAt: Date;
  revokedAt: Date | null;
}

/** 各 delegate 的入参形态 */
interface CreateArgs {
  data: Record<string, unknown>;
}
interface UpdateArgs {
  where: { id: bigint };
  data: Record<string, unknown>;
}
interface UpdateManyArgs {
  where: Record<string, unknown>;
  data: Record<string, unknown>;
}
interface FindArgs {
  where: Record<string, unknown>;
}

/** 构造一个可追踪调用的假 Prisma 客户端（仅实现本服务用到的委托） */
function buildFakeDb() {
  // 注：@jest/globals（Jest 29）的 jest.fn 泛型是「函数类型」，
  // 形如 jest.fn<(arg: T) => Promise<R>>()，而非旧的 <R, [T]> 双参数写法
  const calls = {
    refreshCreate: jest.fn<(arg: CreateArgs) => Promise<{ id: bigint }>>(),
    refreshFindUnique: jest.fn<(arg: FindArgs) => Promise<FakeRefreshRecord | null>>(),
    refreshUpdate: jest.fn<(arg: UpdateArgs) => Promise<unknown>>(),
    refreshUpdateMany: jest.fn<(arg: UpdateManyArgs) => Promise<{ count: number }>>(),
    userFindUnique: jest.fn<(arg: FindArgs) => Promise<{ id: bigint; role: string; tokenVersion: number } | null>>(),
    adminFindUnique: jest.fn<(arg: FindArgs) => Promise<unknown>>(),
  };

  const db = {
    refreshToken: {
      create: (arg: CreateArgs) => calls.refreshCreate(arg),
      findUnique: (arg: FindArgs) => calls.refreshFindUnique(arg),
      update: (arg: UpdateArgs) => calls.refreshUpdate(arg),
      updateMany: (arg: UpdateManyArgs) => calls.refreshUpdateMany(arg),
    },
    user: { findUnique: (arg: FindArgs) => calls.userFindUnique(arg) },
    adminUser: { findUnique: (arg: FindArgs) => calls.adminFindUnique(arg) },
  };

  return { db, calls };
}

/** 一条可用的（未吊销、未过期）refresh 记录 */
function activeRecord(overrides: Partial<FakeRefreshRecord> = {}): FakeRefreshRecord {
  return {
    id: 1n,
    subjectType: SubjectType.USER,
    userId: 10n,
    adminId: null,
    familyId: 'fam-1',
    userAgent: 'ua-test',
    ip: '1.2.3.4',
    expiresAt: new Date(Date.now() + 3_600_000),
    revokedAt: null,
    ...overrides,
  };
}

describe('TokenService', () => {
  it('正常轮换：旧记录被吊销、新记录 replacedById 指向新 ID、二者 familyId 相同', async () => {
    const { db, calls } = buildFakeDb();
    calls.refreshFindUnique.mockResolvedValue(activeRecord());
    calls.refreshCreate.mockResolvedValue({ id: 2n });
    calls.refreshUpdate.mockResolvedValue({});
    calls.userFindUnique.mockResolvedValue({ id: 10n, role: 'USER', tokenVersion: 1 });

    const service = new TokenService(db as unknown as ConstructorParameters<typeof TokenService>[0]);
    const pair = await service.rotate('some-old-refresh-token-plaintext', 'shop');

    // 旧记录被吊销，且 replacedById 指向新记录 ID
    expect(calls.refreshUpdate.mock.calls).toHaveLength(1);
    const updateArg = calls.refreshUpdate.mock.calls[0][0];
    expect(updateArg.where).toEqual({ id: 1n });
    expect(updateArg.data.revokedAt).toBeInstanceOf(Date);
    expect(updateArg.data.replacedById).toBe(2n);

    // 新记录与旧记录同家族
    expect(calls.refreshCreate.mock.calls).toHaveLength(1);
    const createArg = calls.refreshCreate.mock.calls[0][0];
    expect(createArg.data.familyId).toBe('fam-1');

    // 返回了新的 token 对，且 refresh token 是全新的明文
    expect(typeof pair.accessToken).toBe('string');
    expect(pair.accessToken.split('.')).toHaveLength(3); // JWT 三段
    expect(pair.refreshToken).not.toBe('some-old-refresh-token-plaintext');
  });

  it('重放检测：用已吊销的 refresh token 再次 rotate 抛 10008，且整个 familyId 下所有未吊销记录被吊销', async () => {
    const { db, calls } = buildFakeDb();
    calls.refreshFindUnique.mockResolvedValue(
      activeRecord({ revokedAt: new Date(Date.now() - 10_000), familyId: 'fam-9' }),
    );
    calls.refreshUpdateMany.mockResolvedValue({ count: 3 });

    const service = new TokenService(db as unknown as ConstructorParameters<typeof TokenService>[0]);
    await expect(service.rotate('already-revoked-token', 'shop')).rejects.toMatchObject({
      code: ErrorCode.REFRESH_TOKEN_REPLAYED,
    });

    // 整族吊销：updateMany 命中 familyId 且只吊销未吊销的
    expect(calls.refreshUpdateMany.mock.calls).toHaveLength(1);
    const arg = calls.refreshUpdateMany.mock.calls[0][0];
    expect(arg.where).toEqual({ familyId: 'fam-9', revokedAt: null });
    expect(arg.data.revokedAt).toBeInstanceOf(Date);

    // 重放路径不得签发新 token
    expect(calls.refreshCreate.mock.calls).toHaveLength(0);
  });

  it('过期：expiresAt 已过抛 10007，且不签发新 token、不触发家族吊销', async () => {
    const { db, calls } = buildFakeDb();
    calls.refreshFindUnique.mockResolvedValue(
      activeRecord({ expiresAt: new Date(Date.now() - 10_000), familyId: 'fam-3' }),
    );

    const service = new TokenService(db as unknown as ConstructorParameters<typeof TokenService>[0]);
    await expect(service.rotate('expired-token', 'shop')).rejects.toMatchObject({
      code: ErrorCode.REFRESH_TOKEN_EXPIRED,
    });

    expect(calls.refreshUpdateMany.mock.calls).toHaveLength(0);
    expect(calls.refreshCreate.mock.calls).toHaveLength(0);
    expect(calls.refreshUpdate.mock.calls).toHaveLength(0);
  });

  it('只存哈希：签发时库里的 tokenHash 等于 sha256(明文)，且不等于明文', async () => {
    const { db, calls } = buildFakeDb();
    calls.refreshCreate.mockResolvedValue({ id: 5n });

    const service = new TokenService(db as unknown as ConstructorParameters<typeof TokenService>[0]);
    const pair = await service.issueTokenPair(
      { subjectType: SubjectType.USER, subjectId: 10n, role: 'USER', tokenVersion: 1 },
      'shop',
      { userAgent: 'ua', ip: '9.9.9.9' },
    );

    expect(calls.refreshCreate.mock.calls).toHaveLength(1);
    const data = calls.refreshCreate.mock.calls[0][0].data;

    // 库里只存 sha256 哈希，且绝不等于明文
    expect(data.tokenHash).toBe(sha256Hex(pair.refreshToken));
    expect(data.tokenHash).not.toBe(pair.refreshToken);
    // 明文仅此一次返回给客户端（32 字节 → 64 位 hex）
    expect(pair.refreshToken).toMatch(/^[0-9a-f]{64}$/);
  });
});
