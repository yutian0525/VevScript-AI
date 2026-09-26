// components/settings/SettingsView.tsx
// 设置枢纽壳（spec §1）：useState 二级路由（不持久化，每次进设置从列表开始）。
import { useEffect, useState } from 'react';
import { SettingsHome, TAB_ENTRIES, type SettingsSub } from './SettingsHome';
import { useUi } from '../../stores/ui';
import { openExtensionTab } from '../../stores/extension-tabs';
import { getCurrentConvId } from '../../storage/conversations';
import { ModelSettings } from './ModelSettings';
import { ToolBenchPage } from '../debug/ToolBenchPage';
import { ScriptDebugPage } from '../scriptdebug/ScriptDebugPage';
import { SystemPromptPage } from './SystemPromptPage';
import { MemoryPage } from './MemoryPage';
import { McpSettings } from './McpSettings';
import { StoragePage } from './StoragePage';
import { AboutPage } from './AboutPage';

export function SettingsView() {
  // 别处（会话页 MCP 浮层）可指定落点：读一次意图当初始值，挂载后即清，
  // 免得下次进设置还停在这个二级页（意图只吃一次）。读取是幂等的，StrictMode 重渲染无副作用。
  const [sub, setSub] = useState<SettingsSub | null>(() => useUi.getState().pendingSettingsSub);
  const back = () => setSub(null);

  useEffect(() => { useUi.getState().clearPendingSettingsSub(); }, []);

  // 带 tabUrl 的条目开独立标签页（默认停在你正在看的会话），其余照旧切二级页
  const open = (key: SettingsSub) => {
    const url = TAB_ENTRIES[key];
    if (url) {
      void getCurrentConvId().then((convId) => openExtensionTab(url, { convId }));
      return;
    }
    setSub(key);
  };

  return (
    <div className="view-swap" key={sub ?? 'home'}>
      {sub === 'model' ? (
        <ModelSettings onBack={back} />
      ) : sub === 'prompt' ? (
        <SystemPromptPage onBack={back} />
      ) : sub === 'memory' ? (
        <MemoryPage onBack={back} />
      ) : sub === 'mcp' ? (
        <McpSettings onBack={back} />
      ) : sub === 'toolbench' ? (
        <ToolBenchPage onBack={back} />
      ) : sub === 'scriptdebug' ? (
        <ScriptDebugPage onBack={back} />
      ) : sub === 'storage' ? (
        <StoragePage onBack={back} />
      ) : sub === 'about' ? (
        <AboutPage onBack={back} />
      ) : (
        <SettingsHome onOpen={open} />
      )}
    </div>
  );
}
