// content/locator-diagnose.ts
// 定位失败诊断（spec §5.3）。只在失败路径调用，与 locator.ts 的匹配逻辑分开——
// 匹配是热路径要快，诊断是冷路径可以慢但要信息足。
// 匹配口径必须复用 locator.ts（queryLocator/matchText/norm），不写第二套：诊断给的
// 「放宽后能命中 N 个」若与真实匹配行为对不上，agent 会按假情报改 locator，越改越偏。
import { queryLocator, norm, matchText, describeLocator, type Locator, type SemanticLocator } from './locator';
import { isHidden } from './snapshot/visibility';

export interface ElementBrief {
  tag: string;
  class?: string;
  text: string;
}

export interface LocatorDiagnosis {
  matched: number;
  relaxed?: Record<string, number>;
  nearMiss?: ElementBrief[];
  ambiguous?: ElementBrief[];
  hint: string;
}

const TEXT_CAP = 40;
const NEAR_MISS_CAP = 3;
const AMBIGUOUS_CAP = 5;

export function briefElement(el: Element): ElementBrief {
  // class 取完整属性值 trim 后判空——首个 class 名才代表元素身份（tailwind 的
  // 组合类名里第一个通常是布局占位），整体空串才不带字段，保留其余有信息量的名字。
  const cls = el.getAttribute('class')?.trim();
  const t = norm(el.textContent ?? '');
  const brief: ElementBrief = {
    tag: el.tagName.toLowerCase(),
    text: t.length > TEXT_CAP ? `${t.slice(0, TEXT_CAP)}…` : t,
  };
  if (cls) brief.class = cls;
  return brief;
}

/** 安全计数：locator 非法等异常按 0 计，诊断本身不该抛。 */
function countOf(loc: Locator, root: Element): number {
  try {
    return queryLocator(loc, { within: root }).elements.length;
  } catch {
    return 0;
  }
}

/** 提取 CSS 选择器最后一段的 tag 名（用于放宽计数）。无 tag 段返回 null。
 *  只取末段：完整选择器的约束都在最后一棒，放宽计数问的是「这一类元素页面有多少」。 */
function tagOfSelector(sel: string): string | null {
  const last = sel.trim().split(/\s+|>|\+|~/).filter(Boolean).pop() ?? '';
  const m = /^([a-zA-Z][\w-]*)/.exec(last);
  return m ? m[1]! : null;
}

/** 文本相似候选：与目标文本互相包含的可见元素，按「文本长度与目标的差」升序
 *  （最像的在前），截 3 条。排除还有后代也命中的祖先——否则 body/div 包装层
 *  文本更长反而排前，候选名额全被容器占掉。 */
function findNearMiss(want: string, root: Element): ElementBrief[] {
  const w = norm(want);
  if (!w) return [];
  const hits = Array.from(root.querySelectorAll('*')).filter((el) => {
    if (isHidden(el)) return false;
    const t = matchText(el);
    if (!t) return false;
    return t.includes(w) || w.includes(t);
  });
  const deepest = hits.filter((el) => !hits.some((o) => o !== el && el.contains(o)));
  return deepest
    .sort((a, b) => Math.abs(matchText(a).length - w.length) - Math.abs(matchText(b).length - w.length))
    .slice(0, NEAR_MISS_CAP)
    .map(briefElement);
}

export function diagnoseMiss(loc: Locator, root: Element): LocatorDiagnosis {
  if (typeof loc === 'number') {
    return {
      matched: 0,
      hint: `uid ${loc} 已失效（页面结构变化或元素被移除）。重新 take_snapshot 或 query_page 取新 uid，也可改用选择器/语义 locator 以免受快照时序影响。`,
    };
  }

  if (typeof loc === 'string') {
    const tag = tagOfSelector(loc);
    const relaxed: Record<string, number> = {};
    if (tag) {
      relaxed[`${tag} 全部`] = countOf(tag, root);
      return {
        matched: 0,
        relaxed,
        hint: relaxed[`${tag} 全部`]
          ? `页面有 ${relaxed[`${tag} 全部`]} 个 <${tag}>，但没有匹配完整选择器 "${loc}" 的。类名可能是动态生成的——改用语义 locator 更稳。`
          : `没有匹配选择器的元素。改用语义 locator（{ role, text }）按角色与文本定位，不依赖类名。`,
      };
    }
    return {
      matched: 0,
      hint: `没有匹配选择器的元素。改用语义 locator（{ role, text }）按角色与文本定位，不依赖类名。`,
    };
  }

  // 语义 locator：relaxed 逐级放宽计数。刻意不复用 makePredicate——计数问的是
  // 「单独放宽这一档后能命中多少」，是独立的探针而非原 locator 的子集。
  const relaxed: Record<string, number> = {};
  let nearMiss: ElementBrief[] | undefined;

  if (loc.text) {
    relaxed['text 精确匹配（忽略 role）'] = countOf({ text: loc.text, exact: true }, root);
    relaxed['text 包含匹配（忽略 role）'] = countOf({ text: loc.text }, root);
    nearMiss = findNearMiss(loc.text, root);
  }
  if (loc.role) {
    relaxed[`role=${loc.role} 全部`] = countOf({ role: loc.role }, root);
  }

  return {
    matched: 0,
    relaxed: Object.keys(relaxed).length ? relaxed : undefined,
    nearMiss: nearMiss?.length ? nearMiss : undefined,
    hint: buildMissHint(loc, relaxed, nearMiss, root),
  };
}

