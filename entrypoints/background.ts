// entrypoints/background.ts
import { MessageRouter } from '../background/router';
import type { CsReadyNotification, DebugExecRequest } from '../shared/messages';
import { attachAgentPort, notifyCsReady } from '../background/agent-port';
import { handleDebugExec } from '../background/debug-exec';
import {
  recordRequestStart,
  recordRequestEnd,
  recordRequestError,
  clearTab,
  clearTabNetwork,
} from '../background/observe-store';
import { initScriptsModule } from '../background/scripts';
import { initGmApi } from '../background/gm-api';
import { initSkillsModule } from '../background/skills';
import { seedBuiltinSkills } from '../background/builtin-skills';
import { maybeRunStartupUpdateCheck } from '../background/scripts-update';
import { initExtUpdateModule, maybeRunStartupExtUpdateCheck } from '../background/ext-update';
import { initConfirmQueue } from '../background/confirm-queue';
import { initCdp, attachCdpListeners } from '../background/cdp/init';

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

  browser.runtime.onInstalled.addListener(async () => {
    // 工具栏图标已由 action.default_popup 接管（弹 popup 浮窗），不再 setPanelBehavior 直开侧边栏；
    // 侧边栏改由 popup 内「打开侧边栏」按钮经 sidePanel.open 唤起。
    // 弃用旧的按标签页会话（local:session:{tabId}）——WXT 存储裸 key 为 'session:{tabId}'
    try {
      const all = await browser.storage.local.get(null);
      const stale = Object.keys(all).filter((k) => k.startsWith('session:'));
      if (stale.length) await browser.storage.local.remove(stale);
    } catch { /* 清理失败不阻断启动 */ }
    // 内置技能投放（安装 + 更新都触发；更新时覆盖为扩展内新版，保留用户启停状态）
    await seedBuiltinSkills().catch((e) => console.warn('[vevscript] 内置技能投放失败', e));
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

  // 深度观测（CDP）：事件监听与消息 handler 必须在 SW 顶层同步注册。
  attachCdpListeners();
  initCdp(router);

  initScriptsModule(router);
  initGmApi(router);
  initSkillsModule(router);

  // 脚本更新的批量检查（fire-and-forget，不阻塞 SW）。三条路径统一走 maybeRunStartupUpdateCheck：
  //  1) SW 冷启动（本行）：节流兜底——onStartup 在 MV3 不可靠（unpacked 几乎不触发、SW 被唤醒不补触发），
  //     故每次 SW 冷启动都进节流检查，距上次超 12h 才真的查，保证「浏览器开着」隔段时间自动查一次。
  //  2) onStartup：浏览器带扩展冷启动的显式信号，force 无视节流立即查。
  //  3) onInstalled：安装/更新时 force 立即查。
  // 同一 SW 生命周期内 checkStarted 守卫保证只跑一次，三路径不重复。
  void maybeRunStartupUpdateCheck().catch(() => {});
  browser.runtime.onStartup.addListener(() => { void maybeRunStartupUpdateCheck(true).catch(() => {}); });
  browser.runtime.onInstalled.addListener(() => { void maybeRunStartupUpdateCheck(true).catch(() => {}); });

  // 扩展自身更新检查（三路径与脚本更新同构，见上注）。纯自分发下唯一的「发现新版」通道，
  // onInstalled 在用户重载新版扩展后 force 查一次，让「已是最新」状态及时对齐。
  initExtUpdateModule(router);
  void maybeRunStartupExtUpdateCheck().catch(() => {});
  browser.runtime.onStartup.addListener(() => { void maybeRunStartupExtUpdateCheck(true).catch(() => {}); });
  browser.runtime.onInstalled.addListener(() => { void maybeRunStartupExtUpdateCheck(true).catch(() => {}); });

  initConfirmQueue(router);
  router.attach();
  console.log('[vevscript] background started');
});
