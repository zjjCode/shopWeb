/**
 * @file server/src/date.ts
 * @description 时间工具 DateUtil：dayjs 封装（统一时区 Asia/Shanghai）+ 时长解析
 * @module utils
 * @see docs/02-architecture.md §1.1（技术选型 dayjs）
 * @author 软件开发团队
 * @created 2026-09-03
 */

import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';

dayjs.extend(utc);
dayjs.extend(timezone);

/** 全站统一时区：数据库与应用同用东八区，避免「下单时间差 8 小时」这类经典事故 */
export const DEFAULT_TIMEZONE = 'Asia/Shanghai';

/** 常用格式化模板 */
export const DATE_FORMAT = {
  /** 2026-09-03 */
  DATE: 'YYYY-MM-DD',
  /** 2026-09-03 14:30:00 */
  DATETIME: 'YYYY-MM-DD HH:mm:ss',
  /** DATETIME(3) 落库格式 */
  DATETIME_MS: 'YYYY-MM-DD HH:mm:ss.SSS',
  /** 20260903（单号时间前缀） */
  COMPACT_DATE: 'YYYYMMDD',
  /** 2026-09-03T14:30:00+08:00 */
  ISO: 'YYYY-MM-DDTHH:mm:ssZ',
} as const;

/** 时长单位 → 秒 */
const DURATION_UNITS: Record<string, number> = {
  s: 1,
  sec: 1,
  secs: 1,
  m: 60,
  min: 60,
  mins: 60,
  h: 3600,
  hr: 3600,
  hrs: 3600,
  d: 86_400,
  day: 86_400,
  days: 86_400,
};

/** 时间入参类型 */
export type DateInput = Date | string | number | dayjs.Dayjs;

/**
 * 时间工具集。
 *
 * 约定：所有对外返回的时间统一为东八区 `Date` 对象或格式化字符串；
 * 落库交给 Prisma 传 `Date` 对象，禁止手工拼 SQL 时间字符串（防注入与时区漂移）。
 */
export class DateUtil {
  /** 统一时区 */
  static readonly TIMEZONE = DEFAULT_TIMEZONE;

  /**
   * 当前时间（东八区）。
   *
   * @returns dayjs 对象
   */
  static now(): dayjs.Dayjs {
    return dayjs().tz(DEFAULT_TIMEZONE);
  }

  /**
   * 当前时间戳（毫秒）。
   *
   * @returns 毫秒时间戳
   */
  static nowMs(): number {
    return Date.now();
  }

  /**
   * 当前时间（Date 对象），用于 Prisma 写入。
   *
   * @returns 当前 Date
   */
  static nowDate(): Date {
    return new Date();
  }

  /**
   * 解析任意时间入参。
   *
   * @param input 时间入参；为空时返回当前时间
   * @returns dayjs 对象（东八区）
   */
  static parse(input?: DateInput): dayjs.Dayjs {
    if (input === undefined || input === null) {
      return DateUtil.now();
    }
    return dayjs(input).tz(DEFAULT_TIMEZONE);
  }

  /**
   * 格式化时间。
   *
   * @param input 时间入参，默认当前时间
   * @param pattern 模板，默认 `YYYY-MM-DD HH:mm:ss`
   * @returns 格式化后的字符串
   */
  static format(input?: DateInput, pattern: string = DATE_FORMAT.DATETIME): string {
    return DateUtil.parse(input).format(pattern);
  }

  /** 格式化为 `YYYY-MM-DD` */
  static formatDate(input?: DateInput): string {
    return DateUtil.format(input, DATE_FORMAT.DATE);
  }

  /** 格式化为 `YYYYMMDD`（单号时间前缀） */
  static formatCompactDate(input?: DateInput): string {
    return DateUtil.format(input, DATE_FORMAT.COMPACT_DATE);
  }

  /** 加 N 分钟 */
  static addMinutes(input: DateInput, minutes: number): Date {
    return DateUtil.parse(input).add(minutes, 'minute').toDate();
  }

