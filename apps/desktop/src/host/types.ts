/**
 * 宿主端口：界面和业务层访问系统能力的唯一入口。
 *
 * - 生产实现 `tauri.ts`：经 Tauri IPC 调用 Rust（rusqlite、钥匙串、DeepSeek 转发）。
 * - 测试实现 `memory.ts`：sql.js 内存库 + 可注入的 AI 应答，用于单元测试、验收测试和浏览器模式开发。
 *
 * 两种实现必须对同一份冒烟契约（tests/fixtures/host-smoke.json）给出相同结果。
 * 这里的类型与 Rust 侧 `zt-db` 和 `src-tauri/src/commands.rs` 的 JSON 形状一一对应。
 */

export type SqlValue = string | number | null;
/** 布尔参数按 0/1 写入。 */
export type SqlParam = SqlValue | boolean;

export interface Stmt {
  sql: string;
  params?: SqlParam[];
  /** 期望的影响行数；不一致时整个事务回滚并抛出 `conflict`。用于版本断言。 */
  expectChanges?: number;
}

export interface TxPlan {
  statements: Stmt[];
}

export interface TxResult {
  changes: number[];
}

export interface QueryResult {
  columns: string[];
  rows: SqlValue[][];
}

export type Row = Record<string, SqlValue>;

export function toObjects(r: QueryResult): Row[] {
  return r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i] ?? null])));
}

export type DbErrorKind = 'conflict' | 'constraint' | 'not_readonly' | 'sql' | 'io';

export class DbError extends Error {
  override readonly name = 'DbError';
  constructor(
    readonly kind: DbErrorKind,
    message: string,
    /** 出错语句在事务计划里的下标（从 0 开始）。 */
    readonly statementIndex?: number,
  ) {
    super(message);
  }
}

export type AiMethod = 'get' | 'post';
export type AiPath = 'chat/completions' | 'models' | 'user/balance';

export interface AiCall {
  method: AiMethod;
  path: AiPath;
  /** strict 工具调用需要走 Beta 地址。 */
  beta?: boolean;
  body?: unknown;
}

export interface AiResponse {
  status: number;
  body: unknown;
  latencyMs: number;
}

export type AiErrorKind = 'no_key' | 'keychain' | 'network' | 'timeout';

export class AiError extends Error {
  override readonly name = 'AiError';
  constructor(
    readonly kind: AiErrorKind,
    message: string,
  ) {
    super(message);
  }
}

export interface AppInfo {
  version: string;
  dataDir: string;
  dbPath: string;
  schemaFrom: number;
  schemaTo: number;
  migrationBackup: string | null;
  /** 数据库无法打开时的说明；此时查询和写入都会失败，界面只显示这条信息。 */
  startupError: string | null;
}

export interface HostPort {
  readonly kind: 'tauri' | 'memory';
  /** 只读查询；写语句抛出 `not_readonly`。 */
  query(sql: string, params?: SqlParam[]): Promise<QueryResult>;
  /** 一组写语句，原子执行。 */
  tx(plan: TxPlan): Promise<TxResult>;
  /** DeepSeek 请求；非 2xx 照常返回，网络失败才抛 `AiError`。 */
  ai(call: AiCall): Promise<AiResponse>;
  hasApiKey(): Promise<boolean>;
  setApiKey(key: string): Promise<void>;
  deleteApiKey(): Promise<void>;
  appInfo(): Promise<AppInfo>;
}

const DB_KINDS: ReadonlySet<string> = new Set(['conflict', 'constraint', 'not_readonly', 'sql', 'io']);
const AI_KINDS: ReadonlySet<string> = new Set(['no_key', 'keychain', 'network', 'timeout']);

/** 把 Rust 命令返回的错误对象还原成对应的错误类。 */
export function toHostError(e: unknown): Error {
  if (e && typeof e === 'object' && 'kind' in e && 'message' in e) {
    const { kind, message } = e as { kind: string; message: string; statementIndex?: number };
    if (DB_KINDS.has(kind)) {
      return new DbError(kind as DbErrorKind, message, (e as { statementIndex?: number }).statementIndex);
    }
    if (AI_KINDS.has(kind)) return new AiError(kind as AiErrorKind, message);
  }
  return e instanceof Error ? e : new Error(String(e));
}
