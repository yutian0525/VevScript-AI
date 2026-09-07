// tests/settings/memory-page.test.tsx
// 记忆管理页：列表渲染、两个开关、新建/编辑/删除、非法 pattern 拦截。
// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryPage } from '../../components/settings/MemoryPage';
import { listMemories, saveMemory, newMemory } from '../../storage/memory';
import { getSettings } from '../../storage/settings';

beforeEach(() => {
  fakeBrowser.reset();
  vi.restoreAllMocks();
});
afterEach(cleanup);

async function seed(): Promise<void> {
  await saveMemory({ ...newMemory({ content: '偏好中文回复', matches: [], source: 'user' }), id: 'g1' });
  await saveMemory({
    ...newMemory({ content: 'B 站登录在悬浮层', matches: ['*://*.bilibili.com/*'], source: 'ai' }),
    id: 's1',
  });
}

describe('MemoryPage 列表', () => {
  it('渲染条目、作用域 chip 与来源 chip', async () => {
    await seed();
    render(<MemoryPage onBack={() => {}} />);
    expect(await screen.findByText('偏好中文回复')).toBeTruthy();
    expect(screen.getByText('B 站登录在悬浮层')).toBeTruthy();
    expect(screen.getByText('全局')).toBeTruthy();
    expect(screen.getByText('*://*.bilibili.com/*')).toBeTruthy();
    expect(screen.getByText('手工')).toBeTruthy();
    expect(screen.getByText('AI')).toBeTruthy();
  });

  it('搜索过滤', async () => {
    await seed();
    render(<MemoryPage onBack={() => {}} />);
    await screen.findByText('偏好中文回复');
    fireEvent.change(screen.getByLabelText('搜索记忆'), { target: { value: 'bilibili' } });
    expect(screen.queryByText('偏好中文回复')).toBeNull();
    expect(screen.getByText('B 站登录在悬浮层')).toBeTruthy();
  });

  it('空库出占位文案', async () => {
    render(<MemoryPage onBack={() => {}} />);
    expect(await screen.findByText(/还没有记忆/)).toBeTruthy();
  });

  it('删除按钮（确认后）真删', async () => {
    await seed();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<MemoryPage onBack={() => {}} />);
    await screen.findByText('偏好中文回复');
    fireEvent.click(screen.getByRole('button', { name: '删除这条记忆：偏好中文回复' }));
    await waitFor(async () => expect(await listMemories()).toHaveLength(1));
  });
});

describe('MemoryPage 开关', () => {
  it('两个开关反映 settings 并可切换落库', async () => {
    render(<MemoryPage onBack={() => {}} />);
    const master = await screen.findByRole('switch', { name: '启用记忆' });
    expect(master.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(master);
    await waitFor(async () => expect((await getSettings()).agent.memoryEnabled).toBe(false));

    const writable = screen.getByRole('switch', { name: '允许 AI 写入' });
    fireEvent.click(writable);
    await waitFor(async () => expect((await getSettings()).agent.memoryWritable).toBe(false));
  });
});

describe('MemoryPage 详情', () => {
  it('新建：填正文与作用域后保存，落库 source=user', async () => {
    render(<MemoryPage onBack={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: '新建记忆' }));
    fireEvent.change(screen.getByLabelText('记忆正文'), { target: { value: '新记的东西' } });
    fireEvent.change(screen.getByLabelText('站点作用域'), { target: { value: '*://a.com/*' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(async () => {
      const all = await listMemories();
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({ content: '新记的东西', matches: ['*://a.com/*'], source: 'user' });
    });
  });

  it('非法 pattern → 出错误提示且不落库', async () => {
    render(<MemoryPage onBack={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: '新建记忆' }));
    fireEvent.change(screen.getByLabelText('记忆正文'), { target: { value: 'X' } });
    fireEvent.change(screen.getByLabelText('站点作用域'), { target: { value: '乱写的东西' } });
    expect(screen.getByText(/非法 match pattern：乱写的东西/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(async () => expect(await listMemories()).toEqual([]));
  });

  it('编辑 AI 记录的条目 → 保留 source=ai', async () => {
    await seed();
    render(<MemoryPage onBack={() => {}} />);
    fireEvent.click(await screen.findByText('B 站登录在悬浮层'));
    const box = await screen.findByLabelText<HTMLTextAreaElement>('记忆正文');
    fireEvent.change(box, { target: { value: '改过的经验' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(async () => {
      const hit = (await listMemories()).find((m) => m.id === 's1')!;
      expect(hit).toMatchObject({ content: '改过的经验', source: 'ai' });
    });
  });

  it('正文超 500 字 → 禁用保存并出计数错误', async () => {
    render(<MemoryPage onBack={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: '新建记忆' }));
    fireEvent.change(screen.getByLabelText('记忆正文'), { target: { value: 'x'.repeat(501) } });
    expect(screen.getByRole('button', { name: '保存' })).toHaveProperty('disabled', true);
    expect(screen.getByText(/501 \/ 500/)).toBeTruthy();
  });

  it('保存失败（撞条数上限）→ 错误横幅出在详情页而非被吞掉', async () => {
    for (let i = 0; i < 100; i++) {
      await saveMemory({ ...newMemory({ content: `第 ${i} 条`, matches: [], source: 'ai' }), id: `k${i}` });
    }
    render(<MemoryPage onBack={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: '新建记忆' }));
    fireEvent.change(screen.getByLabelText('记忆正文'), { target: { value: '第 101 条' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(await screen.findByText(/上限/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: '新建记忆' })).toBeTruthy();
  });
});
