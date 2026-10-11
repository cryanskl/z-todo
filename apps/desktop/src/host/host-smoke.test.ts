/**
 * 宿主端口冒烟测试（TypeScript 侧）。
 * 与 Rust 的 src-tauri/db/tests/smoke.rs 读取同一份 tests/fixtures/host-smoke.json。
 */

import { describe, expect, it } from 'vitest';
import contract from '../../../../tests/fixtures/host-smoke.json';
import { createMemoryHost } from './memory';
import { DbError, toObjects, type SqlParam, type Stmt } from './types';

interface Expect {
  columns?: string[];
  rows?: Record<string, unknown>[];
  changes?: number[];
  error?: { kind: string; statementIndex?: number };
}
type Step =
  | { query: string; params?: SqlParam[]; expect: Expect }
  | { tx: Stmt[]; expect: Expect };
interface Scenario {
  name: string;
  seeds?: string[];
  steps: Step[];
}

const seeds = contract.seeds as Record<string, Stmt[]>;
const scenarios = contract.scenarios as unknown as Scenario[];

describe('宿主端口冒烟契约（内存宿主）', () => {
  it('契约非空', () => expect(scenarios.length).toBeGreaterThan(10));

  for (const sc of scenarios) {
    it(sc.name, async () => {
      const host = await createMemoryHost();
      for (const s of sc.seeds ?? []) await host.tx({ statements: seeds[s]! });

      for (const [i, step] of sc.steps.entries()) {
        const label = `第 ${i} 步`;
        const run = 'query' in step ? host.query(step.query, step.params) : host.tx({ statements: step.tx });
        const { expect: want } = step;

        if (want.error) {
          const err = await run.then(
            (r) => expect.unreachable(`${label}期望出错，实际返回 ${JSON.stringify(r)}`),
            (e: unknown) => e,
          );
          expect(err, label).toBeInstanceOf(DbError);
          expect((err as DbError).kind, label).toBe(want.error.kind);
          if (want.error.statementIndex !== undefined) {
            expect((err as DbError).statementIndex, label).toBe(want.error.statementIndex);
          }
          continue;
        }

        const result = await run;
        if ('columns' in result) {
          if (want.columns) expect(result.columns, label).toEqual(want.columns);
          if (want.rows) expect(toObjects(result), label).toEqual(want.rows);
        } else if (want.changes) {
          expect(result.changes, label).toEqual(want.changes);
        }
      }
    });
  }
});
