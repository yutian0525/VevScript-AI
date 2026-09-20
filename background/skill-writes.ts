// background/skill-writes.ts
// 技能池写编排层（spec §5）：CRUD 四个 handler，AI 工具（agent/tools/skill-pool.ts）与未来 UI
// 新建入口共用。与 background/scripts.ts 同定位；background/skills.ts 保持消息层不变。
//
// 文本为源：技能在 storage 里是 {name, command, description, content} 四字段，但写入一律走
// 完整 .md（frontmatter + 正文）→ parseSkillMd → 落库，读出用 serializeSkillMd 还原同一份 .md。
// 正文末尾就是全文末尾（frontmatter 在开头），故 patch.append 与脚本池语义完全一致。
// 单文档路径不走 parseSkillMdDocument 的拆分——正文里的 --- 水平线不会被吃掉。

import type { Skill, SkillSource } from '../shared/types';
import type { SkillPatch } from '../shared/messages';
import { parseSkillMd, serializeSkillMd, type SkillMdFields } from '../shared/skill-md';
import { appendText, replaceText } from '../shared/text-patch';
import { deleteSkill, getSkill, listSkills, newSkill, saveSkill } from '../storage/skills';

const SKILL_CONFIRM_HINT = '请先用 get_skill 确认原文';

/** 正文过短阈值：分步写入的中间态兜底。技能没有脚本那样的括号配平信号
 *  （正文是自然语言，无可校验语法），只能靠体量提醒模型「可能还没写完」。 */
export const MIN_CONTENT_CHARS = 50;

export interface SkillWriteResult {
  skill: Skill;
  warnings: string[];
}

export interface SkillGetResult {
  skill: Skill;
  /** 完整 .md（frontmatter + 正文），可直接整份复制改写后喂回 update_skill 的 patch.text */
  text: string;
  /** 正文字符数（不含 frontmatter），对应 storage 的 64KB 上限 */
  contentChars: number;
  /** 完整 .md 字符数（含 frontmatter），对应 create_skill 的 8192 字符闸 */
  totalChars: number;
}

/** Skill → 完整 .md。工具层算 totalChars 也用它。 */
export function toSkillMd(skill: Skill): string {
  return serializeSkillMd({
    name: skill.name, description: skill.description, command: skill.command, content: skill.content,
  });
}

function contentWarnings(content: string): string[] {
  return content.length < MIN_CONTENT_CHARS
    ? [`技能正文只有 ${content.length} 字符，可能还没写完——分步写入时请继续用 update_skill 的 patch.append 追加`]
    : [];
}

/** .md → 校验通过的字段。parseSkillMd 的 warning 原样透传；
 *  description 空升级为 error——简述是技能日后能被触发的唯一依据（spec §4 第 3 道闸）。 */
function parseOrThrow(md: string): { fields: SkillMdFields; warnings: string[] } {
  const r = parseSkillMd(md);
  if (!r.ok) throw new Error(r.error);
  if (!r.skill.description.trim()) {
    throw new Error(
      '技能缺少 description：简述是它日后能被触发的唯一依据，'
      + '请在 frontmatter 里写清「什么时候该用这个技能」，而不是「它是什么」',
    );
  }
  return { fields: r.skill, warnings: r.warnings };
}

export async function handleCreateSkill(input: {
  md: string; enabled?: boolean; source?: SkillSource;
}): Promise<SkillWriteResult> {
  if (typeof input?.md !== 'string' || !input.md.trim()) {
    throw new Error('md 必填：完整的技能 .md 文本（--- frontmatter --- + 正文）');
  }
  const { fields, warnings } = parseOrThrow(input.md);
  // command 撞车 → 报错并给出可操作的下一步。刻意不静默覆盖：导入路径是用户亲手选文件，
  // 这里是 agent 主动新增——无声抹掉用户技能不可接受（spec §4 第 4 道闸）。
  const owner = (await listSkills()).find((s) => s.command === fields.command);
  if (owner) {
    throw new Error(
      `command「${fields.command}」已被技能「${owner.name}」（id=${owner.id}）占用：`
      + '用 get_skill 看它的原文后 update_skill 改写，或换个 command 再建',
    );
  }
  const skill: Skill = { ...newSkill(fields, input.source), enabled: input.enabled ?? true };
  await saveSkill(skill);
  return { skill, warnings: [...warnings, ...contentWarnings(fields.content)] };
}

export async function handleGetSkill(id: string): Promise<SkillGetResult> {
  const skill = await getSkill(id);
  if (!skill) throw new Error(`技能不存在：${id}`);
  const text = toSkillMd(skill);
  return { skill, text, contentChars: skill.content.length, totalChars: text.length };
}

const TEXT_BRANCHES = ['text', 'append', 'replace'] as const;

/** 文本改动分支三支互斥（同传两支报错，不静默取优先——静默取舍会让模型误以为两处改动都生效）；
 *  enabled 独立，可单独传也可与文本分支并存。 */
export async function handleUpdateSkill(id: string, patch: SkillPatch): Promise<SkillWriteResult> {
  const existing = await getSkill(id);
  if (!existing) throw new Error(`技能不存在：${id}`);

  // != null 而非 !== undefined：挡掉模型 JSON 透传的 null 分支（如 { append: null }）
  const branches = TEXT_BRANCHES.filter((k) => patch[k] != null);
  if (branches.length > 1) {
    throw new Error(`patch 只能传一个文本改动分支，收到 ${branches.length} 个：${branches.join('、')}`);
  }
  // == null 而非 === undefined：与上面的分支过滤同一道理，挡掉模型 JSON 透传的 null enabled
  if (branches.length === 0 && patch.enabled == null) {
    throw new Error('patch 至少包含 text / append / replace / enabled 之一');
  }

  const warnings: string[] = [];
  let next: Skill;
  if (branches.length === 0) {
    // 仅启停：不重解析
    next = { ...existing, enabled: patch.enabled as boolean, updatedAt: Date.now() };
  } else {
    // 文本路径：算出新 .md 后整体重解析（文本为源，字段全部重建）
    const current = toSkillMd(existing);
    let md: string;
    switch (branches[0]) {
      case 'append':
        md = appendText(current, patch.append!);
        break;
      case 'replace':
        md = replaceText(
          current, patch.replace!.old, patch.replace!.new, patch.replace!.all ?? false, SKILL_CONFIRM_HINT,
        );
        break;
      case 'text':
        if (!patch.text!.trim()) {
          throw new Error('text 必填：完整的技能 .md 文本（--- frontmatter --- + 正文）');
        }
        md = patch.text!;
        break;
      default:
        // TEXT_BRANCHES 已穷举三支，走到这里说明类型层被绕过——无穷举保护
        throw new Error(`未处理的文本分支：${String(branches[0])}`);
    }
    const parsed = parseOrThrow(md);
    warnings.push(...parsed.warnings);
    next = {
      ...existing,
      name: parsed.fields.name,
      command: parsed.fields.command,
      description: parsed.fields.description,
      content: parsed.fields.content,
      enabled: patch.enabled ?? existing.enabled,
      updatedAt: Date.now(),
    };
    warnings.push(...contentWarnings(parsed.fields.content));
  }
  await saveSkill(next);
  return { skill: next, warnings };
}

/** 幂等：id 不存在也成功。builtin 拒删由 storage/skills.ts 的 deleteSkill 抛错兜底。 */
export async function handleDeleteSkill(id: string): Promise<void> {
  await deleteSkill(id);
}
