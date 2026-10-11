/**
 * Drizzle 只负责构造 SQL：
 * - 读：`createDb(host)` 返回的查询对象经宿主端口执行只读查询；
 * - 写：用 `stmt(drizzle 写语句)` 转成事务计划里的一条语句，交给 `host.tx` 原子执行。
 *   直接调用 `.run()` 会被拒绝，避免绕过事务和版本断言。
 */

import { drizzle } from 'drizzle-orm/sqlite-proxy';
import { DbError, type HostPort, type SqlParam, type Stmt } from '../host/types';
import { allTables } from './schema';

export function createDb(host: HostPort) {
  return drizzle(
    async (sql, params, method) => {
      if (method === 'run') {
        throw new DbError('not_readonly', '写操作请用 stmt() 放进事务计划，经 host.tx 执行');
      }
      const r = await host.query(sql, params as SqlParam[]);
      // sqlite-proxy 约定：get 返回单行数组，其余返回行数组。
      return { rows: method === 'get' ? (r.rows[0] ?? []) : r.rows };
    },
    { schema: allTables },
  );
}

export type Db = ReturnType<typeof createDb>;

interface ToSql {
  toSQL(): { sql: string; params: unknown[] };
}

/** 把 Drizzle 构造的写语句转成事务计划里的一条语句。 */
export function stmt(query: ToSql, expectChanges?: number): Stmt {
  const { sql, params } = query.toSQL();
  return expectChanges === undefined
    ? { sql, params: params as SqlParam[] }
    : { sql, params: params as SqlParam[], expectChanges };
}
