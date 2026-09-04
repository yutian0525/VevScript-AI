import { describe, it, expect } from 'vitest';
import { TOOL_TAGS, GROUPS } from '../../components/debug/tool-tags';
import { TOOL_SCHEMAS } from '../../agent/tools/schemas';

describe('TOOL_TAGS 完备性', () => {
  it('每个工具都有 tag', () => {
    for (const t of TOOL_SCHEMAS) {
      expect(TOOL_TAGS[t.function.name], `工具 ${t.function.name} 缺 tag`).toBeDefined();
    }
  });

  it('四类计数 PAGE 10 / TABS 5 / NET 4 / SCRIPTS 6', () => {
    const count = (tag: string) => Object.values(TOOL_TAGS).filter((v) => v === tag).length;
    expect(count('PAGE')).toBe(10);
    expect(count('TABS')).toBe(5);
    expect(count('NET')).toBe(4);
    expect(count('SCRIPTS')).toBe(6);
  });

  it('TOOL_TAGS 键集 = TOOL_SCHEMAS 名字集（无多余、无遗漏）', () => {
    const names = new Set(TOOL_SCHEMAS.map((t) => t.function.name));
    expect(new Set(Object.keys(TOOL_TAGS))).toEqual(names);
  });

  it('GROUPS 按组序 PAGE/TABS/NET/SCRIPTS', () => {
    expect(GROUPS.map((g) => g.key)).toEqual(['PAGE', 'TABS', 'NET', 'SCRIPTS']);
  });
});
