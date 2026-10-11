import { create } from 'zustand';

export type ViewId = 'review' | 'today' | 'calendar' | 'history' | 'settings';

export interface ViewMeta {
  id: ViewId;
  label: string;
  shortcut?: string;
}

export const VIEWS: readonly ViewMeta[] = [
  { id: 'review', label: '输入 / 核对', shortcut: '⌘1' },
  { id: 'today', label: '当前', shortcut: '⌘2' },
  { id: 'calendar', label: '日历', shortcut: '⌘3' },
  { id: 'history', label: '历史', shortcut: '⌘4' },
  { id: 'settings', label: '设置', shortcut: '⌘,' },
];

interface NavState {
  view: ViewId;
  go: (view: ViewId) => void;
}

export const useNav = create<NavState>((set) => ({
  view: 'today',
  go: (view) => set({ view }),
}));
