// components/settings/SettingsView.tsx
// 设置枢纽壳（spec §1）：useState 二级路由（不持久化，每次进设置从列表开始）。
import { useState } from 'react';
import { SettingsHome, type SettingsSub } from './SettingsHome';
import { ModelSettings } from './ModelSettings';
import { ToolBenchPage } from '../debug/ToolBenchPage';
import { ScriptDebugPage } from '../scriptdebug/ScriptDebugPage';
import { SkillsPage } from '../skills/SkillsPage';
import { SystemPromptPage } from './SystemPromptPage';
import { MemoryPage } from './MemoryPage';
import { HookExclusionsPage } from './HookExclusionsPage';
import { AboutPage } from './AboutPage';

export function SettingsView() {
  const [sub, setSub] = useState<SettingsSub | null>(null);
  const back = () => setSub(null);

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
      ) : sub === 'skills' ? (
        <SkillsPage onBack={back} />
      ) : sub === 'hookexclusions' ? (
        <HookExclusionsPage onBack={back} />
      ) : sub === 'about' ? (
        <AboutPage onBack={back} />
      ) : (
        <SettingsHome onOpen={setSub} />
      )}
    </div>
  );
}
