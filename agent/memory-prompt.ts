// agent/memory-prompt.ts
// 记忆注入的纯函数（spec §3.3）：三层分组 + 半预算装箱 + 站点清单聚合，输出拆 stable / volatile 两段。
// 拆分的动因：说明与用法不随页面变（进 system，是缓存前缀的一部分），条目与站点清单依赖 page.url
// （每轮都可能变），两者混在一段会让整个前缀失去缓存价值（spec §4）。
//
// 三层的动因：记忆过滤依赖 page.url，而 page.url 每轮循环顶部才重读（loop 的 getPageInfo）。
// 模型在导航【前】规划路线时看不到目标站的记忆，第 3 层（站点清单）让它知道「那站有 N 条」，
// 可主动用 memory_list 取；不取也没事，导航后下一轮自动注入全文。
import { matchUrl } from '../shared/match-pattern';
import type { MemoryCap } from './mode';

export interface MemoryBrief {
  id: string;
  content: string;
  matches: string[];
  updatedAt: number;
}

export interface MemoryState {
  /** 总开关。false → 两段皆返回空串（连冷启动文案都不注入） */
  enabled: boolean;
  /** false 时说明文案不提写工具（工具没下发，避免幻觉调用） */
  writable: boolean;
  entries: MemoryBrief[];
}

/** 注入预算（字符）。最坏情况约 3K token，站点作用域下日常远小于此。 */
export const INJECT_BUDGET_CHARS = 6000;
/** 站点清单最多列多少个 pattern。 */
export const MAX_SITE_LIST = 30;

export function memoryStateToCap(s: MemoryState): MemoryCap {
  if (!s.enabled) return 'off';
  return s.writable ? 'full' : 'read';
}

/** 作用域标签：全局 / 单 pattern / 首个 pattern + 「等 N 条」。 */
function scopeLabel(matches: string[]): string {
  if (matches.length === 0) return '全局';
  if (matches.length === 1) return matches[0]!;
  return `${matches[0]!} 等 ${matches.length} 条`;
}

function renderEntry(m: MemoryBrief): string {
  return `[${m.id} ${scopeLabel(m.matches)}] ${m.content}`;
}

const byRecent = (a: MemoryBrief, b: MemoryBrief): number => b.updatedAt - a.updatedAt;

/** 按预算装箱：返回装进去的条目与消耗的字符数（未装进的留给调用方统计）。 */
function pack(entries: MemoryBrief[], budget: number): { taken: MemoryBrief[]; used: number } {
  const taken: MemoryBrief[] = [];
  let used = 0;
  for (const m of entries) {
    const cost = renderEntry(m).length + 1; // +1 换行
    if (used + cost > budget) continue;
    taken.push(m);
    used += cost;
  }
  return { taken, used };
}

