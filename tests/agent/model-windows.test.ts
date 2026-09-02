import { describe, it, expect } from 'vitest';
import { resolveContextWindow, DEFAULT_CONTEXT_WINDOW } from '../../agent/model-windows';

describe('resolveContextWindow', () => {
  it('用户覆盖值优先级最高', () => {
    expect(resolveContextWindow('gpt-4o', 200000)).toBe(200000);
  });
  it('覆盖值为 0 或负数视为未设置，回落映射', () => {
    expect(resolveContextWindow('gpt-4o', 0)).toBe(128000);
    expect(resolveContextWindow('gpt-4o', -5)).toBe(128000);
  });
  it('按 model 名子串匹配映射（大小写不敏感）', () => {
    expect(resolveContextWindow('gpt-4o-2024-08-06')).toBe(128000);
    expect(resolveContextWindow('DeepSeek-Chat')).toBe(64000);
    expect(resolveContextWindow('claude-3-5-sonnet')).toBe(200000);
  });
  it('匹配不到给默认值', () => {
    expect(resolveContextWindow('some-proxy-model-x')).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(DEFAULT_CONTEXT_WINDOW).toBe(128000);
  });
  it('空 model 名给默认值', () => {
    expect(resolveContextWindow('')).toBe(128000);
    expect(resolveContextWindow(undefined)).toBe(128000);
  });
});
