// content/snapshot/build.ts
// 完整内容树组装：DFS 遍历 childNodes → 过滤隐藏 → 每节点编 uid（Text 映射父元素）
// → RootWebArea 根 → 折叠纯布局 → 缩进序列化 → open shadow DOM 递归。
import { computeRole, computeName, computeStates, computeDescription, computeExtras, type NodeExtras } from './roles';
import { isHidden } from './visibility';

export interface SnapshotOptions {
  maxChildrenPerLevel?: number;
  maxNodes?: number;
}

const DEFAULTS: Required<SnapshotOptions> = { maxChildrenPerLevel: 200, maxNodes: 1200 };

let uidMap = new Map<number, WeakRef<Element>>();
let uidCounter = 0;

export function resetUidMap(): void {
  uidMap = new Map();
  uidCounter = 0;
}

export function resolveUid(uid: number): Element | null {
  const ref = uidMap.get(uid);
  if (!ref) return null;
  const el = ref.deref();
  if (!el || !el.isConnected) return null;
  return el;
}

interface SnapNode {
  role: string;
  name: string;
  states: string[];
  description: string;
  extras: NodeExtras;
  uid?: number;
  isText?: boolean;
  children: SnapNode[];
}

export function buildSnapshot(root: Element, opts: SnapshotOptions = {}): { text: string } {
  const cfg = { ...DEFAULTS, ...opts };
  resetUidMap();
  let nodeCount = 0;
  let truncated = false;

  function assignUid(el: Element): number {
    uidCounter += 1;
    uidMap.set(uidCounter, new WeakRef(el));
    return uidCounter;
  }

  function walkChildren(el: Element, parent: SnapNode & { uid: number }, out: SnapNode[]): void {
    const kids: ChildNode[] = [];
    const shadow = (el as HTMLElement).shadowRoot;
    if (shadow) kids.push(...Array.from(shadow.childNodes));
    kids.push(...Array.from(el.childNodes));

    let emitted = 0;
    for (const node of kids) {
      if (emitted >= cfg.maxChildrenPerLevel) {
        out.push({ role: `… [${kids.length - emitted} more]`, name: '', states: [], description: '', extras: {}, children: [] });
        break;
      }
      if (node.nodeType === Node.TEXT_NODE) {
        const t = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (!t) continue;
        if (coveredByName(parent.name, t)) continue;
        if (nodeCount >= cfg.maxNodes) { truncated = true; break; }
        nodeCount += 1;
        out.push({ role: 'StaticText', name: t.slice(0, 200), states: [], description: '', extras: {}, uid: parent.uid, isText: true, children: [] });
        emitted += 1;
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const child = walkElement(node as Element);
        if (child) { out.push(child); emitted += 1; }
        else if (truncated) break;
      }
    }
  }

  function walkElement(elem: Element): SnapNode | null {
    if (isHidden(elem)) return null;
    if (nodeCount >= cfg.maxNodes) { truncated = true; return null; }
    nodeCount += 1;
    const uid = assignUid(elem);
    // 收紧为必带 uid：walkChildren 依赖它保证 StaticText 行必带 [uid]（agent 定位元素的唯一入口）
    const node: SnapNode & { uid: number } = {
      role: computeRole(elem),
      name: computeName(elem),
      states: computeStates(elem),
      description: computeDescription(elem),
      extras: computeExtras(elem),
      uid,
      children: [],
    };
    walkChildren(elem, node, node.children);
    return node;
  }

  const rootUid = assignUid(root);
  nodeCount += 1;
  const view = root.ownerDocument.defaultView;
  // 同源省 origin 的基准。jsdom 下 location.origin 存在（http://localhost:3000）；
  // about:blank 等取不到时退空串——此时跨源分支生效，host 会保留（对 agent 反而更完整）。
  const baseOrigin = view?.location?.origin ?? '';
  const rootNode: SnapNode & { uid: number } = {
    role: 'RootWebArea',
    name: root.ownerDocument.title ?? '',
    states: [],
    description: '',
    extras: { url: view?.location?.href },
    uid: rootUid,
    children: [],
  };
  walkChildren(root, rootNode, rootNode.children);

  const lines: string[] = [];
  serialize(rootNode, 0, lines, baseOrigin);
  if (truncated) lines.push(`… [还有更多节点未显示，快照已达节点上限 ${cfg.maxNodes} 被截断]`);
  return { text: lines.join('\n') };
}

