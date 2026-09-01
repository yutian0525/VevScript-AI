// storage/settings.ts
import { storage } from 'wxt/utils/storage';

export interface ProviderConfig {
  baseUrl: string; // OpenAI 兼容，如 https://api.deepseek.com/v1
  apiKey: string;
  model: string;
}

export interface AgentConfig {
  // 注：不设"最大步数上限"——agent loop 靠自然终止 + 熔断阀（见 agent/loop-guards.ts），不数步数。
  screenshotPolicy: 'never' | 'on-demand';
  confirmGate: boolean; // 脚本池确认门控，默认 true
}

export interface Settings {
  provider: ProviderConfig;
  agent: AgentConfig;
}

export const DEFAULT_SETTINGS: Settings = {
  provider: { baseUrl: '', apiKey: '', model: '' },
  agent: { screenshotPolicy: 'on-demand', confirmGate: true },
};

const KEY = 'local:settings';

/** saveSettings 的入参：顶层段（provider/agent）可选，段内字段可选 */
export type SettingsPatch = {
  provider?: Partial<ProviderConfig>;
  agent?: Partial<AgentConfig>;
};

export async function getSettings(): Promise<Settings> {
  const raw = await storage.getItem<SettingsPatch>(KEY);
  return {
    provider: { ...DEFAULT_SETTINGS.provider, ...raw?.provider },
    agent: { ...DEFAULT_SETTINGS.agent, ...raw?.agent },
  };
}

/** merge 语义：顶层段（provider/agent）内的字段 merge */
export async function saveSettings(patch: SettingsPatch): Promise<void> {
  const current = await getSettings();
  const next: Settings = {
    provider: { ...current.provider, ...patch.provider },
    agent: { ...current.agent, ...patch.agent },
  };
  await storage.setItem(KEY, next);
}
