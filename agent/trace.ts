// agent/trace.ts
// loop 轮次 trace 采集（spec §5）。本模块是 storage 与 loop 之间的唯一接缝：
// loop 只调语义方法（markLlm/markTool/...），storage 细节封在这里。
import type { ChatMessage } from './provider/types';
import type { SkillBrief } from './context';
import type { TurnContextSummary } from '../storage/traces';

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
