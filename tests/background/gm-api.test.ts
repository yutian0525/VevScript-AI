// tests/background/gm-api.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { storage } from 'wxt/utils/storage';
import {
  gmErrorCounts, getErrorBuffer, clearErrors, getMenuSnapshot, handleGmCall,
} from '../../background/gm-api';
import { saveScript } from '../../storage/scripts';
import type { UserScript } from '../../shared/types';

// fakeBrowser 未内置 notifications API——本文件用例需要它，顶部统一挂 stub
(browser as unknown as Record<string, unknown>).notifications = { create: vi.fn(async () => 'id') };

function mkScript(over: Partial<UserScript> = {}): UserScript {
  return {
    id: 's1', text: '// ==UserScript==\n// @name t\n// @match https://a.com/*\n// @grant GM_setValue\n// ==/UserScript==\nx();',
    name: 't', enabled: true, matches: ['https://a.com/*'], code: 'x();',
    runAt: 'document_idle', world: 'USER_SCRIPT', source: 'user', createdAt: 1, updatedAt: 1,
    meta: { grants: ['GM_setValue'] }, ...over,
  };
}

/** 直接调用 handleGmCall（绕过消息层），sender 模拟来自 tab 1 */
async function call(api: string, params: unknown[], scriptId = 's1') {
  return handleGmCall({ scriptId, api, reqId: 1, params }, { tab: { id: 1, url: 'https://a.com/' } } as never);
}

describe('gm-api 值存储', () => {
  beforeEach(() => { fakeBrowser.reset(); vi.restoreAllMocks(); vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({} as never); });

  it('SetValue 落库 + 广播 GM_EVENT( VALUE_CHANGE )', async () => {
    await saveScript(mkScript());
    const spy = vi.spyOn(browser.tabs, 'sendMessage').mockResolvedValue(undefined as never);
    const r = await call('SetValue', ['k', 42]);
    expect(r).toEqual({ ok: true, data: null });
    const raw = await storage.getItem<Record<string, unknown>>('local:script-values:s1');
    expect(raw).toEqual({ k: 42 });
    expect(spy).toHaveBeenCalled();
  });

  it('GetValue 读库（桥侧兜底——正常路径走快照）', async () => {
    await storage.setItem('local:script-values:s1', { k: 'v' });
    const r = await call('GetValue', ['k']);
    expect(r).toEqual({ ok: true, data: 'v' });
  });

  it('DeleteValue 删键', async () => {
    await storage.setItem('local:script-values:s1', { k: 'v', k2: 2 });
    await call('DeleteValue', ['k']);
    const raw = await storage.getItem<Record<string, unknown>>('local:script-values:s1');
    expect(raw).toEqual({ k2: 2 });
  });

  it('grant 白名单：未 grant 的 API 拒绝', async () => {
    await saveScript(mkScript()); // 只 grant 了 GM_setValue
    const r = await call('GM_notification', [{}]);
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toContain('permission');
  });
});

describe('gm-api 错误缓冲', () => {
  beforeEach(() => { fakeBrowser.reset(); vi.restoreAllMocks(); vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({} as never); });

  it('ReportError 入环形缓冲（≤20）+ gmErrorCounts', async () => {
    await saveScript(mkScript());
    for (let i = 0; i < 25; i++) await call('ReportError', [`err${i}`, 'stack', i]);
    const buf = getErrorBuffer('s1');
    expect(buf).toHaveLength(20);
    expect(buf[0]!.message).toBe('err5'); // 丢最旧
    expect(gmErrorCounts()).toEqual({ s1: 20 });
  });

  it('clearErrors 清空', async () => {
    await saveScript(mkScript());
    await call('ReportError', ['e', 's', 1]);
    await clearErrors('s1');
    expect(getErrorBuffer('s1')).toEqual([]);
  });
});

describe('gm-api 菜单表', () => {
  beforeEach(() => { fakeBrowser.reset(); vi.restoreAllMocks(); vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({} as never); });

  it('RegisterMenu 落表；invokeMenuCommand 路由 MENU_CLICK 下行到注册来源 tab', async () => {
    await saveScript(mkScript({ meta: { grants: ['GM_registerMenuCommand'] } }));
    await call('RegisterMenu', ['m1', '抓取数据']);
    const snap = getMenuSnapshot();
    expect(snap).toEqual([{ scriptId: 's1', commands: [{ key: 'm1', name: '抓取数据' }] }]);

    const tabSpy = vi.spyOn(browser.tabs, 'sendMessage').mockResolvedValue(undefined as never);
    const { invokeMenuCommand } = await import('../../background/gm-api');
    await invokeMenuCommand('s1', 'm1');
    expect(tabSpy.mock.calls[0]![0]).toBe(1); // 发到注册来源 tab
    const payload = tabSpy.mock.calls[0]![1] as { type: string; scriptId: string; kind: string };
    expect(payload).toMatchObject({ type: 'GM_EVENT', scriptId: 's1', kind: 'MENU_CLICK' });
  });
});

describe('gm-api 简单 API', () => {
  beforeEach(() => { fakeBrowser.reset(); vi.restoreAllMocks(); vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({} as never); });

  it('OpenInTab：tabs.create + 返回 tabId；CloseTab：tabs.remove', async () => {
    await saveScript(mkScript({ meta: { grants: ['GM_openInTab'] } }));
    // fakeBrowser 的 tabs.remove 存在按 tab.id 查 window 的 bug（id≠windowId 即抛），
    // 且 reset 会种默认 tab——故与 tabs.test.ts 一致，spy create/remove 只断言调用本身
    const create = vi.spyOn(browser.tabs, 'create').mockResolvedValue({ id: 42 } as never);
    const remove = vi.spyOn(browser.tabs, 'remove').mockResolvedValue(undefined as never);
    const r = await call('OpenInTab', ['https://example.com/', { active: false }]);
    expect(r).toMatchObject({ ok: true, data: 42 });
    expect(create).toHaveBeenCalledWith({ url: 'https://example.com/', active: false });
    const r2 = await call('CloseTab', [42]);
    expect(r2).toMatchObject({ ok: true });
    expect(remove).toHaveBeenCalledWith(42);
  });

  it('SetClipboard 失败返回可读错误', async () => {
    await saveScript(mkScript({ meta: { grants: ['GM_setClipboard'] } }));
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => { throw new Error('denied'); }) } });
    const r = await call('SetClipboard', ['text']);
    expect(r).toMatchObject({ ok: false });
    vi.unstubAllGlobals();
  });

  it('XmlHttpRequest 占位：明确报错（Task 10 接入）', async () => {
    await saveScript(mkScript({ meta: { grants: ['GM_xmlhttpRequest'] } }));
    const r = await call('XmlHttpRequest', [{ url: 'https://x.com/' }]);
    expect(r).toMatchObject({ ok: false });
  });
});
