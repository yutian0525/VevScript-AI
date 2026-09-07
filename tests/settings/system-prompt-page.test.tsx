// tests/settings/system-prompt-page.test.tsx
// 系统提示词页：未自定义时预填内置全文 + 提示条；保存写入 custom 与 baseSnapshot；恢复默认清空。
// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SystemPromptPage } from '../../components/settings/SystemPromptPage';
import { getSettings, saveSettings } from '../../storage/settings';
import { SYSTEM_PROMPT } from '../../agent/context';

// CodeMirror 在 jsdom 下不便断言内容，替换为受控 textarea（只测页面逻辑，不测编辑器本体）
vi.mock('../../components/detail/CodeEditor', () => ({
  CodeEditor: ({ value, onChange, ariaLabel }: {
    value: string; onChange: (v: string) => void; ariaLabel: string;
  }) => (
    <textarea aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

beforeEach(() => {
  fakeBrowser.reset();
  vi.restoreAllMocks();
});
afterEach(cleanup);

describe('SystemPromptPage', () => {
  it('未自定义时：预填内置全文 + 出「当前使用内置提示词」提示条', async () => {
    render(<SystemPromptPage onBack={() => {}} />);
    const box = await screen.findByLabelText<HTMLTextAreaElement>('系统提示词编辑器');
    expect(box.value).toBe(SYSTEM_PROMPT);
    expect(screen.getByText(/当前使用内置提示词/)).toBeTruthy();
  });

  it('改内容后保存 → custom 与 baseSnapshot 落库，提示条消失', async () => {
    render(<SystemPromptPage onBack={() => {}} />);
    const box = await screen.findByLabelText<HTMLTextAreaElement>('系统提示词编辑器');
    fireEvent.change(box, { target: { value: '我的提示词' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(async () => {
      const s = await getSettings();
      expect(s.prompt.custom).toBe('我的提示词');
      expect(s.prompt.baseSnapshot).toBe(SYSTEM_PROMPT);
    });
    expect(screen.queryByText(/当前使用内置提示词/)).toBeNull();
  });

  it('已自定义时载入 custom，恢复默认后清空并回内置全文', async () => {
    await saveSettings({ prompt: { custom: '旧的自定义', baseSnapshot: SYSTEM_PROMPT } });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<SystemPromptPage onBack={() => {}} />);
    const box = await screen.findByLabelText<HTMLTextAreaElement>('系统提示词编辑器');
    await waitFor(() => expect(box.value).toBe('旧的自定义'));
    fireEvent.click(screen.getByRole('button', { name: '恢复默认' }));
    await waitFor(async () => expect((await getSettings()).prompt.custom).toBe(''));
    expect(box.value).toBe(SYSTEM_PROMPT);
  });

  it('baseSnapshot 与当前内置不同 → 出「基于旧版」提示条', async () => {
    await saveSettings({ prompt: { custom: '自定义', baseSnapshot: '很久以前的内置全文' } });
    render(<SystemPromptPage onBack={() => {}} />);
    expect(await screen.findByText(/基于旧版内置提示词/)).toBeTruthy();
  });

  it('超长（>16KB）禁用保存并出错误文案', async () => {
    render(<SystemPromptPage onBack={() => {}} />);
    const box = await screen.findByLabelText<HTMLTextAreaElement>('系统提示词编辑器');
    fireEvent.change(box, { target: { value: 'x'.repeat(16 * 1024 + 1) } });
    expect(screen.getByRole('button', { name: '保存' })).toHaveProperty('disabled', true);
    expect(screen.getByText(/超过上限/)).toBeTruthy();
  });

  it('切到预览渲染 Markdown（标题变成 heading 元素）', async () => {
    render(<SystemPromptPage onBack={() => {}} />);
    const box = await screen.findByLabelText<HTMLTextAreaElement>('系统提示词编辑器');
    fireEvent.change(box, { target: { value: '# 标题一' } });
    fireEvent.click(screen.getByRole('button', { name: '预览' }));
    expect(await screen.findByRole('heading', { name: '标题一' })).toBeTruthy();
  });
});
