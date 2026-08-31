import { describe, it, expect } from 'vitest';
import { buildContext, truncateMessages } from '../../agent/context';
import type { ChatMessage } from '../../agent/provider/types';

const u = (c: string): ChatMessage => ({ role: 'user', content: c });

describe('context 组装', () => {
  it('第一条是 system，含工具指南与不可信输入声明', () => {
    const msgs = buildContext([u('hi')], { url: 'https://x.com', title: 'X' });
    expect(msgs[0]!.role).toBe('system');
    expect(msgs[0]!.content).toContain('不可信');
    expect(msgs[0]!.content).toContain('take_snapshot');
  });

  it('注入当前页 URL/title', () => {
    const msgs = buildContext([u('hi')], { url: 'https://x.com', title: '标题' });
    const sys = msgs[0]!.content as string;
    expect(sys).toContain('https://x.com');
    expect(sys).toContain('标题');
  });

  it('历史消息接在 system 之后', () => {
    const msgs = buildContext([u('a'), u('b')], { url: '', title: '' });
    expect(msgs.slice(1).map((m) => m.content)).toEqual(['a', 'b']);
  });

  it('truncateMessages 保留首条 user + 最近 N 条', () => {
    const history = Array.from({ length: 100 }, (_, i) => u(String(i)));
    const kept = truncateMessages(history, 10);
    expect(kept[0]!.content).toBe('0');
    expect(kept[kept.length - 1]!.content).toBe('99');
    expect(kept.length).toBeLessThanOrEqual(11);
  });

  it('历史不超过上限时原样返回', () => {
    const history = [u('a'), u('b')];
    expect(truncateMessages(history, 10)).toEqual(history);
  });

  it('truncateMessages 剥掉窗口头部孤立的 tool 消息（避免 orphaned tool_call）', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: '任务' },
      ...Array.from({ length: 20 }, (_, i) => ({ role: 'user', content: `f${i}` }) as ChatMessage),
      { role: 'tool', toolCallId: 'orphan', content: 'r' },
      { role: 'assistant', content: '继续' },
    ];
    // keepRecent=2 → 窗口 = 最后2条 [tool, assistant]，头部 tool 应被剥掉
    const kept = truncateMessages(history, 2);
    expect(kept[0]!.role).toBe('user'); // 保留的首条
    expect(kept.slice(1).some((m) => m.role === 'tool')).toBe(false);
    expect(kept[kept.length - 1]!.content).toBe('继续');
  });
});
