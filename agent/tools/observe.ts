// agent/tools/observe.ts
// 观测三工具执行器（设计 §6）：读 SW observe-store 缓冲，零 content script 往返。
// get_network_request 读取时按 settings.agent.networkCaptureHeaders 脱敏（设计 §4.3）。
// 降级语义（CDP spec §4.2）：深度观测未开启时不报错，返回 deepObserve:false + hint。
import type { ToolResult } from '../../shared/types';
import { getSettings } from '../../storage/settings';
import { redactHeaders } from '../../observe/redact';
import { readConsole, readNetworkList, readNetworkDetail } from '../../background/observe-store';
import { getState } from '../../background/cdp/session';

const CONSOLE_HINT =
  '控制台观测需要深度观测（CDP），当前未开启；可调用 enable_deep_observe 开启'
  + '（会在页面顶部显示 Chrome 调试提示条，且与页面 DevTools 互斥）';
const NETWORK_HINT =
  '当前只有 webRequest 元数据（无响应体、无请求头）；要看这些内容可调用 enable_deep_observe 开启深度观测';

function isDeepObserve(tabId: number): boolean {
  return getState(tabId).status === 'on';
}

export async function doListConsoleMessages(
  tabId: number,
  args: { level?: string; limit?: number },
): Promise<ToolResult> {
  const deepObserve = isDeepObserve(tabId);
  const messages = readConsole(tabId, { level: args.level, limit: args.limit });
  if (deepObserve) return { ok: true, data: { messages, deepObserve } };
  return { ok: true, data: { messages, deepObserve, hint: CONSOLE_HINT } };
}

export async function doListNetworkRequests(
  tabId: number,
  args: { method?: string; urlContains?: string; status?: number; limit?: number },
): Promise<ToolResult> {
  const deepObserve = isDeepObserve(tabId);
  const requests = readNetworkList(tabId, args);
  if (deepObserve) return { ok: true, data: { requests, deepObserve } };
  return { ok: true, data: { requests, deepObserve, hint: NETWORK_HINT } };
}

export async function doGetNetworkRequest(
  tabId: number,
  args: { requestId: string },
): Promise<ToolResult> {
  if (!args.requestId) return { ok: false, error: 'get_network_request 缺少 requestId 参数' };
  const entry = readNetworkDetail(tabId, args.requestId);
  if (!entry) return { ok: false, error: `未找到请求 ${args.requestId}（可能已被环形缓冲淘汰或不在当前标签）` };
  const { networkCaptureHeaders } = (await getSettings()).agent;
  const deepObserve = isDeepObserve(tabId);
  const data: Record<string, unknown> = {
    requestId: entry.requestId,
    method: entry.method,
    url: entry.url,
    type: entry.type,
    status: entry.status,
    error: entry.error,
    ts: entry.ts,
    durationMs: entry.endTs != null ? entry.endTs - entry.ts : undefined,
    requestHeaders: entry.requestHeaders ? redactHeaders(entry.requestHeaders, networkCaptureHeaders) : undefined,
    responseHeaders: entry.responseHeaders ? redactHeaders(entry.responseHeaders, networkCaptureHeaders) : undefined,
    requestBody: entry.requestBody,
    responseBody: entry.responseBody,
    wsFrames: entry.wsFrames,
    truncated: entry.truncated,
    source: entry.source,
    deepObserve,
  };
  // 无 body 且无 headers 且未开深度观测：说明为什么看不到内容。
  const empty = !entry.requestHeaders && !entry.responseHeaders && !entry.requestBody && !entry.responseBody;
  if (!deepObserve && empty) data.hint = NETWORK_HINT;
  return { ok: true, data };
}
