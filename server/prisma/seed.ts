/**
 * @file server/prisma/seed.ts
 * @description 种子数据入口：编排执行顺序 + 环境守卫（T006）
 * @module seed
 * @see docs/03-database.md §8.2（执行顺序）/ §8.3（幂等与环境守卫）
 * @author 软件开发团队
 * @created 2026-09-04
 *
 * 执行顺序（§8.2 外键依赖 + RBAC 依赖）：
 *   permissions → roles → role_permissions → admin_users → admin_user_roles
 *   → fund_accounts → payment_methods
 *   → categories → products → product_images → product_specs → skus → sku_stocks
 *
 * 环境守卫（§8.3）：`NODE_ENV === 'production'` 时直接打印警告并退出，**不执行任何写入**
 * （docs/02-architecture.md line 820：生产环境禁止 seed；mock 在生产下亦强制不可启用）。
 *
 * 幂等：每个模块均按唯一键 upsert / findFirst + create，可重复执行。
 */

import { getPrisma } from '@/core/prisma';
import { seedRbac } from './seed/rbac.seed';
import { seedAdmins } from './seed/admin.seed';
import { seedFundAccounts } from './seed/fundAccount.seed';
import { seedPaymentMethods } from './seed/paymentMethod.seed';
import { seedCatalog } from './seed/catalog.seed';

/** 各模块写入条数汇总 */
interface SeedSummary {
  permissions: number;
  roles: number;
  rolePermissions: number;
  adminUsers: number;
  adminUserRoles: number;
  fundAccounts: number;
  paymentMethods: number;
  categories: number;
  products: number;
  productImages: number;
  productSpecs: number;
  skus: number;
  skuStocks: number;
}

/**
 * 种子数据主流程。
 *
 * @returns 各表写入条数汇总
 */
async function main(): Promise<SeedSummary> {
  const prisma = getPrisma();

  const rbac = await seedRbac(prisma);
  const admins = await seedAdmins(prisma);
  const fundAccounts = await seedFundAccounts(prisma);
  const paymentMethods = await seedPaymentMethods(prisma);
  // 商品目录：外键依赖 categories → products → skus → sku_stocks，故放在最后
  const catalog = await seedCatalog(prisma);

  return {
    permissions: rbac.permissions,
    roles: rbac.roles,
    rolePermissions: rbac.rolePermissions,
    adminUsers: admins.adminUsers,
    adminUserRoles: admins.adminUserRoles,
    fundAccounts,
    paymentMethods,
    categories: catalog.categories,
    products: catalog.products,
    productImages: catalog.productImages,
    productSpecs: catalog.productSpecs,
    skus: catalog.skus,
    skuStocks: catalog.skuStocks,
  };
}

// ---------------- 入口 ----------------
if (process.env.NODE_ENV === 'production') {
  // 环境守卫：生产禁止 seed，直接退出且不写任何数据
  console.warn('[seed] 检测到 NODE_ENV=production，已跳过种子数据写入（生产环境禁止 seed）。');
  process.exit(0);
}

main()
  .then((summary) => {
    console.warn('[seed] 种子数据初始化完成。汇总：', summary);
    return getPrisma().$disconnect();
  })
  .then(() => {
    process.exit(0);
  })
  .catch(async (err: unknown) => {
    console.error('[seed] 种子数据初始化失败：', err);
    try {
      await getPrisma().$disconnect();
    } catch {
      /* 忽略断连错误 */
    }
    process.exit(1);
  });
