// tests/agent/trace.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { createTurnRecorder, measureMessages, summarizeContext } from '../../agent/trace';
import { readTraces } from '../../storage/traces';
import type { ChatMessage } from '../../agent/provider/types';
import type { TurnResult } from '../../agent/run-turn';

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

const llmResult = (over?: Partial<TurnResult>): TurnResult => ({
  text: '好的',
  toolCalls: [],
  finishReason: 'stop',
  usage: { promptTokens: 100, completionTokens: 20 },
  ...over,
});

describe('createTurnRecorder', () => {
  beforeEach(() => fakeBrowser.reset());

  it('commit 补 endedAt 并把整轮写进 storage', async () => {
    const tr = createTurnRecorder({ convId: 'r1', turn: 1, tabId: 3 });
    tr.setMode('ask');
    tr.markLlm({ startedAt: Date.now() - 50, result: llmResult() });
    await tr.commit();
    const { seq, turns } = await readTraces('r1');
    expect(seq).toBe(1);
    expect(turns[0]!.tabId).toBe(3);
    expect(turns[0]!.mode).toBe('ask');
    expect(turns[0]!.llm.finishReason).toBe('stop');
    expect(turns[0]!.llm.usage).toEqual({ promptTokens: 100, completionTokens: 20 });
    expect(turns[0]!.llm.textChars).toBe(2);
    expect(turns[0]!.endedAt).toBeGreaterThanOrEqual(turns[0]!.startedAt);
  });

  it('未赋值时 outcome 默认 error（漏设是 bug，不做静默伪装）', async () => {
    const tr = createTurnRecorder({ convId: 'r2', turn: 1, tabId: 1 });
    await tr.commit();
    expect((await readTraces('r2')).turns[0]!.outcome).toBe('error');
  });

  it('firstTokenAt 换算成 firstTokenMs；缺省则字段不存在', async () => {
    const startedAt = 1000;
    const a = createTurnRecorder({ convId: 'r3', turn: 1, tabId: 1 });
    a.markLlm({ startedAt, firstTokenAt: 1240, result: llmResult() });
    await a.commit();

    const b = createTurnRecorder({ convId: 'r4', turn: 1, tabId: 1 });
    b.markLlm({ startedAt, result: llmResult() });
    await b.commit();

    const [ta] = (await readTraces('r3')).turns;
    const [tb] = (await readTraces('r4')).turns;
    expect(ta!.llm.firstTokenMs).toBe(240);
    expect(tb!.llm.firstTokenMs).toBeUndefined();
  });

  it('markContext 走 summarizeContext', async () => {
    const tr = createTurnRecorder({ convId: 'r5', turn: 1, tabId: 1 });
    tr.markContext([{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }], { pageUrl: 'https://a.com' });
    await tr.commit();
    const c = (await readTraces('r5')).turns[0]!.context;
    expect(c.messageCount).toBe(2);
    expect(c.systemPromptChars).toBe(3);
    expect(c.pageUrl).toBe('https://a.com');
  });

  it('markTool 按调用顺序累计，markCompact 记下压缩', async () => {
    const tr = createTurnRecorder({ convId: 'r6', turn: 1, tabId: 1 });
    tr.markTool({ name: 'click', callId: 'c1', argsBytes: 9, ms: 12, ok: true, summary: '成功' });
    tr.markTool({ name: 'scroll', callId: 'c2', argsBytes: 20, ms: 30, ok: false, error: '炸了', summary: '炸了' });
    tr.markCompact({ ms: 800, ok: true, newPromptTokens: 340 });
    await tr.commit();
    const t = (await readTraces('r6')).turns[0]!;
    expect(t.tools.map((x) => x.callId)).toEqual(['c1', 'c2']);
    expect(t.tools[1]!.error).toBe('炸了');
    expect(t.compact).toEqual({ ms: 800, ok: true, newPromptTokens: 340 });
  });

  it('storage 写失败被吞掉，不阻断 loop', async () => {
    const spy = vi.spyOn(browser.storage.local, 'set').mockRejectedValue(new Error('QUOTA_BYTES exceeded'));
    const tr = createTurnRecorder({ convId: 'r7', turn: 1, tabId: 1 });
    await expect(tr.commit()).resolves.toBeUndefined();
    spy.mockRestore();
  });
});
