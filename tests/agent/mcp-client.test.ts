// tests/agent/mcp-client.test.ts
// MCP 客户端：用假 fetch 覆盖两种传输与 auto 探测。不碰真实网络，也不碰 browser API。
import { describe, it, expect } from 'vitest';
import { createMcpClient, McpError, type McpClientOptions } from '../../agent/mcp/client';

interface Call { url: string; init: RequestInit }

function fakeResp(body: string | ReadableStream<Uint8Array> | null, opts: { status?: number; headers?: Record<string, string> } = {}): Response {
  const status = opts.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(opts.headers ?? {}),
    body: typeof body === 'string' ? (body ? textStream(body) : null) : body,
    json: async () => JSON.parse(typeof body === 'string' ? body : 'null'),
  } as unknown as Response;
}

function textStream(s: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(enc.encode(s)); c.close(); },
  });
}

/** 可被外部持续 push 的 SSE 流（模拟 GET 长连接）。 */
function openStream(): { stream: ReadableStream<Uint8Array>; push: (s: string) => void } {
  const enc = new TextEncoder();
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(c) { ctl = c; } });
  return { stream, push: (s) => ctl.enqueue(enc.encode(s)) };
}

/** 按 method 路由的 streamable 假服务端。按顺序应答 initialize / initialized / tools/list / tools/call。 */
function streamableMock(extra?: { sessionId?: string }) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    const body = JSON.parse(String(init.body ?? '{}'));
    const id = body.id;
    if (body.method === 'initialize') {
      return fakeResp(JSON.stringify({
        jsonrpc: '2.0', id,
        result: { protocolVersion: '2025-06-18', serverInfo: { name: 'demo', version: '1.0.0' } },
      }), { headers: { 'content-type': 'application/json', ...(extra?.sessionId ? { 'Mcp-Session-Id': extra.sessionId } : {}) } });
    }
    if (body.method === 'notifications/initialized') return fakeResp(null, { status: 202 });
    if (body.method === 'tools/list') {
      return fakeResp(JSON.stringify({
        jsonrpc: '2.0', id,
        result: { tools: [{ name: 'read_file', description: '读文件', inputSchema: { type: 'object' } }] },
      }), { headers: { 'content-type': 'application/json' } });
    }
    if (body.method === 'tools/call') {
      return fakeResp(JSON.stringify({
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: '文件内容' }], isError: false },
      }), { headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`未预期的 method: ${body.method}`);
  };
  return { calls, fetchImpl };
}

describe('streamable HTTP', () => {
  it('握手 → 拉工具 → 调工具，全链路通', async () => {
    const { fetchImpl } = streamableMock();
    const c = createMcpClient({ url: 'https://mcp.example.com/mcp', fetchImpl });
    const tools = await c.listTools();
    expect(c.transport).toBe('streamable');
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe('read_file');
    const r = await c.callTool('read_file', { path: '/a.txt' });
    expect(r.content?.[0]?.text).toBe('文件内容');
    expect(c.protocolVersion).toBe('2025-06-18');
    expect(c.serverInfo?.name).toBe('demo');
    c.close();
  });

  it('服务端回传的会话 id 会在后续请求里原样带回', async () => {
    const { calls, fetchImpl } = streamableMock({ sessionId: 'sess-1' });
    const c = createMcpClient({ url: 'https://mcp.example.com/mcp', fetchImpl });
    await c.listTools();
    const second = calls.find((x) => x.init.method === 'POST' && String(x.init.body).includes('tools/list'));
    expect((second!.init.headers as Record<string, string>)['Mcp-Session-Id']).toBe('sess-1');
    c.close();
  });

  it('响应为 text/event-stream 时按 SSE 帧取结果', async () => {
    const calls: Call[] = [];
    const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
      calls.push({ url, init });
      const body = JSON.parse(String(init.body ?? '{}'));
      if (body.method === 'initialize') {
        return fakeResp(
          textStream(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-03-26' } })}\n\n`),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }
      return fakeResp(null, { status: 202 });
    };
    const c = createMcpClient({ url: 'https://mcp.example.com/mcp', fetchImpl });
    await c.connect();
    expect(c.protocolVersion).toBe('2025-03-26');
    c.close();
  });

  it('JSON-RPC error 直接抛 McpError（调用方不必各判一次）', async () => {
    const fetchImpl = async (): Promise<Response> => fakeResp(JSON.stringify({
      jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'method not found' },
    }), { headers: { 'content-type': 'application/json' } });
    const c = createMcpClient({ url: 'https://mcp.example.com/mcp', fetchImpl, transport: 'streamable' });
    await expect(c.connect()).rejects.toThrow(McpError);
    await expect(c.connect()).rejects.toThrow(/method not found/);
  });

  it('自定义请求头原样透传', async () => {
    const { calls, fetchImpl } = streamableMock();
    const c = createMcpClient({
      url: 'https://mcp.example.com/mcp',
      fetchImpl,
      headers: { Authorization: 'Bearer sk-test' },
    });
    await c.listTools();
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
    c.close();
  });

  it('transport=streamable 时不再回退 SSE（失败就直接抛）', async () => {
    const calls: Call[] = [];
    const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
      calls.push({ url, init });
      return fakeResp(null, { status: 404 });
    };
    const c = createMcpClient({ url: 'https://mcp.example.com/mcp', fetchImpl, transport: 'streamable' });
    await expect(c.connect()).rejects.toThrow(/404/);
    expect(calls.every((x) => x.init.method === 'POST')).toBe(true);
  });

  it('请求超时抛 McpError（不永久挂起）', async () => {
    const fetchImpl = (_url: string, init: RequestInit): Promise<Response> =>
      new Promise((_res, rej) => { init.signal?.addEventListener('abort', () => rej(new Error('aborted'))); });
    const c = createMcpClient({ url: 'https://mcp.example.com/mcp', fetchImpl, timeoutMs: 20 });
    await expect(c.connect()).rejects.toThrow(/超时/);
  });
});

