// components/settings/memory-page-utils.ts
// 记忆页的纯逻辑：作用域文本 ↔ pattern 数组、非法行检出、列表过滤。
// 抽出来是为了不必渲染组件就能测这几条规则。
import type { MemoryEntry } from '../../shared/types';
import { isValidMatchPattern } from '../../shared/match-pattern';

/** 作用域输入框（每行一条）→ pattern 数组。空行忽略，全空 = 全局记忆。 */
export function parsePatternLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** 挑出非法 pattern（用于实时标红与保存前拦截）。 */
export function invalidPatterns(patterns: string[]): string[] {
  return patterns.filter((p) => !isValidMatchPattern(p));
}

/** 列表搜索：正文或作用域子串，大小写不敏感。 */
export function filterMemories(list: MemoryEntry[], query: string): MemoryEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter(
    (m) =>
      m.content.toLowerCase().includes(q) ||
      m.matches.some((p) => p.toLowerCase().includes(q)),
  );
}
