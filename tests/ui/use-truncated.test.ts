// tests/ui/use-truncated.test.ts
import { describe, it, expect } from 'vitest';
import { measureTruncated } from '../../components/ui/useTruncated';

describe('measureTruncated', () => {
  it('内容宽于可视区 → 判定截断', () => {
    expect(measureTruncated({ scrollWidth: 384, clientWidth: 221 })).toBe(true);
  });

  it('内容装得下 → 不截断（短标题不该弹重复 tooltip）', () => {
    expect(measureTruncated({ scrollWidth: 45, clientWidth: 221 })).toBe(false);
  });

  it('刚好齐平 → 不截断', () => {
    expect(measureTruncated({ scrollWidth: 221, clientWidth: 221 })).toBe(false);
  });

  it('1px 亚像素差不算截断（避让圆整误差导致的假 tooltip）', () => {
    expect(measureTruncated({ scrollWidth: 222, clientWidth: 221 })).toBe(false);
    expect(measureTruncated({ scrollWidth: 223, clientWidth: 221 })).toBe(true);
  });

  it('未布局（宽度都是 0，如 jsdom）→ 不截断', () => {
    expect(measureTruncated({ scrollWidth: 0, clientWidth: 0 })).toBe(false);
  });
});
