// agent/compact.ts
// 上下文压缩：切段 + 增量摘要 + token 估算（设计 §4）。原始消息永不删除。
//
// 本文件第一段只含无副作用的纯函数（splitForCompaction / estimateContextTokens）。
// 主流程 compactConversation（调用 runTurn 生成摘要、读写 storage）在 Task 7b 加入，
// 届时再 import runTurn / getConversation / setSummary / Provider。
import type { ChatMessage, ContentPart } from './provider/types';

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

/** 取消息文本（parts 数组只计 text part，图片等不计入字符估算）。 */
function msgText(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  return (content as ContentPart[])
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
