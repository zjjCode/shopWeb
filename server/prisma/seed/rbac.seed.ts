/**
 * @file server/prisma/seed/rbac.seed.ts
 * @description RBAC 种子：权限点 + 角色 + 角色权限绑定（T006）
 * @module seed
 * @see docs/03-database.md §3.10（权限点清单）/ §8.1 #2（角色）/ §8.2（执行顺序）
 * @author 软件开发团队
 * @created 2026-09-04
 *
 * 设计要点：
 * 1. 权限点**复用** `src/constants/permissions.ts` 的 `PERMISSION_MODULES`，严禁把 57 个编码硬编码进本文件
 *    （否则日后在权威源新增权限点要改两处 —— 必须杜绝的坏味道）。
 * 2. `isSensitive` 由 `isSensitivePermission(code)` 判定；`module` 取分组 key；
 *    `sort` = 数组下标 * 10 + 10，保证同模块内顺序稳定且与权威源天然一致。
 * 3. `name` 直接取权限编码本身：编码即规范（`资源:操作`），是权限的权威标识；
 *    展示层的中文名交给后台「权限树」i18n / 维护界面，本 seed 不重复维护一份中文名清单。
 * 4. 全部写操作为幂等 `upsert`，可重复执行。
 */

import type { PrismaClient } from '@prisma/client';
import {
  PERMISSION_MODULES,
  ALL_PERMISSIONS,
  ADMIN_DEFAULT_PERMISSIONS,
  isSensitivePermission,
} from '@/constants/permissions';

/** RBAC seed 写入条数汇总 */
export interface RbacSeedResult {
  /** 权限点记录数 */
  permissions: number;
  /** 角色记录数 */
  roles: number;
  /** 角色-权限绑定记录数 */
  rolePermissions: number;
}

/**
 * 写入权限点、内置角色、角色权限绑定。
 *
 * 执行顺序（见 §8.2 外键依赖）：权限点 → 角色 → 角色权限绑定。
 *
 * @param prisma PrismaClient 实例
 * @returns 各表写入条数
 */
export async function seedRbac(prisma: PrismaClient): Promise<RbacSeedResult> {
  // ---------------- 1. 权限点 ----------------
  const permissionUpserts: Array<Promise<unknown>> = [];
  for (const [module, codes] of Object.entries(PERMISSION_MODULES)) {
    codes.forEach((code, idx) => {
      permissionUpserts.push(
        prisma.permission.upsert({
          where: { code },
          create: {
            code,
            module,
            name: code,
            isSensitive: isSensitivePermission(code),
            sort: idx * 10 + 10,
          },
          update: {
            module,
            isSensitive: isSensitivePermission(code),
            sort: idx * 10 + 10,
          },
        }),
      );
    });
  }
  await Promise.all(permissionUpserts);

  const permissionCount = await prisma.permission.count();

  // ---------------- 2. 内置角色 ----------------
  const superRole = await prisma.role.upsert({
    where: { code: 'SUPER_ADMIN' },
    create: {
      code: 'SUPER_ADMIN',
      name: '超级管理员',
      description: '系统内置超级管理员：不可删除、不可编辑权限（RBAC-03）',
      dataScope: 'ALL',
      status: 'ENABLED',
      isBuiltin: true,
      sort: 10,
    },
    update: {
      name: '超级管理员',
      description: '系统内置超级管理员：不可删除、不可编辑权限（RBAC-03）',
      dataScope: 'ALL',
      status: 'ENABLED',
      isBuiltin: true,
      sort: 10,
    },
  });

  // ADMIN 的 dataScope = SELF 的裁定（RBAC-06）：
  // 多角色时「数据范围取最宽」。若两个内置角色都设 ALL，该并集规则在一期就失去
  // 可验证的差异样本。故 ADMIN 取 SELF 以保留一条差异路径。
  // ⚠️ 坦白：一期查询层尚未实现 SELF（即按 creator_id 过滤），实际行为等同 ALL，
  //    待 RbacService（T0xx）落地数据范围过滤后，SELF 才会真正生效。
  const adminRole = await prisma.role.upsert({
    where: { code: 'ADMIN' },
    create: {
      code: 'ADMIN',
      name: '运营管理员',
      description: '系统内置运营管理员：可编辑、不可删除（RBAC-03）；数据范围 SELF（一期等同 ALL）',
      dataScope: 'SELF',
      status: 'ENABLED',
      isBuiltin: true,
      sort: 20,
    },
    update: {
      name: '运营管理员',
      description: '系统内置运营管理员：可编辑、不可删除（RBAC-03）；数据范围 SELF（一期等同 ALL）',
      dataScope: 'SELF',
      status: 'ENABLED',
      isBuiltin: true,
      sort: 20,
    },
  });

  // ---------------- 3. 角色权限绑定 ----------------
  // 权限编码 → id 映射，供绑定使用（避免 N 次按 code 查询）
  const permMap = new Map<string, bigint>();
  const perms = await prisma.permission.findMany({ select: { id: true, code: true } });
  for (const p of perms) {
    permMap.set(p.code, p.id);
  }

  const rolePermBindings: Array<{ roleId: bigint; codes: readonly string[] }> = [
    { roleId: superRole.id, codes: ALL_PERMISSIONS }, // 超级管理员：全量 57 个
    { roleId: adminRole.id, codes: ADMIN_DEFAULT_PERMISSIONS }, // 运营管理员：默认勾选集
  ];

  let rolePermissionCount = 0;
  for (const binding of rolePermBindings) {
    for (const code of binding.codes) {
      const permissionId = permMap.get(code);
      if (permissionId === undefined) {
        // 理论上不会发生：权限点已先行写入且 codes 来自同一权威源
        console.warn(`[seed:rbac] 跳过未找到的权限编码：${code}`);
        continue;
      }
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: binding.roleId, permissionId } },
        create: { roleId: binding.roleId, permissionId },
        update: {},
      });
      rolePermissionCount += 1;
    }
  }

  console.warn(`[seed:rbac] 权限点 ${permissionCount} / 角色 2 / 角色权限绑定 ${rolePermissionCount}`);
  return { permissions: permissionCount, roles: 2, rolePermissions: rolePermissionCount };
}
