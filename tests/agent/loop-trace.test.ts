// tests/agent/loop-trace.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { runAgentLoop, type LoopDeps } from '../../agent/loop';
import { readTraces } from '../../storage/traces';
import type { Provider, StreamEvent, ChatParams } from '../../agent/provider/types';
import type { ToolResult } from '../../shared/types';

function queuedProvider(scripts: StreamEvent[][]): Provider {
  let i = 0;
  return {
    streamChat(_p: ChatParams, onEvent: (e: StreamEvent) => void) {
      const script = scripts[i++] ?? [{ type: 'message-done', finishReason: 'stop' }];
      queueMicrotask(() => { for (const e of script) onEvent(e); });
      return { cancel: vi.fn() };
    },
  };
}

const deps = (provider: Provider, exec: LoopDeps['executeTool'], extra?: Partial<LoopDeps>): LoopDeps => ({
  provider,
  executeTool: exec,
  getPageInfo: async () => ({ url: 'https://x.com', title: 'X' }),
  emit: vi.fn(),
  ...extra,
});

describe('agent loop trace', () => {
  beforeEach(() => fakeBrowser.reset());

  it('自然终止的一轮落一条 trace，outcome=done', async () => {
    const provider = queuedProvider([[
      { type: 'text-delta', text: '完成了' },
      { type: 'message-done', finishReason: 'stop' },
    ]]);
    const exec = vi.fn<LoopDeps['executeTool']>();
    await runAgentLoop({ convId: 't1', tabId: 7, userMessage: '你好' }, deps(provider, exec));

    const { seq, turns } = await readTraces('t1');
    expect(seq).toBe(1);
    expect(turns).toHaveLength(1);
    const t = turns[0]!;
    expect(t.turn).toBe(1);
    expect(t.outcome).toBe('done');
    expect(t.tabId).toBe(7);
    expect(t.mode).toBe('agent');
    expect(t.llm.finishReason).toBe('stop');
    expect(t.llm.textChars).toBe(3);
    expect(t.llm.ms).toBeGreaterThanOrEqual(0);
    expect(t.context.pageUrl).toBe('https://x.com');
    expect(t.context.systemPromptChars).toBeGreaterThan(0);
    expect(t.tools).toEqual([]);
    expect(t.endedAt).toBeGreaterThanOrEqual(t.startedAt);
  });

  it('工具轮 outcome=continue，工具记录与 callId 对齐，下一轮是新 recorder', async () => {
    const provider = queuedProvider([
      [
        { type: 'tool-call-delta', index: 0, id: 'call_a', name: 'click', argsDelta: '{"uid":1}' },
        { type: 'message-done', finishReason: 'tool_calls' },
      ],
      [{ type: 'text-delta', text: '好了' }, { type: 'message-done', finishReason: 'stop' }],
    ]);
    const exec = vi.fn<LoopDeps['executeTool']>().mockResolvedValue({ ok: true, data: { clicked: true } } as ToolResult);
    await runAgentLoop({ convId: 't2', tabId: 1, userMessage: '点一下' }, deps(provider, exec));

    const { seq, turns } = await readTraces('t2');
    expect(seq).toBe(2);
    expect(turns).toHaveLength(2);

    const first = turns[0]!;
    expect(first.outcome).toBe('continue');
    expect(first.tools).toHaveLength(1);
    expect(first.tools[0]!.name).toBe('click');
    expect(first.tools[0]!.callId).toBe('call_a');
    expect(first.tools[0]!.argsBytes).toBe('{"uid":1}'.length);
    expect(first.tools[0]!.ok).toBe(true);
    expect(first.tools[0]!.summary).toBe('成功');
    expect(first.tools[0]!.ms).toBeGreaterThanOrEqual(0);

    expect(turns[1]!.turn).toBe(2);
    expect(turns[1]!.outcome).toBe('done');
  });

  it('轮首 abort → outcome=aborted', async () => {
    const provider = queuedProvider([[]]);
    const ac = new AbortController();
    ac.abort();
    await runAgentLoop({ convId: 't3', tabId: 1, userMessage: 'x' }, deps(provider, vi.fn()), ac.signal);
    const { turns } = await readTraces('t3');
    expect(turns).toHaveLength(1);
    expect(turns[0]!.outcome).toBe('aborted');
    // 早退轮在 setMode 之前就返回，不存在「实际生效的模式」——宁缺勿伪造
    expect(turns[0]!.mode).toBeUndefined();
  });

  it('工具失败记 error 字段，summary 为错误文本', async () => {
    const provider = queuedProvider([
      [
        { type: 'tool-call-delta', index: 0, id: 'call_f', name: 'click', argsDelta: '{}' },
        { type: 'message-done', finishReason: 'tool_calls' },
      ],
      [{ type: 'text-delta', text: '算了' }, { type: 'message-done', finishReason: 'stop' }],
    ]);
    const exec = vi.fn<LoopDeps['executeTool']>().mockResolvedValue({ ok: false, error: '元素不存在' } as ToolResult);
    await runAgentLoop({ convId: 't4', tabId: 1, userMessage: 'x' }, deps(provider, exec));
    const t = (await readTraces('t4')).turns[0]!;
    expect(t.tools[0]!.ok).toBe(false);
    expect(t.tools[0]!.error).toBe('元素不存在');
    expect(t.tools[0]!.summary).toBe('元素不存在');
  });

  it('打转熔断 → 该轮 outcome=paused 且带 guardReason', async () => {
    const turn = (): StreamEvent[] => [
      { type: 'tool-call-delta', index: 0, id: `c${Math.random()}`, name: 'scroll', argsDelta: '{"direction":"down"}' },
      { type: 'message-done', finishReason: 'tool_calls' },
    ];
    const provider = queuedProvider([turn(), turn(), turn(), turn(), turn()]);
    const exec = vi.fn<LoopDeps['executeTool']>().mockResolvedValue({ ok: true } as ToolResult);
    await runAgentLoop({ convId: 't5', tabId: 1, userMessage: 'x' }, deps(provider, exec));

    const { turns } = await readTraces('t5');
    expect(turns).toHaveLength(3);              // repeatThreshold=3
    expect(turns[0]!.outcome).toBe('continue');
    expect(turns[2]!.outcome).toBe('paused');
    expect(turns[2]!.guardReason).toContain('重复调用同一工具');
  });

  it('截断重试 → 前几轮 truncated-retry，熔断那轮 paused', async () => {
    // argsDelta 每轮必须不同：signature() 只取 name+arguments，若各轮相同会先撞「打转」
    // 熔断（repeatThreshold=3 且优先判定），到不了第 5 轮的「连续失败」。
    const turn = (): StreamEvent[] => [
      { type: 'tool-call-delta', index: 0, id: `c${Math.random()}`, name: 'click', argsDelta: `{"uid":${Math.random()}}` },
      { type: 'message-done', finishReason: 'length' },
    ];
    const provider = queuedProvider(Array.from({ length: 20 }, () => turn()));
    const exec = vi.fn<LoopDeps['executeTool']>();
    await runAgentLoop({ convId: 't6', tabId: 1, userMessage: 'x' }, deps(provider, exec));

    const { turns } = await readTraces('t6');
    expect(turns).toHaveLength(5);              // errorThreshold=5
    expect(turns.slice(0, 4).map((t) => t.outcome)).toEqual([
      'truncated-retry', 'truncated-retry', 'truncated-retry', 'truncated-retry',
    ]);
    expect(turns[4]!.outcome).toBe('paused');
    expect(turns[4]!.guardReason).toContain('全部失败');
    expect(exec).not.toHaveBeenCalled();
  });

  it('usage 落进 llm.usage', async () => {
    const provider: Provider = {
      streamChat(_p, onEvent) {
        queueMicrotask(() => {
          onEvent({ type: 'text-delta', text: 'ok' });
          onEvent({ type: 'message-done', finishReason: 'stop', usage: { promptTokens: 1234, completionTokens: 56 } });
        });
        return { cancel: vi.fn() };
      },
    };
    await runAgentLoop({ convId: 't7', tabId: 1, userMessage: 'x' }, deps(provider, vi.fn()));
    const t = (await readTraces('t7')).turns[0]!;
    expect(t.llm.usage).toEqual({ promptTokens: 1234, completionTokens: 56 });
  });

  it('触发自动压缩 → compact 字段有记录', async () => {
    // 第 1 轮必须带工具调用，否则 loop 在第 1 轮就 done 返回，走不到第 2 轮开头的压缩判定
    const provider = queuedProvider([
      [
        { type: 'tool-call-delta', index: 0, id: 'c1', name: 'click', argsDelta: '{}' },
        { type: 'message-done', finishReason: 'tool_calls', usage: { promptTokens: 9000, completionTokens: 10 } },
      ],
      [{ type: 'text-delta', text: 'b' }, { type: 'message-done', finishReason: 'stop' }],
    ]);
    const compact = vi.fn().mockResolvedValue({ ok: true, newPromptTokens: 400 });
    const exec = vi.fn<LoopDeps['executeTool']>().mockResolvedValue({ ok: true } as ToolResult);
    // 第 2 轮开头：promptTokens=9000 / window=10000 → 0.9 ≥ COMPACT_THRESHOLD(0.8) 触发
    await runAgentLoop({ convId: 't8', tabId: 1, userMessage: 'x' },
      deps(provider, exec, { getContextWindow: async () => 10000, compact }));

    expect(compact).toHaveBeenCalledTimes(1);
    const { turns } = await readTraces('t8');
    expect(turns[0]!.compact).toBeUndefined();
    expect(turns[1]!.compact).toEqual({ ms: expect.any(Number), ok: true, newPromptTokens: 400 });
  });

  it('provider error 出口 → outcome=error', async () => {
    const provider = queuedProvider([[
      { type: 'error', error: '炸了' },
      { type: 'message-done' },
    ]]);
    await runAgentLoop({ convId: 't9', tabId: 1, userMessage: 'x' }, deps(provider, vi.fn()));
    const t = (await readTraces('t9')).turns[0]!;
    expect(t.outcome).toBe('error');
    expect(t.llm.error).toBe('炸了');
  });

  it('压缩执行期间 abort（压缩后、runTurn 前）→ outcome=aborted', async () => {
    const ac = new AbortController();
    const provider = queuedProvider([
      [
        { type: 'tool-call-delta', index: 0, id: 'c1', name: 'click', argsDelta: '{}' },
        { type: 'message-done', finishReason: 'tool_calls', usage: { promptTokens: 9000, completionTokens: 10 } },
      ],
      [{ type: 'text-delta', text: 'b' }, { type: 'message-done', finishReason: 'stop' }],
    ]);
    const compact = vi.fn().mockImplementation(async () => {
      // 压缩执行期间 abort → 命中「压缩后再检查」出口（#2）
      ac.abort();
      return { ok: true, newPromptTokens: 400 };
    });
    const exec = vi.fn<LoopDeps['executeTool']>().mockResolvedValue({ ok: true } as ToolResult);
    await runAgentLoop({ convId: 't10', tabId: 1, userMessage: 'x' },
      deps(provider, exec, { getContextWindow: async () => 10000, compact }), ac.signal);

    const { turns } = await readTraces('t10');
    expect(turns).toHaveLength(2);
    expect(turns[0]!.outcome).toBe('continue');
    expect(turns[1]!.outcome).toBe('aborted');
    // 压缩后早退同样发生在 setMode 之前，mode 不落伪造值
    expect(turns[1]!.mode).toBeUndefined();
    // abort 省下了那次 API 调用：turn 2 未进 runTurn，llm 停留 recorder 默认值
    expect(turns[1]!.llm.finishReason).toBe('');
  });

  it('runTurn 返回后 abort（半截 assistant 已保留）→ outcome=aborted', async () => {
    const ac = new AbortController();
    const provider: Provider = {
      streamChat(_p, onEvent) {
        queueMicrotask(() => {
          onEvent({ type: 'text-delta', text: '我正在处理' });
          ac.abort();
          onEvent({ type: 'tool-call-delta', index: 0, id: 'c1', name: 'click', argsDelta: '{"uid":1}' });
          onEvent({ type: 'message-done', finishReason: 'tool_calls' });
        });
        return { cancel: vi.fn() };
      },
    };
    const exec = vi.fn<LoopDeps['executeTool']>();
    await runAgentLoop({ convId: 't11', tabId: 1, userMessage: 'x' }, deps(provider, exec), ac.signal);
    const t = (await readTraces('t11')).turns[0]!;
    expect(t.outcome).toBe('aborted');
    expect(exec).not.toHaveBeenCalled();
    expect(t.llm.textChars).toBe('我正在处理'.length);
  });

  it('工具循环内两工具之间 abort → outcome=aborted', async () => {
    const ac = new AbortController();
    const provider = queuedProvider([[
      { type: 'tool-call-delta', index: 0, id: 'c1', name: 'click', argsDelta: '{"uid":1}' },
      { type: 'tool-call-delta', index: 1, id: 'c2', name: 'click', argsDelta: '{"uid":2}' },
      { type: 'message-done', finishReason: 'tool_calls' },
    ]]);
    let n = 0;
    const exec = vi.fn<LoopDeps['executeTool']>().mockImplementation(async () => {
      n += 1;
      if (n === 1) ac.abort(); // 第一个工具执行后 abort → 命中第二个迭代开头的检查（出口 #7）
      return { ok: true } as ToolResult;
    });
    await runAgentLoop({ convId: 't12', tabId: 1, userMessage: 'x' }, deps(provider, exec), ac.signal);
    const t = (await readTraces('t12')).turns[0]!;
    expect(t.outcome).toBe('aborted');
    expect(t.tools).toHaveLength(1); // 第二个工具没执行，markTool 只有一条
  });

  it('firstTokenMs 落盘：text-delta 先到 hook 也计入 TTFT', async () => {
    const provider = queuedProvider([[
      { type: 'text-delta', text: '正文先到' },
      { type: 'message-done', finishReason: 'stop' },
    ]]);
    await runAgentLoop({ convId: 't13', tabId: 1, userMessage: 'x' }, deps(provider, vi.fn()));
    const t = (await readTraces('t13')).turns[0]!;
    expect(typeof t.llm.firstTokenMs).toBe('number');
    expect(t.llm.firstTokenMs!).toBeGreaterThanOrEqual(0);
  });
});
