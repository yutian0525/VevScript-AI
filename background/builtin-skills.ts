// background/builtin-skills.ts
// 内置技能投放（onInstalled：安装 + 更新都触发）。四个内置技能以多文档 .md 随扩展打包
// （public/skills/builtin.md → 运行时 skills/builtin.md），经 parseSkillMdDocument 解析后
// 逐条按 command 合入技能池：已存在同 command（含用户从 .md 导入的同名技能）覆盖更新并打
// builtin 标记（保留用户 id/enabled——升级不重置启停状态）；不存在则新建。builtin 技能
// 不可删除（storage 层拒删），只可停用。

import { listSkills, saveSkill, newSkill } from '../storage/skills';
import { parseSkillMdDocument } from '../shared/skill-md';
import type { Skill } from '../shared/types';
import type { PublicPath } from 'wxt/browser';

export const BUILTIN_SKILLS_URL = '/skills/builtin.md';

/** 拉取打包的 builtin.md 并合入技能池。返回写入条数（新增 + 覆盖）。
 *  资源缺失/解析全失败时 throw（调用方决定是否静默）。 */
export async function seedBuiltinSkills(url: PublicPath = BUILTIN_SKILLS_URL): Promise<number> {
  const resp = await fetch(browser.runtime.getURL(url));
  if (!resp.ok) throw new Error(`内置技能资源读取失败：HTTP ${resp.status}`);
  const text = await resp.text();
  const docs = parseSkillMdDocument(text);
  const bad = docs.filter((d) => !d.ok);
  if (docs.length === 0 || bad.length === docs.length) {
    throw new Error(`内置技能资源解析失败（${docs.length} 条中 ${bad.length} 条坏）`);
  }

  const existing = await listSkills();
  const byCommand = new Map(existing.map((s) => [s.command, s]));
  let seeded = 0;
  for (const doc of docs) {
    if (!doc.ok) continue;
    const { name, description, command, content } = doc.skill;
    const prev = byCommand.get(command);
    const skill: Skill = prev
      ? // 覆盖更新：保留用户 id/createdAt/enabled（升级不重置启停），内容取扩展新版
        { ...prev, name, description, content, builtin: true, updatedAt: Date.now() }
      : { ...newSkill({ name, command, description, content }), builtin: true };
    await saveSkill(skill);
    byCommand.set(command, skill);
    seeded += 1;
  }
  return seeded;
}
