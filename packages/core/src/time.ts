/**
 * 时间与本地日期。
 *
 * 约定：所有时间点存 UTC 毫秒，同时存写入时的系统时区偏移（分钟，东八区为 +480）。
 * 一条记录归属哪一天，由「时间点 + 当时的偏移」算出，不依赖读取时的系统时区，
 * 所以出差改时区不会让历史数据跳日。
 */

const MINUTE_MS = 60_000;
export const DAY_MS = 86_400_000;

/** YYYY-MM-DD */
export type LocalDate = string;

const LOCAL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 时间点在给定偏移下的本地日期。 */
export function localDateOf(ms: number, tzOffsetMin: number): LocalDate {
  return new Date(ms + tzOffsetMin * MINUTE_MS).toISOString().slice(0, 10);
}

/** 本地日期在给定偏移下的 00:00:00.000 对应的 UTC 毫秒。 */
export function startOfLocalDay(date: LocalDate, tzOffsetMin: number): number {
  const m = LOCAL_DATE_RE.exec(date);
  if (!m) throw new RangeError(`不是合法的本地日期：${date}`);
  const utcMidnight = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (localDateOf(utcMidnight, 0) !== date) throw new RangeError(`不存在的日期：${date}`);
  return utcMidnight - tzOffsetMin * MINUTE_MS;
}

/**
 * 只填日期的截止时间：当天本地 23:59:59.999。
 * 需求文档：「只填日期时按系统时区的当日结束理解」。
 */
export function endOfLocalDay(date: LocalDate, tzOffsetMin: number): number {
  return startOfLocalDay(date, tzOffsetMin) + DAY_MS - 1;
}

/** 本地日期加减天数。 */
export function addDays(date: LocalDate, days: number): LocalDate {
  return localDateOf(startOfLocalDay(date, 0) + days * DAY_MS, 0);
}

/** 时间点在给定偏移下的本地 ISO 字符串（精确到分钟，带偏移），如 2026-10-11T07:30+08:00。 */
export function toLocalIso(ms: number, tzOffsetMin: number): string {
  const local = new Date(ms + tzOffsetMin * MINUTE_MS).toISOString().slice(0, 16);
  const sign = tzOffsetMin < 0 ? '-' : '+';
  const abs = Math.abs(tzOffsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${local}${sign}${hh}:${mm}`;
}

/** 本地日期是星期几：0 = 星期日 … 6 = 星期六。 */
export function weekdayOf(date: LocalDate): number {
  return new Date(startOfLocalDay(date, 0)).getUTCDay();
}
