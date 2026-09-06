import { describe, it, expect, beforeEach } from 'vitest';
import {
  resetStore, ingestConsole, ingestHookNet,
  recordRequestStart, recordRequestEnd, recordRequestError,
  readConsole, readNetworkList, readNetworkDetail, clearTab, clearTabNetwork,
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
    expect(list[0]!).toMatchObject({ requestId: 'r1', status: 200, durationMs: 50, hasBody: false });
  });

  it('onErrorOccurred 记录错误', () => {
    recordRequestStart(1, { requestId: 'r2', method: 'GET', url: 'https://x.com/b', type: 'image', ts: 10 });
    recordRequestError('r2', { error: 'net::ERR_FAILED', ts: 20 });
    const d = readNetworkDetail(1, 'r2');
    expect(d).toBeDefined();
    expect((d as { error?: string }).error).toBe('net::ERR_FAILED');
  });

  it('过滤 method / urlContains / status', () => {
    recordRequestStart(1, { requestId: 'a', method: 'GET', url: 'https://x.com/users', type: 'xmlhttprequest', ts: 1 });
    recordRequestEnd('a', { status: 200, ts: 2 });
    recordRequestStart(1, { requestId: 'b', method: 'POST', url: 'https://x.com/login', type: 'xmlhttprequest', ts: 3 });
    recordRequestEnd('b', { status: 401, ts: 4 });
    expect(readNetworkList(1, { method: 'POST' }).map((r) => r.requestId)).toEqual(['b']);
    expect(readNetworkList(1, { urlContains: 'users' }).map((r) => r.requestId)).toEqual(['a']);
    expect(readNetworkList(1, { status: 401 }).map((r) => r.requestId)).toEqual(['b']);
  });
});

describe('network 缓冲：hook body 关联', () => {
  it('hook body 按 method+url+时间窗关联到 webRequest 条目', () => {
    recordRequestStart(1, { requestId: 'r1', method: 'POST', url: 'https://x.com/api', type: 'xmlhttprequest', ts: 1000 });
    recordRequestEnd('r1', { status: 200, ts: 1100 });
    ingestHookNet(1, [{ loadNonce: 'n1', seq: 1, method: 'POST', url: 'https://x.com/api', ts: 1050, endTs: 1090, status: 200, responseBody: '{"ok":1}', requestBody: '{"q":1}' }]);
    const list = readNetworkList(1, {});
    expect(list).toHaveLength(1);        // 关联进同一条，不新增
    expect(list[0]!.hasBody).toBe(true);
    const d = readNetworkDetail(1, 'r1') as { responseBody?: string; source?: string };
    expect(d.responseBody).toBe('{"ok":1}');
    expect(d.source).toBe('merged');
  });

  it('关联不上（时间窗外）→ 作独立 hook 条目保留', () => {
    recordRequestStart(1, { requestId: 'r1', method: 'GET', url: 'https://x.com/api', type: 'xmlhttprequest', ts: 1000 });
    ingestHookNet(1, [{ loadNonce: 'n1', seq: 5, method: 'GET', url: 'https://x.com/api', ts: 9000, responseBody: 'late' }]);
    const list = readNetworkList(1, {});
    expect(list).toHaveLength(2); // r1 + 独立 hook 条目
    const hook = list.find((r) => r.requestId.startsWith('hook:'));
    expect(hook).toBeDefined();
  });

  it('同一 hook 条目双投递（backlog flush + live）按 loadNonce:seq 去重', () => {
    const e = { loadNonce: 'n1', seq: 3, method: 'GET', url: 'https://x.com/dup', ts: 5000, responseBody: 'x' };
    ingestHookNet(1, [e]);
    ingestHookNet(1, [e]); // 重复投递
    const list = readNetworkList(1, {});
    expect(list.filter((r) => r.url === 'https://x.com/dup')).toHaveLength(1);
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
