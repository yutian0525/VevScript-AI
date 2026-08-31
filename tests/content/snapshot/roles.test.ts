// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { computeRole, computeName, computeStates, isInteractive } from '../../../content/snapshot/roles';

function el(html: string): Element {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d.firstElementChild!;
}

describe('role 计算', () => {
  it('显式 role 优先', () => {
    expect(computeRole(el('<div role="button">x</div>'))).toBe('button');
  });
  it('button → button', () => expect(computeRole(el('<button>x</button>'))).toBe('button'));
  it('a[href] → link', () => expect(computeRole(el('<a href="/x">x</a>'))).toBe('link'));
  it('a 无 href → generic', () => expect(computeRole(el('<a>x</a>'))).toBe('generic'));
  it('input[type=text] → textbox', () => expect(computeRole(el('<input type="text">'))).toBe('textbox'));
  it('input[type=checkbox] → checkbox', () => expect(computeRole(el('<input type="checkbox">'))).toBe('checkbox'));
  it('select → combobox', () => expect(computeRole(el('<select></select>'))).toBe('combobox'));
  it('textarea → textbox', () => expect(computeRole(el('<textarea></textarea>'))).toBe('textbox'));
  it('div → generic', () => expect(computeRole(el('<div>x</div>'))).toBe('generic'));
  it('h1 → heading', () => expect(computeRole(el('<h1>x</h1>'))).toBe('heading'));
});

describe('name 计算', () => {
  it('aria-label 最高优先', () => {
    expect(computeName(el('<button aria-label="关闭">x</button>'))).toBe('关闭');
  });
  it('placeholder 次之', () => {
    expect(computeName(el('<input placeholder="邮箱">'))).toBe('邮箱');
  });
  it('alt（img）', () => expect(computeName(el('<img alt="头像">'))).toBe('头像'));
  it('textContent 兜底并截断', () => {
    const long = 'x'.repeat(200);
    expect(computeName(el(`<button>${long}</button>`)).length).toBeLessThanOrEqual(100);
  });
  it('无名返回空串', () => expect(computeName(el('<div></div>'))).toBe(''));
  it('label[for] 关联优先于 placeholder', () => {
    const d = document.createElement('div');
    d.innerHTML = '<label for="em">邮箱地址</label><input id="em" placeholder="ph">';
    document.body.appendChild(d);
    const input = d.querySelector('input')!;
    expect(computeName(input)).toBe('邮箱地址');
    d.remove();
  });
  it('包裹式 label 关联', () => {
    const d = document.createElement('div');
    d.innerHTML = '<label>用户名<input></label>';
    document.body.appendChild(d);
    const input = d.querySelector('input')!;
    expect(computeName(input)).toContain('用户名');
    d.remove();
  });
});

describe('states 计算', () => {
  it('disabled', () => expect(computeStates(el('<button disabled>x</button>'))).toContain('disabled'));
  it('checked', () => {
    const c = el('<input type="checkbox">') as HTMLInputElement;
    c.checked = true;
    expect(computeStates(c)).toContain('checked');
  });
  it('aria-expanded', () => expect(computeStates(el('<button aria-expanded="true">x</button>'))).toContain('expanded'));
});

describe('isInteractive', () => {
  it('button/link/textbox/checkbox/combobox 可交互', () => {
    for (const r of ['button', 'link', 'textbox', 'checkbox', 'combobox']) expect(isInteractive(r)).toBe(true);
  });
  it('generic/heading 不可交互', () => {
    expect(isInteractive('generic')).toBe(false);
    expect(isInteractive('heading')).toBe(false);
  });
});
