import { createContext, useContext, type ReactNode } from 'react';
import type { HostPort } from '../host/types';

const HostContext = createContext<HostPort | null>(null);

export function HostProvider({ host, children }: { host: HostPort; children: ReactNode }) {
  return <HostContext.Provider value={host}>{children}</HostContext.Provider>;
}

export function useHost(): HostPort {
  const host = useContext(HostContext);
  if (!host) throw new Error('useHost 必须在 HostProvider 内使用');
  return host;
}
