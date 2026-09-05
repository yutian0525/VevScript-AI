// tests/agent/tools/skills-tool.test.ts
// load_skill 工具（spec §2.4 修订 2026-09-05）：按 command 拉取启用技能正文。
import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { doLoadSkill } from '../../../agent/tools/skills-tool';
import { saveSkill } from '../../../storage/skills';

describe('doLoadSkill', () => {
  beforeEach(() => fakeBrowser.reset());

  it('命中启用技能 → 返回 name/command/content', async () => {
    await saveSkill({
      id: 'k1', name: '翻译', command: 'translate', description: 'd',
      content: '技能正文', enabled: true, createdAt: 1, updatedAt: 1,
    });
    const r = await doLoadSkill('translate');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data).toEqual({ name: '翻译', command: 'translate', content: '技能正文' });
  });

  it('command 空 → 报错', async () => {
    const r = await doLoadSkill('');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('command');
  });

  it('未知 command → 报错（提示无此启用技能）', async () => {
    const r = await doLoadSkill('nope');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('nope');
  });

  it('技能存在但已停用 → 报错点名停用', async () => {
    await saveSkill({
      id: 'k2', name: '停用技能', command: 'off', description: 'd',
      content: 'X', enabled: false, createdAt: 1, updatedAt: 1,
    });
    const r = await doLoadSkill('off');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('停用');
      expect(r.error).toContain('停用技能');
    }
  });
});
