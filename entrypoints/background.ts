// entrypoints/background.ts
import { MessageRouter } from '../background/router';
import type { CsToBgNotification } from '../shared/messages';

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

  browser.runtime.onInstalled.addListener(() => {
    browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  });

  router.attach();
  console.log('[ai-browser-ext] background started');
});
