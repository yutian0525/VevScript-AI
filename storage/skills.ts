// storage/skills.ts
// 技能池存储（spec §1.2）。单键 local:skills:index（Skill[]），与 storage/scripts.ts 同构。

import { storage } from 'wxt/utils/storage';
import { nanoid } from 'nanoid';
import type { Skill, SkillSummary } from '../shared/types';
import { SKILL_COMMAND_RE } from '../shared/skill-md';

const KEY = 'local:skills:index' as const;

export const MAX_SKILLS = 100;
export const MAX_CONTENT_LENGTH = 64 * 1024;
export const MAX_DESCRIPTION_LENGTH = 200;

export async function listSkills(): Promise<Skill[]> {
  return (await storage.getItem<Skill[]>(KEY)) ?? [];
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
  await storage.setItem(KEY, next);
}

/** 幂等：不存在也成功。 */
export async function deleteSkill(id: string): Promise<void> {
  const all = await listSkills();
  await storage.setItem(KEY, all.filter((s) => s.id !== id));
}

export async function setSkillEnabled(id: string, enabled: boolean): Promise<void> {
  const all = await listSkills();
  const next = all.map((s) => (s.id === id ? { ...s, enabled, updatedAt: Date.now() } : s));
  await storage.setItem(KEY, next);
}

export function toSkillSummary(s: Skill): SkillSummary {
  return {
    id: s.id, name: s.name, command: s.command,
    description: s.description, enabled: s.enabled, updatedAt: s.updatedAt,
  };
}

/** 新 skill 工厂：导入通道用。 */
export function newSkill(fields: { name: string; command: string; description: string; content: string }): Skill {
  const now = Date.now();
  return { id: nanoid(), enabled: true, createdAt: now, updatedAt: now, ...fields };
}