/** 语义 locator 的 hint 组装，按信息量降序取第一个可用分支：
 *  near 锚点状态 → role/text 线索交叉 → 逐项计数 → 兜底。 */
function buildMissHint(
  loc: SemanticLocator,
  relaxed: Record<string, number>,
  nearMiss: ElementBrief[] | undefined,
  root: Element,
): string {
  // near 分支先行：锚点文本在不在页面，是两种完全不同的失败——
  // 找不到锚点（去滚动/确认文案）vs 锚点在但附近没目标（结构假设错了）。
  if (loc.near) {
    const anchorExists = norm(root.textContent ?? '').includes(norm(loc.near));
    if (!anchorExists) {
      return `页面上未找到文本「${loc.near}」，near 无锚点可用。确认该文字是否在当前视图内（可能需要先滚动或展开），或改用 { role, text } 直接定位目标。`;
    }
    return `找到了「${loc.near}」，但其附近没有满足其余条件的元素${loc.role ? `（role=${loc.role}）` : ''}。该标签与控件可能不在同一容器内——改用选择器，或放宽 role 后用 query_page 看看附近有什么。`;
  }

  const containCount = relaxed['text 包含匹配（忽略 role）'] ?? 0;
  const roleCount = loc.role ? (relaxed[`role=${loc.role} 全部`] ?? 0) : 0;

  // exact 精确失败但放宽包含能命中：根因是 exact 卡的而非 role——若落到下面的
  // role 分支会产出「它是 <button> 不是 button」这类自相矛盾文案（探针 P4 实录），
  // 必须先分流。去掉 exact 在此必然有效（包含计数 > 0）。
  if (loc.exact && containCount > 0) {
    const nm = nearMiss?.[0];
    return nm
      ? `exact 精确匹配未命中，但放宽为包含匹配能命中 ${containCount} 个元素（最像的：<${nm.tag}> "${nm.text}"）。去掉 exact 改用包含匹配，或把 text 改成元素的实际完整文本。`
      : `exact 精确匹配未命中，但放宽为包含匹配能命中 ${containCount} 个元素。去掉 exact 改用包含匹配。`;
  }

  // 最强线索：文本在页面上、候选也挑出来了，只是 role 卡住——直接点名那个元素。
  if (loc.role && containCount > 0 && nearMiss?.length) {
    const nm = nearMiss[0]!;
    const cls = nm.class?.split(/\s+/)[0];
    return `有一个元素文本为"${nm.text}"，但它是 <${nm.tag}> 不是 ${loc.role}。改用 { text:"${loc.text}" } 不限 role，或直接用选择器 ${nm.tag}${cls ? `.${cls}` : ''}。`;
  }
  if (loc.role && roleCount === 0) {
    return `页面上没有任何 role=${loc.role} 的元素。该角色可能判定不同（本扩展的 role 由标签与 role 属性推导）——先用 query_page 只按 { text } 查，看命中元素实际是什么角色。`;
  }
  if (containCount === 0 && loc.text) {
    return `页面上没有包含"${loc.text}"的元素。文字可能还没渲染（需先 waitFor）、在跨域 iframe 里（无法访问），或与页面实际文案不同（含空格/标点差异）。`;
  }
  return `未找到匹配 ${describeLocator(loc)} 的元素。用 query_page 逐步放宽条件定位。`;
}

export function diagnoseAmbiguous(loc: Locator, elements: Element[]): LocatorDiagnosis {
  return {
    matched: elements.length,
    ambiguous: elements.slice(0, AMBIGUOUS_CAP).map(briefElement),
    hint: `${describeLocator(loc)} 命中 ${elements.length} 个元素，无法确定操作哪个。加 nth（0-based，如 nth:0 取第一个）收窄，或用 opts.within 限定在某个容器内查找。`,
  };
}
