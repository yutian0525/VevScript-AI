// background/agent-port.ts
// sidepanel ↔ background Port 管理 + agent loop 生命周期挂载（设计 §7 / §1.4）。
import type { AgentEvent, PortMsgFromPanel } from '../shared/messages';
import type { Provider } from '../agent/provider/types';
import { OpenAICompatProvider } from '../agent/provider/openai-compat';
import { getSettings } from '../storage/settings';
import { listMemories } from '../storage/memory';
import { memoryStateToCap, type MemoryState } from '../agent/memory-prompt';
import { runAgentLoop, resumeAgentLoop, type LoopDeps } from '../agent/loop';
import { CONFIRM_TIMEOUT_MS } from '../agent/permission';
import { executeTool } from '../agent/tools/registry';
import { compactConversation } from '../agent/compact';
import { resolveContextWindow } from '../agent/model-windows';
import { resolveSystemPrompt } from '../agent/context';
import { getConversation, setLastPromptTokens, setStatus, setMode as storeSetMode } from '../storage/conversations';
import { listSkills } from '../storage/skills';
import type { Skill } from '../shared/types';
import { emptyTail, reduceTail, replayTail, type AgentTail } from './agent-tail';

export async function buildProviderFromSettings(): Promise<Provider | null> {
  const { provider, agent } = await getSettings();
  if (!provider.baseUrl || !provider.model) return null;
  // 超时与重试配置：秒 → 毫秒（0 = 关闭），传给 provider 内部实现
  return new OpenAICompatProvider(provider, {
    timeoutMs: agent.llmTimeoutSec > 0 ? agent.llmTimeoutSec * 1000 : 0,
    maxRetries: agent.llmMaxRetries,
  });
}

// ---------- CS_READY 等待（navigate 后）----------
const readyWaiters = new Map<number, Array<() => void>>();

export function notifyCsReady(tabId: number): void {
  const waiters = readyWaiters.get(tabId);
  if (waiters) {
    readyWaiters.delete(tabId);
    for (const w of waiters) w();
  }
}

export function waitForCsReady(tabId: number, timeoutMs = 15_000): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const cur = readyWaiters.get(tabId);
      if (cur) readyWaiters.set(tabId, cur.filter((w) => w !== done));
      resolve(); // 超时也放行
    }, timeoutMs);
    const done = () => { clearTimeout(timer); resolve(); };
    const list = readyWaiters.get(tabId) ?? [];
    list.push(done);
    readyWaiters.set(tabId, list);
  });
}

async function getPageInfo(tabId: number): Promise<{ url: string; title: string }> {
  const tab = await browser.tabs.get(tabId).catch(() => undefined);
  return { url: tab?.url ?? '', title: tab?.title ?? '' };
}

/** 交互后探测新开标签：找以 openerTabId 为父、当前激活的标签
 *  （target=_blank / window.open 默认前台打开并聚焦，openerTabId 指向发起点击的标签）。
 *  命中则等其 content script 就绪、返回其 id 供 loop 切换 targetTab；否则 undefined。
 *  多候选（该标签历史开过多个子标签）取最新（tab id 最大，Chrome 单调递增）。
 *  查全量再 JS 过滤，不依赖 query 的 openerTabId 过滤保真度。 */
export async function resolveOpenedTab(
  openerTabId: number,
  waitReady: (tabId: number) => Promise<void>,
): Promise<number | undefined> {
  const tabs = await browser.tabs.query({}).catch(() => [] as Browser.tabs.Tab[]);
  const candidates = tabs.filter((t) => t.id != null && t.openerTabId === openerTabId && t.active);
  if (candidates.length === 0) return undefined;
  const newest = candidates.reduce((a, b) => ((b.id ?? 0) > (a.id ?? 0) ? b : a));
  const id = newest.id!;
  await waitReady(id).catch(() => {});
  return id;
}

// ---------- 面板端口集合 + 事件广播 ----------
// 面板会在切标签/切视图时销毁重建（端口随之断开重连），因此 loop 不能捏着建立时的那一个 port。
// 改为：SW 维护当前所有活着的面板端口，事件广播给所有端口并盖上 convId，面板按当前会话过滤。
const panelPorts = new Set<Browser.runtime.Port>();

