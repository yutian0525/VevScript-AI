// agent/compact.ts
// 上下文压缩：切段 + 增量摘要 + token 估算（设计 §4）。原始消息永不删除。
//
// 纯函数（splitForCompaction / estimateContextTokens）+ 主流程 compactConversation
// （调用 runTurn 生成摘要、读写 storage）。失败不改会话。
import type { ChatMessage, Provider } from './provider/types';
import { runTurn } from './run-turn';
import { getConversation, setSummary } from '../storage/conversations';

/** 保留最近 N 条原始消息不进摘要（近期上下文对连续操作最关键）。 */
export const KEEP_RECENT_ORIGINALS = 20;

export interface CompactSplit {
  segment: ChatMessage[];
  newCoversUpTo: number;
}

/**
 * 计算本轮要摘要的旧段与新边界。
 *
 * - covered = coversUpTo ?? -1（未摘要过时起点为 -1，slice(0, ...) 即从首条开始）。
 * - newCoversUpTo = max(covered, len - keepRecent - 1)：边界单调不倒退——
 *   若新算出的边界不大于已覆盖边界，说明没有比上次更新的可摘内容，返回 null。
 * - segment = messages.slice(covered+1, newCoversUpTo+1)：开区间 (covered, newCoversUpTo]。
 * - 空段（边界虽前进但 slice 结果为空）同样返回 null。
 */
export function splitForCompaction(
  messages: ChatMessage[],
  coversUpTo: number | undefined,
  keepRecent: number,
): CompactSplit | null {
  const covered = coversUpTo ?? -1;
  const newCoversUpTo = Math.max(covered, messages.length - keepRecent - 1);
  if (newCoversUpTo <= covered) return null;
  const segment = messages.slice(covered + 1, newCoversUpTo + 1);
  if (segment.length === 0) return null;
  return { segment, newCoversUpTo };
}

/** 取消息文本（parts 数组只计 text part，图片等不计入字符估算）。
 * 仅估 content 文本，toolCalls/reasoning 不计入——靠 estimateContextTokens 的 /2 保守系数吸收。 */
function msgText(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

/**
 * 压缩后主上下文的 token 粗估：（摘要 + 保留消息文本）字符数 / 2。
 * 中英混合下字符/ token 比取保守系数 2，宁可高估以触发更早的压缩。
 */
export function estimateContextTokens(keptMessages: ChatMessage[], summaryText: string): number {
  const chars = summaryText.length + keptMessages.reduce((a, m) => a + msgText(m.content).length, 0);
  return Math.ceil(chars / 2);
}

export interface CompactDeps { provider: Provider }
export interface CompactResult { ok: boolean; newPromptTokens?: number; error?: string }

const COMPACT_SYSTEM = `你是一个上下文压缩器。把给定的对话历史浓缩成简洁的中文「前情摘要」，供后续对话延续使用。
保留：任务目标、已完成的关键操作及其结果、重要发现/数据/URL、待办事项。
丢弃：冗余的工具原始输出、寒暄、重复内容。
直接输出摘要正文，不要加「以下是摘要」之类的前言。`;

/** 把一段消息序列化成可读文本（供摘要 LLM 阅读）。 */
function serializeSegment(messages: ChatMessage[]): string {
  return messages.map((m) => {
    const text = msgText(m.content);
    if (m.role === 'assistant' && m.toolCalls?.length) {
      const calls = m.toolCalls.map((tc) => `${tc.name}(${tc.arguments})`).join(', ');
      return `assistant: ${text}${text ? ' ' : ''}[调用工具: ${calls}]`;
    }
    if (m.role === 'tool') return `tool[${m.name ?? ''}]: ${text}`;
    return `${m.role}: ${text}`;
  }).join('\n');
}

/** 压缩会话：读→切段→（含旧摘要）调 LLM→写回摘要→估算新 token。失败不改会话。 */
export async function compactConversation(convId: string, deps: CompactDeps): Promise<CompactResult> {
  const conv = await getConversation(convId);
  const split = splitForCompaction(conv.messages, conv.summary?.coversUpTo, KEEP_RECENT_ORIGINALS);
  if (!split) return { ok: true }; // 无新可摘内容

  const priorBlock = conv.summary ? `已有前情摘要（请在此基础上增量合并）：\n${conv.summary.text}\n\n新增对话：\n` : '';
  const userContent = `${priorBlock}${serializeSegment(split.segment)}`;
  const messages: ChatMessage[] = [
    { role: 'system', content: COMPACT_SYSTEM },
    { role: 'user', content: userContent },
  ];

  const result = await runTurn(deps.provider, { messages, tools: [] }, {});
  if (result.error) return { ok: false, error: result.error };
  const text = result.text.trim();
  if (!text) return { ok: false, error: '摘要为空' };

  await setSummary(convId, { text, coversUpTo: split.newCoversUpTo });
  const kept = conv.messages.slice(split.newCoversUpTo + 1);
  return { ok: true, newPromptTokens: estimateContextTokens(kept, text) };
}
