// storage/settings.ts
import { storage } from 'wxt/utils/storage';
import type { ConfirmLevel } from '../agent/permission';

export interface ProviderConfig {
  baseUrl: string; // OpenAI 兼容，如 https://api.deepseek.com/v1
  apiKey: string;
  model: string;
  /** 上下文窗口（token）。留空则按 model 名映射；见 agent/model-windows.ts。 */
  contextWindow?: number;
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
  /** LLM 单轮超时（秒）：首字节与流增量间隙共用此窗口，超时即中止本轮。0 = 不限时。 */
  llmTimeoutSec: number;
  /** LLM 调用失败自动重试次数（仅对未产出任何 token 的失败重试；429/5xx 指数退避）。0 = 不重试。 */
  llmMaxRetries: number;
  /** 单轮回复的 token 上限（下发为 max_tokens）。此前从不下发 → 走服务端默认（多数网关
   *  2048~4096），长脚本必然被截断。0 = 不下发该字段（留给对它敏感的特殊网关）。 */
  maxTokens: number;
  /** 记忆总开关。false = 不注入记忆块、不下发三个记忆工具。 */
  memoryEnabled: boolean;
  /** AI 是否可写记忆。false = 只注入 + 只下发 memory_list，记忆改由人工维护。 */
  memoryWritable: boolean;
  /** 三级确认策略（spec §4）：all=全部询问 / sensitive=仅敏感 / auto=自动放行。每发工具现读，中途改档下一发生效。 */
  confirmLevel: ConfirmLevel;
}

/** 系统提示词自定义（覆盖式）。见 spec §2。 */
export interface PromptConfig {
  /** 自定义系统提示词全文。空串 = 使用内置 SYSTEM_PROMPT。 */
  custom: string;
  /** 保存自定义时的内置全文快照，用于「内置已更新」提示。 */
  baseSnapshot?: string;
}

/** 自定义提示词长度上限（字符）。页面侧拦截，不进 storage。 */
export const MAX_CUSTOM_PROMPT = 16 * 1024;

export interface Settings {
  provider: ProviderConfig;
  agent: AgentConfig;
  prompt: PromptConfig;
}

export const DEFAULT_SETTINGS: Settings = {
  provider: { baseUrl: '', apiKey: '', model: '' },
  agent: {
    screenshotPolicy: 'on-demand',
    confirmGate: true,
    networkCaptureHeaders: 'redacted',
    llmTimeoutSec: 60,
    llmMaxRetries: 2,
    maxTokens: 8192,
    memoryEnabled: true,
    memoryWritable: true,
    confirmLevel: 'sensitive',
  },
  prompt: { custom: '' },
};

const KEY = 'local:settings';

/** saveSettings 的入参：顶层段（provider/agent/prompt）可选，段内字段可选 */
export type SettingsPatch = {
  provider?: Partial<ProviderConfig>;
  agent?: Partial<AgentConfig>;
  prompt?: Partial<PromptConfig>;
};

export async function getSettings(): Promise<Settings> {
  const raw = await storage.getItem<SettingsPatch>(KEY);
  return {
    provider: { ...DEFAULT_SETTINGS.provider, ...raw?.provider },
    agent: { ...DEFAULT_SETTINGS.agent, ...raw?.agent },
    prompt: { ...DEFAULT_SETTINGS.prompt, ...raw?.prompt },
  };
}

/** merge 语义：顶层段（provider/agent/prompt）内的字段 merge */
export async function saveSettings(patch: SettingsPatch): Promise<void> {
  const current = await getSettings();
  const next: Settings = {
    provider: { ...current.provider, ...patch.provider },
    agent: { ...current.agent, ...patch.agent },
    prompt: { ...current.prompt, ...patch.prompt },
  };
  await storage.setItem(KEY, next);
}
