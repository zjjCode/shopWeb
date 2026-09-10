/**
 * @file server/src/idGenerator.ts
 * @description 业务单号生成器：订单/支付/退款/流水/充值/券/活动/交易组/账户号（规则见 03 §1.3）
 * @module core
 * @see docs/03-database.md §1.3（单号生成规则）
 * @see docs/02-architecture.md §7.6（单号不可枚举）
 * @author 软件开发团队
 * @created 2026-09-03
 */

import { randomInt } from 'node:crypto';
import { ID_PREFIX } from '@/config/constants';
import { DateUtil } from '@/utils/date';
import { randomDigits } from '@/utils/crypto';

/**
 * 序列段来源：DB 自增 ID（推荐）或进程内单调计数器（兜底）。
 *
 * 设计说明（为什么这样兜底）：
 * 规范约定「序列段由 DB 自增 ID 补齐，不引入额外序列表」，因此**首选**由调用方把刚插入记录的
 * 自增 ID 作为 seed 传入（例如先插订单拿到 id，再回填 order_no）。但在"先生成单号再插库"的场景
 * （如支付单号要在调渠道之前生成）拿不到 id，此时退化为进程内按天单调计数器 + 随机段：
 * 计数器保证同进程内不重复，随机段保证跨进程/重启后碰撞概率极低，且单号不可枚举。
 */
export type IdSeed = number | bigint;

/** Crockford Base32 字母表（去掉 I/L/O/U，避免与数字混淆） */
const CROCKFORD_BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** ULID 时间戳长度（10 字符）与随机段长度（16 字符） */
const ULID_TIME_LENGTH = 10;
const ULID_RANDOM_LENGTH = 16;

/** 进程内序列计数器：key = `${prefix}:${yyyyMMdd}` */
const sequenceCounters = new Map<string, number>();

/**
 * 按 Crockford Base32 编码数值到定长字符串。
 *
 * @param value 非负整数
 * @param length 目标长度（不足左侧补 0）
 * @returns Base32 字符串
 */
function encodeBase32(value: number, length: number): string {
  let remaining = Math.max(0, Math.floor(value));
  let encoded = '';
  while (encoded.length < length) {
    encoded = CROCKFORD_BASE32[remaining % 32] + encoded;
    remaining = Math.floor(remaining / 32);
  }
  return encoded;
}

/**
 * 取序列段（定长补零）。
 *
 * @param prefix 单号前缀（用于隔离不同业务的计数器）
 * @param width 序列段宽度
 * @param seed DB 自增 ID（可选）
 * @returns 定长序列字符串
 */
function nextSequence(prefix: string, width: number, seed?: IdSeed): string {
  const modulus = 10 ** width;
  let sequence: number;

  if (seed !== undefined) {
    // 优先用 DB 自增 ID 补齐序列段：单调递增、可回溯到记录，符合规范要求
    sequence = Number(BigInt(seed) % BigInt(modulus));
  } else {
    const counterKey = `${prefix}:${DateUtil.formatCompactDate()}`;
    const current = sequenceCounters.get(counterKey) ?? 0;
    sequence = (current + 1) % modulus;
    sequenceCounters.set(counterKey, sequence);
  }

  return sequence.toString().padStart(width, '0');
}

/**
 * 取定长随机数字段（防枚举）。
 *
 * @param width 随机段宽度
 * @returns 定长数字字符串
 */
function randomSegment(width: number): string {
  return randomDigits(width);
}

/**
 * 生成 ULID。
 *
 * @description 用于 requestId：时间前缀保证大致有序（便于按时间检索），随机段保证唯一
 * @returns 26 字符 ULID
 */
export function ulid(): string {
  const timePart = encodeBase32(Date.now(), ULID_TIME_LENGTH);
  let randomPart = '';
  for (let i = 0; i < ULID_RANDOM_LENGTH; i += 1) {
    randomPart += CROCKFORD_BASE32[randomInt(0, 32)];
  }
  return `${timePart}${randomPart}`;
}

