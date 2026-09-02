import { describe, it, expect } from 'vitest';
import { redactHeaders, SENSITIVE_HEADERS } from '../../observe/redact';

describe('redactHeaders', () => {
  it('redacted 模式：敏感头替换为 [REDACTED]', () => {
    const out = redactHeaders({ Authorization: 'Bearer x', 'Content-Type': 'application/json' }, 'redacted');
    expect(out.authorization).toBe('[REDACTED]');
    expect(out['content-type']).toBe('application/json');
  });

  it('full 模式：原文保留（仅长度截断）', () => {
    const out = redactHeaders({ Authorization: 'Bearer secret' }, 'full');
    expect(out.authorization).toBe('Bearer secret');
  });

  it('key 归一化为小写', () => {
    const out = redactHeaders({ 'X-Custom': 'v' }, 'redacted');
    expect(out['x-custom']).toBe('v');
  });

  it('超长头值截断', () => {
    const out = redactHeaders({ 'x-big': 'v'.repeat(5000) }, 'full');
    expect(out['x-big']!.length).toBeLessThanOrEqual(2050);
    expect(out['x-big']!.endsWith('…')).toBe(true);
  });

  it('条数超上限截断并标注', () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 100; i++) many[`h${i}`] = String(i);
    const out = redactHeaders(many, 'full', 30);
    expect(Object.keys(out).length).toBeLessThanOrEqual(31); // 30 + 一条 __truncated__ 标注
    expect(out.__truncated__).toContain('头过多');
  });

  it('SENSITIVE_HEADERS 覆盖常见凭证头', () => {
    for (const h of ['authorization', 'cookie', 'set-cookie', 'proxy-authorization']) {
      expect(SENSITIVE_HEADERS.has(h)).toBe(true);
    }
  });

  it('undefined 入参返回空对象', () => {
    expect(redactHeaders(undefined, 'redacted')).toEqual({});
  });
});
