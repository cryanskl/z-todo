/**
 * 测试宿主：sql.js 内存库。语义与 Rust 宿主保持一致，由共用的冒烟契约保证。
 * 用于单元测试、验收测试和浏览器模式开发（`pnpm dev:web`），数据不落盘。
 */

import initSqlJs, { type Database, type SqlValue as SqlJsValue } from 'sql.js';
import { APPLICATION_ID, LATEST_SCHEMA, MIGRATIONS } from './migrations';
import { castLargeIntegers, forbidden, scanSql } from './sql-text';
import {
  AiError,
  DbError,
  type AiCall,
  type AiResponse,
  type AppInfo,
  type HostPort,
  type QueryResult,
  type SqlParam,
  type SqlValue,
  type TxPlan,
  type TxResult,
} from './types';

export type AiHandler = (call: AiCall) => AiResponse | Promise<AiResponse>;

export interface MemoryHostOptions {
  /** 浏览器里需要告诉 sql.js 去哪里加载 wasm；Node 里不用传。 */
  locateFile?: (file: string) => string;
  /** 模拟 DeepSeek 的应答，例如回放录制的夹具。不传时 AI 调用一律报网络错误。 */
  ai?: AiHandler;
  /** 预置的 API Key。 */
  apiKey?: string;
}

export interface MemoryHost extends HostPort {
  readonly kind: 'memory';
  /** 测试里替换 AI 应答。 */
  setAiHandler(handler: AiHandler | undefined): void;
  /** 底层 sql.js 库，仅供测试断言使用。 */
  readonly raw: Database;
}

// ---------------------------------------------------------------------------

function classify(e: unknown, statementIndex?: number): DbError {
  if (e instanceof DbError) {
    return statementIndex === undefined || e.statementIndex !== undefined
      ? e
      : new DbError(e.kind, e.message, statementIndex);
  }
  const message = e instanceof Error ? e.message : String(e);
  const kind = /constraint failed/i.test(message) ? 'constraint' : 'sql';
  return new DbError(kind, message, statementIndex);
}

function bindable(params: readonly SqlParam[] | undefined): SqlJsValue[] {
  return (params ?? []).map((p) => {
    if (typeof p === 'boolean') return p ? 1 : 0;
    if (p === undefined) return null;
    if (p === null || typeof p === 'number' || typeof p === 'string') return p;
    throw new DbError('sql', '参数只能是 null、布尔、数字或字符串；JSON 字段请先序列化为字符串');
  });
}

function fromSqlJs(v: SqlJsValue): SqlValue {
  if (v instanceof Uint8Array) throw new DbError('sql', '查询结果含 BLOB，z-todo 不使用 BLOB 列');
  return v;
}

/**
 * 编译前的检查，与 rusqlite 的行为对齐：禁止的语句、多条语句、参数个数。
 * 返回改写后的 SQL（大整数参数加 CAST，见 castLargeIntegers）。
 */
function prepareText(sql: string, params: readonly SqlParam[] | undefined, inTx: boolean, index?: number): string {
  const reason = forbidden(sql, inTx);
  if (reason) throw new DbError(inTx ? 'sql' : 'not_readonly', reason, index);
  const scan = scanSql(sql);
  if (scan.hasTrailingStatement) throw new DbError('sql', '一次只能执行一条语句', index);
  const count = params?.length ?? 0;
  if (scan.placeholders.length !== count) {
    throw new DbError('sql', `参数个数不符：语句需要 ${scan.placeholders.length} 个，传入 ${count} 个`, index);
  }
  return castLargeIntegers(sql, scan.placeholders, params ?? []);
}

function scalar(db: Database, sql: string): SqlValue {
  const r = db.exec(sql);
  return fromSqlJs(r[0]?.values[0]?.[0] ?? null);
}

