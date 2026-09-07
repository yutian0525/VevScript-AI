// agent/loop.ts
// Agent 主循环状态机（设计 §2）：convId 存储 + tabId 操作目标 + usage 计量 + 自动压缩 + 熔断阀。
import type { Provider, ChatMessage, ToolCall, ContentPart } from './provider/types';
import type { ToolResult } from '../shared/types';
import type { AgentEvent } from '../shared/messages';
import { runTurn } from './run-turn';
import { buildContext, type PageInfo, type SkillBrief } from './context';
import { getToolSchemas } from './tools/registry';
import { modePrompt, type AgentMode } from './mode';
import { initGuardState, recordTurn, checkGuards, DEFAULT_GUARD_CONFIG, type GuardState } from './loop-guards';
import { getConversation, appendMessage, setStatus, setLastPromptTokens, setMode } from '../storage/conversations';
import { meterRatio, COMPACT_THRESHOLD } from './context-meter';
import { composeUserContent, SCREENSHOT_SENTINEL } from './user-message';
import type { ChatAttachment } from '../shared/types';

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
  /** 当前行为模式（缺省 'agent'）。每轮开跑前经 getMode 重读，支持任务中途切换。 */
  getMode?: () => Promise<AgentMode>;
  /** 单轮 token 上限（0/缺省 = 不下发 max_tokens）。 */
  getMaxTokens?: () => Promise<number>;
}

const TAB_OPENING_TOOLS = new Set(['click', 'press_key']);

export interface LoopArgs {
  convId: string;
  tabId: number;
  userMessage: string;
  /** 输入框上传的附件（纯文本内联进消息、图片作 image_url part）。 */
  attachments?: ChatAttachment[];
  /** 发起本轮时的行为模式（写入 user 消息前的默认模式；loop 每轮经 deps.getMode 重读）。 */
  mode?: AgentMode;
}

export async function runAgentLoop(args: LoopArgs, deps: LoopDeps, signal?: AbortSignal): Promise<void> {
  await appendMessage(args.convId, { role: 'user', content: composeUserContent(args.userMessage, args.attachments ?? []) });
  await setStatus(args.convId, 'running');
  if (args.mode) await setMode(args.convId, args.mode);
  // 斜杠 /command 不再注入技能正文——它就是普通 user 文本；模型看到系统提示的技能简述后，
  // 自行调用 load_skill 工具取正文（spec §2.4 修订 2026-09-05）。
  await drive(args.convId, args.tabId, deps, initGuardState(), signal ?? new AbortController().signal);
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
): Promise<void> {
  let guard = guardState;
  let targetTab = startTabId;
  let lastPromptTokens: number | undefined;

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
    // 模式每轮重读：任务中途用户切 ask/agent，下一轮立即生效（已发出的轮次不回收）
    const mode = (await deps.getMode?.()) ?? 'agent';
    const messages = buildContext(conv.messages, page, { summary: conv.summary, skills, mode });

    const maxTokens = (await deps.getMaxTokens?.()) ?? 0;
    // 参数生成进度节流器：每轮新建，状态不跨轮（下一轮从 0 重新计）
    const onArgs = makeArgsThrottle((name, bytes) => deps.emit({ type: 'tool-args-delta', name, bytes }));
    const result = await runTurn(deps.provider, {
      messages, tools: getToolSchemas(mode), signal,
      ...(maxTokens > 0 ? { maxTokens } : {}),
    }, {
      onTextDelta: (t) => deps.emit({ type: 'text-delta', text: t }),
      onReasoningDelta: (t) => deps.emit({ type: 'reasoning-delta', text: t }),
      onToolArgsDelta: onArgs,
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
        await appendMessage(convId, { role: 'tool', toolCallId: tc.id, name: tc.name, content: '错误：模型输出被截断，该工具调用参数不完整。若在写长脚本，请改用分步方式：'
          + '先 create_script 只提交元数据头 + 未闭合的 IIFE 骨架（如 `(function () {` 结尾，不写 `})();`），'
          + '再用 update_script 的 patch.append 分次追加代码体，最后一段带上 `})();` 闭合。' });
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

      if (tc.name === 'load_skill' && r.ok) {
        // 工具卡摘要显示「已加载「技能名」」；tool 消息 content = 正文，喂给模型遵循执行。
        const d = r.data as { name?: string; command?: string; content?: string } | undefined;
        const summary = d?.name ? `已加载「${d.name}」` : '已加载技能';
        const output = `【技能指令 /${d?.command ?? ''}】\n${d?.content ?? ''}`;
        deps.emit({ type: 'tool-end', name: tc.name, callId: tc.id, ok: true, summary, output });
        await appendMessage(convId, { role: 'tool', toolCallId: tc.id, name: tc.name, content: output });
        continue;
      }

      if (tc.name === 'take_screenshot' && r.ok) {
        const shot = (r.data as { screenshot?: string } | undefined)?.screenshot;
        deps.emit({ type: 'tool-end', name: tc.name, callId: tc.id, ok: true, summary: '已截图', image: shot });
        await appendMessage(convId, { role: 'tool', toolCallId: tc.id, name: tc.name, content: '截图已捕获，见下一条消息' });
        if (shot) {
          const parts: ContentPart[] = [
            { type: 'text', text: SCREENSHOT_SENTINEL },
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

const ARGS_THROTTLE_MS = 200;
const ARGS_THROTTLE_BYTES = 1024;

/** 参数进度节流：首次立即发，之后满 200ms 或涨够 1KB 才发（避免逐 token 广播）。
 *  每轮 runTurn 前新建一个，状态不跨轮。 */
function makeArgsThrottle(emit: (name: string, bytes: number) => void): (name: string, bytes: number) => void {
  let lastAt = 0;
  let lastBytes = -1;
  return (name, bytes) => {
    const now = Date.now();
    if (lastBytes >= 0 && now - lastAt < ARGS_THROTTLE_MS && bytes - lastBytes < ARGS_THROTTLE_BYTES) return;
    lastAt = now;
    lastBytes = bytes;
    emit(name, bytes);
  };
}
