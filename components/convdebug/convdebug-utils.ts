// components/convdebug/convdebug-utils.ts
// 会话调试页的纯投影函数（无 React 依赖，可单测）。
import type { ChatMessage, ContentPart } from '../../agent/provider/types';
import type { Conversation } from '../../storage/conversations';
import type { ConvTraceStore, TurnOutcome } from '../../storage/traces';

/** trace 是否已被环形裁剪（累计轮数 > 现存轮数）。 */
export function isTrimmed(store: ConvTraceStore): boolean {
  return store.seq > store.turns.length;
}

/** 现存最早轮次序号；空 store 返回 0。 */
export function firstKeptTurn(store: ConvTraceStore): number {
  return store.turns[0]?.turn ?? 0;
}

/** getConversation 对未知 id 返回 createdAt=0 的空壳（conversations.ts 的 EPOCH 哨兵）。 */
export function isMissingConversation(conv: Conversation): boolean {
  return conv.createdAt === 0;
}

/** 毫秒 → 人读耗时。>=1000 用秒一位小数，否则毫秒整数。 */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

/** 1000 以下原样；以上保留一位小数的 k。 */
export function compactNumber(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** token 变化：`1.2k→340`；缺 prompt 端退化为 '—'，缺 completion 端只显示单值。 */
export function formatTokens(promptTokens?: number, completionTokens?: number): string {
  if (promptTokens == null) return '—';
  const p = compactNumber(promptTokens);
  return completionTokens == null ? p : `${p}→${compactNumber(completionTokens)}`;
}

/** 字符体积。 */
export function formatChars(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k 字` : `${n} 字`;
}

/** 相对时间：<60s「刚刚」，<60m「N 分钟前」，<24h「N 小时前」，否则本地日期。 */
export function formatRelativeTime(ts: number, now = Date.now()): string {
  const diff = now - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return new Date(ts).toLocaleDateString();
}

/** outcome → styles.css 里的修饰类名。 */
export function outcomeClass(o: TurnOutcome): string {
  return `convdebug-turn--${o}`;
}

/** 原始消息流的一行视图模型。 */
export interface MessageRow {
  key: string;
  role: ChatMessage['role'];
  text: string;
  reasoning?: string;
  toolCalls?: Array<{ name: string; args: string }>;
  name?: string;
}

/** ChatMessage[] → 可渲染行（图片 part 折叠为占位文本，避免把 base64 渲进 DOM）。 */
export function toMessageRows(messages: ChatMessage[]): MessageRow[] {
  return messages.map((m, i) => ({
    key: `${i}-${m.role}`,
    role: m.role,
    text: typeof m.content === 'string' ? m.content : contentPartsToText(m.content),
    ...(m.reasoning ? { reasoning: m.reasoning } : {}),
    ...(m.toolCalls ? { toolCalls: m.toolCalls.map((tc) => ({ name: tc.name, args: tc.arguments })) } : {}),
    ...(m.name ? { name: m.name } : {}),
  }));
}

function contentPartsToText(parts: ContentPart[]): string {
  return parts
    .map((p) => (p.type === 'text' ? p.text : `[图片 ${p.imageUrl.length} 字符]`))
    .join('\n');
}
