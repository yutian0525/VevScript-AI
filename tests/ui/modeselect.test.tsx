// tests/ui/modeselect.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { ModeSelect } from '../../components/chat/ModeSelect';
import { useChat } from '../../stores/chat';
import { getSettings, saveSettings } from '../../storage/settings';

afterEach(cleanup);

beforeEach(() => {
  fakeBrowser.reset();
  useChat.setState({ mode: 'agent' });
});

describe('ModeSelect 触发钮与双组浮窗', () => {
  it('触发钮无箭头，文案为权限状态（agent + 默认仅敏感）', async () => {
    const { container } = render(<ModeSelect />);
    const btn = await screen.findByRole('button', { name: /仅敏感/ });
    expect(btn.querySelector('.modeselect__chev')).toBeNull();
    expect(container.querySelector('.modeselect__chev')).toBeNull();
  });

  it('ask 模式文案为只读', async () => {
    useChat.setState({ mode: 'ask' });
    render(<ModeSelect />);
    expect(await screen.findByRole('button', { name: /只读/ })).toBeInTheDocument();
  });

  it('挂载时读取已存档位', async () => {
    await saveSettings({ agent: { confirmLevel: 'all' } });
    render(<ModeSelect />);
    expect(await screen.findByRole('button', { name: /全部询问/ })).toBeInTheDocument();
  });

  it('浮窗含两组，选档写入 settings', async () => {
    render(<ModeSelect />);
    fireEvent.click(await screen.findByRole('button', { name: /仅敏感/ }));
    expect(screen.getByText('行为模式')).toBeInTheDocument();
    expect(screen.getByText('确认策略')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: /自动放行/ }));
    await waitFor(async () => expect((await getSettings()).agent.confirmLevel).toBe('auto'));
  });

  it('ask 模式下确认策略组禁用', async () => {
    useChat.setState({ mode: 'ask' });
    render(<ModeSelect />);
    fireEvent.click(await screen.findByRole('button', { name: /只读/ }));
    expect(screen.getByRole('option', { name: /自动放行/ })).toBeDisabled();
  });

  it('键盘 ↓×4 + Enter 选到「自动放行」', async () => {
    render(<ModeSelect />);
    fireEvent.click(await screen.findByRole('button', { name: /仅敏感/ }));
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    fireEvent.keyDown(document, { key: 'Enter' });
    await waitFor(async () => expect((await getSettings()).agent.confirmLevel).toBe('auto'));
  });
});
