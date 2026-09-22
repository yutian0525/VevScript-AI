// tests/storage/traces.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { readTraces, appendTurnTrace, clearTraces, MAX_TURNS, type TurnTrace } from '../../storage/traces';
import { createConversation, deleteConversation } from '../../storage/conversations';

function turn(n: number): TurnTrace {
  return {
    turn: n,
    startedAt: n * 1000,
    endedAt: n * 1000 + 500,
    tabId: 1,
    mode: 'agent',
    context: {
      messageCount: 1, chars: 10, hasSummary: false, summaryChars: 0,
      skillCount: 0, systemPromptChars: 5, volatileChars: 0, pageUrl: 'https://x.com',
    },
    llm: { ms: 400, finishReason: 'stop', textChars: 3, reasoningChars: 0 },
    tools: [],
    outcome: 'done',
  };
}

describe('traces storage', () => {
  beforeEach(() => fakeBrowser.reset());

  it('未知 convId 返回空壳，不抛错', async () => {
    expect(await readTraces('nope')).toEqual({ seq: 0, turns: [] });
  });

  it('appendTurnTrace 追加一轮并推进 seq', async () => {
    await appendTurnTrace('c1', turn(1));
    await appendTurnTrace('c1', turn(2));
    const { seq, turns } = await readTraces('c1');
    expect(seq).toBe(2);
    expect(turns.map((t) => t.turn)).toEqual([1, 2]);
  });

  it('超过 MAX_TURNS 裁掉最旧，seq 不回退', async () => {
    for (let i = 1; i <= MAX_TURNS + 1; i += 1) await appendTurnTrace('c2', turn(i));
    const { seq, turns } = await readTraces('c2');
    expect(seq).toBe(MAX_TURNS + 1);
    expect(turns).toHaveLength(MAX_TURNS);
    expect(turns[0]!.turn).toBe(2);                          // 第 1 轮被裁
    expect(turns[turns.length - 1]!.turn).toBe(MAX_TURNS + 1); // 最新一轮还在
  });

  it('clearTraces 清空该会话的 trace', async () => {
    await appendTurnTrace('c3', turn(1));
    await clearTraces('c3');
    expect(await readTraces('c3')).toEqual({ seq: 0, turns: [] });
  });

  it('deleteConversation 连带清掉该会话的 trace', async () => {
    const c = await createConversation();
    await appendTurnTrace(c.id, turn(1));
    await deleteConversation(c.id);
    expect(await readTraces(c.id)).toEqual({ seq: 0, turns: [] });
  });
});
