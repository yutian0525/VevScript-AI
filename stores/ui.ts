// stores/ui.ts
import { create } from 'zustand';

export type Page = 'chat' | 'scripts' | 'settings';

interface UiState {
  page: Page;
  setPage: (p: Page) => void;
  /** 脚本详情态：非空 = ScriptsView 内路由到详情页 */
  scriptId: string | null;
  openScript: (id: string | null) => void;
}

export const useUi = create<UiState>((set) => ({
  page: 'chat',
  setPage: (page) => set({ page }),
  scriptId: null,
  openScript: (scriptId) => set({ scriptId }),
}));
