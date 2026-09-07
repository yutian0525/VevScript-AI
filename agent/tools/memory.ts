// agent/tools/memory.ts
// 三个记忆工具（spec §3.4）：list / write / delete。纯 storage 操作，不碰页面。
// 返回值刻意瘦身（照 toWriteResult 的教训）：不回灌全库、正文截断 120 字——
// 同一份内容在上下文里存两遍纯属浪费。
import type { ToolResult } from '../../shared/types';
import { matchUrl } from '../../shared/match-pattern';
import {
  listMemories, getMemoryEntry, saveMemory, deleteMemory, newMemory,
} from '../../storage/memory';
import type { MemoryEntry } from '../../shared/types';

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;
const SUMMARY_CHARS = 120;

export interface MemoryListEntry {
  id: string;
  content: string;
  matches: string[];
  source: 'ai' | 'user';
  updatedAt: number;
}

export interface MemoryListData {
  total: number;
  returned: number;
  entries: MemoryListEntry[];
}

export interface MemoryWriteData {
  id: string;
  /** 截断到 120 字的正文回显（确认写对了，不回灌全文） */
  content: string;
  matches: string[];
  created: boolean;
  total: number;
}

export interface MemoryDeleteData {
  id: string;
  deleted: boolean;
  total: number;
}

function truncate(s: string): string {
  return s.length <= SUMMARY_CHARS ? s : `${s.slice(0, SUMMARY_CHARS)}…`;
}

const byRecent = (a: MemoryEntry, b: MemoryEntry): number => b.updatedAt - a.updatedAt;

/**
 * scope 两趟匹配：先当完整 URL 走 matchUrl（精确），未命中再对 pattern 做大小写不敏感子串匹配
 * （关键词，如 'bilibili'）。全局记忆不参与——它们已常驻注入，混进来只挤占返回额度。
 */
function scopeMatch(entry: MemoryEntry, scope: string): boolean {
  if (entry.matches.length === 0) return false;
  if (matchUrl(entry.matches, scope)) return true;
  const kw = scope.toLowerCase();
  return entry.matches.some((p) => p.toLowerCase().includes(kw));
}

export async function doMemoryList(
  args: { scope?: string; limit?: number },
): Promise<ToolResult<MemoryListData>> {
  const all = await listMemories().catch(() => [] as MemoryEntry[]);
  const scope = args.scope?.trim();
  const filtered = scope ? all.filter((m) => scopeMatch(m, scope)) : all;
  const raw = Number(args.limit);
  const limit = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), MAX_LIMIT) : DEFAULT_LIMIT;
  const entries = [...filtered].sort(byRecent).slice(0, limit).map((m) => ({
    id: m.id, content: m.content, matches: m.matches, source: m.source, updatedAt: m.updatedAt,
  }));
  return { ok: true, data: { total: filtered.length, returned: entries.length, entries } };
}

export async function doMemoryWrite(
  args: { content?: string; matches?: string[]; id?: string },
): Promise<ToolResult<MemoryWriteData>> {
  const content = (args.content ?? '').trim();
  if (!content) return { ok: false, error: 'memory_write 缺少 content 参数（记忆正文）' };

  try {
    let entry: MemoryEntry;
    let created: boolean;
    if (args.id) {
      const old = await getMemoryEntry(args.id);
      if (!old) {
        return { ok: false, error: `没有 id 为「${args.id}」的记忆；不传 id 即新增一条，或先用 memory_list 查现有 id` };
      }
      // 保留 createdAt 与 source（来源是事实记录，不因 AI 改写而变）；matches 传了才改
      entry = { ...old, content, matches: args.matches ?? old.matches, updatedAt: Date.now() };
      created = false;
    } else {
      entry = newMemory({ content, matches: args.matches ?? [], source: 'ai' });
      created = true;
    }
    await saveMemory(entry);
    const total = (await listMemories()).length;
    return {
      ok: true,
      data: { id: entry.id, content: truncate(entry.content), matches: entry.matches, created, total },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function doMemoryDelete(
  args: { id: string },
): Promise<ToolResult<MemoryDeleteData>> {
  const id = (args.id ?? '').trim();
  if (!id) return { ok: false, error: 'memory_delete 缺少 id 参数' };
  try {
    const existed = (await getMemoryEntry(id)) != null;
    await deleteMemory(id);
    const total = (await listMemories()).length;
    return { ok: true, data: { id, deleted: existed, total } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
