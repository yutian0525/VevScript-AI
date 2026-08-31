import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { buildProviderFromSettings, notifyCsReady, waitForCsReady } from '../../background/agent-port';
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
});
