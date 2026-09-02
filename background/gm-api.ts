// background/gm-api.ts
// GM API SW 侧实现中心（spec §3/§8）：GM_API_CALL 分发、@grant 白名单、值存储与广播、
// 菜单表、错误环形缓冲、SetClipboard/Notification/OpenInTab；GM_xmlhttpRequest 的 @connect
// 确认流在 Task 10 并入（本任务先分发占位错误）。token 表查询（GM_BRIDGE_TOKENS）同。

import type { GmEventKind } from '../shared/gm-bridge';
import { storage } from 'wxt/utils/storage';
import { getScript } from '../storage/scripts';
import { matchUrl } from '../shared/match-pattern';
import { bridgeTokensForUrl } from './gm-token';

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

// ---- SW 内存态（重启丢失、可自重建，spec §4.1）----
const errorBuffers = new Map<string, GmErrorEntry[]>();
const ERROR_BUFFER_MAX = 20;
const menuTable = new Map<string, Map<string, GmMenuCommand>>();

export function gmErrorCounts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, buf] of errorBuffers) if (buf.length > 0) out[id] = buf.length;
  return out;
}

export function getErrorBuffer(scriptId: string): GmErrorEntry[] {
  return [...(errorBuffers.get(scriptId) ?? [])];
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
  await storage.removeItem(valuesKey(scriptId));
  broadcastMenus();
}

// ---- @grant 白名单（spec §3）----

async function grantAllowed(scriptId: string, api: string): Promise<boolean> {
  if (GRANT_EXEMPT.has(api)) return true;
  const script = await getScript(scriptId);
  if (!script) return false;
  const grants = script.meta?.grants ?? [];
  const required = API_TO_GRANT[api] ?? api;
  if (grants.includes(required)) return true;
  // 点形式别名：GM.notification 归 GM_notification
  const under = required.replace(/^GM\./, 'GM_');
  return grants.includes(under);
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
      try {
        await browser.notifications.create(notifId, {
          type: 'basic', iconUrl: '', title: details?.title ?? scriptId, message: details?.text ?? '',
        });
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
    case 'AbortRequest':
      return { ok: false, error: 'GM_xmlhttpRequest 尚未接入（Task 10 实现跨域确认流）' };
    default:
      return { ok: false, error: `未知 GM API：${api}` };
  }
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
}

