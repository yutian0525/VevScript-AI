// tests/background/cdp-domains.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { enableAll, handleEvent, __resetCdpDomains } from '../../background/cdp/domains';
import { initCdpSession, rememberSession, __resetCdpSession } from '../../background/cdp/session';
import { resetStore, readConsole, readNetworkList, getCdpEntry } from '../../background/observe-store';

let commands: Array<{ method: string; params?: Record<string, unknown>; sessionId?: string }>;
let bodyReply: { body: string; base64Encoded: boolean } | null;

beforeEach(() => {
  fakeBrowser.reset();
  resetStore();
  __resetCdpSession();
  __resetCdpDomains();
  commands = [];
  bodyReply = null;
  (fakeBrowser as unknown as { debugger: unknown }).debugger = {
    sendCommand: (async (target: { sessionId?: string }, method: string, params?: Record<string, unknown>) => {
      commands.push({ method, params, sessionId: target.sessionId });
      if (method === 'Network.getResponseBody') return bodyReply ?? (() => { throw new Error('gone'); })();
      return {};
    }) as never,
  };
  initCdpSession({ enableDomains: enableAll, onStateChange: () => {} });
});

describe('enableAll', () => {
  it('启用四域并 setAutoAttach（waitForDebuggerOnStart 必须为 false）', async () => {
    await enableAll(1);
    const methods = commands.map((c) => c.method);
    expect(methods).toEqual([
      'Network.enable', 'Runtime.enable', 'Log.enable', 'Page.enable', 'Target.setAutoAttach',
    ]);
    const auto = commands.find((c) => c.method === 'Target.setAutoAttach')!;
    expect(auto.params).toEqual({ autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  });
});

describe('handleEvent：网络', () => {
  it('requestWillBeSent → responseReceived → loadingFinished 全链路', async () => {
    await handleEvent(1, undefined, 'Network.requestWillBeSent', {
      requestId: 'c1', timestamp: 1, wallTime: 1000,
      request: { url: 'https://x.com/api', method: 'POST', headers: { a: '1' }, postData: '{"q":1}' },
      type: 'XHR',
    });
    await handleEvent(1, undefined, 'Network.responseReceived', {
      requestId: 'c1', response: { status: 200, headers: { 'content-type': 'application/json' }, mimeType: 'application/json' },
    });
    bodyReply = { body: '{"ok":1}', base64Encoded: false };
    await handleEvent(1, undefined, 'Network.loadingFinished', { requestId: 'c1', timestamp: 1.5 });
    const list = readNetworkList(1, {});
    expect(list[0]!).toMatchObject({ requestId: 'cdp:c1', method: 'POST', status: 200, hasBody: true });
    expect(getCdpEntry(1, 'c1')!.responseBody).toBe('{"ok":1}');
  });

  it('白名单外类型不拉响应体', async () => {
    await handleEvent(1, undefined, 'Network.requestWillBeSent', {
      requestId: 'i1', timestamp: 1, request: { url: 'https://x.com/a.png', method: 'GET', headers: {} }, type: 'Image',
    });
    await handleEvent(1, undefined, 'Network.responseReceived', {
      requestId: 'i1', response: { status: 200, headers: {}, mimeType: 'image/png' },
    });
    commands.length = 0;
    await handleEvent(1, undefined, 'Network.loadingFinished', { requestId: 'i1', timestamp: 2 });
    expect(commands.map((c) => c.method)).not.toContain('Network.getResponseBody');
  });

  it('loadingFailed → 错误落库', async () => {
    await handleEvent(1, undefined, 'Network.requestWillBeSent', {
      requestId: 'e1', timestamp: 1, request: { url: 'https://x.com/b', method: 'GET', headers: {} }, type: 'Fetch',
    });
    await handleEvent(1, undefined, 'Network.loadingFailed', { requestId: 'e1', timestamp: 2, errorText: 'net::ERR_FAILED' });
    expect(getCdpEntry(1, 'e1')!.error).toBe('net::ERR_FAILED');
  });

  it('WS 帧挂到握手条目', async () => {
    await handleEvent(1, undefined, 'Network.requestWillBeSent', {
      requestId: 'w1', timestamp: 1, request: { url: 'wss://x.com/s', method: 'GET', headers: {} }, type: 'WebSocket',
    });
    await handleEvent(1, undefined, 'Network.webSocketFrameSent', {
      requestId: 'w1', timestamp: 2, response: { opcode: 1, payloadData: 'ping' },
    });
    await handleEvent(1, undefined, 'Network.webSocketFrameReceived', {
      requestId: 'w1', timestamp: 3, response: { opcode: 1, payloadData: 'pong' },
    });
    expect(getCdpEntry(1, 'w1')!.wsFrames).toEqual([
      { dir: 'sent', opcode: 1, payload: 'ping', ts: expect.any(Number) },
      { dir: 'received', opcode: 1, payload: 'pong', ts: expect.any(Number) },
    ]);
  });
});

describe('handleEvent：浏览器补全头（ExtraInfo）', () => {
  // requestWillBeSent / responseReceived 只带渲染进程提供的子集；
  // Cookie、User-Agent、Origin、Referer、Sec-Fetch-*、Set-Cookie 只出现在 ExtraInfo 里。
  it('requestWillBeSentExtraInfo 后到 → 并入已有条目', async () => {
    await handleEvent(1, undefined, 'Network.requestWillBeSent', {
      requestId: 'x1', timestamp: 1,
      request: { url: 'https://x.com/api', method: 'GET', headers: { 'x-app': '1' } }, type: 'XHR',
    });
    await handleEvent(1, undefined, 'Network.requestWillBeSentExtraInfo', {
      requestId: 'x1', headers: { cookie: 'sid=1', 'user-agent': 'UA' },
      associatedCookies: [], connectTiming: {},
    });
    expect(getCdpEntry(1, 'x1')!.requestHeaders).toEqual({
      'x-app': '1', cookie: 'sid=1', 'user-agent': 'UA',
    });
  });

  it('responseReceivedExtraInfo 后到 → 并入已有条目（Set-Cookie 可见）', async () => {
    await handleEvent(1, undefined, 'Network.requestWillBeSent', {
      requestId: 'x1b', timestamp: 1, request: { url: 'https://x.com/a', method: 'GET', headers: {} }, type: 'XHR',
    });
    await handleEvent(1, undefined, 'Network.responseReceived', {
      requestId: 'x1b', response: { status: 200, headers: { 'content-type': 'text/html' }, mimeType: 'text/html' },
    });
    await handleEvent(1, undefined, 'Network.responseReceivedExtraInfo', {
      requestId: 'x1b', headers: { 'set-cookie': 'sid=1' }, statusCode: 200, blockedCookies: [],
    });
    expect(getCdpEntry(1, 'x1b')!.responseHeaders).toEqual({
      'content-type': 'text/html', 'set-cookie': 'sid=1',
    });
  });

  it('ExtraInfo 先到 → 暂存，配对事件建条目时套用（不假设先后）', async () => {
    await handleEvent(1, undefined, 'Network.responseReceivedExtraInfo', {
      requestId: 'x2', headers: { 'set-cookie': 'sid=2' }, statusCode: 200, blockedCookies: [],
    });
    await handleEvent(1, undefined, 'Network.requestWillBeSent', {
      requestId: 'x2', timestamp: 1, request: { url: 'https://x.com/a', method: 'GET', headers: {} }, type: 'XHR',
    });
    await handleEvent(1, undefined, 'Network.responseReceived', {
      requestId: 'x2', response: { status: 200, headers: { 'content-type': 'text/html' }, mimeType: 'text/html' },
    });
    expect(getCdpEntry(1, 'x2')!.responseHeaders).toEqual({
      'content-type': 'text/html', 'set-cookie': 'sid=2',
    });
  });

  it('同名头以 ExtraInfo（浏览器完整集）为准', async () => {
    await handleEvent(1, undefined, 'Network.requestWillBeSent', {
      requestId: 'x3', timestamp: 1,
      request: { url: 'https://x.com/a', method: 'GET', headers: { accept: 'renderer' } }, type: 'XHR',
    });
    await handleEvent(1, undefined, 'Network.requestWillBeSentExtraInfo', {
      requestId: 'x3', headers: { accept: 'browser' }, associatedCookies: [], connectTiming: {},
    });
    expect(getCdpEntry(1, 'x3')!.requestHeaders!.accept).toBe('browser');
  });

  it('暂存的 ExtraInfo 被消费后不重复套用到后来的同名 requestId', async () => {
    await handleEvent(1, undefined, 'Network.requestWillBeSentExtraInfo', {
      requestId: 'x4', headers: { cookie: 'stale=1' }, associatedCookies: [], connectTiming: {},
    });
    await handleEvent(1, undefined, 'Network.requestWillBeSent', {
      requestId: 'x4', timestamp: 1, request: { url: 'https://x.com/a', method: 'GET', headers: {} }, type: 'XHR',
    });
    expect(getCdpEntry(1, 'x4')!.requestHeaders).toEqual({ cookie: 'stale=1' });
    await handleEvent(1, undefined, 'Network.requestWillBeSent', {
      requestId: 'x5', timestamp: 2, request: { url: 'https://x.com/b', method: 'GET', headers: {} }, type: 'XHR',
    });
    expect(getCdpEntry(1, 'x5')!.requestHeaders).toEqual({}); // 只有渲染进程子集，无暂存残留
  });
});

describe('handleEvent：console', () => {
  it('consoleAPICalled → 摄入，级别映射 warning→warn', async () => {
    await handleEvent(1, undefined, 'Runtime.consoleAPICalled', {
      type: 'warning', timestamp: 1, args: [{ type: 'string', value: 'careful' }],
    });
    const msgs = readConsole(1, {});
    expect(msgs[0]!).toMatchObject({ level: 'warn', text: 'careful' });
  });

  it('exceptionThrown → error 级 console 条目', async () => {
    await handleEvent(1, undefined, 'Runtime.exceptionThrown', {
      timestamp: 1,
      exceptionDetails: { text: 'Uncaught', exception: { description: 'Error: boom' } },
    });
    expect(readConsole(1, { level: 'error' })[0]!.text).toBe('Uncaught Error: boom');
  });

  it('Log.entryAdded → 摄入（CSP 违规等浏览器级条目）', async () => {
    await handleEvent(1, undefined, 'Log.entryAdded', {
      entry: { source: 'security', level: 'error', text: 'Refused to load the script', url: 'https://x.com/' },
    });
    expect(readConsole(1, { level: 'error' })[0]!.text).toBe('Refused to load the script');
  });
});

describe('handleEvent：子 target 路由', () => {
  it('attachedToTarget → 记映射 + 对子 session 单独 enable（不再 setAutoAttach）', async () => {
    await handleEvent(1, undefined, 'Target.attachedToTarget', { sessionId: 's1', targetInfo: { type: 'iframe' } });
    expect(commands.map((c) => c.method)).toEqual(['Network.enable', 'Runtime.enable', 'Log.enable']);
    expect(commands.every((c) => c.sessionId === 's1')).toBe(true);
  });

  it('子 session 的事件按 sessionId 归到所属 tab', async () => {
    rememberSession(3, 's9');
    await handleEvent(3, 's9', 'Runtime.consoleAPICalled', {
      type: 'log', timestamp: 1, args: [{ type: 'string', value: 'from-iframe' }],
    });
    expect(readConsole(3, {})[0]!.text).toBe('from-iframe');
  });
});
