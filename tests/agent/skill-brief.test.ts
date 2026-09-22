// tests/agent/skill-brief.test.ts
import { describe, it, expect } from 'vitest';
import {
  selectSkillBriefs, truncateDescription, SKILL_LIST_CAP, SKILL_DESC_MAX, type SkillBrief,
} from '../../agent/skill-brief';

const b = (over: Partial<SkillBrief> = {}): SkillBrief =>
  ({ name: 'N', command: 'c', description: 'd', createdAt: 1, ...over });

describe('truncateDescription', () => {
  it('未超限原样返回', () => {
    expect(truncateDescription('短描述')).toBe('短描述');
  });

  it('超限在最后一个「；」处截断并加省略号', () => {
    const d = '介绍本扩展的功能与用法；当用户询问扩展能做什么、怎么用时触发；还有后半句没用的补充说明文字';
    const out = truncateDescription(d, 40);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(41);
    expect(out).not.toContain('还有后半句');
  });

  it('超限在最后一个「，」处截断（无「；」时）', () => {
    const d = '第一段说明文字，第二段说明文字，第三段说明文字，第四段很长的补充说明文字啊啊啊';
    const out = truncateDescription(d, 20);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(21);
  });

  it('limit 之前无分隔符则硬切', () => {
    expect(truncateDescription('x'.repeat(100), 10)).toBe(`${'x'.repeat(10)}…`);
  });

  it('默认 limit = SKILL_DESC_MAX', () => {
    expect(truncateDescription('x'.repeat(200)).length).toBe(SKILL_DESC_MAX + 1);
  });
});

describe('selectSkillBriefs', () => {
  it('内置在前（createdAt 升序 = builtin.md 顺序），用户技能在后（createdAt 降序，最新在前）', () => {
    const { shown } = selectSkillBriefs([
      b({ command: 'u-old', createdAt: 10 }),
      b({ command: 'bi-2', builtin: true, createdAt: 2 }),
      b({ command: 'u-new', createdAt: 30 }),
      b({ command: 'bi-1', builtin: true, createdAt: 1 }),
    ]);
    expect(shown.map((s) => s.command)).toEqual(['bi-1', 'bi-2', 'u-new', 'u-old']);
  });

  it('内置不占名额：4 内置 + 20 用户 = 24 条全出，hidden=0', () => {
    const builtins = Array.from({ length: 4 }, (_, i) => b({ command: `bi-${i}`, builtin: true, createdAt: i }));
    const users = Array.from({ length: 20 }, (_, i) => b({ command: `u${i}`, createdAt: i }));
    const { shown, hidden } = selectSkillBriefs([...builtins, ...users]);
    expect(shown).toHaveLength(24);
    expect(hidden).toBe(0);
  });

  it('用户技能超 20 只出 20，hidden 计数正确', () => {
    const users = Array.from({ length: 25 }, (_, i) => b({ command: `u${i}`, createdAt: i }));
    const { shown, hidden } = selectSkillBriefs(users);
    expect(shown).toHaveLength(SKILL_LIST_CAP);
    expect(hidden).toBe(5);
  });

  it('同 createdAt 用 command 字典序兜底（全序，locale 无关）', () => {
    const { shown } = selectSkillBriefs([
      b({ command: 'b', createdAt: 5 }), b({ command: 'a', createdAt: 5 }), b({ command: 'c', createdAt: 5 }),
    ]);
    expect(shown.map((s) => s.command)).toEqual(['a', 'b', 'c']);
  });

  it('空输入 → 空结果', () => {
    expect(selectSkillBriefs([])).toEqual({ shown: [], hidden: 0 });
  });
});