// per-conv 未落库的流式尾巴（供重新附着的面板补齐当前轮输出）
const tails = new Map<string, AgentTail>();

function postTo(port: Pick<Browser.runtime.Port, 'postMessage'>, convId: string, e: AgentEvent): void {
  try {
    port.postMessage({ ...e, convId });
  } catch {
    /* port 已断开：忽略 */
  }
}

/** 广播 agent 事件到所有活着的面板（并推进该会话的流式尾巴）。 */
function broadcast(convId: string, e: AgentEvent): void {
  tails.set(convId, reduceTail(tails.get(convId) ?? emptyTail(), e));
  for (const p of panelPorts) postTo(p, convId, e);
}

/** 读记忆状态：总开关关闭时直接返回空且不可写；storage 故障同样降级为 off
 *  （任务不因记忆读不出来而中断，代价是该轮拿不到记忆也不能写——瞬时故障可接受）。
 *
 *  注：loop 用它过滤 schema、executeTool 又独立读一次做硬闸，两处各读一次同一份设置。
 *  用户在一轮进行中拨开关，最坏情况是这一轮清单与守卫松紧不一致，下一轮即对齐——
 *  守卫是防幻觉的兜底，不追求与清单严格同帧。 */
export async function readMemoryState(): Promise<MemoryState> {
  const off: MemoryState = { enabled: false, writable: false, entries: [] };
  try {
    const { agent } = await getSettings();
    if (!agent.memoryEnabled) return off;
    const all = await listMemories();
    return {
      enabled: true,
      writable: agent.memoryWritable,
      entries: all.map((m) => ({
        id: m.id, content: m.content, matches: m.matches, updatedAt: m.updatedAt,
      })),
    };
  } catch {
    return off;
  }
}

function makeDeps(provider: Provider, convId: string): LoopDeps {
  return {
    provider,
    executeTool: async (name, args, tabId, signal) =>
      executeTool(name, args, {
        tabId, sessionId: convId, signal,
        waitForReady: (t) => waitForCsReady(t),
        mode: convModeRef.mode,
        memory: memoryStateToCap(await readMemoryState()),
      }),
    getPageInfo,
    resolveOpenedTab: (_name, openerTabId) => resolveOpenedTab(openerTabId, (t) => waitForCsReady(t)),
    getContextWindow: async () => {
      const { provider: p } = await getSettings();
      return resolveContextWindow(p.model, p.contextWindow);
    },
    getMaxTokens: async () => (await getSettings()).agent.maxTokens,
    getSystemPrompt: async () => {
      const s = await getSettings().catch(() => null);
      return resolveSystemPrompt(s?.prompt.custom);
    },
    getMemoryState: readMemoryState,
    getConfirmLevel: async () => (await getSettings()).agent.confirmLevel,
    confirmToolCall: (req, signal) =>
      registerToolConfirm(convId, { callId: req.callId, name: req.name, args: req.rawArgs }, signal),
    compact: (id) => compactConversation(id, { provider }),
    getSkills: async () =>
      (await listSkills().catch(() => [] as Skill[]))
        .filter((s) => s.enabled)
        .map((s) => ({ name: s.name, command: s.command, description: s.description })),
    // 每轮开跑前重读模式：中途切换下一轮生效（ref 读的是最新值）
    getMode: async () => convModeRef.mode,
    // 断开的端口在 postTo 内被吞掉：loop 不受面板生死影响，继续跑到底
    emit: (m) => broadcast(convId, m),
  };
}

// 同 conv 单 loop 闸门 + 中断句柄：每个运行中的会话挂一个 AbortController。
const runningConvs = new Map<string, AbortController>();

/** 运行中会话的实时模式（loop 的 deps.getMode/executeTool 守卫读这里）。
 *  map 的生命周期 = loop 生命周期（agent:start 写入、finally 清除），中途 setMode 只改值不重建 loop。 */
const convModeRef: { mode: 'ask' | 'agent' } = { mode: 'agent' };

