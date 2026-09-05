// stores/scripts.ts
// 脚本池前端状态（spec §7）：summaries + per-tab 运行态 + 搜索过滤。
// 运行区 = runtimeEntries[activeTabId]（组件侧取值）；广播按 tabId 全落，取值时按 activeTabId 过滤。

import { create } from 'zustand';
import type { ScriptsRequest, ScriptsRuntimeEntry, ScriptsRuntimeEvent, ScriptsListData } from '../shared/messages';
import type { ScriptSummary } from '../shared/types';

export async function sendScriptsRequest<T = unknown>(req: ScriptsRequest): Promise<T> {
  return (await browser.runtime.sendMessage(req)) as T;
}

/** 全屏详情页入口（侧边栏卡片 / popup 编辑按钮共用）：新标签打开扩展自有页面。
 * script-detail.html 入口已由 Task 5 注册，getURL 走类型安全形式（.wxt/types/paths.d.ts 已含该路径）。 */
export function openScriptTab(id: string): void {
  void browser.tabs.create({ url: browser.runtime.getURL(`/script-detail.html?id=${encodeURIComponent(id)}`) });
}

export interface GmMenuEntry { scriptId: string; commands: Array<{ key: string; name: string }> }
export interface GmErrorItem { at: number; message: string; stack?: string; line?: number }

/** 当前 tab 运行集内脚本的菜单命令展开（纯函数，组件与 store 共用，spec §9.3） */
export function selectMenuCommands(
  entry: ScriptsRuntimeEntry | undefined, menus: GmMenuEntry[],
): Array<{ scriptId: string; key: string; name: string }> {
  if (!entry) return [];
  const out: Array<{ scriptId: string; key: string; name: string }> = [];
  for (const m of menus) {
    if (!entry.scriptIds.includes(m.scriptId)) continue;
    for (const c of m.commands) out.push({ scriptId: m.scriptId, key: c.key, name: c.name });
  }
  return out;
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
  /** GM_registerMenuCommand 菜单快照（全量替换，spec §11） */
  menus: GmMenuEntry[];
  /** 脚本运行错误环形缓冲（按 scriptId，上限 20） */
  errors: Record<string, GmErrorItem[]>;
  setQuery: (q: string) => void;
  setActiveTab: (id: number | null) => void;
  applyRuntimeEvent: (e: ScriptsRuntimeEvent) => void;
  setEngineWarning: (w: string | null) => void;
  applyMenusEvent: (e: { entries: GmMenuEntry[] }) => void;
  applyErrorEvent: (e: { scriptId: string; error: GmErrorItem }) => void;
  applyErrorCleared: (scriptId: string) => void;
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
  menus: [],
  errors: {},

  setQuery: (query) => set({ query }),
  setActiveTab: (activeTabId) => set({ activeTabId }),

  applyRuntimeEvent: (e) =>
    set((s) => ({ runtimeEntries: { ...s.runtimeEntries, [e.payload.tabId]: e.payload } })),

  setEngineWarning: (engineWarning) => set({ engineWarning }),

  applyMenusEvent: (e) => set({ menus: e.entries }),
  applyErrorEvent: (e) => set((s) => {
    const cur = s.errors[e.scriptId] ?? [];
    return { errors: { ...s.errors, [e.scriptId]: [...cur, e.error].slice(-20) } };
  }),
  applyErrorCleared: (scriptId) => set((s) => {
    const next = { ...s.errors }; delete next[scriptId]; return { errors: next };
  }),

  refresh: async () => {
    set({ loading: true });
    try {
      // 侧边栏里 currentWindow 有时取不到；退化到 lastFocusedWindow（对齐 ChatView 惯例）
      let [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tab) [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
      const listResp = await sendScriptsRequest<{ ok: boolean; data?: ScriptsListData }>({ type: 'SCRIPTS_LIST' });
      const rtResp = await sendScriptsRequest<{ ok: boolean; data?: { entries: ScriptsRuntimeEntry[] } }>({ type: 'SCRIPTS_GET_RUNTIME' });
      // GM 状态复水（面板重开而 SW 存活时，广播不补量——冷读一次；GmErrorEntry 形状与 GmErrorItem 一致）
      const gmResp = await sendScriptsRequest<{ ok: boolean; data?: { menus: GmMenuEntry[]; errors: Record<string, GmErrorItem[]> } }>({ type: 'SCRIPTS_GET_GM_STATE' });
      const entries = rtResp.data?.entries ?? [];
      set({
        summaries: listResp.data?.scripts ?? [],
        runtimeEntries: Object.fromEntries(entries.map((e) => [e.tabId, e])),
        activeTabId: tab?.id ?? null,
        engineWarning: listResp.data?.engineAvailable === false ? `${ENGINE_WARNING_PREFIX}：请在 chrome://extensions 开启开发者模式或升级 Chrome 120+` : null,
        menus: gmResp.data?.menus ?? [],
        errors: gmResp.data?.errors ?? {},
        loading: false,
      });
    } catch {
      set({ loading: false });
    }
  },
}));
