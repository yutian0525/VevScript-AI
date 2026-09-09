// tests/chat/args-progress.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useChat } from '../../stores/chat';
import type { ChatMessage } from '../../agent/provider/types';

describe('chat store：参数生成进度（顶层瞬态）', () => {
  beforeEach(() => useChat.getState().reset());

  it('tool-args-delta 写入顶层 argsProgress，不进 messages', () => {
    useChat.getState().applyEvent({ type: 'tool-args-delta', name: 'create_script', bytes: 512 });
    expect(useChat.getState().argsProgress).toEqual({ name: 'create_script', bytes: 512 });
    expect(useChat.getState().messages).toHaveLength(0);
  });

  it('后续事件覆盖写（bytes 是累计值）', () => {
    const { applyEvent } = useChat.getState();
    applyEvent({ type: 'tool-args-delta', name: 'create_script', bytes: 512 });
    applyEvent({ type: 'tool-args-delta', name: 'create_script', bytes: 2048 });
    expect(useChat.getState().argsProgress).toEqual({ name: 'create_script', bytes: 2048 });
  });

  it('tool-start / done / paused / error 清空进度', () => {
    const set = () => useChat.getState().applyEvent({ type: 'tool-args-delta', name: 'x', bytes: 1 });

    set();
    useChat.getState().applyEvent({ type: 'tool-start', name: 'x', args: '{}', callId: 'c1' });
    expect(useChat.getState().argsProgress).toBeUndefined();

    set();
    useChat.getState().applyEvent({ type: 'done', finalText: 'ok' });
    expect(useChat.getState().argsProgress).toBeUndefined();

    set();
    useChat.getState().applyEvent({ type: 'paused', reason: 'r' });
    expect(useChat.getState().argsProgress).toBeUndefined();

    set();
    useChat.getState().applyEvent({ type: 'error', message: 'e' });
    expect(useChat.getState().argsProgress).toBeUndefined();
  });

  it('reset 清空进度', () => {
    useChat.getState().applyEvent({ type: 'tool-args-delta', name: 'x', bytes: 1 });
    useChat.getState().reset();
    expect(useChat.getState().argsProgress).toBeUndefined();
  });

  it('loadFromStorage 清空进度（跨会话切换不残留上一会话的进度条）', () => {
    useChat.getState().applyEvent({ type: 'tool-args-delta', name: 'create_script', bytes: 4096 });
    useChat.getState().loadFromStorage([{ role: 'user', content: '另一个会话' }] as ChatMessage[]);
    expect(useChat.getState().argsProgress).toBeUndefined();
  });
});
