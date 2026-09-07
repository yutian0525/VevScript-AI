// background/gm-api.ts
// GM API SW 侧实现中心（spec §3/§8）：GM_API_CALL 分发、@grant 白名单、值存储与广播、
// 菜单表、错误环形缓冲、SetClipboard/Notification/OpenInTab；GM_xmlhttpRequest 的 @connect
// 确认流在 Task 10 并入（本任务先分发占位错误）。token 表查询（GM_BRIDGE_TOKENS）同。

import type { GmEventKind } from '../shared/gm-bridge';
import { storage } from 'wxt/utils/storage';
import { getScript } from '../storage/scripts';
import { matchUrl } from '../shared/match-pattern';
import { bridgeTokensForUrl } from './gm-token';
import { getTabData, saveTabData, getAllTabData, cleanupTabData } from './gm-tab-store';
import { classifyGrants } from '../shared/gm-apis';
import { enqueueConfirm } from './confirm-queue';
import { createRequest, type CsResponse, type GmDebugInfoData } from '../shared/messages';
import { OpenAICompatProvider } from '../agent/provider/openai-compat';
import type { ChatMessage, ContentPart, StreamEvent } from '../agent/provider/types';
import { getSettings } from '../storage/settings';
import { getLlmTier } from './gm-permissions';
import { listCookies, setCookie, deleteCookie, cookieTargetUrl, type CookieDetails } from './gm-cookie';
import { runDownload, type DownloadDetails } from './gm-download';

export interface GmErrorEntry {
  at: number;
  message: string;
  stack?: string;
  line?: number;
}

export interface GmMenuCommand {
  key: string;
  name: string;
  tabId: number; // 注册来源 tab（MENU_CLICK 回发目标）
}

interface GmCallRequest {
  scriptId: string;
  api: string;
  reqId: number;
  params: unknown[];
}

type Sender = { tab?: { id?: number; url?: string } } | undefined;

// bridge 侧短 API 名 → @grant 名映射（白名单查的是 script.meta.grants，见 spec §3）。
// 未在表内的 api 直接用其本名（如已是 GM_ 全名的调用）。
const API_TO_GRANT: Record<string, string> = {
  SetValue: 'GM_setValue',
  GetValue: 'GM_getValue',
  DeleteValue: 'GM_deleteValue',
  ListValues: 'GM_listValues',
  RegisterMenu: 'GM_registerMenuCommand',
  SetClipboard: 'GM_setClipboard',
  Notification: 'GM_notification',
  OpenInTab: 'GM_openInTab',
  CloseTab: 'GM_openInTab', // close 是 GM_openInTab 返回句柄上的方法，共用同一 grant
  XmlHttpRequest: 'GM_xmlhttpRequest',
  AbortRequest: 'GM_xmlhttpRequest',
  LlmChat: 'GM_llmChat',
  SetValues: 'GM_setValues',
  DeleteValues: 'GM_deleteValues',
  UnregisterMenu: 'GM_unregisterMenuCommand',
  CloseNotification: 'GM_closeNotification',
  UpdateNotification: 'GM_updateNotification',
  GetTab: 'GM_getTab',
  SaveTab: 'GM_saveTab',
  GetTabs: 'GM_getTabs',
  Download: 'GM_download',
  CookieList: 'GM_cookie',
  CookieSet: 'GM_cookie',
  CookieDelete: 'GM_cookie',
  WindowClose: 'window.close',
  WindowFocus: 'window.focus',
};

// 框架内部通道（错误上报）与值存储不受 @grant 限制：值 API 的 grant 已在 wrapper 侧安装期把关，
// SW 只当存储；错误上报是框架自身调用（spec §8）。
const GRANT_EXEMPT = new Set(['ReportError', 'SetValue', 'GetValue', 'DeleteValue', 'ListValues', 'SetValues', 'DeleteValues', 'GetValues']);

// GM_notification 兜底图标（Chrome basic 通知要求非空 iconUrl，且只认扩展内真实文件路径——
// data: URI 会报 "Unable to download all specified images"，资产由 public/gm-notif.png 提供）
const NOTIF_ICON = '/gm-notif.png';

// ---- SW 内存态（重启丢失、可自重建，spec §4.1）----
const errorBuffers = new Map<string, GmErrorEntry[]>();
const ERROR_BUFFER_MAX = 20;
const menuTable = new Map<string, Map<string, GmMenuCommand>>();
// notifId → 回发目标（GM_notification 的 onClicked/onClosed 路由回注册来源 tab，spec §8）。
// SW 内存态，重启丢失可接受——通知本身也随 SW 失效。
const notifTargets = new Map<string, { scriptId: string; tabId: number }>();

export function gmErrorCounts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, buf] of errorBuffers) if (buf.length > 0) out[id] = buf.length;
  return out;
}

export function getErrorBuffer(scriptId: string): GmErrorEntry[] {
  return [...(errorBuffers.get(scriptId) ?? [])];
}

/** 全部脚本的错误缓冲快照（面板复水用）。 */
export function getAllErrors(): Record<string, GmErrorEntry[]> {
  const out: Record<string, GmErrorEntry[]> = {};
  for (const [id, buf] of errorBuffers) if (buf.length > 0) out[id] = [...buf];
  return out;
}

function broadcastToPanel(msg: Record<string, unknown>): void {
  void browser.runtime.sendMessage(msg).catch(() => {});
}

export async function clearErrors(scriptId: string): Promise<void> {
  errorBuffers.delete(scriptId);
  broadcastToPanel({ type: 'SCRIPTS_ERROR_CLEARED', scriptId });
}

function pushError(scriptId: string, entry: GmErrorEntry): void {
  const buf = errorBuffers.get(scriptId) ?? [];
  buf.push(entry);
  while (buf.length > ERROR_BUFFER_MAX) buf.shift();
  errorBuffers.set(scriptId, buf);
  broadcastToPanel({ type: 'SCRIPTS_ERROR', scriptId, error: entry });
}

