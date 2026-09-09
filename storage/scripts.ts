// storage/scripts.ts
// 脚本池存储（spec §4）。单键 local:scripts:index（UserScript[]），沿用原总体设计 §8 键名。
// 个人量级（<100 条）全量读写无压力，YAGNI 分键。
// 修订 2026-09-02（文本为源）：text 为唯一真源；旧记录（无 text）读取时用 stringifyUserScript 反拼惰性迁移。

import { storage } from 'wxt/utils/storage';
import type { ScriptSummary, UserScript } from '../shared/types';
import { stringifyUserScript } from '../shared/userscript-meta';
import { classifyGrants } from '../shared/gm-apis';

const KEY = 'local:scripts:index' as const;

export const MAX_SCRIPTS = 200;
export const MAX_CODE_LENGTH = 256 * 1024;
/** text = 头部 + 代码体，上限略宽于 code（修订 2026-09-02） */
export const MAX_TEXT_LENGTH = 280 * 1024;

/** 旧记录（无 text）→ stringifyUserScript 反拼补齐，并惰性写回（一次性迁移，失败不影响读取）。 */
async function migrateText(all: UserScript[]): Promise<UserScript[]> {
  let changed = false;
  const next = all.map((s) => {
    if (typeof s.text === 'string') return s;
    changed = true;
    return { ...s, text: stringifyUserScript(s) };
  });
  if (changed) await storage.setItem(KEY, next).catch(() => {});
  return next;
}

export async function listScripts(): Promise<UserScript[]> {
  return migrateText((await storage.getItem<UserScript[]>(KEY)) ?? []);
}

export async function getScript(id: string): Promise<UserScript | undefined> {
  return (await listScripts()).find((s) => s.id === id);
}

/** upsert；数量/code/text 上限超限 throw（文案给用户/模型可读的中文原因）。 */
export async function saveScript(script: UserScript): Promise<void> {
  const all = await listScripts();
  const exists = all.some((s) => s.id === script.id);
  if (!exists && all.length >= MAX_SCRIPTS) {
    throw new Error(`脚本数量已达上限（${MAX_SCRIPTS} 条），请先删除部分脚本`);
  }
  if (script.code.length > MAX_CODE_LENGTH) {
    throw new Error(`脚本代码超过上限（${MAX_CODE_LENGTH} 字符）`);
  }
  if (script.text.length > MAX_TEXT_LENGTH) {
    throw new Error(`脚本文本超过上限（${MAX_TEXT_LENGTH} 字符）`);
  }
  const next = exists ? all.map((s) => (s.id === script.id ? script : s)) : [...all, script];
  await storage.setItem(KEY, next);
}

export async function deleteScript(id: string): Promise<void> {
  const all = await listScripts();
  await storage.setItem(KEY, all.filter((s) => s.id !== id));
}

// storage/scripts.ts —— toSummary 签名改为接收错误计数（SW 内存态由编排层持有）
export function toSummary(s: UserScript, errorCount = 0): ScriptSummary {
  const { supported, unsupported } = classifyGrants(s.meta?.grants ?? []);
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
    errorCount,
    hasRequires: (s.meta?.requires?.length ?? 0) > 0,
    grantSupported: supported,
    grantUnsupported: unsupported,
    lines: s.text.split('\n').length,
    bytes: s.text.length,
  };
}
