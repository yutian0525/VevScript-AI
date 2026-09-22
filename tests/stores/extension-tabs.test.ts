// tests/stores/extension-tabs.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { openExtensionTab } from '../../stores/extension-tabs';

describe('openExtensionTab', () => {
  beforeEach(() => { fakeBrowser.reset(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('无已开标签页 → tabs.create 带 convId 参数', async () => {
    vi.spyOn(browser.tabs, 'query').mockResolvedValue([] as never);
    const create = vi.spyOn(browser.tabs, 'create').mockResolvedValue({ id: 1 } as never);
    await openExtensionTab('/conv-debug.html', { convId: 'abc' });
    expect(create).toHaveBeenCalledTimes(1);
    const arg = create.mock.calls[0]![0] as { url: string; active: boolean };
    expect(arg.url).toContain('/conv-debug.html?convId=abc');
    expect(arg.active).toBe(true);
  });

  it('无 convId 时不带查询串', async () => {
    vi.spyOn(browser.tabs, 'query').mockResolvedValue([] as never);
    const create = vi.spyOn(browser.tabs, 'create').mockResolvedValue({ id: 1 } as never);
    await openExtensionTab('/conv-debug.html');
    const arg = create.mock.calls[0]![0] as { url: string };
    expect(arg.url).not.toContain('?');
  });

  it('已开 → tabs.update 导航 + 聚焦，不再 create', async () => {
    vi.spyOn(browser.tabs, 'query').mockResolvedValue([{ id: 7 }] as never);
    const update = vi.spyOn(browser.tabs, 'update').mockResolvedValue({ id: 7 } as never);
    const create = vi.spyOn(browser.tabs, 'create').mockResolvedValue({ id: 8 } as never);
    await openExtensionTab('/conv-debug.html', { convId: 'xyz' });
    expect(update).toHaveBeenCalledTimes(1);
    const [tabId, props] = update.mock.calls[0]! as unknown as [number, { url: string; active: boolean }];
    expect(tabId).toBe(7);
    expect(props.url).toContain('convId=xyz');
    expect(props.active).toBe(true);
    expect(create).not.toHaveBeenCalled();
  });

  it('convId 做 URL 编码', async () => {
    vi.spyOn(browser.tabs, 'query').mockResolvedValue([] as never);
    const create = vi.spyOn(browser.tabs, 'create').mockResolvedValue({ id: 1 } as never);
    await openExtensionTab('/conv-debug.html', { convId: 'a b/c' });
    const arg = create.mock.calls[0]![0] as { url: string };
    expect(arg.url).toContain('convId=a%20b%2Fc');
  });
});
