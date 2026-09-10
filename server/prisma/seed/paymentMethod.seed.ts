/**
 * @file server/prisma/seed/paymentMethod.seed.ts
 * @description 支付方式种子：9 条（T006）
 * @module seed
 * @see docs/03-database.md §8.1 #2（支付方式）/ docs/02-architecture.md line 249、1619、820 / schema line 1022
 * @author 软件开发团队
 * @created 2026-09-04
 *
 * ⚠️ 口径冲突已裁定：`docs/02-architecture.md` line 249 写的是 `unionpay`，
 * 但 schema 枚举实际值为 **`BANKCARD`**（v2 变更为银行卡聚合支付）。**以 schema 枚举为准**。
 *
 * `enabled` 的裁定理由（docs/02-architecture.md line 1619 / line 820）：
 * 上线前在后台「支付方式管理」开启该渠道；未开启时 C 端结算页不展示。
 * 且 `NODE_ENV=production` 下 mock 强制不可启用。
 * 故只默认开启**不依赖外部渠道凭证**的 `mock` 与 `balance`（本地事务），
 * 其余 6 条待渠道密钥配置就绪后由后台开启 —— 避免「配置表里显示已启用、实际调不通」的假象。
 *
 * 其余字段约定：
 * - `terminals` 按 subChannel 映射（schema line 1022 注释）：WEB→["PC"]、SCAN→["PC"]、
 *   JSAPI→["WECHAT_IN"]、H5→["H5"]、GATEWAY/QUICK→["PC","H5"]、BALANCE→["PC","H5","WECHAT_IN"]；
 *   `mock`（MOCK+WEB）按调试需要给 ["PC","H5","WECHAT_IN"]。
 * - `minAmount = 1`（1 分）、`maxAmount = 0`（0 表示不限）、`status = NORMAL`、
 *   `config = null`（待后台配渠道参数）、`icon` / `maintainTip = null`。
 * - `feeRate` 单位为**万分比整数**（60 = 0.6%），与 schema 注释一致。
 * - 金额单位为「分」。
 * - 全部幂等 `upsert`，可重复执行。
 */

import { Prisma, type PrismaClient, type PayChannel, type SubChannel } from '@prisma/client';

/** 单条支付方式种子定义 */
interface PaymentMethodSeedRow {
  code: string;
  channel: PayChannel;
  subChannel: SubChannel | null;
  name: string;
  enabled: boolean;
  sort: number;
  feeRate: number;
  terminals: string[];
}

/** 9 条支付方式（顺序即 sort 基准） */
const PAYMENT_METHOD_ROWS: readonly PaymentMethodSeedRow[] = [
  {
    code: 'mock',
    channel: 'MOCK',
    subChannel: 'WEB',
    name: '模拟支付',
    enabled: true,
    sort: 10,
    feeRate: 0,
    terminals: ['PC', 'H5', 'WECHAT_IN'],
  },
  {
    code: 'balance',
    channel: 'BALANCE',
    subChannel: 'BALANCE',
    name: '余额支付',
    enabled: true,
    sort: 20,
    feeRate: 0,
    terminals: ['PC', 'H5', 'WECHAT_IN'],
  },
  {
    code: 'alipay_scan',
    channel: 'ALIPAY',
    subChannel: 'SCAN',
    name: '支付宝扫码支付',
    enabled: false,
    sort: 30,
    feeRate: 60,
    terminals: ['PC'],
  },
  {
    code: 'alipay_web',
    channel: 'ALIPAY',
    subChannel: 'WEB',
    name: '支付宝网页支付',
    enabled: false,
    sort: 40,
    feeRate: 60,
    terminals: ['PC'],
  },
  {
    code: 'wechat_jsapi',
    channel: 'WECHAT',
    subChannel: 'JSAPI',
    name: '微信JSAPI支付',
    enabled: false,
    sort: 50,
    feeRate: 60,
    terminals: ['WECHAT_IN'],
  },
  {
    code: 'wechat_h5',
    channel: 'WECHAT',
    subChannel: 'H5',
    name: '微信H5支付',
    enabled: false,
    sort: 60,
    feeRate: 60,
    terminals: ['H5'],
  },
  {
    code: 'wechat_scan',
    channel: 'WECHAT',
    subChannel: 'SCAN',
    name: '微信扫码支付',
    enabled: false,
    sort: 70,
    feeRate: 60,
    terminals: ['PC'],
  },
  {
    // ⚠️ 文档 `unionpay` 与 schema `BANKCARD` 冲突：以 schema 枚举为准
    code: 'bankcard_gateway',
    channel: 'BANKCARD',
    subChannel: 'GATEWAY',
    name: '银行卡网关支付',
    enabled: false,
    sort: 80,
    feeRate: 80,
    terminals: ['PC', 'H5'],
  },
  {
    code: 'bankcard_quick',
    channel: 'BANKCARD',
    subChannel: 'QUICK',
    name: '银行卡快捷支付',
    enabled: false,
    sort: 90,
    feeRate: 80,
    terminals: ['PC', 'H5'],
  },
];

/**
 * 写入 9 条支付方式。
 *
 * @param prisma PrismaClient 实例
 * @returns 写入条数（恒 9；已存在则为更新后仍存在 9 条）
 */
export async function seedPaymentMethods(prisma: PrismaClient): Promise<number> {
  for (const row of PAYMENT_METHOD_ROWS) {
    await prisma.paymentMethod.upsert({
      where: { code: row.code },
      create: {
        code: row.code,
        channel: row.channel,
        subChannel: row.subChannel,
        name: row.name,
        enabled: row.enabled,
        status: 'NORMAL',
        sort: row.sort,
        terminals: row.terminals,
        minAmount: 1n,
        maxAmount: 0n,
        feeRate: row.feeRate,
        config: Prisma.JsonNull,
        icon: null,
        maintainTip: null,
      },
      update: {
        channel: row.channel,
        subChannel: row.subChannel,
        name: row.name,
        enabled: row.enabled,
        status: 'NORMAL',
        sort: row.sort,
        terminals: row.terminals,
        feeRate: row.feeRate,
      },
    });
  }

  const count = await prisma.paymentMethod.count();
  console.warn(`[seed:pay] 支付方式 ${count}`);
  return count;
}
