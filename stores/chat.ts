// stores/chat.ts
import { create } from 'zustand';
import type { PortMsgToPanel } from '../shared/messages';

export type ChatStatus = 'idle' | 'running' | 'paused';

export interface ChatItem {
  role: 'user' | 'assistant' | 'tool' | 'error';
  text?: string;
  name?: string; args?: string; callId?: string;
  status?: 'running' | 'done'; ok?: boolean; summary?: string;
}

interface ChatState {
  messages: ChatItem[];
  status: ChatStatus;
  pauseReason?: string;
  addUserMessage: (text: string) => void;
  applyEvent: (e: PortMsgToPanel) => void;
  setStatus: (s: ChatStatus) => void;
  reset: () => void;
}

export const useChat = create<ChatState>((set) => ({
  messages: [],
  status: 'idle',
  addUserMessage: (text) => set((s) => ({ messages: [...s.messages, { role: 'user', text }], status: 'running' })),
  setStatus: (status) => set({ status }),
  reset: () => set({ messages: [], status: 'idle', pauseReason: undefined }),
  applyEvent: (e) => set((s) => {
    const messages = [...s.messages];
    switch (e.type) {
      case 'text-delta': {
        const last = messages[messages.length - 1];
        if (last?.role === 'assistant' && last.status == null) {
          messages[messages.length - 1] = { ...last, text: (last.text ?? '') + e.text };
        } else {
          messages.push({ role: 'assistant', text: e.text });
        }
        return { messages };
      }
      case 'tool-start':
        messages.push({ role: 'tool', name: e.name, args: e.args, callId: e.callId, status: 'running' });
        return { messages };
      case 'tool-end': {
        const idx = messages.findIndex((m) => m.role === 'tool' && m.callId === e.callId);
        if (idx >= 0) messages[idx] = { ...messages[idx]!, status: 'done', ok: e.ok, summary: e.summary };
        return { messages };
      }
      case 'state': return { status: e.status };
      case 'paused': return { status: 'paused', pauseReason: e.reason };
      case 'done': return { status: 'idle' };
      case 'error':
        messages.push({ role: 'error', text: e.message });
        return { messages, status: 'idle' };
      default: return {};
    }
  }),
}));
