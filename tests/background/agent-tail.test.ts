// tests/background/agent-tail.test.ts
import { describe, it, expect } from 'vitest';
import { emptyTail, reduceTail, replayTail } from '../../background/agent-tail';
import type { AgentEvent } from '../../shared/messages';

function fold(events: AgentEvent[]) {
  return events.reduce(reduceTail, emptyTail());
}

describe('agent-tail：未落库的流式尾巴', () => {
  it('reasoning-delta / text-delta 各自累积', () => {
    const t = fold([
      { type: 'reasoning-delta', text: '先' },
      { type: 'reasoning-delta', text: '想想' },
      { type: 'text-delta', text: '答' },
      { type: 'text-delta', text: '案' },
    ]);
    expect(t.reasoning).toBe('先想想');
    expect(t.text).toBe('答案');
  });

  it('tool-start 作废尾巴：此时 assistant 消息已落库', () => {
    const t = fold([
      { type: 'reasoning-delta', text: '要截图' },
      { type: 'text-delta', text: '我来看看' },
      { type: 'tool-start', name: 'take_snapshot', args: '{}', callId: 'c1' },
    ]);
    expect(t).toEqual(emptyTail());
  });

  it('tool-start 后的新增量重新累积（下一轮的尾巴）', () => {
    const t = fold([
      { type: 'text-delta', text: '第一轮' },
      { type: 'tool-start', name: 'click', args: '{}', callId: 'c1' },
      { type: 'tool-end', name: 'click', callId: 'c1', ok: true, summary: '成功' },
      { type: 'text-delta', text: '第二轮' },
    ]);
    expect(t.text).toBe('第二轮');
  });

  it('done / paused / error 各自收尾清空', () => {
    const seed: AgentEvent[] = [{ type: 'text-delta', text: 'x' }];
    for (const last of [
      { type: 'done', finalText: 'x' },
      { type: 'paused', reason: '需要确认' },
      { type: 'error', message: '炸了' },
    ] satisfies AgentEvent[]) {
      expect(fold([...seed, last])).toEqual(emptyTail());
    }
  });

  it('usage / state 不动尾巴：usage 在 assistant 落库之前发出', () => {
    const t = fold([
      { type: 'text-delta', text: '保留' },
      { type: 'usage', promptTokens: 100, completionTokens: 20 },
      { type: 'state', status: 'running', messageCount: 3 },
    ]);
    expect(t.text).toBe('保留');
  });

  it('compact-start / compact-done 跟踪压缩中，且不吃掉正文', () => {
    const during = fold([
      { type: 'text-delta', text: '正文' },
      { type: 'compact-start' },
    ]);
    expect(during).toMatchObject({ compacting: true, text: '正文' });
    const after = reduceTail(during, { type: 'compact-done', newPromptTokens: 3000 });
    expect(after).toMatchObject({ compacting: false, text: '正文' });
  });

  it('reduceTail 不改原对象（纯函数）', () => {
    const before = emptyTail();
    reduceTail(before, { type: 'text-delta', text: 'a' });
    expect(before).toEqual({ reasoning: '', text: '', compacting: false });
  });

  it('replayTail 顺序 reasoning → text：与流式一致，思考块会被正文收起', () => {
    const events = replayTail({ reasoning: '想', text: '说', compacting: false });
    expect(events).toEqual([
      { type: 'reasoning-delta', text: '想' },
      { type: 'text-delta', text: '说' },
    ]);
  });

  it('replayTail 空尾巴不补发任何事件', () => {
    expect(replayTail(emptyTail())).toEqual([]);
  });

  it('replayTail 只补有内容的部分，compacting 补 compact-start', () => {
    expect(replayTail({ reasoning: '', text: '仅正文', compacting: true })).toEqual([
      { type: 'text-delta', text: '仅正文' },
      { type: 'compact-start' },
    ]);
  });

  it('replay 出的事件回放进 reduceTail 得到同一尾巴（幂等）', () => {
    const tail = fold([
      { type: 'reasoning-delta', text: '想' },
      { type: 'text-delta', text: '说' },
    ]);
    expect(fold(replayTail(tail))).toEqual(tail);
  });
});
