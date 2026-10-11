/** 生产宿主：经 Tauri IPC 调用 Rust 命令（src-tauri/src/commands.rs）。 */

import { invoke } from '@tauri-apps/api/core';
import {
  toHostError,
  type AiCall,
  type AiResponse,
  type AppInfo,
  type HostPort,
  type QueryResult,
  type SqlParam,
  type TxPlan,
  type TxResult,
} from './types';

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw toHostError(e);
  }
}

export function createTauriHost(): HostPort {
  return {
    kind: 'tauri',
    query: (sql: string, params: SqlParam[] = []) => call<QueryResult>('db_query', { sql, params }),
    tx: (plan: TxPlan) => call<TxResult>('db_tx', { plan }),
    ai: (req: AiCall) => call<AiResponse>('ai_call', { req }),
    hasApiKey: () => call<boolean>('has_api_key'),
    setApiKey: (key: string) => call<void>('set_api_key', { key }),
    deleteApiKey: () => call<void>('delete_api_key'),
    appInfo: () => call<AppInfo>('app_info'),
  };
}
