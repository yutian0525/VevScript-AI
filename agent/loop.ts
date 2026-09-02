// agent/loop.ts
// Agent 主循环状态机（设计 §2）：convId 存储 + tabId 操作目标 + usage 计量 + 自动压缩 + 熔断阀。
import type { Provider, ChatMessage, ToolCall, ContentPart } from './provider/types';
import type { ToolResult } from '../shared/types';
import type { PortMsgToPanel } from '../shared/messages';
import { runTurn } from './run-turn';
import { buildContext, type PageInfo } from './context';
import { getToolSchemas } from './tools/registry';
import { initGuardState, recordTurn, checkGuards, DEFAULT_GUARD_CONFIG, type GuardState } from './loop-guards';
import { getConversation, appendMessage, setStatus, setLastPromptTokens } from '../storage/conversations';
import { meterRatio, COMPACT_THRESHOLD } from './context-meter';

export interface LoopDeps {
  provider: Provider;
  executeTool: (name: string, args: Record<string, unknown>, tabId: number, signal: AbortSignal) => Promise<ToolResult>;
  getPageInfo: (tabId: number) => Promise<PageInfo>;
  emit: (msg: PortMsgToPanel) => void;
  resolveOpenedTab?: (toolName: string, openerTabId: number, signal: AbortSignal) => Promise<number | undefined>;
  /** 上下文窗口（token）。缺省则不做自动压缩（便于测试）。 */
  getContextWindow?: () => Promise<number>;
  /** 压缩当前会话。缺省则不做自动压缩（便于测试）。 */
  compact?: (convId: string) => Promise<{ ok: boolean; newPromptTokens?: number; error?: string }>;
}

const TAB_OPENING_TOOLS = new Set(['click', 'press_key']);

export interface LoopArgs {
  convId: string;
  tabId: number;
  userMessage: string;
}

export async function runAgentLoop(args: LoopArgs, deps: LoopDeps, signal?: AbortSignal): Promise<void> {
  await appendMessage(args.convId, { role: 'user', content: args.userMessage });
  await setStatus(args.convId, 'running');
  await drive(args.convId, args.tabId, deps, initGuardState(), signal ?? new AbortController().signal);
}

/** 从暂停状态恢复（不追加新 user 消息）。 */
export async function resumeAgentLoop(convId: string, tabId: number, deps: LoopDeps, signal?: AbortSignal): Promise<void> {
  await setStatus(convId, 'running');
  await drive(convId, tabId, deps, initGuardState(), signal ?? new AbortController().signal);
}

