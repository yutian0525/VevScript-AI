// tests/ui/deep-observe-toggle.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { DeepObserveToggle } from '../../components/chat/DeepObserveToggle';
import { useDeepObserve } from '../../stores/deep-observe';

afterEach(cleanup);

let sent: unknown[];

beforeEach(() => {
  fakeBrowser.reset();
  useDeepObserve.setState({ states: {} });
  sent = [];
  fakeBrowser.tabs.query = (async () => [{ id: 7 }]) as never;
  fakeBrowser.runtime.sendMessage = (async (msg: unknown) => {
    sent.push(msg);
    const m = msg as { type: string; tabId: number; enabled?: boolean };
    if (m.type === 'DEEP_OBSERVE_GET') return { ok: true, data: { tabId: m.tabId, status: 'off' } };
    return { ok: true, data: { tabId: m.tabId, status: m.enabled ? 'on' : 'off' } };
  }) as never;
});

describe('DeepObserveToggle', () => {
  it('挂载时拉取当前标签页状态', async () => {
    render(<DeepObserveToggle />);
    await waitFor(() => expect(sent.some((m) => (m as { type: string }).type === 'DEEP_OBSERVE_GET')).toBe(true));
  });

  it('默认渲染关态，aria-label 提示点击开启', async () => {
    render(<DeepObserveToggle />);
    const btn = await screen.findByRole('button', { name: /深度观测/ });
    expect(btn.className).toContain('deepobs--off');
    expect(btn.getAttribute('aria-label')).toContain('点击开启');
  });

  it('点击后发出 SET enabled=true 并转开态', async () => {
    render(<DeepObserveToggle />);
    const btn = await screen.findByRole('button', { name: /深度观测/ });
    fireEvent.click(btn);
    await waitFor(() => expect(btn.className).toContain('deepobs--on'));
    expect(sent.some((m) => (m as { type: string; enabled?: boolean }).enabled === true)).toBe(true);
  });

  it('广播到达时更新为 error 态（DevTools 抢占）', async () => {
    render(<DeepObserveToggle />);
    const btn = await screen.findByRole('button', { name: /深度观测/ });
    await waitFor(() => expect(sent.length).toBeGreaterThan(0));
    // 模拟 SW 广播：beforeEach 的 mock 覆写了 runtime.sendMessage，同页消息不会转发给组件的
    // onMessage 监听器（brief 注明的退化路径）——直接把广播载荷落进 store，等价于监听器收到后 applyState。
    useDeepObserve.getState().applyState({ tabId: 7, status: 'error', reason: '页面 DevTools 占用中' });
    await waitFor(() => expect(useDeepObserve.getState().states[7]?.status).toBe('error'));
    expect(btn.className).toContain('deepobs--error');
  });

  it('error 态点击重试开启：发出 enabled=true 而非 false', async () => {
    render(<DeepObserveToggle />);
    const btn = await screen.findByRole('button', { name: /深度观测/ });
    await waitFor(() => expect(sent.length).toBeGreaterThan(0));
    // 前情：本页处于 error 态（DevTools 抢占）
    useDeepObserve.getState().applyState({ tabId: 7, status: 'error', reason: '页面 DevTools 占用中' });
    await waitFor(() => expect(btn.className).toContain('deepobs--error'));
    fireEvent.click(btn);
    // 点击本身不改本地态：SW 回话前类名仍是 error（同步窗口内断言，尚无重渲染）
    expect(btn.className).toContain('deepobs--error');
    // 回归核心：error 态点击发的是重试开启（enabled=true），而非误发关闭（enabled=false）
    const sets = sent.filter((m) => (m as { type: string }).type === 'DEEP_OBSERVE_SET') as Array<{ enabled?: boolean }>;
    expect(sets).toHaveLength(1);
    expect(sets[0]!.enabled).toBe(true);
  });

  it('disabled 时按钮禁用', async () => {
    render(<DeepObserveToggle disabled />);
    const btn = await screen.findByRole('button', { name: /深度观测/ });
    expect(btn).toBeDisabled();
  });
});
