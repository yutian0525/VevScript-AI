// background/agent-tail.ts
// 「流式尾巴」：per-conv 记录尚未落库的增量（当前轮 assistant 的 reasoning/text + 压缩态）。
//
// 为什么需要：面板会在切标签/切视图时被销毁重建，重建后从 storage 读历史，
// 但当前轮正在流式生成的那段文本还没写进 storage（loop 是整轮结束才 appendMessage）。
// 若不补发，切回来就会丢掉这段正在输出的内容，直到下一轮才恢复。
//
// 落库边界（对齐 agent/loop.ts 的 await 顺序）：
//   - tool-start 之前一定已 appendMessage(assistant)  → 收到 tool-start 即清空文本尾巴
//   - done 之前一定已 appendMessage(assistant)        → 清空
//   - paused / error 收尾                              → 清空
//   - usage 在 appendMessage 之前发出                  → 不清空
// 工具卡片不入尾巴：storage 里 assistant.toolCalls 已含调用信息，
// 面板 loadFromStorage 把「无结果」的调用渲染成 running，tool-end 到达后按 callId 更新。
import type { AgentEvent } from '../shared/messages';

export interface AgentTail {
  reasoning: string;
  text: string;
  compacting: boolean;
}

export function emptyTail(): AgentTail {
  return { reasoning: '', text: '', compacting: false };
}

/** 按事件推进尾巴状态（纯函数，返回新对象）。 */
export function reduceTail(tail: AgentTail, e: AgentEvent): AgentTail {
  switch (e.type) {
    case 'reasoning-delta':
      return { ...tail, reasoning: tail.reasoning + e.text };
    case 'text-delta':
      return { ...tail, text: tail.text + e.text };
    case 'compact-start':
      return { ...tail, compacting: true };
    case 'compact-done':
      return { ...tail, compacting: false };
    case 'tool-start':
    case 'done':
    case 'paused':
    case 'error':
      // 已落库或已收尾：文本尾巴作废（compacting 一并归位，压缩不会跨越这些边界）
      return emptyTail();
    default:
      return tail;
  }
}

/** 把尾巴还原成一串事件，供重新附着的面板按正常路径 applyEvent。
 *  顺序 reasoning → text 与流式一致：先建思考块，正文增量再把它收起。 */
export function replayTail(tail: AgentTail): AgentEvent[] {
  const out: AgentEvent[] = [];
  if (tail.reasoning) out.push({ type: 'reasoning-delta', text: tail.reasoning });
  if (tail.text) out.push({ type: 'text-delta', text: tail.text });
  if (tail.compacting) out.push({ type: 'compact-start' });
  return out;
}
