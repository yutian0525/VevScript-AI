// content/locator.ts
// locator 匹配实现（spec §3.2）。类型见 shared/types.ts（跨 SW/CS 边界）。
// 被 query_page 工具与页内 $/$$ helper 共用——探查试出的 locator 能原样搬进脚本。
// 刻意不 import 任何 helper/事件代码：query_page 路径不该拉入事件实现。
import type { Locator, SemanticLocator } from '../shared/types';
import { computeRole, computeName, visibleText } from './snapshot/roles';
import { isHidden } from './snapshot/visibility';
import { resolveUid } from './snapshot/build';

export type { Locator, SemanticLocator };

export interface QueryOpts {
  /** 限定搜索根。缺省为 doc.body。 */
  within?: Element;
  /** 预留：测试注入替身文档用。 */
  doc?: Document;
}

export interface QueryResult {
  elements: Element[];
  /** nth 参数是否参与过收窄。注意它【不区分】「只命中一个」与「命中多个取其一」——
   *  nth:0 恰好单命中时也是 true。消费方（trace）若要区分，需要的是收窄前的命中数，
   *  届时应加 matchedBeforeNth 字段而非改这个布尔的语义（当前无消费方）。 */
  nthApplied: boolean;
  /** 跨域 iframe 跳过数（后续任务填充，此处恒 0）。 */
  skippedFrames: number;
  /** near 命中经由哪一级判定（仅 near 分支填充）。诊断用。 */
  nearTier?: 'label' | 'dom' | 'geometry';
}

/** 折叠空白 + trim。文本比较的统一口径，与 roles.ts 的 normalize 一致。 */
export function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** 元素用于 text 匹配的文本：优先可访问名，无名时退回自身可见文本。
 *  退回是必要的——generic 不在 NAME_FROM_CONTENT，纯文本 div 的 computeName 为空。 */
export function matchText(el: Element): string {
  const name = norm(computeName(el));
  return name || norm(visibleText(el));
}

export function describeLocator(loc: Locator): string {
  if (typeof loc === 'string') return `选择器 "${loc}"`;
  if (typeof loc === 'number') return `uid ${loc}`;
  // text/near 用 JSON.stringify 包值：locator 的 text 是模型写的，常含引号——
  // 直接内插会产出 text:"he said "hi"" 这种自嵌套，模型读第二遍就解析错位（审查探针实录）。
  const parts: string[] = [];
  if (loc.role) parts.push(`role:${JSON.stringify(loc.role)}`);
  if (loc.text) parts.push(`text:${JSON.stringify(loc.text)}`);
  if (loc.near) parts.push(`near:${JSON.stringify(loc.near)}`);
  if (loc.exact) parts.push('exact:true');
  if (loc.nth != null) parts.push(`nth:${loc.nth}`);
  return `{ ${parts.join(', ')} }`;
}

/** 语义 locator 是否有任何可用条件。空条件会退化成「全页元素」，必须拒。 */
function hasCondition(loc: SemanticLocator): boolean {
  return Boolean(loc.role || loc.text || loc.near);
}

/** 存在非 generic 命中时，丢弃所有 generic 命中。
 *  规则是「有非 generic 就丢 generic」，不是「按深度排除祖先」——后者会把
 *  <button><span>删除</span></button> 里的真 button 当祖先删掉，只剩 span。
 *  只影响「有 text 无 role」场景：role 一旦指定，computeRole 过滤后候选全是同一 role
 *  （要么全 generic 要么全非 generic），规则永不混合触发。 */
function dropGenericWhenSpecificExists(candidates: Element[]): Element[] {
  const hasSpecific = candidates.some((el) => computeRole(el) !== 'generic');
  if (!hasSpecific) return candidates;
  return candidates.filter((el) => computeRole(el) !== 'generic');
}

/** 由语义 locator 的 role/text/exact 构造元素谓词（不含 near/nth）。
 *  near 分支与非 near 分支共用，保证两路对 role/text 的口径完全一致。 */
function makePredicate(loc: SemanticLocator): (el: Element) => boolean {
  const want = loc.text != null ? norm(loc.text) : null;
  return (el: Element) => {
    if (isHidden(el)) return false;
    if (loc.role && computeRole(el) !== loc.role) return false;
    if (want != null) {
      const t = matchText(el);
      if (loc.exact ? t !== want : !t.includes(want)) return false;
    }
    return true;
  };
}

