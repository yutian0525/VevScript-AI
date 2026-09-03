// components/scripts/ScriptsView.tsx
// 脚本池路由壳：ui.scriptId 非空 = 详情页；挂载时拉数据 + 订阅运行态广播（spec §7）。
import { useEffect } from 'react';
import { ScriptsListView } from './ScriptsListView';
import { ScriptDetailView } from './ScriptDetailView';
import { useScripts } from '../../stores/scripts';
import type { GmConfirmItem, GmErrorItem, GmMenuEntry } from '../../stores/scripts';
import { useUi } from '../../stores/ui';
import type { ScriptsRuntimeEvent } from '../../shared/messages';

export function ScriptsView() {
  const scriptId = useUi((s) => s.scriptId);

  useEffect(() => {
    void useScripts.getState().refresh();
    const onMessage = (msg: unknown) => {
      const m = msg as { type?: string };
      if (m?.type === 'SCRIPTS_RUNTIME') {
        useScripts.getState().applyRuntimeEvent(msg as ScriptsRuntimeEvent);
      }
      if (m?.type === 'SCRIPTS_MENUS') {
        useScripts.getState().applyMenusEvent(msg as { type: string; entries: GmMenuEntry[] });
      }
      if (m?.type === 'SCRIPTS_ERROR') {
        useScripts.getState().applyErrorEvent(msg as { type: string; scriptId: string; error: GmErrorItem });
      }
      if (m?.type === 'SCRIPTS_ERROR_CLEARED') {
        useScripts.getState().applyErrorCleared((msg as { scriptId: string }).scriptId);
      }
      if (m?.type === 'GM_CONFIRM_PENDING') {
        useScripts.getState().applyConfirmEvent(msg as { type: string; confirm: GmConfirmItem });
      }
      if (m?.type === 'GM_CONFIRM_RESOLVED') {
        useScripts.getState().applyConfirmResolved((msg as { confirmId: string }).confirmId);
      }
    };
    browser.runtime.onMessage.addListener(onMessage);
    // 切换浏览器标签页 → 更新 activeTabId；该 tab 无运行态条目（SW 重启丢失）时重拉兜底
    const onActivated = ({ tabId }: { tabId: number }) => {
      useScripts.getState().setActiveTab(tabId);
      if (useScripts.getState().runtimeEntries[tabId] == null) void useScripts.getState().refresh();
    };
    browser.tabs.onActivated.addListener(onActivated);
    return () => {
      browser.runtime.onMessage.removeListener(onMessage);
      browser.tabs.onActivated.removeListener(onActivated);
    };
  }, []);

  return scriptId ? <ScriptDetailView id={scriptId} /> : <ScriptsListView />;
}
