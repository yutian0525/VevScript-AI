// tests/stores/deep-observe.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { useDeepObserve } from '../../stores/deep-observe';

beforeEach(() => {
  fakeBrowser.reset();
  useDeepObserve.setState({ states: {} });
});

describe('deep-observe store', () => {
  it('applyState 按 tabId 写入', () => {
    useDeepObserve.getState().applyState({ tabId: 1, status: 'on' });
    expect(useDeepObserve.getState().states[1]).toEqual({ tabId: 1, status: 'on' });
  });

  it('fetchState 拉取并落库', async () => {
    fakeBrowser.runtime.sendMessage = (async () => ({ ok: true, data: { tabId: 2, status: 'off' } })) as never;
    await useDeepObserve.getState().fetchState(2);
    expect(useDeepObserve.getState().states[2]).toEqual({ tabId: 2, status: 'off' });
  });

  it('fetchState 后台抛错时静默（保持未知态）', async () => {
    fakeBrowser.runtime.sendMessage = (async () => { throw new Error('no bg'); }) as never;
    await expect(useDeepObserve.getState().fetchState(3)).resolves.toBeUndefined();
    expect(useDeepObserve.getState().states[3]).toBeUndefined();
  });

  it('setEnabled 成功时写入返回态', async () => {
    fakeBrowser.runtime.sendMessage = (async () => ({ ok: true, data: { tabId: 4, status: 'on' } })) as never;
    await useDeepObserve.getState().setEnabled(4, true);
    expect(useDeepObserve.getState().states[4]).toEqual({ tabId: 4, status: 'on' });
  });

  it('setEnabled 失败时写 error 态（开关据此转 warn 色）', async () => {
    fakeBrowser.runtime.sendMessage = (async () => ({ ok: false, error: '附着失败：Another debugger is already attached' })) as never;
    await useDeepObserve.getState().setEnabled(5, true);
    const s = useDeepObserve.getState().states[5]!;
    expect(s.status).toBe('error');
    expect(s.reason).toContain('附着失败');
  });

  it('setEnabled 通道异常时也写 error 态', async () => {
    fakeBrowser.runtime.sendMessage = (async () => { throw new Error('disconnected'); }) as never;
    await useDeepObserve.getState().setEnabled(6, true);
    expect(useDeepObserve.getState().states[6]!.status).toBe('error');
  });
});
