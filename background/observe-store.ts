// background/observe-store.ts
// SW 侧 per-tab 观测环形缓冲（设计 §4、§8.3）。
// 数据逻辑纯粹、可单测；browser.webRequest 事件接线在 background.ts（不在本文件初始化时执行）。
import type { ConsoleEntry } from '../shared/observe';

const MAX_ENTRIES = 200;      // 每 tab 每通道环形上限

export const MAX_WS_FRAMES = 200;
export const MAX_WS_PAYLOAD = 4096;

/** 一条 WebSocket 帧。 */
export interface WsFrame { dir: 'sent' | 'received'; opcode: number; payload: string; ts: number }

export interface NetEntry {
  requestId: string;            // `wr:<webRequest id>` 或 `cdp:<CDP requestId>`
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
  mimeType?: string;
  wsFrames?: WsFrame[];
  truncated?: boolean;
  source: 'webRequest' | 'cdp';
}

/** id 命名空间前缀：webRequest 与 CDP 的 requestId 是两套独立空间，加前缀防撞号。 */
export function wrId(raw: string): string { return `wr:${raw}`; }
export function cdpId(raw: string): string { return `cdp:${raw}`; }

interface TabBuf {
  console: ConsoleEntry[];
  consoleIds: Set<string>;
  network: NetEntry[];
}

const tabs = new Map<number, TabBuf>();

// CDP 附着时该 tab 的网络由 CDP 独占，webRequest 主干静默（两套 id 无法对齐，硬合并只产生幽灵重复条目）。
let networkSuppressed: (tabId: number) => boolean = () => false;
export function setNetworkSuppressor(fn: (tabId: number) => boolean): void { networkSuppressed = fn; }

function buf(tabId: number): TabBuf {
  let b = tabs.get(tabId);
  if (!b) { b = { console: [], consoleIds: new Set(), network: [] }; tabs.set(tabId, b); }
  return b;
}

function ring<T>(arr: T[]): void {
  if (arr.length > MAX_ENTRIES) arr.splice(0, arr.length - MAX_ENTRIES);
}

/** 测试用：清空全部缓冲。 */
export function resetStore(): void {
  tabs.clear();
  networkSuppressed = () => false; // 抑制器一并复位，防前一用例挂上的状态串到后续用例
}

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
  if (networkSuppressed(tabId)) return;
  const b = buf(tabId);
  b.network.push({ requestId: wrId(r.requestId), method: r.method, url: r.url, type: r.type, ts: r.ts, source: 'webRequest' });
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
  const e = findByRequestId(wrId(requestId));
  if (e) { e.status = r.status; e.endTs = r.ts; }
}

export function recordRequestError(requestId: string, r: { error: string; ts: number }): void {
  const e = findByRequestId(wrId(requestId));
  if (e) { e.error = r.error; e.endTs = r.ts; }
}

// ---------- network：CDP 数据源 ----------
// CDP 的 requestId 在 session 内唯一，且摄入时已知道 tabId，故按 tab 内查找即可（无需全局扫描）。
function findCdp(tabId: number, requestId: string): NetEntry | undefined {
  const b = tabs.get(tabId);
  const id = cdpId(requestId);
  return b?.network.find((n) => n.requestId === id);
}

export function ingestCdpStart(
  tabId: number,
  r: { requestId: string; method: string; url: string; type: string; ts: number;
       requestHeaders?: Record<string, string>; requestBody?: string },
): void {
  const b = buf(tabId);
  b.network.push({
    requestId: cdpId(r.requestId), method: r.method, url: r.url, type: r.type, ts: r.ts,
    requestHeaders: r.requestHeaders, requestBody: r.requestBody, source: 'cdp',
  });
  ring(b.network);
}

export function ingestCdpResponse(
  tabId: number,
  r: { requestId: string; status: number; responseHeaders?: Record<string, string>; mimeType?: string },
): void {
  const e = findCdp(tabId, r.requestId);
  if (!e) return;
  e.status = r.status;
  if (r.responseHeaders) e.responseHeaders = r.responseHeaders;
  if (r.mimeType) e.mimeType = r.mimeType;
}

export function ingestCdpEnd(tabId: number, r: { requestId: string; ts: number }): void {
  const e = findCdp(tabId, r.requestId);
  if (e) e.endTs = r.ts;
}

export function ingestCdpError(tabId: number, r: { requestId: string; error: string; ts: number }): void {
  const e = findCdp(tabId, r.requestId);
  if (e) { e.error = r.error; e.endTs = r.ts; }
}

export function ingestCdpWsFrame(
  tabId: number,
  r: { requestId: string; dir: 'sent' | 'received'; opcode: number; payload: string; ts: number },
): void {
  const e = findCdp(tabId, r.requestId);
  if (!e) return;
  const frames = e.wsFrames ?? (e.wsFrames = []);
  frames.push({ dir: r.dir, opcode: r.opcode, payload: r.payload.slice(0, MAX_WS_PAYLOAD), ts: r.ts });
  if (frames.length > MAX_WS_FRAMES) frames.splice(0, frames.length - MAX_WS_FRAMES);
}

export function getCdpEntry(tabId: number, requestId: string): NetEntry | undefined {
  return findCdp(tabId, requestId);
}

export function setCdpBody(tabId: number, requestId: string, r: { body: string; truncated: boolean }): void {
  const e = findCdp(tabId, requestId);
  if (e) { e.responseBody = r.body; e.truncated = r.truncated; }
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
  if (b) b.network = [];
}
