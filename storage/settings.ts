// storage/settings.ts
import { storage } from 'wxt/utils/storage';

export interface ProviderConfig {
  baseUrl: string; // OpenAI 兼容，如 https://api.deepseek.com/v1
  apiKey: string;
  model: string;
  /** 额外请求体参数：合并进 /chat/completions body（核心字段受保护不被覆盖）。
   *  用于开启各家网关的思考等开关，如 { enable_thinking: true } / { reasoning_effort: 'high' }。 */
  extraBody?: Record<string, unknown>;
}

export interface AgentConfig {
  // 注：不设"最大步数上限"——agent loop 靠自然终止 + 熔断阀（见 agent/loop-guards.ts），不数步数。
  screenshotPolicy: 'never' | 'on-demand';
  confirmGate: boolean; // 脚本池确认门控，默认 true
  /** 网络观测头处理：redacted=敏感头脱敏（默认），full=原文返回。见设计 §4.3。 */
  networkCaptureHeaders: 'redacted' | 'full';
}

export interface Settings {
  provider: ProviderConfig;
  agent: AgentConfig;
}

export const DEFAULT_SETTINGS: Settings = {
  provider: { baseUrl: '', apiKey: '', model: '' },
  agent: { screenshotPolicy: 'on-demand', confirmGate: true, networkCaptureHeaders: 'redacted' },
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
