// tests/background/cdp-messages.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { initCdp } from '../../background/cdp/init';
import { __resetCdpSession } from '../../background/cdp/session';
import { MessageRouter } from '../../background/router';

let attachFails = false;

function makeRouter(): MessageRouter {
  const router = new MessageRouter();
  initCdp(router);
  return router;
}

beforeEach(() => {
  fakeBrowser.reset();
  __resetCdpSession();
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
