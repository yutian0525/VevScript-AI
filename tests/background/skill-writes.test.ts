// tests/background/skill-writes.test.ts
// 技能写编排层（spec §5）：.md 全文为源 → parseSkillMd → 落库；读出 serializeSkillMd 还原。
import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  handleCreateSkill, handleGetSkill, handleUpdateSkill, handleDeleteSkill,
} from '../../background/skill-writes';
import { listSkills } from '../../storage/skills';

// parseSkillMd 会 trim 正文首尾空白，round-trip 精确等价（text toBe md）要求 body 首尾无空白，
// 故 repeat 后去掉尾换行——去掉的只是「不落库的装饰性换行」，步进间换行仍保留。
const BODY = '## 第 1 步\n\n打开页面，做点什么。\n'.repeat(3).trimEnd();
const mkMd = (name: string, command: string, desc: string, body = BODY): string =>
  `---\nname: ${name}\ndescription: ${desc}\ncommand: ${command}\n---\n${body}`;

describe('background/skill-writes', () => {
  beforeEach(() => fakeBrowser.reset());

  it('create → get round-trip：读回的 .md 与输入等价，正文末尾就是全文末尾', async () => {
    const md = mkMd('日报', 'daily-report', '每天整理报表时触发');
    const { skill } = await handleCreateSkill({ md, source: 'agent' });
    expect(skill.source).toBe('agent');
    expect(skill.builtin).toBeUndefined();

    const got = await handleGetSkill(skill.id);
    expect(got.text).toBe(md);
    expect(got.contentChars).toBe(BODY.length);
    expect(got.totalChars).toBe(md.length);
    // append 语义成立的前提：正文末尾 == 全文末尾（frontmatter 在开头）
    expect(got.text.endsWith(BODY)).toBe(true);
  });

  it('append 后 frontmatter 仍在开头、正文续在末尾', async () => {
    const { skill } = await handleCreateSkill({ md: mkMd('日报', 'daily-report', '每天整理报表时触发') });
    await handleUpdateSkill(skill.id, { append: '## 第 2 步\n\n再检查一遍。' });
    const got = await handleGetSkill(skill.id);
    expect(got.text.startsWith('---\nname: 日报\n')).toBe(true);
    expect(got.text.endsWith('再检查一遍。')).toBe(true);
    // 正文只从 text 出：skill 上不再挂一份 content（同一份正文发两遍 = 白烧上下文）
    expect('content' in got.skill).toBe(false);
    expect(got.skill.command).toBe('daily-report');
  });

  it('replace 能改 frontmatter 字段（改 description 生效）', async () => {
    const { skill } = await handleCreateSkill({ md: mkMd('日报', 'daily-report', '旧的简述') });
    const r = await handleUpdateSkill(skill.id, {
      replace: { old: 'description: 旧的简述', new: 'description: 新的简述' },
    });
    expect(r.skill.description).toBe('新的简述');
  });

  it('description 为空 → 拒绝（简述是日后触发的唯一依据）', async () => {
    await expect(handleCreateSkill({ md: mkMd('日报', 'daily-report', '') }))
      .rejects.toThrow('description');
  });

  it('command 撞车 → 报错并给出可操作的下一步，不覆盖原技能', async () => {
    await handleCreateSkill({ md: mkMd('日报', 'daily-report', 'd1') });
    const first = (await listSkills())[0]!;
    await expect(handleCreateSkill({ md: mkMd('周报', 'daily-report', 'd2') }))
      .rejects.toThrow(/已被技能「日报」[\s\S]*update_skill/);
    const after = (await listSkills())[0]!;
    expect(after.name).toBe('日报');
    expect(after.id).toBe(first.id);
  });

  it('三个文本分支互斥；enabled 可与文本分支并存；至少传一项', async () => {
    const { skill } = await handleCreateSkill({ md: mkMd('日报', 'daily-report', 'd') });
    await expect(handleUpdateSkill(skill.id, { append: 'x', enabled: true })).resolves.toBeTruthy();
    await expect(handleUpdateSkill(skill.id, { append: 'x', text: 'y' })).rejects.toThrow('只能传一个');
    await expect(handleUpdateSkill(skill.id, {})).rejects.toThrow('至少包含');
  });

  it('patch.text 非字符串 → 中文可操作文案，不抛裸 TypeError', async () => {
    const { skill } = await handleCreateSkill({ md: mkMd('日报', 'daily-report', 'd') });
    await expect(handleUpdateSkill(skill.id, { text: 123 as never }))
      .rejects.toThrow(/patch.text 必须是字符串/);
  });

  it('patch.enabled 非布尔 → 拒绝且不落库（字符串 "false" 是真值，落库会让技能实际仍启用）', async () => {
    const { skill } = await handleCreateSkill({ md: mkMd('日报', 'daily-report', 'd') });
    await expect(handleUpdateSkill(skill.id, { enabled: 'false' as never }))
      .rejects.toThrow(/patch.enabled 必须是布尔值/);
    // 文本分支同传非布尔：读写两侧走同一道守卫
    await expect(handleUpdateSkill(skill.id, { append: 'x', enabled: 0 as never }))
      .rejects.toThrow(/patch.enabled 必须是布尔值/);
    const after = (await listSkills())[0]!;
    expect(after.enabled).toBe(true);
    expect(after.content).not.toContain('x');
  });

  it('replace 未命中 → 文案指向 get_skill', async () => {
    const { skill } = await handleCreateSkill({ md: mkMd('日报', 'daily-report', 'd') });
    await expect(handleUpdateSkill(skill.id, { replace: { old: '不存在的片段', new: 'x' } }))
      .rejects.toThrow(/get_skill 确认原文/);
  });

  it('正文过短 → warning 兜底（技能没有配平信号，只能靠体量提醒）', async () => {
    const r = await handleCreateSkill({ md: mkMd('日报', 'daily-report', 'd', '短') });
    expect(r.warnings.some((w) => w.includes('可能还没写完'))).toBe(true);
  });

  it('delete 幂等；builtin 拒删由 storage 层兜底', async () => {
    const { skill } = await handleCreateSkill({ md: mkMd('日报', 'daily-report', 'd') });
    await handleDeleteSkill(skill.id);
    expect(await listSkills()).toHaveLength(0);
    await expect(handleDeleteSkill(skill.id)).resolves.toBeUndefined();
  });

  // ---- Review Focus ----

  it('RF1 正文含 --- 水平线：create → get 原样往返（单文档路径不拆分）', async () => {
    const body = '## 第 1 步\n\n甲。\n\n---\n\n## 第 2 步\n\n乙。';
    const md = mkMd('日报', 'daily-report', 'd', body);
    const { skill } = await handleCreateSkill({ md });
    expect((await handleGetSkill(skill.id)).text).toBe(md);
  });

  it('RF2 frontmatter 值含换行：只取第一行，后续行不被误当成键，结构完好', async () => {
    const md = '---\nname: 日报\ndescription: 第一行\n第二行\ncommand: daily-report\n---\n正文占位够长正文占位够长正文占位够长正文占位够长。';
    const { skill } = await handleCreateSkill({ md });
    expect(skill.description).toBe('第一行');
    expect(skill.command).toBe('daily-report'); // 「第二行」没被吃掉 command
    expect((await handleGetSkill(skill.id)).text.split('\n')[1]).toBe('name: 日报');
  });

  it('RF3 正文无尾换行时 append 补一个，不粘连上一段', async () => {
    const md = '---\nname: 日报\ndescription: d\ncommand: daily-report\n---\n没有尾换行的正文';
    const { skill } = await handleCreateSkill({ md });
    await handleUpdateSkill(skill.id, { append: '追加段。' });
    expect((await handleGetSkill(skill.id)).text.endsWith('没有尾换行的正文\n追加段。')).toBe(true);
  });

  it('RF-边界 frontmatter 无任何键 → 报错（name/command 都派生不出来）', async () => {
    await expect(handleCreateSkill({ md: '---\n---\n正文占位够长正文占位够长正文占位够长正文占位够长。' }))
      .rejects.toThrow(/command/);
  });

  it('RF5 分步 append 可突破 create 的 8192 闸，但总量受 storage 的 64KB 上限兜底', async () => {
    const { skill } = await handleCreateSkill({ md: mkMd('日报', 'daily-report', 'd') });
    const chunk = 'x'.repeat(20000);
    // 8192 闸只管 create 的 source（模型单次输出），append 不受限——分步写入本就要靠它
    await handleUpdateSkill(skill.id, { append: chunk });
    await handleUpdateSkill(skill.id, { append: chunk });
    await handleUpdateSkill(skill.id, { append: chunk });
    await expect(handleUpdateSkill(skill.id, { append: chunk })).rejects.toThrow('上限');
  });

  it('text 分支：整文替换（frontmatter 与正文一起换），整体重解析', async () => {
    const { skill } = await handleCreateSkill({ md: mkMd('日报', 'daily-report', '旧简述') });
    const next = mkMd('周报', 'weekly', '新简述', '## 全新正文\n\n换了一整份。\n'.repeat(3).trimEnd());
    const r = await handleUpdateSkill(skill.id, { text: next });
    expect(r.skill.command).toBe('weekly');
    expect(r.skill.name).toBe('周报');
    expect(r.skill.description).toBe('新简述');
    expect((await handleGetSkill(skill.id)).text).toBe(next);
  });
});
