import { describe, it, expect, vi } from 'vitest';
import { runTurn } from '../../agent/run-turn';
import type { Provider, StreamEvent, ChatParams } from '../../agent/provider/types';

function scriptedProvider(events: StreamEvent[]): Provider {
  return {
    streamChat(_params: ChatParams, onEvent: (e: StreamEvent) => void) {
      queueMicrotask(() => { for (const e of events) onEvent(e); });
      return { cancel: vi.fn() };
    },
  };
}
const params = (): ChatParams => ({ messages: [{ role: 'user', content: 'hi' }], tools: [] });

describe('runTurn', () => {
  it('聚合 text-delta 为完整文本', async () => {
    const p = scriptedProvider([
      { type: 'text-delta', text: '你好' },
      { type: 'text-delta', text: '世界' },
      { type: 'message-done', finishReason: 'stop' },
    ]);
    const r = await runTurn(p, params(), {});
    expect(r.text).toBe('你好世界');
    expect(r.toolCalls).toEqual([]);
    expect(r.finishReason).toBe('stop');
  });

  it('onTextDelta 回调实时收到增量', async () => {
    const p = scriptedProvider([
      { type: 'text-delta', text: 'a' }, { type: 'text-delta', text: 'b' },
      { type: 'message-done', finishReason: 'stop' },
    ]);
    const deltas: string[] = [];
    await runTurn(p, params(), { onTextDelta: (t) => deltas.push(t) });
    expect(deltas).toEqual(['a', 'b']);
  });

  it('聚合 tool-call-delta（index+id）为完整 ToolCall', async () => {
    const p = scriptedProvider([
      { type: 'tool-call-delta', index: 0, id: 'c1', name: 'click', argsDelta: '{"uid"' },
      { type: 'tool-call-delta', index: 0, argsDelta: ':5}' },
      { type: 'message-done', finishReason: 'tool_calls' },
    ]);
    const r = await runTurn(p, params(), {});
    expect(r.toolCalls).toEqual([{ id: 'c1', name: 'click', arguments: '{"uid":5}' }]);
    expect(r.finishReason).toBe('tool_calls');
  });

  it('多工具按 index 聚合', async () => {
    const p = scriptedProvider([
      { type: 'tool-call-delta', index: 0, id: 'c0', name: 'click', argsDelta: '{"uid":1}' },
      { type: 'tool-call-delta', index: 1, id: 'c1', name: 'fill', argsDelta: '{"uid":2,"value":"x"}' },
      { type: 'message-done', finishReason: 'tool_calls' },
    ]);
    const r = await runTurn(p, params(), {});
    expect(r.toolCalls).toHaveLength(2);
    expect(r.toolCalls[1]).toEqual({ id: 'c1', name: 'fill', arguments: '{"uid":2,"value":"x"}' });
  });

  it('error 事件编码进结果而非 reject', async () => {
    const p = scriptedProvider([
      { type: 'error', error: 'HTTP 401: bad key' },
      { type: 'message-done' },
    ]);
    const r = await runTurn(p, params(), {});
    expect(r.error).toBe('HTTP 401: bad key');
  });

  it('usage 透传', async () => {
    const p = scriptedProvider([
      { type: 'text-delta', text: 'x' },
      { type: 'message-done', finishReason: 'stop', usage: { promptTokens: 10, completionTokens: 3 } },
    ]);
    const r = await runTurn(p, params(), {});
    expect(r.usage).toEqual({ promptTokens: 10, completionTokens: 3 });
  });

  it('abort() 调用底层 cancel，且 Promise 仍 resolve（补发 message-done 不变量）', async () => {
    const cancel = vi.fn();
    let emit: ((e: StreamEvent) => void) | null = null;
    const p: Provider = {
      streamChat(_params, onEvent) {
        emit = onEvent;
        // 先发一点文本，不发 message-done，等 abort
        queueMicrotask(() => onEvent({ type: 'text-delta', text: '部分' }));
        return { cancel };
      },
    };
    const handle = runTurn(p, params(), {});
    await Promise.resolve(); // 让首个 microtask 跑完
    handle.abort();
    expect(cancel).toHaveBeenCalledOnce();
    // 模拟 provider 在 abort 后仍补发 message-done（Phase 1 不变量）
    emit!({ type: 'message-done', finishReason: undefined });
    const r = await handle;
    expect(r.text).toBe('部分');
  });
});