  /** 加 N 小时 */
  static addHours(input: DateInput, hours: number): Date {
    return DateUtil.parse(input).add(hours, 'hour').toDate();
  }

  /** 加 N 天 */
  static addDays(input: DateInput, days: number): Date {
    return DateUtil.parse(input).add(days, 'day').toDate();
  }

  /** 减 N 分钟 */
  static subtractMinutes(input: DateInput, minutes: number): Date {
    return DateUtil.parse(input).subtract(minutes, 'minute').toDate();
  }

  /** 减 N 天 */
  static subtractDays(input: DateInput, days: number): Date {
    return DateUtil.parse(input).subtract(days, 'day').toDate();
  }

  /**
   * 两个时间的毫秒差（a - b）。
   *
   * @param a 时间一
   * @param b 时间二
   * @returns 毫秒差（a 早于 b 时为负）
   */
  static diffMs(a: DateInput, b: DateInput): number {
    return DateUtil.parse(a).diff(DateUtil.parse(b));
  }

  /**
   * 两个时间的分钟差（a - b，向下取整）。
   *
   * @param a 时间一
   * @param b 时间二
   * @returns 分钟差
   */
  static diffMinutes(a: DateInput, b: DateInput): number {
    return DateUtil.parse(a).diff(DateUtil.parse(b), 'minute');
  }

  /** a 是否早于 b */
  static isBefore(a: DateInput, b: DateInput): boolean {
    return DateUtil.parse(a).isBefore(DateUtil.parse(b));
  }

  /** a 是否晚于 b */
  static isAfter(a: DateInput, b: DateInput): boolean {
    return DateUtil.parse(a).isAfter(DateUtil.parse(b));
  }

  /**
   * 判断某个时间点是否已过期。
   *
   * @param expireAt 过期时间
   * @param base 基准时间，默认当前时间
   * @returns 是否已过期
   */
  static isExpired(expireAt: DateInput, base: DateInput = DateUtil.now()): boolean {
    return DateUtil.parse(expireAt).isBefore(DateUtil.parse(base));
  }

  /**
   * 距过期时间的剩余秒数（已过期返回 0）。
   *
   * @param expireAt 过期时间
   * @param base 基准时间，默认当前时间
   * @returns 剩余秒数
   */
  static remainingSeconds(expireAt: DateInput, base: DateInput = DateUtil.now()): number {
    const seconds = DateUtil.parse(expireAt).diff(DateUtil.parse(base), 'second');
    return seconds > 0 ? seconds : 0;
  }

  /** 当天 00:00:00 */
  static startOfDay(input?: DateInput): Date {
    return DateUtil.parse(input).startOf('day').toDate();
  }

  /** 当天 23:59:59.999 */
  static endOfDay(input?: DateInput): Date {
    return DateUtil.parse(input).endOf('day').toDate();
  }

  /**
   * 解析时长字符串为秒数。
   *
   * @description 支持 `30s` / `15m` / `2h` / `7d`，用于 JWT TTL 与业务超时配置
   * @param expression 时长表达式
   * @param fallbackSeconds 解析失败时的兜底秒数
   * @returns 秒数
   */
  static parseDuration(expression: string, fallbackSeconds = 0): number {
    const matched = /^(\d+)\s*([a-zA-Z]+)$/.exec(expression.trim());
    if (!matched) {
      return fallbackSeconds;
    }
    const amount = Number(matched[1]);
    const unit = (matched[2] ?? '').toLowerCase();
    const unitSeconds = DURATION_UNITS[unit];
    if (unitSeconds === undefined) {
      return fallbackSeconds;
    }
    return amount * unitSeconds;
  }

  /**
   * 把 Date 转成 MySQL DATETIME(3) 字符串。
   *
   * @description 仅用于原生 SQL 与导出场景；常规读写请直接传 Date 给 Prisma
   * @param input 时间入参
   * @returns `YYYY-MM-DD HH:mm:ss.SSS`
   */
  static toMysqlDateTime(input?: DateInput): string {
    return DateUtil.format(input, DATE_FORMAT.DATETIME_MS);
  }
}

export default DateUtil;
