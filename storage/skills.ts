// storage/skills.ts
// 技能池存储（spec §1.2）。单键 local:skills:index（Skill[]），与 storage/scripts.ts 同构。

import { storage } from 'wxt/utils/storage';
import { nanoid } from 'nanoid';
import type { Skill, SkillSource, SkillSummary } from '../shared/types';
import { SKILL_COMMAND_RE } from '../shared/skill-md';

// 导出给 UI 侧 storage.watch 用——键名只此一处，改键不会让 watch 静默失效。
export const SKILLS_KEY = 'local:skills:index' as const;

export const MAX_SKILLS = 100;
export const MAX_CONTENT_LENGTH = 64 * 1024;
export const MAX_DESCRIPTION_LENGTH = 300;

export async function listSkills(): Promise<Skill[]> {
  return (await storage.getItem<Skill[]>(SKILLS_KEY)) ?? [];
}

export async function getSkill(id: string): Promise<Skill | undefined> {
  return (await listSkills()).find((s) => s.id === id);
}

/** upsert。数量上限 / command 唯一与格式 / 长度上限超限 throw（中文可读文案）。 */
export async function saveSkill(skill: Skill): Promise<void> {
  const all = await listSkills();
  const exists = all.some((s) => s.id === skill.id);
  if (!exists && all.length >= MAX_SKILLS) {
    throw new Error(`技能数量已达上限（${MAX_SKILLS} 条），请先删除部分技能`);
  }
  if (!SKILL_COMMAND_RE.test(skill.command)) {
    throw new Error(`command 格式非法（需 kebab-case 小写字母/数字/连字符）：${skill.command}`);
  }
  const owner = all.find((s) => s.command === skill.command);
  if (owner && owner.id !== skill.id) {
    throw new Error(`command「${skill.command}」已被其他技能使用`);
  }
  if (skill.content.length > MAX_CONTENT_LENGTH) {
    throw new Error(`技能正文超过上限（${MAX_CONTENT_LENGTH} 字符）`);
  }
  if (skill.description.length > MAX_DESCRIPTION_LENGTH) {
    throw new Error(`简述超过上限（${MAX_DESCRIPTION_LENGTH} 字符）`);
  }
  const next = exists ? all.map((s) => (s.id === skill.id ? skill : s)) : [...all, skill];
  await storage.setItem(SKILLS_KEY, next);
}

/** 幂等：不存在也成功。内置技能（builtin）拒删——只可停用。 */
export async function deleteSkill(id: string): Promise<void> {
  const all = await listSkills();
  const hit = all.find((s) => s.id === id);
  if (hit?.builtin) throw new Error('内置技能不可删除，如不需要可停用');
  await storage.setItem(SKILLS_KEY, all.filter((s) => s.id !== id));
}

export async function setSkillEnabled(id: string, enabled: boolean): Promise<void> {
  const all = await listSkills();
  const next = all.map((s) => (s.id === id ? { ...s, enabled, updatedAt: Date.now() } : s));
  await storage.setItem(SKILLS_KEY, next);
}

export function toSkillSummary(s: Skill): SkillSummary {
  return {
    id: s.id, name: s.name, command: s.command,
    description: s.description, enabled: s.enabled, builtin: s.builtin, source: s.source, updatedAt: s.updatedAt,
  };
}

/** 新 skill 工厂：导入通道与 AI 写技能通道共用。
 *  source 只在显式传入时落库——缺省不带该字段（等价于 'user'），内置技能也不打此标。 */
export function newSkill(
  fields: { name: string; command: string; description: string; content: string },
  source?: SkillSource,
): Skill {
  const now = Date.now();
  return {
    id: nanoid(), enabled: true, ...(source ? { source } : {}),
    createdAt: now, updatedAt: now, ...fields,
  };
}
