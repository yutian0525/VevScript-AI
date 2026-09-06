// components/scripts/ScriptsView.tsx
// 脚本池路由壳：纯列表（详情页已迁全屏新标签页）；挂载时拉数据 + 订阅运行态/菜单/错误/确认广播。
import { useEffect } from 'react';
import { ScriptsListView } from './ScriptsListView';
import { useScripts } from '../../stores/scripts';
import type { GmErrorItem, GmMenuEntry } from '../../stores/scripts';
import type { ScriptsRuntimeEvent, ScriptsUpdatesEvent } from '../../shared/messages';

export function ScriptsView() {
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
      if (m?.type === 'SCRIPTS_UPDATES') {
        useScripts.getState().applyUpdatesEvent(msg as ScriptsUpdatesEvent);
      }
    };
    browser.runtime.onMessage.addListener(onMessage);
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

  return <ScriptsListView />;
}
