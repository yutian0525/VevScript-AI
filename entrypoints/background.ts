// entrypoints/background.ts
import { MessageRouter } from '../background/router';
import type { CsReadyNotification, DebugExecRequest } from '../shared/messages';
import { attachAgentPort, notifyCsReady } from '../background/agent-port';
import { handleDebugExec } from '../background/debug-exec';
import {
  ingestConsole,
  ingestHookNet,
  recordRequestStart,
  recordRequestEnd,
  recordRequestError,
  clearTab,
  clearTabNetwork,
} from '../background/observe-store';
import type { ConsoleEntry, HookNetEntry } from '../shared/hook-bridge';

export default defineBackground(() => {
  const router = new MessageRouter();

  // MVP 骨架：仅 PING echo 验证链路（Phase 2+ 逐工具接入）
  router.on('PING', async () => ({ ok: true, data: { pong: Date.now() } }));

  // 调试台：直接执行单个工具（绕过 LLM）
  router.on('DEBUG_EXEC_TOOL', (msg) => handleDebugExec(msg as unknown as DebugExecRequest));

  // content script 就绪通知：唤醒 navigate_page 的等待者
  router.on('CS_READY', async (msg, sender) => {
    void (msg as unknown as CsReadyNotification);
    const tabId = sender?.tab?.id;
    if (tabId != null) notifyCsReady(tabId);
    return { ok: true };
  });

  // MAIN hook 经 content.ts 中继来的观测：tabId 以 sender.tab.id 为准（payload 内不带）。
  router.on('HOOK_CONSOLE', async (msg, sender) => {
    const tabId = sender?.tab?.id;
    const entries = (msg as { payload?: { entries?: ConsoleEntry[] } }).payload?.entries ?? [];
    if (tabId != null) ingestConsole(tabId, entries);
    return { ok: true };
  });
  router.on('HOOK_NETWORK', async (msg, sender) => {
    const tabId = sender?.tab?.id;
    const entries = (msg as { payload?: { entries?: HookNetEntry[] } }).payload?.entries ?? [];
    if (tabId != null) ingestHookNet(tabId, entries);
    return { ok: true };
  });

  browser.runtime.onInstalled.addListener(async () => {
    browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
    // 弃用旧的按标签页会话（local:session:{tabId}）——WXT 存储裸 key 为 'session:{tabId}'
    try {
      const all = await browser.storage.local.get(null);
      const stale = Object.keys(all).filter((k) => k.startsWith('session:'));
      if (stale.length) await browser.storage.local.remove(stale);
    } catch { /* 清理失败不阻断启动 */ }
  });

  // webRequest 接线放 background（统管 browser 事件），observe-store 保持纯数据可测。
  function attachObservers(): void {
    const FILTER = { urls: ['<all_urls>'] as string[] };
    browser.webRequest.onBeforeRequest.addListener((d) => {
      if (d.tabId < 0 || d.url.startsWith('chrome-extension://')) return;
      if (d.type === 'main_frame') clearTabNetwork(d.tabId); // 翻页语义：清旧网络缓冲
      recordRequestStart(d.tabId, {
        requestId: d.requestId,
        method: d.method,
        url: d.url,
        type: d.type,
        ts: d.timeStamp,
      });
    }, FILTER);
    browser.webRequest.onCompleted.addListener((d) => {
      if (d.tabId < 0) return;
      recordRequestEnd(d.requestId, { status: d.statusCode, ts: d.timeStamp });
    }, FILTER);
    browser.webRequest.onErrorOccurred.addListener((d) => {
      if (d.tabId < 0) return;
      recordRequestError(d.requestId, { error: d.error, ts: d.timeStamp });
    }, FILTER);
    browser.tabs.onRemoved.addListener((tabId) => clearTab(tabId));
  }

  attachAgentPort();
  attachObservers();
  router.attach();
  console.log('[ai-browser-ext] background started');
});
