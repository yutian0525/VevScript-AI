// agent/tools/http.ts
// http_request 工具（设计 §6、§7）：background fetch，带 same-origin cookie（credentials:'include'）。
// 响应头只回白名单子集；body 按 content-type 判文本，截断 64KB。
// 已知风险：带凭证 + 无门控（设计 §7），后续 Phase 补门控闭合。
import type { ToolResult } from '../../shared/types';

const MAX_BODY = 64 * 1024;
const HEADER_ALLOW = new Set(['content-type', 'content-length', 'server', 'date', 'cache-control', 'last-modified', 'etag']);
const TEXT_CT = /(text\/|application\/(json|xml|javascript|x-www-form-urlencoded)|\+json|\+xml)/i;

export async function doHttpRequest(args: {
  url: string; method?: string; headers?: Record<string, string>; body?: string;
}): Promise<ToolResult> {
  if (!args.url) return { ok: false, error: 'http_request 缺少 url 参数' };
  try {
    const resp = await fetch(args.url, {
      method: args.method ?? 'GET',
      headers: args.headers,
      body: args.body,
      credentials: 'include',
    });
    const headers: Record<string, string> = {};
    resp.headers.forEach((v, k) => { if (HEADER_ALLOW.has(k.toLowerCase())) headers[k.toLowerCase()] = v; });
    const ct = resp.headers.get('content-type') ?? '';
    let body: string;
    let truncated = false;
    if (TEXT_CT.test(ct) || ct === '') {
      const text = await resp.text();
      if (text.length > MAX_BODY) { body = text.slice(0, MAX_BODY); truncated = true; }
      else body = text;
    } else {
      body = `[非文本响应体已省略，content-type=${ct}]`;
    }
    return { ok: true, data: { status: resp.status, statusText: resp.statusText, headers, body, ...(truncated ? { truncated } : {}) } };
  } catch (err) {
    return { ok: false, error: `http_request 失败：${err instanceof Error ? err.message : String(err)}` };
  }
}
