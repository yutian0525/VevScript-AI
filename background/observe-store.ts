// background/observe-store.ts
// SW 侧 per-tab 观测环形缓冲（设计 §4、§8.3）。
// 数据逻辑纯粹、可单测；browser.webRequest 事件接线在 Task 11 的 background.ts（不在本文件初始化时执行）。
import type { ConsoleEntry, HookNetEntry } from '../shared/hook-bridge';

const MAX_ENTRIES = 200;      // 每 tab 每通道环形上限
const MATCH_WINDOW_MS = 2000; // hook body 关联时间窗

/** 合并后的网络条目（webRequest 主干 + hook 富化）。 */
export interface NetEntry {
  requestId: string;            // webRequest 原生 id，或 hook:<loadNonce>:<seq>
  method: string;
  url: string;
  type: string;                 // resourceType（document/xmlhttprequest/...）
  ts: number;
  endTs?: number;
  status?: number;
  error?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBody?: string;
  responseBody?: string;
  truncated?: boolean;
  source: 'webRequest' | 'hook' | 'merged';
  _hookMerged?: boolean;        // 内部：已被某条 hook 富化（防重复关联）
}

interface TabBuf {
  console: ConsoleEntry[];
  consoleIds: Set<string>;
  network: NetEntry[];
  hookKeys: Set<string>;   // 已消费的 hook 网络条目键（loadNonce:seq），防双投递重复关联/建条
}

const tabs = new Map<number, TabBuf>();

function buf(tabId: number): TabBuf {
  let b = tabs.get(tabId);
  if (!b) { b = { console: [], consoleIds: new Set(), network: [], hookKeys: new Set() }; tabs.set(tabId, b); }
  return b;
}

function ring<T>(arr: T[]): void {
  if (arr.length > MAX_ENTRIES) arr.splice(0, arr.length - MAX_ENTRIES);
}

/** 测试用：清空全部缓冲。 */
export function resetStore(): void { tabs.clear(); }

// ---------- console ----------
export function ingestConsole(tabId: number, entries: ConsoleEntry[]): void {
  const b = buf(tabId);
  for (const e of entries) {
    if (b.consoleIds.has(e.id)) continue; // backlog flush 去重
    b.consoleIds.add(e.id);
    b.console.push(e);
  }
  ring(b.console);
  // id 是 loadNonce:seq 单调不复用；ring 淘汰后重建去重集，防 consoleIds 随 tab 生命期无限增长。
  if (b.consoleIds.size > b.console.length) b.consoleIds = new Set(b.console.map((e) => e.id));
}

export function readConsole(tabId: number, opts: { level?: string; limit?: number }): ConsoleEntry[] {
  const b = tabs.get(tabId);
  if (!b) return [];
  let list = b.console;
  if (opts.level) list = list.filter((e) => e.level === opts.level);
  const limit = opts.limit ?? 50;
  return list.slice(-limit).reverse(); // 最新在前
}

// ---------- network：webRequest 主干 ----------
export function recordRequestStart(
  tabId: number,
  r: { requestId: string; method: string; url: string; type: string; ts: number },
): void {
  const b = buf(tabId);
  b.network.push({ requestId: r.requestId, method: r.method, url: r.url, type: r.type, ts: r.ts, source: 'webRequest' });
  ring(b.network);
}

function findByRequestId(requestId: string): NetEntry | undefined {
  for (const b of tabs.values()) {
    const hit = b.network.find((n) => n.requestId === requestId);
    if (hit) return hit;
  }
  return undefined;
}

export function recordRequestEnd(requestId: string, r: { status: number; ts: number }): void {
  const e = findByRequestId(requestId);
  if (e) { e.status = r.status; e.endTs = r.ts; }
}

export function recordRequestError(requestId: string, r: { error: string; ts: number }): void {
  const e = findByRequestId(requestId);
  if (e) { e.error = r.error; e.endTs = r.ts; }
}

// ---------- network：hook body 关联富化 ----------
export function ingestHookNet(tabId: number, entries: HookNetEntry[]): void {
  const b = buf(tabId);
  for (const h of entries) {
    const key = `${h.loadNonce}:${h.seq}`;
    if (b.hookKeys.has(key)) continue; // 双投递（backlog flush + live）去重
    b.hookKeys.add(key);
    const match = b.network.find(
      (n) => n.source !== 'hook' && !n._hookMerged &&
        n.method === h.method && n.url === h.url &&
        Math.abs(n.ts - h.ts) <= MATCH_WINDOW_MS,
    );
    if (match) {
      match._hookMerged = true;
      match.source = 'merged';
      if (h.status != null && match.status == null) match.status = h.status;
      if (h.endTs != null && match.endTs == null) match.endTs = h.endTs;
      match.requestHeaders = h.requestHeaders;
      match.responseHeaders = h.responseHeaders;
      match.requestBody = h.requestBody;
      match.responseBody = h.responseBody;
      match.truncated = h.truncated;
    } else {
      b.network.push({
        requestId: `hook:${key}`, method: h.method, url: h.url, type: 'fetch',
        ts: h.ts, endTs: h.endTs, status: h.status,
        requestHeaders: h.requestHeaders, responseHeaders: h.responseHeaders,
        requestBody: h.requestBody, responseBody: h.responseBody, truncated: h.truncated,
        source: 'hook',
      });
    }
  }
  ring(b.network);
}

export interface NetSummary {
  requestId: string; method: string; url: string; status?: number; type: string;
  ts: number; durationMs?: number; hasBody: boolean;
}

export function readNetworkList(
  tabId: number,
  opts: { method?: string; urlContains?: string; status?: number; limit?: number },
): NetSummary[] {
  const b = tabs.get(tabId);
  if (!b) return [];
  let list = b.network;
  if (opts.method) list = list.filter((n) => n.method.toUpperCase() === opts.method!.toUpperCase());
  if (opts.urlContains) list = list.filter((n) => n.url.includes(opts.urlContains!));
  if (opts.status != null) list = list.filter((n) => n.status === opts.status);
  const limit = opts.limit ?? 50;
  return list.slice(-limit).reverse().map((n) => ({
    requestId: n.requestId, method: n.method, url: n.url, status: n.status, type: n.type, ts: n.ts,
    durationMs: n.endTs != null ? n.endTs - n.ts : undefined,
    hasBody: n.requestBody != null || n.responseBody != null,
  }));
}

/** 返回原始 NetEntry（含原文 headers/body，未脱敏）——脱敏由调用方读 settings 后做。 */
export function readNetworkDetail(tabId: number, requestId: string): NetEntry | undefined {
  const b = tabs.get(tabId);
  return b?.network.find((n) => n.requestId === requestId);
}

// ---------- 清理 ----------
export function clearTab(tabId: number): void { tabs.delete(tabId); }

export function clearTabNetwork(tabId: number): void {
  const b = tabs.get(tabId);
  if (b) { b.network = []; b.hookKeys.clear(); }
}
