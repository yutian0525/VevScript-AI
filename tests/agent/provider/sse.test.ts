// tests/agent/provider/sse.test.ts
import { describe, it, expect } from 'vitest';
import { createSseParser } from '../../../agent/provider/sse';

describe('SSE 解析器', () => {
  it('解析单个完整 event', () => {
    const events: string[] = [];
    const parser = createSseParser((data) => events.push(data));
    parser.push('data: {"a":1}\n\n');
    parser.flush();
    expect(events).toEqual(['{"a":1}']);
  });

  it('跨 chunk 分割的事件能拼接', () => {
    const events: string[] = [];
    const parser = createSseParser((data) => events.push(data));
    parser.push('data: {"a');
    parser.push('rt":1}\n');
    parser.push('\n');
    parser.flush();
    expect(events).toEqual(['{"art":1}']);
  });

  it('多行 data 字段按规范拼接（\\n 连接）', () => {
    const events: string[] = [];
    const parser = createSseParser((data) => events.push(data));
    parser.push('data: line1\ndata: line2\n\n');
    parser.flush();
    expect(events).toEqual(['line1\nline2']);
  });

  it('忽略注释与 event/id 行，只回调 data', () => {
    const events: string[] = [];
    const parser = createSseParser((data) => events.push(data));
    parser.push(': comment\nid: 42\nevent: message\ndata: {"x":1}\n\n');
    parser.flush();
    expect(events).toEqual(['{"x":1}']);
  });

  it('[DONE] 不回调', () => {
    const events: string[] = [];
    const parser = createSseParser((data) => events.push(data));
    parser.push('data: [DONE]\n\n');
    parser.flush();
    expect(events).toEqual([]);
  });

  it('CRLF 换行兼容', () => {
    const events: string[] = [];
    const parser = createSseParser((data) => events.push(data));
    parser.push('data: {"a":1}\r\n\r\n');
    parser.flush();
    expect(events).toEqual(['{"a":1}']);
  });

  it('多事件 CRLF 流经 push 规范化正确切分', () => {
    const events: string[] = [];
    const parser = createSseParser((data) => events.push(data));
    parser.push('data: {"i":0}\r\n\r\ndata: {"i":1}\r\n\r\n');
    parser.flush();
    expect(events).toEqual(['{"i":0}', '{"i":1}']);
  });

  it('flush 处理无空行结尾的残留事件', () => {
    const events: string[] = [];
    const parser = createSseParser((data) => events.push(data));
    parser.push('data: {"a":1}');
    parser.flush();
    expect(events).toEqual(['{"a":1}']);
  });

  it('连续事件流不丢失不重复', () => {
    const events: string[] = [];
    const parser = createSseParser((data) => events.push(data));
    parser.push('data: {"i":0}\n\n');
    parser.push('data: {"i":1}\n\ndata: {"i":2}\n\n');
    parser.flush();
    expect(events.map((e) => JSON.parse(e).i)).toEqual([0, 1, 2]);
  });
});
