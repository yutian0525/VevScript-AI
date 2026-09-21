// tests/background/builtin-skills.test.ts
// 内置技能投放（seedBuiltinSkills）：资源缺失/全坏文档报错、空池新增、
// 已有同 command 覆盖保留 id/enabled、升级后打 builtin 标记。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { seedBuiltinSkills } from '../../background/builtin-skills';
import { listSkills, deleteSkill } from '../../storage/skills';
import { parseSkillMdDocument } from '../../shared/skill-md';

// 打包资源（构建时 public/skills/builtin.md 原样拷贝）——用真实文件保证内容与解析器同步
import builtinMd from '../../public/skills/builtin.md?raw';

const CMD_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

function mockGetURL(path: string): string {
  return `chrome-extension://test/${path}`;
}

/** 把 md 文本塞进 fake fetch（seedBuiltinSkills 内部 fetch chrome.runtime.getURL(...)） */
function stubFetchWith(text: string): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(text, { status: 200 })));
}

describe('public/skills/builtin.md 内容契约', () => {
  it('恰好四个文档，command 合法且唯一', () => {
    const docs = parseSkillMdDocument(builtinMd);
    const okDocs = docs.filter((d) => d.ok);
    expect(okDocs).toHaveLength(4);
    const commands = okDocs.map((d) => (d.ok ? d.skill.command : ''));
    expect(commands.sort()).toEqual(['find-scripts', 'help', 'write-script', 'write-skill']);
    commands.forEach((c) => expect(c).toMatch(CMD_RE));
  });

  it('每条 name/description/content 非空且长度合规', () => {
    const docs = parseSkillMdDocument(builtinMd).filter((d) => d.ok);
    for (const d of docs) {
      if (!d.ok) continue;
      expect(d.skill.name.length).toBeGreaterThan(0);
      expect(d.skill.description.length).toBeGreaterThan(0);
      expect(d.skill.description.length).toBeLessThanOrEqual(300);
      expect(d.skill.content.length).toBeGreaterThan(100);
      expect(d.skill.content.length).toBeLessThanOrEqual(64 * 1024);
    }
  });
});

describe('seedBuiltinSkills', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.unstubAllGlobals();
    vi.stubGlobal('chrome', { runtime: { getURL: mockGetURL } });
  });

  it('资源读取失败（HTTP 非 200）→ throw', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
    await expect(seedBuiltinSkills()).rejects.toThrow('读取失败');
  });

  it('资源全为坏文档 → throw', async () => {
    stubFetchWith('没有 frontmatter 的内容');
    await expect(seedBuiltinSkills()).rejects.toThrow('解析失败');
  });

  it('空池投放：四条全部写入并带 builtin 标记', async () => {
    stubFetchWith(builtinMd);
    const n = await seedBuiltinSkills();
    expect(n).toBe(4);
    const all = await listSkills();
    expect(all).toHaveLength(4);
    expect(all.map((s) => s.builtin)).toEqual([true, true, true, true]);
  });

  it('已有同 command（用户导入过）：覆盖内容但保留 id/enabled，并打 builtin', async () => {
    // 用户先前从 .md 导入过同 command 技能并停用
    const oldMd = '---\nname: 帮助（旧版）\ndescription: 旧的简述\ncommand: help\n---\n旧的正文';
    const { importSkillsText } = await import('../../background/skills');
    await importSkillsText(oldMd);
    const before = (await listSkills()).find((s) => s.command === 'help')!;
    expect(before).toBeDefined();
    expect(before.builtin ?? false).toBe(false);
    // 模拟用户已停用
    const { saveSkill } = await import('../../storage/skills');
    await saveSkill({ ...before, enabled: false });

    stubFetchWith(builtinMd);
    const n = await seedBuiltinSkills();
    expect(n).toBe(4);
    const all = await listSkills();
    expect(all).toHaveLength(4);
    const help = all.find((s) => s.command === 'help')!;
    expect(help.id).toBe(before.id);
    expect(help.enabled).toBe(false);
    expect(help.builtin).toBe(true);
  });

  it('用户导入过旧版内置（已 builtin）：升级覆盖为新内容', async () => {
    stubFetchWith(builtinMd);
    await seedBuiltinSkills();
    // 模拟下一版扩展带来新正文
    const newer = builtinMd.replace('帮助：介绍本扩展的能力', '帮助：介绍本扩展的能力（v2）');
    stubFetchWith(newer);
    await seedBuiltinSkills();
    const help = (await listSkills()).find((s) => s.command === 'help')!;
    expect(help.content).toContain('v2');
    expect((await listSkills()).length).toBe(4);
  });

  it('投放后的 builtin 技能不可删除', async () => {
    stubFetchWith(builtinMd);
    await seedBuiltinSkills();
    const help = (await listSkills()).find((s) => s.command === 'help')!;
    await expect(deleteSkill(help.id)).rejects.toThrow('不可删除');
  });
});
