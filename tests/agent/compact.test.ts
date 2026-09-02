// tests/agent/compact.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { splitForCompaction, estimateContextTokens, KEEP_RECENT_ORIGINALS, compactConversation } from '../../agent/compact';
import { createConversation, getConversation, appendMessage } from '../../storage/conversations';
import type { ChatMessage, Provider, StreamEvent, ChatParams } from '../../agent/provider/types';

const mk = (n: number): ChatMessage[] =>
  Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }) as ChatMessage);

describe('splitForCompaction', () => {
  it('保留边界常量 = 20', () => {
    expect(KEEP_RECENT_ORIGINALS).toBe(20);
  });
  it('首次压缩：N=30 无 coversUpTo → 摘要前 10 条，边界 9', () => {
    const r = splitForCompaction(mk(30), undefined, 20)!;
    expect(r.segment).toHaveLength(10);
    expect(r.newCoversUpTo).toBe(9);
  });
  it('消息不够老（N=15 < keep+1）→ null', () => {
    expect(splitForCompaction(mk(15), undefined, 20)).toBeNull();
  });
  it('已摘要覆盖足够（N=25, coversUpTo=9）→ null（不重复摘要，边界不倒退）', () => {
    expect(splitForCompaction(mk(25), 9, 20)).toBeNull();
  });
  it('增量压缩：N=50, coversUpTo=9 → 摘要 idx10-29，边界 29', () => {
    const r = splitForCompaction(mk(50), 9, 20)!;
    expect(r.segment).toHaveLength(20);
    expect(r.newCoversUpTo).toBe(29);
  });
});

describe('estimateContextTokens', () => {
  it('按字符数 / 2 估算（摘要 + 保留消息文本）', () => {
    const kept: ChatMessage[] = [{ role: 'user', content: 'abcd' }];
    // summary 'xy'(2) + 'abcd'(4) = 6 → ceil(6/2)=3
    expect(estimateContextTokens(kept, 'xy')).toBe(3);
  });
  it('content 为 parts 数组时只计文本 part', () => {
    const kept: ChatMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', imageUrl: 'x' }] }];
    // 'hi'(2) + summary ''(0) = 2 → 1
    expect(estimateContextTokens(kept, '')).toBe(1);
  });
});

function textProvider(events: StreamEvent[]): Provider {
  return {
    streamChat(_p: ChatParams, onEvent: (e: StreamEvent) => void) {
      queueMicrotask(() => { for (const e of events) onEvent(e); });
      return { cancel: vi.fn() };
    },
  };
}

describe('compactConversation', () => {
  beforeEach(() => fakeBrowser.reset());

  it('消息够多 → 调 LLM 写回摘要，原始消息不变', async () => {
    const c = await createConversation();
    for (let i = 0; i < 30; i++) await appendMessage(c.id, { role: i % 2 ? 'assistant' : 'user', content: `m${i}` });
    const provider = textProvider([{ type: 'text-delta', text: '前情摘要内容' }, { type: 'message-done', finishReason: 'stop' }]);
    const r = await compactConversation(c.id, { provider });
    expect(r.ok).toBe(true);
    const got = await getConversation(c.id);
    expect(got.summary!.text).toBe('前情摘要内容');
    expect(got.summary!.coversUpTo).toBe(9);
    expect(got.messages).toHaveLength(30); // 原始不删
    expect(r.newPromptTokens).toBeGreaterThan(0);
  });

  it('消息太少（不足触发）→ ok 但不调 provider、不写摘要', async () => {
    const c = await createConversation();
    for (let i = 0; i < 5; i++) await appendMessage(c.id, { role: 'user', content: `m${i}` });
    const stream = vi.fn();
    const provider: Provider = { streamChat: stream };
    const r = await compactConversation(c.id, { provider });
    expect(r.ok).toBe(true);
    expect(stream).not.toHaveBeenCalled();
    expect((await getConversation(c.id)).summary).toBeUndefined();
  });

  it('LLM 出错 → ok=false，不改会话摘要', async () => {
    const c = await createConversation();
    for (let i = 0; i < 30; i++) await appendMessage(c.id, { role: 'user', content: `m${i}` });
    const provider = textProvider([{ type: 'error', error: '429' }, { type: 'message-done' }]);
    const r = await compactConversation(c.id, { provider });
    expect(r.ok).toBe(false);
    expect((await getConversation(c.id)).summary).toBeUndefined();
  });

  it('增量摘要：已有 summary 时把旧摘要一并喂给 LLM', async () => {
    const c = await createConversation();
    for (let i = 0; i < 30; i++) await appendMessage(c.id, { role: 'user', content: `m${i}` });
    await compactConversation(c.id, { provider: textProvider([{ type: 'text-delta', text: '第一次摘要' }, { type: 'message-done', finishReason: 'stop' }]) });
    for (let i = 30; i < 60; i++) await appendMessage(c.id, { role: 'user', content: `m${i}` });
    let sentMessages = '';
    const spyProvider: Provider = {
      streamChat(p, onEvent) {
        sentMessages = JSON.stringify(p.messages);
        queueMicrotask(() => { onEvent({ type: 'text-delta', text: '第二次摘要' }); onEvent({ type: 'message-done', finishReason: 'stop' }); });
        return { cancel: vi.fn() };
      },
    };
    const r = await compactConversation(c.id, { provider: spyProvider });
    expect(r.ok).toBe(true);
    expect(sentMessages).toContain('第一次摘要'); // 旧摘要参与增量
    expect((await getConversation(c.id)).summary!.text).toBe('第二次摘要');
  });
});