export function getMenuSnapshot(): Array<{ scriptId: string; commands: Array<{ key: string; name: string }> }> {
  const out: Array<{ scriptId: string; commands: Array<{ key: string; name: string }> }> = [];
  for (const [scriptId, cmds] of menuTable) {
    if (cmds.size === 0) continue;
    out.push({ scriptId, commands: [...cmds.values()].map(({ key, name }) => ({ key, name })) });
  }
  return out;
}

function broadcastMenus(): void {
  broadcastToPanel({ type: 'SCRIPTS_MENUS', entries: getMenuSnapshot() });
}

async function sendGmEvent(tabId: number, scriptId: string, kind: GmEventKind, data: Record<string, unknown>): Promise<void> {
  try {
    await browser.tabs.sendMessage(tabId, { type: 'GM_EVENT', scriptId, kind, data });
  } catch {
    // tab 可能已关闭/无接收方——fire-and-forget
  }
}

/** 侧边栏点击菜单命令 → MENU_CLICK 下行到注册来源 tab（spec §9.3）。 */
export async function invokeMenuCommand(scriptId: string, key: string): Promise<void> {
  const cmd = menuTable.get(scriptId)?.get(key);
  if (!cmd) return;
  await sendGmEvent(cmd.tabId, scriptId, 'MENU_CLICK', { key });
}

// ---- 值存储 ----

const valuesKey = (scriptId: string) => `local:script-values:${scriptId}` as const;

async function readValues(scriptId: string): Promise<Record<string, unknown>> {
  return (await storage.getItem<Record<string, unknown>>(valuesKey(scriptId))) ?? {};
}

async function writeValues(scriptId: string, next: Record<string, unknown>): Promise<void> {
  await storage.setItem(valuesKey(scriptId), next);
}

/** 注入时值快照（background/scripts.ts toRegisterDetailsAsync 调用，Task 11 接线）。 */
export async function readValuesForSnapshot(scriptId: string): Promise<Record<string, unknown>> {
  return readValues(scriptId);
}

/** 脚本删除时清值域与内存态（background/scripts.ts handleDelete 调用，Task 11 接线）。 */
export async function cleanupScriptState(scriptId: string): Promise<void> {
  errorBuffers.delete(scriptId);
  menuTable.delete(scriptId);
  for (const [id, t] of notifTargets) if (t.scriptId === scriptId) notifTargets.delete(id);
  await storage.removeItem(valuesKey(scriptId));
  await cleanupTabData(scriptId);
  broadcastMenus();
}

// ---- @grant 白名单（spec §3）----

async function grantAllowed(scriptId: string, api: string): Promise<boolean> {
  if (GRANT_EXEMPT.has(api)) return true;
  const script = await getScript(scriptId);
  if (!script) return false;
  const grants = script.meta?.grants ?? [];
  // bridge 只发短 api 名（映射到 GM_ 全名）或已是 GM_ 全名，从不产生点形式，故直接精确匹配。
  const required = API_TO_GRANT[api] ?? api;
  return grants.includes(required);
}

async function broadcastValueChange(
  scriptId: string, key: string, oldValue: unknown, newValue: unknown, sender: Sender,
): Promise<void> {
  // 打到所有匹配该脚本 matches 的 tab（其它 tab remote=true）。发起 tab 的本地监听由 wrapper 同步触发，
  // 但仍下行（remote=false）以覆盖同脚本的其它同源框架/标签场景（spec §8）。
  const script = await getScript(scriptId);
  if (!script || script.matches.length === 0) return;
  // sender.url 实测可能缺失（Chrome 不总填）——缺失时用 tabs.get 兜底，拿不到 URL 按「不匹配」处理
  let senderTabId = sender?.tab?.id ?? null;
  let senderUrl = sender?.tab?.url ?? (senderTabId != null ? (await browser.tabs.get(senderTabId).catch(() => undefined))?.url : undefined);
  if (senderUrl == null && senderTabId != null) senderTabId = null;
  const tabs = await browser.tabs.query({}).catch(() => []);
  const targets = new Map<number, boolean>(); // tabId → remote
  for (const t of tabs) {
    if (t.id == null || !t.url || !matchUrl(script.matches, t.url)) continue;
    targets.set(t.id, t.id !== senderTabId);
  }
  // 发起 tab（sender）必然匹配（脚本正在其内运行），确保它也收到本地事件
  if (senderTabId != null) targets.set(senderTabId, false);
  for (const [tabId, remote] of targets) {
    void sendGmEvent(tabId, scriptId, 'VALUE_CHANGE', { key, oldValue, newValue, remote });
  }
}

// ---- @connect 校验（spec §8.1）----

export const ConnectDecision = { ALLOW: 0, DENY: 1, CONFIRM: 2 } as const;
export type ConnectDecision = (typeof ConnectDecision)[keyof typeof ConnectDecision];

function hostOf(url: string): string {
  try { return new URL(url).hostname; } catch { return ''; }
}

/** 纯函数三分支（spec §8.1）：self/子域或 @connect 命中→ALLOW；列了不中→DENY；未列→查 alwaysAllowedHosts，命中 ALLOW 否则 CONFIRM。 */
export function matchConnect(
  connects: string[], reqUrl: string, pageUrl: string, alwaysAllowedHosts: string[],
): ConnectDecision {
  const reqHost = hostOf(reqUrl);
  const pageHost = hostOf(pageUrl);
  if (!reqHost) return ConnectDecision.DENY;
  // self：同 host / 请求是页面的子域
  if (reqHost === pageHost || (pageHost && reqHost.endsWith(`.${pageHost}`))) return ConnectDecision.ALLOW;
  if (connects.includes('*')) return ConnectDecision.ALLOW;
  for (const c of connects) {
    const cc = c.toLowerCase();
    if (cc.startsWith('*.')) {
      const base = cc.slice(2);
      if (reqHost === base || reqHost.endsWith(`.${base}`)) return ConnectDecision.ALLOW;
    } else if (cc === reqHost) return ConnectDecision.ALLOW;
  }
  if (connects.some((c) => c && c !== 'none')) return ConnectDecision.DENY;
  if (alwaysAllowedHosts.includes(reqHost)) return ConnectDecision.ALLOW;
  return ConnectDecision.CONFIRM;
}

