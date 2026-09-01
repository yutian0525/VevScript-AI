// agent/loop.ts
// Agent 主循环状态机（设计 §2）：无硬上限 + 熔断阀 + 每轮持久化。
import type { Provider, ChatMessage, ToolCall, Usage, ContentPart } from './provider/types';
import type { ToolResult } from '../shared/types';
import type { PortMsgToPanel } from '../shared/messages';
import { runTurn } from './run-turn';
import { buildContext, type PageInfo } from './context';
import { getToolSchemas } from './tools/registry';
import { initGuardState, recordTurn, checkGuards, DEFAULT_GUARD_CONFIG, type GuardState } from './loop-guards';
import { getSession, appendMessage, setStatus } from '../storage/sessions';

export interface LoopDeps {
  provider: Provider;
  executeTool: (name: string, args: Record<string, unknown>, tabId: number, signal: AbortSignal) => Promise<ToolResult>;
  getPageInfo: (tabId: number) => Promise<PageInfo>;
  emit: (msg: PortMsgToPanel) => void;
}

export interface LoopArgs {
  tabId: number;
  sessionId: string;
  userMessage: string;
}

export async function runAgentLoop(args: LoopArgs, deps: LoopDeps): Promise<void> {
  await appendMessage(args.tabId, { role: 'user', content: args.userMessage });
  await setStatus(args.tabId, 'running');
  await drive(args.tabId, deps, initGuardState());
}

/** 从暂停状态恢复（不追加新 user 消息）。 */
export async function resumeAgentLoop(tabId: number, deps: LoopDeps): Promise<void> {
  await setStatus(tabId, 'running');
  await drive(tabId, deps, initGuardState());
}

