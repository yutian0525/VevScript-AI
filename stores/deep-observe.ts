// stores/deep-observe.ts
// 深度观测的前端状态缓存（设计 §5.8）：SW 权威，本 store 只缓存广播与查询结果，不做判定。
import { create } from 'zustand';
import type { DeepObserveRequest, DeepObserveState } from '../shared/cdp';

interface DeepObserveStore {
  states: Record<number, DeepObserveState>;
  applyState: (s: DeepObserveState) => void;
  fetchState: (tabId: number) => Promise<void>;
  setEnabled: (tabId: number, enabled: boolean) => Promise<void>;
}

interface DeepObserveReply { ok: boolean; data?: DeepObserveState; error?: string }

export const useDeepObserve = create<DeepObserveStore>((set) => ({
  states: {},

  applyState: (s) => set((st) => ({ states: { ...st.states, [s.tabId]: s } })),

  fetchState: async (tabId) => {
    try {
      const resp = await browser.runtime.sendMessage(
        { type: 'DEEP_OBSERVE_GET', tabId } as DeepObserveRequest,
      ) as DeepObserveReply | undefined;
      if (resp?.data) set((st) => ({ states: { ...st.states, [resp.data!.tabId]: resp.data! } }));
    } catch {
      // 后台未就绪：保持未知态（开关按 off 渲染），下次广播或切换标签页会补上。
    }
  },

  setEnabled: async (tabId, enabled) => {
    try {
      const resp = await browser.runtime.sendMessage(
        { type: 'DEEP_OBSERVE_SET', tabId, enabled } as DeepObserveRequest,
      ) as DeepObserveReply | undefined;
      if (resp?.data) {
        set((st) => ({ states: { ...st.states, [resp.data!.tabId]: resp.data! } }));
      } else if (resp?.error) {
        set((st) => ({ states: { ...st.states, [tabId]: { tabId, status: 'error', reason: resp.error } } }));
      }
    } catch (e) {
      set((st) => ({
        states: { ...st.states, [tabId]: { tabId, status: 'error', reason: e instanceof Error ? e.message : String(e) } },
      }));
    }
  },
}));
