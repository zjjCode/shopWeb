/**
 * @file web/src/utils/format.ts
 * @description 通用格式化工具。
 */
import dayjs from 'dayjs';

/** 日期格式化（默认 YYYY-MM-DD HH:mm:ss） */
export function formatDateTime(value: string | number | Date | null | undefined, pattern = 'YYYY-MM-DD HH:mm:ss'): string {
  if (value == null || value === '') return '-';
  const d = dayjs(value);
  return d.isValid() ? d.format(pattern) : '-';
}

/** 截取文本长度 */
export function truncate(text: string | null | undefined, max = 20): string {
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
