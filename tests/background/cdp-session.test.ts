// tests/background/cdp-session.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  initCdpSession, attach, detach, getState, isAttached, onDetached, markZombie, forget, reconcile,
  rememberSession, forgetSession, tabIdForSession, __resetCdpSession,
} from '../../background/cdp/session';

let attachImpl: (t: unknown, v: string) => Promise<void>;
let detachImpl: (t: unknown) => Promise<void>;
let targets: Array<{ type: string; tabId?: number; attached: boolean }>;
let enableCalls: number[];
let stateCalls: Array<{ tabId: number; status: string }>;

beforeEach(() => {
  fakeBrowser.reset();
  __resetCdpSession();
  attachImpl = async () => {};
  detachImpl = async () => {};
  targets = [];
  enableCalls = [];
  stateCalls = [];
  (fakeBrowser as unknown as { debugger: unknown }).debugger = {
    attach: ((t: unknown, v: string) => attachImpl(t, v)) as never,
    detach: ((t: unknown) => detachImpl(t)) as never,
    getTargets: (async () => targets) as never,
  };
  initCdpSession({
    enableDomains: async (tabId) => { enableCalls.push(tabId); },
    onStateChange: (s) => { stateCalls.push({ tabId: s.tabId, status: s.status }); },
  });
});

describe('cdp session', () => {
  it('初始为 off', () => {
    expect(getState(1)).toEqual({ tabId: 1, status: 'off' });
    expect(isAttached(1)).toBe(false);
  });

  it('attach 成功 → on 态 + enable 域 + 广播', async () => {
    const r = await attach(1);
    expect(r).toEqual({ ok: true, state: { tabId: 1, status: 'on' } });
    expect(enableCalls).toEqual([1]);
    expect(stateCalls.at(-1)).toEqual({ tabId: 1, status: 'on' });
  });

  it('attach 幂等：已 on 时不重复 attach / enable', async () => {
    await attach(1);
    const spy = vi.fn(async () => {});
    attachImpl = spy;
    await attach(1);
    expect(spy).not.toHaveBeenCalled();
    expect(enableCalls).toEqual([1]);
  });

  it('attach 失败（DevTools 占用）→ error 态且不抛，返回 ok:false', async () => {
    attachImpl = async () => { throw new Error('Another debugger is already attached to the tab with id: 1'); };
    const r = await attach(1);
    expect(r.ok).toBe(false);
    expect(getState(1).status).toBe('error');
    expect(getState(1).reason).toContain('Another debugger');
    expect(stateCalls.at(-1)).toEqual({ tabId: 1, status: 'error' });
  });

  it('域启用失败不脱离会话（部分域可用优于完全不可用）', async () => {
    initCdpSession({
      enableDomains: async () => { throw new Error('boom'); },
      onStateChange: (s) => { stateCalls.push({ tabId: s.tabId, status: s.status }); },
    });
    const r = await attach(2);
    expect(r).toEqual({ ok: true, state: { tabId: 2, status: 'on' } });
  });

  it('detach 对未附着幂等（「not attached」抛错视为成功）', async () => {
    detachImpl = async () => { throw new Error('Debugger is not attached to the tab with id: 3'); };
    await expect(detach(3)).resolves.toBeUndefined();
    expect(getState(3).status).toBe('off');
  });

  it('onDetached(canceled_by_user) → error 态', () => {
    void attach(1);
    onDetached(1, 'canceled_by_user');
    expect(getState(1).status).toBe('error');
    expect(getState(1).reason).toBe('页面 DevTools 占用中');
  });

  it('onDetached(target_closed) → 清记录回 off', async () => {
    await attach(1);
    onDetached(1, 'target_closed');
    expect(getState(1)).toEqual({ tabId: 1, status: 'off' });
  });

  it('sessionId ↔ tabId 映射', () => {
    rememberSession(5, 's-a');
    expect(tabIdForSession('s-a')).toBe(5);
    forgetSession('s-a');
    expect(tabIdForSession('s-a')).toBeUndefined();
  });

  it('forget 清掉该 tab 的 session 映射', () => {
    rememberSession(6, 's-b');
    forget(6);
    expect(tabIdForSession('s-b')).toBeUndefined();
  });

  it('markZombie → error 态且清 session 映射', () => {
    rememberSession(10, 's-z');
    markZombie(10);
    expect(getState(10).status).toBe('error');
    expect(getState(10).reason).toBe('调试会话已失效，请重新开启');
    expect(tabIdForSession('s-z')).toBeUndefined();
  });

  it('reconcile：浏览器侧附着而内存无记录 → 补记录并 enable', async () => {
    targets = [{ type: 'page', tabId: 7, attached: true }];
    await reconcile();
    expect(getState(7).status).toBe('on');
    expect(enableCalls).toEqual([7]);
  });

  it('reconcile：内存有记录而浏览器侧未附着 → 清僵尸态', async () => {
    await attach(8);
    targets = [];
    await reconcile();
    expect(getState(8).status).toBe('off');
  });

  it('reconcile：一致时跳过，不重复 enable', async () => {
    targets = [{ type: 'page', tabId: 9, attached: true }];
    await reconcile();
    enableCalls.length = 0;
    await reconcile();
    expect(enableCalls).toEqual([]);
  });

  it('reconcile：getTargets 抛错时静默返回', async () => {
    (fakeBrowser as unknown as { debugger: { getTargets: unknown } }).debugger.getTargets =
      (async () => { throw new Error('unavailable'); }) as never;
    await expect(reconcile()).resolves.toBeUndefined();
  });
});
