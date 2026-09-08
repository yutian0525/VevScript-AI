// tests/background/gm-api.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { storage } from 'wxt/utils/storage';
import {
  gmErrorCounts, getErrorBuffer, clearErrors, getMenuSnapshot, handleGmCall,
  initGmApi, cleanupScriptState, readValuesForSnapshot,
  __setLlmProviderFactory, __resetLlmSession,
} from '../../background/gm-api';
import { __resetConfirmQueue, getPending, resolveConfirm } from '../../background/confirm-queue';
import { setLlmTier } from '../../background/gm-permissions';
import { saveScript } from '../../storage/scripts';
import type { UserScript } from '../../shared/types';
import type { StreamEvent } from '../../agent/provider/types';

// fakeBrowser 未内置 notifications API——本文件用例需要它，顶部统一挂 stub
(browser as unknown as Record<string, unknown>).notifications = { create: vi.fn(async () => 'id') };

import offscreenMainSrc from '../../entrypoints/offscreen-clipboard/main.ts?raw';

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

  it('SetValue：sender.url 缺失时 tabs.get 兜底，本地 VALUE_CHANGE 事件不丢', async () => {
    await saveScript(mkScript());
    // 模拟 Chrome 实测行为：sender 只有 tab.id，url 未填；tabs.get 能查到 url
    vi.spyOn(browser.tabs, 'get').mockResolvedValue({ id: 1, url: 'https://a.com/' } as never);
    const spy = vi.spyOn(browser.tabs, 'sendMessage').mockResolvedValue(undefined as never);
    await handleGmCall(
      { scriptId: 's1', api: 'SetValue', reqId: 1, params: ['k3', 'x'] },
      { tab: { id: 1 } } as never,
    );
    const local = spy.mock.calls.find((c) => c[0] === 1);
    expect(local).toBeDefined();
    const payload = local![1] as { type: string; kind: string; data: { remote: boolean } };
    expect(payload).toMatchObject({ type: 'GM_EVENT', kind: 'VALUE_CHANGE' });
    expect(payload.data.remote).toBe(false); // 发起 tab 自己收到的必须是本地事件
  });

  it('SetValue：sender.url 与 tabs.get 都拿不到 → 仍广播到其它匹配 tab（发起 tab 不进 targets）', async () => {
    await saveScript(mkScript({ id: 's2', matches: ['https://b.com/*'] }));
    vi.spyOn(browser.tabs, 'get').mockRejectedValue(new Error('no tab'));
    await fakeBrowser.tabs.create({ url: 'https://b.com/page' });
    const spy = vi.spyOn(browser.tabs, 'sendMessage').mockResolvedValue(undefined as never);
    await handleGmCall(
      { scriptId: 's2', api: 'SetValue', reqId: 1, params: ['k', 1] },
      { tab: { id: 99 } } as never,
    );
    // 匹配的 b.com tab 收到 remote=true 事件；不匹配的发起 tab（99）不收
    expect(spy.mock.calls.some((c) => c[0] !== 99)).toBe(true);
    expect(spy.mock.calls.every((c) => c[0] !== 99)).toBe(true);
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

  it('CloseTab：非法 tabId（undefined/非整数）直接回可读错误，不调 tabs.remove', async () => {
    await saveScript(mkScript({ meta: { grants: ['GM_openInTab'] } }));
    const remove = vi.spyOn(browser.tabs, 'remove').mockResolvedValue(undefined as never);
    const r1 = await call('CloseTab', [undefined]);
    expect(r1).toMatchObject({ ok: false, error: expect.stringContaining('非法 tabId') });
    const r2 = await call('CloseTab', ['n1' as unknown as number]); // 通知 id 误传等
    expect(r2).toMatchObject({ ok: false });
    expect(remove).not.toHaveBeenCalled();
  });

  it('Notification：iconUrl 用扩展内文件路径（data: URI 会报 Unable to download all specified images）', async () => {
    await saveScript(mkScript({ meta: { grants: ['GM_notification'] } }));
    const create = vi.spyOn(browser.notifications, 'create').mockResolvedValue('n1' as never);
    await call('Notification', [{ title: 't', text: 'm' }, 'n1']);
    expect(create).toHaveBeenCalledWith('n1', expect.objectContaining({
      type: 'basic', iconUrl: '/gm-notif.png',
    }));
  });

  it('SetClipboard 失败返回可读错误', async () => {
    await saveScript(mkScript({ meta: { grants: ['GM_setClipboard'] } }));
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => { throw new Error('denied'); }) } });
    const r = await call('SetClipboard', ['text']);
    expect(r).toMatchObject({ ok: false });
    vi.unstubAllGlobals();
  });

  it('SetClipboard 走 offscreen 文档：createDocument(Clipboard) + 委托写入成功', async () => {
    await saveScript(mkScript({ meta: { grants: ['GM_setClipboard'] } }));
    // SW 里 navigator.clipboard 为 undefined（冒烟实测）——走 offscreen 委托
    const createDocument = vi.fn(async () => {});
    (browser as unknown as Record<string, unknown>).offscreen = { createDocument, hasDocument: vi.fn(async () => false) };
    const send = vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({ ok: true } as never);
    const r = await call('SetClipboard', ['gmt-text']);
    expect(r).toEqual({ ok: true, data: null });
    expect(createDocument).toHaveBeenCalledWith(expect.objectContaining({ reasons: ['CLIPBOARD'] }));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'OFFSCREEN_WRITE_CLIPBOARD', text: 'gmt-text' }));
    delete (browser as unknown as Record<string, unknown>).offscreen;
  });

  it('SetClipboard offscreen 页报错时透传 error', async () => {
    await saveScript(mkScript({ meta: { grants: ['GM_setClipboard'] } }));
    (browser as unknown as Record<string, unknown>).offscreen = {
      createDocument: vi.fn(async () => {}),
      hasDocument: vi.fn(async () => true), // 已存在不重建
    };
    vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({ ok: false, error: 'denied' } as never);
    const r = await call('SetClipboard', ['t']);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('denied') });
    delete (browser as unknown as Record<string, unknown>).offscreen;
  });

  it('offscreen-clipboard 页源码走 execCommand 路径（writeText 在无焦点 offscreen 文档必报 Document is not focused）', async () => {
    // offscreen 页无单测环境（execCommand 为浏览器 API，jsdom 无实现）——做源码锚点断言锁死实现路径。
    // Vite ?raw 内联原文（项目无 @types/node，node:fs 过不了 compile 门禁，同 gmt-selftest-fixture 惯例）
    const src = offscreenMainSrc;
    expect(src).toContain("execCommand('copy')");
    expect(src).not.toContain('clipboard.writeText'); // 防 Backport 回 writeText 路径
    expect(src).toContain('OFFSCREEN_WRITE_CLIPBOARD');
  });

  // XmlHttpRequest 由 gm-connect.test.ts 完整覆盖（@connect 三分支 + 通用确认队列），此处不再占位
});

