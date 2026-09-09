// storage/memory.ts
// Agent 记忆存储（spec §3.2）。单键 local:memory:index（MemoryEntry[]），与 storage/skills.ts 同构。
// 面板（设置页）与 AI 工具层共用本模块——记忆不走 background 编排层（无解析、无注入引擎）。
import { storage } from 'wxt/utils/storage';
import { nanoid } from 'nanoid';
import type { MemoryEntry } from '../shared/types';
import { isValidMatchPattern } from '../shared/match-pattern';

// 导出给 UI 侧 storage.watch 用——键名只此一处，改键不会让 watch 静默失效。
export const MEMORY_KEY = 'local:memory:index' as const;

export const MAX_ENTRIES = 100;
export const MAX_CONTENT_LENGTH = 500;

export async function listMemories(): Promise<MemoryEntry[]> {
  return (await storage.getItem<MemoryEntry[]>(MEMORY_KEY)) ?? [];
}

export async function getMemoryEntry(id: string): Promise<MemoryEntry | undefined> {
  return (await listMemories()).find((m) => m.id === id);
}

/**
 * upsert。数量上限 / 正文空与超长 / 非法 pattern 超限 throw（中文可读文案）。
 *
 * 非法 pattern 整条拒存（不同于脚本池的「跳过坏规则 + 警告」）：记忆只有一个 matches
 * 字段，静默跳过会让 AI 以为写成功了、而实际作用域是错的——这种失败必须显式。
 */
export async function saveMemory(entry: MemoryEntry): Promise<void> {
  const all = await listMemories();
  const exists = all.some((m) => m.id === entry.id);
  if (!exists && all.length >= MAX_ENTRIES) {
    throw new Error(`记忆数量已达上限（${MAX_ENTRIES} 条），请先删除部分记忆`);
  }
  if (!entry.content.trim()) {
    throw new Error('记忆正文不能为空');
  }
  if (entry.content.length > MAX_CONTENT_LENGTH) {
    throw new Error(`记忆正文超过上限（${MAX_CONTENT_LENGTH} 字符），请精简或拆成两条`);
  }
  const bad = entry.matches.find((p) => !isValidMatchPattern(p));
  if (bad != null) {
    throw new Error(`非法 match pattern：${bad}（形如 *://*.example.com/* 或 <all_urls>）`);
  }
  const next = exists ? all.map((m) => (m.id === entry.id ? entry : m)) : [...all, entry];
  await storage.setItem(MEMORY_KEY, next);
}

/** 幂等：不存在也成功。 */
export async function deleteMemory(id: string): Promise<void> {
  const all = await listMemories();
  await storage.setItem(MEMORY_KEY, all.filter((m) => m.id !== id));
}

/** 新条目工厂（AI 工具与设置页共用）。 */
export function newMemory(
  fields: { content: string; matches: string[]; source: 'ai' | 'user' },
): MemoryEntry {
  const now = Date.now();
  return { id: nanoid(8), createdAt: now, updatedAt: now, ...fields };
}
