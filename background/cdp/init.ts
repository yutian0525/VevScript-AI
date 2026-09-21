// background/cdp/init.ts
// 深度观测的 SW 接线（设计 §5.6）：会话 ↔ 域启用互接、状态广播、消息 handler。
// 抽成独立模块是为了能在单测里挂到 MessageRouter 上，不必启动整个 background。
import { enableAll, handleEvent } from './domains';
import {
  initCdpSession, attach, detach, getState, onDetached, markZombie, forget, reconcile, tabIdForSession,
} from './session';
import { setNetworkSuppressor } from '../observe-store';
import type { DeepObserveState } from '../../shared/cdp';

interface RouterLike { on(type: string, handler: (msg: Record<string, unknown>) => unknown): void }

/** 在 SW 顶层同步调用：注册 debugger 事件监听 + 消息 handler + 网络抑制钩子。 */
export function initCdp(router: RouterLike): void {
  initCdpSession({
    enableDomains: enableAll,
    onStateChange: (state: DeepObserveState) => {
      void browser.runtime.sendMessage({ type: 'DEEP_OBSERVE_STATE', payload: { state } }).catch(() => {});
    },
  });

  // CDP 附着时该 tab 的网络由 CDP 独占（observe-store 侧判定）。
  setNetworkSuppressor((tabId) => getState(tabId).status === 'on');

  router.on('DEEP_OBSERVE_GET', async (msg) => {
    const { tabId } = msg as unknown as { tabId: number };
    return { ok: true, data: getState(tabId) };
  });
  router.on('DEEP_OBSERVE_SET', async (msg) => {
    const { tabId, enabled } = msg as unknown as { tabId: number; enabled: boolean };
    if (!enabled) {
      await detach(tabId);
      return { ok: true, data: getState(tabId) };
    }
    const r = await attach(tabId);
    return r.ok ? { ok: true, data: r.state } : { ok: false, error: r.error };
  });

  // 冷启动对账：附着跨 SW 重启存活，但内存记账会丢。
  void reconcile().catch(() => {});
}

/** 在 SW 顶层同步注册 debugger 事件监听。
 *  MV3 下 SW 重启后事件可能早于异步初始化到达，顶层同步注册是唯一能保证收到的写法。 */
export function attachCdpListeners(): void {
  browser.debugger.onEvent.addListener((source, method, params) => {
    const tabId = source.tabId ?? (source.sessionId ? tabIdForSession(source.sessionId) : undefined);
    if (tabId == null) return;
    void handleEvent(tabId, source.sessionId, method, (params ?? {}) as Record<string, unknown>)
      .catch((err: unknown) => {
        // 「not attached」= 浏览器侧会话已消失而内存记账还在的僵尸态（spec §8）。
        if (/not attached/i.test(err instanceof Error ? err.message : String(err))) markZombie(tabId);
      });
  });
  browser.debugger.onDetach.addListener((source, reason) => {
    if (source.tabId == null) return;
    onDetached(source.tabId, reason);
  });
  browser.tabs.onRemoved.addListener((tabId) => forget(tabId));
}
