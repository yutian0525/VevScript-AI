// stores/ui.ts
import { create } from 'zustand';

export type Page = 'chat' | 'scripts' | 'debug' | 'settings';

interface UiState {
  page: Page;
  setPage: (p: Page) => void;
}

export const useUi = create<UiState>((set) => ({
  page: 'chat',
  setPage: (page) => set({ page }),
}));
