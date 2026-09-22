// components/settings/SettingsView.tsx
// 设置枢纽壳（spec §1）：useState 二级路由（不持久化，每次进设置从列表开始）。
import { useState } from 'react';
import { SettingsHome, TAB_ENTRIES, type SettingsSub } from './SettingsHome';
import { openExtensionTab } from '../../stores/extension-tabs';
import { getCurrentConvId } from '../../storage/conversations';
import { ModelSettings } from './ModelSettings';
import { ToolBenchPage } from '../debug/ToolBenchPage';
import { ScriptDebugPage } from '../scriptdebug/ScriptDebugPage';
import { SystemPromptPage } from './SystemPromptPage';
import { MemoryPage } from './MemoryPage';
import { AboutPage } from './AboutPage';

export function SettingsView() {
  const [sub, setSub] = useState<SettingsSub | null>(null);
  const back = () => setSub(null);

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
      ) : sub === 'toolbench' ? (
        <ToolBenchPage onBack={back} />
      ) : sub === 'scriptdebug' ? (
        <ScriptDebugPage onBack={back} />
      ) : sub === 'about' ? (
        <AboutPage onBack={back} />
      ) : (
        <SettingsHome onOpen={open} />
      )}
    </div>
  );
}
