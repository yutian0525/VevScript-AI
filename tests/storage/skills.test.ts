// tests/storage/skills.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { storage } from 'wxt/utils/storage';
import {
  listSkills, getSkill, saveSkill, deleteSkill, setSkillEnabled, newSkill,
  MAX_SKILLS, MAX_CONTENT_LENGTH, MAX_DESCRIPTION_LENGTH, toSkillSummary,
} from '../../storage/skills';
import type { Skill } from '../../shared/types';

function mkSkill(over: Partial<Skill> = {}): Skill {
  return {
    id: 'sk1', name: '翻译', command: 'translate', description: '简述',
    content: '指令正文', enabled: true, createdAt: 1, updatedAt: 1, ...over,
  };
}

describe('storage/skills', () => {
  beforeEach(() => fakeBrowser.reset());

  it('空库返回 []', async () => {
    expect(await listSkills()).toEqual([]);
    expect(await getSkill('sk1')).toBeUndefined();
  });

  it('save 新增 + get 读回 + list 全量', async () => {
    await saveSkill(mkSkill());
    await saveSkill(mkSkill({ id: 'sk2', command: 'summarize' }));
    expect(await getSkill('sk1')).toMatchObject({ id: 'sk1', command: 'translate' });
    expect(await listSkills()).toHaveLength(2);
  });

  it('command 撞名（不同 id）→ throw', async () => {
    await saveSkill(mkSkill());
    await expect(saveSkill(mkSkill({ id: 'sk2' }))).rejects.toThrow('command');
  });

  it('更新路径改 command 撞他人 → throw，列表不变', async () => {
    await saveSkill(mkSkill({ id: 'sk1', command: 'a' }));
    await saveSkill(mkSkill({ id: 'sk2', command: 'b' }));
    await expect(saveSkill(mkSkill({ id: 'sk1', command: 'b' }))).rejects.toThrow('command');
    const all = await listSkills();
    expect(all).toHaveLength(2);
    expect(all.map((s) => s.command).sort()).toEqual(['a', 'b']);
  });

  it('save 同 id 覆盖（upsert）不触发 command 撞名校验', async () => {
    await saveSkill(mkSkill());
    await saveSkill(mkSkill({ name: '改名' }));
    const all = await listSkills();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ name: '改名' });
  });

  it('command 格式非法 → throw', async () => {
    await expect(saveSkill(mkSkill({ command: 'Bad_Name' }))).rejects.toThrow('command');
  });

  it('落到 local:skills:index 键', async () => {
    await saveSkill(mkSkill());
    const raw = await storage.getItem<Skill[]>('local:skills:index');
    expect(raw).toHaveLength(1);
  });

  it('数量上限：超过 MAX_SKILLS 抛错', async () => {
    for (let i = 0; i < MAX_SKILLS; i++) await saveSkill(mkSkill({ id: `k${i}`, command: `c-${i}` }));
    await expect(saveSkill(mkSkill({ id: 'extra', command: 'extra' }))).rejects.toThrow('上限');
  });

  it('满员时更新既有技能仍成功', async () => {
    for (let i = 0; i < MAX_SKILLS; i++) await saveSkill(mkSkill({ id: `k${i}`, command: `c-${i}` }));
    await saveSkill(mkSkill({ id: 'k0', name: '改名' }));
    expect(await listSkills()).toHaveLength(MAX_SKILLS);
    expect((await getSkill('k0'))!.name).toBe('改名');
  });

  it('content 超长抛错', async () => {
    await expect(saveSkill(mkSkill({ content: 'x'.repeat(MAX_CONTENT_LENGTH + 1) }))).rejects.toThrow('上限');
  });

  it('description 超长抛错', async () => {
    await expect(saveSkill(mkSkill({ description: 'x'.repeat(MAX_DESCRIPTION_LENGTH + 1) }))).rejects.toThrow('上限');
  });

  it('delete 幂等（不存在也成功）', async () => {
    await saveSkill(mkSkill());
    await deleteSkill('sk1');
    await deleteSkill('sk1');
    expect(await listSkills()).toEqual([]);
  });

  it('builtin 技能拒删（普通技能不受影响）', async () => {
    await saveSkill(mkSkill({ builtin: true }));
    await expect(deleteSkill('sk1')).rejects.toThrow('不可删除');
    expect(await listSkills()).toHaveLength(1);
    await saveSkill(mkSkill({ id: 'sk2', command: 'plain' }));
    await deleteSkill('sk2');
    expect(await listSkills()).toHaveLength(1);
  });

  it('setSkillEnabled 翻转', async () => {
    await saveSkill(mkSkill());
    await setSkillEnabled('sk1', false);
    expect((await getSkill('sk1'))!.enabled).toBe(false);
    await setSkillEnabled('sk1', true);
    expect((await getSkill('sk1'))!.enabled).toBe(true);
  });

  it('toSkillSummary 裁掉 content', () => {
    const s = toSkillSummary(mkSkill());
    expect(s).not.toHaveProperty('content');
    expect(s).toMatchObject({
      id: 'sk1', name: '翻译', command: 'translate',
      description: '简述', enabled: true, updatedAt: 1,
    });
  });

  it('toSkillSummary 透传 builtin 标记', () => {
    expect(toSkillSummary(mkSkill({ builtin: true })).builtin).toBe(true);
    expect(toSkillSummary(mkSkill()).builtin).toBeUndefined();
  });

  it('newSkill 工厂：默认 enabled + 时间戳 + 随机 id', () => {
    const s = newSkill({ name: 'N', command: 'c', description: 'd', content: 'C' });
    expect(s.enabled).toBe(true);
    expect(s.createdAt).toBeGreaterThan(0);
    expect(s.updatedAt).toBe(s.createdAt);
    expect(s.id).toBeTruthy();
  });
});
