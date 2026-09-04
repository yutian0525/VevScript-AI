// shared/messages.ts
// 三环境（background / content script / sidepanel）共享的消息协议。
// 设计决策：request/response 模式 + correlation id（设计 §4.4）；
// 例外：cs→bg 的 fire-and-forget 通知（见 HookConsoleNotification / HookNetworkNotification）。

import type { ScriptSource, ScriptSummary, ToolResult, Uid, UserScript } from './types';
import type { ConsoleEntry, HookNetEntry } from './hook-bridge';

export interface BgToCsRequestMap {
  SNAPSHOT: { verbose?: boolean };
  CLICK: { uid: Uid; dblClick?: boolean };
  FILL: { uid: Uid; value: string };
  FILL_FORM: { elements: Array<{ uid: Uid; value: string }> };
  HOVER: { uid: Uid };
  SCROLL: { direction: 'up' | 'down' | 'left' | 'right'; amount?: number };
  PRESS_KEY: { key: string; modifiers?: string[] };
  WAIT_TEXT: { texts: string[]; timeoutMs?: number };
  PAGE_META: Record<string, never>;
  /** 脚本运行时调试台直调：SW→CS，宿主 debugCall 经真实桥链路发 GM_API_CALL（spec §3） */
  GM_DEBUG_INVOKE: { scriptId: string; api: string; params: unknown[] };
}

export type BgToCsRequest = {
  [K in keyof BgToCsRequestMap]: {
    type: K;
    correlationId: string;
    payload: BgToCsRequestMap[K];
  };
}[keyof BgToCsRequestMap];

/** cs→bg 的 fire-and-forget 通知：MAIN hook 经 ISOLATED content.ts 中继来的 console 观测。
 *  tabId 由 background 从 sender.tab.id 取，此处不带。 */
export interface HookConsoleNotification {
  type: 'HOOK_CONSOLE';
  payload: { entries: ConsoleEntry[] };
}

/** cs→bg 的 fire-and-forget 通知：中继来的 hook 网络观测（fetch/XHR body/headers）。 */
export interface HookNetworkNotification {
  type: 'HOOK_NETWORK';
  payload: { entries: HookNetEntry[] };
}

export interface CsResponse {
  correlationId: string;
  type: BgToCsRequest['type'];
  result: ToolResult;
}

let correlationCounter = 0;

export function createRequest<K extends keyof BgToCsRequestMap>(
  type: K,
  payload: BgToCsRequestMap[K],
): Extract<BgToCsRequest, { type: K }> {
  correlationCounter += 1;
  return {
    type,
    correlationId: `${Date.now()}-${correlationCounter}-${Math.random().toString(36).slice(2, 8)}`,
    payload,
  } as Extract<BgToCsRequest, { type: K }>;
}

export function isResponseFor(resp: CsResponse, req: BgToCsRequest): boolean {
  return resp.correlationId === req.correlationId && resp.type === req.type;
}

// ---------- cs→bg fire-and-forget 通知（HookConsole/HookNetwork 的兄弟类型）----------

/** content script 加载完成通知（navigate 后等待此信号）。 */
export interface CsReadyNotification {
  type: 'CS_READY';
  payload: { url: string };
}

// ---------- 调试台：绕过 LLM 直接执行单个工具（sidepanel → background，一问一答）----------

/** 调试执行请求：指定 tab + 工具名 + 参数，走真实 executeTool 链路。 */
export interface DebugExecRequest {
  type: 'DEBUG_EXEC_TOOL';
  tabId: number;
  name: string;
  args: Record<string, unknown>;
}

/** 调试执行响应：dispatched=链路是否跑通（非工具语义 ok），result=工具返回，ms=耗时。 */
export interface DebugExecResponse {
  dispatched: boolean;
  result?: ToolResult;
  ms: number;
  error?: string; // 链路层错误（如 executeTool 抛出）
}

// ---------- sidepanel ↔ background Port 协议（独立于 cs 协议）----------
// 约定：Port name 为 'agent'；消息用 'agent:' 前缀（→bg）或事件名（bg→）区分。

export type PortMsgFromPanel =
  | { type: 'agent:start'; convId: string; tabId: number; userMessage: string }
  | { type: 'agent:stop'; convId: string }
  /** 面板（重）挂载/切会话时附着：后台回权威 state + 补发未落库的流式尾巴。 */
  | { type: 'agent:attach'; convId: string }
  | { type: 'agent:resume'; convId: string; tabId: number }
  | { type: 'agent:compact'; convId: string };

/** agent 领域事件（loop 只关心语义，不关心投递给谁）。 */
export type AgentEvent =
  | { type: 'reasoning-delta'; text: string }
  | { type: 'text-delta'; text: string }
  | { type: 'tool-start'; name: string; args: string; callId: string }
  | { type: 'tool-end'; name: string; callId: string; ok: boolean; summary: string; output?: string; image?: string }
  | { type: 'usage'; promptTokens?: number; completionTokens?: number }
  | { type: 'compact-start' }
  | { type: 'compact-done'; newPromptTokens?: number }
  | { type: 'paused'; reason: string }
  | { type: 'done'; finalText: string }
  | { type: 'error'; message: string }
  | { type: 'state'; status: 'idle' | 'running' | 'paused'; messageCount: number };

