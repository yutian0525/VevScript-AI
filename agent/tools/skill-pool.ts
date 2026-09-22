// agent/tools/skill-pool.ts
// 技能池五工具执行器（spec §4）。与 UI 共用 background/skill-writes 编排层——AI 改技能 = 用户改技能。
// 全部豁免受限页预检（registry 在 RESTRICTED 检查之前分发）：不碰页面内容，纯 storage 操作。

import type { Skill, SkillSummary, ToolResult } from '../../shared/types';
import type { SkillPatch } from '../../shared/messages';
import { getSkill, listSkills, toSkillSummary } from '../../storage/skills';
import { searchSkills } from '../../shared/skill-search';
import {
  handleCreateSkill, handleDeleteSkill, handleGetSkill, handleUpdateSkill, toSkillMd,
} from '../../background/skill-writes';

const err = (e: unknown) => (e instanceof Error ? e.message : String(e));

// create_skill 的 source 长度硬闸（spec §4 第 1 道闸）：阈值同 create_script——瓶颈不是 storage 的
// 64KB 上限，而是单次工具调用的输出上限，两者是同一个物理约束。骨架（frontmatter + 正文开头）
// 远小于此，不会触发；只拦模型逐 token 吐出的 source。
// patch.text 同样是模型逐 token 生成的，受同一个单次输出上限约束，但刻意不在此设闸：总量有 storage
// 的 64KB 兜底，且改坏 frontmatter 会当场解析失败报错——与脚本池行为一致，失败响亮，不需要第二道闸。
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

export async function doListSkills(args: { enabled?: boolean; query?: string }): Promise<ToolResult> {
  try {
    let skills: SkillListEntry[] = (await listSkills()).map((s) => ({
      ...toSkillSummary(s), contentChars: s.content.length,
    }));
    // != null 而非 !== undefined：模型 JSON 透传的 null 会被后者当成「要过滤」，于是静默返回空列表——
    // 读起来就是「技能库是空的」，而查重恰恰是写技能前的第一步。写路径用的是同一个判据。
    if (args.enabled != null) skills = skills.filter((s) => s.enabled === args.enabled);

    const q = typeof args.query === 'string' ? args.query.trim() : '';
    if (!q) return { ok: true, data: { skills } };

    const hits = searchSkills(skills, q);
    // 命中 0 个时不返回空列表——模型读到空数组会以为技能库是空的。给诊断（同 query_page 命中 0 个的思路）。
    // 基数口径是检索范围（enabled 过滤后的集合）而非全库：紧随其后的前 10 个出自同一集合，两种口径混用
    // 会让模型把「范围内无命中」误读成「全库没技能」，查重（写技能前的第一步）随之误判。
    if (hits.length === 0) {
      return {
        ok: true,
        data: {
          skills: [],
          hint: `无匹配「${q}」；检索范围内共 ${skills.length} 个，前 10 个是：`
            + skills.slice(0, 10).map((s) => `/${s.command} ${s.name}`).join('、'),
        },
      };
    }
    return { ok: true, data: { skills: hits.map((h) => h.skill) } };
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
    // patch 缺失或非对象时，编排层会在 patch[k] 上抛裸英文 TypeError——工具边界先给可操作的中文
    if (args.patch == null || typeof args.patch !== 'object') {
      return { ok: false, error: 'update_skill 需要 patch（至少包含 text / append / replace / enabled 之一）' };
    }
    const { skill, warnings } = await handleUpdateSkill(args.id, args.patch);
    return { ok: true, data: toWriteResult(skill, warnings) };
  } catch (e) {
    return { ok: false, error: `update_skill 失败：${err(e)}` };
  }
}

export async function doDeleteSkill(args: { id: string }): Promise<ToolResult> {
  try {
    // 删除不可逆，且技能页不留痕（'agent' 徽标只保护 AI 建的技能事后可审计，删除没有对应物）。
    // 故 agent 只能删自己在对话里建的——用户手写/导入的技能请用户到技能页自行删除。
    // builtin 不在此拦：storage 层已有「不可删除」的固定文案，交给它兜底（两处文案不同，别覆盖）。
    const skill = await getSkill(args.id);
    if (skill && !skill.builtin && skill.source !== 'agent') {
      return {
        ok: false,
        error: `「${skill.name}」不是 AI 在对话里创建的技能，delete_skill 只能删自己建的；`
          + '删除不可逆，请让用户到技能页自行删除',
      };
    }
    await handleDeleteSkill(args.id);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `delete_skill 失败：${err(e)}` };
  }
}