/** 找锚点：文本包含 nearText 的最深层元素（排除还有后代也包含该文本的祖先）。
 *  不排除的话 body 这类含全部文本的祖先也会当锚点，near 会退化成全页搜索。 */
function findAnchors(nearText: string, root: Element): Element[] {
  const want = norm(nearText);
  const hits = Array.from(root.querySelectorAll('*')).filter(
    (el) => !isHidden(el) && norm(el.textContent ?? '').includes(want),
  );
  return hits.filter((el) => !hits.some((other) => other !== el && el.contains(other)));
}

/** 第一级：显式 label / aria-labelledby 关联。命中返回目标元素。
 *  覆盖 label[for]（正向）、包裹式 label（label.control）、aria-labelledby（反向）。 */
function byExplicitLabel(anchor: Element, pred: (el: Element) => boolean): Element | null {
  const doc = anchor.ownerDocument;
  const label = anchor.tagName === 'LABEL' ? (anchor as HTMLLabelElement) : anchor.closest('label');
  if (label) {
    const forId = label.getAttribute('for');
    const target = forId ? doc.getElementById(forId) : (label as HTMLLabelElement).control ?? null;
    if (target && pred(target)) return target;
    // 包裹式 label 的 control 在部分引擎下可能为 null，退回扫 label 后代
    const inner = Array.from(label.querySelectorAll('*')).find(pred);
    if (inner) return inner;
  }
  if (anchor.id) {
    const referrers = Array.from(doc.querySelectorAll(`[aria-labelledby~="${CSS.escape(anchor.id)}"]`));
    const hit = referrers.find(pred);
    if (hit) return hit;
  }
  return null;
}

/** 第三级：几何最近。rect 全 0（jsdom / 0 尺寸）时返回 null，交回 DOM 序决定。
 *  纵向距离加权 3 倍：保护的是【同一视觉行】——同行横向 40px 的真标签（得分 40）
 *  要赢过正下方 30px 的无关元素（得分 90）。分界线：纵向偏移 < 横向偏移/3 时正上/正下方赢。
 *  注意正上方 15px 的标签（45）会输给同行 40px 的元素（40）——加权刻意偏行不偏纵，
 *  实测过这组对照（审查探针 P3），若要改偏好先想清楚表单布局的多数形态。 */
