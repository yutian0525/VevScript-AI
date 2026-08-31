// content/snapshot/build.ts
// 快照组装（设计 §5）：DFS 遍历 → 过滤隐藏 → uid 分配 + WeakRef 映射
// → 折叠 → 缩进序列化 → open shadow DOM 递归。
import { computeRole, computeName, computeStates, isInteractive } from './roles';
import { isHidden } from './visibility';

export interface SnapshotOptions {
  maxChildrenPerLevel?: number;
  maxNodes?: number;
}

const DEFAULTS: Required<SnapshotOptions> = { maxChildrenPerLevel: 200, maxNodes: 2000 };

// uid → WeakRef<Element>，模块级；每次 buildSnapshot 重建。
let uidMap = new Map<number, WeakRef<Element>>();
let uidCounter = 0;

export function resetUidMap(): void {
  uidMap = new Map();
  uidCounter = 0;
}

/** uid → 元素；重置过、解析不到、或已脱离 DOM 都返回 null（stale 语义）。 */
export function resolveUid(uid: number): Element | null {
  const ref = uidMap.get(uid);
  if (!ref) return null;
  const el = ref.deref();
  if (!el || !el.isConnected) return null;
  return el;
}

interface SnapNode { role: string; name: string; states: string[]; uid?: number; children: SnapNode[] }

// 这些容器/地标角色的可访问名称不取自后代文本内容（WAI-ARIA name-from-content 不适用）；
// 否则会把子孙文本聚合成噪声名称（如 <nav> 显示其内所有链接文字）。它们仍作为结构行输出，只是不带名称。
const NO_NAME_FROM_CONTENT = new Set([
  'navigation', 'list', 'listitem', 'main', 'region', 'banner', 'contentinfo',
  'complementary', 'form', 'search', 'group', 'toolbar',
]);

export function buildSnapshot(root: Element, opts: SnapshotOptions = {}): { text: string } {
  const cfg = { ...DEFAULTS, ...opts };
  resetUidMap();
  let nodeCount = 0;
  let truncated = false;

  function walk(elem: Element): SnapNode | null {
    if (isHidden(elem)) return null;
    if (nodeCount >= cfg.maxNodes) { truncated = true; return null; }
    nodeCount += 1;

    const role = computeRole(elem);
    const name = computeName(elem);
    const states = computeStates(elem);
    const node: SnapNode = { role, name, states, children: [] };

    if (isInteractive(role)) {
      uidCounter += 1;
      node.uid = uidCounter;
      uidMap.set(uidCounter, new WeakRef(elem));
    }

    // 子节点来源：open shadow root + 普通 children
    const kids: Element[] = [];
    const shadow = (elem as HTMLElement).shadowRoot;
    if (shadow) kids.push(...Array.from(shadow.children));
    kids.push(...Array.from(elem.children));

    let emitted = 0;
    for (const child of kids) {
      if (emitted >= cfg.maxChildrenPerLevel) {
        node.children.push({ role: `… [${kids.length - emitted} more]`, name: '', states: [], children: [] });
        break;
      }
      const c = walk(child);
      if (c) { node.children.push(c); emitted += 1; }
    }
    return node;
  }

  const tree = walk(root);
  const lines: string[] = [];
  if (tree) serialize(tree, 0, lines, true);
  // 命中节点上限时追加截断标记，让模型知道树不完整。
  if (truncated) lines.push(`… [达到节点上限 ${cfg.maxNodes}，快照已截断]`);
  return { text: lines.join('\n') };
}

function serialize(node: SnapNode, depth: number, lines: string[], isRoot: boolean): void {
  const emit = shouldEmit(node);
  if (!isRoot && emit) {
    const indent = '  '.repeat(Math.max(0, depth - 1));
    const uid = node.uid != null ? `[${node.uid}] ` : '';
    const showName = node.name && !NO_NAME_FROM_CONTENT.has(node.role);
    // 转义 name 内的双引号，避免破坏 [uid] role "name" 格式。
    const safeName = node.name.replace(/"/g, '\\"');
    const name = showName ? ` "${safeName}"` : '';
    const states = node.states.length ? ` {${node.states.join(',')}}` : '';
    lines.push(`${indent}${uid}${node.role}${name}${states}`);
  }
  const nextDepth = isRoot ? depth + 1 : (emit ? depth + 1 : depth);
  for (const c of node.children) serialize(c, nextDepth, lines, false);
}

/** 折叠占位、有 uid、或非 generic 的有名节点才输出；其余 generic 无名节点仅作容器透传子节点。 */
function shouldEmit(node: SnapNode): boolean {
  if (node.role.startsWith('…')) return true;
  if (node.uid != null) return true;
  return node.role !== 'generic' && node.name !== '';
}
