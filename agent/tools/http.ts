// agent/tools/http.ts
// http_request 工具（设计 §6、§7）：background fetch，带 same-origin cookie（credentials:'include'）。
// 响应头只回白名单子集；body 按 content-type 判文本，截断 64KB。
// 默认 30s 超时 + 可选外部 signal（为 Task 6 透传 ctx.signal 预留），避免挂起服务器阻塞 agent。
// 已知风险：带凭证 + 无门控（设计 §7），后续 Phase 补门控闭合。
import type { ToolResult } from '../../shared/types';

const MAX_BODY = 64 * 1024;
const TIMEOUT_MS = 30_000;
const HEADER_ALLOW = new Set(['content-type', 'content-length', 'server', 'date', 'cache-control', 'last-modified', 'etag']);
const TEXT_CT = /(text\/|application\/(json|xml|javascript|x-www-form-urlencoded)|\+json|\+xml)/i;

export async function doHttpRequest(args: {
  url: string; method?: string; headers?: Record<string, string>; body?: string;
}, externalSignal?: AbortSignal): Promise<ToolResult> {
  if (!args.url) return { ok: false, error: 'http_request 缺少 url 参数' };
  // 组合超时与外部 signal：内部 timer 到点 abort；外部 signal abort 时联动 abort。
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('timeout')), TIMEOUT_MS);
  if (externalSignal) {
    if (externalSignal.aborted) ac.abort();
    else externalSignal.addEventListener('abort', () => ac.abort(), { once: true });
  }
  try {
    // 外部 signal 到达时已 abort → 直接中止，不调用 fetch（真实 fetch 会拒，
    // 但 Node AbortSignal 对 abort 后才挂的监听器不触发事件，故此处显式短路）。
    if (ac.signal.aborted) return { ok: false, error: 'http_request 已中止（超时 30s 或被取消）' };
    const resp = await fetch(args.url, {
      method: args.method ?? 'GET',
      headers: args.headers,
      body: args.body,
      credentials: 'include',
      signal: ac.signal,
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
    // abort 导致的错误给出更清晰的信息（超时或被外部取消）。
    if (ac.signal.aborted) return { ok: false, error: 'http_request 已中止（超时 30s 或被取消）' };
    return { ok: false, error: `http_request 失败：${err instanceof Error ? err.message : String(err)}` };
  } finally {
    clearTimeout(timer);
  }
}
