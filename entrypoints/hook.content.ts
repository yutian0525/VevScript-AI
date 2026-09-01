// entrypoints/hook.content.ts
// MAIN world hook（设计 §4、§8.1）：document_start 包装 fetch/XHR/console + 运行时错误，
// window.postMessage 桥给同页 ISOLATED content.ts。透明性第一：任何采集异常都吞掉，绝不破坏页面。
// 本文件被 WXT 打包，可 import（区别于 scripting.executeScript 的自包含函数）。
import { HOOK_MSG, RELAY_READY, type HookWindowMsg, type ConsoleEntry, type HookNetEntry } from '../shared/hook-bridge';
import { serializeConsoleArgs } from '../observe/serialize';

export default defineContentScript({
  matches: ['<all_urls>'],
  world: 'MAIN',
  runAt: 'document_start',
  allFrames: true,
  main() {
    const MAX_BODY = 64 * 1024;
    const TEXT_CT = /(text\/|application\/(json|xml|javascript|x-www-form-urlencoded)|\+json|\+xml)/i;
    const loadNonce = Math.random().toString(36).slice(2, 10);
    let seq = 0;
    let relayReady = false;
    const backlog: HookWindowMsg[] = [];
    const BACKLOG_MAX = 400;

    const post = (msg: HookWindowMsg): void => {
      try { window.postMessage(msg, '*'); } catch { /* ignore */ }
      if (!relayReady) { backlog.push(msg); if (backlog.length > BACKLOG_MAX) backlog.shift(); }
    };

    // ISOLATED 中继就绪 → flush backlog（补 document_idle 前的早期观测）
    window.addEventListener('message', (ev) => {
      if (ev.source !== window) return;
      const d = ev.data as { source?: string } | undefined;
      if (d?.source === RELAY_READY) {
        relayReady = true;
        for (const m of backlog) { try { window.postMessage(m, '*'); } catch { /* ignore */ } }
        backlog.length = 0;
      }
    });

    // ---- console 包装（永远先调原始方法）----
    const levels: Array<'log' | 'info' | 'warn' | 'error' | 'debug'> = ['log', 'info', 'warn', 'error', 'debug'];
    for (const level of levels) {
      const orig = console[level].bind(console);
      console[level] = (...args: unknown[]) => {
        orig(...args);
        try {
          const entry: ConsoleEntry = { id: `${loadNonce}:${++seq}`, level, text: serializeConsoleArgs(args), ts: Date.now(), url: location.href };
          post({ source: HOOK_MSG, kind: 'console', entry });
        } catch { /* 采集失败不影响页面 */ }
      };
    }

    // ---- 运行时错误 ----
    window.addEventListener('error', (ev) => {
      try {
        const entry: ConsoleEntry = { id: `${loadNonce}:${++seq}`, level: 'error', text: `[uncaught] ${ev.message}${ev.filename ? ` @ ${ev.filename}:${ev.lineno}` : ''}`, ts: Date.now(), url: location.href };
        post({ source: HOOK_MSG, kind: 'console', entry });
      } catch { /* ignore */ }
    });
    window.addEventListener('unhandledrejection', (ev) => {
      try {
        const reason = (ev as PromiseRejectionEvent).reason;
        const text = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
        const entry: ConsoleEntry = { id: `${loadNonce}:${++seq}`, level: 'error', text: `[unhandledrejection] ${text}`, ts: Date.now(), url: location.href };
        post({ source: HOOK_MSG, kind: 'console', entry });
      } catch { /* ignore */ }
    });

    // ---- 公共小工具 ----
    const capBody = (s: string | undefined): { body?: string; truncated?: boolean } => {
      if (s == null) return {};
      if (s.length > MAX_BODY) return { body: s.slice(0, MAX_BODY), truncated: true };
      return { body: s };
    };
    const headersToObj = (h: HeadersInit | Headers | undefined): Record<string, string> | undefined => {
      if (!h) return undefined;
      const out: Record<string, string> = {};
      try {
        if (h instanceof Headers) h.forEach((v, k) => { out[k] = v; });
        else if (Array.isArray(h)) for (const [k, v] of h) out[String(k)] = String(v);
        else for (const [k, v] of Object.entries(h)) out[k] = String(v);
      } catch { return undefined; }
      return out;
    };
    const isSelf = (url: string): boolean => url.startsWith('chrome-extension://') || url.startsWith('moz-extension://');

    // ---- fetch 包装（clone 读 body，原 response 原样返回）----
    const origFetch = window.fetch;
    window.fetch = async function patchedFetch(this: unknown, ...args: Parameters<typeof fetch>): Promise<Response> {
      const [input, init] = args;
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      const ts = Date.now();
      const seqN = ++seq;
      const reqHeaders = headersToObj(init?.headers ?? (input instanceof Request ? (input as Request).headers : undefined));
      const reqBody = typeof init?.body === 'string' ? init.body : undefined;
      if (isSelf(url)) return origFetch.apply(this as never, args);
      try {
        const resp = await origFetch.apply(this as never, args);
        let respBody: string | undefined; let truncated: boolean | undefined;
        try {
          const ct = resp.headers.get('content-type') ?? '';
          if (TEXT_CT.test(ct) || ct === '') {
            const c = capBody(await resp.clone().text()); respBody = c.body; truncated = c.truncated;
          }
        } catch { /* body 读取失败忽略 */ }
        const rq = capBody(reqBody);
        const entry: HookNetEntry = { loadNonce, seq: seqN, method, url, ts, endTs: Date.now(), status: resp.status, requestHeaders: reqHeaders, responseHeaders: headersToObj(resp.headers), requestBody: rq.body, responseBody: respBody, truncated: truncated || rq.truncated };
        post({ source: HOOK_MSG, kind: 'network', entry });
        return resp;
      } catch (err) {
        const rq = capBody(reqBody);
        post({ source: HOOK_MSG, kind: 'network', entry: { loadNonce, seq: seqN, method, url, ts, endTs: Date.now(), requestHeaders: reqHeaders, requestBody: rq.body, truncated: rq.truncated } });
        throw err;
      }
    } as typeof fetch;

    // ---- XHR 包装 ----
    const XHR = XMLHttpRequest.prototype;
    const origOpen = XHR.open;
    const origSend = XHR.send;
    interface Tracked { _m?: string; _u?: string; _ts?: number; _seq?: number; _reqBody?: string }
    origOpen && (XHR.open = function (this: XMLHttpRequest & Tracked, method: string, url: string, ...rest: unknown[]) {
      this._m = String(method).toUpperCase(); this._u = String(url);
      // @ts-expect-error 透传原始可变参数
      return origOpen.call(this, method, url, ...rest);
    } as typeof XHR.open);
    origSend && (XHR.send = function (this: XMLHttpRequest & Tracked, body?: Document | XMLHttpRequestBodyInit | null) {
      this._ts = Date.now(); this._seq = ++seq;
      this._reqBody = typeof body === 'string' ? body : undefined;
      const url = this._u ?? '';
      if (!isSelf(url)) {
        this.addEventListener('loadend', () => {
          try {
            let respBody: string | undefined; let truncated: boolean | undefined;
            const ct = this.getResponseHeader('content-type') ?? '';
            if ((this.responseType === '' || this.responseType === 'text') && (TEXT_CT.test(ct) || ct === '')) {
              const c = capBody(this.responseText); respBody = c.body; truncated = c.truncated;
            }
            const rq = capBody(this._reqBody);
            const respHeaders: Record<string, string> = {};
            for (const line of (this.getAllResponseHeaders() || '').trim().split(/\r?\n/)) {
              const i = line.indexOf(':'); if (i > 0) respHeaders[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
            }
            const entry: HookNetEntry = { loadNonce, seq: this._seq!, method: this._m ?? 'GET', url, ts: this._ts!, endTs: Date.now(), status: this.status, responseHeaders: respHeaders, requestBody: rq.body, responseBody: respBody, truncated: truncated || rq.truncated };
            post({ source: HOOK_MSG, kind: 'network', entry });
          } catch { /* ignore */ }
        });
      }
      return origSend.call(this, body ?? null);
    } as typeof XHR.send);
  },
});
