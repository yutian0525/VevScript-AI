// agent/mcp/client.ts
// MCP 客户端：JSON-RPC 2.0 over HTTP，两种传输 + auto 探测。
//   streamable = 单端点 POST（2025-06-18），响应可为 JSON 或 text/event-stream
//   sse        = GET 事件流拿 endpoint + POST /messages（2024-11-05），响应靠 id 在流上匹配
// MV3 的 SW 会被回收，连接不保活：本客户端刻意做成「一次性握手 + 短请求」，
// 断开后重建一个新客户端即可（重连 = 换新 client，见 background/mcp.ts）。
import {
  MCP_DEFAULT_TIMEOUT_MS,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpCallResult,
  type McpToolDef,
  type McpTransport,
} from '../../shared/mcp';
import { firstJsonRpcResponse, parseSseChunk, type JsonRpcPayload, type SseEvent } from './sse';

export class McpError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
    this.name = 'McpError';
  }
}

export interface McpClientOptions {
  url: string;
  transport?: McpTransport;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** 注入点：单测用假 fetch，生产用全局 fetch。 */
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  clientInfo?: { name: string; version: string };
}

export interface McpClient {
  /** 实际生效的传输（auto 探测后才有确定值）。 */
  readonly transport: 'streamable' | 'sse' | null;
  readonly protocolVersion?: string;
  readonly serverInfo?: { name?: string; version?: string };
  connect(): Promise<void>;
  listTools(): Promise<McpToolDef[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult>;
  close(): void;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

function defer<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** 协商时声明的协议版本。若服务端不接受会回它自己的版本，我们照单全收不强校验。 */
const REQUESTED_PROTOCOL_VERSION = '2025-06-18';
const JSONRPC = '2.0';

export function createMcpClient(opts: McpClientOptions): McpClient {
  const requested = opts.transport ?? 'auto';
  const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : MCP_DEFAULT_TIMEOUT_MS;
  const doFetch = opts.fetchImpl ?? ((u: string, i: RequestInit) => fetch(u, i));
  const customHeaders = opts.headers ?? {};
  const clientInfo = opts.clientInfo ?? { name: 'vevscript-ai', version: '0.2.0' };

  let active: 'streamable' | 'sse' | null = null;
  let sessionId: string | undefined;
  let protocolVersion: string | undefined;
  let serverInfo: { name?: string; version?: string } | undefined;
  let nextId = 1;
  let closed = false;

  // ---- HTTP+SSE 传输的运行时 ----
  let sseAbort: AbortController | undefined;
  let sseEndpoint: string | undefined;
  let endpointGate: Deferred<string> | undefined;
  const pending = new Map<number, Deferred<JsonRpcPayload>>();

  const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bomb = new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new McpError(`${what} 超时（${ms}ms）`)), ms);
    });
    return Promise.race([p, bomb]).finally(() => clearTimeout(timer)) as Promise<T>;
  };

  function baseHeaders(extra?: Record<string, string>): Record<string, string> {
    return { ...customHeaders, ...(extra ?? {}) };
  }

  /**
   * 统一超时：自带 AbortController，超时既是「不再等」也是「告诉对面别再算」。
   * 被自己 abort 掉的一律翻译成 McpError（超时），不让调用方去区分 DOMException。
   */
  async function timedFetch(url: string, init: RequestInit, what: string): Promise<Response> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      return await doFetch(url, { ...init, signal: ac.signal });
    } catch (e) {
      if (ac.signal.aborted) throw new McpError(`${what} 超时（${timeoutMs}ms）`);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------------- Streamable HTTP ----------------

  async function postStreamable(body: JsonRpcRequest): Promise<JsonRpcPayload> {
    const headers = baseHeaders({
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
    });
    const resp = await timedFetch(opts.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }, `请求 ${body.method}`);
    const sid = resp.headers?.get?.('Mcp-Session-Id');
    if (sid) sessionId = sid;
    if (!resp.ok) throw new McpError(`HTTP ${resp.status}`, resp.status);
    if (body.id == null) return {}; // 通知：不等响应（202 / 空体都正常）
    const ct = String(resp.headers?.get?.('content-type') ?? '').toLowerCase();
    if (ct.includes('text/event-stream')) {
      if (!resp.body) throw new McpError('服务端返回 SSE 但没有响应体');
      const text = await readAll(resp.body, timeoutMs);
      const payload = firstJsonRpcResponse(parseSseChunk(text).events);
      if (!payload) throw new McpError('SSE 流里没有 JSON-RPC 响应');
      return payload;
    }
    let json: unknown;
    try {
      json = await resp.json();
    } catch {
      throw new McpError('响应不是合法 JSON（该端点可能不是 MCP 服务）');
    }
    return normalize(json as JsonRpcResponse);
  }

  // ---------------- HTTP+SSE ----------------

  async function openSse(): Promise<void> {
    const ac = new AbortController();
    sseAbort = ac;
    endpointGate = defer<string>();
    const resp = await timedFetch(opts.url, {
      method: 'GET',
      headers: baseHeaders({ Accept: 'text/event-stream' }),
    }, '建立 SSE 连接');
    if (!resp.ok) throw new McpError(`SSE 连接失败：HTTP ${resp.status}`, resp.status);
    if (!resp.body) throw new McpError('SSE 响应没有响应体');
    void pump(resp.body);
    sseEndpoint = await withTimeout(endpointGate.promise, timeoutMs, '等待 endpoint 事件');
  }

  async function pump(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parsed = parseSseChunk(buf);
        buf = parsed.rest;
        for (const ev of parsed.events) handleSseEvent(ev);
      }
    } catch {
      // 流断（SW 被回收、网络抖动）：下面的 finally 会把等待者全部叫醒
    } finally {
      failAllPending(new McpError('MCP 连接已断开'));
    }
  }

  function handleSseEvent(ev: SseEvent): void {
    if (ev.event === 'endpoint') {
      try {
        sseEndpoint = new URL(ev.data.trim(), opts.url).toString();
      } catch {
        sseEndpoint = ev.data.trim();
      }
      endpointGate?.resolve(sseEndpoint);
      return;
    }
    let obj: unknown;
    try {
      obj = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (typeof obj !== 'object' || obj === null) return;
    const o = obj as Record<string, unknown>;
    if (!('result' in o) && !('error' in o)) return;
    const id = typeof o.id === 'number' ? o.id : undefined;
    const waiter = id != null ? pending.get(id) : undefined;
    if (!waiter) return;
    pending.delete(id!);
    waiter.resolve({
      ...(o.id != null ? { id: o.id as number | string } : {}),
      ...('result' in o ? { result: o.result as Record<string, unknown> } : {}),
      ...('error' in o ? { error: o.error as never } : {}),
    });
  }

  function failAllPending(err: Error): void {
    for (const [, d] of pending) d.reject(err);
    pending.clear();
    endpointGate?.reject(err);
    endpointGate = undefined;
  }

  async function requestSse(body: JsonRpcRequest): Promise<JsonRpcPayload> {
    if (!sseEndpoint) throw new McpError('SSE 端点尚未就绪');
    const resp = await timedFetch(sseEndpoint, {
      method: 'POST',
      headers: baseHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    }, `请求 ${body.method}`);
    // 部分实现直接在 POST 响应里回结果；没有才去 GET 流上等
    if (resp.ok) {
      const direct = await readJsonPayload(resp);
      if (direct) return direct;
    }
    if (body.id == null) return {}; // 通知：不等响应
    const id = body.id as number;
    const d = defer<JsonRpcPayload>();
    pending.set(id, d);
    const bomb = setTimeout(() => {
      if (pending.delete(id)) d.reject(new McpError(`MCP 请求超时（${body.method}）`));
    }, timeoutMs);
    try {
      return await d.promise;
    } finally {
      clearTimeout(bomb);
    }
  }

  async function readJsonPayload(resp: Response): Promise<JsonRpcPayload | undefined> {
    const ct = String(resp.headers?.get?.('content-type') ?? '').toLowerCase();
    if (!ct.includes('application/json')) return undefined;
    try {
      const json = (await resp.json()) as Record<string, unknown>;
      if (!('result' in json) && !('error' in json)) return undefined;
      return normalize(json as unknown as JsonRpcResponse);
    } catch {
      return undefined;
    }
  }

  // ---------------- 统一分发 ----------------

  function request(method: string, params?: Record<string, unknown>, id?: number): Promise<JsonRpcPayload> {
    const body: JsonRpcRequest = {
      jsonrpc: JSONRPC,
      method,
      ...(id != null ? { id } : {}),
      ...(params ? { params } : {}),
    };
    if (active === 'sse') return requestSse(body);
    return postStreamable(body);
  }

  async function handshake(): Promise<void> {
    const r = await request('initialize', {
      protocolVersion: REQUESTED_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo,
    }, nextId++);
    const result = r.result ?? {};
    if (typeof result.protocolVersion === 'string') protocolVersion = result.protocolVersion;
    const si = result.serverInfo;
    if (si && typeof si === 'object') {
      const o = si as Record<string, unknown>;
      serverInfo = {
        ...(typeof o.name === 'string' ? { name: o.name } : {}),
        ...(typeof o.version === 'string' ? { version: o.version } : {}),
      };
    }
    // initialized 通知：无 id，不等响应（SSE 传输下发完即返回）
    await request('notifications/initialized');
  }

  async function connect(): Promise<void> {
    if (closed) throw new McpError('MCP 客户端已关闭');
    if (active) return;
    if (requested === 'sse') {
      active = 'sse';
      try {
        await openSse();
        await handshake();
      } catch (e) {
        active = null; // 失败不算「已选定传输」，下次可重来
        throw e;
      }
      return;
    }
    active = 'streamable';
    try {
      await handshake();
      return;
    } catch (e) {
      if (requested === 'streamable') { active = null; throw e; }
      const first = e instanceof Error ? e.message : String(e);
      // 回退：丢掉 streamable 的会话，改走 SSE
      sessionId = undefined;
      active = 'sse';
      try {
        await openSse();
        await handshake();
      } catch (e2) {
        const second = e2 instanceof Error ? e2.message : String(e2);
        active = null;
        throw new McpError(`Streamable HTTP 失败（${first}）；回退 HTTP+SSE 也失败（${second}）`);
      }
    }
  }

  return {
    get transport() { return active; },
    get protocolVersion() { return protocolVersion; },
    get serverInfo() { return serverInfo; },
    connect,
    listTools: async () => {
      await connect();
      const r = await request('tools/list', {}, nextId++);
      const tools = r.result?.tools;
      if (!Array.isArray(tools)) return [];
      return tools.filter((t): t is McpToolDef => typeof (t as McpToolDef)?.name === 'string');
    },
    callTool: async (name, args) => {
      await connect();
      const r = await request('tools/call', { name, arguments: args ?? {} }, nextId++);
      return (r.result ?? {}) as McpCallResult;
    },
    close: () => {
      closed = true;
      active = null;
      sseAbort?.abort();
      sseAbort = undefined;
      failAllPending(new McpError('MCP 客户端已关闭'));
    },
  };
}

// ---------------- 工具函数 ----------------

async function readAll(body: ReadableStream<Uint8Array>, ms: number): Promise<string> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let out = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bomb = new Promise<never>((_, rej) => {
    timer = setTimeout(() => {
      void reader.cancel().catch(() => {});
      rej(new McpError(`读取响应超时（${ms}ms）`));
    }, ms);
  });
  try {
    await Promise.race([
      (async () => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          out += dec.decode(value, { stream: true });
        }
        out += dec.decode();
      })(),
      bomb,
    ]);
    return out;
  } finally {
    clearTimeout(timer);
  }
}

/** 把 JSON-RPC 回包归一成 { id, result, error }；带 error 直接抛 McpError（调用方不必各判一次）。 */
function normalize(resp: JsonRpcResponse): JsonRpcPayload {
  if (resp.error) throw new McpError(resp.error.message || `JSON-RPC 错误 ${resp.error.code}`, resp.error.code);
  return {
    ...(resp.id != null ? { id: resp.id } : {}),
    ...('result' in resp ? { result: resp.result ?? {} } : {}),
  };
}
