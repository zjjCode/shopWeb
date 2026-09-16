/**
 * @file web/src/utils/money.ts
 * @description 金额工具：分 ↔ 元。后端金额一律以「分」为整数单位。
 */

/** 分 → 元字符串（带千分位，保留 2 位） */
export function formatYuan(cents: number, withSymbol = true): string {
  const yuan = (cents ?? 0) / 100;
  const text = yuan.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return withSymbol ? `¥${text}` : text;
}

/** 元（字符串/数字）→ 分（整数）。非法输入返回 0。 */
export function parseYuanToFen(yuan: string | number): number {
  const num = typeof yuan === 'number' ? yuan : Number(String(yuan).trim());
  if (!Number.isFinite(num) || num < 0) return 0;
  return Math.round(num * 100);
}
