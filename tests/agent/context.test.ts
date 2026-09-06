import { describe, it, expect } from 'vitest';
import { buildContext, truncateMessages, SYSTEM_PROMPT } from '../../agent/context';
import type { ChatMessage, ContentPart } from '../../agent/provider/types';

const u = (c: string): ChatMessage => ({ role: 'user', content: c });

describe('context 组装', () => {
  it('第一条是 system，含工具指南与不可信输入声明', () => {
    const msgs = buildContext([u('hi')], { url: 'https://x.com', title: 'X' });
    expect(msgs[0]!.role).toBe('system');
    expect(msgs[0]!.content).toContain('不可信');
    expect(msgs[0]!.content).toContain('take_snapshot');
  });

  it('SYSTEM_PROMPT 含「长内容分步写入」通用规则', () => {
    expect(SYSTEM_PROMPT).toContain('骨架');
    expect(SYSTEM_PROMPT).toContain('截断');
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

const img = (tag: string): ChatMessage => ({
  role: 'user',
  content: [{ type: 'text', text: tag }, { type: 'image_url', imageUrl: `data:img,${tag}` }] as ContentPart[],
});

describe('历史图片裁剪', () => {
  it('保留最近 2 条图片，更早的图片替换为文本占位', () => {
    const history = [img('a'), img('b'), img('c'), img('d')];
    const msgs = buildContext(history, { url: '', title: '' });
    const body = msgs.slice(1); // 去掉 system
    const hasImage = (m: ChatMessage) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url');
    const imgCount = body.filter(hasImage).length;
    expect(imgCount).toBe(2); // 只剩 c、d 带图
    const a = body[0]!;
    const aParts = a.content as ContentPart[];
    expect(aParts.some((p) => p.type === 'image_url')).toBe(false);
    expect(aParts.some((p) => p.type === 'text' && p.text.includes('历史截图'))).toBe(true);
  });

  it('图片数 <= 2 时不动', () => {
    const history = [img('a'), img('b')];
    const msgs = buildContext(history, { url: '', title: '' });
    const withImg = msgs.filter((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'));
    expect(withImg).toHaveLength(2);
  });
});

const page = { url: 'https://x.com', title: 'X' };

describe('buildContext summary 分支', () => {
  it('无 summary 时首条为 system，其后是历史', () => {
    const history: ChatMessage[] = [{ role: 'user', content: 'hi' }];
    const out = buildContext(history, page);
    expect(out[0]!.role).toBe('system');
    expect(out[1]).toEqual({ role: 'user', content: 'hi' });
  });

  it('有 summary 时：system + 前情摘要(user) + coversUpTo 之后的原始消息', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: 'm0' },
      { role: 'assistant', content: 'm1' },
      { role: 'user', content: 'm2' },
      { role: 'assistant', content: 'm3' },
    ];
    const out = buildContext(history, page, 60, { text: '前情：做了 m0-m1', coversUpTo: 1 });
    expect(out[0]!.role).toBe('system');
    expect(out[1]!.role).toBe('user');
    expect(String(out[1]!.content)).toContain('前情：做了 m0-m1');
    // coversUpTo=1 → 保留 index 2,3
    expect(out.slice(2)).toEqual([
      { role: 'user', content: 'm2' },
      { role: 'assistant', content: 'm3' },
    ]);
  });

  it('summary 保留段头部若为孤立 tool 消息则剥离（避免 tool_call_id 悬空）', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: 'm0' },
      { role: 'tool', toolCallId: 't1', name: 'click', content: 'ok' },
      { role: 'assistant', content: 'm2' },
    ];
    // coversUpTo=0 → 保留段从 index1 起是 tool（悬空），应被剥掉，留 assistant
    const out = buildContext(history, page, 60, { text: 's', coversUpTo: 0 });
    const afterSummary = out.slice(2);
    expect(afterSummary[0]!.role).not.toBe('tool');
    expect(afterSummary).toEqual([{ role: 'assistant', content: 'm2' }]);
  });

  it('coversUpTo 越界时保留段为空，只余 system + 摘要', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: 'm0' },
      { role: 'assistant', content: 'm1' },
    ];
    const out = buildContext(history, page, 60, { text: 's', coversUpTo: 5 });
    expect(out).toHaveLength(2);
    expect(out[0]!.role).toBe('system');
    expect(out[1]!.role).toBe('user');
    expect(String(out[1]!.content)).toContain('s');
  });
});
