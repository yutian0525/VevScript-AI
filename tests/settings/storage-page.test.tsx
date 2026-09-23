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

  it('清理失败：行内报错可见', async () => {
    mockBg({
      STORAGE_USAGE_GET: () => ({ ok: true, data: USAGE }),
      STORAGE_CLEAN: () => ({ ok: false, error: 'boom' }),
    });
    render(<StoragePage onBack={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: '清空缓存' })); // 第一次：武装
    fireEvent.click(screen.getByRole('button', { name: '确认清空？' })); // 第二次：执行
    expect(await screen.findByText('清理失败：boom')).toBeTruthy();
  });
});

describe('StoragePage 备份区', () => {
  beforeEach(() => {
    // downloads/reload 直赋桩不进 restoreAllMocks 回收链，用完即删防泄漏给后续用例
    delete (browser as unknown as Record<string, unknown>).downloads;
    delete (browser.runtime as unknown as Record<string, unknown>).reload;
  });

  it('导出：勾选不含 Key → 发 STORAGE_EXPORT 且用返回的 filename 下载', async () => {
    const download = vi.fn(async () => 1);
    (browser as unknown as Record<string, unknown>).downloads = { download };
    mockBg({
      STORAGE_USAGE_GET: () => ({ ok: true, data: USAGE }),
      STORAGE_EXPORT: (m) => {
        expect((m as unknown as { includeApiKey: boolean }).includeApiKey).toBe(false); // 默认不勾
        return { ok: true, data: { filename: 'vevscript-ai-backup-v1.0.0-20260922.json', dataUrl: 'data:application/json;base64,e30=' } };
      },
    });
    render(<StoragePage onBack={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: '导出全部数据' }));
    await waitFor(() => {
      expect(download).toHaveBeenCalledWith(expect.objectContaining({ filename: 'vevscript-ai-backup-v1.0.0-20260922.json' }));
    });
  });

  it('导入：选文件 → 确认卡 → 发 STORAGE_IMPORT → apiKeyMissing 提示后 reload', async () => {
    const reload = vi.fn();
    (browser.runtime as unknown as { reload: () => void }).reload = reload;
    mockBg({
      STORAGE_USAGE_GET: () => ({ ok: true, data: USAGE }),
      STORAGE_IMPORT: () => ({ ok: true, data: { apiKeyMissing: true } }),
    });
    render(<StoragePage onBack={() => {}} />);
    const input = await screen.findByTestId('stor-import-input') as HTMLInputElement;
    const file = new File(['{"meta":{},"data":{}}'], 'backup.json', { type: 'application/json' });
    await waitFor(() => fireEvent.change(input, { target: { files: [file] } }));
    // 文件异步读入后出确认卡
    fireEvent.click(await screen.findByRole('button', { name: '确认导入' }));
    expect(await screen.findByText(/备份未含 API Key/)).toBeTruthy(); // 简报原文正则 /API Key 未包含/ 与实现文案「备份未含 API Key」词序不一致，按实现文案断言（意图不变：确认 apiKeyMissing 提示出现）
    // reload 延迟 1200ms 触发，放宽 waitFor 窗口等真实定时器
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1), { timeout: 3000 });
  });

  it('导入失败：行内报错，不 reload', async () => {
    const reload = vi.fn();
    (browser.runtime as unknown as { reload: () => void }).reload = reload;
    mockBg({
      STORAGE_USAGE_GET: () => ({ ok: true, data: USAGE }),
      STORAGE_IMPORT: () => ({ ok: false, error: '不是本扩展的完整备份文件（缺少有效文件头）' }),
    });
    render(<StoragePage onBack={() => {}} />);
    const input = await screen.findByTestId('stor-import-input') as HTMLInputElement;
    const file = new File(['garbage'], 'backup.json', { type: 'application/json' });
    await waitFor(() => fireEvent.change(input, { target: { files: [file] } }));
    fireEvent.click(await screen.findByRole('button', { name: '确认导入' }));
    expect(await screen.findByText('不是本扩展的完整备份文件（缺少有效文件头）')).toBeTruthy();
    expect(reload).not.toHaveBeenCalled();
  });
});
