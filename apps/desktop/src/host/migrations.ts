/**
 * 迁移脚本：与 Rust 宿主共用 src-tauri/db/migrations 下的同一批 SQL 文件。
 * 文件名形如 0001_init.sql，前缀即版本号。新增迁移只需放一个新文件
 * （Rust 侧还要在 zt-db 的 MIGRATIONS 里登记，有测试检查两边一致）。
 */

/** 写入数据库文件头的应用标识（ASCII "ztod"），与 Rust 的 zt_db::APPLICATION_ID 相同。 */
export const APPLICATION_ID = 0x7a746f64;

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

const files = import.meta.glob<string>('../../src-tauri/db/migrations/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
});

export const MIGRATIONS: readonly Migration[] = Object.entries(files)
  .map(([path, sql]) => {
    const name = path.split('/').pop()!.replace(/\.sql$/, '');
    const version = Number(name.slice(0, 4));
    if (!Number.isInteger(version) || version < 1) throw new Error(`迁移文件名不合法：${path}`);
    return { version, name, sql };
  })
  .sort((a, b) => a.version - b.version);

export const LATEST_SCHEMA = MIGRATIONS.at(-1)?.version ?? 0;
