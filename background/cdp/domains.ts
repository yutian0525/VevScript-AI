// background/cdp/domains.ts
// CDP 域启用 + 事件 → observe-store 摄入（设计 §5.2）。
import { serializeRemoteObjects, type RemoteObjectLike } from './console-text';
import { shouldFetchBody, fetchBody } from './bodies';
import { rememberSession, forgetSession } from './session';
import {
  ingestCdpStart, ingestCdpResponse, ingestCdpEnd, ingestCdpError,
  ingestCdpWsFrame, getCdpEntry, setCdpBody, ingestConsole,
} from '../observe-store';
import type { ConsoleEntry } from '../../shared/observe';

const MAX_TOTAL_BUFFER = 10 * 1024 * 1024;
const MAX_RESOURCE_BUFFER = 5 * 1024 * 1024;

let consoleSeq = 0;

/** 仅测试用：重置内部计数器。 */
export function __resetCdpDomains(): void { consoleSeq = 0; }

async function cmd(
  tabId: number, sessionId: string | undefined, method: string, params?: Record<string, unknown>,
): Promise<unknown> {
  return browser.debugger.sendCommand({ tabId, sessionId }, method, params);
}

/** 主 target 的域启用。子 session 只走 enableChild（不再 setAutoAttach，避免无限递归）。 */
export async function enableAll(tabId: number): Promise<void> {
  await cmd(tabId, undefined, 'Network.enable', {
    maxTotalBufferSize: MAX_TOTAL_BUFFER, maxResourceBufferSize: MAX_RESOURCE_BUFFER,
  });
  await cmd(tabId, undefined, 'Runtime.enable');
  await cmd(tabId, undefined, 'Log.enable');
  await cmd(tabId, undefined, 'Page.enable');
  await cmd(tabId, undefined, 'Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: false, // 必须 false：置 true 会把页面冻在启动断点上
    flatten: true,
  });
}

async function enableChild(tabId: number, sessionId: string): Promise<void> {
  await cmd(tabId, sessionId, 'Network.enable', {
    maxTotalBufferSize: MAX_TOTAL_BUFFER, maxResourceBufferSize: MAX_RESOURCE_BUFFER,
  }).catch(() => {});
  await cmd(tabId, sessionId, 'Runtime.enable').catch(() => {});
  await cmd(tabId, sessionId, 'Log.enable').catch(() => {});
}

/** CDP 时间戳：优先 wallTime（epoch 秒），退回本地时钟。 */
function tsOf(params: Record<string, unknown>): number {
  const wall = params.wallTime;
  if (typeof wall === 'number') return Math.round(wall * 1000);
  return Date.now();
}

/** Runtime.consoleAPICalled 的 type → 我们的 level 词表。 */
function consoleLevel(type: string): string {
  if (type === 'error' || type === 'assert') return 'error';
  if (type === 'warning') return 'warn';
  if (type === 'info') return 'info';
  if (type === 'debug' || type === 'verbose') return 'debug';
  return 'log';
}

function pushConsole(tabId: number, level: string, text: string, ts: number, url?: string): void {
  const entry: ConsoleEntry = { id: `cdp:${++consoleSeq}`, level, text, ts, url };
  ingestConsole(tabId, [entry]);
}

export async function handleEvent(
  tabId: number,
  sessionId: string | undefined,
  method: string,
  params: Record<string, unknown>,
): Promise<void> {
  switch (method) {
    case 'Target.attachedToTarget': {
      const sid = params.sessionId as string | undefined;
      if (!sid) return;
      rememberSession(tabId, sid);
      await enableChild(tabId, sid);
      return;
    }
    case 'Target.detachedFromTarget': {
      const sid = params.sessionId as string | undefined;
      if (sid) forgetSession(sid);
      return;
    }
    case 'Network.requestWillBeSent': {
      const req = params.request as { url?: string; method?: string; headers?: Record<string, string>; postData?: string } | undefined;
      if (!req?.url) return;
      ingestCdpStart(tabId, {
        requestId: params.requestId as string,
        method: req.method ?? 'GET',
        url: req.url,
        type: (params.type as string) ?? 'Other',
        ts: tsOf(params),
        requestHeaders: req.headers,
        requestBody: typeof req.postData === 'string' ? req.postData : undefined,
      });
      return;
    }
    case 'Network.responseReceived': {
      const res = params.response as { status?: number; headers?: Record<string, string>; mimeType?: string } | undefined;
      if (!res) return;
      ingestCdpResponse(tabId, {
        requestId: params.requestId as string,
        status: res.status ?? 0,
        responseHeaders: res.headers,
        mimeType: res.mimeType,
      });
      return;
    }
    case 'Network.loadingFinished': {
      const requestId = params.requestId as string;
      ingestCdpEnd(tabId, { requestId, ts: tsOf(params) });
      const entry = getCdpEntry(tabId, requestId);
      if (!entry || !shouldFetchBody(entry.type, entry.mimeType)) return;
      const body = await fetchBody(tabId, sessionId, requestId);
      if (body) setCdpBody(tabId, requestId, body);
      return;
    }
    case 'Network.loadingFailed': {
      ingestCdpError(tabId, {
        requestId: params.requestId as string,
        error: (params.errorText as string) ?? 'unknown',
        ts: tsOf(params),
      });
      return;
    }
    case 'Network.webSocketFrameSent':
    case 'Network.webSocketFrameReceived': {
      const frame = params.response as { opcode?: number; payloadData?: string } | undefined;
      if (!frame) return;
      ingestCdpWsFrame(tabId, {
        requestId: params.requestId as string,
        dir: method.endsWith('Sent') ? 'sent' : 'received',
        opcode: frame.opcode ?? 0,
        payload: frame.payloadData ?? '',
        ts: tsOf(params),
      });
      return;
    }
    case 'Runtime.consoleAPICalled': {
      const args = (params.args ?? []) as RemoteObjectLike[];
      pushConsole(tabId, consoleLevel((params.type as string) ?? 'log'), serializeRemoteObjects(args), tsOf(params));
      return;
    }
    case 'Runtime.exceptionThrown': {
      const d = params.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined;
      if (!d) return;
      const text = [d.text, d.exception?.description].filter(Boolean).join(' ');
      pushConsole(tabId, 'error', text, tsOf(params));
      return;
    }
    case 'Log.entryAdded': {
      const e = params.entry as { level?: string; text?: string; url?: string } | undefined;
      if (!e?.text) return;
      pushConsole(tabId, consoleLevel(e.level ?? 'info'), e.text, tsOf(params), e.url);
      return;
    }
    default:
      return;
  }
}
