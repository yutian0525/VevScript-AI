// background/agent-port.ts
// sidepanel ↔ background Port 管理 + agent loop 生命周期挂载（设计 §7）。
import type { PortMsgFromPanel, PortMsgToPanel } from '../shared/messages';
import type { Provider } from '../agent/provider/types';
import { OpenAICompatProvider } from '../agent/provider/openai-compat';
import { getSettings } from '../storage/settings';
import { runAgentLoop, resumeAgentLoop, type LoopDeps } from '../agent/loop';
import { executeTool } from '../agent/tools/registry';

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
  port: Pick<Browser.runtime.Port, 'postMessage'>,
): LoopDeps {
  return {
    provider,
    executeTool: (name, args, tabId, signal) =>
      executeTool(name, args, { tabId, sessionId: 'main', signal, waitForReady: (t) => waitForCsReady(t) }),
    getPageInfo,
    resolveOpenedTab: (_name, openerTabId) => resolveOpenedTab(openerTabId, (t) => waitForCsReady(t)),
    emit: (m: PortMsgToPanel) => {
      try {
        port.postMessage(m);
      } catch {
        /* port 已断开：loop 继续 */
      }
    },
  };
}

// 同 tab 单 loop 闸门 + 中断句柄：每个运行中的 tab 挂一个 AbortController。
// 既作"是否在运行"的判据（防并发 drive 竞态），又作 agent:stop 的中断句柄。
const runningTabs = new Map<number, AbortController>();

/** 中断指定 tab 的运行中 loop（agent:stop）。loop 在下个检查点干净退出。 */
export function stopTab(tabId: number): void {
  runningTabs.get(tabId)?.abort();
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
      console.log('[agent-port] 收到消息', msg.type, 'tabId=', (msg as { tabId?: number }).tabId);

      // 中断：优先处理，无论该 tab 是否在运行都幂等（未运行则 no-op）。
      if (msg.type === 'agent:stop') {
        stopTab(msg.tabId);
        return;
      }
      // attach 留 Phase 5（重连拉状态回放）
      if (msg.type !== 'agent:start' && msg.type !== 'agent:resume') return;
      if (runningTabs.has(msg.tabId)) {
        safePost({ type: 'error', message: '该标签页已有任务在运行，请等待完成或停止后再试' });
        return;
      }
      const provider = await buildProviderFromSettings().catch((e) => {
        console.warn('[agent-port] buildProvider 失败', e);
        return null;
      });
      if (!provider) {
        console.warn('[agent-port] provider 为空（未配置 baseUrl/model）');
        safePost({ type: 'error', message: '请先在设置页配置 AI 服务（Base URL + 模型）' });
        return;
      }
      const deps = makeDeps(provider, port);
      const ac = new AbortController();
      runningTabs.set(msg.tabId, ac);
      console.log('[agent-port] 启动 loop', msg.type, msg.tabId);
      try {
        if (msg.type === 'agent:start') {
          await runAgentLoop({ tabId: msg.tabId, sessionId: 'main', userMessage: msg.userMessage }, deps, ac.signal);
        } else {
          await resumeAgentLoop(msg.tabId, deps, ac.signal);
        }
        console.log('[agent-port] loop 结束', msg.tabId);
      } catch (err) {
        console.error('[agent-port] loop 抛错', err);
        safePost({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      } finally {
        runningTabs.delete(msg.tabId);
      }
    });
  });
}
