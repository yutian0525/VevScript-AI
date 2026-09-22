// tests/settings/tab-entries.test.ts
import { describe, it, expect } from 'vitest';
import { TAB_ENTRIES } from '../../components/settings/SettingsHome';

describe('TAB_ENTRIES', () => {
  it('会话调试项指向 conv-debug.html', () => {
    expect(TAB_ENTRIES.convdebug).toBe('/conv-debug.html');
  });

  it('只收带 tabUrl 的条目——进二级页的项不该出现在表里', () => {
    expect(TAB_ENTRIES.model).toBeUndefined();
    expect(TAB_ENTRIES.prompt).toBeUndefined();
    expect(TAB_ENTRIES.memory).toBeUndefined();
    expect(TAB_ENTRIES.skills).toBeUndefined();
    expect(TAB_ENTRIES.toolbench).toBeUndefined();
    expect(TAB_ENTRIES.scriptdebug).toBeUndefined();
    expect(TAB_ENTRIES.about).toBeUndefined();
  });

  it('表里每一项都有非空路径', () => {
    for (const [k, v] of Object.entries(TAB_ENTRIES)) {
      expect(typeof v, k).toBe('string');
      expect(v, k).toMatch(/^\/.+\.html$/);
    }
  });
});
