// tests/agent/tools/script-grep.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { doGrepScript } from '../../../agent/tools/script-grep';
import { saveScript } from '../../../storage/scripts';
import type { UserScript } from '../../../shared/types';

function mkScript(id: string, name: string, text: string): UserScript {
  return {
    id, text, name, enabled: true, matches: ['https://a.com/*'],
    code: text, runAt: 'document_idle', world: 'USER_SCRIPT',
    source: 'user', createdAt: 1, updatedAt: 1,
  };
}

type GrepMatch = { scriptId: string; name: string; line: number; text: string };
type GrepData = { matches: GrepMatch[]; truncated: boolean; warning?: string };
const data = (r: unknown) => (r as { data: GrepData }).data;

describe('grep_script', () => {
  beforeEach(async () => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
    await saveScript(mkScript('s1', '一号', 'const box = 1;\nconst BOX = 2;\nfoo();'));
    await saveScript(mkScript('s2', '二号', 'bar();\nconst box = 3;'));
  });

  it('单脚本检索：返回行号 + 带行号前缀的内容', async () => {
    const r = await doGrepScript({ pattern: 'box', id: 's1' });
    expect(r.ok).toBe(true);
    const d = data(r);
    expect(d.matches).toHaveLength(1);
    expect(d.matches[0]).toMatchObject({ scriptId: 's1', name: '一号', line: 1 });
    expect(d.matches[0]!.text).toMatch(/^\s+1\| const box = 1;$/);
    expect(d.truncated).toBe(false);
  });

  it('缺省 id → 搜全库，跨脚本命中', async () => {
    const d = data(await doGrepScript({ pattern: 'const box' }));
    expect(d.matches.map((m) => `${m.scriptId}:${m.line}`)).toEqual(['s1:1', 's2:2']);
  });

  it('ignoreCase 生效', async () => {
    expect(data(await doGrepScript({ pattern: 'BOX', id: 's1' })).matches).toHaveLength(1);
    expect(data(await doGrepScript({ pattern: 'BOX', id: 's1', ignoreCase: true })).matches).toHaveLength(2);
  });

  it('contextLines 带上下文行（去重、不重复输出同一行）', async () => {
    const d = data(await doGrepScript({ pattern: 'foo', id: 's1', contextLines: 1 }));
    expect(d.matches.map((m) => m.line)).toEqual([2, 3]);
  });

  it('limit 截断 → truncated: true', async () => {
    const d = data(await doGrepScript({ pattern: 'const', limit: 1 }));
    expect(d.matches).toHaveLength(1);
    expect(d.truncated).toBe(true);
  });

  it('正则语法生效；非法正则降级为字面量并带 warning', async () => {
    expect(data(await doGrepScript({ pattern: '^const \\w+', id: 's1' })).matches).toHaveLength(2);

    const d = data(await doGrepScript({ pattern: 'box(', id: 's1' }));
    expect(d.warning).toContain('字面量');
    expect(d.matches).toHaveLength(0);   // 字面量 'box(' 不存在
  });

  it('无命中 → 空数组，不报错', async () => {
    const d = data(await doGrepScript({ pattern: 'zzz-nope' }));
    expect(d.matches).toEqual([]);
    expect(d.truncated).toBe(false);
  });

  it('脚本不存在 → 报错', async () => {
    const r = await doGrepScript({ pattern: 'x', id: 'nope' });
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toContain('脚本不存在');
  });
});
