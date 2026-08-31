import { describe, it, expect, beforeEach } from 'vitest';
import { useChat } from '../../stores/chat';

describe('chat store', () => {
  beforeEach(() => useChat.getState().reset());

  it('addUserMessage 追加用户消息', () => {
    useChat.getState().addUserMessage('你好');
    const msgs = useChat.getState().messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ role: 'user', text: '你好' });
  });

  it('text-delta 累积到当前 assistant 消息', () => {
    useChat.getState().applyEvent({ type: 'text-delta', text: '你' });
    useChat.getState().applyEvent({ type: 'text-delta', text: '好' });
    const msgs = useChat.getState().messages;
    expect(msgs[msgs.length - 1]).toMatchObject({ role: 'assistant', text: '你好' });
  });

  it('tool-start 追加工具卡片（running）', () => {
    useChat.getState().applyEvent({ type: 'tool-start', name: 'click', args: '{"uid":1}', callId: 'c1' });
    const tool = useChat.getState().messages.find((m) => m.role === 'tool');
    expect(tool).toMatchObject({ name: 'click', status: 'running' });
  });

  it('tool-end 更新对应卡片状态', () => {
    useChat.getState().applyEvent({ type: 'tool-start', name: 'click', args: '{}', callId: 'c1' });
    useChat.getState().applyEvent({ type: 'tool-end', name: 'click', callId: 'c1', ok: true, summary: '成功' });
    const tool = useChat.getState().messages.find((m) => m.role === 'tool' && m.callId === 'c1');
    expect(tool).toMatchObject({ status: 'done', ok: true });
  });

  it('state 事件同步 status', () => {
    useChat.getState().applyEvent({ type: 'state', status: 'running', messageCount: 3 });
    expect(useChat.getState().status).toBe('running');
  });

  it('paused 设置 paused 状态与原因', () => {
    useChat.getState().applyEvent({ type: 'paused', reason: '连续重复' });
    expect(useChat.getState().status).toBe('paused');
    expect(useChat.getState().pauseReason).toBe('连续重复');
  });

  it('done 设 idle', () => {
    useChat.getState().setStatus('running');
    useChat.getState().applyEvent({ type: 'done', finalText: 'x' });
    expect(useChat.getState().status).toBe('idle');
  });

  it('error 追加错误卡片并设 idle', () => {
    useChat.getState().applyEvent({ type: 'error', message: 'HTTP 401' });
    const last = useChat.getState().messages.at(-1)!;
    expect(last.role).toBe('error');
    expect(useChat.getState().status).toBe('idle');
  });
});
