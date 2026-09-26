// tests/agent/mcp-sse.test.ts
// SSE 帧解析：两种 MCP HTTP 传输都用得到（streamable 可回 text/event-stream，
// sse 传输的 GET 流本身就是它）。解析必须容忍粘包/半包——扩展里读的是 chunk 流。
import { describe, it, expect } from 'vitest';
import { parseSseChunk, firstJsonRpcResponse } from '../../agent/mcp/sse';

describe('parseSseChunk', () => {
  it('解析单个事件（event + 单行 data）', () => {
    const { events, rest } = parseSseChunk('event: message\ndata: {"id":1}\n\n');
    expect(events).toEqual([{ event: 'message', data: '{"id":1}' }]);
    expect(rest).toBe('');
  });

  it('缺省事件名为 message（不写 event: 行）', () => {
    const { events } = parseSseChunk('data: hello\n\n');
    expect(events).toEqual([{ event: 'message', data: 'hello' }]);
  });

  it('多行 data 用 \\n 拼接（JSON 被拆成多行是常态）', () => {
    const raw = 'data: {"jsonrpc":"2.0",\ndata: "id":1}\n\n';
    expect(parseSseChunk(raw).events[0]!.data).toBe('{"jsonrpc":"2.0",\n"id":1}');
  });

  it('data 值前导空格只削一个（规范：冒号后一个空格属分隔）', () => {
    const { events } = parseSseChunk('data:  a b\n\n');
    expect(events[0]!.data).toBe(' a b');
  });

  it('一次给两事件 → 都吐出来', () => {
    const raw = 'event: endpoint\ndata: /messages?sessionId=1\n\nevent: message\ndata: {}\n\n';
    const { events } = parseSseChunk(raw);
    expect(events.map((e) => e.event)).toEqual(['endpoint', 'message']);
  });

  it('半包（末尾无空行）留在 rest 里等下一 chunk', () => {
    const { events, rest } = parseSseChunk('data: ok\n\ndata: partial');
    expect(events).toHaveLength(1);
    expect(rest).toBe('data: partial');
  });

  it('CRLF 换行同样成立', () => {
    const { events, rest } = parseSseChunk('event: message\r\ndata: x\r\n\r\n');
    expect(events).toEqual([{ event: 'message', data: 'x' }]);
    expect(rest).toBe('');
  });

  it('注释行（: 开头）忽略', () => {
    const { events } = parseSseChunk(': keep-alive\ndata: x\n\n');
    expect(events).toEqual([{ event: 'message', data: 'x' }]);
  });

  it('带 id 的事件保留 id', () => {
    const { events } = parseSseChunk('id: 7\ndata: x\n\n');
    expect(events[0]!.id).toBe('7');
  });

  it('无 data 的空块不产出事件', () => {
    const { events } = parseSseChunk('event: ping\n\n');
    expect(events).toHaveLength(0);
  });
});

describe('firstJsonRpcResponse', () => {
  it('跳过 endpoint 事件，取第一个 JSON-RPC 响应', () => {
    const { events } = parseSseChunk(
      'event: endpoint\ndata: /messages?sessionId=abc\n\nevent: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\n\n',
    );
    const r = firstJsonRpcResponse(events);
    expect(r).toEqual({ id: 1, result: { tools: [] } });
  });

  it('认 error 响应', () => {
    const { events } = parseSseChunk('data: {"jsonrpc":"2.0","id":2,"error":{"code":-32601,"message":"no such method"}}\n\n');
    const r = firstJsonRpcResponse(events);
    expect(r?.error?.message).toBe('no such method');
  });

  it('既无 result 也无 error（如通知回执）→ undefined', () => {
    const { events } = parseSseChunk('data: {"jsonrpc":"2.0","id":3}\n\n');
    expect(firstJsonRpcResponse(events)).toBeUndefined();
  });

  it('非 JSON 的 data 跳过，不把整条流判死', () => {
    const { events } = parseSseChunk('data: not json\n\ndata: {"jsonrpc":"2.0","id":4,"result":{}}\n\n');
    expect(firstJsonRpcResponse(events)?.id).toBe(4);
  });
});
