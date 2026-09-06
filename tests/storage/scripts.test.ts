// tests/storage/scripts.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { storage } from 'wxt/utils/storage';
import {
  listScripts, getScript, saveScript, deleteScript, toSummary, MAX_SCRIPTS, MAX_TEXT_LENGTH,
} from '../../storage/scripts';
import type { UserScript } from '../../shared/types';

function mkScript(over: Partial<UserScript> = {}): UserScript {
  return {
    id: 's1', text: '// ==UserScript==\n// @name 测试\n// @match https://a.com/*\n// ==/UserScript==\nconsole.log(1);\n',
    name: '测试', enabled: true, matches: ['https://a.com/*'],
    code: 'console.log(1);', runAt: 'document_idle', world: 'USER_SCRIPT',
    source: 'user', createdAt: 1, updatedAt: 1, ...over,
  };
}

describe('storage/scripts', () => {
  beforeEach(() => fakeBrowser.reset());

  it('空库返回 []', async () => {
    expect(await listScripts()).toEqual([]);
    expect(await getScript('s1')).toBeUndefined();
  });

  it('save 新增 + get 读回 + list 全量', async () => {
    await saveScript(mkScript());
    await saveScript(mkScript({ id: 's2', name: '第二个' }));
    expect(await getScript('s1')).toMatchObject({ id: 's1', name: '测试' });
    expect(await listScripts()).toHaveLength(2);
  });

  it('save 同 id 覆盖（upsert）', async () => {
    await saveScript(mkScript());
    await saveScript(mkScript({ name: '改名', updatedAt: 9 }));
    const all = await listScripts();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ name: '改名', updatedAt: 9 });
  });

  it('落到 local:scripts:index 键', async () => {
    await saveScript(mkScript());
    const raw = await storage.getItem<UserScript[]>('local:scripts:index');
    expect(raw).toHaveLength(1);
  });

  it('delete 移除', async () => {
    await saveScript(mkScript());
    await deleteScript('s1');
    expect(await listScripts()).toEqual([]);
  });

  it('数量上限：超过 MAX_SCRIPTS 抛错', async () => {
    for (let i = 0; i < MAX_SCRIPTS; i++) await saveScript(mkScript({ id: `s${i}` }));
    await expect(saveScript(mkScript({ id: 'extra' }))).rejects.toThrow('上限');
  });

  it('code 超长抛错', async () => {
    await expect(saveScript(mkScript({ code: 'x'.repeat(256 * 1024 + 1) }))).rejects.toThrow('上限');
  });

  it('text 超长抛错', async () => {
    await expect(saveScript(mkScript({ text: 'x'.repeat(MAX_TEXT_LENGTH + 1) }))).rejects.toThrow('上限');
  });

  it('旧记录缺 text：listScripts 反拼补齐并惰性写回', async () => {
    const legacy = {
      id: 'old', name: '旧', enabled: true, matches: ['https://a.com/*'], code: 'x();',
      runAt: 'document_idle', world: 'USER_SCRIPT', source: 'import', createdAt: 1, updatedAt: 1,
    };
    await storage.setItem('local:scripts:index', [legacy]);
    const all = await listScripts();
    expect(all[0]!.text).toContain('@name');
    expect(all[0]!.text).toContain('x();');
    const raw = await storage.getItem<Array<Record<string, unknown>>>('local:scripts:index');
    expect(raw![0]!).toHaveProperty('text');
  });
});

describe('toSummary', () => {
  it('裁掉 code/text，带 hasGrants/description', () => {
    const s = mkScript({ meta: { description: '描述', grants: ['GM_getValue'] } });
    const sum = toSummary(s);
    expect(sum).not.toHaveProperty('code');
    expect(sum).not.toHaveProperty('text');
    expect(sum).toMatchObject({ id: 's1', description: '描述', hasGrants: true });
  });

  it('带 lines/bytes 规模字段（按 text 计算）', () => {
    const s = mkScript({ text: 'a\nb\nc' });
    expect(toSummary(s)).toMatchObject({ lines: 3, bytes: 5 });
    // 尾换行计入一个空行（split('\n') 语义）
    expect(toSummary(mkScript({ text: 'a\n' }))).toMatchObject({ lines: 2, bytes: 2 });
    expect(toSummary(mkScript({ text: '' }))).toMatchObject({ lines: 1, bytes: 0 });
  });
});
