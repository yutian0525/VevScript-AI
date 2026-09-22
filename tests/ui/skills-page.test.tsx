// tests/ui/skills-page.test.tsx
// 技能管理页：内置技能（builtin）不渲染删除钮 + 显示「内置」徽标；普通技能删除钮照常。
// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { SkillsPage } from '../../components/skills/SkillsPage';
import { useSkills } from '../../stores/skills';
import { newSkill, saveSkill } from '../../storage/skills';
import type { SkillSummary } from '../../shared/types';

afterEach(cleanup);

function mkSummary(over: Partial<SkillSummary> = {}): SkillSummary {
  return {
    id: 'sk1', name: '帮助', command: 'help', description: '介绍扩展功能',
    enabled: true, updatedAt: 1, ...over,
  };
}

describe('SkillsPage 内置技能保护', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
    useSkills.setState({ list: [], loading: false });
  });

  function mockList(list: SkillSummary[]): void {
    browser.runtime.onMessage.addListener((msg: { type: string }, _s, sendResponse) => {
      if (msg.type === 'SKILLS_LIST') { sendResponse({ ok: true, data: { skills: list } }); return true; }
      sendResponse({ ok: false, error: 'unexpected' }); return true;
    });
  }

  it('builtin 技能：无删除钮、有「内置」徽标；普通技能有删除钮', async () => {
    mockList([mkSummary({ builtin: true }), mkSummary({ id: 'sk2', name: '翻译', command: 'translate' })]);
    useSkills.setState({ list: [mkSummary({ builtin: true }), mkSummary({ id: 'sk2', name: '翻译', command: 'translate' })] });
    render(<SkillsPage onBack={() => {}} />);
    await screen.findByText('帮助');
    expect(screen.queryByRole('button', { name: '删除 帮助' })).toBeNull();
    expect(screen.getByRole('button', { name: '删除 翻译' })).toBeTruthy();
    expect(screen.getByText('内置')).toBeTruthy();
  });

  it('主 tab 用法（不传 onBack）：无返回钮；设置二级页用法（传入）有「返回设置」钮', async () => {
    mockList([mkSummary()]);
    const { rerender } = render(<SkillsPage />);
    await screen.findByText('帮助');
    expect(screen.queryByLabelText('返回设置')).toBeNull();
    rerender(<SkillsPage onBack={() => {}} />);
    expect(await screen.findByLabelText('返回设置')).toBeTruthy();
  });

  it('builtin 详情页：显示「内置」徽标与启停开关', async () => {
    browser.runtime.onMessage.addListener((msg: { type: string }, _s, sendResponse) => {
      if (msg.type === 'SKILLS_LIST') { sendResponse({ ok: true, data: { skills: [mkSummary({ builtin: true })] } }); return true; }
      if (msg.type === 'SKILLS_GET') {
        sendResponse({
          ok: true,
          data: { skill: { ...mkSummary({ builtin: true }), content: '正文' } },
        });
        return true;
      }
      sendResponse({ ok: false, error: 'unexpected' }); return true;
    });
    render(<SkillsPage onBack={() => {}} />);
    // 挂载时 refresh() 异步拉列表（mock SKILLS_LIST），等卡片出现再点它（卡片本体 role="button"）进详情
    const card = await screen.findByText('帮助');
    fireEvent.click(card.closest('.scripts-card') ?? card);
    await screen.findByText('正文', { exact: false });
    expect(screen.getByText('内置')).toBeTruthy();
    expect(screen.getByRole('switch')).toBeTruthy();
    // 详情页本来就没有删除钮，但确保没引入
    expect(screen.queryByRole('button', { name: /删除/ })).toBeNull();
  });

  it('AI 创建的技能：显示「AI 创建」徽标；用户导入的不显示', async () => {
    mockList([
      mkSummary({ id: 'sk1', name: '日报', command: 'daily-report', source: 'agent' }),
      mkSummary({ id: 'sk2', name: '翻译', command: 'translate' }),
    ]);
    useSkills.setState({
      list: [
        mkSummary({ id: 'sk1', name: '日报', command: 'daily-report', source: 'agent' }),
        mkSummary({ id: 'sk2', name: '翻译', command: 'translate' }),
      ],
    });
    render(<SkillsPage onBack={() => {}} />);
    await screen.findByText('日报');
    expect(screen.getByText('AI 创建')).toBeTruthy();
    expect(screen.getAllByText('AI 创建')).toHaveLength(1); // 只有 agent 那条
  });

  it('storage.watch：AI 在别处写技能时，正开着这一页自动重拉列表', async () => {
    let listCalls = 0;
    browser.runtime.onMessage.addListener((msg: { type: string }, _s, sendResponse) => {
      if (msg.type === 'SKILLS_LIST') {
        listCalls += 1;
        sendResponse({ ok: true, data: { skills: [] } });
        return true;
      }
      sendResponse({ ok: false, error: 'unexpected' });
      return true;
    });
    render(<SkillsPage onBack={() => {}} />);
    // 挂载时的一次拉取先落地，否则分不清后面的增量是不是 watch 触发的
    await waitFor(() => expect(listCalls).toBe(1));
    // 模拟 AI 在对话里写技能（同一 storage 键）——不经过本页的任何交互
    await saveSkill(newSkill(
      { name: '日报', command: 'daily-report', description: '每天整理报表时触发', content: '正文'.repeat(30) },
      'agent',
    ));
    await waitFor(() => expect(listCalls).toBeGreaterThan(1));
  });
});