// ---------- 三级确认槽（spec §7）：per-conv 单槽（单 conv 单 loop，loop 内逐个 await） ----------
type ConfirmVerdict = 'allow' | 'allow-session' | 'deny' | 'timeout';

interface PendingConfirm {
  callId: string;
  name: string;
  args: string;
  until: number;
  resolve: (d: ConfirmVerdict) => void;
}
const pendingConfirms = new Map<string, PendingConfirm>();

/** 登记待确认项并等决策：120s 超时 → 'timeout'；abort → 'deny'；agent:confirm 消息经 resolveToolConfirm 回传。 */
export function registerToolConfirm(
  convId: string,
  entry: { callId: string; name: string; args: string },
  signal: AbortSignal,
): Promise<ConfirmVerdict> {
  return new Promise((resolve) => {
    // addEventListener 对已 aborted 的 signal 不追溯派发，必须入口自查，否则永挂到 120s 超时。
    if (signal.aborted) { resolve('deny'); return; }
    let settled = false;
    const until = Date.now() + CONFIRM_TIMEOUT_MS;
    const finish = (d: ConfirmVerdict) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (pendingConfirms.get(convId)?.callId === entry.callId) pendingConfirms.delete(convId);
      resolve(d);
    };
    const timer = setTimeout(() => finish('timeout'), CONFIRM_TIMEOUT_MS);
    const onAbort = () => finish('deny');
    signal.addEventListener('abort', onAbort);
    pendingConfirms.set(convId, { ...entry, until, resolve: finish });
  });
}

/** agent:confirm 消息入口：callId 一致才 resolve（防陈旧确认串轮），否则空操作（幂等）。 */
export function resolveToolConfirm(convId: string, callId: string, decision: 'allow' | 'allow-session' | 'deny'): void {
  const p = pendingConfirms.get(convId);
  if (!p || p.callId !== callId) return;
  p.resolve(decision);
}

/** loop 结束的兜底清理：槽里还挂着就强制 resolve（理论上 abort 已收口，这里防悬挂）。 */
export function discardToolConfirm(convId: string): void {
  const p = pendingConfirms.get(convId);
  if (!p) return;
  pendingConfirms.delete(convId);
  p.resolve('deny');
}

/** 仅测试用。 */
export function __resetToolConfirms(): void {
  for (const p of pendingConfirms.values()) p.resolve('deny');
  pendingConfirms.clear();
}

/** 算出附着时该补发给面板的事件序列（权威运行态 + 未落库的流式尾巴）。
 *  running 与否只认后台有没有活着的 loop，不认 storage：SW 被杀会在 storage 里留下假 running，
 *  此处顺手改回 idle，避免面板输入框永久禁用。 */
export async function buildAttachEvents(convId: string, running: boolean, tail: AgentTail): Promise<AgentEvent[]> {
  const conv = await getConversation(convId);
  const modeEvent: AgentEvent = { type: 'mode', mode: convModeRef.mode };
  if (running) {
    const events: AgentEvent[] = [
      modeEvent,
      { type: 'state', status: 'running', messageCount: conv.messages.length },
      ...replayTail(tail),
    ];
    // 待确认状态跨面板重挂载：放序列末尾，让它赢下同帧的 argsProgress 清理
    const pending = pendingConfirms.get(convId);
    if (pending) {
      events.push({ type: 'tool-confirm', callId: pending.callId, name: pending.name, args: pending.args, until: pending.until });
    }
    return events;
  }
  if (conv.status === 'running') await setStatus(convId, 'idle');
  const status = conv.status === 'running' ? 'idle' : conv.status;
  return [modeEvent, { type: 'state', status, messageCount: conv.messages.length }];
}

async function handleAttach(port: Browser.runtime.Port, convId: string): Promise<void> {
  const running = runningConvs.has(convId);
  const events = await buildAttachEvents(convId, running, tails.get(convId) ?? emptyTail());
  for (const e of events) postTo(port, convId, e);
}

/** 中断指定会话的运行中 loop（agent:stop）。loop 在下个检查点干净退出。 */
export function stopConv(convId: string): void {
  runningConvs.get(convId)?.abort();
}

