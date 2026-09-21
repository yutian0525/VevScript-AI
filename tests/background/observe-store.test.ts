import { describe, it, expect, beforeEach } from 'vitest';
import {
  resetStore, ingestConsole,
  recordRequestStart, recordRequestEnd, recordRequestError,
  readConsole, readNetworkList, readNetworkDetail, clearTab, clearTabNetwork,
  setNetworkSuppressor, ingestCdpStart, ingestCdpResponse, ingestCdpEnd,
  ingestCdpError, ingestCdpWsFrame, getCdpEntry, setCdpBody, ingestCdpExtraHeaders,
} from '../../background/observe-store';

beforeEach(() => resetStore());

describe('console 缓冲', () => {
  it('ingest + read（倒序、limit）', () => {
    ingestConsole(1, [{ id: '0:1', level: 'log', text: 'a', ts: 1 }, { id: '0:2', level: 'error', text: 'b', ts: 2 }]);
    const r = readConsole(1, {});
    expect(r.map((m) => m.text)).toEqual(['b', 'a']); // 最新在前
  });

  it('level 过滤', () => {
    ingestConsole(1, [{ id: '0:1', level: 'log', text: 'a', ts: 1 }, { id: '0:2', level: 'error', text: 'b', ts: 2 }]);
    expect(readConsole(1, { level: 'error' }).map((m) => m.text)).toEqual(['b']);
  });

  it('按 id 去重（backlog flush 重复不叠加）', () => {
    ingestConsole(1, [{ id: '0:1', level: 'log', text: 'a', ts: 1 }]);
    ingestConsole(1, [{ id: '0:1', level: 'log', text: 'a', ts: 1 }]);
    expect(readConsole(1, {})).toHaveLength(1);
  });

  it('环形上限 200 淘汰最早', () => {
    const entries = Array.from({ length: 250 }, (_, i) => ({ id: `0:${i}`, level: 'log', text: `m${i}`, ts: i }));
    ingestConsole(1, entries);
    const r = readConsole(1, { limit: 1000 });
    expect(r).toHaveLength(200);
    expect(r[r.length - 1]!.text).toBe('m50'); // m0..m49 被淘汰
  });
});

describe('network 缓冲：webRequest 主干', () => {
  it('start→end 建条目并补 status/duration', () => {
    recordRequestStart(1, { requestId: 'r1', method: 'GET', url: 'https://x.com/a', type: 'xmlhttprequest', ts: 100 });
    recordRequestEnd('r1', { status: 200, ts: 150 });
    const list = readNetworkList(1, {});
    expect(list).toHaveLength(1);
    expect(list[0]!).toMatchObject({ requestId: 'wr:r1', status: 200, durationMs: 50, hasBody: false });
  });

  it('onErrorOccurred 记录错误', () => {
    recordRequestStart(1, { requestId: 'r2', method: 'GET', url: 'https://x.com/b', type: 'image', ts: 10 });
    recordRequestError('r2', { error: 'net::ERR_FAILED', ts: 20 });
    const d = readNetworkDetail(1, 'wr:r2');
    expect(d).toBeDefined();
    expect((d as { error?: string }).error).toBe('net::ERR_FAILED');
  });

  it('过滤 method / urlContains / status', () => {
    recordRequestStart(1, { requestId: 'a', method: 'GET', url: 'https://x.com/users', type: 'xmlhttprequest', ts: 1 });
    recordRequestEnd('a', { status: 200, ts: 2 });
    recordRequestStart(1, { requestId: 'b', method: 'POST', url: 'https://x.com/login', type: 'xmlhttprequest', ts: 3 });
    recordRequestEnd('b', { status: 401, ts: 4 });
    expect(readNetworkList(1, { method: 'POST' }).map((r) => r.requestId)).toEqual(['wr:b']);
    expect(readNetworkList(1, { urlContains: 'users' }).map((r) => r.requestId)).toEqual(['wr:a']);
    expect(readNetworkList(1, { status: 401 }).map((r) => r.requestId)).toEqual(['wr:b']);
  });
});

describe('清理', () => {
  it('clearTab 清 console+network', () => {
    ingestConsole(1, [{ id: '0:1', level: 'log', text: 'a', ts: 1 }]);
    recordRequestStart(1, { requestId: 'r1', method: 'GET', url: 'https://x.com', type: 'document', ts: 1 });
    clearTab(1);
    expect(readConsole(1, {})).toHaveLength(0);
    expect(readNetworkList(1, {})).toHaveLength(0);
  });

  it('clearTabNetwork 只清 network（main_frame 导航语义）', () => {
    ingestConsole(1, [{ id: '0:1', level: 'log', text: 'a', ts: 1 }]);
    recordRequestStart(1, { requestId: 'r1', method: 'GET', url: 'https://x.com', type: 'document', ts: 1 });
    clearTabNetwork(1);
    expect(readConsole(1, {})).toHaveLength(1);
    expect(readNetworkList(1, {})).toHaveLength(0);
  });
});