/**
 * 生成请求链路 ID。
 *
 * @returns `req_` + ULID
 */
export function generateRequestId(): string {
  return `req_${ulid()}`;
}

/**
 * 生成订单号：`SO` + yyyyMMdd + 6 位序列 + 6 位随机。
 *
 * @param seed 订单自增 ID（可选）
 * @returns 订单号
 */
export function orderNo(seed?: IdSeed): string {
  return `${ID_PREFIX.ORDER}${DateUtil.formatCompactDate()}${nextSequence(ID_PREFIX.ORDER, 6, seed)}${randomSegment(6)}`;
}

/**
 * 生成支付单号：`PAY` + yyyyMMdd + 6 位序列 + 6 位随机。
 *
 * @param seed 支付单自增 ID（可选）
 * @returns 支付单号
 */
export function paymentNo(seed?: IdSeed): string {
  return `${ID_PREFIX.PAYMENT}${DateUtil.formatCompactDate()}${nextSequence(ID_PREFIX.PAYMENT, 6, seed)}${randomSegment(6)}`;
}

/**
 * 生成退款单号：`SR` + yyyyMMdd + 6 位序列 + 6 位随机。
 *
 * @description 前缀取 `SR`（Sales Return），与 `docs/03-database.md` §1.3 保持一致
 * @param seed 退款单自增 ID（可选）
 * @returns 退款单号
 */
export function refundNo(seed?: IdSeed): string {
  return `${ID_PREFIX.REFUND}${DateUtil.formatCompactDate()}${nextSequence(ID_PREFIX.REFUND, 6, seed)}${randomSegment(6)}`;
}

/**
 * 生成充值单号：`RC` + yyyyMMdd + 6 位序列 + 6 位随机（v2 新增）。
 *
 * @param seed 充值单自增 ID（可选）
 * @returns 充值单号
 */
export function rechargeNo(seed?: IdSeed): string {
  return `${ID_PREFIX.RECHARGE}${DateUtil.formatCompactDate()}${nextSequence(ID_PREFIX.RECHARGE, 6, seed)}${randomSegment(6)}`;
}

/**
 * 生成资金流水号：`FT` + yyyyMMdd + 8 位序列。
 *
 * @description 流水号**不带随机段**：流水需要严格单调递增以便对账排序，
 * 唯一性由 DB 唯一索引保证（§3.6）
 * @param seed 流水自增 ID（可选）
 * @returns 资金流水号
 */
export function fundTxNo(seed?: IdSeed): string {
  return `${ID_PREFIX.FUND_TX}${DateUtil.formatCompactDate()}${nextSequence(ID_PREFIX.FUND_TX, 8, seed)}`;
}

/**
 * 生成券模板编号：`CT` + yyyyMMdd + 6 位序列（v2 新增）。
 *
 * @param seed 券模板自增 ID（可选）
 * @returns 券模板编号
 */
export function couponTemplateNo(seed?: IdSeed): string {
  return `${ID_PREFIX.COUPON_TEMPLATE}${DateUtil.formatCompactDate()}${nextSequence(ID_PREFIX.COUPON_TEMPLATE, 6, seed)}`;
}

/**
 * 生成券实例编号：`CP` + yyyyMMdd + 10 位序列 + 4 位随机（v2 新增）。
 *
 * @description 券实例数量级远大于订单，序列段加宽到 10 位；保留 4 位随机防枚举（券码可被直接输入兑换）
 * @param seed 券实例自增 ID（可选）
 * @returns 券实例编号
 */
export function couponInstanceNo(seed?: IdSeed): string {
  return `${ID_PREFIX.COUPON_INSTANCE}${DateUtil.formatCompactDate()}${nextSequence(
    ID_PREFIX.COUPON_INSTANCE,
    10,
    seed,
  )}${randomSegment(4)}`;
}

/**
 * 生成促销活动编号：`PM` + yyyyMMdd + 6 位序列（v2 新增）。
 *
 * @param seed 活动自增 ID（可选）
 * @returns 活动编号
 */