/** 异步版：查 always 授权库（Task 8 gm-permissions）。 */
export async function matchConnectWithPermissions(
  connects: string[], reqUrl: string, pageUrl: string, scriptId: string,
): Promise<ConnectDecision> {
  const { getAlwaysAllow } = await import('./gm-permissions');
  const allowed = await getAlwaysAllow(scriptId, hostOf(reqUrl));
  return matchConnect(connects, reqUrl, pageUrl, allowed ? [hostOf(reqUrl)] : []);
}

// ---- 剪贴板（offscreen 文档路径）----
// MV3 SW 里 navigator.clipboard 为 undefined（实测冒烟：Cannot read properties of undefined
// (reading 'writeText')）——Clipboard API 只存在于文档上下文。专用 offscreen 页
// （entrypoints/offscreen-clipboard，reason CLIPBOARD）持有真文档，SW 委托写入。
// offscreen 文档常驻（create 幂等），避免每次写入的创建/销毁开销。

const OFFSCREEN_URL = '/offscreen-clipboard.html';

type OffscreenApi = {
  createDocument(parameters: { reasons: string[]; url: string; justification: string }): Promise<void>;
  hasDocument?(): Promise<boolean>;
};

function offscreenApi(): OffscreenApi | undefined {
  return (browser as unknown as { offscreen?: OffscreenApi }).offscreen;
}

async function ensureOffscreenDocument(): Promise<void> {
  const api = offscreenApi();
  if (!api) throw new Error('offscreen API 不可用（Chrome 109+）');
  // hasDocument @150+；旧版用 createDocument 的 "Only a single offscreen document" 错误判存在
  if (api.hasDocument) {
    if (await api.hasDocument()) return;
    await api.createDocument({ reasons: ['CLIPBOARD'], url: OFFSCREEN_URL, justification: 'GM_setClipboard 剪贴板写入' });
    return;
  }
  try {
    await api.createDocument({ reasons: ['CLIPBOARD'], url: OFFSCREEN_URL, justification: 'GM_setClipboard 剪贴板写入' });
  } catch (e) {
    if (!(e instanceof Error && /single offscreen document/i.test(e.message))) throw e;
  }
}

async function writeClipboardOffscreen(text: string): Promise<void> {
  await ensureOffscreenDocument();
  const resp = (await browser.runtime.sendMessage({
    type: 'OFFSCREEN_WRITE_CLIPBOARD', text,
  } as Record<string, unknown>)) as { ok: boolean; error?: string } | undefined;
  // 广播语义：扩展内所有 onMessage frame 都可能应答（侧边栏/脚本详情页有 listener 但不认识
  // 该 type 不应答；offscreen 页应答 {ok}）。Chrome 取「最后一个非 undefined 响应」——
  // 无 offscreen 应答时 resp 为 undefined（或 SW router 的 no handler 响应被网关排除）。
  if (resp && resp.ok) return;
  throw new Error(resp?.error ?? 'offscreen 剪贴板页无响应');
}

// ---- GM_xmlhttpRequest 实现（替换占位 case）----

const XHR_MAX_BODY = 1024 * 1024;const HEADER_ALLOW = new Set(['content-type', 'content-length', 'server', 'date', 'cache-control', 'last-modified', 'etag']);

async function doXmlHttpRequest(
  scriptId: string, params: unknown[], sender: Sender,
): Promise<{ ok: true; data?: unknown } | { ok: false; error: string }> {
  const details = (params[0] ?? {}) as { url?: string; method?: string; headers?: Record<string, string>; body?: string; timeout?: number };
  if (!details.url) return { ok: false, error: 'GM_xmlhttpRequest 缺少 url' };
  const script = await getScript(scriptId);
  if (!script) return { ok: false, error: '脚本不存在' };
  const pageUrl = sender?.tab?.url ?? '';
  const decision = await matchConnectWithPermissions(script.meta?.connects ?? [], details.url, pageUrl, scriptId);
  if (decision === ConnectDecision.CONFIRM) {
    const host = hostOf(details.url);
    const choice = await enqueueConfirm({
      kind: 'connect',
      title: '跨域请求确认',
      message: `脚本「${script.name}」请求跨域访问`,
      rows: [
        { label: '主机', value: host, mono: true },
        { label: '方法', value: (details.method ?? 'GET').toUpperCase(), mono: true },
        { label: 'URL', value: details.url, mono: true },
        { label: '来源', value: pageUrl || '（未知）', mono: true },
      ],
      actions: [
        { decision: 'allow-once', label: '允许一次', variant: 'primary' },
        { decision: 'always', label: '总是允许' },
        { decision: 'deny', label: '拒绝', variant: 'danger', countdown: true },
      ],
      timeoutMs: 60_000,
    });
    if (choice === 'always') {
      const { setAlwaysAllow } = await import('./gm-permissions');
      await setAlwaysAllow(scriptId, host);
    } else if (choice !== 'allow-once') {
      return { ok: false, error: 'permission denied（用户拒绝或确认超时/关闭；可加 @connect 或在确认页批准）' };
    }
  } else if (decision === ConnectDecision.DENY) {
    return { ok: false, error: `Refused to connect to "${hostOf(details.url)}"：不在 @connect 列表（请补 @connect）` };
  }
  // unsafe header 忽略 + 记 warning（无 DNR，spec §8.1 差异声明）
  const headers: Record<string, string> = {};
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(details.headers ?? {})) {
    if (/^(user-agent|referer|cookie|origin|host|cookie2)$/i.test(k)) dropped.push(k);
    else headers[k] = v;
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('timeout')), details.timeout ?? 30_000);
  try {
    const resp = await fetch(details.url, {
      method: details.method ?? 'GET',
      headers,
      body: details.body,
      signal: ac.signal,
      credentials: 'include',
    });
    const text = await resp.text();
    const outHeaders: Record<string, string> = {};
    resp.headers.forEach((v, k) => { if (HEADER_ALLOW.has(k.toLowerCase())) outHeaders[k.toLowerCase()] = v; });
    const data: Record<string, unknown> = {
      status: resp.status,
      statusText: resp.statusText,
      headers: outHeaders,
      body: text.length > XHR_MAX_BODY ? text.slice(0, XHR_MAX_BODY) : text,
      finalUrl: resp.url,
    };
    if (text.length > XHR_MAX_BODY) data.truncated = true;
    if (dropped.length > 0) data.droppedHeaders = dropped;
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: `GM_xmlhttpRequest 失败：${e instanceof Error ? e.message : String(e)}` };
  } finally {
    clearTimeout(timer);
  }
}