describe('gm-api Notification 点击/关闭回调（spec §8）', () => {
  // 每次重建可触发的 notifications listener 存根 + 经 initGmApi 注册进去
  let clicked: ((id: string) => void) | undefined;
  let closed: ((id: string) => void) | undefined;

  beforeEach(async () => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
    vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({} as never);
    await cleanupScriptState('s1'); // 清 s1 的 notifTargets/menuTable/errorBuffers 残留
    clicked = undefined; closed = undefined;
    (browser as unknown as Record<string, unknown>).notifications = {
      create: vi.fn(async () => 'id'),
      onClicked: { addListener: (cb: (id: string) => void) => { clicked = cb; } },
      onClosed: { addListener: (cb: (id: string) => void) => { closed = cb; } },
    };
    // 最小 router 存根：只需 .on 不报错（本用例不驱动 router，只借 initGmApi 注册 notifications 监听）
    initGmApi({ on: () => {} });
  });

  it('onClicked → NOTIF_CLICK{byUser:true} 回发到注册来源 tab', async () => {
    await saveScript(mkScript({ meta: { grants: ['GM_notification'] } }));
    const tabSpy = vi.spyOn(browser.tabs, 'sendMessage').mockResolvedValue(undefined as never);
    const r = await call('Notification', [{ title: 't', text: 'm' }, 'n1']);
    expect(r).toEqual({ ok: true, data: null });

    clicked!('n1');
    expect(tabSpy.mock.calls[0]![0]).toBe(1); // 回发到注册来源 tab
    expect(tabSpy.mock.calls[0]![1]).toMatchObject({
      type: 'GM_EVENT', scriptId: 's1', kind: 'NOTIF_CLICK', data: { id: 'n1', byUser: true },
    });
  });

  it('onClosed → NOTIF_CLICK{byUser:false} + 清映射（关闭后再点无回发）', async () => {
    await saveScript(mkScript({ meta: { grants: ['GM_notification'] } }));
    const tabSpy = vi.spyOn(browser.tabs, 'sendMessage').mockResolvedValue(undefined as never);
    await call('Notification', [{ text: 'm' }, 'n2']);

    closed!('n2');
    expect(tabSpy.mock.calls[0]![1]).toMatchObject({
      type: 'GM_EVENT', scriptId: 's1', kind: 'NOTIF_CLICK', data: { id: 'n2', byUser: false },
    });
    // 映射已清：再触发 onClicked 不应有新回发
    tabSpy.mockClear();
    clicked!('n2');
    expect(tabSpy).not.toHaveBeenCalled();
  });

  it('未知 notifId（无映射）静默忽略，不回发', () => {
    const tabSpy = vi.spyOn(browser.tabs, 'sendMessage').mockResolvedValue(undefined as never);
    clicked!('ghost');
    closed!('ghost');
    expect(tabSpy).not.toHaveBeenCalled();
  });
});

