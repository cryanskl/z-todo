import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { AiError, toObjects } from '../../host/types';
import { useHost } from '../host-context';

export function SettingsView() {
  return (
    <section className="mx-auto max-w-2xl space-y-10 px-10 py-10">
      <h1 className="text-xl font-semibold tracking-tight">设置</h1>
      <ApiKeySection />
      <DiagnosticsSection />
    </section>
  );
}

function SectionTitle({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="mb-3">
      <h2 className="text-sm font-semibold">{title}</h2>
      {hint && <p className="mt-1 text-xs leading-relaxed text-stone-500 dark:text-stone-400">{hint}</p>}
    </div>
  );
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function ApiKeySection() {
  const host = useHost();
  const qc = useQueryClient();
  const [draft, setDraft] = useState('');
  const hasKey = useQuery({ queryKey: ['hasApiKey'], queryFn: () => host.hasApiKey() });

  const save = useMutation({
    mutationFn: (key: string) => host.setApiKey(key),
    onSuccess: () => {
      setDraft('');
      void qc.invalidateQueries({ queryKey: ['hasApiKey'] });
    },
  });
  const remove = useMutation({
    mutationFn: () => host.deleteApiKey(),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['hasApiKey'] }),
  });
  const test = useMutation({
    mutationFn: async () => {
      const r = await host.ai({ method: 'get', path: 'models' });
      if (r.status !== 200) throw new Error(`DeepSeek 返回 HTTP ${r.status}：${JSON.stringify(r.body)}`);
      const data = (r.body as { data?: { id: string }[] }).data ?? [];
      return { models: data.map((m) => m.id), latencyMs: r.latencyMs };
    },
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (draft.trim()) save.mutate(draft);
  };

  const browserOnly = (e: unknown) => e instanceof AiError && e.kind === 'network' && host.kind === 'memory';
  const storage = host.kind === 'tauri' ? '保存在 macOS 钥匙串里，界面拿不到明文' : '浏览器模式下只保存在内存里';

  return (
    <div>
      <SectionTitle title="DeepSeek API Key" hint={`用于拆分和排程。${storage}。`} />
      <div className="rounded-xl border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
        <div className="mb-3 flex items-center gap-2 text-sm">
          <span
            className={`size-2 rounded-full ${hasKey.data ? 'bg-emerald-500' : 'bg-stone-300 dark:bg-stone-600'}`}
            aria-hidden
          />
          {hasKey.isPending ? '读取中…' : hasKey.data ? '已设置' : '未设置'}
        </div>
        <form onSubmit={onSubmit} className="flex gap-2">
          <input
            type="password"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={hasKey.data ? '输入新的 Key 以替换' : 'sk-…'}
            autoComplete="off"
            spellCheck={false}
            className="min-w-0 flex-1 rounded-md border border-stone-300 bg-transparent px-3 py-1.5 font-mono text-sm outline-none placeholder:font-sans focus:border-accent dark:border-stone-700"
          />
          <button
            type="submit"
            disabled={!draft.trim() || save.isPending}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
          >
            保存
          </button>
        </form>
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={() => test.mutate()}
            disabled={!hasKey.data || test.isPending}
            className="rounded-md border border-stone-300 px-3 py-1 text-xs disabled:opacity-40 dark:border-stone-700"
          >
            {test.isPending ? '测试中…' : '测试连接'}
          </button>
          <button
            type="button"
            onClick={() => remove.mutate()}
            disabled={!hasKey.data || remove.isPending}
            className="rounded-md px-3 py-1 text-xs text-stone-500 hover:text-red-700 disabled:opacity-40"
          >
            删除 Key
          </button>
        </div>
        {(save.error ?? remove.error) && (
          <p className="mt-3 text-xs text-red-700 dark:text-red-400" data-selectable>
            {errorText(save.error ?? remove.error)}
          </p>
        )}
        {test.data && (
          <p className="mt-3 text-xs text-emerald-700 dark:text-emerald-400" data-selectable>
            连接正常（{test.data.latencyMs} ms），可用模型：{test.data.models.join('、') || '（空）'}
          </p>
        )}
        {test.error && (
          <p
            className={`mt-3 text-xs ${browserOnly(test.error) ? 'text-stone-500 dark:text-stone-400' : 'text-red-700 dark:text-red-400'}`}
            data-selectable
          >
            {browserOnly(test.error) ? '浏览器模式不连接 DeepSeek，请在桌面 app 里测试。' : errorText(test.error)}
          </p>
        )}
      </div>
    </div>
  );
}

function DiagnosticsSection() {
  const host = useHost();
  const info = useQuery({
    queryKey: ['diagnostics'],
    queryFn: async () => {
      const [app, schema, tables] = await Promise.all([
        host.appInfo(),
        host.query('PRAGMA user_version'),
        host.query("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"),
      ]);
      return {
        app,
        userVersion: toObjects(schema)[0]?.user_version,
        tables: toObjects(tables)[0]?.n,
      };
    },
  });

  const rows: [string, string][] = info.data
    ? [
        ['宿主', host.kind === 'tauri' ? 'Tauri（Rust + SQLite 文件）' : '浏览器模式（sql.js 内存库）'],
        ['版本', info.data.app.version],
        ['数据库', info.data.app.dbPath],
        ['数据库结构版本', `${info.data.userVersion}（本次启动 ${info.data.app.schemaFrom} → ${info.data.app.schemaTo}）`],
        ['表数量', String(info.data.tables)],
        ['迁移前备份', info.data.app.migrationBackup ?? '无'],
      ]
    : [];

  return (
    <div>
      <SectionTitle title="诊断" hint="确认数据库已正确打开和迁移。" />
      <div className="rounded-xl border border-stone-200 bg-white p-4 text-sm dark:border-stone-800 dark:bg-stone-900">
        {info.isPending && '读取中…'}
        {info.error && <span className="text-red-700 dark:text-red-400">{errorText(info.error)}</span>}
        <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-2" data-selectable>
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-stone-500 dark:text-stone-400">{k}</dt>
              <dd className="font-mono text-xs leading-5 break-all">{v}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