/** 文本是否被父节点 name 覆盖（含 name 被截至 100 字符的前缀情形）。
 *  代价：文本超 100 字符时，其 100~200 段随去重一起丢弃（原本 t.slice(0,200) 会保留）。
 *  这是刻意取舍——长标题重复正是去重收益的主要来源，且 name 里已有前 100 字符。 */
function coveredByName(parentName: string, t: string): boolean {
  if (!parentName) return false;
  if (parentName === t) return true;
  // computeName 截断到 100：name 是 t 的前缀即视为同一段文字。
  // 上限 100 与 roles.ts 的 normalize(s, 100) 耦合，改那边的截断长度必须同步这里。
  return parentName.length === 100 && t.startsWith(parentName);
}

/** URL 瘦身：同源省 origin、跨源留 host+path、查询串截 30、总长超 40 前缀省略号。
 *  代价：hash 与超长 path 的中段会被丢弃——agent 需要 hash 锚点或完整深链时可读 href 补全，
 *  而绝对 URL 的域名前缀对模型零价值（当前页 origin 已在 system prompt 页面信息块给过），
 *  url 属性占快照 28~31% 字符，是仅次于 StaticText 去重的瘦身点，值得这点信息损失。
 *  注意：javascript:/mailto:/tel: 等非 http(s) scheme 在 WHATWG URL 下解析成功不抛错，
 *  但 host 为空、pathname 吞掉 scheme——直接套用瘦身公式会把 scheme 一起删掉（实测踩过），
 *  故只对 http(s) 做 origin 瘦身，其余原样保留（仍吃总长截断）。 */
export function shortenUrl(raw: string, baseOrigin: string): string {
  let s: string;
  try {
    const u = new URL(raw);
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      const q = u.search ? u.search.slice(0, 30) : '';
      s = u.origin === baseOrigin ? `${u.pathname}${q}` : `${u.host}${u.pathname}${q}`;
    } else {
      s = raw;
    }
  } catch {
    s = raw;
  }
  return s.length > 40 ? `…${s.slice(-39)}` : s;
}

function serialize(node: SnapNode, depth: number, lines: string[], baseOrigin: string): void {
  const emit = shouldEmit(node);
  if (emit) {
    lines.push('  '.repeat(depth) + renderLine(node, baseOrigin));
  }
  const nextDepth = emit ? depth + 1 : depth;
  for (const c of node.children) serialize(c, nextDepth, lines, baseOrigin);
}

function renderLine(node: SnapNode, baseOrigin: string): string {
  if (node.role.startsWith('…')) return node.role;
  const esc = (s: string) => s.replace(/\s+/g, ' ').replace(/"/g, '\\"');
  const uid = node.uid != null ? `[${node.uid}] ` : '';
  const name = node.name ? ` "${esc(node.name)}"` : '';
  const hp = node.extras.haspopup ? ` haspopup="${esc(node.extras.haspopup)}"` : '';
  const ac = node.extras.autocomplete ? ` autocomplete="${esc(node.extras.autocomplete)}"` : '';
  const states = node.states.length ? ` {${node.states.join(',')}}` : '';
  const desc = node.description ? ` description="${esc(node.description)}"` : '';
  const url = node.extras.url ? ` url="${esc(shortenUrl(node.extras.url, baseOrigin))}"` : '';
  return `${uid}${node.role}${name}${hp}${ac}${states}${desc}${url}`;
}

/** 产出条件：截断占位、StaticText、RootWebArea、非 generic 有语义、或 generic 但有名/有 description。
 *  纯布局 generic（无名无 description）折叠，子节点上提。 */
function shouldEmit(node: SnapNode): boolean {
  if (node.role.startsWith('…')) return true;
  if (node.isText) return true;
  if (node.role === 'RootWebArea') return true;
  if (node.role !== 'generic') return true;
  return node.name !== '' || node.description !== '';
}
