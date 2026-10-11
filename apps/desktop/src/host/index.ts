/**
 * 选择宿主：在 Tauri 窗口里用 Rust 宿主；在普通浏览器里（`pnpm dev:web`）用 sql.js 内存库。
 * 内存宿主按需动态加载，生产包不会加载 sql.js。
 */

import { isTauri } from '@tauri-apps/api/core';
import type { HostPort } from './types';

export * from './types';

export async function createHost(): Promise<HostPort> {
  if (isTauri()) {
    const { createTauriHost } = await import('./tauri');
    return createTauriHost();
  }
  const [{ createMemoryHost }, { default: wasmUrl }] = await Promise.all([
    import('./memory'),
    import('sql.js/dist/sql-wasm.wasm?url'),
  ]);
  return createMemoryHost({ locateFile: () => wasmUrl });
}