function migrate(db: Database): void {
  const current = Number(scalar(db, 'PRAGMA user_version'));
  const appId = Number(scalar(db, 'PRAGMA application_id'));
  if (appId !== 0 && appId !== APPLICATION_ID) {
    throw new DbError('io', '这个文件不是 z-todo 的数据库（应用标识不符）');
  }
  if (current > LATEST_SCHEMA) {
    throw new DbError('io', `数据库版本 ${current} 高于本程序支持的 ${LATEST_SCHEMA}，请升级 z-todo`);
  }
  const pending = MIGRATIONS.filter((m) => m.version > current);
  if (pending.length === 0) return;

  // 与 Rust 一致：表重建需要在事务外关闭外键，提交前用 foreign_key_check 显式检查。
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN EXCLUSIVE');
    try {
      for (const m of pending) {
        try {
          db.exec(m.sql);
        } catch (e) {
          throw new DbError('io', `迁移 ${m.name} 失败：${e instanceof Error ? e.message : String(e)}`);
        }
        db.exec(`PRAGMA user_version = ${m.version}`);
      }
      db.exec(`PRAGMA application_id = ${APPLICATION_ID}`);
      const violations = Number(scalar(db, 'SELECT count(*) FROM pragma_foreign_key_check'));
      if (violations > 0) throw new DbError('io', `迁移后外键检查发现 ${violations} 处问题，已回滚`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

// ---------------------------------------------------------------------------

export async function createMemoryHost(opts: MemoryHostOptions = {}): Promise<MemoryHost> {
  const SQL = await initSqlJs(opts.locateFile ? { locateFile: opts.locateFile } : undefined);
  const db = new SQL.Database();
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);

  let apiKey: string | undefined = opts.apiKey;
  let aiHandler = opts.ai;

  const host: MemoryHost = {
    kind: 'memory',
    raw: db,

    async query(sql: string, params?: SqlParam[]): Promise<QueryResult> {
      const text = prepareText(sql, params, false);
      // query_only 让任何写入在执行时失败，判断依据与 sqlite3_stmt_readonly 相同。
      db.exec('PRAGMA query_only = 1');
      let stmt;
      try {
        stmt = db.prepare(text);
        stmt.bind(bindable(params));
        const columns = stmt.getColumnNames();
        const rows: SqlValue[][] = [];
        while (stmt.step()) rows.push(stmt.get().map(fromSqlJs));
        return { columns, rows };
      } catch (e) {
        if (e instanceof Error && /readonly database/i.test(e.message)) {
          throw new DbError('not_readonly', '查询接口只接受只读语句，写操作请放进事务');
        }
        throw classify(e);
      } finally {
        stmt?.free();
        db.exec('PRAGMA query_only = 0');
      }
    },

    async tx(plan: TxPlan): Promise<TxResult> {
      const changes: number[] = [];
      db.exec('BEGIN IMMEDIATE');
      try {
        plan.statements.forEach((s, i) => {
          const text = prepareText(s.sql, s.params, true, i);
          let n: number;
          try {
            const stmt = db.prepare(text);
            try {
              stmt.bind(bindable(s.params));
              // 与 rusqlite 的 execute 一致：语句返回结果行（SELECT、RETURNING）算错误
              if (stmt.step()) throw new DbError('sql', '事务里的语句不能返回结果', i);
            } finally {
              stmt.free();
            }
            n = db.getRowsModified();
          } catch (e) {
            throw classify(e, i);
          }
          if (s.expectChanges !== undefined && n !== s.expectChanges) {
            throw new DbError('conflict', `第 ${i} 条语句影响了 ${n} 行，期望 ${s.expectChanges} 行；数据可能已被修改`, i);
          }
          changes.push(n);
        });
        db.exec('COMMIT');
        return { changes };
      } catch (e) {
        db.exec('ROLLBACK');
        throw classify(e);
      }
    },

    async ai(call: AiCall): Promise<AiResponse> {
      if (!apiKey) throw new AiError('no_key', '还没有设置 DeepSeek API Key');
      if (!aiHandler) throw new AiError('network', '测试宿主没有配置 AI 应答');
      return aiHandler(call);
    },

    async hasApiKey() {
      return apiKey !== undefined;
    },

    async setApiKey(key: string) {
      const k = key.trim();
      if (!k) throw new AiError('keychain', 'API Key 不能为空');
      apiKey = k;
    },

    async deleteApiKey() {
      apiKey = undefined;
    },

    async appInfo(): Promise<AppInfo> {
      return {
        version: 'dev',
        dataDir: '（内存，不落盘）',
        dbPath: ':memory:',
        schemaFrom: 0,
        schemaTo: LATEST_SCHEMA,
        migrationBackup: null,
        startupError: null,
      };
    },

    setAiHandler(handler) {
      aiHandler = handler;
    },
  };
  return host;
}
