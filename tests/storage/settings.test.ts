// tests/storage/settings.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { storage } from 'wxt/utils/storage';
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

  it('save 后可读回字段（全量段写入）', async () => {
    await saveSettings({ provider: { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-x', model: 'deepseek-chat' } });
    const s = await getSettings();
    expect(s.provider.baseUrl).toBe('https://api.deepseek.com/v1');
    expect(s.provider.model).toBe('deepseek-chat');
  });

  it('段内 merge：未提供的字段保留旧值', async () => {
    await saveSettings({ provider: { baseUrl: 'https://a.com/v1', apiKey: 'k', model: 'm' } });
    await saveSettings({ agent: { confirmGate: false } });
    const s = await getSettings();
    expect(s.provider.baseUrl).toBe('https://a.com/v1');
    expect(s.agent.confirmGate).toBe(false);
  });

  it('agent 段 merge：未提供字段保留默认值', async () => {
    await saveSettings({ agent: { confirmGate: false } });
    const s = await getSettings();
    expect(s.agent.confirmGate).toBe(false);
    expect(s.agent.screenshotPolicy).toBe('on-demand');
  });

  it('部分保存 agent 段不重置同段其他字段（段内 merge 回归）', async () => {
    await saveSettings({ agent: { confirmGate: false, screenshotPolicy: 'never' } });
    await saveSettings({ agent: { screenshotPolicy: 'on-demand' } });
    const s = await getSettings();
    expect(s.agent).toEqual({ screenshotPolicy: 'on-demand', confirmGate: false, networkCaptureHeaders: 'redacted', llmTimeoutSec: 120, llmMaxRetries: 2 });
  });

  it('saveSettings 持久化到 local:settings（fakeBrowser storage 驱动）', async () => {
    await saveSettings({ provider: { baseUrl: 'https://b.com/v1' } });
    const raw = await storage.getItem('local:settings');
    expect(raw).toEqual({
      provider: { baseUrl: 'https://b.com/v1', apiKey: '', model: '' },
      agent: DEFAULT_SETTINGS.agent,
    });
  });

  it('extraBody 可存可读回（对象原样保留）', async () => {
    await saveSettings({ provider: { extraBody: { enable_thinking: true, reasoning_effort: 'high' } } });
    const s = await getSettings();
    expect(s.provider.extraBody).toEqual({ enable_thinking: true, reasoning_effort: 'high' });
  });

  it('存量数据缺字段时 getSettings 用默认值补齐（前向兼容）', async () => {
    // 模拟旧版本写入的数据（如未来新增 agent 字段后，旧存量缺该字段）
    await storage.setItem('local:settings', {
      provider: { baseUrl: 'https://old.com/v1' },
      agent: { confirmGate: false },
    });
    const s = await getSettings();
    expect(s.provider).toEqual({ baseUrl: 'https://old.com/v1', apiKey: '', model: '' });
    expect(s.agent).toEqual({ screenshotPolicy: 'on-demand', confirmGate: false, networkCaptureHeaders: 'redacted', llmTimeoutSec: 120, llmMaxRetries: 2 });
  });

  it('AgentConfig 默认 networkCaptureHeaders=redacted', async () => {
    const s = await getSettings();
    expect(s.agent.networkCaptureHeaders).toBe('redacted');
  });

  it('可存 networkCaptureHeaders=full', async () => {
    await saveSettings({ agent: { networkCaptureHeaders: 'full' } });
    const s = await getSettings();
    expect(s.agent.networkCaptureHeaders).toBe('full');
  });
});

describe('agent 超时与重试配置', () => {
  beforeEach(() => fakeBrowser.reset());

  it('默认 llmTimeoutSec=120 / llmMaxRetries=2', async () => {
    const s = await getSettings();
    expect(s.agent.llmTimeoutSec).toBe(120);
    expect(s.agent.llmMaxRetries).toBe(2);
  });

  it('可存可读回超时与重试', async () => {
    await saveSettings({ agent: { llmTimeoutSec: 60, llmMaxRetries: 0 } });
    const s = await getSettings();
    expect(s.agent.llmTimeoutSec).toBe(60);
    expect(s.agent.llmMaxRetries).toBe(0);
  });

  it('存量数据缺新字段时用默认值补齐（前向兼容）', async () => {
    await storage.setItem('local:settings', {
      provider: { baseUrl: 'https://old.com/v1' },
      agent: { confirmGate: false },
    });
    const s = await getSettings();
    expect(s.agent.llmTimeoutSec).toBe(120);
    expect(s.agent.llmMaxRetries).toBe(2);
  });
});
