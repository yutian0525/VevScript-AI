// tests/background/storage-manager.test.ts
// 存储管理（background/storage-manager.ts）：分组分类、字节统计、清理、备份导出/导入。
// 注意：裸 browser.storage.local 用物理键（无 local: 前缀）；种子数据一律物理键直写。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
// Task 1 只 import 本任务实现的三个函数；Task 2/3/4 落地时把 cleanStorage/buildBackup/jsonDataUrl/parseBackup/importBackup 补进这行 import
import { classifyKey, byteLength, getStorageUsage } from '../../background/storage-manager';

beforeEach(() => {
  fakeBrowser.reset();
  vi.restoreAllMocks();
});

describe('classifyKey（物理键 → 数据域）', () => {
  it.each([
    ['conv-index', 'conv'],
    ['conv:abc123', 'conv'],
    ['conv:abc123:trace', 'trace'],
    ['scripts:index', 'scripts'],
    ['skills:index', 'skills'],
    ['memory:index', 'memory'],
    ['settings', 'settings'],
    ['gm:resources', 'gm-resources'],
    ['gm:permissions', 'gm-auth'],
    ['gm:seed', 'gm-auth'],
    ['script-values:s1', 'gm-values'],
    ['scripts:update-state', 'update-state'],
    ['scripts:last-update-check', 'update-state'],
    ['ext-update:state', 'update-state'],
    ['ext-update:last-check', 'update-state'],
    ['something-new', 'other'],
  ])('%s → %s', (key, expected) => {
    expect(classifyKey(key)).toBe(expected);
  });
});

describe('byteLength（UTF-8 精确字节）', () => {
  it('ASCII 与中文各按编码计', () => {
    expect(byteLength('ab')).toBe(4);        // "ab" 含两引号
    expect(byteLength('中')).toBe(5);        // "中" = 1 + 3 + 1
    expect(byteLength({ a: 1 })).toBe(7);    // {"a":1}
  });
});

describe('getStorageUsage', () => {
  beforeEach(async () => {
    await browser.storage.local.set({
      'conv-index': [{ id: 'a', title: '会话A', updatedAt: 1, status: 'active' }, { id: 'b', title: '会话B', updatedAt: 2, status: 'active' }],
      'conv:a': { id: 'a', messages: [] },
      'conv:a:trace': { turns: new Array(50).fill('x') },  // 大 trace
      'conv:b:trace': { turns: [] },
      'scripts:index': [{ id: 's1' }, { id: 's2' }, { id: 's3' }],
      'settings': { provider: { baseUrl: '', apiKey: 'sk-secret', model: 'm' }, agent: {}, prompt: {} },
      'gm:resources': { 'https://x/1.js': { content: 'x', fetchedAt: 1 }, 'https://x/2.js': { content: 'y', fetchedAt: 2 } },
      'unknown-key': { z: 1 },
    });
  });

  it('分组字节/条目数正确；traces 按字节降序且带会话标题；gmResources 计数', async () => {
    const u = await getStorageUsage();
    expect(u.totalBytes).toBeGreaterThan(0);
    const byGroup = Object.fromEntries(u.groups.map((g) => [g.group, g]));
    expect(byGroup['conv']!.items).toBe(1);            // conv:{id} 键数（conv-index 不计）
    expect(byGroup['trace']!.items).toBe(2);           // 两条 trace 键
    expect(byGroup['scripts']!.items).toBe(3);         // 数组长度
    expect(byGroup['other']!.bytes).toBeGreaterThan(0);
    expect(u.traces[0]!.convId).toBe('a');
    expect(u.traces[0]!.title).toBe('会话A');
    expect(u.traces[1]!.convId).toBe('b');
    expect(u.gmResources.count).toBe(2);
    expect(u.gmResources.bytes).toBeGreaterThan(0);
  });

  it('已删会话的残留 trace：title 置空仍可列出', async () => {
    await browser.storage.local.set({ 'conv:ghost:trace': { turns: [] } });
    const u = await getStorageUsage();
    const ghost = u.traces.find((t) => t.convId === 'ghost');
    expect(ghost).toBeDefined();
    expect(ghost!.title).toBeUndefined();
  });
});
