// background/skills.ts
// 技能池编排层（spec §2.1）：6 个 SKILLS_* handler，内部调 storage/skills.ts + shared/skill-md.ts。
// skill 是纯存储实体：无注入引擎、无 tabs 监听、无 Port 事件。
import type { MessageRouter } from './router';
import {
  listSkills, getSkill, saveSkill, deleteSkill, setSkillEnabled, toSkillSummary, newSkill,
} from '../storage/skills';
import { parseSkillMdDocument, serializeSkillsMd } from '../shared/skill-md';

/** 单次导入的聚合结果 */
export interface SkillsImportResult {
  imported: number;
  overwritten: number;
  warnings: string[];
}

/** 导入一份 .md 文本（可能含多文档）。逐文档解析：坏文档跳过 + warning；
 *  command 撞车 → 覆盖更新（保留原 id/enabled/createdAt）；超限等 saveSkill 抛错 → 跳过该条 + warning。
 *  所有 warning 统一带「[filename ]文档N：」归属前缀——面板逐文件导入聚合后仍可定位来源。 */
export async function importSkillsText(text: string, filename?: string): Promise<SkillsImportResult> {
  const docs = parseSkillMdDocument(text, filename);
  const warnings: string[] = [];
  const tag = (i: number) => `${filename ? `${filename} ` : ''}文档${i + 1}`;
  let imported = 0;
  let overwritten = 0;
  for (let i = 0; i < docs.length; i += 1) {
    const r = docs[i]!;
    if (!r.ok) {
      warnings.push(`${tag(i)}：${r.error}`);
      continue;
    }
    for (const w of r.warnings) warnings.push(`${tag(i)}：${w}`);
    try {
      const existing = (await listSkills()).find((s) => s.command === r.skill.command);
      if (existing) {
        await saveSkill({
          ...existing,
          name: r.skill.name,
          description: r.skill.description,
          content: r.skill.content,
          updatedAt: Date.now(),
        });
        overwritten += 1;
        warnings.push(`${tag(i)}：「${r.skill.name}」已存在同 command「${r.skill.command}」，已覆盖更新`);
      } else {
        await saveSkill(newSkill(r.skill));
        imported += 1;
      }
    } catch (e) {
      warnings.push(`${tag(i)}：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { imported, overwritten, warnings };
}

/** SKILLS_EXPORT 数据函数：返回序列化好的 .md 文本 + 条数（面板拿去 Blob 下载）。
 *  ids 缺省 = 全部（按 storage 顺序）。 */
export async function exportSkillsMd(ids?: string[]): Promise<{ text: string; count: number }> {
  const all = await listSkills();
  const picked = ids ? all.filter((s) => ids.includes(s.id)) : all;
  const text = serializeSkillsMd(picked.map((s) => ({
    name: s.name, description: s.description, command: s.command, content: s.content,
  })));
  return { text, count: picked.length };
}

/** handler 注册（entrypoints/background.ts 调用）。 */
export function initSkillsModule(router: MessageRouter): void {
  router.on('SKILLS_LIST', async () => ({
    ok: true,
    data: { skills: (await listSkills()).map(toSkillSummary) },
  }));

  router.on('SKILLS_GET', async (msg) => {
    const { id } = msg as unknown as { id: string };
    const skill = await getSkill(id);
    if (!skill) return { ok: false, error: '技能不存在' };
    return { ok: true, data: { skill } };
  });

  router.on('SKILLS_DELETE', async (msg) => {
    const { id } = msg as unknown as { id: string };
    await deleteSkill(id);
    return { ok: true };
  });

  router.on('SKILLS_SET_ENABLED', async (msg) => {
    const { id, enabled } = msg as unknown as { id: string; enabled: boolean };
    await setSkillEnabled(id, enabled);
    return { ok: true };
  });

  router.on('SKILLS_IMPORT', async (msg) => {
    const { text, filename } = msg as unknown as { text: string; filename?: string };
    return { ok: true, data: await importSkillsText(text, filename) };
  });

  router.on('SKILLS_EXPORT', async (msg) => {
    const { ids } = (msg ?? {}) as { ids?: string[] };
    return { ok: true, data: await exportSkillsMd(ids) };
  });
}
