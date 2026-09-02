// agent/loop-guards.ts
// 熔断阀（设计 §2.1）：替代硬上限。纯函数，判定是否暂停。
import type { ToolCall } from './provider/types';
import type { ToolResult } from '../shared/types';

// 设计取向：不设"最大步数上限"、也不设"token 软预算"——正经 agent harness（如 pi）都不靠
// 数步数/数 token 兜底，主退出是自然终止（模型不再调工具）+ 用户中断（见 agent:stop）。
// 这里只保留"故障检测"类熔断阀：打转（原地重复）、连续错误（每步都失败）——检测的是
// 模型真的卡住/失灵，而非正常的长任务。均为"暂停问用户"而非硬杀。
export interface GuardConfig {
  repeatThreshold: number;   // 连续同工具同参数次数（打转检测）
  errorThreshold: number;    // 连续全失败轮数（故障检测）
}

export const DEFAULT_GUARD_CONFIG: GuardConfig = {
  repeatThreshold: 3,
  errorThreshold: 5,
};

export interface GuardState {
  lastSignature?: string;
  repeatCount: number;
  consecutiveErrors: number;
}

export function initGuardState(): GuardState {
  return { repeatCount: 1, consecutiveErrors: 0 };
}

function signature(calls: ToolCall[]): string {
  return calls.map((c) => `${c.name}:${c.arguments}`).sort().join('|');
}

/** 记录一轮工具执行结果，返回新状态（不可变）。 */
export function recordTurn(state: GuardState, calls: ToolCall[], results: ToolResult[]): GuardState {
  const sig = signature(calls);
  const repeatCount = sig === state.lastSignature ? state.repeatCount + 1 : 1;
  const allFailed = results.length > 0 && results.every((r) => !r.ok);
  const consecutiveErrors = allFailed ? state.consecutiveErrors + 1 : 0;
  return { lastSignature: sig, repeatCount, consecutiveErrors };
}

export interface GuardVerdict { stop: boolean; reason?: string }

export function checkGuards(state: GuardState, cfg: GuardConfig): GuardVerdict {
  if (state.repeatCount >= cfg.repeatThreshold) {
    return { stop: true, reason: `连续 ${state.repeatCount} 次重复调用同一工具，可能卡住` };
  }
  if (state.consecutiveErrors >= cfg.errorThreshold) {
    return { stop: true, reason: `连续 ${state.consecutiveErrors} 轮工具全部失败` };
  }
  return { stop: false };
}