/** 站点清单：pattern → 条数，按条数倒序，最多 MAX_SITE_LIST 个。 */
function siteList(entries: MemoryBrief[]): string {
  const counts = new Map<string, number>();
  for (const m of entries) {
    for (const p of m.matches) counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const shown = sorted.slice(0, MAX_SITE_LIST);
  const line = shown.map(([p, n]) => `${p} (${n})`).join(' · ');
  const rest = sorted.length - shown.length;
  return rest > 0 ? `${line}，另有 ${rest} 个站点` : line;
}

function usageBlock(writable: boolean): string {
  if (!writable) {
    return [
      '- 这些记忆由用户手工维护，你只能读、不能改（本轮未提供写入工具）。',
      '- 想查看未列在上面的站点记忆，用 memory_list（传 scope 可按站点关键词或完整 URL 过滤）。',
    ].join('\n');
  }
  return [
    '- 发现值得长期保留的信息时调用 memory_write 记下：用户的偏好与习惯、某站点的固定操作路径、踩过的坑与解法、账号/环境的稳定事实。写入无需征求用户同意，但要在回复里简短告知你记了什么。',
    '- 不要记一次性的临时信息：本轮的中间结果、页面上随时会变的数字、马上就用完的数据。',
    '- 记忆过时或错误时，用 memory_write（带 id）改写、或 memory_delete 删除，不要留下互相矛盾的两条。',
    '- 只在当前页面命中作用域时，该站的记忆才会出现在上面。**导航到新站点后，该站记忆会在下一步出现在这里**；需要提前知道就用 memory_list（传 scope 可按站点关键词或完整 URL 过滤）。',
  ].join('\n');
}

export interface MemoryPromptParts {
  /** 稳定部分：说明与用法。进 system 消息，是缓存前缀的一部分。 */
  stable: string;
  /** 易变部分：条目与站点清单（依赖 page.url）。进尾部易变块，无内容时为 ''。 */
  volatile: string;
}

/**
 * 组装记忆块，返回 stable / volatile 两段。三层：全局全文 → 当前页命中全文 → 其余站点清单（无正文）。
 *
 * 预算 INJECT_BUDGET_CHARS 由全局与站点两层【各分半】，某层未用满的额度让给另一层——
 * 全局记忆被挤掉会立刻被用户察觉，站点记忆被挤掉会让 agent 在当前页重复踩坑，都不能牺牲。
 */
export function buildMemoryPrompt(state: MemoryState, url: string): MemoryPromptParts {
  if (!state.enabled) return { stable: '', volatile: '' };

  const globals = state.entries.filter((m) => m.matches.length === 0).sort(byRecent);
  const others = state.entries.filter((m) => m.matches.length > 0);
  const hits = others.filter((m) => matchUrl(m.matches, url)).sort(byRecent);
  const misses = others.filter((m) => !matchUrl(m.matches, url));

  // 第一趟：各装半额
  const half = Math.floor(INJECT_BUDGET_CHARS / 2);
  const g1 = pack(globals, half);
  const h1 = pack(hits, half);
  // 第二趟：把两层剩下的额度合并，按同样顺序再补装未进去的条目
  let spare = INJECT_BUDGET_CHARS - g1.used - h1.used;
  const g2 = pack(globals.filter((m) => !g1.taken.includes(m)), spare);
  spare -= g2.used;
  const h2 = pack(hits.filter((m) => !h1.taken.includes(m)), spare);

  const shownGlobals = globals.filter((m) => g1.taken.includes(m) || g2.taken.includes(m));
  const shownHits = hits.filter((m) => h1.taken.includes(m) || h2.taken.includes(m));
  const droppedCount =
    globals.length - shownGlobals.length + (hits.length - shownHits.length);

  const stable: string[] = ['\n\n## 记忆\n'];
  if (state.entries.length === 0) {
    stable.push('你具备跨会话的长期记忆，当前为空。\n');
  } else {
    stable.push('下面是你在之前的会话中记录的、以及用户手工维护的长期记忆，它们跨会话持久存在。\n');
  }
  stable.push(usageBlock(state.writable));

  // 易变部分：条目依赖 page.url，站点清单依赖「哪些站点没命中」——两者都随页面变化，
  // 必须与稳定部分分开承载，否则每轮前缀都变（spec §4）。
  const vol: string[] = [];
  if (shownGlobals.length > 0 || shownHits.length > 0) {
    vol.push('记忆条目（当前生效）：');
    for (const m of shownGlobals) vol.push(renderEntry(m));
    for (const m of shownHits) vol.push(renderEntry(m));
  }
  if (droppedCount > 0) {
    vol.push('', `另有 ${droppedCount} 条记忆因长度限制未列出，可用 memory_list 查看。`);
  }
  if (misses.length > 0) {
    vol.push('', `其他站点已有记忆（需要时用 memory_list 取全文）：\n${siteList(misses)}`);
  }
  return { stable: stable.join('\n'), volatile: vol.join('\n') };
}
