// tests/ui/chat-confirm.test.tsx
// ChatView 接线：tool-confirm 事件渲染确认卡，决策经 postToAgent 发 agent:confirm。
// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { ChatView } from '../../components/chat/ChatView';
import { useChat } from '../../stores/chat';
import { useConversations } from '../../stores/conversations';
import { useSkills } from '../../stores/skills';
import { postToAgent } from '../../stores/agent-port-client';

afterEach(cleanup);

vi.mock('../../stores/agent-port-client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  attachConv: vi.fn(() => false),
  postToAgent: vi.fn(() => true),
}));

beforeEach(() => {
  fakeBrowser.reset();
  vi.clearAllMocks();
  useChat.setState({ messages: [], status: 'idle', promptTokens: 0, compacting: false } as never);
  useConversations.setState({ currentId: 'conv-1', list: [], menuOpen: false } as never);
  useSkills.setState({ list: [], loading: false });
});

describe('ChatView 工具确认卡接线', () => {
  it('tool-confirm 事件渲染确认卡，点击允许发出 agent:confirm', async () => {
    render(<ChatView />);
    // 等挂载 init() 异步链落定：空 storage 下 init 会走 newConversation → reset，
    // 若不先落定会在 applyEvent 之后把消息抹掉（竞态），事件永远渲染不出来。
    await act(async () => {});
    act(() => {
      useChat.getState().applyEvent({ type: 'tool-confirm', callId: 'tc1', name: 'evaluate_script', args: '{"function":"1+1"}', until: Date.now() + 120_000 });
    });
    expect(await screen.findByRole('alertdialog', { name: /evaluate_script/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '允许执行' }));
    await waitFor(() =>
      expect(vi.mocked(postToAgent)).toHaveBeenCalledWith({
        type: 'agent:confirm',
        convId: useConversations.getState().currentId,
        callId: 'tc1',
        decision: 'allow',
      }),
    );
  });

  it('tool-start 到达后确认卡翻回运行态工具卡', async () => {
    render(<ChatView />);
    await act(async () => {});
    act(() => {
      useChat.getState().applyEvent({ type: 'tool-confirm', callId: 'tc1', name: 'evaluate_script', args: '{}', until: Date.now() + 120_000 });
      useChat.getState().applyEvent({ type: 'tool-start', name: 'evaluate_script', args: '{}', callId: 'tc1' });
    });
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});
