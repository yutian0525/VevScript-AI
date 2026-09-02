// stores/conversations.ts
// 会话列表 UI 状态（设计 §2.4）。当前会话切换协调 chat store（storage 是历史的权威源）。
import { create } from 'zustand';
import { nanoid } from 'nanoid';
import {
  listConversations, getConversation, renameConversation, deleteConversation,
  type ConversationMeta,
} from '../storage/conversations';
import { useChat } from './chat';

interface ConvState {
  currentId: string | null;
  list: ConversationMeta[];
  menuOpen: boolean;
  refreshList: () => Promise<void>;
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

  // 新会话 = 客户端草稿 id（不落库）。首条消息发出后由 loop 的 appendMessage 建档。
  newConversation: async () => {
    useChat.getState().reset();
    set({ currentId: nanoid(), menuOpen: false });
  },

  switchTo: async (id) => {
    const conv = await getConversation(id);
    useChat.getState().loadFromStorage(conv.messages);
    // status 恢复：残留的 running（如 SW 被杀/中途关标签）本面板并未附着实时流，
    // 恢复成 running 会让输入框永久禁用且无 loop 来解除——本阶段一律降到 idle（并发发送仍有后台闸门拦截）。
    useChat.setState({
      promptTokens: conv.lastPromptTokens,
      status: conv.status === 'running' ? 'idle' : conv.status,
      compacting: false,
    });
    set({ currentId: id, menuOpen: false });
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
