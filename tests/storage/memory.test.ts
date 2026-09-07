// tests/storage/memory.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { storage } from 'wxt/utils/storage';
import {
  listMemories, getMemoryEntry, saveMemory, deleteMemory, newMemory,
  MAX_ENTRIES, MAX_CONTENT_LENGTH,
} from '../../storage/memory';
import type { MemoryEntry } from '../../shared/types';

function mk(over: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: 'm1', content: '用户偏好中文回复', matches: [],
    source: 'ai', createdAt: 1, updatedAt: 1, ...over,
  };
}

describe('storage/memory', () => {
  beforeEach(() => fakeBrowser.reset());

  it('空库返回 []，getMemoryEntry 返回 undefined', async () => {
    expect(await listMemories()).toEqual([]);
    expect(await getMemoryEntry('m1')).toBeUndefined();
  });

  it('save 新增 + 读回 + list 全量', async () => {
    await saveMemory(mk());
    await saveMemory(mk({ id: 'm2', content: 'B 站登录按钮在头像悬浮层', matches: ['*://*.bilibili.com/*'] }));
    expect(await getMemoryEntry('m2')).toMatchObject({ id: 'm2', matches: ['*://*.bilibili.com/*'] });
    expect(await listMemories()).toHaveLength(2);
  });

  it('同 id 覆盖（upsert）不新增', async () => {
    await saveMemory(mk());
    await saveMemory(mk({ content: '改过的正文' }));
    const all = await listMemories();
    expect(all).toHaveLength(1);
    expect(all[0]!.content).toBe('改过的正文');
  });

  it('落到 local:memory:index 键', async () => {
    await saveMemory(mk());
    expect(await storage.getItem<MemoryEntry[]>('local:memory:index')).toHaveLength(1);
  });

  it('数量上限：超过 MAX_ENTRIES 抛错', async () => {
    for (let i = 0; i < MAX_ENTRIES; i++) await saveMemory(mk({ id: `k${i}` }));
    await expect(saveMemory(mk({ id: 'extra' }))).rejects.toThrow('上限');
  });

  it('满员时更新既有条目仍成功', async () => {
    for (let i = 0; i < MAX_ENTRIES; i++) await saveMemory(mk({ id: `k${i}` }));
    await saveMemory(mk({ id: 'k0', content: '改名' }));
    expect(await listMemories()).toHaveLength(MAX_ENTRIES);
    expect((await getMemoryEntry('k0'))!.content).toBe('改名');
  });

  it('content 为空或纯空白抛错', async () => {
    await expect(saveMemory(mk({ content: '' }))).rejects.toThrow('正文');
    await expect(saveMemory(mk({ content: '   ' }))).rejects.toThrow('正文');
  });

  it('content 超长抛错', async () => {
    await expect(saveMemory(mk({ content: 'x'.repeat(MAX_CONTENT_LENGTH + 1) }))).rejects.toThrow('上限');
  });

  it('非法 match pattern 整条拒存，错误文案点名那条', async () => {
    await expect(
      saveMemory(mk({ matches: ['*://*.bilibili.com/*', '不是 pattern'] })),
    ).rejects.toThrow('不是 pattern');
    expect(await listMemories()).toEqual([]);
  });

  it('<all_urls> 视为合法 pattern', async () => {
    await saveMemory(mk({ matches: ['<all_urls>'] }));
    expect(await listMemories()).toHaveLength(1);
  });

  it('delete 幂等（不存在也成功）', async () => {
    await saveMemory(mk());
    await deleteMemory('m1');
    await deleteMemory('m1');
    expect(await listMemories()).toEqual([]);
  });

  it('newMemory 工厂：8 位 id + 时间戳 + 字段透传', () => {
    const m = newMemory({ content: 'C', matches: ['<all_urls>'], source: 'user' });
    expect(m.id).toHaveLength(8);
    expect(m.createdAt).toBeGreaterThan(0);
    expect(m.updatedAt).toBe(m.createdAt);
    expect(m).toMatchObject({ content: 'C', matches: ['<all_urls>'], source: 'user' });
  });
});
