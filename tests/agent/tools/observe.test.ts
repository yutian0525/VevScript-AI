import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { doListConsoleMessages, doListNetworkRequests, doGetNetworkRequest } from '../../../agent/tools/observe';
import { resetStore, ingestConsole, recordRequestStart, recordRequestEnd, ingestHookNet } from '../../../background/observe-store';
import { saveSettings } from '../../../storage/settings';

describe('观测三工具', () => {
  beforeEach(async () => { fakeBrowser.reset(); resetStore(); await saveSettings({ agent: { networkCaptureHeaders: 'redacted' } }); });

  it('list_console_messages 返回倒序 + level 过滤', async () => {
    ingestConsole(1, [{ id: '0:1', level: 'log', text: 'a', ts: 1 }, { id: '0:2', level: 'error', text: 'b', ts: 2 }]);
    const r = await doListConsoleMessages(1, { level: 'error' });
    expect(r.ok).toBe(true);
    const msgs = (r as { data: { messages: Array<{ text: string }> } }).data.messages;
    expect(msgs.map((m) => m.text)).toEqual(['b']);
  });

  it('list_console_messages 空缓冲返回空数组（不报错）', async () => {
    const r = await doListConsoleMessages(999, {});
    expect(r.ok).toBe(true);
    expect((r as { data: { messages: unknown[] } }).data.messages).toEqual([]);
  });

  it('list_network_requests 返回摘要（含 hasBody）', async () => {
    recordRequestStart(1, { requestId: 'r1', method: 'GET', url: 'https://x.com/a', type: 'xmlhttprequest', ts: 100 });
    recordRequestEnd('r1', { status: 200, ts: 150 });
    const r = await doListNetworkRequests(1, {});
    const list = (r as { data: { requests: Array<{ requestId: string; hasBody: boolean; durationMs?: number }> } }).data.requests;
    expect(list[0]!).toMatchObject({ requestId: 'r1', hasBody: false, durationMs: 50 });
  });

  it('get_network_request 默认脱敏敏感头', async () => {
    recordRequestStart(1, { requestId: 'r1', method: 'POST', url: 'https://x.com/api', type: 'xmlhttprequest', ts: 100 });
    ingestHookNet(1, [{ loadNonce: 'n1', seq: 1, method: 'POST', url: 'https://x.com/api', ts: 120, requestHeaders: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' }, responseBody: '{"ok":1}' }]);
    const r = await doGetNetworkRequest(1, { requestId: 'r1' });
    const d = (r as { data: { requestHeaders?: Record<string, string>; responseBody?: string } }).data;
    expect(d.requestHeaders!.authorization).toBe('[REDACTED]');
    expect(d.requestHeaders!['content-type']).toBe('application/json');
    expect(d.responseBody).toBe('{"ok":1}');
  });

  it('get_network_request full 模式原样返回敏感头', async () => {
    await saveSettings({ agent: { networkCaptureHeaders: 'full' } });
    recordRequestStart(1, { requestId: 'r1', method: 'GET', url: 'https://x.com/api', type: 'xmlhttprequest', ts: 100 });
    ingestHookNet(1, [{ loadNonce: 'n1', seq: 1, method: 'GET', url: 'https://x.com/api', ts: 120, requestHeaders: { Authorization: 'Bearer secret' } }]);
    const r = await doGetNetworkRequest(1, { requestId: 'r1' });
    const d = (r as { data: { requestHeaders?: Record<string, string> } }).data;
    expect(d.requestHeaders!.authorization).toBe('Bearer secret');
  });

  it('get_network_request 未知 id 报错', async () => {
    const r = await doGetNetworkRequest(1, { requestId: 'nope' });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('预期失败结果');
    expect(r.error).toContain('未找到');
  });

  it('get_network_request 缺 requestId 报错', async () => {
    const r = await doGetNetworkRequest(1, { requestId: '' });
    expect(r.ok).toBe(false);
  });
});
