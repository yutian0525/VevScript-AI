// content/interact.ts
// DOM 交互执行（设计 §6）。输入 uid → resolveUid → 派发原生事件。
import type { ToolResult } from '../shared/types';
import type { BgToCsRequestMap } from '../shared/messages';
import { resolveUid } from './snapshot/build';

const STALE = 'stale snapshot: uid 已失效，请重新 take_snapshot';

function resolve(uid: number): Element | null {
  return resolveUid(uid);
}

// 用 null 判别 stale，不用 `'error' in el`——<video>/<audio> 等原型上带 error 属性，
// `'error' in el` 会把真实媒体元素误判为 stale。
function staleError(uid: number): ToolResult {
  return { ok: false, error: `${STALE}（uid=${uid}）` };
}

function fireMouse(el: Element, type: string): void {
  // 不传 view: window——jsdom 的 MouseEvent 构造器会拒绝其 window（非标准 Window 类型），
  // 且 view 对事件派发/冒泡无影响。
  el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
}

export function doClick(p: BgToCsRequestMap['CLICK']): ToolResult {
  const el = resolve(p.uid);
  if (!el) return staleError(p.uid);
  (el as HTMLElement).scrollIntoView?.({ block: 'center' });
  fireMouse(el, 'pointerdown');
  fireMouse(el, 'mousedown');
  fireMouse(el, 'mouseup');
  fireMouse(el, 'click');
  if (p.dblClick) fireMouse(el, 'dblclick');
  return { ok: true };
}

export function doFill(p: BgToCsRequestMap['FILL']): ToolResult {
  const el = resolve(p.uid);
  if (!el) return staleError(p.uid);
  // select 是 combobox，也会分到 uid、被 agent 发 FILL；但拿 HTMLInputElement 的 value setter
  // 去 call select 会抛 TypeError，所以单独处理。
  if (el instanceof HTMLSelectElement) {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    if (setter) setter.call(el, p.value); else el.value = p.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  }
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
    return { ok: false, error: `元素不支持 fill（uid=${p.uid}），它不是输入框/文本域/下拉框` };
  }
  const input = el as HTMLInputElement | HTMLTextAreaElement;
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(input, p.value);
  else input.value = p.value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true };
}

export function doFillForm(p: BgToCsRequestMap['FILL_FORM']): ToolResult {
  const errors: string[] = [];
  let done = 0;
  for (const { uid, value } of p.elements) {
    const r = doFill({ uid, value });
    if (r.ok) done += 1; else errors.push(r.error ?? `uid=${uid} 失败`);
  }
  if (errors.length) return { ok: false, error: `已成功填充 ${done} 项；失败：${errors.join('；')}` };
  return { ok: true };
}

export function doHover(p: BgToCsRequestMap['HOVER']): ToolResult {
  const el = resolve(p.uid);
  if (!el) return staleError(p.uid);
  fireMouse(el, 'pointerover');
  fireMouse(el, 'mouseover');
  fireMouse(el, 'mouseenter');
  return { ok: true };
}

export function doScroll(p: BgToCsRequestMap['SCROLL']): ToolResult {
  const amount = p.amount ?? 400;
  const dx = p.direction === 'left' ? -amount : p.direction === 'right' ? amount : 0;
  const dy = p.direction === 'up' ? -amount : p.direction === 'down' ? amount : 0;
  window.scrollBy(dx, dy);
  return { ok: true };
}

export function doPressKey(p: BgToCsRequestMap['PRESS_KEY']): ToolResult {
  const mods = new Set(p.modifiers ?? []);
  const init: KeyboardEventInit = {
    key: p.key, bubbles: true, cancelable: true,
    ctrlKey: mods.has('Control'), shiftKey: mods.has('Shift'),
    altKey: mods.has('Alt'), metaKey: mods.has('Meta'),
  };
  const target = (document.activeElement ?? document.body) as Element;
  target.dispatchEvent(new KeyboardEvent('keydown', init));
  target.dispatchEvent(new KeyboardEvent('keyup', init));
  return { ok: true };
}
