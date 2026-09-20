// agent/tools/skill-pool.ts
// 技能池五工具执行器（spec §4）。与 UI 共用 background/skill-writes 编排层——AI 改技能 = 用户改技能。
// 全部豁免受限页预检（registry 在 RESTRICTED 检查之前分发）：不碰页面内容，纯 storage 操作。

import type { Skill, SkillSummary, ToolResult } from '../../shared/types';
import type { SkillPatch } from '../../shared/messages';
import { listSkills, toSkillSummary } from '../../storage/skills';
import {
  handleCreateSkill, handleDeleteSkill, handleGetSkill, handleUpdateSkill, toSkillMd,
} from '../../background/skill-writes';

const err = (e: unknown) => (e instanceof Error ? e.message : String(e));

// create_skill 的 source 长度硬闸（spec §4 第 1 道闸）：阈值同 create_script——瓶颈不是 storage 的
// 64KB 上限，而是单次工具调用的输出上限，两者是同一个物理约束。骨架（frontmatter + 正文开头）
// 远小于此，不会触发；只拦模型逐 token 吐出的 source，patch.text 不受限（总量由 storage 管）。
export const MAX_CREATE_LINES = 200;
export const MAX_CREATE_CHARS = 8192;

function createGateError(md: string): string | undefined {
  const lines = md.split('\n').length;
  if (lines <= MAX_CREATE_LINES && md.length <= MAX_CREATE_CHARS) return undefined;
  return `create_skill 的 source 过长（${lines} 行 / ${md.length} 字符，上限 ${MAX_CREATE_LINES} 行 / ${MAX_CREATE_CHARS} 字符）。`
    + '长技能请分步：本次只提交 frontmatter + 正文开头，再用 update_skill 的 patch.append 按小节逐段追加。';
}

/** 写操作的精简返回（spec §4）：不回灌 .md 全文，只给模型下一步决策需要的元信息。 */
function toWriteResult(skill: Skill, warnings: string[]) {
  return {
    id: skill.id,
    name: skill.name,
    command: skill.command,
    description: skill.description,
    enabled: skill.enabled,
    builtin: skill.builtin ?? false,
    source: skill.source,
    contentChars: skill.content.length,
    totalChars: toSkillMd(skill).length,
    warnings,
  };
}

/** 列表条目：摘要 + 正文字符数（体量感——看到 8000 字符就知道改写要分步）。 */
export type SkillListEntry = SkillSummary & { contentChars: number };

export async function doListSkills(args: { enabled?: boolean }): Promise<ToolResult> {
  try {
    let skills: SkillListEntry[] = (await listSkills()).map((s) => ({
      ...toSkillSummary(s), contentChars: s.content.length,
    }));
    if (args.enabled !== undefined) skills = skills.filter((s) => s.enabled === args.enabled);
    return { ok: true, data: { skills } };
  } catch (e) {
    return { ok: false, error: `list_skills 失败：${err(e)}` };
  }
}

export async function doGetSkill(args: { id: string }): Promise<ToolResult> {
  try {
    return { ok: true, data: await handleGetSkill(args.id) };
  } catch (e) {
    return { ok: false, error: `get_skill 失败：${err(e)}` };
  }
}

export async function doCreateSkill(args: { source?: string; enabled?: boolean }): Promise<ToolResult> {
  try {
    const md = args.source;
    if (typeof md !== 'string' || !md.trim()) {
      return { ok: false, error: 'create_skill 需要 source（完整的技能 .md：--- frontmatter --- + 正文）' };
    }
    // 长度硬闸在解析之前：长度错误比「缺 frontmatter」更可操作——模型该先改写作策略（分步）
    const gate = createGateError(md);
    if (gate) return { ok: false, error: gate };
    const { skill, warnings } = await handleCreateSkill({ md, enabled: args.enabled, source: 'agent' });
    return { ok: true, data: toWriteResult(skill, warnings) };
  } catch (e) {
    return { ok: false, error: `create_skill 失败：${err(e)}` };
  }
}

export async function doUpdateSkill(args: { id: string; patch: SkillPatch }): Promise<ToolResult> {
  try {
    const { skill, warnings } = await handleUpdateSkill(args.id, args.patch);
    return { ok: true, data: toWriteResult(skill, warnings) };
  } catch (e) {
    return { ok: false, error: `update_skill 失败：${err(e)}` };
  }
}

export async function doDeleteSkill(args: { id: string }): Promise<ToolResult> {
  try {
    await handleDeleteSkill(args.id);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `delete_skill 失败：${err(e)}` };
  }
}
