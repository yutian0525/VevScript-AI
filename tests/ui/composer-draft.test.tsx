// tests/ui/composer-draft.test.tsx
// 输入框草稿：侧边栏切标签会被销毁重建（本地 useState 全丢），未发送内容须跨挂载保留。
// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { ChatView } from '../../components/chat/ChatView';
import { useChat } from '../../stores/chat';
import { useConversations } from '../../stores/conversations';
import { useSkills } from '../../stores/skills';
import { getDraft, saveDraft } from '../../storage/composer';

afterEach(cleanup);

vi.mock('../../stores/agent-port-client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  attachConv: vi.fn(() => false),
  postToAgent: vi.fn(),
}));

const PLACEHOLDER = '输入指令，让 AI 操作页面…';

async function renderComposer(): Promise<HTMLTextAreaElement> {
  render(<ChatView />);
  const ta = await screen.findByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
  await waitFor(() => expect(ta.disabled).toBe(false)); // 等草稿恢复落定
  return ta;
}

describe('输入框草稿跨挂载保留', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
    useChat.setState({ messages: [], status: 'idle', promptTokens: 0, compacting: false } as never);
    useConversations.setState({ currentId: null, list: [], menuOpen: false } as never);
    useSkills.setState({ list: [], loading: false });
  });

  it('敲字 → 面板重建（卸载再挂载）→ 内容仍在', async () => {
    const ta = await renderComposer();
    fireEvent.change(ta, { target: { value: '帮我把这三个弹窗都关掉' } });
    cleanup(); // 模拟切标签：面板文档销毁

    const again = await renderComposer();
    await waitFor(() => expect(again.value).toBe('帮我把这三个弹窗都关掉'));
  });

  it('清空输入 → 草稿键一并清掉，重建后不复活', async () => {
    const ta = await renderComposer();
    fireEvent.change(ta, { target: { value: '写一半的指令' } });
    await waitFor(async () => expect(await getDraft()).toBe('写一半的指令'));
    fireEvent.change(ta, { target: { value: '' } });
    await waitFor(async () => expect(await getDraft()).toBe(''));

    cleanup();
    const again = await renderComposer();
    expect(again.value).toBe('');
  });

  it('saveDraft 空串删键而非写字面空串', async () => {
    await saveDraft('x');
    await saveDraft('');
    expect(await fakeBrowser.storage.session.get('session:composer:draft')).toEqual({});
  });
});
