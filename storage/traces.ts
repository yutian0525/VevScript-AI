// storage/traces.ts
// agent loop 轮次 trace 持久化（spec §4）。key = local:conv:{id}:trace。
// 与 messages 分开存：trace 每轮写一次，共用 key 会把写放大到整个消息数组。
import { storage } from 'wxt/utils/storage';
import type { AgentMode } from '../agent/mode';

/** 保留轮数上限，与 conversations 的 MAX_MESSAGES 对齐。 */
export const MAX_TURNS = 200;

/** buildContext 的组装摘要——刻意不存 prompt 全文（无 unlimitedStorage，quota 即 10MB）。 */
export interface TurnContextSummary {
  messageCount: number;
  chars: number;
  hasSummary: boolean;
  summaryChars: number;
  skillCount: number;
  systemPromptChars: number;
  pageUrl: string;
}

export interface TurnLlmRecord {
  ms: number;
  firstTokenMs?: number;
  finishReason: string;
  usage?: { promptTokens?: number; completionTokens?: number };
  textChars: number;
  reasoningChars: number;
  error?: string;
}

export interface TurnToolRecord {
  name: string;
  callId: string;
  argsBytes: number;
  ms: number;
  ok: boolean;
  error?: string;
  summary: string;
}

/** 轮次结束方式。'continue' = 工具跑完、循环回下一轮（最常见的非终态）。 */
export type TurnOutcome = 'continue' | 'done' | 'paused' | 'aborted' | 'error' | 'truncated-retry';

export interface TurnTrace {
  /** 会话内单调递增，从 1 起（seq 记账，环形裁剪后仍连续） */
  turn: number;
  startedAt: number;
  endedAt: number;
  /** 本轮起点的操作目标 tab */
  tabId: number;
  /** 本轮实际生效的模式（每轮重读后的值）；重读之前退出的轮次无此项（早退轮不存在「实际生效的模式」，宁缺勿伪造） */
  mode?: AgentMode;
  context: TurnContextSummary;
  llm: TurnLlmRecord;
  /** 本轮开跑前的自动压缩（若触发） */
  compact?: { ms: number; ok: boolean; newPromptTokens?: number };
  tools: TurnToolRecord[];
  outcome: TurnOutcome;
  /** 熔断停止时的原因（checkGuards 的 verdict.reason） */
  guardReason?: string;
}

export interface ConvTraceStore {
  /** 会话内累计轮数，不随环形裁剪回退 */
  seq: number;
  /** 最近 MAX_TURNS 轮，最旧在前 */
  turns: TurnTrace[];
}

/** 导出给 conv-debug 页复用：UI 的 storage.watch 必须与这里写盘用同一个 key，否则自动跟随静默失效。 */
export const traceKey = (id: string) => `local:conv:${id}:trace` as const;

export async function readTraces(convId: string): Promise<ConvTraceStore> {
  const raw = await storage.getItem<ConvTraceStore>(traceKey(convId));
  return raw ?? { seq: 0, turns: [] };
}

/** 追加一轮 trace：seq 自增、超 MAX_TURNS 裁掉最旧。 */
export async function appendTurnTrace(convId: string, t: TurnTrace): Promise<void> {
  const cur = await readTraces(convId);
  const turns = [...cur.turns, t];
  const trimmed = turns.length > MAX_TURNS ? turns.slice(turns.length - MAX_TURNS) : turns;
  await storage.setItem(traceKey(convId), { seq: cur.seq + 1, turns: trimmed });
}

export async function clearTraces(convId: string): Promise<void> {
  await storage.removeItem(traceKey(convId));
}
