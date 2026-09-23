// tests/settings/storage-page.test.tsx
// 存储管理页测试：用量渲染 / 清理二次确认 / 备份导出导入交互。
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { StoragePage } from '../../components/settings/StoragePage';
import type { StorageUsage } from '../../shared/messages';

const USAGE: StorageUsage = {
  totalBytes: 100,
  groups: [{ group: 'trace', bytes: 60, items: 2 }, { group: 'conv', bytes: 40, items: 1 }],
  traces: [{ convId: 'a', title: '会话A', bytes: 50 }, { convId: 'b', bytes: 10 }],
  gmResources: { bytes: 30, count: 3 },
};

function mockBg(handlers: Record<string, (msg: { type: string }) => unknown>) {
  vi.spyOn(browser.runtime, 'sendMessage').mockImplementation(async (msg: unknown) => {
    const m = msg as { type: string };
    return handlers[m.type]?.(m) ?? { ok: false, error: `no handler: ${m.type}` };
  });
}

beforeEach(() => {
  fakeBrowser.reset();
  vi.restoreAllMocks();
});
afterEach(cleanup);

describe('StoragePage 用量总览', () => {
  it('渲染各域中文名、条目数与字节', async () => {
    mockBg({ STORAGE_USAGE_GET: () => ({ ok: true, data: USAGE }) });
    render(<StoragePage onBack={() => {}} />);
    expect(await screen.findByText('Agent 调用记录')).toBeTruthy();
    expect(screen.getByText('会话本体')).toBeTruthy();
    expect(screen.getByText('2 项')).toBeTruthy();
    expect(screen.getByText('60 B')).toBeTruthy();
  });
});

describe('StoragePage 清理区', () => {
  it('GM 资源缓存清空：二次确认后发 STORAGE_CLEAN 并刷新', async () => {
    const clean = vi.fn(() => ({ ok: true }));
    mockBg({
      STORAGE_USAGE_GET: () => ({ ok: true, data: USAGE }),
      STORAGE_CLEAN: clean,
    });
    render(<StoragePage onBack={() => {}} />);
    const arm = await screen.findByRole('button', { name: '清空缓存' });
    fireEvent.click(arm); // 第一次：武装
    fireEvent.click(screen.getByRole('button', { name: '确认清空？' })); // 第二次：执行
    await waitFor(() => {
      expect(clean).toHaveBeenCalledWith({ type: 'STORAGE_CLEAN', scope: { kind: 'gm-resources' } });
    });
  });

  it('trace 按会话勾选清理：只带勾选的 convIds', async () => {
    const clean = vi.fn(() => ({ ok: true }));
    mockBg({
      STORAGE_USAGE_GET: () => ({ ok: true, data: USAGE }),
      STORAGE_CLEAN: clean,
    });
    render(<StoragePage onBack={() => {}} />);
    fireEvent.click(await screen.findByLabelText('会话A'));
    fireEvent.click(screen.getByRole('button', { name: '清理选中' }));
    fireEvent.click(screen.getByRole('button', { name: '确认清理？' }));
    await waitFor(() => {
      expect(clean).toHaveBeenCalledWith({ type: 'STORAGE_CLEAN', scope: { kind: 'trace', convIds: ['a'] } });
    });
  });
});