// ---- GM_cookie 实现（chrome.cookies 透传 + @connect 门控，spec §5.2）----

async function doCookie(
  scriptId: string, op: 'list' | 'set' | 'delete', params: unknown[], sender: Sender,
): Promise<{ ok: true; data?: unknown } | { ok: false; error: string }> {
  const details = (params[0] ?? {}) as CookieDetails;
  const script = await getScript(scriptId);
  if (!script) return { ok: false, error: '脚本不存在' };
  const targetUrl = cookieTargetUrl(details);
  if (!targetUrl) return { ok: false, error: 'GM_cookie 缺少 url 或 domain' };
  const pageUrl = sender?.tab?.url ?? '';
  const decision = await matchConnectWithPermissions(script.meta?.connects ?? [], targetUrl, pageUrl, scriptId);
  if (decision === ConnectDecision.CONFIRM) {
    const host = hostOf(targetUrl);
    const choice = await enqueueConfirm({
      kind: 'connect',
      title: 'Cookie 访问确认',
      message: `脚本「${script.name}」请求读写 cookie`,
      rows: [
        { label: '主机', value: host, mono: true },
        { label: '操作', value: op, mono: true },
        { label: '来源', value: pageUrl || '（未知）', mono: true },
      ],
      actions: [
        { decision: 'allow-once', label: '允许一次', variant: 'primary' },
        { decision: 'always', label: '总是允许' },
        { decision: 'deny', label: '拒绝', variant: 'danger', countdown: true },
      ],
      timeoutMs: 60_000,
    });
    if (choice === 'always') {
      const { setAlwaysAllow } = await import('./gm-permissions');
      await setAlwaysAllow(scriptId, host);
    } else if (choice !== 'allow-once') {
      return { ok: false, error: 'permission denied（用户拒绝或超时；可加 @connect 或在确认页批准）' };
    }
  } else if (decision === ConnectDecision.DENY) {
    return { ok: false, error: `Refused：cookie 主机「${hostOf(targetUrl)}」不在 @connect 列表` };
  }
  try {
    if (op === 'list') return { ok: true, data: await listCookies(details) };
    if (op === 'set') { await setCookie(details); return { ok: true, data: null }; }
    await deleteCookie(details);
    return { ok: true, data: null };
  } catch (e) {
    return { ok: false, error: `GM_cookie.${op} 失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

// ---- GM_download 实现（chrome.downloads + @connect 门控，spec §5.3）----

async function doDownload(
  scriptId: string, params: unknown[], sender: Sender,
): Promise<{ ok: true; data?: unknown } | { ok: false; error: string }> {
  const details = (params[0] ?? {}) as DownloadDetails;
  if (!details.url) return { ok: false, error: 'GM_download 缺少 url' };
  const script = await getScript(scriptId);
  if (!script) return { ok: false, error: '脚本不存在' };
  const pageUrl = sender?.tab?.url ?? '';
  const decision = await matchConnectWithPermissions(script.meta?.connects ?? [], details.url, pageUrl, scriptId);
  if (decision === ConnectDecision.CONFIRM) {
    const host = hostOf(details.url);
    const choice = await enqueueConfirm({
      kind: 'connect',
      title: '下载确认',
      message: `脚本「${script.name}」请求下载文件`,
      rows: [
        { label: '主机', value: host, mono: true },
        { label: 'URL', value: details.url, mono: true },
        { label: '文件名', value: details.name ?? '（默认）', mono: true },
        { label: '来源', value: pageUrl || '（未知）', mono: true },
      ],
      actions: [
        { decision: 'allow-once', label: '允许一次', variant: 'primary' },
        { decision: 'always', label: '总是允许' },
        { decision: 'deny', label: '拒绝', variant: 'danger', countdown: true },
      ],
      timeoutMs: 60_000,
    });
    if (choice === 'always') {
      const { setAlwaysAllow } = await import('./gm-permissions');
      await setAlwaysAllow(scriptId, host);
    } else if (choice !== 'allow-once') {
      return { ok: false, error: 'permission denied（用户拒绝或超时）' };
    }
  } else if (decision === ConnectDecision.DENY) {
    return { ok: false, error: `Refused：下载主机「${hostOf(details.url)}」不在 @connect 列表` };
  }
  try {
    return await runDownload(details);
  } catch (e) {
    return { ok: false, error: `GM_download 失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

// ---- GM_llmChat（脚本调用大模型，spec docs/superpowers/specs/2026-09-05-gm-llm-chat-design.md）----

// 「本会话内允许」：SW 内存态，重启失效（与菜单表同款取舍）。档位变更时由 SCRIPTS_SET_LLM_TIER 清（scripts.ts handler 调用）。
const llmSessionAllow = new Set<string>();

/** 档位变更时清单脚本的会话内授权（scripts.ts SCRIPTS_SET_LLM_TIER 调用）。 */
export function __resetLlmSessionFor(scriptId: string): void { llmSessionAllow.delete(scriptId); }

/** 仅测试用：造一个 session 授权（scripts-llm-tier 测试验证「set 档清 session」）。 */
export function __addLlmSessionForTest(scriptId: string): void { llmSessionAllow.add(scriptId); }

/** 仅测试用：只读查询 session 授权是否存在（同上）。 */
export function __llmSessionHasForTest(scriptId: string): boolean { return llmSessionAllow.has(scriptId); }

const LLM_IMAGE_MAX = 5 * 1024 * 1024;      // 单张 data URL 上限（base64 后）
const LLM_PAYLOAD_MAX = 2 * 1024 * 1024;    // 消息总载荷上限
const LLM_RESPONSE_MAX = 1024 * 1024;       // 响应聚合文本上限
const LLM_DEFAULT_TIMEOUT = 120_000;
const LLM_DENY_MSG = 'permission denied: 大模型调用已被用户拒绝（可在脚本详情 → 设置 → 模型调用 改档位）';

/** 测试注入点：SW 内不可 mock import 的 provider 构造，经此替换。
 *  返回类型 = streamChat 签名本身（Provider 接口的结构形状）——fake provider 无需继承类。 */
type LlmProviderLike = { streamChat: OpenAICompatProvider['streamChat'] };
let llmProviderFactory: (config: { baseUrl: string; apiKey: string; model: string; extraBody?: Record<string, unknown> }) => LlmProviderLike =
  (config) => new OpenAICompatProvider(config);

/** 仅测试用：替换 provider 工厂。 */
export function __setLlmProviderFactory(f: typeof llmProviderFactory): void { llmProviderFactory = f; }

/** 仅测试用：清 session 授权表。 */
export function __resetLlmSession(): void { llmSessionAllow.clear(); }

interface LlmDetails {
  messages?: unknown;
  timeout?: number;
}

function fail(msg: string): { ok: false; error: string } {
  return { ok: false, error: msg };
}

/** 参数校验 + 归一化为 ChatMessage[]。返回 union：失败带 error；payloadKB 供确认卡复用（避免二次 stringify）。 */
function validateLlmMessages(raw: unknown): { ok: true; messages: ChatMessage[]; payloadKB: number } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return fail('缺少 messages 或为空数组');
  const out: ChatMessage[] = [];
  for (const m of raw) {
    const role = (m as { role?: unknown })?.role;
    if (role !== 'system' && role !== 'user' && role !== 'assistant') {
      return fail(`非法 role: ${String(role)}（仅支持 system/user/assistant）`);
    }
    const content = (m as { content?: unknown })?.content;
    if (typeof content === 'string') { out.push({ role, content }); continue; }
    if (!Array.isArray(content)) return fail('非法 content（应为字符串或 {type,...} 数组）');
    const parts: ContentPart[] = [];
    for (const p of content) {
      const t = (p as { type?: unknown })?.type;
      if (t === 'text') {
        parts.push({ type: 'text', text: String((p as { text?: unknown })?.text ?? '') });
      } else if (t === 'image_url') {
        const url = String((p as { image_url?: { url?: unknown } })?.image_url?.url ?? '');
        if (url.startsWith('data:') && url.length > LLM_IMAGE_MAX) {
          return fail(`图片过大：${Math.round(url.length / 1024)}KB（上限 5MB）`);
        }
        parts.push({ type: 'image_url', imageUrl: url });
      } else {
        return fail(`非法 content part type: ${String(t)}`);
      }
    }
    out.push({ role, content: parts });
  }
  const payload = JSON.stringify(out);
  const payloadKB = Math.round(payload.length / 1024);
  if (payload.length > LLM_PAYLOAD_MAX) {
    return fail(`消息载荷过大：${payloadKB}KB（上限 2MB）`);
  }
  return { ok: true, messages: out, payloadKB };
}

/** 权限档决策：allow 放 / ask 查 session 表，未命中弹确认卡。
 *  deny 已在 doLlmChat 硬拒，gate 只处理 ask/allow/session（不弹卡不依赖模型配置状态的拒绝在最外层）。 */
async function llmGate(scriptId: string, scriptName: string, modelName: string, msgCount: number, payloadKB: number, tier: 'ask' | 'allow'): Promise<{ ok: true } | { ok: false; error: string }> {
  if (tier === 'allow') return { ok: true };
  if (llmSessionAllow.has(scriptId)) return { ok: true };
  const choice = await enqueueConfirm({
    kind: 'llm',
    title: '大模型调用确认',
    message: `脚本「${scriptName}」请求调用大模型`,
    rows: [
      { label: '脚本', value: scriptName },
      { label: '模型', value: modelName, mono: true },
      { label: '消息数', value: String(msgCount), mono: true },
      { label: '载荷', value: `${payloadKB}KB`, mono: true },
    ],
    actions: [
      { decision: 'allow-once', label: '允许一次', variant: 'primary' },
      { decision: 'session', label: '本会话内允许' },
      { decision: 'deny', label: '拒绝', variant: 'danger', countdown: true },
    ],
    timeoutMs: 60_000,
  });
  if (choice === 'session') { llmSessionAllow.add(scriptId); return { ok: true }; }
  if (choice === 'allow-once') return { ok: true };
  return fail(LLM_DENY_MSG);
}

async function doLlmChat(
  scriptId: string, params: unknown[], sender: Sender,
): Promise<{ ok: true; data?: unknown } | { ok: false; error: string }> {
  const details = (params[0] ?? {}) as LlmDetails;
  const v = validateLlmMessages(details.messages);
  if (!v.ok) return v;
  if (details.timeout != null && (typeof details.timeout !== 'number' || !Number.isFinite(details.timeout) || details.timeout <= 0)) {
    return fail('非法 timeout');
  }
  const script = await getScript(scriptId);
  if (!script) return fail('脚本不存在');

  // deny 硬拒先于模型配置检查（权限层最外：档位拒绝时既不弹卡也不暴露配置状态）
  const tier = await getLlmTier(scriptId);
  if (tier === 'deny') return fail(LLM_DENY_MSG);

  const { provider } = await getSettings();
  if (!provider.baseUrl || !provider.apiKey || !provider.model) {
    return fail('模型未配置：请到侧边栏 设置 → 模型设置 配置后重试');
  }
  const gate = await llmGate(scriptId, script.name, provider.model, v.messages.length, v.payloadKB, tier);
  if (!gate.ok) return gate;

  const tabId = sender?.tab?.id;
  const chan = params[1] as string | undefined; // wrapper 传的通道号（直调/旧调用无 chan → chunk 不下发）
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('timeout')), details.timeout ?? LLM_DEFAULT_TIMEOUT);

  // 流结束哨兵：provider 契约保证恰好终止于一个 message-done（abort 也不例外）——
  // 先等流终结，再等 chunk 下行链排空，gmres 才会 resolve（时序不变量）。
  // 兜底：abort 时 provider 可能已死（如流被 cancel 后连补发都做不了的违约实现），
  // 不能指望它补发事件——abort 即放行等待，下方终态判定（超时/超限）会正确接管。
  // resolveDone 幂等（finished 守卫 + once 监听），与契约路径并存为双保险。
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => { resolveDone = r; });
  let finished = false; // 防御 fake/异常 provider 违约重复发 message-done（第二次忽略）
  // abort 双兜底：①放行 done 等待（provider 可能已死、连契约的补发 message-done 都没有）；
  // ②cancel 流句柄（signal 是契约通道，cancel 是显式句柄——fake/实现可能不监听 signal）。
  // 均幂等：resolveDone 有 finished 守卫，cancel 对已终止流是无害 no-op。
  let handle: { cancel: () => void } | undefined; // provider 可能在 streamChat 内部同步 emit+abort，此刻赋值语句未执行 → ?. 防 undefined
  ac.signal.addEventListener('abort', () => {
    if (!finished) resolveDone();
    handle?.cancel();
  }, { once: true });

  // chunk 下行 promise 链：保证 gmres resolve 晚于所有 LLM_CHUNK（时序不变量）
  let chain: Promise<void> = Promise.resolve();
  const enqueueChunk = (delta: string): void => {
    chain = chain.then(() =>
      tabId != null && chan ? sendGmEvent(tabId, scriptId, 'LLM_CHUNK', { chan, delta }) : undefined,
    );
  };

  let text = '';
  let usage: { promptTokens?: number; completionTokens?: number } | undefined;
  let finishReason: string | undefined;
  let streamError: string | undefined;

  try {
    const p = llmProviderFactory(provider);
    handle = p.streamChat({ messages: v.messages, tools: [], signal: ac.signal }, (ev: StreamEvent) => {
      if (ev.type === 'text-delta') {
        text += ev.text;
        if (text.length > LLM_RESPONSE_MAX) { ac.abort(new Error('response-too-large')); return; }
        enqueueChunk(ev.text);
      } else if (ev.type === 'message-done') {
        usage = ev.usage; finishReason = ev.finishReason;
        if (!finished) { finished = true; resolveDone(); }
      } else if (ev.type === 'error') {
        streamError = ev.error;
      }
      // reasoning-delta 忽略（不下发）
    });
    await done;   // 等流终结（此刻全部 chunk 已入链）
    await chain;  // 再排空 chunk 下行链
  } finally {
    clearTimeout(timer);
  }

  if (text.length > LLM_RESPONSE_MAX) return fail('响应过大：超 1MB 上限');
  if (ac.signal.reason instanceof Error && ac.signal.reason.message === 'timeout') {
    return fail(`LLM 调用超时（${details.timeout ?? LLM_DEFAULT_TIMEOUT}ms）`);
  }
  if (streamError) return fail(`LLM 调用失败: ${streamError}`);
  return { ok: true, data: { text, usage, finishReason } };
}

