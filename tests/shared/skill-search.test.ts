// tests/shared/skill-search.test.ts
// 技能模糊检索（spec §7.4）：五档打分 + 同分 command 字典序兜底（确定性）。
import { describe, it, expect } from 'vitest';
import { searchSkills } from '../../shared/skill-search';

const s = (command: string, name = 'N', description = 'd') =>
  ({ id: command, command, name, description, enabled: true, updatedAt: 1, contentChars: 10 });

const cmds = (r: { skill: { command: string } }[]) => r.map((h) => h.skill.command);

describe('searchSkills', () => {
  it('空 query → 原序全量', () => {
    const all = [s('b'), s('a'), s('c')];
    expect(cmds(searchSkills(all, ''))).toEqual(['b', 'a', 'c']);
    expect(cmds(searchSkills(all, '   '))).toEqual(['b', 'a', 'c']);
  });

  it('command 精确命中置顶', () => {
    const all = [s('write-script'), s('script-helper'), s('script')];
    expect(cmds(searchSkills(all, 'script'))[0]).toBe('script');
  });

  it('command 子串命中排在 name 子串之前', () => {
    const all = [s('zzz', 'script 助手'), s('script-x', '别的')];
    expect(cmds(searchSkills(all, 'script'))).toEqual(['script-x', 'zzz']);
  });

  it('中文按子串命中 name 与 description', () => {
    const all = [s('a', '网页翻译', '把当前页翻成中文'), s('b', '别的', '无关')];
    expect(cmds(searchSkills(all, '翻译'))).toEqual(['a']);
    expect(cmds(searchSkills(all, '翻成中文'))).toEqual(['a']);
  });

  it('字符子序列兜底：wscr → write-script', () => {
    const all = [s('write-script', '写脚本'), s('unrelated', '无关')];
    expect(cmds(searchSkills(all, 'wscr'))).toEqual(['write-script']);
  });

  it('大小写不敏感', () => {
    const all = [s('Write-Script', 'X')];
    expect(cmds(searchSkills(all, 'WRITE'))).toEqual(['Write-Script']);
  });

  it('命中 0 个 → 空数组', () => {
    expect(searchSkills([s('a')], 'zzzzz')).toEqual([]);
  });

  it('同分按 command 字典序兜底（确定性）', () => {
    const all = [s('zz', '同名', '同描述'), s('aa', '同名', '同描述')];
    expect(cmds(searchSkills(all, '同名'))).toEqual(['aa', 'zz']);
  });
});
