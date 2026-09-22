// tests/convdebug/utils.test.ts
import { describe, it, expect } from 'vitest';
import {
  isTrimmed, firstKeptTurn, isMissingConversation, formatMs, compactNumber,
  formatTokens, formatChars, formatRelativeTime, outcomeClass, toMessageRows,
} from '../../components/convdebug/convdebug-utils';
import type { ConvTraceStore, TurnTrace } from '../../storage/traces';
import type { ChatMessage } from '../../agent/provider/types';

const turn = (n: number): TurnTrace => ({
  turn: n, startedAt: 0, endedAt: 0, tabId: 1, mode: 'agent',
  context: { messageCount: 0, chars: 0, hasSummary: false, summaryChars: 0, skillCount: 0, systemPromptChars: 0, volatileChars: 0, pageUrl: '' },
  llm: { ms: 0, finishReason: '', textChars: 0, reasoningChars: 0 },
  tools: [], outcome: 'done',
});
const store = (seq: number, n: number): ConvTraceStore => ({ seq, turns: Array.from({ length: n }, (_, i) => turn(i + 1)) });

describe('convdebug-utils', () => {
  it('isTrimmed：seq 大于现存轮数即被裁过', () => {
    expect(isTrimmed(store(3, 2))).toBe(true);
    expect(isTrimmed(store(2, 2))).toBe(false);
    expect(isTrimmed(store(0, 0))).toBe(false);
  });

  it('firstKeptTurn：空 store 返回 0', () => {
    expect(firstKeptTurn(store(5, 2))).toBe(1);
    expect(firstKeptTurn(store(0, 0))).toBe(0);
  });

  it('isMissingConversation：updatedAt 为 0 才是「从未落库」的哨兵', () => {
    // getConversation 对未知 id 返回 updatedAt=0 的空壳
    expect(isMissingConversation({ id: 'x', title: '新会话', messages: [], status: 'idle', createdAt: 0, updatedAt: 0 })).toBe(true);
    expect(isMissingConversation({ id: 'x', title: 'a', messages: [], status: 'idle', createdAt: 1, updatedAt: 1 })).toBe(false);
  });

  it('isMissingConversation：草稿出生的真实会话不能被误判为不存在', () => {
    // 回归：新会话是客户端草稿 id（stores/conversations.ts 的 newConversation 不落库），
    // 首条消息经 appendMessage → getConversation(空壳) → saveConversation 建档，
    // 于是 createdAt 永久停留在哨兵值 0，而 updatedAt 被 saveConversation 刷新。
    // 拿 createdAt 判「不存在」会把每一个真实会话都判成不存在。
    expect(isMissingConversation({
      id: 'draft-abc', title: '你好', status: 'idle',
      messages: [{ role: 'user', content: '你好' }],
      createdAt: 0, updatedAt: Date.now(),
    })).toBe(false);
  });

  it('formatMs：>=1000 用秒一位小数，否则毫秒整数', () => {
    expect(formatMs(240)).toBe('240ms');
    expect(formatMs(2400)).toBe('2.4s');
    expect(formatMs(0)).toBe('0ms');
    expect(formatMs(Number.NaN)).toBe('—');
    expect(formatMs(-1)).toBe('—');
  });

  it('compactNumber / formatChars / formatTokens', () => {
    expect(compactNumber(999)).toBe('999');
    expect(compactNumber(1200)).toBe('1.2k');
    expect(formatChars(420)).toBe('420 字');
    expect(formatChars(42000)).toBe('42.0k 字');
    expect(formatTokens(1200, 340)).toBe('1.2k→340');
    expect(formatTokens(1200)).toBe('1.2k');
    expect(formatTokens(undefined, 340)).toBe('—');
  });

  it('formatRelativeTime 按档位退化', () => {
    const now = 10_000_000;
    expect(formatRelativeTime(now - 30_000, now)).toBe('刚刚');
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5 分钟前');
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe('3 小时前');
    expect(formatRelativeTime(now - 3 * 86_400_000, now)).toBe(new Date(now - 3 * 86_400_000).toLocaleDateString());
  });

  it('outcomeClass 产出 CSS 修饰名', () => {
    expect(outcomeClass('truncated-retry')).toBe('convdebug-turn--truncated-retry');
  });

  it('toMessageRows：字符串 content、toolCalls、name', () => {
    const msgs: ChatMessage[] = [
      { role: 'assistant', content: '好的', toolCalls: [{ id: 'a', name: 'click', arguments: '{"uid":1}' }] },
      { role: 'tool', content: 'ok', name: 'click', toolCallId: 'a' },
    ];
    const rows = toMessageRows(msgs);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.text).toBe('好的');
    expect(rows[0]!.toolCalls).toEqual([{ name: 'click', args: '{"uid":1}' }]);
    expect(rows[1]!.name).toBe('click');
    expect(rows[0]!.key).not.toBe(rows[1]!.key);
  });

  it('toMessageRows：图片 part 折叠成占位文本，不把 base64 渲进 DOM', () => {
    const msgs: ChatMessage[] = [{
      role: 'user',
      content: [{ type: 'text', text: '看这个' }, { type: 'image_url', imageUrl: 'data:image/png;base64,AAAA' }],
    }];
    const row = toMessageRows(msgs)[0]!;
    expect(row.text).toContain('看这个');
    expect(row.text).toContain('[图片');
    expect(row.text).not.toContain('AAAA');
  });

  it('toMessageRows：reasoning 单独成字段', () => {
    const rows = toMessageRows([{ role: 'assistant', content: 'x', reasoning: '想想' }]);
    expect(rows[0]!.reasoning).toBe('想想');
  });
});