async function drive(startTabId: number, deps: LoopDeps, guardState: GuardState): Promise<void> {
  const ac = new AbortController();
  let guard = guardState;
  let targetTab = startTabId;

  for (;;) {
    if (ac.signal.aborted) { await setStatus(startTabId, 'idle'); return; }

    const session = await getSession(startTabId);
    const page = await deps.getPageInfo(targetTab).catch(() => ({ url: '', title: '' }));
    const messages = buildContext(session.messages, page);

    const result = await runTurn(deps.provider, { messages, tools: getToolSchemas(), signal: ac.signal }, {
      onTextDelta: (t) => deps.emit({ type: 'text-delta', text: t }),
      onReasoningDelta: (t) => deps.emit({ type: 'reasoning-delta', text: t }),
    });

    if (result.error) {
      deps.emit({ type: 'error', message: result.error });
      await setStatus(startTabId, 'idle');
      return;
    }

    // length 守卫：输出被截断 → 该轮 tool_calls 全判失败喂回
    if (result.finishReason === 'length' && result.toolCalls.length > 0) {
      await appendMessage(startTabId, assistantMsg(result.text, result.toolCalls, result.reasoning));
      const truncFailed: ToolResult[] = [];
      for (const tc of result.toolCalls) {
        await appendMessage(startTabId, { role: 'tool', toolCallId: tc.id, name: tc.name, content: '错误：模型输出被截断，该工具调用参数不完整，请重新发起' });
        truncFailed.push({ ok: false, error: '模型输出被截断' });
      }
      // 计入熔断阀：连续截断会累加步数/连续错误，触及阀值则暂停，避免无限截断循环烧钱
      guard = recordTurn(guard, result.toolCalls, truncFailed, turnTokens(result.usage));
      const verdict = checkGuards(guard, DEFAULT_GUARD_CONFIG);
      if (verdict.stop) {
        await setStatus(startTabId, 'paused');
        deps.emit({ type: 'paused', reason: verdict.reason ?? '' });
        return;
      }
      continue;
    }

    // 自然终止（无工具调用）
    if (result.toolCalls.length === 0) {
      const truncated = result.finishReason === 'length';
      const finalText = truncated
        ? `${result.text}\n\n[注意：回复因达到长度上限被截断，可能不完整]`
        : result.text;
      await appendMessage(startTabId, { role: 'assistant', content: finalText, reasoning: result.reasoning });
      deps.emit({ type: 'done', finalText });
      await setStatus(startTabId, 'idle');
      return;
    }

    // 执行工具（先 append assistant(toolCalls)，再依次 append 每个 tool result，保持配对连续）
    await appendMessage(startTabId, assistantMsg(result.text, result.toolCalls, result.reasoning));
    const results: ToolResult[] = [];
    for (const tc of result.toolCalls) {
      if (ac.signal.aborted) { await setStatus(startTabId, 'idle'); return; }
      let toolArgs: Record<string, unknown> = {};
      try { toolArgs = tc.arguments ? JSON.parse(tc.arguments) : {}; } catch { /* 保持空对象 */ }
      deps.emit({ type: 'tool-start', name: tc.name, args: tc.arguments, callId: tc.id });
      const r = await deps.executeTool(tc.name, toolArgs, targetTab, ac.signal);
      results.push(r);

      // targetTab 更新（设计 §4）
      if (r.ok && (tc.name === 'new_page' || tc.name === 'select_page')) {
        const d = r.data as { targetTab?: number } | undefined;
        if (typeof d?.targetTab === 'number') targetTab = d.targetTab;
      }
      if (r.ok && tc.name === 'close_page') {
        const d = r.data as { closed?: number } | undefined;
        if (d?.closed === targetTab) targetTab = startTabId;
      }

      // 截图注入（设计 §5.2）：tool 消息占位 + 追加 user 图片消息
      if (tc.name === 'take_screenshot' && r.ok) {
        const shot = (r.data as { screenshot?: string } | undefined)?.screenshot;
        deps.emit({ type: 'tool-end', name: tc.name, callId: tc.id, ok: true, summary: '已截图', image: shot });
        await appendMessage(startTabId, { role: 'tool', toolCallId: tc.id, name: tc.name, content: '截图已捕获，见下一条消息' });
        if (shot) {
          // 图片走 user 消息：OpenAI 协议下 tool 消息 content 约定为 string，
          // image_url 须在 user 消息里才被多数 OpenAI-compatible 网关处理（勿改回 tool 消息塞图）。
          const parts: ContentPart[] = [
            { type: 'text', text: '（take_screenshot 返回的页面截图）' },
            { type: 'image_url', imageUrl: shot },
          ];
          await appendMessage(startTabId, { role: 'user', content: parts });
        }
        continue;
      }

      const summary = r.ok ? '成功' : (r.error ?? '失败');
      const output = toToolContent(r);
      deps.emit({ type: 'tool-end', name: tc.name, callId: tc.id, ok: r.ok, summary, output });
      await appendMessage(startTabId, { role: 'tool', toolCallId: tc.id, name: tc.name, content: output });
    }

    // 熔断阀
    guard = recordTurn(guard, result.toolCalls, results, turnTokens(result.usage));
    const verdict = checkGuards(guard, DEFAULT_GUARD_CONFIG);
    if (verdict.stop) {
      await setStatus(startTabId, 'paused');
      deps.emit({ type: 'paused', reason: verdict.reason ?? '' });
      return;
    }
  }
}

function assistantMsg(text: string, toolCalls: ToolCall[], reasoning?: string): ChatMessage {
  return { role: 'assistant', content: text, toolCalls, reasoning };
}

/** 本轮消耗 token = prompt + completion（prompt 通常占大头，只算 completion 会严重低估 token 阀）。 */
function turnTokens(usage: Usage | undefined): number {
  return (usage?.promptTokens ?? 0) + (usage?.completionTokens ?? 0);
}

function toToolContent(r: ToolResult): string {
  if (r.ok) return typeof r.data === 'string' ? r.data : JSON.stringify(r.data ?? { ok: true });
  return `错误：${r.error ?? '未知错误'}`;
}
