/**
 * @file server/src/tests/unit/payPasswordService.spec.ts
 * @description 支付密码服务（T070）单元测试：verify / hasPassword / set / modify 全分支
 * @module tests/unit
 * @see server/src/services/PayPasswordService.ts、docs/12-phase12-plan.md
 * @author 软件开发团队
 * @created 2026-09-20
 *
 * 覆盖：
 * 1. verify：哈希匹配→true、密码错→false、用户不存在→false、未设置→false；
 * 2. hasPassword：已设置→true、未设置→false、用户不存在→false；
 * 3. set：成功（update 写入哈希）/ 已设置（61011）/ 强度不足（61007，且不下库）/ 账号不存在（10012）；
 * 4. modify：成功（update 写入新哈希）/ 未设置（61009）/ 原密码错（61007，不下库）/ 新密码弱（61007）/ 账号不存在（10012）。
 *
 * 策略：向构造函数注入**假 Prisma**（Pick<PrismaClient,'user'>），bcrypt 走真实实现，
 * 既验证「哈希比对」真实逻辑，又避免连库。
 */

import { describe, expect, it, jest } from '@jest/globals';
import { ErrorCode } from '@/core/errors/errorCodes';
import { hashPassword } from '@/utils/hash';
import { PayPasswordService } from '@/services/PayPasswordService';

jest.mock('@/config', () => ({
  config: { env: 'test', redis: { keyPrefix: 'shop' }, log: { level: 'error', dir: '' } },
  isProduction: false,
  isTest: true,
  isDevelopment: false,
}));

jest.mock('@/core/prisma', () => ({
  getPrisma: jest.fn(() => ({})),
}));

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyAsyncFn = (...args: any[]) => Promise<any>;

type FakeUserDelegate = {
  findUnique: jest.Mock<AnyAsyncFn>;
  update: jest.Mock<AnyAsyncFn>;
};

/** 构造注入用的假 Prisma（仅 user 委托） */
function makeFakePrisma(): { user: FakeUserDelegate } {
  return {
    user: {
      findUnique: jest.fn<AnyAsyncFn>(),
      update: jest.fn<AnyAsyncFn>().mockResolvedValue({ payPasswordHash: 'x' }),
    },
  };
}