describe('gm-api SCRIPTS_GET_GM_STATE 复水快照', () => {
  const handlers = new Map<string, (msg: Record<string, unknown>) => unknown>();

  beforeEach(async () => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
    vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({} as never);
    await cleanupScriptState('s1');
    handlers.clear();
    (browser as unknown as Record<string, unknown>).notifications = { create: vi.fn(async () => 'id') };
    initGmApi({ on: (type, h) => { handlers.set(type, h as (msg: Record<string, unknown>) => unknown); } });
  });

  it('返回 menus/errors 两者非空且形状对', async () => {
    await saveScript(mkScript({ meta: { grants: ['GM_registerMenuCommand', 'GM_xmlhttpRequest'] } }));
    await call('RegisterMenu', ['m1', '抓取']);
    await call('ReportError', ['boom', 'stack', 3]);
    const getState = handlers.get('SCRIPTS_GET_GM_STATE')!;
    const resp = await getState({}) as {
      ok: boolean;
      data: { menus: Array<{ scriptId: string; commands: unknown[] }>; errors: Record<string, unknown[]> };
    };
    expect(resp.ok).toBe(true);
    expect(resp.data.menus).toEqual([{ scriptId: 's1', commands: [{ key: 'm1', name: '抓取' }] }]);
    expect(resp.data.errors['s1']).toHaveLength(1);
    expect(resp.data.errors['s1']![0]).toMatchObject({ message: 'boom', line: 3 });
  });
});

