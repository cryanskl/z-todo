import { describe, expect, it } from 'vitest';
import { addDays, endOfLocalDay, localDateOf, startOfLocalDay, toLocalIso, weekdayOf } from './time';

const CST = 480; // UTC+8

describe('localDateOf', () => {
  it('按记录时的偏移归属日期，而不是按 UTC', () => {
    // 2026-10-11 23:30 (UTC+8) = 2026-10-11 15:30Z
    const ms = Date.UTC(2026, 9, 11, 15, 30);
    expect(localDateOf(ms, CST)).toBe('2026-10-11');
    // 2026-10-12 00:30 (UTC+8) = 2026-10-11 16:30Z
    expect(localDateOf(ms + 3_600_000, CST)).toBe('2026-10-12');
  });

  it('同一时间点在不同偏移下可以落在不同日期', () => {
    const ms = Date.UTC(2026, 9, 11, 20, 0); // 2026-10-11 20:00Z
    expect(localDateOf(ms, CST)).toBe('2026-10-12');
    expect(localDateOf(ms, -300)).toBe('2026-10-11');
  });
});

describe('startOfLocalDay / endOfLocalDay', () => {
  it('互为边界，且一天长度为 24 小时', () => {
    const start = startOfLocalDay('2026-10-11', CST);
    const end = endOfLocalDay('2026-10-11', CST);
    expect(end - start).toBe(86_400_000 - 1);
    expect(localDateOf(start, CST)).toBe('2026-10-11');
    expect(localDateOf(end, CST)).toBe('2026-10-11');
    expect(localDateOf(end + 1, CST)).toBe('2026-10-12');
  });

  it('拒绝不合法或不存在的日期', () => {
    expect(() => startOfLocalDay('2026-2-1', CST)).toThrow(RangeError);
    expect(() => startOfLocalDay('2026-02-30', CST)).toThrow(RangeError);
  });
});

describe('addDays', () => {
  it('跨月、跨年', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('toLocalIso / weekdayOf', () => {
  it('输出带偏移的本地时间，可被 Date.parse 还原', () => {
    const ms = Date.UTC(2026, 9, 10, 23, 30); // 2026-10-11 07:30 (UTC+8)
    expect(toLocalIso(ms, CST)).toBe('2026-10-11T07:30+08:00');
    expect(Date.parse(toLocalIso(ms, CST))).toBe(ms);
    expect(toLocalIso(ms, -330)).toBe('2026-10-10T18:00-05:30');
    expect(Date.parse(toLocalIso(ms, -330))).toBe(ms);
  });

  it('星期几', () => {
    expect(weekdayOf('2026-10-11')).toBe(0);
    expect(weekdayOf('2026-10-17')).toBe(6);
  });
});