/** 下行到面板的事件 = 领域事件 + 归属会话（面板按当前会话过滤，避免多会话串台）。
 *  用分布式条件类型逐支叠加，保留可辨识联合（直接写 `AgentEvent & {convId}` 会破坏 type 判别收窄）。 */
type WithConv<T> = T extends unknown ? T & { convId: string } : never;
export type PortMsgToPanel = WithConv<AgentEvent>;

// ---------- Phase 4：脚本池（sidepanel → bg request/response，走 MessageRouter；spec §7）----------

/** 行区间替换（修订 2026-09-02）：1-based、含端点；非法区间/越界由编排层报错 */
export interface ScriptEditRange {
  startLine: number;
  endLine: number;
  text: string;
}

export interface ScriptInput {
  /** 完整 .user.js 文本（含 ==UserScript== 头）——唯一配置源（修订 2026-09-02） */
  text: string;
  enabled?: boolean;
  /** 创建来源：UI 默认 user；AI 工具传 agent；导入走 SCRIPTS_IMPORT（固定 import） */
  source?: ScriptSource;
}

export interface ScriptPatch {
  /** 整文替换：替换后整体重解析（投影字段全部重建） */
  text?: string;
  enabled?: boolean;
  /** 行区间替换：在当前原文上 splice 后整体重解析 */
  edit?: ScriptEditRange;
}

/** SCRIPTS_GET 响应 data 形状：传 offset/limit 时 script.text 为行切片（修订 2026-09-02） */
export interface ScriptGetData {
  script: UserScript;
  totalLines: number;
  startLine: number;
  endLine: number;
}

export interface ScriptsRuntimeEntry {
  tabId: number;
  url: string;
  scriptIds: string[];
}

export type ScriptsRequest =
  | { type: 'SCRIPTS_LIST' }
  | { type: 'SCRIPTS_GET'; id: string; offset?: number; limit?: number }
  | { type: 'SCRIPTS_CREATE'; input: ScriptInput }
  | { type: 'SCRIPTS_UPDATE'; id: string; patch: ScriptPatch }
  | { type: 'SCRIPTS_DELETE'; id: string }
  | { type: 'SCRIPTS_SET_ENABLED'; id: string; enabled: boolean }
  | { type: 'SCRIPTS_IMPORT'; text: string; filename?: string }
  | { type: 'SCRIPTS_GET_RUNTIME' }
  | { type: 'SCRIPTS_MENU_INVOKE'; scriptId: string; key: string }
  | { type: 'SCRIPTS_CLEAR_ERRORS'; scriptId: string }
  | { type: 'SCRIPTS_GET_GM_STATE' }
  | { type: 'SCRIPTS_GET_RUNTIME_FOR_TAB'; tabId: number }
  | { type: 'SCRIPTS_GET_PERMISSIONS'; id: string }
  | { type: 'SCRIPTS_REVOKE_PERMISSION'; id: string; host: string }
  | { type: 'GM_CONFIRM_RESOLVE'; confirmId: string; decision: 'allow-once' | 'always' | 'deny' }
  | { type: 'GM_DEBUG_CALL'; scriptId: string; api: string; params: unknown[]; tabId?: number }
  | { type: 'GM_DEBUG_INFO'; scriptId: string; tabId?: number };

/** GM_DEBUG_INFO 响应 data：脚本运行时调试台白名单视图（spec §3.①）。 */
export interface GmDebugInfoData {
  connects: string[];
  grantSupported: string[];
  grantUnsupported: string[];
  /** 已「始终允许」的跨域主机（background/gm-permissions） */
  alwaysAllow: string[];
  /** 该脚本当前是否注入目标页（bridgeTokensForUrl 命中） */
  injected: boolean;
  /** 目标页 URL（host 仪表条 + @connect self 判定展示） */
  tabUrl: string;
}

/** bg → 扩展页面广播（fire-and-forget）：某 tab 运行集变化（spec §6.2「预期注入」语义） */
export interface ScriptsRuntimeEvent {
  type: 'SCRIPTS_RUNTIME';
  payload: ScriptsRuntimeEntry;
}

/** popup/侧边栏跨面导航通知（popup → sidepanel，fire-and-forget；sidepanel 未开时由 pendingView 兜底） */
export interface UiNavNotification {
  type: 'UI_NAV';
  view: 'chat' | 'scripts' | 'settings';
}

/** SCRIPTS_LIST 响应 data 形状 */
export interface ScriptsListData {
  scripts: ScriptSummary[];
  /** chrome.userScripts 可用性（false → UI 顶部警示条） */
  engineAvailable: boolean;
}