describe('gm-api LlmChat 参数校验', () => {
  beforeEach(() => { fakeBrowser.reset(); vi.restoreAllMocks(); __resetConfirmQueue(); vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({} as never); });

  it('未 grant → permission not requested', async () => {
    await saveScript(mkScript()); // 只 grant GM_setValue
    const r = await call('LlmChat', [{ messages: [{ role: 'user', content: 'hi' }] }]);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('permission not requested') });
  });

  it('模型未配置 → 明确报错', async () => {
    await saveScript(mkScript({ meta: { grants: ['GM_llmChat'] } }));
    const r = await call('LlmChat', [{ messages: [{ role: 'user', content: 'hi' }] }]);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('模型未配置') });
  });

  it('messages 缺失/空 → 报错', async () => {
    await saveScript(mkScript({ meta: { grants: ['GM_llmChat'] } }));
    const r1 = await call('LlmChat', [{}]);
    const r2 = await call('LlmChat', [{ messages: [] }]);
    expect(r1).toMatchObject({ ok: false, error: expect.stringContaining('messages') });
    expect(r2).toMatchObject({ ok: false, error: expect.stringContaining('messages') });
  });

  it('非法 role / content 形状 / part type → 报错', async () => {
    await saveScript(mkScript({ meta: { grants: ['GM_llmChat'] } }));
    const bad = await call('LlmChat', [{ messages: [{ role: 'tool', content: 'x' }] }]);
    expect(bad).toMatchObject({ ok: false, error: expect.stringContaining('role') });
    const bad2 = await call('LlmChat', [{ messages: [{ role: 'user', content: 42 }] }]);
    expect(bad2).toMatchObject({ ok: false, error: expect.stringContaining('content') });
    const bad3 = await call('LlmChat', [{ messages: [{ role: 'user', content: [{ type: 'audio', text: 'x' }] }] }]);
    expect(bad3).toMatchObject({ ok: false, error: expect.stringContaining('type') });
  });

  it('非法 timeout（0/负数/非数字）→ 报错', async () => {
    await saveScript(mkScript({ meta: { grants: ['GM_llmChat'] } }));
    const r1 = await call('LlmChat', [{ messages: [{ role: 'user', content: 'hi' }], timeout: 0 }]);
    const r2 = await call('LlmChat', [{ messages: [{ role: 'user', content: 'hi' }], timeout: -5 }]);
    const r3 = await call('LlmChat', [{ messages: [{ role: 'user', content: 'hi' }], timeout: 'abc' as unknown as number }]);
    expect(r1).toMatchObject({ ok: false, error: expect.stringContaining('非法 timeout') });
    expect(r2).toMatchObject({ ok: false, error: expect.stringContaining('非法 timeout') });
    expect(r3).toMatchObject({ ok: false, error: expect.stringContaining('非法 timeout') });
  });

  it('图片超 5MB / 载荷超 2MB → 报错', async () => {
    await saveScript(mkScript({ meta: { grants: ['GM_llmChat'] } }));
    const big = 'data:image/png;base64,' + 'A'.repeat(5 * 1024 * 1024);
    const r1 = await call('LlmChat', [{ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: big } }] }] }]);
    expect(r1).toMatchObject({ ok: false, error: expect.stringContaining('图片过大') });
    const fat = 'x'.repeat(2 * 1024 * 1024 + 1);
    const r2 = await call('LlmChat', [{ messages: [{ role: 'user', content: fat }] }]);
    expect(r2).toMatchObject({ ok: false, error: expect.stringContaining('载荷过大') });
  });
});

