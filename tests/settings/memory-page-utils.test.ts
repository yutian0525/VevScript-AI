// tests/settings/memory-page-utils.test.ts
import { describe, it, expect } from 'vitest';
import { parsePatternLines, invalidPatterns, filterMemories } from '../../components/settings/memory-page-utils';
import type { MemoryEntry } from '../../shared/types';

function mk(over: Partial<MemoryEntry> = {}): MemoryEntry {
  return { id: 'm1', content: '正文', matches: [], source: 'ai', createdAt: 1, updatedAt: 1, ...over };
}

describe('parsePatternLines', () => {
  it('按行拆分并去掉空行与首尾空白', () => {
    expect(parsePatternLines(' *://a.com/* \n\n  *://b.com/*  \n')).toEqual(['*://a.com/*', '*://b.com/*']);
  });
  it('全空 → 空数组（= 全局记忆）', () => {
    expect(parsePatternLines('')).toEqual([]);
    expect(parsePatternLines('  \n \n ')).toEqual([]);
  });
  it('CRLF 也能拆', () => {
    expect(parsePatternLines('*://a.com/*\r\n*://b.com/*')).toEqual(['*://a.com/*', '*://b.com/*']);
  });
});

describe('invalidPatterns', () => {
  it('返回非法行，合法的不返回', () => {
    expect(invalidPatterns(['*://a.com/*', '乱写', '<all_urls>'])).toEqual(['乱写']);
  });
  it('全合法 → 空数组', () => {
    expect(invalidPatterns(['*://a.com/*'])).toEqual([]);
  });
});

describe('filterMemories', () => {
  const list = [
    mk({ id: 'a', content: '偏好中文回复' }),
    mk({ id: 'b', content: 'B 站登录', matches: ['*://*.bilibili.com/*'] }),
  ];
  it('空查询 → 原样返回', () => {
    expect(filterMemories(list, '')).toHaveLength(2);
    expect(filterMemories(list, '   ')).toHaveLength(2);
  });
  it('匹配正文子串', () => {
    expect(filterMemories(list, '中文').map((m) => m.id)).toEqual(['a']);
  });
  it('匹配作用域子串，大小写不敏感', () => {
    expect(filterMemories(list, 'BILIBILI').map((m) => m.id)).toEqual(['b']);
  });
  it('无命中 → 空数组', () => {
    expect(filterMemories(list, 'zzz')).toEqual([]);
  });
});
