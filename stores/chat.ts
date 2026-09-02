// stores/chat.ts
import { create } from 'zustand';
import type { PortMsgToPanel } from '../shared/messages';
import type { ChatMessage } from '../agent/provider/types';

export type ChatStatus = 'idle' | 'running' | 'paused';

export interface ChatItem {
  role: 'user' | 'assistant' | 'tool' | 'error';
  text?: string;
  reasoning?: string;        // 思考文本
  thinking?: boolean;        // 是否处于「思考中」（控制默认展开）
  expanded?: boolean;        // 用户手动展开/收起（思考块 & 工具卡片共用）
  name?: string; args?: string; callId?: string;
  status?: 'running' | 'done'; ok?: boolean; summary?: string;
  output?: string;           // 工具完整输出（供展开）
  image?: string;            // 截图缩略图 dataURL（take_screenshot）
  usage?: { prompt?: number; completion?: number }; // 该轮 token 用量（消息下方标注）
}

interface ChatState {
  messages: ChatItem[];
  status: ChatStatus;
  pauseReason?: string;
  promptTokens?: number;   // 当前会话最近一轮真实发出的 token（环形指示器分子）
  compacting: boolean;     // 是否正在压缩
  addUserMessage: (text: string) => void;
  applyEvent: (e: PortMsgToPanel) => void;
  setStatus: (s: ChatStatus) => void;
  toggleExpand: (index: number) => void;
  loadFromStorage: (messages: ChatMessage[]) => void;
  reset: () => void;
}

/** ChatMessage.content 可能是字符串或内容块数组，取其文本。 */
function contentText(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  return content.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('');
}

/** 收起仍在"思考中"的尾部助手项：进入工具调用或轮次结束时，思考阶段已结束。 */
function collapseTrailingThinking(messages: ChatItem[]): void {
  const last = messages[messages.length - 1];
  if (last?.role === 'assistant' && last.status == null && last.thinking) {
    messages[messages.length - 1] = { ...last, thinking: false };
  }
}

export const useChat = create<ChatState>((set) => ({
  messages: [],
  status: 'idle',
  compacting: false,
  addUserMessage: (text) => set((s) => ({ messages: [...s.messages, { role: 'user', text }], status: 'running' })),
  setStatus: (status) => set({ status }),
  toggleExpand: (index) => set((s) => {
    const messages = [...s.messages];
    const cur = messages[index];
    if (!cur) return {};
    messages[index] = { ...cur, expanded: !cur.expanded };
    return { messages };
  }),
  loadFromStorage: (stored) => set(() => {
    // callId → tool result（用于把 assistant.toolCalls 还原成工具卡片状态）
    const toolResults = new Map<string, { content: string }>();
    for (const m of stored) {
      if (m.role === 'tool' && m.toolCallId) toolResults.set(m.toolCallId, { content: contentText(m.content) });
    }
    const items: ChatItem[] = [];
    for (const m of stored) {
      if (m.role === 'user') {
        // 注入的截图消息（content 是数组且含 image_url part）：
        // 回挂到最近的 take_screenshot 工具卡片，不产生独立 user 气泡（消除重载幽灵气泡+丢图）
        if (Array.isArray(m.content)) {
          const imgPart = m.content.find((p) => p.type === 'image_url');
          if (imgPart && imgPart.type === 'image_url') {
            for (let i = items.length - 1; i >= 0; i--) {
              const it = items[i];
              if (it && it.role === 'tool' && it.name === 'take_screenshot' && !it.image) {
                it.image = imgPart.imageUrl;
                break;
              }
            }
            continue;
          }
        }
        items.push({ role: 'user', text: contentText(m.content) });
      } else if (m.role === 'assistant') {
        const text = contentText(m.content);
        // 历史思考块：thinking=false（默认收起，可点开）
        if (text || m.reasoning) {
          items.push({ role: 'assistant', text: text || undefined, reasoning: m.reasoning, thinking: false });
        }
        for (const tc of m.toolCalls ?? []) {
          const res = toolResults.get(tc.id);
          const output = res?.content;
          const ok = output != null ? !output.startsWith('错误：') : true;
          items.push({
            role: 'tool', name: tc.name, args: tc.arguments, callId: tc.id,
            status: 'done', ok, summary: ok ? '成功' : '失败', output,
          });
        }
      }
      // role==='tool' 已在 toolResults 里被 assistant 分支消费，不单独渲染
      // role==='system' 不持久化，天然不会出现
    }
    return { messages: items, status: 'idle', pauseReason: undefined };
  }),
  reset: () => set({ messages: [], status: 'idle', pauseReason: undefined, promptTokens: undefined, compacting: false }),
  applyEvent: (e) => set((s) => {
    const messages = [...s.messages];
    switch (e.type) {
      case 'reasoning-delta': {
        const last = messages[messages.length - 1];
        if (last?.role === 'assistant' && last.status == null && last.thinking) {
          messages[messages.length - 1] = { ...last, reasoning: (last.reasoning ?? '') + e.text };
        } else {
          messages.push({ role: 'assistant', reasoning: e.text, thinking: true });
        }
        return { messages };
      }
      case 'text-delta': {
        const last = messages[messages.length - 1];
        if (last?.role === 'assistant' && last.status == null) {
          // 首个正文增量：自动收起思考块（thinking→false）
          messages[messages.length - 1] = { ...last, text: (last.text ?? '') + e.text, thinking: false };
        } else {
          messages.push({ role: 'assistant', text: e.text });
        }
        return { messages };
      }
      case 'tool-start': {
        collapseTrailingThinking(messages);
        // 按 callId 幂等：重复的 tool-start（同 callId）不再新推卡片，避免"一张 done 一张永远 running"
        if (e.callId && messages.some((m) => m.role === 'tool' && m.callId === e.callId)) {
          return { messages };
        }
        messages.push({ role: 'tool', name: e.name, args: e.args, callId: e.callId, status: 'running' });
        return { messages };
      }
      case 'tool-end': {
        const idx = messages.findIndex((m) => m.role === 'tool' && m.callId === e.callId);
        if (idx >= 0) messages[idx] = { ...messages[idx]!, status: 'done', ok: e.ok, summary: e.summary, output: e.output, image: e.image };
        return { messages };
      }
      case 'state': return { status: e.status };
      case 'usage': {
        // 挂到最后一条 assistant 项（供消息下方标注）；同时更新环的分子
        const idx = [...messages].reverse().findIndex((m) => m.role === 'assistant');
        if (idx >= 0) {
          const real = messages.length - 1 - idx;
          messages[real] = { ...messages[real]!, usage: { prompt: e.promptTokens, completion: e.completionTokens } };
        }
        return { messages, promptTokens: e.promptTokens ?? s.promptTokens };
      }
      case 'compact-start':
        return { compacting: true };
      case 'compact-done':
        return { compacting: false, promptTokens: e.newPromptTokens ?? s.promptTokens };
      case 'paused':
        collapseTrailingThinking(messages);
        return { messages, status: 'paused', pauseReason: e.reason };
      case 'done':
        collapseTrailingThinking(messages);
        return { messages, status: 'idle' };
      case 'error':
        collapseTrailingThinking(messages);
        messages.push({ role: 'error', text: e.message });
        return { messages, status: 'idle' };
      default: return {};
    }
  }),
}));
