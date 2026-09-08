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
  /** 起始文档。缺省 globalThis.document。 */
  doc?: Document;
}

export interface QueryResult {
  elements: Element[];
  /** 是否因 nth 收窄过（进 trace 用，区分「只命中一个」与「命中多个取其一」）。 */
  nthApplied: boolean;
  /** 跨域 iframe 跳过数（后续任务填充，此处恒 0）。 */
  skippedFrames: number;
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
  const parts: string[] = [];
  if (loc.role) parts.push(`role:"${loc.role}"`);
  if (loc.text) parts.push(`text:"${loc.text}"`);
  if (loc.near) parts.push(`near:"${loc.near}"`);
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

export function queryLocator(loc: Locator, opts: QueryOpts = {}): QueryResult {
  const doc = opts.doc ?? globalThis.document;
  const root = opts.within ?? doc.body;
  if (!root) return { elements: [], nthApplied: false, skippedFrames: 0 };

  if (typeof loc === 'number') {
    const el = resolveUid(loc);
    return { elements: el ? [el] : [], nthApplied: false, skippedFrames: 0 };
  }

  if (typeof loc === 'string') {
    let found: Element[];
    try {
      found = Array.from(root.querySelectorAll(loc));
    } catch {
      throw new Error(`选择器非法：${loc}`);
    }
    return { elements: found.filter((el) => !isHidden(el)), nthApplied: false, skippedFrames: 0 };
  }

  if (!hasCondition(loc)) {
    throw new Error('语义 locator 至少需要一个条件（role / text / near）');
  }

  // near 分支在下个任务接入；此处先按 role/text 过滤全部候选。
  let candidates = Array.from(root.querySelectorAll('*')).filter((el) => !isHidden(el));
  if (loc.role) candidates = candidates.filter((el) => computeRole(el) === loc.role);
  if (loc.text) {
    const want = norm(loc.text);
    candidates = candidates.filter((el) => {
      const t = matchText(el);
      return loc.exact ? t === want : t.includes(want);
    });
  }

  // nth 前收口：generic 容器/装饰后代不该挤占命中序列，也避免 nth 取到外层容器。
  const finalCandidates = dropGenericWhenSpecificExists(candidates);
  if (loc.nth != null) {
    const picked = finalCandidates[loc.nth];
    return { elements: picked ? [picked] : [], nthApplied: true, skippedFrames: 0 };
  }
  return { elements: finalCandidates, nthApplied: false, skippedFrames: 0 };
}
