// tests/background/gm-debug.test.ts
// GM_DEBUG_CALL / GM_DEBUG_INFO SW handler（脚本运行时调试台，spec §3）
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { MessageRouter } from '../../background/router';
import {
  initGmApi, handleGmCall, __setLlmProviderFactory, __resetLlmSession,
} from '../../background/gm-api';
import { __resetConfirmQueue } from '../../background/confirm-queue';
import { listAlwaysAllow, setAlwaysAllow, setLlmTier } from '../../background/gm-permissions';
import { saveScript } from '../../storage/scripts';
import type { UserScript } from '../../shared/types';
import type { StreamEvent } from '../../agent/provider/types';

// fakeBrowser 未内置 notifications API——initGmApi 挂 onClicked/onClosed 监听需要它
(browser as unknown as Record<string, unknown>).notifications = { create: vi.fn(async () => 'id') };

function mkScript(over: Partial<UserScript> = {}): UserScript {
  return {
    id: 's1', text: '// ==UserScript==\n// @name t\n// @match https://a.com/*\n// @connect api.a.com\n// @grant GM_setValue\n// @grant GM_wat\n// ==/UserScript==\nx();',
    name: 't', enabled: true, matches: ['https://a.com/*'], code: 'x();',
    runAt: 'document_idle', world: 'USER_SCRIPT', source: 'user', createdAt: 1, updatedAt: 1,
    meta: { grants: ['GM_setValue', 'GM_wat'], connects: ['api.a.com'] }, ...over,
  };
}

describe('gm-debug handlers', () => {
  beforeEach(() => { fakeBrowser.reset(); vi.restoreAllMocks(); });

  it('GM_DEBUG_CALL：token 查不到（脚本未匹配目标页）时报错', async () => {
    await saveScript(mkScript());
    const router = new MessageRouter();
    initGmApi(router);
    vi.spyOn(browser.tabs, 'get').mockResolvedValue({ id: 9, url: 'https://other.com/' } as never);
    const r = await router.dispatch({ type: 'GM_DEBUG_CALL', scriptId: 's1', api: 'SetValue', params: ['k', 1], tabId: 9 }) as { dispatched: boolean; error?: string };
    expect(r.dispatched).toBe(false);
    expect(r.error).toMatch(/未注入|token|匹配/);
  });

  it('GM_DEBUG_CALL：命中则下发 GM_DEBUG_INVOKE，回 result', async () => {
    await saveScript(mkScript());
    const router = new MessageRouter();
    initGmApi(router);
    vi.spyOn(browser.tabs, 'get').mockResolvedValue({ id: 9, url: 'https://a.com/x' } as never);
    const send = vi.spyOn(browser.tabs, 'sendMessage').mockResolvedValue({ result: { ok: true, data: 42 } } as never);
    const r = await router.dispatch({ type: 'GM_DEBUG_CALL', scriptId: 's1', api: 'GetValue', params: ['k'], tabId: 9 }) as { dispatched: boolean; result?: { ok: boolean; data?: unknown } };
    expect(send).toHaveBeenCalled();
    const sent = send.mock.calls[0]![1] as { type: string; payload: { api: string } };
    expect(sent.type).toBe('GM_DEBUG_INVOKE');
    expect(sent.payload.api).toBe('GetValue');
    expect(r.dispatched).toBe(true);
    expect(r.result).toEqual({ ok: true, data: 42 });
  });

  it('GM_DEBUG_INFO：回 grant 二分 + connects + alwaysAllow + injected', async () => {
    await saveScript(mkScript());
    await setAlwaysAllow('s1', 'cdn.x.com');
    const router = new MessageRouter();
    initGmApi(router);
    vi.spyOn(browser.tabs, 'get').mockResolvedValue({ id: 9, url: 'https://a.com/x' } as never);
    const r = await router.dispatch({ type: 'GM_DEBUG_INFO', scriptId: 's1', tabId: 9 }) as { ok: boolean; data: { grantSupported: string[]; grantUnsupported: string[]; connects: string[]; alwaysAllow: string[]; injected: boolean } };
    expect(r.ok).toBe(true);
    expect(r.data.grantSupported).toContain('GM_setValue');
    expect(r.data.grantUnsupported).toContain('GM_wat');
    expect(r.data.connects).toContain('api.a.com');
    expect(r.data.alwaysAllow).toContain('cdn.x.com');
    expect(r.data.injected).toBe(true);
  });

  it('listAlwaysAllow：无记录返回空', async () => {
    expect(await listAlwaysAllow('nope')).toEqual([]);
  });
});

describe('LlmChat 直调（调试台）', () => {
  beforeEach(() => {
    fakeBrowser.reset(); vi.restoreAllMocks(); __resetConfirmQueue(); __resetLlmSession();
    vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({} as never);
  });

  it('无 chan 参数：chunk 不下发、终值照常返回（直调 = 非流式语义）', async () => {
    const { saveSettings } = await import('../../storage/settings');
    await saveSettings({ provider: { baseUrl: 'https://api.test/v1', apiKey: 'k', model: 'm' } });
    await saveScript(mkScript({ meta: { grants: ['GM_llmChat'], connects: ['api.a.com'] } }));
    await setLlmTier('s1', 'allow');
    const tabSpy = vi.spyOn(browser.tabs, 'sendMessage').mockResolvedValue(undefined as never);
    // 宏任务时序 + 双 delta：与 gm-api.test.ts 的 fake 对齐（防微任务早于 await 续体掩盖时序 bug）
    __setLlmProviderFactory(() => ({
      streamChat: (_p: unknown, onEvent: (ev: StreamEvent) => void) => {
        setTimeout(() => {
          onEvent({ type: 'text-delta', text: '直' });
          onEvent({ type: 'text-delta', text: '调' });
          onEvent({ type: 'message-done' });
        }, 0);
        return { cancel: () => {} };
      },
    }));
    // 直调视角（走 handleGmCall，无 wrapper）：params[1] 无 chan → enqueueChunk 静默，仅回终值
    const r = await handleGmCall(
      { scriptId: 's1', api: 'LlmChat', reqId: 1, params: [{ messages: [{ role: 'user', content: 'hi' }] }] },
      { tab: { id: 1, url: 'https://a.com/' } } as never,
    );
    expect(r).toMatchObject({ ok: true, data: { text: '直调' } });
    expect(tabSpy.mock.calls.filter((c) => (c[1] as { kind?: string })?.kind === 'LLM_CHUNK')).toHaveLength(0);
  });

  it('API_TO_GRANT：LlmChat 映射 GM_llmChat（未 grant → permission not requested: LlmChat）', async () => {
    await saveScript(mkScript()); // 无 GM_llmChat grant
    const r = await handleGmCall(
      { scriptId: 's1', api: 'LlmChat', reqId: 1, params: [{ messages: [{ role: 'user', content: 'x' }] }] },
      { tab: { id: 1, url: 'https://a.com/' } } as never,
    );
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('permission not requested: LlmChat') });
  });
});