describe('gm-api LlmChat 权限档', () => {
  beforeEach(() => {
    fakeBrowser.reset(); vi.restoreAllMocks(); __resetConfirmQueue(); __resetLlmSession();
    vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({} as never);
    // 注入 fake provider：宏任务（setTimeout 0）后 text-delta 两段 + message-done——
    // 对齐真实 provider 时序（网络宏任务后才 emit），防止微任务早于 await 续体掩盖时序 bug
    __setLlmProviderFactory(() => ({
      streamChat: (_params: unknown, onEvent: (ev: StreamEvent) => void) => {
        setTimeout(() => {
          onEvent({ type: 'text-delta', text: '你' });
          onEvent({ type: 'text-delta', text: '好' });
          onEvent({ type: 'message-done', usage: { promptTokens: 3, completionTokens: 2 }, finishReason: 'stop' });
        }, 0);
        return { cancel: () => {} };
      },
    }));
  });

  it('deny 档直接拒绝（不弹卡、不调 provider）', async () => {
    await saveScript(mkScript({ meta: { grants: ['GM_llmChat'] } }));
    await setLlmTier('s1', 'deny');
    const r = await call('LlmChat', [{ messages: [{ role: 'user', content: 'hi' }] }]);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('permission denied') });
    expect(getPending()).toHaveLength(0);
  });

  it('allow 档直通', async () => {
    await saveScript(mkScript({ meta: { grants: ['GM_llmChat'] } }));
    await setLlmTier('s1', 'allow');
    const { saveSettings } = await import('../../storage/settings');
    await saveSettings({ provider: { baseUrl: 'https://api.test/v1', apiKey: 'k', model: 'm' } });
    const r = await call('LlmChat', [{ messages: [{ role: 'user', content: 'hi' }] }]);
    expect(r).toEqual({ ok: true, data: { text: '你好', usage: { promptTokens: 3, completionTokens: 2 }, finishReason: 'stop' } });
  });

  it('ask 档：弹卡 → deny 拒绝；allow-once 一次放行（不记 session）；session 后免卡', async () => {
    const { saveSettings } = await import('../../storage/settings');
    await saveSettings({ provider: { baseUrl: 'https://api.test/v1', apiKey: 'k', model: 'm' } });
    await saveScript(mkScript({ meta: { grants: ['GM_llmChat'] } }));
    const okParams = [{ messages: [{ role: 'user', content: 'hi' }] }, 'inst1:1'];

    const p1 = call('LlmChat', okParams);
    await new Promise((r) => setTimeout(r, 10));
    const confirms = getPending();
    expect(confirms).toHaveLength(1);
    expect(confirms[0]).toMatchObject({ kind: 'llm', title: '大模型调用确认' });
    resolveConfirm(confirms[0]!.confirmId, 'deny');
    expect(await p1).toMatchObject({ ok: false, error: expect.stringContaining('permission denied') });

    const p2 = call('LlmChat', okParams);
    await new Promise((r) => setTimeout(r, 10));
    resolveConfirm(getPending()[0]!.confirmId, 'allow-once');
    expect(await p2).toMatchObject({ ok: true });

    const r3 = call('LlmChat', okParams); // allow-once 不记 session —— 第三次仍弹卡
    await new Promise((r) => setTimeout(r, 10));
    resolveConfirm(getPending()[0]!.confirmId, 'session');
    expect(await r3).toMatchObject({ ok: true });
    const r4 = await call('LlmChat', okParams); // session 已记 → 免卡直通
    expect(await r4).toMatchObject({ ok: true });
    expect(getPending()).toHaveLength(0);
  });

  it('无 chan（params[1] 缺省）→ 终值返回但不产生任何 LLM_CHUNK 下发', async () => {
    const { saveSettings } = await import('../../storage/settings');
    await saveSettings({ provider: { baseUrl: 'https://api.test/v1', apiKey: 'k', model: 'm' } });
    await saveScript(mkScript({ meta: { grants: ['GM_llmChat'] } }));
    await setLlmTier('s1', 'allow');
    const tabSpy = vi.spyOn(browser.tabs, 'sendMessage').mockResolvedValue(undefined as never);
    const r = await call('LlmChat', [{ messages: [{ role: 'user', content: 'hi' }] }]);
    expect(r).toMatchObject({ ok: true, data: { text: '你好' } });
    expect(tabSpy.mock.calls.filter((c) => (c[1] as { kind?: string })?.kind === 'LLM_CHUNK')).toHaveLength(0);
  });
});

