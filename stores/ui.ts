// stores/ui.ts
import { create } from 'zustand';
import type { ExtUpdateRequest } from '../shared/messages';
import type { ExtUpdateState } from '../shared/types';

export type Page = 'chat' | 'scripts' | 'skills' | 'settings';

interface UiState {
  page: Page;
  setPage: (p: Page) => void;
  /** 扩展自身更新状态：App.tsx 挂载时 EXT_UPDATE_GET 回填 + EXT_UPDATE_STATE 广播实时更新。
   *  消费方：设置「关于软件」卡片的动态简述、关于页更新区块。 */
  extUpdate: ExtUpdateState | null;
  setExtUpdate: (u: ExtUpdateState | null) => void;
}

export const useUi = create<UiState>((set) => ({
  page: 'chat',
  setPage: (page) => set({ page }),
  extUpdate: null,
  setExtUpdate: (extUpdate) => set({ extUpdate }),
}));

export async function sendExtUpdateRequest<T = unknown>(req: ExtUpdateRequest): Promise<T> {
  return (await browser.runtime.sendMessage(req)) as T;
}
