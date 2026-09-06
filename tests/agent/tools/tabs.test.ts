import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { doListPages, doNewPage, doClosePage, doSelectPage } from '../../../agent/tools/tabs';

describe('标签页工具', () => {
  beforeEach(() => fakeBrowser.reset());

  it('list_pages 返回标签列表并标注 isTarget', async () => {
    fakeBrowser.tabs.query = vi.fn().mockResolvedValue([
      { id: 1, url: 'https://a.com', title: 'A', active: true },
      { id: 2, url: 'https://b.com', title: 'B', active: false },
    ]) as never;
    const r = await doListPages(2);
    expect(r.ok).toBe(true);
    const pages = (r as { data: { pages: Array<{ tabId: number; isTarget: boolean }> } }).data.pages;
    expect(pages).toHaveLength(2);
    expect(pages.find((p) => p.tabId === 2)!.isTarget).toBe(true);
    expect(pages.find((p) => p.tabId === 1)!.isTarget).toBe(false);
  });

  it('new_page 创建标签并返回 targetTab', async () => {
    const create = vi.fn().mockResolvedValue({ id: 99, url: 'https://x.com' });
    fakeBrowser.tabs.create = create as never;
    const waitForReady = vi.fn().mockResolvedValue(undefined);
    const r = await doNewPage({ url: 'https://x.com', background: true }, waitForReady);
    expect(r.ok).toBe(true);
    expect((r as { data: { targetTab: number } }).data.targetTab).toBe(99);
    expect(create).toHaveBeenCalledWith({ url: 'https://x.com', active: false });
    expect(waitForReady).toHaveBeenCalledWith(99);
  });

  it('new_page 缺 url 报错', async () => {
    const r = await doNewPage({ url: '' }, vi.fn());
    expect(r.ok).toBe(false);
  });

  it('close_page 返回 closed', async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    fakeBrowser.tabs.remove = remove as never;
    const r = await doClosePage({ tabId: 5 });
    expect(r.ok).toBe(true);
    expect((r as { data: { closed: number } }).data.closed).toBe(5);
    expect(remove).toHaveBeenCalledWith(5);
  });

  it('select_page 激活并返回 targetTab', async () => {
    const update = vi.fn().mockResolvedValue({ id: 7, url: 'https://c.com' });
    fakeBrowser.tabs.update = update as never;
    const r = await doSelectPage({ tabId: 7 });
    expect(r.ok).toBe(true);
    expect((r as { data: { targetTab: number } }).data.targetTab).toBe(7);
    expect(update).toHaveBeenCalledWith(7, { active: true });
  });

  it('select_page 无效 tabId 报错', async () => {
    fakeBrowser.tabs.update = vi.fn().mockRejectedValue(new Error('No tab with id')) as never;
    const r = await doSelectPage({ tabId: 123 });
    expect(r.ok).toBe(false);
  });
});
