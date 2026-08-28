// tests/storage/settings.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { getSettings, saveSettings, DEFAULT_SETTINGS } from '../../storage/settings';

describe('settings storage', () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  it('无配置时返回默认值', async () => {
    const s = await getSettings();
    expect(s).toEqual(DEFAULT_SETTINGS);
    expect(s.provider.baseUrl).toBe('');
  });

  it('save 后可读回字段（整段替换）', async () => {
    await saveSettings({ provider: { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-x', model: 'deepseek-chat' } });
    const s = await getSettings();
    expect(s.provider.baseUrl).toBe('https://api.deepseek.com/v1');
    expect(s.provider.model).toBe('deepseek-chat');
  });

  it('段内 merge：未提供的字段保留旧值', async () => {
    await saveSettings({ provider: { baseUrl: 'https://a.com/v1', apiKey: 'k', model: 'm' } });
    await saveSettings({ agent: { maxSteps: 50 } });
    const s = await getSettings();
    expect(s.provider.baseUrl).toBe('https://a.com/v1');
    expect(s.agent.maxSteps).toBe(50);
  });

  it('agent 段 merge：未提供字段保留默认值', async () => {
    await saveSettings({ agent: { maxSteps: 50 } });
    const s = await getSettings();
    expect(s.agent.maxSteps).toBe(50);
    expect(s.agent.confirmGate).toBe(true);
    expect(s.agent.screenshotPolicy).toBe('on-demand');
  });
});