// ---- 分发 ----

export async function handleGmCall(
  req: GmCallRequest, sender: Sender,
): Promise<{ ok: true; data?: unknown } | { ok: false; error: string }> {
  const { scriptId, api, params } = req;
  // 内部通道不受 grant 限制（错误上报是框架自身调用）
  if (api === 'ReportError') {
    const [message, stack, line] = params as [string, string?, number?];
    pushError(scriptId, { at: Date.now(), message: String(message ?? ''), stack, line });
    return { ok: true, data: null };
  }
  if (!(await grantAllowed(scriptId, api))) {
    return { ok: false, error: `permission not requested: ${api}（@grant 未声明）` };
  }
  switch (api) {
    case 'SetValue': {
      const [key, value] = params as [string, unknown];
      const values = await readValues(scriptId);
      const oldValue = values[key];
      values[key] = value;
      await writeValues(scriptId, values);
      await broadcastValueChange(scriptId, key, oldValue, value, sender);
      return { ok: true, data: null };
    }
    case 'DeleteValue': {
      const [key] = params as [string];
      const values = await readValues(scriptId);
      const oldValue = values[key];
      delete values[key];
      await writeValues(scriptId, values);
      await broadcastValueChange(scriptId, key, oldValue, undefined, sender);
      return { ok: true, data: null };
    }
    case 'GetValue': {
      const [key, def] = params as [string, unknown];
      const values = await readValues(scriptId);
      return { ok: true, data: key in values ? values[key] : def };
    }
    case 'ListValues': {
      const values = await readValues(scriptId);
      return { ok: true, data: Object.keys(values) };
    }
    case 'SetValues': {
      const [obj] = params as [Record<string, unknown>];
      const values = await readValues(scriptId);
      const entries = obj && typeof obj === 'object' ? Object.entries(obj) : [];
      for (const [key, value] of entries) {
        const oldValue = values[key];
        values[key] = value;
        await broadcastValueChange(scriptId, key, oldValue, value, sender);
      }
      await writeValues(scriptId, values);
      return { ok: true, data: null };
    }
    case 'DeleteValues': {
      const [keys] = params as [string[]];
      const values = await readValues(scriptId);
      for (const key of Array.isArray(keys) ? keys : []) {
        const oldValue = values[key];
        delete values[key];
        await broadcastValueChange(scriptId, key, oldValue, undefined, sender);
      }
      await writeValues(scriptId, values);
      return { ok: true, data: null };
    }
    case 'UnregisterMenu': {
      const [key] = params as [string];
      const cmds = menuTable.get(scriptId);
      if (cmds) { cmds.delete(key); if (cmds.size === 0) menuTable.delete(scriptId); }
      broadcastMenus();
      return { ok: true, data: null };
    }
    case 'CloseNotification': {
      const [id] = params as [string];
      try { await browser.notifications?.clear(id); return { ok: true, data: null }; }
      catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
    }
    case 'UpdateNotification': {
      const [id, details] = params as [string, { title?: string; text?: string }];
      try {
        await browser.notifications?.update(id, { type: 'basic', iconUrl: NOTIF_ICON, title: details?.title ?? scriptId, message: details?.text ?? '' });
        return { ok: true, data: null };
      } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
    }
    case 'RegisterMenu': {
      const [key, name] = params as [string, string];
      const tabId = sender?.tab?.id;
      if (tabId == null) return { ok: false, error: 'RegisterMenu 缺少 tab 上下文' };
      const cmds = menuTable.get(scriptId) ?? new Map<string, GmMenuCommand>();
      cmds.set(key, { key, name, tabId });
      menuTable.set(scriptId, cmds);
      broadcastMenus();
      return { ok: true, data: null };
    }
    case 'SetClipboard': {
      const [text] = params as [string];
      try {
        await writeClipboardOffscreen(String(text ?? ''));
        return { ok: true, data: null };
      } catch (e) {
        return { ok: false, error: `剪贴板写入失败：${e instanceof Error ? e.message : String(e)}` };
      }
    }
    case 'Notification': {
      const [details, notifId] = params as [{ title?: string; text?: string }, string];
      const tabId = sender?.tab?.id;
      try {
        await browser.notifications.create(notifId, {
          type: 'basic', iconUrl: NOTIF_ICON, title: details?.title ?? scriptId, message: details?.text ?? '',
        });
        // 记映射：onClicked/onClosed 时回发 NOTIF_CLICK 到注册来源 tab（spec §8）
        if (tabId != null) notifTargets.set(notifId, { scriptId, tabId });
        return { ok: true, data: null };
      } catch (e) {
        return { ok: false, error: `通知失败：${e instanceof Error ? e.message : String(e)}` };
      }
    }
    case 'OpenInTab': {
      const [url, opts] = params as [string, { active?: boolean }];
      const tab = await browser.tabs.create({ url, active: opts?.active !== false });
      const openerTabId = sender?.tab?.id;
      if (openerTabId != null && tab.id != null) {
        const onRemoved = (closedId: number): void => {
          if (closedId !== tab.id) return;
          browser.tabs.onRemoved.removeListener(onRemoved);
          void sendGmEvent(openerTabId, scriptId, 'TAB_EVENT', { tabId: tab.id, closed: true });
        };
        browser.tabs.onRemoved.addListener(onRemoved);
      }
      return { ok: true, data: tab.id };
    }
    case 'CloseTab': {
      const [tabId] = params as [number];
      // 防御：OpenInTab 未 resolve 前句柄 close() 会带 undefined tabId——直接回可读错误，
      // 不喂给 tabs.remove（No matching signature）
      if (typeof tabId !== 'number' || !Number.isInteger(tabId)) {
        return { ok: false, error: `CloseTab：非法 tabId（${JSON.stringify(tabId) ?? 'undefined'}）——标签页可能尚未创建完成` };
      }
      try { await browser.tabs.remove(tabId); return { ok: true, data: null }; }
      catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
    }
    case 'LlmChat':
      return doLlmChat(scriptId, params, sender);
    case 'XmlHttpRequest':
      return doXmlHttpRequest(scriptId, params, sender);
    case 'CookieList':
      return doCookie(scriptId, 'list', params, sender);
    case 'CookieSet':
      return doCookie(scriptId, 'set', params, sender);
    case 'CookieDelete':
      return doCookie(scriptId, 'delete', params, sender);
    case 'Download':
      return doDownload(scriptId, params, sender);
    case 'AbortRequest':
      return { ok: true, data: null }; // 一次性请求模型：abort 后到的响应由 content 宿主/wrapper 侧忽略（简化语义，文档明示）
    case 'GetTab': {
      const tabId = sender?.tab?.id;
      if (tabId == null) return { ok: false, error: 'GetTab 缺少 tab 上下文' };
      return { ok: true, data: await getTabData(scriptId, tabId) };
    }
    case 'SaveTab': {
      const tabId = sender?.tab?.id;
      if (tabId == null) return { ok: false, error: 'SaveTab 缺少 tab 上下文' };
      await saveTabData(scriptId, tabId, (params[0] ?? {}) as Record<string, unknown>);
      return { ok: true, data: null };
    }
    case 'GetTabs':
      return { ok: true, data: await getAllTabData(scriptId) };
    default:
      return { ok: false, error: `未知 GM API：${api}` };
  }
}

