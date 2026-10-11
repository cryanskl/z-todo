/**
 * 不依赖 SQLite 的 SQL 文本分析，供测试宿主补齐 sql.js 与 rusqlite 的行为差异：
 * - 开头关键字（跳过空白与注释），用于禁止事务控制、修改 PRAGMA 等语句；
 * - 字符串、标识符、注释之外的 `?` 占位符与 `;` 的位置。
 * 规则与 Rust 侧 zt-db 的 `leading_keyword` / `forbidden` 保持一致。
 */

export function leadingKeyword(sql: string): string {
  let i = 0;
  for (;;) {
    while (i < sql.length && /\s/.test(sql[i]!)) i++;
    if (sql.startsWith('--', i)) {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? sql.length : nl + 1;
    } else if (sql.startsWith('/*', i)) {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
    } else break;
  }
  return (/^[A-Za-z]+/.exec(sql.slice(i))?.[0] ?? '').toUpperCase();
}

/** 查询接口和事务计划都不允许的语句；返回原因，允许时返回 null。 */
export function forbidden(sql: string, inTx: boolean): string | null {
  switch (leadingKeyword(sql)) {
    case 'BEGIN':
    case 'COMMIT':
    case 'END':
    case 'ROLLBACK':
    case 'SAVEPOINT':
    case 'RELEASE':
      return '事务由宿主管理，不能执行事务控制语句';
    case 'ATTACH':
    case 'DETACH':
      return '不能附加或分离数据库';
    case 'VACUUM':
    case 'REINDEX':
    case 'ANALYZE':
    case 'EXPLAIN':
      return '不支持这类维护或分析语句';
    case 'PRAGMA':
      if (inTx) return '事务计划里不能包含 PRAGMA';
      if (sql.includes('=') || sql.includes('(')) {
        return '只能读取 PRAGMA，不能修改；表结构请用 SELECT ... FROM pragma_table_info(?)';
      }
      return null;
    default:
      return null;
  }
}

export interface SqlScan {
  /** 位置参数 `?` 在原文中的下标 */
  placeholders: number[];
  /** 第一条语句之后是否还有内容（多条语句） */
  hasTrailingStatement: boolean;
}

/** 扫描字符串、带引号的标识符和注释之外的 `?` 与 `;`。 */
export function scanSql(sql: string): SqlScan {
  const placeholders: number[] = [];
  let i = 0;
  let firstSemicolon = -1;
  const n = sql.length;
  while (i < n) {
    const c = sql[i]!;
    if (c === "'" || c === '"' || c === '`') {
      const close = sql.indexOf(c, i + 1);
      i = close === -1 ? n : close + 1; // '' 转义相当于连续两个字符串，结果一样
    } else if (c === '[') {
      const close = sql.indexOf(']', i + 1);
      i = close === -1 ? n : close + 1;
    } else if (sql.startsWith('--', i)) {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? n : nl + 1;
    } else if (sql.startsWith('/*', i)) {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
    } else if (c === '?') {
      if (firstSemicolon === -1) placeholders.push(i);
      i++;
    } else if (c === ';') {
      if (firstSemicolon === -1) firstSemicolon = i;
      i++;
    } else {
      i++;
    }
  }
  const rest = firstSemicolon === -1 ? '' : sql.slice(firstSemicolon + 1);
  return { placeholders, hasTrailingStatement: /[^\s;]/.test(stripComments(rest)) };
}

function stripComments(s: string): string {
  return s.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

/**
 * sql.js 只把 32 位以内的整数按整数绑定，更大的（毫秒时间戳）按浮点数绑定，
 * 导致 `? / 7` 这类运算与 rusqlite 不同。这里把这类参数的占位符改写成 CAST(? AS INTEGER)。
 */
export function castLargeIntegers(sql: string, placeholders: number[], params: readonly unknown[]): string {
  let out = '';
  let last = 0;
  placeholders.forEach((pos, k) => {
    const p = params[k];
    if (typeof p === 'number' && Number.isInteger(p) && (p > INT32_MAX || p < INT32_MIN)) {
      out += `${sql.slice(last, pos)}CAST(? AS INTEGER)`;
      last = pos + 1;
    }
  });
  return out + sql.slice(last);
}
