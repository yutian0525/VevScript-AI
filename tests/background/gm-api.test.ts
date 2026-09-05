// tests/background/gm-api.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { storage } from 'wxt/utils/storage';
import {
  gmErrorCounts, getErrorBuffer, clearErrors, getMenuSnapshot, handleGmCall,
  initGmApi, cleanupScriptState, resolveConfirm,
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

  // XmlHttpRequest 由 gm-connect.test.ts 完整覆盖（@connect 三分支 + 确认队列），此处不再占位
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

  it('返回 menus/errors/confirms 三者非空且形状对', async () => {
    await saveScript(mkScript({ meta: { grants: ['GM_registerMenuCommand', 'GM_xmlhttpRequest'] } }));
    await call('RegisterMenu', ['m1', '抓取']);
    await call('ReportError', ['boom', 'stack', 3]);
    // 入确认队列：XHR 打未列 @connect 的域 → CONFIRM。queueConfirm 在数个 await 之后才同步入队，
    // 全量套件负载下固定 sleep 不稳，改轮询直到 GM 状态里出现该确认（上限 ~1s）。
    const pending = handleGmCall(
      { scriptId: 's1', api: 'XmlHttpRequest', reqId: 9, params: [{ url: 'https://ext.com/x' }] },
      { tab: { id: 1, url: 'https://a.com/' } } as never,
    );
    const getState = handlers.get('SCRIPTS_GET_GM_STATE')!;
    let resp!: {
      ok: boolean;
      data: { menus: Array<{ scriptId: string; commands: unknown[] }>; errors: Record<string, unknown[]>; confirms: Array<{ confirmId: string; scriptId: string; host: string }> };
    };
    for (let i = 0; i < 100; i++) {
      resp = await getState({}) as typeof resp;
      if (resp.data.confirms.length > 0) break;
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(resp.ok).toBe(true);
    expect(resp.data.menus).toEqual([{ scriptId: 's1', commands: [{ key: 'm1', name: '抓取' }] }]);
    expect(resp.data.errors['s1']).toHaveLength(1);
    expect(resp.data.errors['s1']![0]).toMatchObject({ message: 'boom', line: 3 });
    expect(resp.data.confirms).toHaveLength(1);
    expect(resp.data.confirms[0]).toMatchObject({ scriptId: 's1', host: 'ext.com' });

    // 收尾：解掉挂起的确认，避免 60s 定时器悬挂
    await resolveConfirm(resp.data.confirms[0]!.confirmId, 'deny');
    await pending;
  });
});
