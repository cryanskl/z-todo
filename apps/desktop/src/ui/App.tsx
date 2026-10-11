import { useEffect } from 'react';
import { useHost } from './host-context';
import { useNav, VIEWS, type ViewId } from './nav';
import { PlannedView } from './views/PlannedView';
import { SettingsView } from './views/SettingsView';

const SHORTCUTS: Record<string, ViewId> = { '1': 'review', '2': 'today', '3': 'calendar', '4': 'history', ',': 'settings' };

export function App() {
  const view = useNav((s) => s.view);
  const go = useNav((s) => s.go);
  const host = useHost();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.altKey || e.ctrlKey) return;
      const target = SHORTCUTS[e.key];
      if (target) {
        e.preventDefault();
        go(target);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go]);

  return (
    <div className="flex h-full">
      <nav className="flex w-52 shrink-0 flex-col border-r border-stone-200 bg-stone-100/70 px-3 pt-6 pb-4 dark:border-stone-800 dark:bg-stone-900/60">
        <div className="mb-6 flex items-center gap-2 px-2">
          <span className="grid size-6 place-items-center rounded-md bg-accent text-xs font-bold text-white">z</span>
          <span className="text-[15px] font-semibold tracking-tight">z-todo</span>
        </div>
        <ul className="flex flex-1 flex-col gap-0.5">
          {VIEWS.map((v) => (
            <li key={v.id} className={v.id === 'settings' ? 'mt-auto' : undefined}>
              <button
                type="button"
                onClick={() => go(v.id)}
                aria-current={view === v.id ? 'page' : undefined}
                className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
                  view === v.id
                    ? 'bg-white font-medium text-stone-900 shadow-sm dark:bg-stone-800 dark:text-stone-50'
                    : 'text-stone-600 hover:bg-stone-200/60 dark:text-stone-400 dark:hover:bg-stone-800/60'
                }`}
              >
                <span>{v.label}</span>
                {v.shortcut && <span className="text-[11px] text-stone-400 dark:text-stone-500">{v.shortcut}</span>}
              </button>
            </li>
          ))}
        </ul>
        <div className="px-2 pt-4 text-[11px] leading-relaxed text-stone-400 dark:text-stone-500">
          {host.kind === 'tauri' ? '本地数据库' : '浏览器模式 · 内存库，刷新即清空'}
        </div>
      </nav>

      <main className="min-w-0 flex-1 overflow-y-auto">
        {view === 'settings' ? <SettingsView /> : <PlannedView view={view} />}
      </main>
    </div>
  );
}
