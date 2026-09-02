// background/agent-port.ts
// sidepanel ↔ background Port 管理 + agent loop 生命周期挂载（设计 §7 / §1.4）。
import type { PortMsgFromPanel, PortMsgToPanel } from '../shared/messages';
import type { Provider } from '../agent/provider/types';
import { OpenAICompatProvider } from '../agent/provider/openai-compat';
import { getSettings } from '../storage/settings';
import { runAgentLoop, resumeAgentLoop, type LoopDeps } from '../agent/loop';
import { executeTool } from '../agent/tools/registry';
import { compactConversation } from '../agent/compact';
import { resolveContextWindow } from '../agent/model-windows';
import { setLastPromptTokens } from '../storage/conversations';

export async function buildProviderFromSettings(): Promise<Provider | null> {
  const { provider } = await getSettings();
  if (!provider.baseUrl || !provider.model) return null;
  return new OpenAICompatProvider(provider);
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

function makeDeps(
  provider: Provider,
  convId: string,
  port: Pick<Browser.runtime.Port, 'postMessage'>,
): LoopDeps {
  return {
    provider,
    executeTool: (name, args, tabId, signal) =>
      executeTool(name, args, { tabId, sessionId: convId, signal, waitForReady: (t) => waitForCsReady(t) }),
    getPageInfo,
    resolveOpenedTab: (_name, openerTabId) => resolveOpenedTab(openerTabId, (t) => waitForCsReady(t)),
    getContextWindow: async () => {
      const { provider: p } = await getSettings();
      return resolveContextWindow(p.model, p.contextWindow);
    },
    compact: (id) => compactConversation(id, { provider }),
    emit: (m: PortMsgToPanel) => {
      try {
        port.postMessage(m);
      } catch {
        /* port 已断开：loop 继续 */
      }
    },
  };
}

// 同 conv 单 loop 闸门 + 中断句柄：每个运行中的会话挂一个 AbortController。
const runningConvs = new Map<string, AbortController>();

/** 中断指定会话的运行中 loop（agent:stop）。loop 在下个检查点干净退出。 */
export function stopConv(convId: string): void {
  runningConvs.get(convId)?.abort();
}

/** 挂载 Port 监听（在 background 入口调用）。 */
export function attachAgentPort(): void {
  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== 'agent') return;
    const safePost = (m: PortMsgToPanel) => {
      try { port.postMessage(m); } catch { /* port 已断开：忽略 */ }
    };
    port.onMessage.addListener(async (raw) => {
      const msg = raw as PortMsgFromPanel;
      console.log('[agent-port] 收到消息', msg.type, (msg as { convId?: string }).convId);

      if (msg.type === 'agent:stop') {
        stopConv(msg.convId);
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
        safePost({ type: 'compact-start' });
        const r = await compactConversation(msg.convId, { provider }).catch((e) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }));
        if (r.ok && r.newPromptTokens != null) {
          await setLastPromptTokens(msg.convId, r.newPromptTokens);
          safePost({ type: 'usage', promptTokens: r.newPromptTokens });
        }
        if (!r.ok) safePost({ type: 'error', message: `压缩失败：${r.error ?? '未知错误'}` });
        safePost({ type: 'compact-done', newPromptTokens: r.ok ? r.newPromptTokens : undefined });
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
      const deps = makeDeps(provider, msg.convId, port);
      const ac = new AbortController();
      runningConvs.set(msg.convId, ac);
      try {
        if (msg.type === 'agent:start') {
          await runAgentLoop({ convId: msg.convId, tabId: msg.tabId, userMessage: msg.userMessage }, deps, ac.signal);
        } else {
          await resumeAgentLoop(msg.convId, msg.tabId, deps, ac.signal);
        }
      } catch (err) {
        console.error('[agent-port] loop 抛错', err);
        safePost({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      } finally {
        runningConvs.delete(msg.convId);
      }
    });
  });
}
