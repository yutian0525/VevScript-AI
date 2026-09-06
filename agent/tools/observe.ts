// agent/tools/observe.ts
// 观测三工具执行器（设计 §6）：读 SW observe-store 缓冲，零 content script 往返。
// get_network_request 读取时按 settings.agent.networkCaptureHeaders 脱敏（设计 §4.3）。
import type { ToolResult } from '../../shared/types';
import { getSettings } from '../../storage/settings';
import { redactHeaders } from '../../observe/redact';
import { readConsole, readNetworkList, readNetworkDetail } from '../../background/observe-store';

export async function doListConsoleMessages(
  tabId: number,
  args: { level?: string; limit?: number },
): Promise<ToolResult> {
  const messages = readConsole(tabId, { level: args.level, limit: args.limit });
  return { ok: true, data: { messages } };
}

export async function doListNetworkRequests(
  tabId: number,
  args: { method?: string; urlContains?: string; status?: number; limit?: number },
): Promise<ToolResult> {
  const requests = readNetworkList(tabId, args);
  return { ok: true, data: { requests } };
}

export async function doGetNetworkRequest(
  tabId: number,
  args: { requestId: string },
): Promise<ToolResult> {
  if (!args.requestId) return { ok: false, error: 'get_network_request 缺少 requestId 参数' };
  const entry = readNetworkDetail(tabId, args.requestId);
  if (!entry) return { ok: false, error: `未找到请求 ${args.requestId}（可能已被环形缓冲淘汰或不在当前标签）` };
  const { networkCaptureHeaders } = (await getSettings()).agent;
  return {
    ok: true,
    data: {
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
      truncated: entry.truncated,
      source: entry.source,
    },
  };
}
