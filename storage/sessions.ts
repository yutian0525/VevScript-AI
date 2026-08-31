// storage/sessions.ts
// 每标签页会话历史（设计 §8）。key = local:session:{tabId}，最近 200 条。
import { storage } from 'wxt/utils/storage';
import type { ChatMessage } from '../agent/provider/types';

export type SessionStatus = 'idle' | 'running' | 'paused';

export interface Session {
  tabId: number;
  messages: ChatMessage[];
  status: SessionStatus;
  updatedAt: number;
}

const MAX_MESSAGES = 200;
const key = (tabId: number) => `local:session:${tabId}` as const;

export async function getSession(tabId: number): Promise<Session> {
  const raw = await storage.getItem<Session>(key(tabId));
  if (raw) return raw;
  return { tabId, messages: [], status: 'idle', updatedAt: 0 };
}

export async function saveSession(session: Session): Promise<void> {
  await storage.setItem(key(session.tabId), { ...session, updatedAt: Date.now() });
}

export async function appendMessage(tabId: number, msg: ChatMessage): Promise<void> {
  const s = await getSession(tabId);
  const messages = [...s.messages, msg];
  const trimmed = messages.length > MAX_MESSAGES ? messages.slice(messages.length - MAX_MESSAGES) : messages;
  await saveSession({ ...s, messages: trimmed });
}

export async function setStatus(tabId: number, status: SessionStatus): Promise<void> {
  const s = await getSession(tabId);
  await saveSession({ ...s, status });
}
