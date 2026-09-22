// agent/trace.ts
// loop 轮次 trace 采集（spec §5）。本模块是 storage 与 loop 之间的唯一接缝：
// loop 只调语义方法（markLlm/markTool/...），storage 细节封在这里。
import type { ChatMessage } from './provider/types';
import type { SkillBrief } from './context';
import type { TurnResult } from './run-turn';
import type { AgentMode } from './mode';
import type { TurnContextSummary, TurnToolRecord, TurnTrace } from '../storage/traces';
import { appendTurnTrace } from '../storage/traces';

/** 统计消息数组的字符体积（content + toolCalls + reasoning）。 */
export function measureMessages(messages: ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') {
      chars += m.content.length;
    } else {
      for (const p of m.content) {
        chars += p.type === 'text' ? p.text.length : p.imageUrl.length;
      }
    }
    if (m.reasoning) chars += m.reasoning.length;
    if (m.toolCalls) chars += JSON.stringify(m.toolCalls).length;
  }
  return chars;
}

/** buildContext 输出的组装摘要。system 长度取 messages[0]——那是真正发出去的正文，
 *  比 getSystemPrompt() 的返回值更诚实（后者缺省时用的是内置提示词）。 */
export function summarizeContext(
  messages: ChatMessage[],
  opts: { summary?: { text: string; coversUpTo: number }; skills?: SkillBrief[]; pageUrl: string },
): TurnContextSummary {
  const head = messages[0];
  const systemChars = head && head.role === 'system' && typeof head.content === 'string'
    ? head.content.length
    : 0;
  return {
    messageCount: messages.length,
    chars: measureMessages(messages),
    hasSummary: opts.summary != null,
    summaryChars: opts.summary?.text.length ?? 0,
    skillCount: opts.skills?.length ?? 0,
    systemPromptChars: systemChars,
    pageUrl: opts.pageUrl,
  };
}

export interface TurnRecorder {
  /** 可变轮次记录：loop 直接写 rec.outcome / rec.guardReason。 */
  rec: TurnTrace;
  /** 模式在轮体中部才重读出来，晚于 recorder 创建；早退轮没走到这一步，mode 保持缺省。 */
  setMode(mode: AgentMode): void;
  markContext(
    messages: ChatMessage[],
    opts: { summary?: { text: string; coversUpTo: number }; skills?: SkillBrief[]; pageUrl: string },
  ): void;
  markLlm(args: { startedAt: number; firstTokenAt?: number; result: TurnResult }): void;
  markTool(t: TurnToolRecord): void;
  markCompact(c: { ms: number; ok: boolean; newPromptTokens?: number }): void;
  commit(): Promise<void>;
}

export function createTurnRecorder(init: { convId: string; turn: number; tabId: number }): TurnRecorder {
  const now = Date.now();
  const rec: TurnTrace = {
    turn: init.turn,
    startedAt: now,
    endedAt: now,
    tabId: init.tabId,
    // mode 刻意不写初始值：轮首 abort 等早退轮在 setMode 之前就返回，根本不存在
    // 「实际生效的模式」——落伪造值（如 'agent'）会让 ask 会话展示出错误的 mode，
    // 调试工具展示假数据比缺数据更有害，故留空由 setMode() 填入。
    context: {
      messageCount: 0, chars: 0, hasSummary: false, summaryChars: 0,
      skillCount: 0, systemPromptChars: 0, pageUrl: '',
    },
    llm: { ms: 0, finishReason: '', textChars: 0, reasoningChars: 0 },
    tools: [],
    // 默认 'error' 是绊线：loop 的 9 处出口都必须显式赋值，漏设即暴露为错误而非伪装成 done
    outcome: 'error',
  };

  return {
    rec,
    setMode(mode) { rec.mode = mode; },
    markContext(messages, opts) { rec.context = summarizeContext(messages, opts); },
    markLlm({ startedAt, firstTokenAt, result }) {
      rec.llm = {
        ms: Date.now() - startedAt,
        ...(firstTokenAt != null ? { firstTokenMs: firstTokenAt - startedAt } : {}),
        finishReason: result.finishReason ?? '',
        ...(result.usage ? { usage: result.usage } : {}),
        textChars: result.text.length,
        reasoningChars: result.reasoning?.length ?? 0,
        ...(result.error ? { error: result.error } : {}),
      };
    },
    markTool(t) { rec.tools.push(t); },
    markCompact(c) { rec.compact = c; },
    async commit() {
      rec.endedAt = Date.now();
      // 调试设施不该有能力搞挂主流程：quota 打满就丢这一轮 trace
      await appendTurnTrace(init.convId, rec).catch(() => {});
    },
  };
}