export function promotionNo(seed?: IdSeed): string {
  return `${ID_PREFIX.PROMOTION}${DateUtil.formatCompactDate()}${nextSequence(ID_PREFIX.PROMOTION, 6, seed)}`;
}

/**
 * 生成交易组号：`TG` + yyyyMMdd + 12 位序列 + 4 位随机（v2 新增）。
 *
 * @description `tx_group_no` 用于绑定「负债结转对」：一笔余额消费在同一组号下产生
 * 用户余额 OUT + 平台 IN（确认收入）+ 平台 OUT（冲减负债）三条流水。
 * 没有组号就无法证明后两条属于同一次结转，负债与收入会各自漂移（03 §1.3 澄清）。
 *
 * @param seed 自增 ID（可选）
 * @returns 交易组号
 */
export function txGroupNo(seed?: IdSeed): string {
  return `${ID_PREFIX.TX_GROUP}${DateUtil.formatCompactDate()}${nextSequence(ID_PREFIX.TX_GROUP, 12, seed)}${randomSegment(4)}`;
}

/**
 * 生成用户余额账户编号：`UB` + yyyyMMdd + 用户 ID 补零 12 位（v2 新增）。
 *
 * @description 账户号带开户日期便于人工识别；用户 ID 补零定长保证同一用户只会有一个账户号，
 * 与 `fund_accounts` 上的唯一索引配合，天然防重复开户
 * @description **确定性生成**（同 userId + 同日期 → 同账号），刻意区别于 orderNo 等带随机段的单号：
 * 开户是「每用户仅一次」的动作，确定性可让重试/补偿不会产生第二个账号号，
 * 且与 `fund_accounts` 的 `uk_user_account(userId, account_type)` 唯一索引语义天然契合。
 * 账号内嵌 userId 亦便于对账时反查归属。
 *
 * 边界：`padStart(12, '0')` **不截断**，userId 超过 12 位（≈1 万亿）时账号会超出 12 位。
 * 总长 = `UB`(2) + yyyyMMdd(8) + 12 = 22 字符，在 `account_no` 的 `VarChar(32)` 内留有余量。
 *
 * @param userId 用户 ID
 * @param openedAt 开户时间，默认当前时间
 * @returns 账户编号
 */
export function userBalanceAccountNo(userId: number | bigint, openedAt?: Date): string {
  const idText = BigInt(userId).toString().padStart(12, '0');
  return `${ID_PREFIX.USER_BALANCE_ACCOUNT}${DateUtil.formatCompactDate(openedAt ?? new Date())}${idText}`;
}

/**
 * 平台现金账户编号（全局唯一常量）。
 *
 * @description 一期单商户自营（假设 A1），平台现金账户只有一条，故为常量而非生成
 * @returns `ACC_PLATFORM_CASH`
 */
export function platformCashAccountNo(): string {
  return ID_PREFIX.PLATFORM_CASH_ACCOUNT;
}

/**
 * 生成 SKU 编码：`SKU-` + 8 位业务码。
 *
 * @description 后台可手工填写，此处仅做规范化（补零到 8 位）
 * @param bizCode 业务码（数字或数字字符串，≤ 8 位）
 * @returns SKU 编码
 */
export function skuCode(bizCode: number | bigint | string): string {
  const text = BigInt(bizCode).toString().padStart(8, '0');
  return `SKU-${text}`;
}

/**
 * 清空进程内序列计数器（仅供测试使用）。
 *
 * @returns void
 */
export function resetSequenceCounters(): void {
  sequenceCounters.clear();
}

/** 单号生成器聚合出口（便于 `IdGenerator.orderNo()` 形式调用） */
export const IdGenerator = {
  orderNo,
  paymentNo,
  refundNo,
  rechargeNo,
  fundTxNo,
  couponTemplateNo,
  couponInstanceNo,
  promotionNo,
  txGroupNo,
  userBalanceAccountNo,
  platformCashAccountNo,
  skuCode,
  ulid,
  generateRequestId,
  resetSequenceCounters,
} as const;

export default IdGenerator;
