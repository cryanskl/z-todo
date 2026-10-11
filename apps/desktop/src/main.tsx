import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createHost } from './host';
import './styles.css';
import { App } from './ui/App';
import { HostProvider } from './ui/host-context';

const root = createRoot(document.getElementById('root')!);

const queryClient = new QueryClient({
  defaultOptions: {
    // 本地库读写很快，不需要后台重试或窗口聚焦时重新拉取
    queries: { retry: false, refetchOnWindowFocus: false, staleTime: Infinity },
  },
});

function Fatal({ title, message }: { title: string; message: string }) {
  return (
    <div className="mx-auto max-w-xl p-10 text-sm">
      <h1 className="mb-3 text-base font-semibold">{title}</h1>
      <pre className="whitespace-pre-wrap text-red-700 dark:text-red-400" data-selectable>
        {message}
      </pre>
    </div>
  );
}

async function start() {
  const host = await createHost();
  const info = await host.appInfo();
  if (info.startupError) {
    root.render(<Fatal title="z-todo 无法打开数据库" message={info.startupError} />);
    return;
  }
  root.render(
    <StrictMode>
      <HostProvider host={host}>
        <QueryClientProvider client={queryClient}>
          <App />
        </QueryClientProvider>
      </HostProvider>
    </StrictMode>,
  );
}

start().catch((e: unknown) => {
  root.render(<Fatal title="z-todo 启动失败" message={e instanceof Error ? e.message : String(e)} />);
});
