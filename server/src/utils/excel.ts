/**
 * @file server/src/utils/excel.ts
 * @description 导出工具：CSV（带 UTF-8 BOM，Excel 直接打开不乱码）生成与单元格转义
 * @module utils
 * @see docs/02-architecture.md §5.7（列表与导出）
 * @author 软件开发团队
 * @created 2026-09-03
 *
 * 为什么一期只做 CSV 而不生成 xlsx：
 * 真正的 .xlsx 是 zip + XML 的复合格式，不引入 exceljs 这类依赖就只能造半个轮子，
 * 而一期导出的真实诉求是「运营能用 Excel 打开看数」，CSV 完全满足且零依赖、内存可控。
 * 若后续需要多 Sheet、单元格样式、合并表头，再引入 exceljs 并按同样的 `ExportColumn` 契约扩展。
 */

/** 导出列定义 */
export interface ExportColumn<T> {
  /** 表头文案 */
  header: string;
  /** 取值器：从一行数据里取出该列的原始值 */
  value: (row: T) => unknown;
  /** 可选格式化器：把原始值转成展示文本（如分 → 元、状态码 → 中文） */
  format?: (value: unknown, row: T) => string;
}

/** CSV 生成选项 */
export interface CsvOptions {
  /** 是否写入 UTF-8 BOM，默认 true（Windows Excel 无 BOM 会乱码） */
  withBom?: boolean;
  /** 行分隔符，默认 CRLF（Excel 与 RFC4180 均推荐） */
  rowSeparator?: string;
}

/** UTF-8 BOM 字节序列（EF BB BF） */
const UTF8_BOM = '﻿';

/**
 * 转义 CSV 单元格。
 *
 * @description 三条规则（RFC4180）：
 * 1. 含逗号、双引号、换行 → 整体加双引号包裹；
 * 2. 内部双引号 → 转义成两个双引号；
 * 3. 以 `=` `+` `-` `@` 开头的单元格前置单引号 —— 这是**公式注入防护**，
 *    否则导出的 `=cmd|'/c calc'!A1` 之类内容会在 Excel 里被当成公式执行。
 * @param value 原始值
 * @returns 转义后的单元格文本
 */
export function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }

  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`;
  }

  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/**
 * 把二维数据渲染成 CSV 文本。
 *
 * @param rows 数据行（每行为字符串数组）
 * @param options CSV 选项
 * @returns CSV 文本
 */
export function toCsv(rows: readonly (readonly string[])[], options: CsvOptions = {}): string {
  const { withBom = true, rowSeparator = '\r\n' } = options;
  const body = rows.map((row) => row.map((cell) => escapeCsvCell(cell)).join(',')).join(rowSeparator);
  return withBom ? `${UTF8_BOM}${body}` : body;
}

/**
 * 按列定义把业务数据渲染成 CSV。
 *
 * @description `null` / `undefined` / `Date` / 对象都有明确处理，
 * 避免导出列里出现 `[object Object]` 这种无法排查的内容
 * @param list 数据列表
 * @param columns 列定义
 * @param options CSV 选项
 * @returns CSV 文本（含表头行）
 */
export function toCsvByColumns<T>(
  list: readonly T[],
  columns: readonly ExportColumn<T>[],
  options: CsvOptions = {},
): string {
  const headerRow: string[] = columns.map((column) => column.header);

  const dataRows = list.map((row) =>
    columns.map((column) => {
      if (column.format !== undefined) {
        return column.format(column.value(row), row);
      }

      const raw = column.value(row);
      if (raw === null || raw === undefined) {
        return '';
      }
      if (raw instanceof Date) {
        return raw.toISOString();
      }
      if (typeof raw === 'object') {
        // 对象没有显式格式化器时序列化成 JSON，至少保证信息不丢且可读
        return JSON.stringify(raw);
      }
      return String(raw);
    }),
  );

  return toCsv([headerRow, ...dataRows], options);
}

/**
 * 构造导出文件名（含日期后缀，避免多次导出覆盖）。
 *
 * @param prefix 文件名前缀（英文，中文在某些浏览器下载头里会乱码）
 * @param extension 扩展名，默认 csv
 * @param now 基准时间，默认当前时间
 * @returns 形如 `orders_20260903_104512.csv` 的文件名
 */
export function buildExportFileName(prefix: string, extension = 'csv', now: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${prefix}_${stamp}.${extension}`;
}
