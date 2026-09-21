// background/cdp/bodies.ts
// 响应体抓取策略（设计 §5.4）：只在 loadingFinished 时按白名单立即取走——
// CDP 的 body 缓冲会被淘汰，等工具调用时再拉不可靠。
export const MAX_BODY = 64 * 1024;

/** 抓体白名单：与旧 hook 的 fetch/XHR 语义对齐，另加 Document（HTML 正文有诊断价值）。 */
const BODY_TYPE_ALLOWLIST = new Set(['XHR', 'Fetch', 'Document']);
/** 非文本 mimeType 前缀/片段，命中即跳过。 */
const NON_TEXT_MIME = ['image/', 'font/', 'audio/', 'video/'];
const SSE_MIME = 'event-stream';

export function shouldFetchBody(type: string, mimeType?: string): boolean {
  if (!BODY_TYPE_ALLOWLIST.has(type)) return false;
  if (!mimeType) return true;
  const mime = mimeType.toLowerCase();
  if (mime.includes(SSE_MIME)) return false;
  return !NON_TEXT_MIME.some((p) => mime.startsWith(p));
}

export function truncateBody(text: string): { body: string; truncated: boolean } {
  if (text.length <= MAX_BODY) return { body: text, truncated: false };
  return { body: text.slice(0, MAX_BODY), truncated: true };
}

/** 取单条响应体。任何失败（已淘汰/重定向/缓存命中/二进制）返回 null，由调用方标 hasBody:false。 */
export async function fetchBody(
  tabId: number,
  sessionId: string | undefined,
  requestId: string,
): Promise<{ body: string; truncated: boolean } | null> {
  try {
    const res = await browser.debugger.sendCommand(
      { tabId, sessionId },
      'Network.getResponseBody',
      { requestId },
    ) as { body?: string; base64Encoded?: boolean } | undefined;
    if (!res?.body || res.base64Encoded) return null;
    return truncateBody(res.body);
  } catch {
    return null;
  }
}
