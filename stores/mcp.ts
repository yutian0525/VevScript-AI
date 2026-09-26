// stores/mcp.ts
// MCP 的面板侧状态缓存（设计 §5/§8）：后台是权威，本 store 只缓存查询结果与广播，不做判定。
// 与 stores/deep-observe.ts 同构。
import { create } from 'zustand';
import type { McpImportData, McpRequest, McpTestData } from '../shared/messages';
import type { McpServerConfig, McpServerState, McpStatusItem } from '../shared/mcp';

export async function sendMcpRequest<T = unknown>(req: McpRequest): Promise<T> {
  return (await browser.runtime.sendMessage(req)) as T;
}

interface McpReply<T> { ok: boolean; data?: T; error?: string }

interface McpStore {
  items: McpStatusItem[];
  /** 是否已拉过一次（浮层与设置页共用，避免重复首屏请求）。 */
  loaded: boolean;
  refresh: () => Promise<void>;          // 只读列表，不触发连接
  reconnectAll: () => Promise<void>;     // 拉齐：启用的一律重连
  connect: (id: string) => Promise<void>;
  disconnect: (id: string) => Promise<void>;
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
  save: (server: McpServerConfig) => Promise<void>;
  remove: (id: string) => Promise<void>;
  test: (server: McpServerConfig) => Promise<McpTestData>;
  importJson: (text: string) => Promise<McpImportData>;
  exportJson: () => Promise<string>;
  applyEvent: (states: McpServerState[]) => void;
}

export const useMcp = create<McpStore>((set) => {
  /** 统一收口：绝大多数 MCP handler 都回全量列表，直接整体替换最省心。 */
  const applyItems = (items: McpStatusItem[] | undefined) => {
    if (items) set({ items, loaded: true });
    else set({ loaded: true });
  };

  const call = async (req: McpRequest): Promise<McpReply<McpStatusItem[]>> => {
    try {
      const r = await sendMcpRequest<McpReply<McpStatusItem[]>>(req);
      applyItems(r?.data);
      return r ?? { ok: false, error: '后台无响应' };
    } catch (e) {
      // 后台未就绪（扩展刚重载）：保持现状，下次请求或广播会补上
      set({ loaded: true });
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  };

  return {
    items: [],
    loaded: false,

    refresh: async () => { await call({ type: 'MCP_LIST' }); },
    reconnectAll: async () => { await call({ type: 'MCP_REFRESH' }); },
    connect: async (id) => { await call({ type: 'MCP_CONNECT', id }); },
    disconnect: async (id) => { await call({ type: 'MCP_DISCONNECT', id }); },
    setEnabled: async (id, enabled) => { await call({ type: 'MCP_SET_ENABLED', id, enabled }); },
    save: async (server) => { await call({ type: 'MCP_SAVE', server }); },
    remove: async (id) => { await call({ type: 'MCP_REMOVE', id }); },

    test: async (server) => {
      const r = await sendMcpRequest<McpReply<McpTestData>>({ type: 'MCP_TEST', server });
      if (!r?.ok) throw new Error(r?.error ?? '连接失败');
      return r.data ?? { tools: 0 };
    },

    importJson: async (text) => {
      const r = await sendMcpRequest<McpReply<McpImportData>>({ type: 'MCP_IMPORT', text });
      if (!r?.ok) throw new Error(r?.error ?? '导入失败');
      applyItems(r.data?.items);
      return r.data ?? { imported: 0, warnings: [], items: [] };
    },

    exportJson: async () => {
      const r = await sendMcpRequest<McpReply<{ text: string }>>({ type: 'MCP_EXPORT' });
      if (!r?.ok || !r.data) throw new Error(r?.error ?? '导出失败');
      return r.data.text;
    },

    // 广播只带状态不带配置字段：按 id 并入既有条目，未见的条目保持原样
    applyEvent: (states) => set((st) => ({
      items: st.items.map((it) => {
        const s = states.find((x) => x.id === it.id);
        return s ? { ...it, ...s } : it;
      }),
    })),
  };
});

// 广播订阅挂在模块层：面板任何地方用了这个 store 都能实时跟随状态变化。
browser.runtime.onMessage.addListener((msg: unknown) => {
  const m = msg as { type?: string; states?: McpServerState[] };
  if (m?.type === 'MCP_STATE' && Array.isArray(m.states)) {
    useMcp.getState().applyEvent(m.states);
  }
});
