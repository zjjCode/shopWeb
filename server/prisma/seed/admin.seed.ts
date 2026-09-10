/**
 * @file server/prisma/seed/admin.seed.ts
 * @description 后台管理员种子：2 个内置管理员 + 管理员角色绑定（T006）
 * @module seed
 * @see docs/03-database.md §8.1 #2（管理员）/ §8.2（执行顺序）
 * @author 软件开发团队
 * @created 2026-09-04
 *
 * 设计要点：
 * 1. 密码**必须**走 `src/utils/hash.ts` 的 `hashPassword()`（bcrypt(sha256(pwd), cost=12)），
 *    与运行时登录校验口径一致；严禁在本文件直接调 bcrypt，否则中文/长密码因 72 字节截断
 *    导致「后几位随便改都能登录」或校验失败。
 * 2. `superadmin.isBuiltin = true` 是硬约束（RBAC-03：不可删除、不可解绑最后一个超管，防自锁）。
 * 3. `AdminUserRole.createdBy` 指向 `superadmin` 自身（首个内置超管即初始分配人），
 *    语义上表示「初始内置绑定由系统超管创建」。
 * 4. 全部幂等 `upsert`，可重复执行。
 */

import type { PrismaClient } from '@prisma/client';
import { hashPassword } from '@/utils/hash';

/** 管理员 seed 写入条数汇总 */
export interface AdminSeedResult {
  /** 管理员记录数 */
  adminUsers: number;
  /** 管理员-角色绑定记录数 */
  adminUserRoles: number;
}

/** 内置管理员初始密码（与 docs/03-database.md §8.1 #2 一致） */
const INITIAL_PASSWORD = 'Admin@123456';

/**
 * 写入 2 个后台管理员及其角色绑定。
 *
 * 执行顺序依赖 RBAC：需先有角色（SUPER_ADMIN / ADMIN）再绑定，故本步应在 `seedRbac` 之后调用。
 *
 * @param prisma PrismaClient 实例
 * @returns 各表写入条数
 */
export async function seedAdmins(prisma: PrismaClient): Promise<AdminSeedResult> {
  const passwordHash = await hashPassword(INITIAL_PASSWORD);

  // ---------------- 管理员 ----------------
  const superAdmin = await prisma.adminUser.upsert({
    where: { username: 'superadmin' },
    create: {
      username: 'superadmin',
      passwordHash,
      realName: '超级管理员',
      status: 'ACTIVE',
      isBuiltin: true,
    },
    update: {
      realName: '超级管理员',
      status: 'ACTIVE',
      isBuiltin: true,
    },
  });

  const admin = await prisma.adminUser.upsert({
    where: { username: 'admin' },
    create: {
      username: 'admin',
      passwordHash,
      realName: '运营管理员',
      status: 'ACTIVE',
      isBuiltin: false,
    },
    update: {
      realName: '运营管理员',
      status: 'ACTIVE',
      isBuiltin: false,
    },
  });

  // ---------------- 角色绑定 ----------------
  const roles = await prisma.role.findMany({
    where: { code: { in: ['SUPER_ADMIN', 'ADMIN'] } },
    select: { id: true, code: true },
  });
  const roleIdByCode = new Map<string, bigint>(roles.map((r) => [r.code, r.id]));

  // createdBy 统一指向首个内置超管（自身），作为初始绑定的分配人
  const createdBy = superAdmin.id;

  const bindings: Array<{ adminUserId: bigint; roleCode: string }> = [
    { adminUserId: superAdmin.id, roleCode: 'SUPER_ADMIN' },
    { adminUserId: admin.id, roleCode: 'ADMIN' },
  ];

  let adminUserRoleCount = 0;
  for (const binding of bindings) {
    const roleId = roleIdByCode.get(binding.roleCode);
    if (roleId === undefined) {
      console.warn(`[seed:admin] 跳过未找到的角色：${binding.roleCode}`);
      continue;
    }
    await prisma.adminUserRole.upsert({
      where: { adminUserId_roleId: { adminUserId: binding.adminUserId, roleId } },
      create: { adminUserId: binding.adminUserId, roleId, createdBy },
      update: { createdBy },
    });
    adminUserRoleCount += 1;
  }

  const adminUserCount = await prisma.adminUser.count();
  console.warn(`[seed:admin] 管理员 ${adminUserCount} / 角色绑定 ${adminUserRoleCount}`);
  return { adminUsers: adminUserCount, adminUserRoles: adminUserRoleCount };
}
