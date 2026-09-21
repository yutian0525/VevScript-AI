// tests/agent/deep-observe.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { doEnableDeepObserve, doDisableDeepObserve } from '../../agent/tools/deep-observe';
import { executeTool } from '../../agent/tools/registry';
import { __resetCdpSession } from '../../background/cdp/session';

let attachFails = false;

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

describe('deep observe 工具', () => {
  it('enable → ok，data 带 tabId 与 on', async () => {
    await expect(doEnableDeepObserve(1)).resolves.toEqual({ ok: true, data: { tabId: 1, status: 'on' } });
  });

  it('enable 失败 → ok:false 且文案含附着失败', async () => {
    attachFails = true;
    const r = await doEnableDeepObserve(1);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('附着失败');
  });

  it('disable → off，对未附着幂等', async () => {
    await expect(doDisableDeepObserve(1)).resolves.toEqual({ ok: true, data: { tabId: 1, status: 'off' } });
  });
});

describe('工具分发与模式', () => {
  it('registry 分发两个新工具', async () => {
    const r = await executeTool('enable_deep_observe', {}, { tabId: 1, sessionId: 's', signal: new AbortController().signal });
    expect(r.ok).toBe(true);
  });

  it('disable 也经 registry 分发（写错名字会落「未知工具」而非报错）', async () => {
    const r = await executeTool('disable_deep_observe', {}, { tabId: 1, sessionId: 's', signal: new AbortController().signal });
    expect(r).toEqual({ ok: true, data: { tabId: 1, status: 'off' } });
  });

  it('ask 模式放行（诊断主场，只读观测工具依赖它）', async () => {
    const r = await executeTool('enable_deep_observe', {}, { tabId: 1, sessionId: 's', signal: new AbortController().signal, mode: 'ask' });
    expect(r.ok).toBe(true);
  });
});
