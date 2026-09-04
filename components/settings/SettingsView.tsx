// components/settings/SettingsView.tsx
// 设置枢纽壳（spec §1）：useState 二级路由（不持久化，每次进设置从列表开始）。
import { useState } from 'react';
import { SettingsHome, type SettingsSub } from './SettingsHome';
import { ModelSettings } from './ModelSettings';
import { ToolBenchPage } from '../debug/ToolBenchPage';
import { ScriptDebugPage } from '../scriptdebug/ScriptDebugPage';
import { SkillsPage } from '../skills/SkillsPage';

export function SettingsView() {
  const [sub, setSub] = useState<SettingsSub | null>(null);
  const back = () => setSub(null);

  if (sub === 'model') return <ModelSettings onBack={back} />;
  if (sub === 'toolbench') return <ToolBenchPage onBack={back} />;
  if (sub === 'scriptdebug') return <ScriptDebugPage onBack={back} />;
  if (sub === 'skills') return <SkillsPage onBack={back} />;
  return <SettingsHome onOpen={setSub} />;
}
