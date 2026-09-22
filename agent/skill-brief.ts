// agent/skill-brief.ts
// 技能清单的 prompt 整形纯函数（spec §7.1）：排序 → 封顶 → 描述截断。
// 与 memory-prompt.ts 同构：prompt 整形逻辑独立成纯函数模块，便于单测。
//
// 排序必须确定性：清单块在 system 消息里，是缓存前缀的一部分。
// 顺序抖动 = 前缀抖动 = 缓存全废（spec 决策 9）。故一律用 locale 无关的比较，
// 不用 localeCompare——后者随 locale 变化，会让同一份数据在不同环境下排出不同顺序。

export interface SkillBrief {
  name: string;
  command: string;
  description: string;
  /** 内置技能：常驻清单，不占 SKILL_LIST_CAP 名额 */
  builtin?: boolean;
  createdAt: number;
}

/** 用户技能（非内置）进清单的上限。 */
export const SKILL_LIST_CAP = 20;
/** 描述字符上限；超出在最后一个「；」或「，」处截断。 */
export const SKILL_DESC_MAX = 60;

/** 截断到 limit：优先在 limit 之前最后一个「；」「，」处切（技能简述的惯用写法是
 *  「做什么；什么时候触发」，在那里切能保住完整语义单元）；无分隔符则硬切。 */
export function truncateDescription(desc: string, limit = SKILL_DESC_MAX): string {
  if (desc.length <= limit) return desc;
  const head = desc.slice(0, limit);
  const cut = Math.max(head.lastIndexOf('；'), head.lastIndexOf('，'));
  return `${cut > 0 ? head.slice(0, cut) : head}…`;
}

const byCommand = (a: SkillBrief, b: SkillBrief): number =>
  a.command < b.command ? -1 : a.command > b.command ? 1 : 0;

/** 排序 + 封顶。内置在前（createdAt 升序 = builtin.md 投放顺序），用户技能在后
 *  （createdAt 降序，最新在前——新写的技能更可能是当前任务需要的）。
 *  同 createdAt 用 command 字典序兜底，保证全序（确定性是硬要求）。 */
export function selectSkillBriefs(
  briefs: SkillBrief[],
  cap = SKILL_LIST_CAP,
): { shown: SkillBrief[]; hidden: number } {
  const builtins = briefs
    .filter((s) => s.builtin)
    .sort((a, b) => a.createdAt - b.createdAt || byCommand(a, b));
  const users = briefs
    .filter((s) => !s.builtin)
    .sort((a, b) => b.createdAt - a.createdAt || byCommand(a, b));
  const shownUsers = users.slice(0, cap);
  return { shown: [...builtins, ...shownUsers], hidden: users.length - shownUsers.length };
}
