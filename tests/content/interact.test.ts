// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { buildSnapshot, resetUidMap, resolveUid } from '../../content/snapshot/build';
import { doClick, doFill, doFillForm, doHover, doScroll, doPressKey } from '../../content/interact';

function uidOf(el: Element): number {
  for (let i = 1; i < 10000; i++) if (resolveUid(i) === el) return i;
  throw new Error('no uid');
}

describe('交互执行', () => {
  beforeEach(() => { resetUidMap(); document.body.innerHTML = ''; });

  it('click 触发 click 事件', () => {
    document.body.innerHTML = '<button>x</button>';
    buildSnapshot(document.body);
    const btn = document.querySelector('button')!;
    const spy = vi.fn(); btn.addEventListener('click', spy);
    const r = doClick({ uid: uidOf(btn) });
    expect(r.ok).toBe(true);
    expect(spy).toHaveBeenCalled();
  });

  it('click 无效 uid → stale 错误', () => {
    const r = doClick({ uid: 999 }) as { ok: boolean; error: string };
    expect(r.ok).toBe(false);
    expect(r.error).toContain('stale');
  });

  it('fill 设值并派发 input/change', () => {
    document.body.innerHTML = '<input>';
    buildSnapshot(document.body);
    const inp = document.querySelector('input')!;
    const inputSpy = vi.fn(); inp.addEventListener('input', inputSpy);
    const r = doFill({ uid: uidOf(inp), value: '你好' });
    expect(r.ok).toBe(true);
    expect(inp.value).toBe('你好');
    expect(inputSpy).toHaveBeenCalled();
  });

  it('fill_form 批量填充', () => {
    document.body.innerHTML = '<input id="a"><input id="b">';
    buildSnapshot(document.body);
    const a = document.getElementById('a') as HTMLInputElement;
    const b = document.getElementById('b') as HTMLInputElement;
    const r = doFillForm({ elements: [{ uid: uidOf(a), value: '1' }, { uid: uidOf(b), value: '2' }] });
    expect(r.ok).toBe(true);
    expect(a.value).toBe('1');
    expect(b.value).toBe('2');
  });

  it('fill_form 部分 stale 时报告失败项', () => {
    document.body.innerHTML = '<input id="a">';
    buildSnapshot(document.body);
    const a = document.getElementById('a') as HTMLInputElement;
    const r = doFillForm({ elements: [{ uid: uidOf(a), value: '1' }, { uid: 999, value: '2' }] }) as { ok: boolean; error: string };
    expect(r.ok).toBe(false);
    expect(r.error).toContain('999');
  });

  it('hover 触发 mouseover', () => {
    document.body.innerHTML = '<a href="/x">x</a>';
    buildSnapshot(document.body);
    const a = document.querySelector('a')!;
    const s2 = vi.fn(); a.addEventListener('mouseover', s2);
    const r = doHover({ uid: uidOf(a) });
    expect(r.ok).toBe(true);
    expect(s2).toHaveBeenCalled();
  });

  it('press_key 派发 keydown', () => {
    const spy = vi.fn();
    document.addEventListener('keydown', spy);
    const r = doPressKey({ key: 'Enter' });
    expect(r.ok).toBe(true);
    expect(spy).toHaveBeenCalled();
  });

  it('scroll 返回 ok（window）', () => {
    const r = doScroll({ direction: 'down', amount: 100 });
    expect(r.ok).toBe(true);
  });

  it('scroll 按方向调用 window.scrollBy（验参）', () => {
    const spy = vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
    doScroll({ direction: 'down', amount: 250 });
    expect(spy).toHaveBeenCalledWith(0, 250);
    doScroll({ direction: 'up' });
    expect(spy).toHaveBeenCalledWith(0, -400);
    doScroll({ direction: 'right', amount: 100 });
    expect(spy).toHaveBeenCalledWith(100, 0);
    spy.mockRestore();
  });

  it('fill 支持 select（combobox）', () => {
    document.body.innerHTML = '<select><option value="a">A</option><option value="b">B</option></select>';
    buildSnapshot(document.body);
    const sel = document.querySelector('select')!;
    const r = doFill({ uid: uidOf(sel), value: 'b' });
    expect(r.ok).toBe(true);
    expect(sel.value).toBe('b');
  });
});
