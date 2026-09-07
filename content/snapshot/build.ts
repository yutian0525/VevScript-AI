// content/snapshot/build.ts
// 完整内容树组装：DFS 遍历 childNodes → 过滤隐藏 → 每节点编 uid（Text 映射父元素）
// → RootWebArea 根 → 折叠纯布局 → 缩进序列化 → open shadow DOM 递归。
import { computeRole, computeName, computeStates, computeDescription, computeExtras, type NodeExtras } from './roles';
import { isHidden } from './visibility';
import { keepAtDetail, type SnapshotDetail } from './filter';

export interface SnapshotOptions {
  maxChildrenPerLevel?: number;
  maxNodes?: number;
  /** 详细档位。缺省 'interactive'（spec §6.2 新默认）：只留可交互角色 + 标题 + 视口内文本，其余折叠为计数行。 */
  detail?: SnapshotDetail;
}

const DEFAULTS: Required<SnapshotOptions> = { maxChildrenPerLevel: 200, maxNodes: 1200, detail: 'interactive' };

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

export interface SnapNode {
  role: string;
  name: string;
  states: string[];
  description: string;
  extras: NodeExtras;
  uid?: number;
  isText?: boolean;
  /** 是否与视口相交。undefined = 未知（jsdom / 0 尺寸元素），过滤时按保留处理。 */
  inViewport?: boolean;
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

  /** 元素是否与视口相交。rect 全 0（jsdom / 0 尺寸）返回 undefined 表示未知——
   *  缺信息时 keepAtDetail 按保留处理，不让内容因测量不到而消失。 */
  function inViewport(el: Element): boolean | undefined {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return undefined;
    const view = el.ownerDocument.defaultView;
    const vh = view?.innerHeight ?? 0;
    const vw = view?.innerWidth ?? 0;
    return r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
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
        out.push({ role: 'StaticText', name: t.slice(0, 200), states: [], description: '', extras: {}, uid: parent.uid, isText: true, inViewport: inViewport(el), children: [] });
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
      inViewport: inViewport(elem),
      children: [],
    };
    walkChildren(elem, node, node.children);
    return node;
  }

  const rootUid = assignUid(root);
  nodeCount += 1;
  const view = root.ownerDocument.defaultView;
  // 同源省 origin 的基准。真实 about:blank 的 origin 序列化为字符串 "null"（不缺失），
  // 此处退空串的真实来源是 implementation.createHTMLDocument() 这类 defaultView 为 null 的文档
  // （jsdom 单测里 mock document 的场景同理）——退空串走跨源分支，host 保留，对 agent 反而更完整。
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
  const fold = { n: 0 };
  serialize(rootNode, 0, lines, baseOrigin, cfg.detail, fold);
  flushFold(lines, 0, fold);   // 残留计数
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

/** URL 瘦身：同源省 origin、跨源留 host+path、查询串截 30（带 … 标记）、总长上限 40。
 *  代价：hash 一律丢弃——锚点定位对快照读者价值极低，需要时 agent 可经 evaluate_script 读 href；
 *  超长时同源丢前缀、跨源丢 path 中段。url 属性占快照 28~31% 字符，是仅次于 StaticText
 *  去重的瘦身点，值得这点信息损失（当前页 origin 已在 system prompt 页面信息块给过）。
 *  两个实测踩过的坑：
 *  1. javascript:/mailto:/tel: 等非 http(s) scheme 在 WHATWG URL 下解析成功不抛错，但 host 为空、
 *     pathname 吞掉 scheme——直接套瘦身公式会把 scheme 一起删掉，故只对 http(s) 瘦身，其余原样保留。
 *  2. 跨源超长时截断只作用于 host 之后的部分——host 是跨源分支存在的唯一理由（模型靠它区分站点），
 *     丢了它模型会把外链误判成同源路径；host 自身就超预算的极端情况才整体截断。 */
export function shortenUrl(raw: string, baseOrigin: string): string {
  let s: string;
  let host = '';
  let sameOrigin = false;
  try {
    const u = new URL(raw);
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      // 截断必须带 … 标记：否则残缺查询与「恰好 30 字符的完整查询」不可区分，模型会把残缺当完整 URL 抄进脚本
      const q = u.search.length > 30 ? `${u.search.slice(0, 30)}…` : u.search;
      if (u.origin === baseOrigin) {
        sameOrigin = true;
        s = `${u.pathname}${q}`;
      } else {
        host = u.host;
        s = `${host}${u.pathname}${q}`;
      }
    } else {
      s = raw;
    }
  } catch {
    s = raw;
  }
  if (s.length <= 40) return s;
  // 跨源：host + … + rest 尾部，总长恰 40。host ≥ 39 时尾部一个字符都塞不下，退回整体截断
  if (!sameOrigin && host.length + 1 < 40) {
    return `${host}…${s.slice(host.length).slice(-(40 - host.length - 1))}`;
  }
  return `…${s.slice(-39)}`;
}

function serialize(
  node: SnapNode, depth: number, lines: string[], baseOrigin: string,
  detail: SnapshotDetail, fold: { n: number },
): void {
  // 两层判定：先按既有结构规则（纯布局 generic 折叠、子节点上提），再叠加档位过滤。
  // 两层都通过才出行——shouldEmit 与 keepAtDetail 口径不同是设计使然：full 档仍需
  // 宽松的结构规则保留全量，不是要把两者收敛成一套。
  const structural = shouldEmit(node);
  const keep = keepAtDetail(node, detail);
  const emit = structural && keep;

  if (emit) {
    flushFold(lines, depth, fold);
    lines.push('  '.repeat(depth) + renderLine(node, baseOrigin));
  } else if (structural) {
    // 计数口径 = 「full 档会显示、本档藏了」的节点，数字即切到 full 能多看到的行数，
    // agent 可据此决策值不值得切档。纯布局 generic（structural 已先行滤掉）不计——
    // 它们在 full 档也不出行，计进去只是几百个布局 div 堆出的噪声。
    fold.n += 1;
  }
  const nextDepth = emit ? depth + 1 : depth;
  for (const c of node.children) serialize(c, nextDepth, lines, baseOrigin, detail, fold);
}

/** 输出并清空折叠计数。相邻多个被滤节点合并成一行。
 *  措辞刻意中性「未展开节点」：被滤的可能是 img/navigation/list 这类非交互元素，
 *  也可能是白名单外的 ARIA 角色，说成「纯文本/容器」以偏概全。 */
function flushFold(lines: string[], depth: number, fold: { n: number }): void {
  if (fold.n === 0) return;
  lines.push('  '.repeat(depth) + `… [${fold.n} 个未展开节点]`);
  fold.n = 0;
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
