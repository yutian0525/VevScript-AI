// background/gm-api.ts
// GM API SW 侧实现中心（spec §3/§8）：GM_API_CALL 分发、@grant 白名单、值存储与广播、
// 菜单表、错误环形缓冲、SetClipboard/Notification/OpenInTab；GM_xmlhttpRequest 的 @connect
// 确认流在 Task 10 并入（本任务先分发占位错误）。token 表查询（GM_BRIDGE_TOKENS）同。

import type { GmEventKind } from '../shared/gm-bridge';
import { storage } from 'wxt/utils/storage';
import { getScript } from '../storage/scripts';
import { matchUrl } from '../shared/match-pattern';
import { bridgeTokensForUrl } from './gm-token';
import { classifyGrants } from '../shared/gm-apis';
import { createRequest, type CsResponse, type GmDebugInfoData } from '../shared/messages';

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
};

// 框架内部通道（错误上报）与值存储不受 @grant 限制：值 API 的 grant 已在 wrapper 侧安装期把关，
// SW 只当存储；错误上报是框架自身调用（spec §8）。
const GRANT_EXEMPT = new Set(['ReportError', 'SetValue', 'GetValue', 'DeleteValue', 'ListValues']);

// GM_notification 兜底图标（Chrome basic 通知要求非空 iconUrl；public 无图标资产时用内嵌 data URL）
const NOTIF_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

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
  const tabs = await browser.tabs.query({}).catch(() => []);
  const targets = new Map<number, boolean>(); // tabId → remote
  for (const t of tabs) {
    if (t.id == null || !t.url || !matchUrl(script.matches, t.url)) continue;
    targets.set(t.id, t.id !== sender?.tab?.id);
  }
  // 发起 tab（sender）必然匹配（脚本正在其内运行），确保它也收到本地事件
  if (sender?.tab?.id != null) targets.set(sender.tab.id, false);
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

// ---- 确认队列（spec §8.1，60s 超时拒绝）----

export interface GmConfirm {
  confirmId: string;
  scriptId: string;
  host: string;
  url: string;
  createdAt: number;
}

const pendingConfirms = new Map<string, { confirm: GmConfirm; resolve: (v: 'allow-once' | 'always' | 'deny') => void }>();
const CONFIRM_TIMEOUT_MS = 60_000;

export function getPendingConfirms(): GmConfirm[] {
  return [...pendingConfirms.values()].map((p) => p.confirm);
}

function queueConfirm(scriptId: string, url: string): Promise<'allow-once' | 'always' | 'deny'> {
  return new Promise((resolve) => {
    const confirmId = crypto.randomUUID();
    const confirm: GmConfirm = { confirmId, scriptId, host: hostOf(url), url, createdAt: Date.now() };
    pendingConfirms.set(confirmId, { confirm, resolve });
    broadcastToPanel({ type: 'GM_CONFIRM_PENDING', confirm });
    setTimeout(() => {
      if (pendingConfirms.has(confirmId)) {
        pendingConfirms.delete(confirmId);
        resolve('deny');
        broadcastToPanel({ type: 'GM_CONFIRM_RESOLVED', confirmId });
      }
    }, CONFIRM_TIMEOUT_MS);
  });
}

export async function resolveConfirm(confirmId: string, decision: 'allow-once' | 'always' | 'deny'): Promise<void> {
  const entry = pendingConfirms.get(confirmId);
  if (!entry) return;
  pendingConfirms.delete(confirmId);
  if (decision === 'always') {
    const { setAlwaysAllow } = await import('./gm-permissions');
    await setAlwaysAllow(entry.confirm.scriptId, entry.confirm.host);
  }
  entry.resolve(decision);
  broadcastToPanel({ type: 'GM_CONFIRM_RESOLVED', confirmId });
}

// ---- GM_xmlhttpRequest 实现（替换占位 case）----

const XHR_MAX_BODY = 1024 * 1024;
const HEADER_ALLOW = new Set(['content-type', 'content-length', 'server', 'date', 'cache-control', 'last-modified', 'etag']);

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
    const choice = await queueConfirm(scriptId, details.url);
    if (choice === 'deny') return { ok: false, error: 'permission denied（用户拒绝或确认超时；可加 @connect 或在侧边栏批准）' };
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
        await navigator.clipboard.writeText(String(text ?? ''));
        return { ok: true, data: null };
      } catch (e) {
        return { ok: false, error: `剪贴板写入失败（MV3 SW 无手势链时可能被拒）：${e instanceof Error ? e.message : String(e)}` };
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
      try { await browser.tabs.remove(tabId); return { ok: true, data: null }; }
      catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
    }
    case 'XmlHttpRequest':
      return doXmlHttpRequest(scriptId, params, sender);
    case 'AbortRequest':
      return { ok: true, data: null }; // 一次性请求模型：abort 后到的响应由 content 宿主/wrapper 侧忽略（简化语义，文档明示）
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

  router.on('GM_CONFIRM_RESOLVE', async (msg) => {
    const { confirmId, decision } = msg as unknown as { confirmId: string; decision: 'allow-once' | 'always' | 'deny' };
    await resolveConfirm(confirmId, decision);
    return { ok: true };
  });

  // 面板重开复水：一次拉齐 menus/errors/confirms（广播只补增量，冷启动/重开靠此）
  router.on('SCRIPTS_GET_GM_STATE', async () => ({
    ok: true,
    data: { menus: getMenuSnapshot(), errors: getAllErrors(), confirms: getPendingConfirms() },
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

