// tests/agent/trace.test.ts
import { describe, it, expect } from 'vitest';
import { measureMessages, summarizeContext } from '../../agent/trace';
import type { ChatMessage } from '../../agent/provider/types';

describe('measureMessages', () => {
  it('累加字符串 content 的长度', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: '12345' },
      { role: 'user', content: '123' },
    ];
    expect(measureMessages(msgs)).toBe(8);
  });

  it('数组 content 里图片 part 按 data URL 长度计入', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'ab' }, { type: 'image_url', imageUrl: 'data:image/png;base64,XXXX' }] },
    ];
    expect(measureMessages(msgs)).toBe(2 + 'data:image/png;base64,XXXX'.length);
  });

  it('toolCalls 与 reasoning 计入', () => {
    const msgs: ChatMessage[] = [
      { role: 'assistant', content: 'x', reasoning: 'yy', toolCalls: [{ id: 'a', name: 'click', arguments: '{}' }] },
    ];
    const expected = 1 + 2 + JSON.stringify([{ id: 'a', name: 'click', arguments: '{}' }]).length;
    expect(measureMessages(msgs)).toBe(expected);
  });
});

describe('summarizeContext', () => {
  it('system 消息长度取 messages[0]（即真正发出去的那份）', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: '1234567890' },
      { role: 'user', content: 'hi' },
    ];
    const s = summarizeContext(msgs, { pageUrl: 'https://x.com' });
    expect(s.messageCount).toBe(2);
    expect(s.systemPromptChars).toBe(10);
    expect(s.pageUrl).toBe('https://x.com');
    expect(s.hasSummary).toBe(false);
    expect(s.summaryChars).toBe(0);
    expect(s.skillCount).toBe(0);
  });

  it('带摘要与技能时反映在字段里', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '【前情摘要】\nabc' },
    ];
    const s = summarizeContext(msgs, {
      summary: { text: 'abc', coversUpTo: 3 },
      skills: [{ name: 'A', command: 'a', description: '' }],
      pageUrl: '',
    });
    expect(s.hasSummary).toBe(true);
    expect(s.summaryChars).toBe(3);
    expect(s.skillCount).toBe(1);
  });

  it('首条不是 system 时 systemPromptChars 为 0', () => {
    const msgs: ChatMessage[] = [{ role: 'user', content: 'hi' }];
    expect(summarizeContext(msgs, { pageUrl: '' }).systemPromptChars).toBe(0);
  });
});
