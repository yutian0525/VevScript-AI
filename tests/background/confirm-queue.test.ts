// tests/background/confirm-queue.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { enqueueConfirm, resolveConfirm, getPending, initConfirmQueue, __resetConfirmQueue } from '../../background/confirm-queue';
import type { ConfirmSpec } from '../../shared/confirm';

function spec(over: Partial<ConfirmSpec> = {}): ConfirmSpec {
  return {
    kind: 'connect', title: 't', message: 'm', rows: [], timeoutMs: 60_000,
    actions: [{ decision: 'allow-once', label: 'A' }, { decision: 'deny', label: 'D' }],
    ...over,
  };
}

describe('confirm-queue', () => {
  beforeEach(() => { fakeBrowser.reset(); vi.restoreAllMocks(); __resetConfirmQueue(); vi.useRealTimers(); });

  it('enqueue：广播 CONFIRM_PENDING + getPending 出现 + 首个 pending 开 hub', async () => {
    const send = vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue(undefined as never);
    const create = vi.spyOn(browser.tabs, 'create').mockResolvedValue({ id: 100 } as never);
    void enqueueConfirm(spec());
    await new Promise((r) => setTimeout(r, 0));
    expect(getPending()).toHaveLength(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'CONFIRM_PENDING' }));
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ url: expect.stringContaining('confirm.html'), active: true }));
  });

  it('第二条 pending：不再 create，改 tabs.update 聚焦已开 hub', async () => {
    vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue(undefined as never);
    vi.spyOn(browser.tabs, 'create').mockResolvedValue({ id: 100 } as never);
    vi.spyOn(browser.tabs, 'get').mockResolvedValue({ id: 100 } as never);
    const update = vi.spyOn(browser.tabs, 'update').mockResolvedValue({} as never);
    void enqueueConfirm(spec());
    await new Promise((r) => setTimeout(r, 0));
    void enqueueConfirm(spec());
    await new Promise((r) => setTimeout(r, 0));
    expect(getPending()).toHaveLength(2);
    expect(update).toHaveBeenCalledWith(100, { active: true });
  });

  it('并发两条 pending（无间隔）：ensureHub 在途单例，只 create 一次 hub', async () => {
    vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue(undefined as never);
    const create = vi.spyOn(browser.tabs, 'create').mockResolvedValue({ id: 100 } as never);
    vi.spyOn(browser.tabs, 'get').mockResolvedValue({ id: 100 } as never);
    vi.spyOn(browser.tabs, 'update').mockResolvedValue({} as never);
    // 同一事件循环内连发两条、中间不 await（脚本连打两个未 @connect 域）：旧实现会因 hubTabId 未回填而 create 两次
    void enqueueConfirm(spec());
    void enqueueConfirm(spec());
    await new Promise((r) => setTimeout(r, 0));
    expect(getPending()).toHaveLength(2);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('resolveConfirm：解析 promise 为该 decision + 广播 CONFIRM_RESOLVED + 出队', async () => {
    const send = vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue(undefined as never);
    vi.spyOn(browser.tabs, 'create').mockResolvedValue({ id: 100 } as never);
    const p = enqueueConfirm(spec());
    await new Promise((r) => setTimeout(r, 0));
    const id = getPending()[0]!.confirmId;
    resolveConfirm(id, 'allow-once');
    expect(await p).toBe('allow-once');
    expect(getPending()).toHaveLength(0);
    expect(send).toHaveBeenCalledWith({ type: 'CONFIRM_RESOLVED', confirmId: id });
  });

  it('超时：timeoutMs 到点 → 决策 __timeout__ + 出队', async () => {
    vi.useFakeTimers();
    vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue(undefined as never);
    vi.spyOn(browser.tabs, 'create').mockResolvedValue({ id: 100 } as never);
    const p = enqueueConfirm(spec({ timeoutMs: 1000 }));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await p).toBe('__timeout__');
    expect(getPending()).toHaveLength(0);
  });

  it('resolve 后清 timer：不会二次 resolve', async () => {
    vi.useFakeTimers();
    vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue(undefined as never);
    vi.spyOn(browser.tabs, 'create').mockResolvedValue({ id: 100 } as never);
    const p = enqueueConfirm(spec({ timeoutMs: 1000 }));
    await vi.advanceTimersByTimeAsync(0);
    const id = getPending()[0]!.confirmId;
    resolveConfirm(id, 'deny');
    await vi.advanceTimersByTimeAsync(2000);
    expect(await p).toBe('deny'); // 不被超时覆盖
  });

  it('关 hub tab：剩余全部 __closed__', async () => {
    vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue(undefined as never);
    vi.spyOn(browser.tabs, 'create').mockResolvedValue({ id: 100 } as never);
    vi.spyOn(browser.tabs, 'get').mockResolvedValue({ id: 100 } as never);
    vi.spyOn(browser.tabs, 'update').mockResolvedValue({} as never);
    initConfirmQueue({ on: () => {} });
    const p1 = enqueueConfirm(spec());
    await new Promise((r) => setTimeout(r, 0));
    const p2 = enqueueConfirm(spec());
    await new Promise((r) => setTimeout(r, 0));
    fakeBrowser.tabs.onRemoved.trigger(100, { windowId: 1, isWindowClosing: false });
    expect(await p1).toBe('__closed__');
    expect(await p2).toBe('__closed__');
    expect(getPending()).toHaveLength(0);
  });
});
