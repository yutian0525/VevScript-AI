// content/snapshot/filter.ts
// 快照分级过滤（spec §6.2）：interactive 档只留可交互角色 + 标题 + 视口内文本。
// 非白名单节点由 build.ts 的 serialize 折叠为计数行，子节点仍继续遍历（可交互后代不丢）。
import type { SnapNode } from './build';

export type SnapshotDetail = 'interactive' | 'full';

/** 可交互角色白名单 + heading（结构锚点）+ RootWebArea（根必留）。 */
export const INTERACTIVE_ROLES = new Set([
  'link', 'button', 'textbox', 'combobox', 'checkbox', 'radio', 'option',
  'tab', 'switch', 'menuitem', 'slider', 'heading', 'RootWebArea',
]);

export function isInteractiveRole(role: string): boolean {
  return INTERACTIVE_ROLES.has(role);
}

/**
 * 该节点在给定档位下是否产出。
 * interactive 档：可交互角色一律留（含视口外——agent 常需点页面下方按钮）；
 * 纯文本按视口过滤，但 inViewport 未知时保留（jsdom 恒 0 尺寸、真实页 0 尺寸包装元素，
 * 缺信息不该导致内容消失）。
 */
export function keepAtDetail(node: SnapNode, detail: SnapshotDetail): boolean {
  if (node.role.startsWith('…')) return true;   // 截断占位
  if (detail === 'full') return true;
  if (node.isText) return node.inViewport !== false;
  return isInteractiveRole(node.role);
}
