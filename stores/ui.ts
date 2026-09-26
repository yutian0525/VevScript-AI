// stores/ui.ts
import { create } from 'zustand';
import type { ExtUpdateRequest, StorageManagerRequest } from '../shared/messages';
import type { ExtUpdateState } from '../shared/types';
// 类型专用导入（编译期擦除，不引入运行时循环：SettingsHome 依赖本 store）。
import type { SettingsSub } from '../components/settings/SettingsHome';

export type Page = 'chat' | 'scripts' | 'skills' | 'settings';

interface UiState {
  page: Page;
  setPage: (p: Page) => void;
  /** 扩展自身更新状态：App.tsx 挂载时 EXT_UPDATE_GET 回填 + EXT_UPDATE_STATE 广播实时更新。
   *  消费方：设置「关于软件」卡片的动态简述、关于页更新区块。 */
  extUpdate: ExtUpdateState | null;
  setExtUpdate: (u: ExtUpdateState | null) => void;
  /** 跨页跳转的一次性意图：从会话页浮层点「配置服务器」直接落到设置二级页。
   *  不持久化——每次进设置默认仍从列表开始，只有显式跳转才吃这个标记。 */
  pendingSettingsSub: SettingsSub | null;
  openSettings: (sub: SettingsSub) => void;
  clearPendingSettingsSub: () => void;
}

export const useUi = create<UiState>((set) => ({
  page: 'chat',
  setPage: (page) => set({ page }),
  extUpdate: null,
  setExtUpdate: (extUpdate) => set({ extUpdate }),
  pendingSettingsSub: null,
  openSettings: (sub) => set({ page: 'settings', pendingSettingsSub: sub }),
  clearPendingSettingsSub: () => set({ pendingSettingsSub: null }),
}));

export async function sendExtUpdateRequest<T = unknown>(req: ExtUpdateRequest): Promise<T> {
  return (await browser.runtime.sendMessage(req)) as T;
}

export async function sendStorageRequest<T = unknown>(req: StorageManagerRequest): Promise<T> {
  return (await browser.runtime.sendMessage(req)) as T;
}
