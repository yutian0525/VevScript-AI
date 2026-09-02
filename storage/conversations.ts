// storage/conversations.ts
// 会话独立实体存储（设计 §1）。key = local:conv:{id}，另存 local:conv-index 供列表 UI。
import { storage } from 'wxt/utils/storage';
import { nanoid } from 'nanoid';
import type { ChatMessage } from '../agent/provider/types';

export type ConversationStatus = 'idle' | 'running' | 'paused';

export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  status: ConversationStatus;
  createdAt: number;
  updatedAt: number;
  lastPromptTokens?: number;
  summary?: { text: string; coversUpTo: number };
}

export interface ConversationMeta {
  id: string;
  title: string;
  updatedAt: number;
  status: ConversationStatus;
}

const MAX_MESSAGES = 200;
const DEFAULT_TITLE = '新会话';
const key = (id: string) => `local:conv:${id}` as const;
const INDEX_KEY = 'local:conv-index';

async function readIndex(): Promise<ConversationMeta[]> {
  return (await storage.getItem<ConversationMeta[]>(INDEX_KEY)) ?? [];
}

async function writeIndex(index: ConversationMeta[]): Promise<void> {
  await storage.setItem(INDEX_KEY, index);
}

/** 把某会话的元数据写进 index（存在则更新），并按 updatedAt 倒序。 */
async function upsertIndex(conv: Conversation): Promise<void> {
  const index = await readIndex();
  const meta: ConversationMeta = { id: conv.id, title: conv.title, updatedAt: conv.updatedAt, status: conv.status };
  const rest = index.filter((m) => m.id !== conv.id);
  const next = [meta, ...rest].sort((a, b) => b.updatedAt - a.updatedAt);
  await writeIndex(next);
}

export async function listConversations(): Promise<ConversationMeta[]> {
  return readIndex();
}

export async function getConversation(id: string): Promise<Conversation> {
  const raw = await storage.getItem<Conversation>(key(id));
  if (raw) return raw;
  const now = 0;
  return { id, title: DEFAULT_TITLE, messages: [], status: 'idle', createdAt: now, updatedAt: now };
}

export async function saveConversation(conv: Conversation): Promise<void> {
  const next = { ...conv, updatedAt: Date.now() };
  await storage.setItem(key(conv.id), next);
  await upsertIndex(next);
}

export async function createConversation(): Promise<Conversation> {
  const now = Date.now();
  const conv: Conversation = { id: nanoid(), title: DEFAULT_TITLE, messages: [], status: 'idle', createdAt: now, updatedAt: now };
  await saveConversation(conv);
  return conv;
}

/** 追加消息（超 200 条裁剪最近）。若标题仍为默认值且这是首条 user 文本消息，用其前 30 字作标题。 */
export async function appendMessage(id: string, msg: ChatMessage): Promise<void> {
  const conv = await getConversation(id);
  const messages = [...conv.messages, msg];
  const trimmed = messages.length > MAX_MESSAGES ? messages.slice(messages.length - MAX_MESSAGES) : messages;
  let title = conv.title;
  if (title === DEFAULT_TITLE && msg.role === 'user' && typeof msg.content === 'string' && msg.content.trim()) {
    title = msg.content.trim().slice(0, 30);
  }
  await saveConversation({ ...conv, messages: trimmed, title });
}

export async function setStatus(id: string, status: ConversationStatus): Promise<void> {
  const conv = await getConversation(id);
  await saveConversation({ ...conv, status });
}

export async function renameConversation(id: string, title: string): Promise<void> {
  const conv = await getConversation(id);
  await saveConversation({ ...conv, title: title.trim() || DEFAULT_TITLE });
}

export async function deleteConversation(id: string): Promise<void> {
  await storage.removeItem(key(id));
  const index = await readIndex();
  await writeIndex(index.filter((m) => m.id !== id));
}

/** 设置最近一轮真实 prompt token（供上下文计量），同时不动消息。 */
export async function setLastPromptTokens(id: string, tokens: number): Promise<void> {
  const conv = await getConversation(id);
  await saveConversation({ ...conv, lastPromptTokens: tokens });
}

/** 写回摘要（原始 messages 不动）。 */
export async function setSummary(id: string, summary: { text: string; coversUpTo: number }): Promise<void> {
  const conv = await getConversation(id);
  await saveConversation({ ...conv, summary });
}