describe('network 缓冲：CDP 数据源', () => {
  it('ingest 全链路建条目，id 带 cdp: 前缀', () => {
    ingestCdpStart(1, { requestId: 'c1', method: 'POST', url: 'https://x.com/api', type: 'XHR', ts: 100, requestHeaders: { a: '1' }, requestBody: '{"q":1}' });
    ingestCdpResponse(1, { requestId: 'c1', status: 200, responseHeaders: { 'content-type': 'application/json' }, mimeType: 'application/json' });
    ingestCdpEnd(1, { requestId: 'c1', ts: 160 });
    const list = readNetworkList(1, {});
    expect(list[0]!).toMatchObject({ requestId: 'cdp:c1', status: 200, durationMs: 60, hasBody: true });
  });

  it('setCdpBody 落库并标 truncated', () => {
    ingestCdpStart(1, { requestId: 'c2', method: 'GET', url: 'https://x.com/a', type: 'Fetch', ts: 1 });
    setCdpBody(1, 'c2', { body: '{"ok":1}', truncated: false });
    expect(getCdpEntry(1, 'c2')!.responseBody).toBe('{"ok":1}');
  });

  it('ingestCdpError 记录错误', () => {
    ingestCdpStart(1, { requestId: 'c3', method: 'GET', url: 'https://x.com/b', type: 'XHR', ts: 1 });
    ingestCdpError(1, { requestId: 'c3', error: 'net::ERR_FAILED', ts: 9 });
    expect(getCdpEntry(1, 'c3')!.error).toBe('net::ERR_FAILED');
  });

  it('WS 帧挂到握手条目，超上限淘汰最早', () => {
    ingestCdpStart(1, { requestId: 'w1', method: 'GET', url: 'wss://x.com/s', type: 'WebSocket', ts: 1 });
    for (let i = 0; i < 210; i++) {
      ingestCdpWsFrame(1, { requestId: 'w1', dir: 'sent', opcode: 1, payload: `f${i}`, ts: i });
    }
    const frames = getCdpEntry(1, 'w1')!.wsFrames!;
    expect(frames).toHaveLength(200);
    expect(frames[frames.length - 1]!.payload).toBe('f209');
    expect(frames[0]!.payload).toBe('f10');
  });

  it('WS 单帧 payload 截断', () => {
    ingestCdpStart(1, { requestId: 'w2', method: 'GET', url: 'wss://x.com/s', type: 'WebSocket', ts: 1 });
    ingestCdpWsFrame(1, { requestId: 'w2', dir: 'received', opcode: 1, payload: 'y'.repeat(5000), ts: 1 });
    expect(getCdpEntry(1, 'w2')!.wsFrames![0]!.payload).toHaveLength(4096);
  });

  it('clearTab 一并清掉该 tab 暂存的 ExtraInfo 头（不跨 tab 生命期残留）', () => {
    ingestCdpExtraHeaders(1, 'p1', { requestHeaders: { cookie: 'stale=1' } });
    clearTab(1);
    ingestCdpStart(1, { requestId: 'p1', method: 'GET', url: 'https://x.com/a', type: 'XHR', ts: 1 });
    expect(getCdpEntry(1, 'p1')!.requestHeaders).toBeUndefined();
  });

  it('wr: 与 cdp: 前缀不撞号', () => {
    recordRequestStart(1, { requestId: 'same', method: 'GET', url: 'https://x.com/1', type: 'xmlhttprequest', ts: 1 });
    ingestCdpStart(1, { requestId: 'same', method: 'GET', url: 'https://x.com/2', type: 'XHR', ts: 2 });
    const ids = readNetworkList(1, {}).map((r) => r.requestId);
    expect(ids).toContain('wr:same');
    expect(ids).toContain('cdp:same');
  });

  it('抑制开启时 webRequest 三入口全部不落库', () => {
    setNetworkSuppressor((tabId) => tabId === 1);
    recordRequestStart(1, { requestId: 'r9', method: 'GET', url: 'https://x.com/z', type: 'xmlhttprequest', ts: 1 });
    recordRequestEnd('r9', { status: 200, ts: 2 });
    recordRequestError('r9', { error: 'x', ts: 3 });
    expect(readNetworkList(1, {})).toHaveLength(0);
    // 未抑制的 tab 不受影响
    recordRequestStart(2, { requestId: 'r10', method: 'GET', url: 'https://x.com/y', type: 'xmlhttprequest', ts: 1 });
    expect(readNetworkList(2, {})).toHaveLength(1);
    setNetworkSuppressor(() => false);
  });
});
