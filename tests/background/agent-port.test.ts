import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { vi } from 'vitest';
import { buildProviderFromSettings, notifyCsReady, waitForCsReady, stopConv, resolveOpenedTab } from '../../background/agent-port';
import { saveSettings } from '../../storage/settings';

describe('agent-port 辅助', () => {
  beforeEach(() => fakeBrowser.reset());

  it('settings 完整时构造 provider', async () => {
    await saveSettings({ provider: { baseUrl: 'https://api.x.com/v1', apiKey: 'k', model: 'm' } });
    const p = await buildProviderFromSettings();
    expect(p).not.toBeNull();
  });

  it('settings 缺失时返回 null', async () => {
    await saveSettings({ provider: { baseUrl: '', apiKey: '', model: '' } });
    const p = await buildProviderFromSettings();
    expect(p).toBeNull();
  });

  it('waitForCsReady 在 notifyCsReady 后 resolve', async () => {
    const wait = waitForCsReady(42, 1000);
    notifyCsReady(42);
    await expect(wait).resolves.toBeUndefined();
  });

  it('waitForCsReady 超时也 resolve（不阻塞 loop）', async () => {
    await expect(waitForCsReady(99, 50)).resolves.toBeUndefined();
  });

  it('stopConv 对未运行的会话是幂等 no-op（不抛）', () => {
    // 运行中 loop 的真正中断由 loop.ts 的 abort 测试覆盖；此处只验导出契约 + 未运行时安全
    expect(() => stopConv('nonexistent-conv')).not.toThrow();
  });

  describe('resolveOpenedTab（交互后新标签探测）', () => {
    it('命中以 opener 为父且激活的标签 → 等就绪并返回其 id', async () => {
      fakeBrowser.tabs.query = vi.fn().mockResolvedValue([
        { id: 50, openerTabId: undefined, active: false },
        { id: 888, openerTabId: 50, active: true },
      ]) as never;
      const waitReady = vi.fn().mockResolvedValue(undefined);
      const id = await resolveOpenedTab(50, waitReady);
      expect(id).toBe(888);
      expect(waitReady).toHaveBeenCalledWith(888);
    });

    it('无以 opener 为父的激活标签（普通同页点击）→ undefined，不等就绪', async () => {
      fakeBrowser.tabs.query = vi.fn().mockResolvedValue([
        { id: 50, openerTabId: undefined, active: true },
      ]) as never;
      const waitReady = vi.fn();
      const id = await resolveOpenedTab(50, waitReady);
      expect(id).toBeUndefined();
      expect(waitReady).not.toHaveBeenCalled();
    });

    it('子标签存在但未激活（曾开过、已切回原标签）→ undefined', async () => {
      fakeBrowser.tabs.query = vi.fn().mockResolvedValue([
        { id: 50, openerTabId: undefined, active: true },
        { id: 601, openerTabId: 50, active: false }, // 历史子标签，非本次点击所开
      ]) as never;
      const id = await resolveOpenedTab(50, vi.fn());
      expect(id).toBeUndefined();
    });

    it('多个激活子标签 → 取 tab id 最大（最新）', async () => {
      fakeBrowser.tabs.query = vi.fn().mockResolvedValue([
        { id: 601, openerTabId: 50, active: true },
        { id: 777, openerTabId: 50, active: true },
      ]) as never;
      const id = await resolveOpenedTab(50, vi.fn().mockResolvedValue(undefined));
      expect(id).toBe(777);
    });

    it('query 抛错 → 安全返回 undefined', async () => {
      fakeBrowser.tabs.query = vi.fn().mockRejectedValue(new Error('boom')) as never;
      const id = await resolveOpenedTab(50, vi.fn());
      expect(id).toBeUndefined();
    });
  });
});
