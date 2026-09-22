// shared/skill-search.ts
// 技能模糊检索（spec §7.4）。纯函数，无 storage / React 依赖。
//
// 存在的理由：系统提示词里的技能清单封顶 20 个，未列出的技能必须能被找回，
// 否则封顶就是能力阉割。打分五档，同分按 command 字典序兜底（确定性）。
import type { SkillSummary } from './types';

export interface SkillSearchHit {
  skill: SkillSummary & { contentChars: number };
  score: number;
}

const SCORE_EXACT_COMMAND = 100;
const SCORE_COMMAND_SUBSTR = 80;
const SCORE_NAME_SUBSTR = 60;
const SCORE_DESC_SUBSTR = 40;
const SCORE_SUBSEQUENCE = 20;

/** needle 的字符是否按序出现在 hay 中（不要求连续）。用于缩写检索（wscr → write-script）。 */
function isSubsequence(needle: string, hay: string): boolean {
  let i = 0;
  for (const ch of hay) {
    if (ch === needle[i]) i += 1;
    if (i === needle.length) return true;
  }
  return i === needle.length;
}

function scoreOne(
  skill: SkillSearchHit['skill'],
  q: string,
): number {
  const command = skill.command.toLowerCase();
  if (command === q) return SCORE_EXACT_COMMAND;
  if (command.includes(q)) return SCORE_COMMAND_SUBSTR;
  if (skill.name.toLowerCase().includes(q)) return SCORE_NAME_SUBSTR;
  if (skill.description.toLowerCase().includes(q)) return SCORE_DESC_SUBSTR;
  if (isSubsequence(q, command)) return SCORE_SUBSEQUENCE;
  return 0;
}

/** 按 query 检索技能。空 query（含纯空白）返回原序全量——保持 list_skills 的既有行为；
 *  命中 0 个返回空数组，诊断文案由工具层组装。 */
export function searchSkills(skills: SkillSearchHit['skill'][], query: string): SkillSearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return skills.map((skill) => ({ skill, score: 0 }));
  return skills
    .map((skill) => ({ skill, score: scoreOne(skill, q) }))
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score
      || (a.skill.command < b.skill.command ? -1 : a.skill.command > b.skill.command ? 1 : 0));
}
