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

function makeDeps(
  provider: Provider,
  port: Pick<Browser.runtime.Port, 'postMessage'>,
): LoopDeps {
  return {
    provider,
    executeTool: (name, args, tabId, signal) =>
      executeTool(name, args, { tabId, sessionId: 'main', signal, waitForReady: (t) => waitForCsReady(t) }),
    getPageInfo,
    emit: (m: PortMsgToPanel) => {
      try {
        port.postMessage(m);
      } catch {
        /* port 已断开：loop 继续 */
      }
    },
  };
}

// 同 tab 单 loop 闸门：防止并发 drive 导致 appendMessage 竞态丢消息 + 双倍烧 token
const activeTabs = new Set<number>();

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
      // stop/attach 留 Phase 5（需 per-tab AbortController 追踪 + 状态回放）
      if (msg.type !== 'agent:start' && msg.type !== 'agent:resume') return;
      if (activeTabs.has(msg.tabId)) {
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
      activeTabs.add(msg.tabId);
      console.log('[agent-port] 启动 loop', msg.type, msg.tabId);
      try {
        if (msg.type === 'agent:start') {
          await runAgentLoop({ tabId: msg.tabId, sessionId: 'main', userMessage: msg.userMessage }, deps);
        } else {
          await resumeAgentLoop(msg.tabId, deps);
        }
        console.log('[agent-port] loop 结束', msg.tabId);
      } catch (err) {
        console.error('[agent-port] loop 抛错', err);
        safePost({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      } finally {
        activeTabs.delete(msg.tabId);
      }
    });
  });
}
