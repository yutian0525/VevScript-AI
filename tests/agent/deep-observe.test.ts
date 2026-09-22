// tests/agent/deep-observe.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { doToggleDeepObserve } from '../../agent/tools/deep-observe';
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

describe('toggle_deep_observe 工具', () => {
  it('enabled=true → ok，data 带 tabId 与 on', async () => {
    await expect(doToggleDeepObserve(1, true)).resolves.toEqual({ ok: true, data: { tabId: 1, status: 'on' } });
  });

  it('开启失败 → ok:false 且文案含附着失败', async () => {
    attachFails = true;
    const r = await doToggleDeepObserve(1, true);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('附着失败');
  });

  it('enabled=false → off，对未附着幂等', async () => {
    await expect(doToggleDeepObserve(1, false)).resolves.toEqual({ ok: true, data: { tabId: 1, status: 'off' } });
  });

  it('开启后再关闭 → 回 off', async () => {
    await doToggleDeepObserve(1, true);
    await expect(doToggleDeepObserve(1, false)).resolves.toEqual({ ok: true, data: { tabId: 1, status: 'off' } });
  });
});

describe('工具分发与模式', () => {
  // 同一行 registry 分发同时覆盖两个方向：名字写错会落「未知工具：…」而非静默失败
  it('registry 按 enabled 分发到开与关', async () => {
    const on = await executeTool('toggle_deep_observe', { enabled: true }, { tabId: 1, sessionId: 's', signal: new AbortController().signal });
    expect(on).toEqual({ ok: true, data: { tabId: 1, status: 'on' } });
    const off = await executeTool('toggle_deep_observe', { enabled: false }, { tabId: 1, sessionId: 's', signal: new AbortController().signal });
    expect(off).toEqual({ ok: true, data: { tabId: 1, status: 'off' } });
  });

  it('缺 enabled 参数时按关闭处理（schema 标 required，这里是防幻觉调用的兜底）', async () => {
    await doToggleDeepObserve(1, true);
    const r = await executeTool('toggle_deep_observe', {}, { tabId: 1, sessionId: 's', signal: new AbortController().signal });
    expect(r).toEqual({ ok: true, data: { tabId: 1, status: 'off' } });
  });

  it('ask 模式拒绝（ask 工具集收为「看页面 + 答问 + 加载技能」，深度观测属 agent 主场）', async () => {
    const r = await executeTool('toggle_deep_observe', { enabled: true }, { tabId: 1, sessionId: 's', signal: new AbortController().signal, mode: 'ask' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('ask');
  });
});
