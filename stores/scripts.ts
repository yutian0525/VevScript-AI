// stores/scripts.ts
// 脚本池前端状态（spec §7）：summaries + per-tab 运行态 + 搜索过滤。
// 运行区 = runtimeEntries[activeTabId]（组件侧取值）；广播按 tabId 全落，取值时按 activeTabId 过滤。

import { create } from 'zustand';
import type { ScriptsRequest, ScriptsRuntimeEntry, ScriptsRuntimeEvent, ScriptsListData } from '../shared/messages';
import type { ScriptSummary } from '../shared/types';

export async function sendScriptsRequest<T = unknown>(req: ScriptsRequest): Promise<T> {
  return (await browser.runtime.sendMessage(req)) as T;
}

/** 列表搜索：name/description/matches 大小写不敏感子串（纯函数，spec §9.1） */
export function filterSummaries(summaries: ScriptSummary[], query: string): ScriptSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return summaries;
  return summaries.filter(
    (s) =>
      s.name.toLowerCase().includes(q) ||
      (s.description ?? '').toLowerCase().includes(q) ||
      s.matches.some((m) => m.toLowerCase().includes(q)),
  );
}

interface ScriptsState {
  summaries: ScriptSummary[];
  runtimeEntries: Record<number, ScriptsRuntimeEntry>;
  activeTabId: number | null;
  query: string;
  loading: boolean;
  /** 引擎不可用文案（null = 可用） */
  engineWarning: string | null;
  setQuery: (q: string) => void;
  setActiveTab: (id: number | null) => void;
  applyRuntimeEvent: (e: ScriptsRuntimeEvent) => void;
  setEngineWarning: (w: string | null) => void;
  refresh: () => Promise<void>;
}

const ENGINE_WARNING_PREFIX = '脚本注入引擎不可用';

export const useScripts = create<ScriptsState>((set) => ({
  summaries: [],
  runtimeEntries: {},
  activeTabId: null,
  query: '',
  loading: false,
  engineWarning: null,

  setQuery: (query) => set({ query }),
  setActiveTab: (activeTabId) => set({ activeTabId }),

  applyRuntimeEvent: (e) =>
    set((s) => ({ runtimeEntries: { ...s.runtimeEntries, [e.payload.tabId]: e.payload } })),

  setEngineWarning: (engineWarning) => set({ engineWarning }),

  refresh: async () => {
    set({ loading: true });
    try {
      // 侧边栏里 currentWindow 有时取不到；退化到 lastFocusedWindow（对齐 ChatView 惯例）
      let [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tab) [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
      const listResp = await sendScriptsRequest<{ ok: boolean; data?: ScriptsListData }>({ type: 'SCRIPTS_LIST' });
      const rtResp = await sendScriptsRequest<{ ok: boolean; data?: { entries: ScriptsRuntimeEntry[] } }>({ type: 'SCRIPTS_GET_RUNTIME' });
      const entries = rtResp.data?.entries ?? [];
      set({
        summaries: listResp.data?.scripts ?? [],
        runtimeEntries: Object.fromEntries(entries.map((e) => [e.tabId, e])),
        activeTabId: tab?.id ?? null,
        engineWarning: listResp.data?.engineAvailable === false ? `${ENGINE_WARNING_PREFIX}：请在 chrome://extensions 开启开发者模式或升级 Chrome 120+` : null,
        loading: false,
      });
    } catch {
      set({ loading: false });
    }
  },
}));
