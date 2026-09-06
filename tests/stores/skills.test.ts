// tests/stores/skills.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { useSkills, filterSkills } from '../../stores/skills';
import type { SkillSummary } from '../../shared/types';

const LIST: SkillSummary[] = [
  { id: '1', name: '网页翻译', command: 'translate', description: '翻译页面', enabled: true, updatedAt: 1 },
  { id: '2', name: '总结', command: 'summarize', description: '总结页面内容', enabled: true, updatedAt: 2 },
  { id: '3', name: '停用项', command: 'off', description: '已停用', enabled: false, updatedAt: 3 },
];

describe('filterSkills（纯函数）', () => {
  it('空查询返回全部启用项（不含停用）', () => {
    expect(filterSkills(LIST, '')).toHaveLength(2);
  });

  it('command 前缀匹配优先排序', () => {
    const r = filterSkills([...LIST, { id: '4', name: '说明', command: 'explain', description: '', enabled: true, updatedAt: 4 }], 's');
    expect(r[0]!.command).toBe('summarize');
  });

  it('name/description 子串也命中', () => {
    expect(filterSkills(LIST, '翻译').map((s) => s.command)).toEqual(['translate']);
    expect(filterSkills(LIST, '页面内容').map((s) => s.command)).toEqual(['summarize']);
  });

  it('无命中返回 []', () => {
    expect(filterSkills(LIST, 'zzz')).toEqual([]);
  });
});

describe('useSkills store', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
    useSkills.setState({ list: [], loading: false });
  });

  it('refresh 拉列表', async () => {
    vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({
      ok: true,
      data: { skills: LIST },
    } as never);
    await useSkills.getState().refresh();
    expect(useSkills.getState().list).toHaveLength(3);
    expect(useSkills.getState().loading).toBe(false);
  });

  it('refresh 失败静默置 loading:false', async () => {
    useSkills.setState({ list: LIST });
    vi.spyOn(browser.runtime, 'sendMessage').mockRejectedValue(new Error('port gone'));
    await expect(useSkills.getState().refresh()).resolves.toBeUndefined();
    expect(useSkills.getState().loading).toBe(false);
  });

  it('refresh 返回 ok:false 时保留已加载列表', async () => {
    vi.spyOn(browser.runtime, 'sendMessage')
      .mockResolvedValueOnce({ ok: true, data: { skills: LIST } } as never)
      .mockResolvedValueOnce({ ok: false, error: 'x' } as never);
    await useSkills.getState().refresh();
    expect(useSkills.getState().list).toHaveLength(3);
    await useSkills.getState().refresh();
    expect(useSkills.getState().list).toHaveLength(3);
    expect(useSkills.getState().loading).toBe(false);
  });
});
