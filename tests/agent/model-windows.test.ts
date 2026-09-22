import { describe, it, expect } from 'vitest';
import { resolveContextWindow, DEFAULT_CONTEXT_WINDOW } from '../../agent/model-windows';

describe('resolveContextWindow', () => {
  it('用户覆盖值优先级最高', () => {
    expect(resolveContextWindow('gpt-4o', 200000)).toBe(200000);
  });
  it('覆盖值为 0、负数、Infinity、NaN 视为未设置，回落映射', () => {
    expect(resolveContextWindow('gpt-4o', 0)).toBe(128000);
    expect(resolveContextWindow('gpt-4o', -5)).toBe(128000);
    expect(resolveContextWindow('gpt-4o', Infinity)).toBe(128000);
    expect(resolveContextWindow('gpt-4o', NaN)).toBe(128000);
  });
  it('按 model 名子串匹配映射（大小写不敏感）', () => {
    expect(resolveContextWindow('gpt-4o-2024-08-06')).toBe(128000);
    expect(resolveContextWindow('DeepSeek-Chat')).toBe(128000);
    expect(resolveContextWindow('claude-3-5-sonnet')).toBe(200000);
  });
  it('2026-09 档位刷新：新一代默认抬到 256k+，旧系列保留真实旧值', () => {
    expect(resolveContextWindow('deepseek-v3.2')).toBe(128000);
    expect(resolveContextWindow('kimi-k2-0905-preview')).toBe(256000);
    expect(resolveContextWindow('moonshot-v1-128k')).toBe(128000); // 旧系列不被 kimi 抬高误伤
    expect(resolveContextWindow('qwen3-max')).toBe(256000);
    expect(resolveContextWindow('glm-4.6')).toBe(200000);
    expect(resolveContextWindow('gpt-5')).toBe(400000);
  });
  it('重叠前缀按表顺序取首个匹配', () => {
    expect(resolveContextWindow('gpt-4-turbo')).toBe(128000);
    expect(resolveContextWindow('gpt-4.1-mini')).toBe(1000000);
    expect(resolveContextWindow('gpt-4-vision-preview')).toBe(8192);
  });
  it('匹配不到给默认值', () => {
    expect(resolveContextWindow('some-proxy-model-x')).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(DEFAULT_CONTEXT_WINDOW).toBe(256000);
  });
  it('空 model 名给默认值', () => {
    expect(resolveContextWindow('')).toBe(256000);
    expect(resolveContextWindow(undefined)).toBe(256000);
  });
});
