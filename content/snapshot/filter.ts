// content/snapshot/filter.ts
// 快照分级过滤（spec §6.2）：interactive 档只留可交互角色 + 标题 + 视口内文本。
// 非白名单节点由 build.ts 的 serialize 折叠为计数行，子节点仍继续遍历（可交互后代不丢）。
import type { SnapNode } from './build';

export type SnapshotDetail = 'interactive' | 'full';

/** 可交互角色白名单 + heading（结构锚点）+ RootWebArea（根必留）。 */
export const INTERACTIVE_ROLES = new Set([
  'link', 'button', 'textbox', 'combobox', 'checkbox', 'radio', 'option',
  'tab', 'switch', 'menuitem', 'slider', 'heading', 'RootWebArea',
  // 显式 ARIA 的纯交互角色：computeRole 的 role 属性路径是开放集合（任意 ARIA 角色都能进来），
  // 这些角色标签路径不产出、页面却会显式标注，白名单漏掉即 interactive 档整行消失，
  // 且折叠计数行不含 name，agent 无从定位（如 React Aria 的 searchbox 无从 fill）。
  'searchbox', 'spinbutton', 'menuitemcheckbox', 'menuitemradio', 'treeitem',
  // 模态边界：弹窗内的 button/link 因子树继续遍历仍在，但「这些按钮属于哪个模态」
  // 的 aria-label 上下文只在这一行——缺了 agent 会错判自己在哪个弹窗，导致后续操作出错。
  'dialog', 'alertdialog',
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