describe('gm-api LlmChat 流式下行', () => {
  beforeEach(() => {
    fakeBrowser.reset(); vi.restoreAllMocks(); __resetConfirmQueue(); __resetLlmSession();
    vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({} as never);
  });

  it('chunk 有序：LLM_CHUNK 按序到达 tab，gmres 晚于全部 chunk；chan 原样回显', async () => {
    const { saveSettings } = await import('../../storage/settings');
    await saveSettings({ provider: { baseUrl: 'https://api.test/v1', apiKey: 'k', model: 'm' } });
    await saveScript(mkScript({ meta: { grants: ['GM_llmChat'] } }));
    await setLlmTier('s1', 'allow');
    const tabSpy = vi.spyOn(browser.tabs, 'sendMessage').mockResolvedValue(undefined as never);

    // gate 式 fake：流事件被 gate 挡住，先让 doLlmChat 进入 await 状态再放行——
    // 验证「await done 等流终结」修复（4454bca）：函数不得在流事件前返回
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    __setLlmProviderFactory(() => ({
      streamChat: (_p: unknown, onEvent: (ev: StreamEvent) => void) => {
        void gate.then(() => {
          onEvent({ type: 'text-delta', text: 'a' });
          onEvent({ type: 'text-delta', text: 'b' });
          onEvent({ type: 'message-done' });
        });
        return { cancel: () => {} };
      },
    }));
    const pending = call('LlmChat', [{ messages: [{ role: 'user', content: 'hi' }] }, 'inst9:7']);
    await new Promise((r) => setTimeout(r, 10)); // doLlmChat 已在 await done 挂起
    release();
    const r = await pending as { ok: boolean; data?: { text: string } };
    expect(r).toMatchObject({ ok: true, data: { text: 'ab' } });
    // 下行顺序：两条 LLM_CHUNK 按 a、b 序到达，chan 原样回显；resolve 语义由 wrapper 清监听保证，
    // SW 侧可断言的是 chunk 全部先于 handleGmCall promise resolve 前发出（await chain 排空）
    const chunks = tabSpy.mock.calls
      .filter((c) => (c[1] as { kind?: string })?.kind === 'LLM_CHUNK')
      .map((c) => (c[1] as { data: { chan: string; delta: string } }).data);
    expect(chunks).toEqual([
      { chan: 'inst9:7', delta: 'a' },
      { chan: 'inst9:7', delta: 'b' },
    ]);
  });

  it('响应超 1MB：cancel 流并报「响应过大」', async () => {
    const { saveSettings } = await import('../../storage/settings');
    await saveSettings({ provider: { baseUrl: 'https://api.test/v1', apiKey: 'k', model: 'm' } });
    await saveScript(mkScript({ meta: { grants: ['GM_llmChat'] } }));
    await setLlmTier('s1', 'allow');
    let cancelled = false;
    __setLlmProviderFactory(() => ({
      streamChat: (_p: unknown, onEvent: (ev: StreamEvent) => void) => {
        // 宏任务时序（与真实 provider 对齐；4454bca 后 fake 统一 setTimeout）
        setTimeout(() => {
          onEvent({ type: 'text-delta', text: 'x'.repeat(1024 * 1024 + 1) });
          onEvent({ type: 'message-done' });
        }, 0);
        return { cancel: () => { cancelled = true; } };
      },
    }));
    const r = await call('LlmChat', [{ messages: [{ role: 'user', content: 'hi' }] }]);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('响应过大') });
    expect(cancelled).toBe(true);
  });

  it('provider error 事件 → 「LLM 调用失败:」前缀', async () => {
    const { saveSettings } = await import('../../storage/settings');
    await saveSettings({ provider: { baseUrl: 'https://api.test/v1', apiKey: 'k', model: 'm' } });
    await saveScript(mkScript({ meta: { grants: ['GM_llmChat'] } }));
    await setLlmTier('s1', 'allow');
    __setLlmProviderFactory(() => ({
      streamChat: (_p: unknown, onEvent: (ev: StreamEvent) => void) => {
        setTimeout(() => { onEvent({ type: 'error', error: 'HTTP 500: boom' }); onEvent({ type: 'message-done' }); }, 0);
        return { cancel: () => {} };
      },
    }));
    const r = await call('LlmChat', [{ messages: [{ role: 'user', content: 'hi' }] }]);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('HTTP 500: boom') });
  });

  it('超时：timeout 到点 abort → 「LLM 调用超时（Xms）」', async () => {
    const { saveSettings } = await import('../../storage/settings');
    await saveSettings({ provider: { baseUrl: 'https://api.test/v1', apiKey: 'k', model: 'm' } });
    await saveScript(mkScript({ meta: { grants: ['GM_llmChat'] } }));
    await setLlmTier('s1', 'allow');
    __setLlmProviderFactory(() => ({
      streamChat: (_p: unknown, _onEvent: unknown) => {
        // 永不发事件——等 timeout abort（provider 契约：abort 后仍会补发 message-done，
        // 但本 fake 连补发也不做，验证 doLlmChat 对「流永不结束」也能按超时终态返回）
        return { cancel: () => {} };
      },
    }));
    const r = await call('LlmChat', [{ messages: [{ role: 'user', content: 'hi' }], timeout: 30 }]);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('LLM 调用超时') });
  });
});

