// tests/agent/observe-degrade.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  doListConsoleMessages, doListNetworkRequests, doGetNetworkRequest,
} from '../../agent/tools/observe';
import { initCdpSession, __resetCdpSession } from '../../background/cdp/session';
import { resetStore, recordRequestStart } from '../../background/observe-store';

beforeEach(() => {
  fakeBrowser.reset();
  resetStore();
  __resetCdpSession();
  (fakeBrowser as unknown as { debugger: unknown }).debugger = {
    attach: (async () => {}) as never, detach: (async () => {}) as never,
    sendCommand: (async () => ({})) as never, getTargets: (async () => []) as never,
  };
});

describe('CDP 关闭时的降级语义', () => {
  it('list_console_messages 返回空 + deepObserve:false + hint', async () => {
    const r = await doListConsoleMessages(1, {});
    expect(r.ok).toBe(true);
    const d = (r as { data: { messages: unknown[]; deepObserve: boolean; hint?: string } }).data;
    expect(d.messages).toEqual([]);
    expect(d.deepObserve).toBe(false);
    expect(d.hint).toContain('toggle_deep_observe');
  });

  it('list_network_requests 仍返回 webRequest 元数据 + deepObserve:false', async () => {
    recordRequestStart(1, { requestId: 'r1', method: 'GET', url: 'https://x.com/a', type: 'xmlhttprequest', ts: 1 });
    const r = await doListNetworkRequests(1, {});
    const d = (r as { data: { requests: unknown[]; deepObserve: boolean } }).data;
    expect(d.requests).toHaveLength(1);
    expect(d.deepObserve).toBe(false);
  });

  it('get_network_request 对无 body 条目附 hint', async () => {
    recordRequestStart(1, { requestId: 'r1', method: 'GET', url: 'https://x.com/a', type: 'xmlhttprequest', ts: 1 });
    const r = await doGetNetworkRequest(1, { requestId: 'wr:r1' });
    const d = (r as { data: { deepObserve: boolean; hint?: string } }).data;
    expect(d.deepObserve).toBe(false);
    expect(d.hint).toContain('toggle_deep_observe');
  });
});

describe('CDP 开启时不加 hint', () => {
  it('deepObserve:true 且无 hint', async () => {
    initCdpSession({ enableDomains: async () => {}, onStateChange: () => {} });
    (fakeBrowser as unknown as { debugger: { attach: unknown } }).debugger.attach = (async () => {}) as never;
    const { attach } = await import('../../background/cdp/session');
    await attach(1);
    const r = await doListConsoleMessages(1, {});
    const d = (r as { data: { deepObserve: boolean; hint?: string } }).data;
    expect(d.deepObserve).toBe(true);
    expect(d.hint).toBeUndefined();
  });
});
