// agent/loop.ts
// Agent 主循环状态机（设计 §2）：convId 存储 + tabId 操作目标 + usage 计量 + 自动压缩 + 熔断阀。
import type { Provider, ChatMessage, ToolCall, ContentPart } from './provider/types';
import type { ToolResult } from '../shared/types';
import type { AgentEvent } from '../shared/messages';
import { runTurn } from './run-turn';
import { buildContext, type PageInfo, type SkillBrief } from './context';
import { getToolSchemas } from './tools/registry';
import { modePrompt, type AgentMode } from './mode';
import { memoryStateToCap, type MemoryState } from './memory-prompt';
import { initGuardState, recordTurn, checkGuards, DEFAULT_GUARD_CONFIG, type GuardState } from './loop-guards';
import { getConversation, appendMessage, setStatus, setLastPromptTokens, setMode } from '../storage/conversations';
import { readTraces } from '../storage/traces';
import { createTurnRecorder } from './trace';
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
  /** 系统提示词全文（缺省用内置 SYSTEM_PROMPT）。每轮重读，设置页改完下一轮生效。 */
  getSystemPrompt?: () => Promise<string>;
  /** 记忆状态（全量条目 + 两个开关）。缺省不注入记忆块，工具清单按默认 full 下发。 */
  getMemoryState?: () => Promise<MemoryState>;
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
    // 轮次序号从 storage 读（而非 loop 内自增）：SW 被杀重启后计数不重置。
    // 读失败同样吞掉（spec §9）：调试设施不该有能力搞挂主流程。回退值无关紧要——
    // 同一存储层的读失败必然让 commit() 里的 appendTurnTrace 也失败，那轮根本不会落盘。
    const { seq } = await readTraces(convId).catch(() => ({ seq: 0, turns: [] }));
    const tr = createTurnRecorder({ convId, turn: seq + 1, tabId: targetTab });
    // try/finally 是刻意的：轮体内有 1 处 continue（截断重试）+ 8 处 return，
    // finally 在 continue 前同样执行，一处收口覆盖全部 9 处出口；轮末自然落下是
    // 第 10 个 outcome 赋值点，承载最常见的 'continue'（漏赋即被绊线记成 'error'）。
    try {
      if (signal.aborted) {
        tr.rec.outcome = 'aborted';
        return void (await finishAborted(convId, deps));
      }

      // 自动压缩：上一轮 usage 达阈值 → 进下一轮前先摘要一次（不打断已完成的工具链）
      if (deps.compact && deps.getContextWindow && lastPromptTokens != null) {
        const windowSize = await deps.getContextWindow();
        if (meterRatio(lastPromptTokens, windowSize) >= COMPACT_THRESHOLD) {
          deps.emit({ type: 'compact-start' });
          const compactAt = Date.now();
          const r = await deps.compact(convId).catch(() => ({ ok: false as const }));
          tr.markCompact({
            ms: Date.now() - compactAt,
            ok: r.ok,
            ...(r.ok && r.newPromptTokens != null ? { newPromptTokens: r.newPromptTokens } : {}),
          });
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
      if (signal.aborted) {
        tr.rec.outcome = 'aborted';
        return void (await finishAborted(convId, deps));
      }

      const conv = await getConversation(convId);
      const page = await deps.getPageInfo(targetTab).catch(() => ({ url: '', title: '' }));
      const skills = (await deps.getSkills?.()) ?? [];
      // 模式每轮重读：任务中途用户切 ask/agent，下一轮立即生效（已发出的轮次不回收）
      const mode = (await deps.getMode?.()) ?? 'agent';
      const systemPrompt = await deps.getSystemPrompt?.();
      const memory = await deps.getMemoryState?.();
      const messages = buildContext(conv.messages, page, { summary: conv.summary, skills, mode, systemPrompt, memory });
      const memoryCap = memory ? memoryStateToCap(memory) : 'full';
      tr.setMode(mode);
      tr.markContext(messages, { summary: conv.summary, skills, pageUrl: page.url });

      const maxTokens = (await deps.getMaxTokens?.()) ?? 0;
      // 参数生成进度节流器：每轮新建，状态不跨轮（下一轮从 0 重新计）
      const onArgs = makeArgsThrottle((name, bytes) => deps.emit({ type: 'tool-args-delta', name, bytes }));
      // TTFT：三个流式 hook 里首次回调即算首 token（工具参数先于正文到达是常态，必须计入）
      const llmAt = Date.now();
      let firstTokenAt: number | undefined;
      const markFirst = () => { if (firstTokenAt == null) firstTokenAt = Date.now(); };
      const result = await runTurn(deps.provider, {
        messages, tools: getToolSchemas(mode, memoryCap), signal,
        ...(maxTokens > 0 ? { maxTokens } : {}),
      }, {
        onTextDelta: (t) => { markFirst(); deps.emit({ type: 'text-delta', text: t }); },
        onReasoningDelta: (t) => { markFirst(); deps.emit({ type: 'reasoning-delta', text: t }); },
        onToolArgsDelta: (name, bytes) => { markFirst(); onArgs(name, bytes); },
      });
      tr.markLlm({ startedAt: llmAt, firstTokenAt, result });

      if (signal.aborted) {
        tr.rec.outcome = 'aborted';
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
        tr.rec.outcome = 'error';
        deps.emit({ type: 'error', message: result.error });
        await setStatus(convId, 'idle');
        return;
      }

      if (result.finishReason === 'length' && result.toolCalls.length > 0) {
        tr.rec.outcome = 'truncated-retry';
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
          tr.rec.outcome = 'paused';
          tr.rec.guardReason = verdict.reason ?? '';
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
        tr.rec.outcome = 'done';
        await appendMessage(convId, { role: 'assistant', content: finalText, reasoning: result.reasoning });
        deps.emit({ type: 'done', finalText });
        await setStatus(convId, 'idle');
        return;
      }

      await appendMessage(convId, assistantMsg(result.text, result.toolCalls, result.reasoning));
      const results: ToolResult[] = [];
      for (const tc of result.toolCalls) {
        if (signal.aborted) {
          tr.rec.outcome = 'aborted';
          await finishAborted(convId, deps);
          return;
        }
        let toolArgs: Record<string, unknown> = {};
        try { toolArgs = tc.arguments ? JSON.parse(tc.arguments) : {}; } catch { /* 保持空对象 */ }
        deps.emit({ type: 'tool-start', name: tc.name, args: tc.arguments, callId: tc.id });
        const toolAt = Date.now();
        const argsBytes = tc.arguments?.length ?? 0;
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
          tr.markTool({ name: tc.name, callId: tc.id, argsBytes, ms: Date.now() - toolAt, ok: true, summary });
          await appendMessage(convId, { role: 'tool', toolCallId: tc.id, name: tc.name, content: output });
          continue;
        }

        // take_screenshot 产截图：tool 消息只留一句话，base64 走独立 user 图片消息
        //（进视觉通道 + 受 trimImageParts 管理）——若让它留在 toToolContent 的 JSON 里，
        // 会成为数万 token 的纯文本废料且永不回收。
        if (tc.name === 'take_screenshot') {
          const data = (r as { data?: { screenshot?: string } | undefined }).data;
          const shot = data?.screenshot;
          const summary = r.ok ? '已截图' : (r.error ?? '失败');
          deps.emit({ type: 'tool-end', name: tc.name, callId: tc.id, ok: r.ok, summary, image: shot });
          tr.markTool({
            name: tc.name, callId: tc.id, argsBytes, ms: Date.now() - toolAt, ok: r.ok,
            ...(r.ok ? {} : { error: r.error }), summary,
          });
          const rest = toToolContent(r.ok ? { ok: true } : r);
          await appendMessage(convId, { role: 'tool', toolCallId: tc.id, name: tc.name, content: rest });
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
        // data 里若混入 screenshot（防御性：任何工具都不得让 base64 进文本上下文），
        // 摘掉后单独走 user 图片消息；其余字段照常序列化进 tool 消息。
        const shot = (r as { data?: { screenshot?: string } | undefined }).data?.screenshot;
        let output: string;
        if (shot != null) {
          const data = (r as { data?: Record<string, unknown> | undefined }).data;
          const { screenshot: _s, ...keep } = data ?? {};
          output = r.ok
            ? toToolContent({ ok: true, data: keep })
            : `错误：${r.error ?? '未知错误'}\n${JSON.stringify(keep)}`;
        } else {
          output = toToolContent(r);
        }
        deps.emit({ type: 'tool-end', name: tc.name, callId: tc.id, ok: r.ok, summary, image: shot, output });
        tr.markTool({
          name: tc.name, callId: tc.id, argsBytes, ms: Date.now() - toolAt, ok: r.ok,
          ...(r.ok ? {} : { error: r.error }), summary,
        });
        await appendMessage(convId, { role: 'tool', toolCallId: tc.id, name: tc.name, content: output });
        if (shot) {
          const parts: ContentPart[] = [
            { type: 'text', text: SCREENSHOT_SENTINEL },
            { type: 'image_url', imageUrl: shot },
          ];
          await appendMessage(convId, { role: 'user', content: parts });
        }
      }

      guard = recordTurn(guard, result.toolCalls, results);
      const verdict = checkGuards(guard, DEFAULT_GUARD_CONFIG);
      if (verdict.stop) {
        tr.rec.outcome = 'paused';
        tr.rec.guardReason = verdict.reason ?? '';
        await setStatus(convId, 'paused');
        deps.emit({ type: 'paused', reason: verdict.reason ?? '' });
        return;
      }

      // 轮体末尾自然落下 = 工具跑完、循环回下一轮（最常见的非终态）
      tr.rec.outcome = 'continue';
    } finally {
      await tr.commit();
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
  // stringify 兜底：data 理论上都经 serializeSafe 归一（无循环引用），但这是 loop 的
  // 最后一道关卡——未来某工具漏归一炸出 TypeError 会让会话永久卡 running，宁可降级为
  // 不可序列化标记也不能炸（审查探针指出该暴露面）。
  const stringify = (v: unknown): string => {
    try {
      return JSON.stringify(v) ?? '';
    } catch {
      return '"[不可序列化]"';
    }
  };
  if (r.ok) return typeof r.data === 'string' ? r.data : stringify(r.data ?? { ok: true });
  // 失败也带 data（个别工具的失败诊断信息在 data 里）——丢掉它「失败极详」落空。
  // ToolResult 失败分支类型上没有 data（类型面收窄），value 层由工具带出，这里是消费端。
  const data = (r as { data?: unknown }).data;
  if (data != null) {
    const detail = typeof data === 'string' ? data : stringify(data);
    return `错误：${r.error ?? '未知错误'}\n${detail}`;
  }
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
