// storage/scripts.ts
// 脚本池存储（spec §4）。单键 local:scripts:index（UserScript[]），沿用原总体设计 §8 键名。
// 个人量级（<100 条）全量读写无压力，YAGNI 分键。

import { storage } from 'wxt/utils/storage';
import type { ScriptSummary, UserScript } from '../shared/types';

const KEY = 'local:scripts:index' as const;

export const MAX_SCRIPTS = 200;
export const MAX_CODE_LENGTH = 256 * 1024;

export async function listScripts(): Promise<UserScript[]> {
  return (await storage.getItem<UserScript[]>(KEY)) ?? [];
}

export async function getScript(id: string): Promise<UserScript | undefined> {
  return (await listScripts()).find((s) => s.id === id);
}

/** upsert；数量/code 上限超限 throw（文案给用户/模型可读的中文原因）。 */
export async function saveScript(script: UserScript): Promise<void> {
  const all = await listScripts();
  const exists = all.some((s) => s.id === script.id);
  if (!exists && all.length >= MAX_SCRIPTS) {
    throw new Error(`脚本数量已达上限（${MAX_SCRIPTS} 条），请先删除部分脚本`);
  }
  if (script.code.length > MAX_CODE_LENGTH) {
    throw new Error(`脚本代码超过上限（${MAX_CODE_LENGTH} 字符）`);
  }
  const next = exists ? all.map((s) => (s.id === script.id ? script : s)) : [...all, script];
  await storage.setItem(KEY, next);
}

export async function deleteScript(id: string): Promise<void> {
  const all = await listScripts();
  await storage.setItem(KEY, all.filter((s) => s.id !== id));
}

export function toSummary(s: UserScript): ScriptSummary {
  return {
    id: s.id,
    name: s.name,
    matches: s.matches,
    enabled: s.enabled,
    source: s.source,
    runAt: s.runAt,
    world: s.world,
    updatedAt: s.updatedAt,
    description: s.meta?.description,
    hasGrants: (s.meta?.grants?.length ?? 0) > 0,
  };
}
