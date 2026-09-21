// tests/agent/tools/skill-pool.test.ts
// 技能池五工具执行器（spec §4）：长度闸在工具层，其余闸在 background/skill-writes 编排层。
import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  doListSkills, doGetSkill, doCreateSkill, doUpdateSkill, doDeleteSkill,
} from '../../../agent/tools/skill-pool';
import { listSkills, newSkill, saveSkill } from '../../../storage/skills';

const BODY = '## 第 1 步\n\n打开页面，做点什么。\n'.repeat(3);
// parseSkillMd 会规整正文（去首尾空白），storage 里存的正文没有尾随换行——断言以规整后为准
const CONTENT = BODY.trimEnd();
const mkMd = (name: string, command: string, desc: string, body = BODY): string =>
  `---\nname: ${name}\ndescription: ${desc}\ncommand: ${command}\n---\n${body}`;

/** 从 ok 结果里取 data（测试里少写点 as） */
const data = (r: { ok: boolean; data?: unknown }): Record<string, unknown> =>
  (r.data ?? {}) as Record<string, unknown>;

describe('skill-pool 工具执行器', () => {
  beforeEach(() => fakeBrowser.reset());

  it('create_skill：创建并强制 agent 来源，返回精简形状（不回灌正文）', async () => {
    const r = await doCreateSkill({ source: mkMd('日报', 'daily-report', '每天整理报表时触发') });
    expect(r.ok).toBe(true);
    expect(data(r)).toMatchObject({
      name: '日报', command: 'daily-report', source: 'agent', builtin: false, enabled: true,
    });
    expect(data(r).text).toBeUndefined();
    expect(data(r).contentChars).toBe(CONTENT.length);
    expect((await listSkills())[0]!.source).toBe('agent');
  });

  it('create_skill：长度超限被拒，文案教分步', async () => {
    const r = await doCreateSkill({ source: mkMd('长', 'huge', 'd', 'x'.repeat(9000)) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/过长[\s\S]*分步/);
    expect(await listSkills()).toHaveLength(0);
  });

  it('create_skill：缺 source / 无 frontmatter / description 空 各自报错', async () => {
    expect((await doCreateSkill({})).ok).toBe(false);
    const noFm = await doCreateSkill({ source: '没有 frontmatter 的正文' });
    expect(noFm.ok).toBe(false);
    if (!noFm.ok) expect(noFm.error).toContain('frontmatter');
    expect((await doCreateSkill({ source: mkMd('日报', 'daily-report', '') })).ok).toBe(false);
  });

  it('create_skill：command 撞车报错且不覆盖原技能', async () => {
    await doCreateSkill({ source: mkMd('日报', 'daily-report', 'd1') });
    const r = await doCreateSkill({ source: mkMd('周报', 'daily-report', 'd2') });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/update_skill/);
    expect((await listSkills())[0]!.name).toBe('日报');
  });

  it('list_skills：摘要含 contentChars，enabled 可过滤', async () => {
    await doCreateSkill({ source: mkMd('日报', 'daily-report', 'd1') });
    await doCreateSkill({ source: mkMd('周报', 'weekly', 'd2') });
    const weekly = (await listSkills()).find((s) => s.command === 'weekly')!;
    await saveSkill({ ...weekly, enabled: false });

    const all = await doListSkills({});
    const list = data(all).skills as { command: string; contentChars: number }[];
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ command: 'daily-report', contentChars: CONTENT.length });

    expect((data(await doListSkills({ enabled: true })).skills as unknown[])).toHaveLength(1);
    expect((data(await doListSkills({ enabled: false })).skills as unknown[])).toHaveLength(1);
  });

  it('list_skills：enabled 传 null（模型 JSON 透传）不过滤，不静默返回空列表', async () => {
    await doCreateSkill({ source: mkMd('日报', 'daily-report', 'd1') });
    const r = await doListSkills({ enabled: null as never });
    expect(r.ok).toBe(true);
    expect(data(r).skills as unknown[]).toHaveLength(1);
  });

  it('get_skill：返回完整 .md 全文与两个字符数口径', async () => {
    const md = mkMd('日报', 'daily-report', 'd1');
    const created = await doCreateSkill({ source: md });
    const id = data(created).id as string;
    const r = await doGetSkill({ id });
    expect(r.ok).toBe(true);
    // text 是规整后正文还原的 .md（尾随换行被 parseSkillMd 吃掉），与入参 md 差一个换行
    const text = md.trimEnd();
    expect(data(r)).toMatchObject({
      text, contentChars: CONTENT.length, totalChars: text.length,
    });
    expect((data(r).skill as { command: string }).command).toBe('daily-report');
  });

  it('get_skill：id 不存在报错', async () => {
    const r = await doGetSkill({ id: 'nope' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('不存在');
  });

  it('update_skill：append 续写正文、replace 精确改、enabled 启停', async () => {
    const id = data(await doCreateSkill({ source: mkMd('日报', 'daily-report', 'd1') })).id as string;

    expect((await doUpdateSkill({ id, patch: { append: '## 第 9 步\n\n收尾。' } })).ok).toBe(true);
    expect(data(await doGetSkill({ id })).text as string).toContain('收尾。');

    expect((await doUpdateSkill({ id, patch: { replace: { old: 'description: d1', new: 'description: d1改' } } })).ok).toBe(true);
    expect((await listSkills())[0]!.description).toBe('d1改');

    expect((await doUpdateSkill({ id, patch: { enabled: false } })).ok).toBe(true);
    expect((await listSkills())[0]!.enabled).toBe(false);
  });

  it('update_skill：三支文本分支互斥', async () => {
    const id = data(await doCreateSkill({ source: mkMd('日报', 'daily-report', 'd1') })).id as string;
    const r = await doUpdateSkill({ id, patch: { append: 'x', text: 'y' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('只能传一个');
  });

  it('update_skill：缺 patch / patch 非对象 → 中文可操作文案，不抛裸英文 TypeError', async () => {
    const id = data(await doCreateSkill({ source: mkMd('日报', 'daily-report', 'd1') })).id as string;
    const missing = await doUpdateSkill({ id } as never);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toMatch(/需要 patch[\s\S]*append/);
    const wrongType = await doUpdateSkill({ id, patch: 'x' as never });
    expect(wrongType.ok).toBe(false);
    if (!wrongType.ok) expect(wrongType.error).toMatch(/需要 patch/);
  });

  it('delete_skill：只删 AI 自建的技能——用户手写/导入的拒删，且拒绝后技能仍在库里', async () => {
    // source 缺省（newSkill 不传 source 即不打标）= 用户导入
    await saveSkill(newSkill({ name: '手写流程', command: 'hand-made', description: 'd', content: BODY }));
    const handId = (await listSkills())[0]!.id;
    const r = await doDeleteSkill({ id: handId });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/技能页/);
    expect(await listSkills()).toHaveLength(1);
    // 显式 source: 'user' 同理
    await saveSkill({ ...newSkill({ name: '自建', command: 'mine', description: 'd', content: BODY }), source: 'user' });
    const userId = (await listSkills()).find((s) => s.command === 'mine')!.id;
    expect((await doDeleteSkill({ id: userId })).ok).toBe(false);
    expect(await listSkills()).toHaveLength(2);
  });

  it('delete_skill：删除自建技能；builtin 拒删（storage 层兜底）', async () => {
    const id = data(await doCreateSkill({ source: mkMd('日报', 'daily-report', 'd1') })).id as string;
    expect((await doDeleteSkill({ id })).ok).toBe(true);
    expect(await listSkills()).toHaveLength(0);

    await saveSkill({
      ...newSkill({ name: '帮助', command: 'help', description: 'd', content: BODY }),
      builtin: true,
    });
    const builtinId = (await listSkills())[0]!.id;
    const r = await doDeleteSkill({ id: builtinId });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('不可删除');
  });
});