function byGeometry(anchor: Element, candidates: Element[]): Element | null {
  const a = anchor.getBoundingClientRect();
  if (a.width === 0 && a.height === 0) return null;
  const ax = a.left + a.width / 2;
  const ay = a.top + a.height / 2;
  let best: Element | null = null;
  let bestScore = Infinity;
  for (const c of candidates) {
    const r = c.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const score = Math.abs(cx - ax) + Math.abs(cy - ay) * 3;
    if (score < bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

/** near 主流程：锚点 → 三级判定。返回命中元素与所用级别。
 *  刻意不走 dropGenericWhenSpecificExists：near 靠 pred 精确定位，
 *  且第二级「逐层向上」本身已把范围收窄到最近祖先层，再降噪反而会误删锚点兄弟。 */
function queryNear(
  loc: SemanticLocator,
  root: Element,
): { elements: Element[]; tier?: 'label' | 'dom' | 'geometry' } {
  const pred = makePredicate(loc);
  const anchors = findAnchors(loc.near!, root);

  // 第一级：显式关联最可靠，任一锚点命中即止。
  for (const anchor of anchors) {
    const explicit = byExplicitLabel(anchor, pred);
    if (explicit) return { elements: [explicit], tier: 'label' };
  }

  // 第二级：从锚点逐层向上扩大搜索范围，最近祖先层命中即止。
  // 同层唯一 → 直接采用；同层多个 → 交几何判定（jsdom rect 全 0 时退回 DOM 序）。
  for (const anchor of anchors) {
    let scope: Element | null = anchor.parentElement;
    while (scope && scope !== root.parentElement) {
      const found = Array.from(scope.querySelectorAll('*')).filter(pred);
      if (found.length === 1) return { elements: found, tier: 'dom' };
      if (found.length > 1) {
        const geo = byGeometry(anchor, found);
        return geo
          ? { elements: [geo, ...found.filter((e) => e !== geo)], tier: 'geometry' }
          : { elements: found, tier: 'dom' };
      }
      scope = scope.parentElement;
    }
  }
  return { elements: [] };
}

/** 收集 root 及其后代同源 iframe 的搜索根（深度优先，主帧在前）。
 *  与快照层（snapshot/build.ts 的 safeFrameDoc）同一取舍：跨域 iframe 的
 *  contentDocument 抛 SecurityError 或返回 null，计入 skipped 让上层知道搜索有盲区。
 *  推入的是帧的 body 而非 frame 元素——querySelectorAll 不会进入 iframe 的
 *  内容文档，帧 body 自身就是等价于主帧 body 的搜索根。 */
export function collectRoots(root: Element): { roots: Element[]; skipped: number } {
  const roots: Element[] = [root];
  let skipped = 0;

  const descend = (scope: Element) => {
    for (const frame of Array.from(scope.querySelectorAll('iframe, frame'))) {
      let body: Element | null = null;
      try {
        body = (frame as HTMLIFrameElement).contentDocument?.body ?? null;
      } catch {
        body = null;
      }
      if (body) { roots.push(body); descend(body); }
      else skipped += 1;
    }
  };
  descend(root);
  return { roots, skipped };
}

export function queryLocator(loc: Locator, opts: QueryOpts = {}): QueryResult {
  const doc = opts.doc ?? globalThis.document;
  const root = opts.within ?? doc.body;
  if (!root) return { elements: [], nthApplied: false, skippedFrames: 0 };

  if (typeof loc === 'number') {
    const el = resolveUid(loc);
    return { elements: el ? [el] : [], nthApplied: false, skippedFrames: 0 };
  }

  // CSS / 语义两分支共用的搜索根：主帧在前保证「主帧优先」，skipped 随结果透出。
  // uid 分支不走这里——uid 序列全局共享（快照已让帧内元素进 uidMap），不按根搜索。
  const { roots, skipped } = collectRoots(root);

  if (typeof loc === 'string') {
    // 逐根查询、任一根抛错即整体抛错：选择器非法是全量失败而非部分结果，
    // 中途吞掉会把「主帧命中的假象」留给调用方。
    const found: Element[] = [];
    try {
      for (const r of roots) found.push(...Array.from(r.querySelectorAll(loc)));
    } catch {
      throw new Error(`选择器非法：${loc}`);
    }
    return { elements: found.filter((el) => !isHidden(el)), nthApplied: false, skippedFrames: skipped };
  }

  if (!hasCondition(loc)) {
    throw new Error('语义 locator 至少需要一个条件（role / text / near）');
  }

  let candidates: Element[];
  let nearTier: 'label' | 'dom' | 'geometry' | undefined;
  if (loc.near) {
    // near 按根独立跑三级判定，首个有命中的帧定 tier（nearTier 只在还没有值时赋）。
    // 不跨帧合并后统一判定：near 的锚点/几何都以「同文档内」为前提，跨文档距离无意义。
    candidates = [];
    for (const r of roots) {
      const res = queryNear(loc, r);
      if (res.elements.length) {
        candidates.push(...res.elements);
        nearTier ??= res.tier;
      }
    }
  } else {
    // 非 near 路径：role/text 过滤 + generic 降噪（Task 5 规则，near 不走）。
    // 降噪刻意在【合并后】的结果上做——「主帧有非 generic 命中」要能压过帧内的
    // generic 容器，降噪若按根独立就退化成每帧各自为政，跨帧语义断裂。
    const pred = makePredicate(loc);
    candidates = roots.flatMap((r) => Array.from(r.querySelectorAll('*')).filter(pred));
    candidates = dropGenericWhenSpecificExists(candidates);
  }

  if (loc.nth != null) {
    const picked = candidates[loc.nth];
    return { elements: picked ? [picked] : [], nthApplied: true, skippedFrames: skipped, nearTier };
  }
  return { elements: candidates, nthApplied: false, skippedFrames: skipped, nearTier };
}
