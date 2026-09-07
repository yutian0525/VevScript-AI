// tests/agent/tools/memory-tool.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { doMemoryList, doMemoryWrite, doMemoryDelete } from '../../../agent/tools/memory';
import { listMemories, saveMemory, newMemory, MAX_CONTENT_LENGTH } from '../../../storage/memory';

describe('doMemoryWrite', () => {
  beforeEach(() => fakeBrowser.reset());

  it('无 id → 新增，source 恒为 ai，返回 created:true', async () => {
    const r = await doMemoryWrite({ content: '偏好中文' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toMatchObject({ created: true, total: 1, matches: [] });
    const all = await listMemories();
    expect(all[0]).toMatchObject({ content: '偏好中文', source: 'ai' });
  });

  it('带 matches 新增', async () => {
    const r = await doMemoryWrite({ content: 'B 站经验', matches: ['*://*.bilibili.com/*'] });
    expect(r.ok).toBe(true);
    expect((await listMemories())[0]!.matches).toEqual(['*://*.bilibili.com/*']);
  });

  it('带 id → 改写正文，created:false，保留 createdAt 与 source', async () => {
    await saveMemory({ ...newMemory({ content: '旧', matches: [], source: 'user' }), id: 'm1', createdAt: 111 });
    const r = await doMemoryWrite({ id: 'm1', content: '新' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toMatchObject({ created: false, id: 'm1' });
    const hit = (await listMemories())[0]!;
    expect(hit).toMatchObject({ content: '新', createdAt: 111, source: 'user' });
    expect(hit.updatedAt).toBeGreaterThanOrEqual(111);
  });

  it('带 id 不传 matches → 保持原 matches', async () => {
    await saveMemory({ ...newMemory({ content: 'A', matches: ['*://a.com/*'], source: 'ai' }), id: 'm1' });
    await doMemoryWrite({ id: 'm1', content: 'B' });
    expect((await listMemories())[0]!.matches).toEqual(['*://a.com/*']);
  });

  it('带 id 传 matches → 全量替换', async () => {
    await saveMemory({ ...newMemory({ content: 'A', matches: ['*://a.com/*'], source: 'ai' }), id: 'm1' });
    await doMemoryWrite({ id: 'm1', content: 'A', matches: ['*://b.com/*'] });
    expect((await listMemories())[0]!.matches).toEqual(['*://b.com/*']);
  });

  it('id 不存在 → 报错，不静默新增', async () => {
    const r = await doMemoryWrite({ id: 'nope', content: 'X' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('nope');
    expect(await listMemories()).toEqual([]);
  });

  it('缺 content → 报错', async () => {
    const r = await doMemoryWrite({});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('content');
  });

  it('非法 pattern → 报错（storage 层校验冒泡成 ok:false）', async () => {
    const r = await doMemoryWrite({ content: 'X', matches: ['乱写'] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('乱写');
  });

  it('超长正文 → 报错', async () => {
    const r = await doMemoryWrite({ content: 'x'.repeat(MAX_CONTENT_LENGTH + 1) });
    expect(r.ok).toBe(false);
  });

  it('返回的 content 截断到 120 字（不回灌全文）', async () => {
    const r = await doMemoryWrite({ content: 'y'.repeat(400) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data!.content.length).toBeLessThanOrEqual(121); // 120 + 省略号
  });
});

describe('doMemoryDelete', () => {
  beforeEach(() => fakeBrowser.reset());

  it('删存在的 → deleted:true，total 减一', async () => {
    await saveMemory({ ...newMemory({ content: 'A', matches: [], source: 'ai' }), id: 'm1' });
    const r = await doMemoryDelete({ id: 'm1' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toMatchObject({ id: 'm1', deleted: true, total: 0 });
  });

  it('删不存在的 → 幂等成功，deleted:false', async () => {
    const r = await doMemoryDelete({ id: 'nope' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toMatchObject({ deleted: false, total: 0 });
  });

  it('缺 id → 报错', async () => {
    const r = await doMemoryDelete({} as { id: string });
    expect(r.ok).toBe(false);
  });
});

describe('doMemoryList', () => {
  beforeEach(async () => {
    fakeBrowser.reset();
    await saveMemory({ ...newMemory({ content: '全局偏好', matches: [], source: 'user' }), id: 'g1', updatedAt: 300 });
    await saveMemory({ ...newMemory({ content: 'B 站经验', matches: ['*://*.bilibili.com/*'], source: 'ai' }), id: 's1', updatedAt: 200 });
    await saveMemory({ ...newMemory({ content: 'GH 经验', matches: ['*://github.com/*'], source: 'ai' }), id: 's2', updatedAt: 100 });
  });

  it('无参 → 全库，按 updatedAt 倒序', async () => {
    const r = await doMemoryList({});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data!.total).toBe(3);
    expect(r.data!.entries.map((e) => e.id)).toEqual(['g1', 's1', 's2']);
  });

  it('scope 传完整 URL → 走 matchUrl 精确命中', async () => {
    const r = await doMemoryList({ scope: 'https://www.bilibili.com/video/BV1' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data!.entries.map((e) => e.id)).toEqual(['s1']);
  });

  it('scope 传关键词 → 走 pattern 子串匹配，大小写不敏感', async () => {
    const r = await doMemoryList({ scope: 'BiliBili' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data!.entries.map((e) => e.id)).toEqual(['s1']);
  });

  it('带 scope 时排除全局记忆（它们已常驻注入）', async () => {
    const r = await doMemoryList({ scope: 'github' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data!.entries.map((e) => e.id)).toEqual(['s2']);
    expect(r.data!.entries.some((e) => e.id === 'g1')).toBe(false);
  });

  it('scope 无命中 → 空列表但 ok:true', async () => {
    const r = await doMemoryList({ scope: 'zhihu' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data!.entries).toEqual([]);
    expect(r.data!.returned).toBe(0);
  });

  it('limit 截断，total 仍报全量', async () => {
    const r = await doMemoryList({ limit: 2 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data!.returned).toBe(2);
    expect(r.data!.total).toBe(3);
  });

  it('limit 超上限收窄到 100，非正数回落默认', async () => {
    const a = await doMemoryList({ limit: 9999 });
    expect(a.ok).toBe(true);
    const b = await doMemoryList({ limit: 0 });
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(b.data!.returned).toBe(3); // 回落默认 30，全库 3 条都在
  });
});
