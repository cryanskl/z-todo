/** Drizzle 表定义必须与迁移后的真实库逐列一致。 */

import { and, eq } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import { createMemoryHost } from '../host/memory';
import { DbError, toObjects } from '../host/types';
import { createDb, stmt } from './client';
import { allTables, task } from './schema';

describe('Drizzle 表定义与迁移一致', async () => {
  const host = await createMemoryHost();

  it('表名集合相同', async () => {
    const r = toObjects(
      await host.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"),
    );
    const actual = r.map((x) => x.name);
    const declared = Object.values(allTables).map((t) => getTableConfig(t).name).sort();
    expect(declared).toEqual(actual);
  });

  for (const t of Object.values(allTables)) {
    const cfg = getTableConfig(t);
    it(`${cfg.name}：列名、非空、主键一致`, async () => {
      const info = toObjects(
        await host.query('SELECT name, "notnull" AS nn, pk FROM pragma_table_info(?) ORDER BY cid', [cfg.name]),
      );
      const compositePk = new Set(cfg.primaryKeys.flatMap((pk) => pk.columns.map((c) => c.name)));
      const declared = cfg.columns.map((c) => ({
        name: c.name,
        notNull: c.notNull,
        pk: c.primary || compositePk.has(c.name),
      }));
      const actual = info.map((c) => ({ name: c.name, notNull: c.nn === 1, pk: Number(c.pk) > 0 }));
      const byName = (a: { name: unknown }, b: { name: unknown }) => String(a.name).localeCompare(String(b.name));
      expect(declared.sort(byName)).toEqual(actual.sort(byName));
    });
  }
});

describe('Drizzle 经宿主端口读写', () => {
  it('写语句进事务计划，读语句经只读查询', async () => {
    const host = await createMemoryHost();
    const db = createDb(host);

    await host.tx({
      statements: [
        stmt(
          db.insert(task).values({ id: 't1', title: '写综述', lifecycle: 'active', origin: 'manual', createdAt: 1, updatedAt: 1 }),
          1,
        ),
      ],
    });
    const rows = await db.select({ id: task.id, title: task.title, version: task.version }).from(task);
    expect(rows).toEqual([{ id: 't1', title: '写综述', version: 1 }]);

    const one = await db.select().from(task).where(eq(task.id, 't1')).get();
    expect(one?.priority).toBe('medium');

    // 版本断言：用旧版本号更新，整个事务回滚
    const err = await host
      .tx({
        statements: [
          stmt(
            db.update(task).set({ title: '改过', version: 2, updatedAt: 2 }).where(and(eq(task.id, 't1'), eq(task.version, 9))),
            1,
          ),
        ],
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DbError);
    expect((err as DbError).kind).toBe('conflict');
  });

  it('直接 run() 写入会被拒绝', async () => {
    const host = await createMemoryHost();
    const db = createDb(host);
    const err = await db
      .insert(task)
      .values({ id: 't1', title: 'x', lifecycle: 'inbox', origin: 'manual', createdAt: 0, updatedAt: 0 })
      .run()
      .catch((e: unknown) => e);
    // Drizzle 会把回调里的错误包一层，原始错误在 cause 里。
    const cause = (err as Error).cause;
    expect(cause).toBeInstanceOf(DbError);
    expect((cause as DbError).kind).toBe('not_readonly');
    expect(await host.query('SELECT count(*) AS n FROM task')).toEqual({ columns: ['n'], rows: [[0]] });
  });
});
