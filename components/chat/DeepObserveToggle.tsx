// components/chat/DeepObserveToggle.tsx
// 深度观测（CDP）开关：输入坞左侧的圆形图标钮（设计 §6）。
// 颜色即信息：关=--ink-3 / 开=--signal / 异常=--warn。SW 权威，本组件只发消息与订阅广播。
import { useEffect, useState } from 'react';
import { Activity } from 'lucide-react';
import { Tooltip } from '../ui/Tooltip';
import { useDeepObserve } from '../../stores/deep-observe';
import type { DeepObserveState, DeepObserveStatus } from '../../shared/cdp';

/** 当前活动标签页 id（侧边栏里 currentWindow 有时取不到，退化到 lastFocusedWindow——对齐 ChatView 惯例）。 */
function useActiveTabId(): number | null {
  const [tabId, setTabId] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    const query = async () => {
      let [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tab) [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
      if (alive) setTabId(tab?.id ?? null);
    };
    void query();
    const refresh = () => { void query(); };
    browser.tabs.onActivated.addListener(refresh);
    browser.tabs.onRemoved.addListener(refresh);
    return () => {
      alive = false;
      browser.tabs.onActivated.removeListener(refresh);
      browser.tabs.onRemoved.removeListener(refresh);
    };
  }, []);
  return tabId;
}

function tipFor(status: DeepObserveStatus, reason?: string): string {
  if (status === 'on') return '网页调试：开 · 本页已附着（点击关闭）';
  if (status === 'error') return `网页调试：已断开——${reason ?? '附着失败'}（点击重试）`;
  return '网页调试：关（点击开启）';
}

export function DeepObserveToggle({ disabled }: { disabled?: boolean }) {
  const tabId = useActiveTabId();
  const state = useDeepObserve((s) => (tabId != null ? s.states[tabId] : undefined));
  const applyState = useDeepObserve((s) => s.applyState);
  const fetchState = useDeepObserve((s) => s.fetchState);
  const setEnabled = useDeepObserve((s) => s.setEnabled);

  // 切换标签页时重新取该页状态
  useEffect(() => { if (tabId != null) void fetchState(tabId); }, [tabId, fetchState]);

  // SW 广播（面板按 tabId 过滤，这里落进 store 后由上面的 selector 取用）
  useEffect(() => {
    const onMessage = (msg: unknown) => {
      const m = msg as { type?: string; payload?: { state?: DeepObserveState } };
      if (m?.type === 'DEEP_OBSERVE_STATE' && m.payload?.state) applyState(m.payload.state);
    };
    browser.runtime.onMessage.addListener(onMessage);
    return () => browser.runtime.onMessage.removeListener(onMessage);
  }, [applyState]);

  const status: DeepObserveStatus = state?.status ?? 'off';
  const tip = tipFor(status, state?.reason);

  return (
    <Tooltip label={tip} placement="top">
      <button
        type="button"
        className={`deepobs deepobs--${status}`}
        aria-label={tip}
        disabled={disabled || tabId == null}
        /* error 态点击等同重试开启（spec §6）：只有 on 才发关闭，绝不从 error 态发 disable */
        onClick={() => { if (tabId != null) void setEnabled(tabId, status !== 'on'); }}
      >
        <Activity size={14} aria-hidden />
      </button>
    </Tooltip>
  );
}
