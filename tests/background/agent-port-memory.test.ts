// tests/background/agent-port-memory.test.ts
// readMemoryState：settings 开关 + storage 投影 + 降级的胶水层直测。
import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { readMemoryState } from '../../background/agent-port';
import { saveMemory, newMemory } from '../../storage/memory';
import { saveSettings } from '../../storage/settings';

describe('readMemoryState', () => {
  beforeEach(() => fakeBrowser.reset());

  it('默认（开关全开）→ enabled/writable 均 true，投影 entries 为 MemoryBrief 形状', async () => {
    await saveMemory({ ...newMemory({ content: 'X', matches: ['*://a.com/*'], source: 'ai' }), id: 'm1', updatedAt: 5 });
    const s = await readMemoryState();
    expect(s.enabled).toBe(true);
    expect(s.writable).toBe(true);
    expect(s.entries).toEqual([{ id: 'm1', content: 'X', matches: ['*://a.com/*'], updatedAt: 5 }]);
    // 投影只取四字段，不含 source/createdAt
    expect(s.entries[0]).not.toHaveProperty('source');
    expect(s.entries[0]).not.toHaveProperty('createdAt');
  });

  it('memoryEnabled=false → 返回 off（enabled:false, writable:false, entries 空），不读记忆', async () => {
    await saveMemory({ ...newMemory({ content: 'X', matches: [], source: 'ai' }), id: 'm1' });
    await saveSettings({ agent: { memoryEnabled: false } });
    const s = await readMemoryState();
    expect(s).toEqual({ enabled: false, writable: false, entries: [] });
  });

  it('memoryWritable=false → enabled:true 但 writable:false（记忆仍注入、只读）', async () => {
    await saveSettings({ agent: { memoryWritable: false } });
    const s = await readMemoryState();
    expect(s.enabled).toBe(true);
    expect(s.writable).toBe(false);
  });
});
