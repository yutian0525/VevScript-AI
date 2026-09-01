// entrypoints/background.ts
import { MessageRouter } from '../background/router';
import type { CsToBgNotification, CsReadyNotification, DebugExecRequest } from '../shared/messages';
import { attachAgentPort, notifyCsReady } from '../background/agent-port';
import { handleDebugExec } from '../background/debug-exec';

export default defineBackground(() => {
  const router = new MessageRouter();

  // MVP 骨架：仅 PING echo 验证链路（Phase 2+ 逐工具接入）
  router.on('PING', async () => ({ ok: true, data: { pong: Date.now() } }));

  router.on('NETLOG_PUSH', async (msg) => {
    const notification = msg as unknown as CsToBgNotification;
    const entries = notification.payload?.entries ?? [];
    // Phase 3 实现：写入网络日志环形缓冲
    console.log('[bg] netlog push (stub)', entries.length);
    return { ok: true };
  });

  // 调试台：直接执行单个工具（绕过 LLM）
  router.on('DEBUG_EXEC_TOOL', (msg) => handleDebugExec(msg as unknown as DebugExecRequest));

  // content script 就绪通知：唤醒 navigate_page 的等待者
  router.on('CS_READY', async (msg, sender) => {
    void (msg as unknown as CsReadyNotification);
    const tabId = sender?.tab?.id;
    if (tabId != null) notifyCsReady(tabId);
    return { ok: true };
  });

  browser.runtime.onInstalled.addListener(() => {
    browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  });

  attachAgentPort();
  router.attach();
  console.log('[ai-browser-ext] background started');
});