async function drive(convId: string, startTabId: number, deps: LoopDeps, guardState: GuardState, signal: AbortSignal): Promise<void> {
  let guard = guardState;
  let targetTab = startTabId;
  let lastPromptTokens: number | undefined;

  for (;;) {
    if (signal.aborted) return void (await finishAborted(convId, deps));

    // 自动压缩：上一轮 usage 达阈值 → 进下一轮前先摘要一次（不打断已完成的工具链）
    if (deps.compact && deps.getContextWindow && lastPromptTokens != null) {
      const window = await deps.getContextWindow();
      if (meterRatio(lastPromptTokens, window) >= COMPACT_THRESHOLD) {
        deps.emit({ type: 'compact-start' });
        const r = await deps.compact(convId).catch(() => ({ ok: false as const }));
        if (r.ok && r.newPromptTokens != null) {
          lastPromptTokens = r.newPromptTokens;
          await setLastPromptTokens(convId, r.newPromptTokens);
          deps.emit({ type: 'usage', promptTokens: r.newPromptTokens });
        }
        deps.emit({ type: 'compact-done', newPromptTokens: r.ok ? r.newPromptTokens : undefined });
      }
    }

    const conv = await getConversation(convId);
    const page = await deps.getPageInfo(targetTab).catch(() => ({ url: '', title: '' }));
    const messages = buildContext(conv.messages, page, 60, conv.summary);

    const result = await runTurn(deps.provider, { messages, tools: getToolSchemas(), signal }, {
      onTextDelta: (t) => deps.emit({ type: 'text-delta', text: t }),
      onReasoningDelta: (t) => deps.emit({ type: 'reasoning-delta', text: t }),
    });

    if (signal.aborted) {
      if (result.text || result.reasoning) {
        await appendMessage(convId, { role: 'assistant', content: result.text, reasoning: result.reasoning });
      }
      await finishAborted(convId, deps);
      return;
    }

    // usage 计量：无论 finishReason 都消费（供上下文标识 + 下一轮自动压缩判定）
    if (result.usage?.promptTokens != null) {
      lastPromptTokens = result.usage.promptTokens;
      await setLastPromptTokens(convId, result.usage.promptTokens);
      deps.emit({ type: 'usage', promptTokens: result.usage.promptTokens, completionTokens: result.usage.completionTokens });
    }

    if (result.error) {
      deps.emit({ type: 'error', message: result.error });
      await setStatus(convId, 'idle');
      return;
    }

    if (result.finishReason === 'length' && result.toolCalls.length > 0) {
      await appendMessage(convId, assistantMsg(result.text, result.toolCalls, result.reasoning));
      const truncFailed: ToolResult[] = [];
      for (const tc of result.toolCalls) {
        await appendMessage(convId, { role: 'tool', toolCallId: tc.id, name: tc.name, content: '错误：模型输出被截断，该工具调用参数不完整，请重新发起' });
        truncFailed.push({ ok: false, error: '模型输出被截断' });
      }
      guard = recordTurn(guard, result.toolCalls, truncFailed);
      const verdict = checkGuards(guard, DEFAULT_GUARD_CONFIG);
      if (verdict.stop) {
        await setStatus(convId, 'paused');
        deps.emit({ type: 'paused', reason: verdict.reason ?? '' });
        return;
      }
      continue;
    }

    if (result.toolCalls.length === 0) {
      const truncated = result.finishReason === 'length';
      const finalText = truncated
        ? `${result.text}\n\n[注意：回复因达到长度上限被截断，可能不完整]`
        : result.text;
      await appendMessage(convId, { role: 'assistant', content: finalText, reasoning: result.reasoning });
      deps.emit({ type: 'done', finalText });
      await setStatus(convId, 'idle');
      return;
    }

    await appendMessage(convId, assistantMsg(result.text, result.toolCalls, result.reasoning));
    const results: ToolResult[] = [];
    for (const tc of result.toolCalls) {
      if (signal.aborted) { await finishAborted(convId, deps); return; }
      let toolArgs: Record<string, unknown> = {};
      try { toolArgs = tc.arguments ? JSON.parse(tc.arguments) : {}; } catch { /* 保持空对象 */ }
      deps.emit({ type: 'tool-start', name: tc.name, args: tc.arguments, callId: tc.id });
      const r = await deps.executeTool(tc.name, toolArgs, targetTab, signal);
      results.push(r);

      if (r.ok && (tc.name === 'new_page' || tc.name === 'select_page')) {
        const d = r.data as { targetTab?: number } | undefined;
        if (typeof d?.targetTab === 'number') targetTab = d.targetTab;
      }
      if (r.ok && tc.name === 'close_page') {
        const d = r.data as { closed?: number } | undefined;
        if (d?.closed === targetTab) targetTab = startTabId;
      }
      if (r.ok && deps.resolveOpenedTab && TAB_OPENING_TOOLS.has(tc.name)) {
        const opened = await deps.resolveOpenedTab(tc.name, targetTab, signal);
        if (typeof opened === 'number') targetTab = opened;
      }

      if (tc.name === 'take_screenshot' && r.ok) {
        const shot = (r.data as { screenshot?: string } | undefined)?.screenshot;
        deps.emit({ type: 'tool-end', name: tc.name, callId: tc.id, ok: true, summary: '已截图', image: shot });
        await appendMessage(convId, { role: 'tool', toolCallId: tc.id, name: tc.name, content: '截图已捕获，见下一条消息' });
        if (shot) {
          const parts: ContentPart[] = [
            { type: 'text', text: '（take_screenshot 返回的页面截图）' },
            { type: 'image_url', imageUrl: shot },
          ];
          await appendMessage(convId, { role: 'user', content: parts });
        }
        continue;
      }

      const summary = r.ok ? '成功' : (r.error ?? '失败');
      const output = toToolContent(r);
      deps.emit({ type: 'tool-end', name: tc.name, callId: tc.id, ok: r.ok, summary, output });
      await appendMessage(convId, { role: 'tool', toolCallId: tc.id, name: tc.name, content: output });
    }

    guard = recordTurn(guard, result.toolCalls, results);
    const verdict = checkGuards(guard, DEFAULT_GUARD_CONFIG);
    if (verdict.stop) {
      await setStatus(convId, 'paused');
      deps.emit({ type: 'paused', reason: verdict.reason ?? '' });
      return;
    }
  }
}

function assistantMsg(text: string, toolCalls: ToolCall[], reasoning?: string): ChatMessage {
  return { role: 'assistant', content: text, toolCalls, reasoning };
}

async function finishAborted(convId: string, deps: LoopDeps): Promise<void> {
  await setStatus(convId, 'idle');
  deps.emit({ type: 'done', finalText: '已停止' });
}

function toToolContent(r: ToolResult): string {
  if (r.ok) return typeof r.data === 'string' ? r.data : JSON.stringify(r.data ?? { ok: true });
  return `错误：${r.error ?? '未知错误'}`;
}
