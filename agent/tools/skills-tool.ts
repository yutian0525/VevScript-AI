// agent/tools/skills-tool.ts
// load_skill 工具（spec §2.4 修订 2026-09-05）：AI 主动按 command 拉取技能完整正文并遵循执行。
// 技能正文进上下文的唯一路径——斜杠触发不再注入正文，改由模型看到简述后自行调用本工具。
import type { ToolResult } from '../../shared/types';
import { listSkills } from '../../storage/skills';

export interface LoadSkillData {
  name: string;
  command: string;
  content: string;
}

/** 按 command 查启用技能，命中返回正文；未命中/停用/storage 故障返回可读错误。 */
export async function doLoadSkill(command: string): Promise<ToolResult<LoadSkillData>> {
  const cmd = (command ?? '').trim();
  if (!cmd) return { ok: false, error: 'load_skill 缺少 command 参数' };
  const all = await listSkills().catch(() => []);
  const hit = all.find((s) => s.command === cmd && s.enabled);
  if (!hit) {
    const disabled = all.find((s) => s.command === cmd);
    if (disabled) return { ok: false, error: `技能「${disabled.name}」（/${cmd}）已被停用，无法加载` };
    return { ok: false, error: `没有 command 为「${cmd}」的启用技能` };
  }
  return { ok: true, data: { name: hit.name, command: hit.command, content: hit.content } };
}
