// stores/conversations.ts
// 会话列表 UI 状态（设计 §2.4）。当前会话切换协调 chat store（storage 是历史的权威源）。
import { create } from 'zustand';
import { nanoid } from 'nanoid';
import {
  listConversations, getConversation, renameConversation, deleteConversation,
  getCurrentConvId, setCurrentConvId, setMode as storeSetMode,
  type ConversationMeta,
} from '../storage/conversations';
import type { AgentMode } from '../agent/mode';
import { useChat } from './chat';
import { bindCurrentConvGetter, postToAgent } from './agent-port-client';

interface ConvState {
  currentId: string | null;
  list: ConversationMeta[];
  menuOpen: boolean;
  refreshList: () => Promise<void>;
  /** 面板挂载入口：恢复上次会话（浏览器重启后 session 指针已失效 → 开新会话）。 */
  init: () => Promise<void>;
  newConversation: () => Promise<void>;
  switchTo: (id: string) => Promise<void>;
  rename: (id: string, title: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  setMenuOpen: (open: boolean) => void;
  /** 切换当前会话行为模式：本地即时生效 + agent:setMode 发后台（落库 + 运行中 loop 下轮生效）。 */
  setMode: (mode: AgentMode) => void;
}

export const useConversations = create<ConvState>((set, get) => ({
  currentId: null,
  list: [],
  menuOpen: false,

  refreshList: async () => set({ list: await listConversations() }),

  init: async () => {
    await get().refreshList();
    const last = await getCurrentConvId();
    if (last) await get().switchTo(last);
    else await get().newConversation();
  },

  // 新会话 = 客户端草稿 id（不落库）。首条消息发出后由 loop 的 appendMessage 建档。
  newConversation: async () => {
    useChat.getState().reset();
    const id = nanoid();
    set({ currentId: id, menuOpen: false });
    await setCurrentConvId(id);
  },

  switchTo: async (id) => {
    const conv = await getConversation(id);
    useChat.getState().loadFromStorage(conv.messages);
    // status 先按 storage 记的走（含 running），真伪由 agent:attach 的权威回包纠正：
    // 后台确有 loop 在跑 → 保持 running 并补发流式尾巴；已无 loop（SW 被杀等）→ 落回 idle。
    // 模式也先按 storage 走（新草稿无记录 = agent），attach 回包再对齐。
    useChat.setState({
      promptTokens: conv.lastPromptTokens,
      status: conv.status,
      compacting: false,
      mode: conv.mode ?? 'agent',
    });
    set({ currentId: id, menuOpen: false });
    await setCurrentConvId(id);
  },

  rename: async (id, title) => {
    const conv = await getConversation(id);
    if (conv.updatedAt === 0) return; // 草稿未落库：不给空会话建档
    await renameConversation(id, title);
    await get().refreshList();
  },

  remove: async (id) => {
    await deleteConversation(id);
    await get().refreshList();
    if (get().currentId === id) {
      const list = get().list;
      if (list.length > 0) await get().switchTo(list[0]!.id);
      else await get().newConversation();
    }
  },

  setMenuOpen: (menuOpen) => set({ menuOpen }),

  setMode: (mode) => {
    const id = get().currentId;
    if (!id) return;
    useChat.getState().setMode(mode); // 本地即时生效（下拉框不等后台回包）
    postToAgent({ type: 'agent:setMode', convId: id, mode });
  },
}));

// 端口客户端按当前会话过滤下行事件，这里把读取器注入（单向依赖，避免 store 循环 import）
bindCurrentConvGetter(() => useConversations.getState().currentId);
