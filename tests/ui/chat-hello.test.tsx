// tests/ui/chat-hello.test.tsx
// 空状态欢迎页：Hi + 副标题 + 快捷指令 tag；点击 tag 填入输入框（不自动发送）。
// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { ChatView } from '../../components/chat/ChatView';
import { useChat } from '../../stores/chat';
import { useConversations } from '../../stores/conversations';
import { useSkills } from '../../stores/skills';

afterEach(cleanup);

vi.mock('../../stores/agent-port-client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  attachConv: vi.fn(() => false),
  postToAgent: vi.fn(),
}));

describe('ChatView 空状态欢迎页', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
    useChat.setState({ messages: [], status: 'idle', promptTokens: 0, compacting: false } as never);
    useConversations.setState({ currentId: null, list: [], menuOpen: false } as never);
    useSkills.setState({ list: [], loading: false });
  });

  it('渲染 Hi 标题 + 副标题 + 四个快捷 tag', async () => {
    render(<ChatView />);
    expect(await screen.findByText('Hi')).toBeTruthy();
    expect(screen.getByText('需要我帮你做些什么？')).toBeTruthy();
    expect(screen.getByText('帮我关闭页面上的弹窗')).toBeTruthy();
    expect(screen.getByText('你能做什么？')).toBeTruthy();
    expect(screen.getByText('帮我找一个脚本')).toBeTruthy();
    expect(screen.getByText('帮我写一个脚本')).toBeTruthy();
  });

  it('点击 tag 填入完整文案并聚焦，不自动发送', async () => {
    render(<ChatView />);
    const textarea = await screen.findByPlaceholderText('输入指令，让 AI 操作页面…') as HTMLTextAreaElement;
    // 普通建议：原文填入
    fireEvent.click(screen.getByText('帮我关闭页面上的弹窗'));
    expect(textarea.value).toBe('帮我关闭页面上的弹窗');
    // 斜杠建议：命令 + 需求描述一并填入（所见即所得）
    fireEvent.click(screen.getByText('你能做什么？'));
    expect(textarea.value).toBe('/help 你能做什么？');
    fireEvent.click(screen.getByText('帮我找一个脚本'));
    expect(textarea.value).toBe('/find-scripts 帮我找一个脚本');
    expect(useChat.getState().messages).toHaveLength(0); // 未自动发送
    expect(document.activeElement).toBe(textarea);
  });
});
