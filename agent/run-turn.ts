// agent/run-turn.ts
// Provider 回调 → Promise 的单轮适配（设计 §3）。
// Phase 1 不变量：streamChat 恰好以一个 message-done 终止，故此 Promise 必 resolve。
import type { Provider, ChatParams, StreamEvent, ToolCall, Usage } from './provider/types';

export interface TurnResult {
  text: string;
  toolCalls: ToolCall[];
  finishReason?: string;
  usage?: Usage;
  error?: string;
}

export interface RunTurnHooks {
  onTextDelta?: (text: string) => void;
}

export interface RunTurnHandle extends Promise<TurnResult> {
  abort: () => void;
}

export function runTurn(provider: Provider, params: ChatParams, hooks: RunTurnHooks): RunTurnHandle {
  let cancel = () => {};
  let text = '';
  let error: string | undefined;
  const agg = new Map<number, { id?: string; name?: string; args: string }>();

  const promise = new Promise<TurnResult>((resolve) => {
    let settled = false;
    const settle = (r: TurnResult) => { if (!settled) { settled = true; resolve(r); } };

    const handle = provider.streamChat(params, (e: StreamEvent) => {
      switch (e.type) {
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
          const toolCalls: ToolCall[] = [...agg.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([, v]) => ({ id: v.id ?? '', name: v.name ?? '', arguments: v.args }));
          settle({ text, toolCalls, finishReason: e.finishReason, usage: e.usage, error });
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