/** 挂载 Port 监听（在 background 入口调用）。 */
export function attachAgentPort(): void {
  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== 'agent') return;
    panelPorts.add(port);
    port.onDisconnect.addListener(() => {
      void browser.runtime.lastError;
      panelPorts.delete(port);
    });
    port.onMessage.addListener(async (raw) => {
      const msg = raw as PortMsgFromPanel;
      console.log('[agent-port] 收到消息', msg.type, msg.convId);
      // 只回本端口的一问一答（错误提示等）；loop 事件走 broadcast
      const safePost = (m: AgentEvent) => postTo(port, msg.convId, m);

      if (msg.type === 'agent:attach') {
        await handleAttach(port, msg.convId);
        return;
      }

      if (msg.type === 'agent:stop') {
        stopConv(msg.convId);
        return;
      }

      // 模式切换：立即落库（草稿会话也建档）；运行中则同步改 convModeRef，loop 下一轮生效。
      if (msg.type === 'agent:setMode') {
        await storeSetMode(msg.convId, msg.mode);
        if (runningConvs.has(msg.convId)) convModeRef.mode = msg.mode;
        broadcast(msg.convId, { type: 'mode', mode: msg.mode });
        return;
      }

      // 手动压缩：与运行中 loop 互斥（避免并发改会话）
      if (msg.type === 'agent:compact') {
        if (runningConvs.has(msg.convId)) {
          safePost({ type: 'error', message: '任务运行中，无法压缩，请等待完成后再试' });
          return;
        }
        const provider = await buildProviderFromSettings().catch(() => null);
        if (!provider) {
          safePost({ type: 'error', message: '请先在设置页配置 AI 服务（Base URL + 模型）' });
          return;
        }
        broadcast(msg.convId, { type: 'compact-start' });
        const r = await compactConversation(msg.convId, { provider }).catch((e) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }));
        if (r.ok && r.newPromptTokens != null) {
          await setLastPromptTokens(msg.convId, r.newPromptTokens);
          broadcast(msg.convId, { type: 'usage', promptTokens: r.newPromptTokens });
        }
        if (!r.ok) safePost({ type: 'error', message: `压缩失败：${r.error ?? '未知错误'}` });
        broadcast(msg.convId, { type: 'compact-done', newPromptTokens: r.ok ? r.newPromptTokens : undefined });
        return;
      }

      // 确认卡决策回传：查槽 resolve（callId 不匹配/已超时清槽 = 空操作）
      if (msg.type === 'agent:confirm') {
        resolveToolConfirm(msg.convId, msg.callId, msg.decision);
        return;
      }

      if (msg.type !== 'agent:start' && msg.type !== 'agent:resume') return;
      if (runningConvs.has(msg.convId)) {
        safePost({ type: 'error', message: '该会话已有任务在运行，请等待完成或停止后再试' });
        return;
      }
      const provider = await buildProviderFromSettings().catch((e) => {
        console.warn('[agent-port] buildProvider 失败', e);
        return null;
      });
      if (!provider) {
        safePost({ type: 'error', message: '请先在设置页配置 AI 服务（Base URL + 模型）' });
        return;
      }
      const conv = await getConversation(msg.convId);
      convModeRef.mode = msg.type === 'agent:start' && msg.mode ? msg.mode : (conv.mode ?? 'agent');
      const deps = makeDeps(provider, msg.convId);
      const ac = new AbortController();
      runningConvs.set(msg.convId, ac);
      tails.set(msg.convId, emptyTail());
      try {
        if (msg.type === 'agent:start') {
          await runAgentLoop({ convId: msg.convId, tabId: msg.tabId, userMessage: msg.userMessage, attachments: msg.attachments, mode: convModeRef.mode }, deps, ac.signal);
        } else {
          await resumeAgentLoop(msg.convId, msg.tabId, deps, ac.signal);
        }
      } catch (err) {
        console.error('[agent-port] loop 抛错', err);
        broadcast(msg.convId, { type: 'error', message: err instanceof Error ? err.message : String(err) });
      } finally {
        runningConvs.delete(msg.convId);
        tails.delete(msg.convId);
        discardToolConfirm(msg.convId);
      }
    });
  });
}
