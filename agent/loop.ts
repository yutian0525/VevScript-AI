// agent/loop.ts
// Agent 主循环状态机（设计 §2）：convId 存储 + tabId 操作目标 + usage 计量 + 自动压缩 + 熔断阀。
import type { Provider, ChatMessage, ToolCall, ContentPart } from './provider/types';
import type { ToolResult, Skill } from '../shared/types';
import type { AgentEvent } from '../shared/messages';
import { runTurn } from './run-turn';
import { buildContext, type PageInfo, type SkillBrief } from './context';
import { getToolSchemas } from './tools/registry';
import { initGuardState, recordTurn, checkGuards, DEFAULT_GUARD_CONFIG, type GuardState } from './loop-guards';
import { getConversation, appendMessage, setStatus, setLastPromptTokens } from '../storage/conversations';
import { listSkills } from '../storage/skills';
import { meterRatio, COMPACT_THRESHOLD } from './context-meter';

export interface LoopDeps {
  provider: Provider;
  executeTool: (name: string, args: Record<string, unknown>, tabId: number, signal: AbortSignal) => Promise<ToolResult>;
  getPageInfo: (tabId: number) => Promise<PageInfo>;
  emit: (msg: AgentEvent) => void;
  resolveOpenedTab?: (toolName: string, openerTabId: number, signal: AbortSignal) => Promise<number | undefined>;
  /** 上下文窗口（token）。缺省则不做自动压缩（便于测试）。 */
  getContextWindow?: () => Promise<number>;
  /** 压缩当前会话。缺省则不做自动压缩（便于测试）。 */
  compact?: (convId: string) => Promise<{ ok: boolean; newPromptTokens?: number; error?: string }>;
  /** 启用技能简述（每轮 buildContext 注入）。缺省不注入（便于测试）。 */
  getSkills?: () => Promise<SkillBrief[]>;
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
  const m = /^\/([a-z0-9-]+)(?:\s+([\s\S]*))?$/.exec(args.userMessage.trim());
  const slash = m ? { command: m[1]!, rest: m[2] ?? '' } : undefined;
  await drive(args.convId, args.tabId, deps, initGuardState(), signal ?? new AbortController().signal, slash);
}

/** 从暂停状态恢复（不追加新 user 消息）。 */
export async function resumeAgentLoop(convId: string, tabId: number, deps: LoopDeps, signal?: AbortSignal): Promise<void> {
  await setStatus(convId, 'running');
  await drive(convId, tabId, deps, initGuardState(), signal ?? new AbortController().signal);
}

async function drive(
  convId: string,
  startTabId: number,
  deps: LoopDeps,
  guardState: GuardState,
  signal: AbortSignal,
  slash?: { command: string; rest: string },
): Promise<void> {
  let guard = guardState;
  let targetTab = startTabId;
  let lastPromptTokens: number | undefined;
  let pendingSlash = slash; // 仅首轮（触发轮）注入技能正文

  for (;;) {
    if (signal.aborted) return void (await finishAborted(convId, deps));

    // 自动压缩：上一轮 usage 达阈值 → 进下一轮前先摘要一次（不打断已完成的工具链）
    if (deps.compact && deps.getContextWindow && lastPromptTokens != null) {
      const windowSize = await deps.getContextWindow();
      if (meterRatio(lastPromptTokens, windowSize) >= COMPACT_THRESHOLD) {
        deps.emit({ type: 'compact-start' });
        const r = await deps.compact(convId).catch(() => ({ ok: false as const }));
        if (r.ok && r.newPromptTokens != null) {
          lastPromptTokens = r.newPromptTokens;
          await setLastPromptTokens(convId, r.newPromptTokens);
          deps.emit({ type: 'usage', promptTokens: r.newPromptTokens });
        } else {
          // 压缩无法再缩减（无新内容可摘）：清空 lastPromptTokens，避免每轮反复空触发
          // compact-start/done（UI 闪烁 + 浪费调用）；等下一轮 runTurn 的真实 usage 再判定。
          lastPromptTokens = undefined;
        }
        deps.emit({ type: 'compact-done', newPromptTokens: r.ok ? r.newPromptTokens : undefined });
      }
    }
    // 压缩期间用户可能已中断：进 runTurn 前再检查一次，避免浪费一次 API 调用
    if (signal.aborted) return void (await finishAborted(convId, deps));

    const conv = await getConversation(convId);
    const page = await deps.getPageInfo(targetTab).catch(() => ({ url: '', title: '' }));
    const skills = (await deps.getSkills?.()) ?? [];
    const messages = buildContext(conv.messages, page, 60, conv.summary, skills);
    // 斜杠触发：查 command 对应 enabled skill，其正文作为隐藏 system 消息仅注入本轮
    // （位于主 system 之后、user 原文之前；不落库——messages 是本轮临时数组）
    const triggerSlash = pendingSlash;
    pendingSlash = undefined; // 仅触发轮注入；后续轮不再重复
    if (triggerSlash) {
      // storage 故障按「未命中」处理（原样普通文本跑），与 port 侧 getSkills 降级对称
      const all = await listSkills().catch(() => [] as Skill[]);
      const hit = all.find((s) => s.command === triggerSlash.command && s.enabled);
      if (hit) {
        messages.splice(1, 0, {
          role: 'system',
          content: `【技能指令 /${hit.command}】\n${hit.content}\n\n用户附加输入：${triggerSlash.rest || '（无）'}`,
        });
      }
    }

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

/** 用户中断的收尾：置 idle + 通知面板结束（复用 done 事件，UI 回到可输入态）。 */
async function finishAborted(convId: string, deps: LoopDeps): Promise<void> {
  await setStatus(convId, 'idle');
  deps.emit({ type: 'done', finalText: '已停止' });
}

function toToolContent(r: ToolResult): string {
  if (r.ok) return typeof r.data === 'string' ? r.data : JSON.stringify(r.data ?? { ok: true });
  return `错误：${r.error ?? '未知错误'}`;
}
