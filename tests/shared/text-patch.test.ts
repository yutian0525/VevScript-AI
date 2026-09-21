// tests/shared/text-patch.test.ts
// 文本补丁原语（spec §6，从 background/scripts.ts 抽出）：append 补尾换行、replace 字面量语义与 confirmHint 文案。
import { describe, it, expect } from 'vitest';
import { appendText, replaceText } from '../../shared/text-patch';

const SCRIPT_HINT = '请先用 get_script 或 grep_script 确认原文';
const SKILL_HINT = '请先用 get_skill 确认原文';

describe('appendText', () => {
  it('追加到末尾；原文无尾换行时补一个', () => {
    expect(appendText('a\nb\n', 'c();')).toBe('a\nb\nc();');
    expect(appendText('a\nb', 'c();')).toBe('a\nb\nc();');
    expect(appendText('', 'c();')).toBe('c();');
    expect(() => appendText('a\n', '')).toThrow('append 不能为空');
  });
});

describe('replaceText', () => {
  it('命中 1 处替换；未命中/多处未传 all 报错；all:true 全替', () => {
    expect(replaceText('a\nfoo\nb', 'foo', 'bar', false, SCRIPT_HINT)).toBe('a\nbar\nb');
    expect(() => replaceText('a\nb', 'zzz', 'x', false, SCRIPT_HINT)).toThrow('未找到');
    expect(() => replaceText('a\nfoo\nb\nfoo', 'foo', 'x', false, SCRIPT_HINT)).toThrow(/命中 2 处.*第 2、4 行/);
    expect(replaceText('a\nfoo\nb\nfoo', 'foo', 'x', true, SCRIPT_HINT)).toBe('a\nx\nb\nx');
    expect(() => replaceText('a\n', '', 'x', false, SCRIPT_HINT)).toThrow('不能为空');
  });

  it('old 含正则元字符按字面量处理', () => {
    expect(replaceText('if (a.b) { c(); }', 'a.b', 'a.c', false, SCRIPT_HINT)).toBe('if (a.c) { c(); }');
    expect(replaceText('x = arr[0] * 2;', 'arr[0] * 2', 'n', false, SCRIPT_HINT)).toBe('x = n;');
    expect(() => replaceText('axb', 'a.b', 'z', false, SCRIPT_HINT)).toThrow('未找到');
  });

  it('未命中文案带上调用方给的确认提示（脚本 get_script / 技能 get_skill）', () => {
    expect(() => replaceText('abc', 'zzz', 'x', false, SCRIPT_HINT)).toThrow(/get_script 或 grep_script/);
    expect(() => replaceText('abc', 'zzz', 'x', false, SKILL_HINT)).toThrow(/get_skill 确认原文/);
  });
});