describe('PayPasswordService（T070）', () => {
  describe('verify', () => {
    it('哈希匹配 → 返回 true', async () => {
      const hash = await hashPassword('Passw0rd1');
      const prisma = makeFakePrisma();
      prisma.user.findUnique.mockResolvedValue({ payPasswordHash: hash });
      const svc = new PayPasswordService(prisma as any);

      await expect(svc.verify(1, 'Passw0rd1')).resolves.toBe(true);
    });

    it('密码错误 → 返回 false（不抛异常）', async () => {
      const hash = await hashPassword('Passw0rd1');
      const prisma = makeFakePrisma();
      prisma.user.findUnique.mockResolvedValue({ payPasswordHash: hash });
      const svc = new PayPasswordService(prisma as any);

      await expect(svc.verify(1, 'wrong-password')).resolves.toBe(false);
    });

    it('用户不存在 → 返回 false', async () => {
      const prisma = makeFakePrisma();
      prisma.user.findUnique.mockResolvedValue(null);
      const svc = new PayPasswordService(prisma as any);

      await expect(svc.verify(1, 'whatever')).resolves.toBe(false);
    });

    it('未设置支付密码 → 返回 false', async () => {
      const prisma = makeFakePrisma();
      prisma.user.findUnique.mockResolvedValue({ payPasswordHash: null });
      const svc = new PayPasswordService(prisma as any);

      await expect(svc.verify(1, 'whatever')).resolves.toBe(false);
    });
  });

  describe('hasPassword', () => {
    it('已设置 → true', async () => {
      const hash = await hashPassword('Passw0rd1');
      const prisma = makeFakePrisma();
      prisma.user.findUnique.mockResolvedValue({ payPasswordHash: hash });
      const svc = new PayPasswordService(prisma as any);

      await expect(svc.hasPassword(1)).resolves.toBe(true);
    });

    it('未设置 → false', async () => {
      const prisma = makeFakePrisma();
      prisma.user.findUnique.mockResolvedValue({ payPasswordHash: null });
      const svc = new PayPasswordService(prisma as any);

      await expect(svc.hasPassword(1)).resolves.toBe(false);
    });

    it('用户不存在 → false', async () => {
      const prisma = makeFakePrisma();
      prisma.user.findUnique.mockResolvedValue(null);
      const svc = new PayPasswordService(prisma as any);

      await expect(svc.hasPassword(1)).resolves.toBe(false);
    });
  });

  describe('set（首次设置）', () => {
    it('成功：写入哈希', async () => {
      const prisma = makeFakePrisma();
      prisma.user.findUnique.mockResolvedValue({ payPasswordHash: null });
      const svc = new PayPasswordService(prisma as any);

      await svc.set(1, 'Passw0rd1');

      expect(prisma.user.update).toHaveBeenCalledTimes(1);
      const arg = prisma.user.update.mock.calls[0][0];
      expect(arg.where.id.toString()).toBe('1');
      expect(typeof arg.data.payPasswordHash).toBe('string');
      expect(arg.data.payPasswordHash.startsWith('$2')).toBe(true);
    });

    it('已设置 → 拒绝（61011），不下库', async () => {
      const hash = await hashPassword('Passw0rd1');
      const prisma = makeFakePrisma();
      prisma.user.findUnique.mockResolvedValue({ payPasswordHash: hash });
      const svc = new PayPasswordService(prisma as any);

      await expect(svc.set(1, 'NewPassw0rd2')).rejects.toMatchObject({
        code: ErrorCode.PAY_PASSWORD_ALREADY_SET,
      });
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('强度不足 → 拒绝（61007），且完全不下库', async () => {
      const prisma = makeFakePrisma();
      const svc = new PayPasswordService(prisma as any);

      await expect(svc.set(1, '123')).rejects.toMatchObject({
        code: ErrorCode.PAY_PASSWORD_INCORRECT,
      });
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('账号不存在 → 拒绝（10012）', async () => {
      const prisma = makeFakePrisma();
      prisma.user.findUnique.mockResolvedValue(null);
      const svc = new PayPasswordService(prisma as any);

      await expect(svc.set(1, 'Passw0rd1')).rejects.toMatchObject({
        code: ErrorCode.USER_NOT_FOUND,
      });
    });
  });

  describe('modify（修改）', () => {
    it('成功：校验原密码后写入新哈希', async () => {
      const oldHash = await hashPassword('OldPassw0rd1');
      const prisma = makeFakePrisma();
      prisma.user.findUnique.mockResolvedValue({ payPasswordHash: oldHash });
      const svc = new PayPasswordService(prisma as any);

      await svc.modify(1, 'OldPassw0rd1', 'NewPassw0rd2');

      expect(prisma.user.update).toHaveBeenCalledTimes(1);
      const arg = prisma.user.update.mock.calls[0][0];
      expect(typeof arg.data.payPasswordHash).toBe('string');
      expect(arg.data.payPasswordHash.startsWith('$2')).toBe(true);
    });

    it('未设置 → 拒绝（61009）', async () => {
      const prisma = makeFakePrisma();
      prisma.user.findUnique.mockResolvedValue({ payPasswordHash: null });
      const svc = new PayPasswordService(prisma as any);

      await expect(svc.modify(1, 'whatever', 'NewPassw0rd2')).rejects.toMatchObject({
        code: ErrorCode.PAY_PASSWORD_NOT_SET,
      });
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('原密码错误 → 拒绝（61007），不下库', async () => {
      const oldHash = await hashPassword('OldPassw0rd1');
      const prisma = makeFakePrisma();
      prisma.user.findUnique.mockResolvedValue({ payPasswordHash: oldHash });
      const svc = new PayPasswordService(prisma as any);

      await expect(svc.modify(1, 'WRONG-pass', 'NewPassw0rd2')).rejects.toMatchObject({
        code: ErrorCode.PAY_PASSWORD_INCORRECT,
      });
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('新密码强度不足 → 拒绝（61007），且完全不下库', async () => {
      const oldHash = await hashPassword('OldPassw0rd1');
      const prisma = makeFakePrisma();
      prisma.user.findUnique.mockResolvedValue({ payPasswordHash: oldHash });
      const svc = new PayPasswordService(prisma as any);

    await expect(svc.modify(1, 'OldPassw0rd1', '123')).rejects.toMatchObject({
      code: ErrorCode.PAY_PASSWORD_INCORRECT,
    });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('账号不存在 → 拒绝（10012）', async () => {
      const prisma = makeFakePrisma();
      prisma.user.findUnique.mockResolvedValue(null);
      const svc = new PayPasswordService(prisma as any);

      await expect(svc.modify(1, 'whatever', 'NewPassw0rd2')).rejects.toMatchObject({
        code: ErrorCode.USER_NOT_FOUND,
      });
    });
  });
});
