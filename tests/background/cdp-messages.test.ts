// tests/background/cdp-messages.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { initCdp } from '../../background/cdp/init';
import { __resetCdpSession, getState } from '../../background/cdp/session';
import { MessageRouter } from '../../background/router';
import { resetStore, recordRequestStart, readNetworkList } from '../../background/observe-store';

let attachFails = false;

function makeRouter(): MessageRouter {
  const router = new MessageRouter();
  initCdp(router);
  return router;
}

beforeEach(() => {
  fakeBrowser.reset();
  __resetCdpSession();
  resetStore();
  attachFails = false;
  (fakeBrowser as unknown as { debugger: unknown }).debugger = {
    attach: (async () => { if (attachFails) throw new Error('Another debugger is already attached'); }) as never,
    detach: (async () => {}) as never,
    sendCommand: (async () => ({})) as never,
    getTargets: (async () => []) as never,
  };
});

describe('DEEP_OBSERVE 消息', () => {
  it('GET 未附着返回 off', async () => {
    const r = await makeRouter().dispatch({ type: 'DEEP_OBSERVE_GET', tabId: 1 });
    expect(r).toEqual({ ok: true, data: { tabId: 1, status: 'off' } });
  });

  it('SET enabled=true → on', async () => {
    const router = makeRouter();
    const r = await router.dispatch({ type: 'DEEP_OBSERVE_SET', tabId: 1, enabled: true });
    expect(r).toEqual({ ok: true, data: { tabId: 1, status: 'on' } });
  });

  it('SET enabled=false → off（幂等）', async () => {
    const router = makeRouter();
    await router.dispatch({ type: 'DEEP_OBSERVE_SET', tabId: 1, enabled: true });
    const r = await router.dispatch({ type: 'DEEP_OBSERVE_SET', tabId: 1, enabled: false });
    expect(r).toEqual({ ok: true, data: { tabId: 1, status: 'off' } });
  });

  it('attach 失败返回 ok:false 且状态落 error', async () => {
    attachFails = true;
    const router = makeRouter();
    // dispatch 返回 unknown，按项目惯例（gm-debug.test.ts）收窄形状
    const r = await router.dispatch({ type: 'DEEP_OBSERVE_SET', tabId: 1, enabled: true }) as { ok: boolean; error: string };
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('附着失败');
    const g = await router.dispatch({ type: 'DEEP_OBSERVE_GET', tabId: 1 });
    expect((g as { data: { status: string } }).data.status).toBe('error');
  });
});

describe('冷启动对账与网络抑制器', () => {
  it('收养失败（DevTools 占用）的 tab 不启用抑制器：webRequest 主干仍落库', async () => {
    // 场景：用户开着 DevTools，SW 冷启动 → getTargets 报 attached:true，但域启用抛「未附着」。
    // 若此时仍落 on 态，抑制器会掐掉该 tab 的 webRequest 主干，页面彻底失去网络观测。
    (fakeBrowser as unknown as { debugger: { getTargets: unknown } }).debugger.getTargets =
      (async () => [{ type: 'page', tabId: 1, attached: true }]) as never;
    (fakeBrowser as unknown as { debugger: { sendCommand: unknown } }).debugger.sendCommand =
      (async () => { throw new Error('Debugger is not attached to the tab with id: 1'); }) as never;

    makeRouter();
    await vi.waitFor(() => expect(getState(1).status).toBe('error'));

    recordRequestStart(1, { requestId: 'r1', method: 'GET', url: 'https://x.com/a', type: 'xmlhttprequest', ts: 1 });
    expect(readNetworkList(1, {})).toHaveLength(1);
  });
});
