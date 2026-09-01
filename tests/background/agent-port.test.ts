import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { buildProviderFromSettings, notifyCsReady, waitForCsReady, stopTab } from '../../background/agent-port';
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

  it('stopTab 对未运行的 tab 是幂等 no-op（不抛）', () => {
    // 运行中 loop 的真正中断由 loop.ts 的 abort 测试覆盖；此处只验导出契约 + 未运行时安全
    expect(() => stopTab(12345)).not.toThrow();
  });
});
