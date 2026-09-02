// tests/agent/compact.test.ts
import { describe, it, expect } from 'vitest';
import { splitForCompaction, estimateContextTokens, KEEP_RECENT_ORIGINALS } from '../../agent/compact';
import type { ChatMessage } from '../../agent/provider/types';

const mk = (n: number): ChatMessage[] =>
  Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }) as ChatMessage);

describe('splitForCompaction', () => {
  it('保留边界常量 = 20', () => {
    expect(KEEP_RECENT_ORIGINALS).toBe(20);
  });
  it('首次压缩：N=30 无 coversUpTo → 摘要前 10 条，边界 9', () => {
    const r = splitForCompaction(mk(30), undefined, 20)!;
    expect(r.segment).toHaveLength(10);
    expect(r.newCoversUpTo).toBe(9);
  });
  it('消息不够老（N=15 < keep+1）→ null', () => {
    expect(splitForCompaction(mk(15), undefined, 20)).toBeNull();
  });
  it('已摘要覆盖足够（N=25, coversUpTo=9）→ null（不重复摘要，边界不倒退）', () => {
    expect(splitForCompaction(mk(25), 9, 20)).toBeNull();
  });
  it('增量压缩：N=50, coversUpTo=9 → 摘要 idx10-29，边界 29', () => {
    const r = splitForCompaction(mk(50), 9, 20)!;
    expect(r.segment).toHaveLength(20);
    expect(r.newCoversUpTo).toBe(29);
  });
});

describe('estimateContextTokens', () => {
  it('按字符数 / 2 估算（摘要 + 保留消息文本）', () => {
    const kept: ChatMessage[] = [{ role: 'user', content: 'abcd' }];
    // summary 'xy'(2) + 'abcd'(4) = 6 → ceil(6/2)=3
    expect(estimateContextTokens(kept, 'xy')).toBe(3);
  });
  it('content 为 parts 数组时只计文本 part', () => {
    const kept: ChatMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', imageUrl: 'x' }] }];
    // 'hi'(2) + summary ''(0) = 2 → 1
    expect(estimateContextTokens(kept, '')).toBe(1);
  });
});
