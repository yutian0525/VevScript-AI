import { describe, it, expect } from 'vitest';
import type { SnapNode } from '../../../content/snapshot/build';
import { INTERACTIVE_ROLES, isInteractiveRole, keepAtDetail } from '../../../content/snapshot/filter';

const node = (role: string, over: Partial<SnapNode> = {}): SnapNode =>
  ({ role, name: '', states: [], description: '', extras: {}, children: [], ...over });

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

  it('interactive 档保留显式 ARIA 交互角色与模态锚点', () => {
    // computeRole 的显式 role 属性路径是开放集合，白名单漏掉即整行消失且折叠行无法恢复其名
    expect(keepAtDetail(node('searchbox'), 'interactive')).toBe(true);
    expect(keepAtDetail(node('treeitem'), 'interactive')).toBe(true);
    // 模态边界：子树按钮仍在，但「属于哪个弹窗」的 aria-label 上下文只能靠这行本身
    expect(keepAtDetail(node('dialog'), 'interactive')).toBe(true);
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
