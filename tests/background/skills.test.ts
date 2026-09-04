// tests/background/skills.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { MessageRouter } from '../../background/router';
import { initSkillsModule } from '../../background/skills';
import { listSkills } from '../../storage/skills';

function dispatch(type: string, extra: Record<string, unknown> = {}): Promise<any> {
  const router = new MessageRouter();
  initSkillsModule(router);
  return router.dispatch({ type, ...extra } as { type: string } & Record<string, unknown>);
}

describe('background/skills handlers', () => {
  beforeEach(() => fakeBrowser.reset());

  it('SKILLS_LIST 空库', async () => {
    const resp = await dispatch('SKILLS_LIST');
    expect(resp).toEqual({ ok: true, data: { skills: [] } });
  });

  it('SKILLS_IMPORT 单文档 → imported 1', async () => {
    const md = '---\nname: A\ndescription: d\ncommand: a\n---\nCA';
    const resp = await dispatch('SKILLS_IMPORT', { text: md, filename: 'a.md' });
    expect(resp.ok).toBe(true);
    expect(resp.data).toMatchObject({ imported: 1, overwritten: 0 });
    expect(resp.data.warnings).toEqual([]);
    expect(await listSkills()).toHaveLength(1);
  });

  it('SKILLS_IMPORT 同 command 再导入 → overwritten 1，保留原 enabled/id', async () => {
    const md = '---\nname: A\ndescription: d\ncommand: a\n---\nCA';
    await dispatch('SKILLS_IMPORT', { text: md });
    await dispatch('SKILLS_SET_ENABLED', { id: (await listSkills())[0]!.id, enabled: false });
    const md2 = '---\nname: A2\ndescription: d2\ncommand: a\n---\nCA2';
    const resp = await dispatch('SKILLS_IMPORT', { text: md2 });
    expect(resp.data).toMatchObject({ imported: 0, overwritten: 1 });
    const all = await listSkills();
    expect(all).toHaveLength(1);
    expect(all[0]!.name).toBe('A2');
    expect(all[0]!.enabled).toBe(false);
  });

  it('SKILLS_IMPORT 多文档串联 → 好文档照常、坏文档跳过 + warning', async () => {
    const md = [
      '---\nname: A\ndescription: d\ncommand: a\n---\nCA',
      '---\nname: B\ndescription: d\ncommand: b\n---\nCB',
      '没有 frontmatter 的坏文档',
    ].join('\n---\n\n');
    const resp = await dispatch('SKILLS_IMPORT', { text: md });
    expect(resp.data.imported).toBe(2);
    expect(resp.data.warnings.length).toBeGreaterThanOrEqual(1);
    expect(await listSkills()).toHaveLength(2);
  });

  it('导入正文超限 → 跳过 + warning，其余照常', async () => {
    const md = [
      '---\nname: A\ndescription: d\ncommand: a\n---\n' + 'x'.repeat(64 * 1024 + 1),
      '---\nname: B\ndescription: d\ncommand: b\n---\nCB',
    ].join('\n---\n\n');
    const resp = await dispatch('SKILLS_IMPORT', { text: md });
    expect(resp.data.imported).toBe(1);
    expect(resp.data.warnings.length).toBeGreaterThanOrEqual(1);
  });

  it('SKILLS_GET 不存在 → ok:false', async () => {
    const resp = await dispatch('SKILLS_GET', { id: 'nope' });
    expect(resp.ok).toBe(false);
  });

  it('SKILLS_GET 存在 → 返回完整 Skill（含 content）', async () => {
    await dispatch('SKILLS_IMPORT', { text: '---\nname: A\ndescription: d\ncommand: a\n---\nC' });
    const id = (await listSkills())[0]!.id;
    const resp = await dispatch('SKILLS_GET', { id });
    expect(resp.ok).toBe(true);
    expect(resp.data.skill.content).toBe('C');
  });

  it('SKILLS_SET_ENABLED + SKILLS_DELETE', async () => {
    await dispatch('SKILLS_IMPORT', { text: '---\nname: A\ndescription: d\ncommand: a\n---\nC' });
    const id = (await listSkills())[0]!.id;
    await dispatch('SKILLS_SET_ENABLED', { id, enabled: false });
    expect((await listSkills())[0]!.enabled).toBe(false);
    await dispatch('SKILLS_DELETE', { id });
    expect(await listSkills()).toHaveLength(0);
  });

  it('SKILLS_EXPORT 缺省导全部，ids 过滤', async () => {
    await dispatch('SKILLS_IMPORT', { text: '---\nname: A\ndescription: d\ncommand: a\n---\nCA' });
    await dispatch('SKILLS_IMPORT', { text: '---\nname: B\ndescription: d\ncommand: b\n---\nCB' });
    const all = await dispatch('SKILLS_EXPORT');
    expect(all.data.count).toBe(2);
    expect(all.data.text).toContain('command: a');
    expect(all.data.text).toContain('command: b');
    const one = await dispatch('SKILLS_EXPORT', { ids: [(await listSkills())[0]!.id] });
    expect(one.data.count).toBe(1);
  });

  it('多文档含解析失败文档 → 该条 warning 带文档序号前缀', async () => {
    const md = [
      '---\nname: A\ndescription: d\ncommand: a\n---\nCA',
      '---\nname: B\ndescription: d\n---\nCB', // 缺 command → 解析失败
    ].join('\n---\n\n');
    const resp = await dispatch('SKILLS_IMPORT', { text: md });
    expect(resp.data.imported).toBe(1);
    expect(resp.data.warnings.length).toBeGreaterThanOrEqual(1);
    expect(resp.data.warnings.some((w: string) => w.startsWith('文档2：'))).toBe(true);
  });

  it('带 filename 导入 → warning 前缀含 filename', async () => {
    const md = [
      '---\nname: A\ndescription: d\ncommand: a\n---\nCA',
      '没有 frontmatter 的坏文档',
    ].join('\n---\n\n');
    const resp = await dispatch('SKILLS_IMPORT', { text: md, filename: 'a.md' });
    expect(resp.data.imported).toBe(1);
    expect(resp.data.warnings.length).toBeGreaterThanOrEqual(1);
    expect(resp.data.warnings.some((w: string) => w.includes('a.md'))).toBe(true);
  });
});