// ---- 面板直调（脚本运行时调试台，spec §3）----

async function resolveTab(tabId?: number): Promise<{ id: number; url: string } | null> {
  let id = tabId;
  if (id == null) {
    let [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab) [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    id = tab?.id;
  }
  if (id == null) return null;
  const tab = await browser.tabs.get(id).catch(() => undefined);
  return tab?.id != null ? { id: tab.id, url: tab.url ?? '' } : null;
}

/** GM_DEBUG_CALL：查 token（=脚本是否注入目标页）→ tabs.sendMessage 下发 GM_DEBUG_INVOKE。 */
async function handleDebugCall(
  scriptId: string, api: string, params: unknown[], tabId: number | undefined,
): Promise<{ dispatched: boolean; result?: { ok: boolean; data?: unknown; error?: string }; ms: number; error?: string }> {
  const started = Date.now();
  const tab = await resolveTab(tabId);
  if (!tab) return { dispatched: false, ms: Date.now() - started, error: '无法获取目标标签页（请切到普通网页）' };
  const entries = await bridgeTokensForUrl(tab.url);
  if (!entries.some((e) => e.scriptId === scriptId)) {
    return { dispatched: false, ms: Date.now() - started, error: '脚本未注入目标页（@match 未命中或未启用），无法直调' };
  }
  try {
    const req = createRequest('GM_DEBUG_INVOKE', { scriptId, api, params });
    // frameId: 0 钉主帧——content script allFrames 注册，不钉会广播到所有帧（iframe 重复执行 debugCall，抢答）
    const resp = (await browser.tabs.sendMessage(tab.id, req, { frameId: 0 })) as CsResponse | undefined;
    return { dispatched: true, result: resp?.result, ms: Date.now() - started };
  } catch (e) {
    return { dispatched: false, ms: Date.now() - started, error: e instanceof Error ? e.message : String(e) };
  }
}

/** GM_DEBUG_INFO：白名单视图数据（grant 二分 + connects + alwaysAllow + 注入态）。 */
async function handleDebugInfo(scriptId: string, tabId: number | undefined): Promise<{ ok: boolean; data?: GmDebugInfoData; error?: string }> {
  const script = await getScript(scriptId);
  if (!script) return { ok: false, error: '脚本不存在' };
  const tab = await resolveTab(tabId);
  const tabUrl = tab?.url ?? '';
  const { supported, unsupported } = classifyGrants(script.meta?.grants ?? []);
  const { listAlwaysAllow } = await import('./gm-permissions');
  const entries = tabUrl ? await bridgeTokensForUrl(tabUrl) : [];
  return {
    ok: true,
    data: {
      connects: script.meta?.connects ?? [],
      grantSupported: supported,
      grantUnsupported: unsupported,
      alwaysAllow: await listAlwaysAllow(scriptId),
      injected: entries.some((e) => e.scriptId === scriptId),
      tabUrl,
    },
  };
}

// ---- 消息接线 ----

interface RouterLike {
  on(type: string, handler: (msg: Record<string, unknown>, sender?: Sender) => unknown): void;
}

export function initGmApi(router: RouterLike): void {
  router.on('GM_API_CALL', async (msg, sender) => {
    const { scriptId, api, reqId, params } = msg as unknown as GmCallRequest;
    void reqId; // content 宿主持有 reqId 配对，SW 返回体透传
    return handleGmCall({ scriptId, api, reqId, params }, sender);
  });

  router.on('GM_BRIDGE_TOKENS', async (msg) => {
    const { url } = msg as unknown as { url: string };
    return { ok: true, data: { entries: await bridgeTokensForUrl(url) } };
  });

  router.on('SCRIPTS_MENU_INVOKE', async (msg) => {
    const { scriptId, key } = msg as unknown as { scriptId: string; key: string };
    await invokeMenuCommand(scriptId, key);
    return { ok: true };
  });

  router.on('SCRIPTS_CLEAR_ERRORS', async (msg) => {
    const { scriptId } = msg as unknown as { scriptId: string };
    await clearErrors(scriptId);
    return { ok: true };
  });

  // 面板重开复水：一次拉齐 menus/errors（广播只补增量，冷启动/重开靠此）
  router.on('SCRIPTS_GET_GM_STATE', async () => ({
    ok: true,
    data: { menus: getMenuSnapshot(), errors: getAllErrors() },
  }));

  router.on('GM_DEBUG_CALL', async (msg) => {
    const { scriptId, api, params, tabId } = msg as unknown as { scriptId: string; api: string; params: unknown[]; tabId?: number };
    return handleDebugCall(scriptId, api, params, tabId);
  });

  router.on('GM_DEBUG_INFO', async (msg) => {
    const { scriptId, tabId } = msg as unknown as { scriptId: string; tabId?: number };
    return handleDebugInfo(scriptId, tabId);
  });

  // GM_notification 点击/关闭 → NOTIF_CLICK 下行到注册来源 tab（wrapper 的 ondone 回调，spec §8）
  // 可选链保护：fakeBrowser 等环境可能无 notifications.onClicked/onClosed
  browser.notifications?.onClicked?.addListener((notifId) => {
    const t = notifTargets.get(notifId);
    if (t) void sendGmEvent(t.tabId, t.scriptId, 'NOTIF_CLICK', { id: notifId, byUser: true });
  });
  browser.notifications?.onClosed?.addListener((notifId) => {
    const t = notifTargets.get(notifId);
    if (!t) return;
    notifTargets.delete(notifId); // 关闭即清映射
    void sendGmEvent(t.tabId, t.scriptId, 'NOTIF_CLICK', { id: notifId, byUser: false });
  });
}

