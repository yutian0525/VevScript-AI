// tests/shared/js-balance.test.ts
import { describe, it, expect } from 'vitest';
import { checkBalance } from '../../shared/js-balance';

describe('checkBalance 配平扫描', () => {
  it('平衡的代码 → ok', () => {
    expect(checkBalance('(function () { var a = [1, 2]; })();')).toEqual({ ok: true });
    expect(checkBalance('')).toEqual({ ok: true });
  });

  it('缺右括号 → 不 ok，detail 带数量与最早行号', () => {
    const r = checkBalance('(function () {\n  var a = 1;\n');
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('未闭合');
    expect(r.detail).toContain('第 1 行');
  });

  it('多出右括号 → 不 ok 且指出行号', () => {
    const r = checkBalance('var a = 1;\n}\n');
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('第 2 行');
    expect(r.detail).toContain('多出');
  });

  it('配对错位（] 对上 {）→ 报不匹配', () => {
    const r = checkBalance('{ ]');
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('不匹配');
  });

  it('字符串里的括号不计入', () => {
    expect(checkBalance('var s = "){[";')).toEqual({ ok: true });
    expect(checkBalance("var s = '}}}';")).toEqual({ ok: true });
    expect(checkBalance('var s = "a\\"){";')).toEqual({ ok: true });
  });

  it('未闭合的引号串 → 不 ok（含换行截断的情况）', () => {
    expect(checkBalance('var s = "abc').ok).toBe(false);
    const r = checkBalance('var s = "abc\nvar t = 1;');
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('字符串未闭合');
  });

  it('模板串里的括号不计入；${} 嵌套正确处理', () => {
    expect(checkBalance('var s = `){[`;')).toEqual({ ok: true });
    expect(checkBalance('var s = `a${ f({ x: [1] }) }b`;')).toEqual({ ok: true });
    expect(checkBalance('var s = `${ `${ 1 }` }`;')).toEqual({ ok: true });
  });

  it('模板串内的 ${} 缺右括号仍被发现', () => {
    expect(checkBalance('var s = `a${ f( `;').ok).toBe(false);
  });

  it('未闭合模板串 → 不 ok', () => {
    const r = checkBalance('var s = `abc;');
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('模板');
    expect(r.detail).toContain('第 1 行');
  });

  it('注释里的括号与引号不计入', () => {
    expect(checkBalance('// ) } " \'\nvar a = 1;')).toEqual({ ok: true });
    expect(checkBalance('/* ) } " it\'s */\nvar a = 1;')).toEqual({ ok: true });
  });

  it('未闭合块注释 → 不 ok', () => {
    const r = checkBalance('/* abc\nvar a = 1;');
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('块注释未闭合');
  });

  it('块注释跨行时行号继续累计', () => {
    const r = checkBalance('/* a\nb\nc */\n{');
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('第 4 行');
  });

  it('正则字面量里的括号与方括号不计入', () => {
    expect(checkBalance('var re = /[(){]/;')).toEqual({ ok: true });
    expect(checkBalance('var re = /a\\/b(/;')).toEqual({ ok: true });
    expect(checkBalance('if (/^x[(]$/.test(s)) { f(); }')).toEqual({ ok: true });
  });

  it('除号不被误判为正则起始（前一个有意义字符是标识符/数字/右括号）', () => {
    expect(checkBalance('var a = b / c; var d = (1) / 2; var e = arr[0] / 3;')).toEqual({ ok: true });
    expect(checkBalance('var a = 6 / 2 / 3;')).toEqual({ ok: true });
  });
});