/** SSE 传输的假服务端：GET 给流，POST 把响应推回流上。 */
function sseMock(opts?: { failFirstPost?: boolean }) {
  const calls: Call[] = [];
  const { stream, push } = openStream();
  let posts = 0;
  const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    if (init.method === 'GET') {
      setTimeout(() => push('event: endpoint\ndata: /messages?sessionId=abc\n\n'), 0);
      return fakeResp(stream, { headers: { 'content-type': 'text/event-stream' } });
    }
    posts += 1;
    if (opts?.failFirstPost && posts === 1) return fakeResp(null, { status: 404 });
    const body = JSON.parse(String(init.body ?? '{}'));
    const result = body.method === 'initialize'
      ? { protocolVersion: '2024-11-05', serverInfo: { name: 'legacy' } }
      : body.method === 'tools/list'
        ? { tools: [{ name: 'query', description: '查库' }] }
        : { content: [{ type: 'text', text: 'ok' }] };
    setTimeout(() => push(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result })}\n\n`), 0);
    return fakeResp(null, { status: 202 });
  };
  return { calls, fetchImpl };
}

describe('HTTP+SSE', () => {
  it('transport=sse 时直接走 GET 建流，不先试 POST', async () => {
    const { calls, fetchImpl } = sseMock();
    const c = createMcpClient({ url: 'https://mcp.example.com/sse', fetchImpl, transport: 'sse' });
    await c.connect();
    expect(calls[0]!.init.method).toBe('GET');
    expect(c.transport).toBe('sse');
    c.close();
  });

  it('endpoint 事件给出的相对路径按 baseUrl 解析成绝对地址', async () => {
    const { calls, fetchImpl } = sseMock();
    const c = createMcpClient({ url: 'https://mcp.example.com/sse', fetchImpl, transport: 'sse' });
    await c.listTools();
    const post = calls.find((x) => x.init.method === 'POST');
    expect(post!.url).toBe('https://mcp.example.com/messages?sessionId=abc');
    c.close();
  });

  it('响应从 GET 流上按 id 匹配回来', async () => {
    const { fetchImpl } = sseMock();
    const c = createMcpClient({ url: 'https://mcp.example.com/sse', fetchImpl, transport: 'sse' });
    const tools = await c.listTools();
    expect(tools[0]!.name).toBe('query');
    const r = await c.callTool('query', { sql: 'select 1' });
    expect(r.content?.[0]?.text).toBe('ok');
    c.close();
  });
});

describe('auto 探测', () => {
  it('streamable 端点 404 → 自动回退 SSE 并正常工作', async () => {
    const { calls, fetchImpl } = sseMock({ failFirstPost: true });
    const c = createMcpClient({ url: 'https://mcp.example.com/mcp', fetchImpl });
    const tools = await c.listTools();
    expect(c.transport).toBe('sse');
    expect(tools[0]!.name).toBe('query');
    expect(calls.some((x) => x.init.method === 'POST')).toBe(true);
    c.close();
  });

  it('两条路都走不通 → 报错里带上两端的失败原因', async () => {
    const fetchImpl = async (): Promise<Response> => fakeResp(null, { status: 502 });
    const c = createMcpClient({ url: 'https://mcp.example.com/mcp', fetchImpl });
    await expect(c.connect()).rejects.toThrow(/Streamable HTTP 失败/);
    await expect(c.connect()).rejects.toThrow(/HTTP\+SSE 也失败/);
  });
});

describe('close', () => {
  it('关闭后不再接受连接（避免后台复用已死客户端）', async () => {
    const { fetchImpl } = streamableMock();
    const c: ReturnType<typeof createMcpClient> = createMcpClient({ url: 'https://mcp.example.com/mcp', fetchImpl });
    c.close();
    await expect(c.connect()).rejects.toThrow(/已关闭/);
  });
});

// 保证 McpClientOptions 的注入点在类型层可用（防止实现里悄悄改成全局 fetch）
const _typeCheck: Pick<McpClientOptions, 'fetchImpl'> = { fetchImpl: async () => fakeResp(null) };
void _typeCheck;
