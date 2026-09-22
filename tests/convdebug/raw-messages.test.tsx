// tests/convdebug/raw-messages.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { RawMessages } from '../../components/convdebug/RawMessages';
import type { ChatMessage } from '../../agent/provider/types';

describe('RawMessages', () => {
  afterEach(cleanup);

  it('空消息显示空态', () => {
    render(<RawMessages messages={[]} />);
    expect(screen.getByText('这个会话还没有消息')).toBeTruthy();
  });

  it('逐条渲染 role 与正文', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: '帮我点掉弹窗' },
      { role: 'assistant', content: '好的' },
    ];
    render(<RawMessages messages={msgs} />);
    expect(screen.getByText('帮我点掉弹窗')).toBeTruthy();
    expect(screen.getByText('好的')).toBeTruthy();
    expect(screen.getByText('user')).toBeTruthy();
    expect(screen.getByText('assistant')).toBeTruthy();
  });

  it('assistant 的 toolCalls 折叠成可展开块', () => {
    const msgs: ChatMessage[] = [
      { role: 'assistant', content: '先点一下', toolCalls: [{ id: 'a', name: 'click', arguments: '{"uid":1}' }] },
    ];
    render(<RawMessages messages={msgs} />);
    expect(screen.getByText('调用 click')).toBeTruthy();
  });

  it('tool 消息显示工具名与输出', () => {
    const msgs: ChatMessage[] = [{ role: 'tool', content: '{"clicked":true}', name: 'click', toolCallId: 'a' }];
    render(<RawMessages messages={msgs} />);
    expect(screen.getByText('tool · click')).toBeTruthy();
    expect(screen.getByText('{"clicked":true}')).toBeTruthy();
  });

  it('reasoning 折叠成 details', () => {
    const msgs: ChatMessage[] = [{ role: 'assistant', content: 'x', reasoning: '先看看' }];
    render(<RawMessages messages={msgs} />);
    expect(screen.getByText('reasoning')).toBeTruthy();
  });

  it('图片 part 不把 base64 渲进 DOM', () => {
    const msgs: ChatMessage[] = [{
      role: 'user',
      content: [{ type: 'text', text: '看这个' }, { type: 'image_url', imageUrl: 'data:image/png;base64,SECRETBASE64' }],
    }];
    const { container } = render(<RawMessages messages={msgs} />);
    expect(container.textContent).not.toContain('SECRETBASE64');
    expect(container.textContent).toContain('[图片');
  });
});
