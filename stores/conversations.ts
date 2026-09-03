// stores/conversations.ts
// 会话列表 UI 状态（设计 §2.4）。当前会话切换协调 chat store（storage 是历史的权威源）。
import { create } from 'zustand';
import { nanoid } from 'nanoid';
import {
  listConversations, getConversation, renameConversation, deleteConversation,
  getCurrentConvId, setCurrentConvId,
  type ConversationMeta,
} from '../storage/conversations';
import { useChat } from './chat';
import { bindCurrentConvGetter } from './agent-port-client';

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
    useChat.setState({
      promptTokens: conv.lastPromptTokens,
      status: conv.status,
      compacting: false,
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
}));

// 端口客户端按当前会话过滤下行事件，这里把读取器注入（单向依赖，避免 store 循环 import）
bindCurrentConvGetter(() => useConversations.getState().currentId);