describe('批量值 + 菜单注销 + 通知管理', () => {
  beforeEach(async () => {
    fakeBrowser.reset(); vi.restoreAllMocks();
    await cleanupScriptState('s1'); // 清 menuTable 残留（模块内存态，fakeBrowser.reset 不触及）
  });

  it('SetValues 批量写；DeleteValues 批量删', async () => {
    await saveScript(mkScript({ meta: { grants: ['GM_setValues', 'GM_deleteValues'] } }));
    await handleGmCall({ scriptId: 's1', api: 'SetValues', reqId: 1, params: [{ a: 1, b: 2, c: 3 }] }, { tab: { id: 1, url: 'https://a.com/' } } as never);
    expect(await readValuesForSnapshot('s1')).toEqual({ a: 1, b: 2, c: 3 });
    await handleGmCall({ scriptId: 's1', api: 'DeleteValues', reqId: 2, params: [['a', 'c']] }, { tab: { id: 1, url: 'https://a.com/' } } as never);
    expect(await readValuesForSnapshot('s1')).toEqual({ b: 2 });
  });

  it('UnregisterMenu 从菜单表移除', async () => {
    await saveScript(mkScript({ meta: { grants: ['GM_registerMenuCommand', 'GM_unregisterMenuCommand'] } }));
    await handleGmCall({ scriptId: 's1', api: 'RegisterMenu', reqId: 1, params: ['k1', '命令一'] }, { tab: { id: 9, url: 'https://a.com/' } } as never);
    expect(getMenuSnapshot().find((e) => e.scriptId === 's1')?.commands).toEqual([{ key: 'k1', name: '命令一' }]);
    await handleGmCall({ scriptId: 's1', api: 'UnregisterMenu', reqId: 2, params: ['k1'] }, { tab: { id: 9, url: 'https://a.com/' } } as never);
    expect(getMenuSnapshot().find((e) => e.scriptId === 's1')).toBeUndefined();
  });

  it('CloseNotification/UpdateNotification 调 notifications API', async () => {
    await saveScript(mkScript({ meta: { grants: ['GM_closeNotification', 'GM_updateNotification'] } }));
    const clear = vi.fn(async () => true);
    const update = vi.fn(async () => true);
    (browser as unknown as { notifications: Record<string, unknown> }).notifications = { clear, update };
    await handleGmCall({ scriptId: 's1', api: 'CloseNotification', reqId: 1, params: ['n1'] }, { tab: { id: 1, url: 'https://a.com/' } } as never);
    expect(clear).toHaveBeenCalledWith('n1');
    await handleGmCall({ scriptId: 's1', api: 'UpdateNotification', reqId: 2, params: ['n1', { title: 'T', text: 'X' }] }, { tab: { id: 1, url: 'https://a.com/' } } as never);
    expect(update).toHaveBeenCalledWith('n1', expect.objectContaining({ title: 'T', message: 'X' }));
  });

  it('GetTab/SaveTab/GetTabs 经 handleGmCall 往返', async () => {
    await saveScript(mkScript({ meta: { grants: ['GM_getTab', 'GM_saveTab', 'GM_getTabs'] } }));
    const sender = { tab: { id: 7, url: 'https://a.com/' } } as never;
    expect((await handleGmCall({ scriptId: 's1', api: 'GetTab', reqId: 1, params: [] }, sender) as { data: unknown }).data).toEqual({});
    await handleGmCall({ scriptId: 's1', api: 'SaveTab', reqId: 2, params: [{ hits: 5 }] }, sender);
    expect((await handleGmCall({ scriptId: 's1', api: 'GetTab', reqId: 3, params: [] }, sender) as { data: unknown }).data).toEqual({ hits: 5 });
    expect((await handleGmCall({ scriptId: 's1', api: 'GetTabs', reqId: 4, params: [] }, sender) as { data: unknown }).data).toEqual({ '7': { hits: 5 } });
  });

  it('WindowClose 关 tab；WindowFocus 激活 tab', async () => {
    await saveScript(mkScript({ meta: { grants: ['window.close', 'window.focus'] } }));
    const remove = vi.spyOn(browser.tabs, 'remove').mockResolvedValue(undefined as never);
    const update = vi.spyOn(browser.tabs, 'update').mockResolvedValue({} as never);
    await handleGmCall({ scriptId: 's1', api: 'WindowClose', reqId: 1, params: [] }, { tab: { id: 8, url: 'https://a.com/' } } as never);
    expect(remove).toHaveBeenCalledWith(8);
    await handleGmCall({ scriptId: 's1', api: 'WindowFocus', reqId: 2, params: [] }, { tab: { id: 8, url: 'https://a.com/' } } as never);
    expect(update).toHaveBeenCalledWith(8, { active: true });
  });
});
