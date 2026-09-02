// agent/run-turn.ts
// Provider 回调 → Promise 的单轮适配（设计 §3）。
// Phase 1 不变量：streamChat 恰好以一个 message-done 终止，故此 Promise 必 resolve。
import type { Provider, ChatParams, StreamEvent, ToolCall, Usage } from './provider/types';

export interface TurnResult {
  text: string;
  reasoning?: string;
  toolCalls: ToolCall[];
  finishReason?: string;
  usage?: Usage;
  error?: string;
}

export interface RunTurnHooks {
  onTextDelta?: (text: string) => void;
  onReasoningDelta?: (text: string) => void;
}

export interface RunTurnHandle extends Promise<TurnResult> {
  abort: () => void;
}

export function runTurn(provider: Provider, params: ChatParams, hooks: RunTurnHooks): RunTurnHandle {
  let cancel = () => {};
  let text = '';
  let reasoning = '';
  let error: string | undefined;
  const agg = new Map<number, { id?: string; name?: string; args: string }>();

  const promise = new Promise<TurnResult>((resolve) => {
    let settled = false;
    const settle = (r: TurnResult) => { if (!settled) { settled = true; resolve(r); } };

    const handle = provider.streamChat(params, (e: StreamEvent) => {
      switch (e.type) {
        case 'reasoning-delta':
          reasoning += e.text;
          // 消费者回调异常不应打断流处理（否则会被上游误标为流错误并丢后续增量）
          try { hooks.onReasoningDelta?.(e.text); } catch { /* 忽略消费者回调异常 */ }
          break;
        case 'text-delta':
          text += e.text;
          // 消费者回调异常不应打断流处理（否则会被上游误标为流错误并丢后续增量）
          try { hooks.onTextDelta?.(e.text); } catch { /* 忽略消费者回调异常 */ }
          break;
        case 'tool-call-delta': {
          const cur = agg.get(e.index) ?? { args: '' };
          if (e.id) cur.id = e.id;
          if (e.name) cur.name = e.name;
          if (e.argsDelta) cur.args += e.argsDelta;
          agg.set(e.index, cur);
          break;
        }
        case 'error':
          error = e.error;
          break;
        case 'message-done': {
          // 按 index 排序后映射；再按非空 id 去重——某些中转站会把同一个 tool_call
          // 以不同 index、相同 id 重复返回，若不去重 loop 会对同一动作 executeTool 两次
          // （双导航/双点击）+ UI 出现"一张 done 一张永远 running"的双卡片。
          // OpenAI 规范中 tool_call.id 唯一，故按 id 去重无条件正确；id 为空的不去重（无从判定）。
          const seen = new Set<string>();
          const toolCalls: ToolCall[] = [];
          for (const [, v] of [...agg.entries()].sort((a, b) => a[0] - b[0])) {
            const call: ToolCall = { id: v.id ?? '', name: v.name ?? '', arguments: v.args };
            if (call.id && seen.has(call.id)) continue;
            if (call.id) seen.add(call.id);
            toolCalls.push(call);
          }
          settle({ text, reasoning: reasoning || undefined, toolCalls, finishReason: e.finishReason, usage: e.usage, error });
          break;
        }
      }
    });
    cancel = handle.cancel;
  });

  const handle = promise as RunTurnHandle;
  handle.abort = () => cancel();
  return handle;
}
