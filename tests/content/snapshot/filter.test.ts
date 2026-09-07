import { describe, it, expect } from 'vitest';
import { INTERACTIVE_ROLES, isInteractiveRole, keepAtDetail } from '../../../content/snapshot/filter';

const node = (role: string, over: Record<string, unknown> = {}) =>
  ({ role, name: '', states: [], description: '', extras: {}, children: [], ...over }) as never;

describe('快照分级过滤', () => {
  it('白名单含全部可交互角色 + heading + RootWebArea', () => {
    for (const r of ['link', 'button', 'textbox', 'combobox', 'checkbox', 'radio',
                     'option', 'tab', 'switch', 'menuitem', 'slider', 'heading', 'RootWebArea']) {
      expect(INTERACTIVE_ROLES.has(r)).toBe(true);
    }
    expect(isInteractiveRole('generic')).toBe(false);
    expect(isInteractiveRole('listitem')).toBe(false);
  });

  it('full 档保留一切', () => {
    expect(keepAtDetail(node('generic'), 'full')).toBe(true);
    expect(keepAtDetail(node('StaticText', { isText: true }), 'full')).toBe(true);
  });

  it('interactive 档保留可交互角色', () => {
    expect(keepAtDetail(node('button'), 'interactive')).toBe(true);
    expect(keepAtDetail(node('heading'), 'interactive')).toBe(true);
  });

  it('interactive 档丢弃容器角色', () => {
    expect(keepAtDetail(node('generic'), 'interactive')).toBe(false);
    expect(keepAtDetail(node('list'), 'interactive')).toBe(false);
  });

  it('interactive 档：视口内文本保留、视口外文本丢弃', () => {
    expect(keepAtDetail(node('StaticText', { isText: true, inViewport: true }), 'interactive')).toBe(true);
    expect(keepAtDetail(node('StaticText', { isText: true, inViewport: false }), 'interactive')).toBe(false);
  });

  it('inViewport 未知（undefined）时文本保留——jsdom 与 0 尺寸元素不因缺信息被误删', () => {
    expect(keepAtDetail(node('StaticText', { isText: true }), 'interactive')).toBe(true);
  });

  it('截断占位行任何档位都保留', () => {
    expect(keepAtDetail(node('… [3 more]'), 'interactive')).toBe(true);
  });
});
