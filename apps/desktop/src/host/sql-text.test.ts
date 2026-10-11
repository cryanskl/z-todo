import { describe, expect, it } from 'vitest';
import { castLargeIntegers, forbidden, leadingKeyword, scanSql } from './sql-text';

describe('leadingKeyword / forbidden', () => {
  it('跳过空白与注释', () => {
    expect(leadingKeyword('  -- c\n /* b */ select 1')).toBe('SELECT');
    expect(leadingKeyword('-- 只有注释')).toBe('');
  });

  it('查询里禁止事务控制和修改 PRAGMA，允许读取 PRAGMA', () => {
    expect(forbidden('BEGIN', false)).not.toBeNull();
    expect(forbidden('PRAGMA foreign_keys = OFF', false)).not.toBeNull();
    expect(forbidden('PRAGMA user_version(5)', false)).not.toBeNull();
    expect(forbidden('PRAGMA user_version', false)).toBeNull();
    expect(forbidden('SELECT * FROM pragma_table_info(?)', false)).toBeNull();
  });

  it('事务计划里任何 PRAGMA 都不允许', () => {
    expect(forbidden('PRAGMA user_version', true)).not.toBeNull();
    expect(forbidden('UPDATE task SET title = ?', true)).toBeNull();
  });
});

describe('scanSql', () => {
  it('只统计字符串、标识符、注释之外的占位符', () => {
    const sql = `SELECT '?', "a?b", [c?], \`d?\` /* ? */, ? -- ?\n , ?`;
    expect(scanSql(sql).placeholders).toHaveLength(2);
  });

  it('识别第一条语句之后的内容', () => {
    expect(scanSql('SELECT 1').hasTrailingStatement).toBe(false);
    expect(scanSql('SELECT 1;').hasTrailingStatement).toBe(false);
    expect(scanSql('SELECT 1; -- 注释').hasTrailingStatement).toBe(false);
    expect(scanSql("SELECT ';'").hasTrailingStatement).toBe(false);
    expect(scanSql('SELECT 1; SELECT 2').hasTrailingStatement).toBe(true);
  });
});

describe('castLargeIntegers', () => {
  it('只改写超出 32 位的整数参数', () => {
    const sql = 'SELECT ?, ?, ?, ?';
    const { placeholders } = scanSql(sql);
    expect(castLargeIntegers(sql, placeholders, [1, 1760000000000, 1.5, 'x'])).toBe('SELECT ?, CAST(? AS INTEGER), ?, ?');
  });
});
