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
  pendingHeaders.clear();
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

/** 暂存头的上限（每 tab）：配对事件始终不来时防 map 随 tab 生命期无限增长。 */
const MAX_PENDING_HEADERS = 200;

interface PendingHeaders {
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
}

/** requestId → 暂存的 ExtraInfo 头（配对事件建条目时消费）。 */
const pendingHeaders = new Map<number, Map<string, PendingHeaders>>();

/** 合并两组头：extra（浏览器完整集）覆盖 base（渲染进程子集）的同名项。 */
function mergeHeaders(
  base: Record<string, string> | undefined,
  extra: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!extra) return base;
  if (!base) return extra;
  return { ...base, ...extra };
}

/** 取出并清除该 requestId 的暂存头。 */
function takePending(tabId: number, requestId: string): PendingHeaders | undefined {
  const m = pendingHeaders.get(tabId);
  const p = m?.get(requestId);
  if (!p) return undefined;
  m!.delete(requestId);
  if (m!.size === 0) pendingHeaders.delete(tabId);
  return p;
}

/** 条目建成/补全时套用暂存头（extra 覆盖条目已有的渲染进程子集）。 */
function applyPendingHeaders(tabId: number, requestId: string, e: NetEntry): void {
  const p = takePending(tabId, requestId);
  if (!p) return;
  if (p.requestHeaders) e.requestHeaders = mergeHeaders(e.requestHeaders, p.requestHeaders);
  if (p.responseHeaders) e.responseHeaders = mergeHeaders(e.responseHeaders, p.responseHeaders);
}

/**
 * 摄入 `Network.requestWillBeSentExtraInfo` / `responseReceivedExtraInfo` 的头。
 * 这两个事件携带浏览器补全后的完整头集（请求侧 Cookie / User-Agent / Origin / Referer /
 * Sec-Fetch-*，响应侧 Set-Cookie），是 requestWillBeSent / responseReceived 里那份
 * 渲染进程子集的超集；同名以本处为准。
 * 与配对事件没有固定先后：条目已在则立即并入，否则暂存待建条目时套用。
 */
export function ingestCdpExtraHeaders(tabId: number, requestId: string, r: PendingHeaders): void {
  const e = findCdp(tabId, requestId);
  if (e) {
    if (r.requestHeaders) e.requestHeaders = mergeHeaders(e.requestHeaders, r.requestHeaders);
    if (r.responseHeaders) e.responseHeaders = mergeHeaders(e.responseHeaders, r.responseHeaders);
    return;
  }
  let m = pendingHeaders.get(tabId);
  if (!m) { m = new Map(); pendingHeaders.set(tabId, m); }
  const cur = m.get(requestId) ?? {};
  if (r.requestHeaders) cur.requestHeaders = mergeHeaders(cur.requestHeaders, r.requestHeaders);
  if (r.responseHeaders) cur.responseHeaders = mergeHeaders(cur.responseHeaders, r.responseHeaders);
  // 重新 set 以刷新插入序（Map 按插入序迭代，超限时淘汰最早的那条）
  m.delete(requestId);
  m.set(requestId, cur);
  if (m.size > MAX_PENDING_HEADERS) m.delete(m.keys().next().value as string);
}

export function ingestCdpStart(
  tabId: number,
  r: { requestId: string; method: string; url: string; type: string; ts: number;
       requestHeaders?: Record<string, string>; requestBody?: string },
): void {
  const b = buf(tabId);
  const id = cdpId(r.requestId);
  const existing = b.network.find((n) => n.requestId === id);
  if (existing) {
    // CDP 在同一条重定向链上复用 requestId，每个 hop 都会再发一次 requestWillBeSent。
    // 无条件 push 会得到两条条目，而 findCdp 只命中首条——最终 hop 的 status/headers/body
    // 全被记到首跳 URL 上，模型真正关心的那个 URL 永远是空白。就地更新为最新一跳。
    existing.url = r.url;
    existing.method = r.method;
    if (r.requestHeaders) existing.requestHeaders = r.requestHeaders;
    return;
  }
  const entry: NetEntry = {
    requestId: id, method: r.method, url: r.url, type: r.type, ts: r.ts,
    requestHeaders: r.requestHeaders, requestBody: r.requestBody, source: 'cdp',
  };
  applyPendingHeaders(tabId, r.requestId, entry);
  b.network.push(entry);
  ring(b.network);
}

export function ingestCdpResponse(
  tabId: number,
  r: { requestId: string; status: number; responseHeaders?: Record<string, string>; mimeType?: string },
): void {
  const e = findCdp(tabId, r.requestId);
  if (!e) return;
  e.status = r.status;
  // 以已有头为高优先级：ExtraInfo 可能抢在 responseReceived 之前到达并已并入（extra 是
  // 浏览器完整集，渲染进程子集是其子集），此处只补它没覆盖到的名字，不整体覆盖。
  if (r.responseHeaders) e.responseHeaders = mergeHeaders(r.responseHeaders, e.responseHeaders);
  if (r.mimeType) e.mimeType = r.mimeType;
  applyPendingHeaders(tabId, r.requestId, e);
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
export function clearTab(tabId: number): void {
  tabs.delete(tabId);
  pendingHeaders.delete(tabId); // 暂存头随 tab 一起走，不跨 tab 生命期残留
}

export function clearTabNetwork(tabId: number): void {
  const b = tabs.get(tabId);
  if (b) b.network = [];
}
