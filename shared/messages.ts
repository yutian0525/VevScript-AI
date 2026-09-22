// shared/messages.ts
// 三环境（background / content script / sidepanel）共享的消息协议。
// 设计决策：request/response 模式 + correlation id（设计 §4.4）；
// 例外：cs→bg 的 fire-and-forget 通知（见 CsReadyNotification）
// 与 bg→面板的深度观测状态广播（见 DeepObserveStateNotification，类型在 shared/cdp.ts）。

import type { ChatAttachment, ExtUpdateState, Locator, ScriptSource, ScriptSummary, ScriptUpdateState, ToolResult, Uid, UserScript } from './types';

export interface BgToCsRequestMap {
  /** detail 缺省 'interactive'（spec §6.2 新默认）。region 限定子树（uid 或选择器）。
   *  原 verbose 字段已删——全项目无人消费，是死字段。 */
  SNAPSHOT: { detail?: 'interactive' | 'full'; region?: Uid | string };
  /** 按 locator 定向查询（spec §6.3）。与脚本内 $ 同一套语法。 */
  QUERY: { locator: Locator; limit?: number; within?: Uid };
  CLICK: { uid: Uid; dblClick?: boolean };
  FILL: { uid: Uid; value: string };
  FILL_FORM: { elements: Array<{ uid: Uid; value: string }> };
  HOVER: { uid: Uid };
  SCROLL: { direction: 'up' | 'down' | 'left' | 'right'; amount?: number };
  PRESS_KEY: { key: string; modifiers?: string[] };
  /** 四种条件互斥（spec §6.4）。texts 为原有形式，保留向后兼容。 */
  WAIT_TEXT: {
    texts?: string[];
    appear?: Locator;
    gone?: Locator;
    idle?: number;
    timeoutMs?: number;
  };
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

// ---------- cs→bg fire-and-forget 通知 ----------

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
  | { type: 'agent:start'; convId: string; tabId: number; userMessage: string; attachments?: ChatAttachment[]; mode?: 'ask' | 'agent' }
  | { type: 'agent:stop'; convId: string }
  /** 面板（重）挂载/切会话时附着：后台回权威 state + 补发未落库的流式尾巴。 */
  | { type: 'agent:attach'; convId: string }
  | { type: 'agent:resume'; convId: string; tabId: number }
  | { type: 'agent:compact'; convId: string }
  /** 切换会话行为模式（ask/agent）：落库 + 通知运行中 loop 下一轮生效。 */
  | { type: 'agent:setMode'; convId: string; mode: 'ask' | 'agent' }
  /** 确认卡决策回传：allow-session = 本会话此工具不再问（记名动作在 loop）。 */
  | { type: 'agent:confirm'; convId: string; callId: string; decision: 'allow' | 'allow-session' | 'deny' };

/** agent 领域事件（loop 只关心语义，不关心投递给谁）。 */
export type AgentEvent =
  | { type: 'reasoning-delta'; text: string }
  | { type: 'text-delta'; text: string }
  /** 工具参数流式生成中（bytes = 已累计字节数，非增量）。根治「模型在写长参数时 UI 全静默」。 */
  | { type: 'tool-args-delta'; name: string; bytes: number }
  | { type: 'tool-start'; name: string; args: string; callId: string }
  /** 工具调用待用户确认（三级确认策略 spec §5-6）：卡片以 confirm 态呈现；
   *  until = 截止绝对时间戳（跨面板重挂载倒计时连续）。args 为模型原始参数串（未解析）。 */
  | { type: 'tool-confirm'; callId: string; name: string; args: string; until: number }
  | { type: 'tool-end'; name: string; callId: string; ok: boolean; summary: string; output?: string; image?: string }
  | { type: 'usage'; promptTokens?: number; completionTokens?: number }
  | { type: 'compact-start' }
  | { type: 'compact-done'; newPromptTokens?: number }
  | { type: 'paused'; reason: string }
  | { type: 'done'; finalText: string }
  | { type: 'error'; message: string }
  | { type: 'state'; status: 'idle' | 'running' | 'paused'; messageCount: number }
  | { type: 'mode'; mode: 'ask' | 'agent' };

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
  /** 从更新源（@updateURL/@downloadURL）拉取远端最新文本并覆盖；与其余分支互斥且优先。 */
  applyUpdate?: boolean;
  /** 追加到原文末尾（不需要行号）。分步写长脚本的主力原语（spec §4.1）。 */
  append?: string;
  /** 字面量精确替换（不依赖行号）。old 需唯一，否则报错列出命中行号。 */
  replace?: { old: string; new: string; all?: boolean };
}

/** 技能补丁（spec §4）：与 ScriptPatch 同构，但少一支——技能正文短，不需要 edit 行区间替换，
 *  且 get_skill 不加行号前缀，没有行号可依。text/append/replace 三支互斥，enabled 独立。 */
export interface SkillPatch {
  /** 整文替换：完整的技能 .md（--- frontmatter --- + 正文），替换后整体重解析 */
  text?: string;
  /** 追加到全文末尾（= 正文末尾，frontmatter 在开头）。分步写技能的主力原语 */
  append?: string;
  /** 字面量精确替换（不依赖行号）。old 需唯一，否则报错列出命中行号 */
  replace?: { old: string; new: string; all?: boolean };
  /** 启停（独立，可与文本分支并存） */
  enabled?: boolean;
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
  | { type: 'SCRIPTS_GET_LLM_TIER'; id: string }
  | { type: 'SCRIPTS_SET_LLM_TIER'; id: string; tier: 'ask' | 'allow' | 'deny' }
  | { type: 'CONFIRM_RESOLVE'; confirmId: string; decision: string }
  | { type: 'CONFIRM_GET_STATE' }
  | { type: 'GM_DEBUG_CALL'; scriptId: string; api: string; params: unknown[]; tabId?: number }
  | { type: 'GM_DEBUG_INFO'; scriptId: string; tabId?: number }
  | { type: 'SCRIPTS_IMPORT_URL'; url: string }
  | { type: 'SCRIPTS_CHECK_UPDATE'; id: string }
  | { type: 'SCRIPTS_APPLY_UPDATE'; id: string };

// ---------- Skill 管理（sidepanel → bg request/response，走 MessageRouter）----------

export type SkillsRequest =
  | { type: 'SKILLS_LIST' }
  | { type: 'SKILLS_GET'; id: string }
  | { type: 'SKILLS_DELETE'; id: string }
  | { type: 'SKILLS_SET_ENABLED'; id: string; enabled: boolean }
  | { type: 'SKILLS_IMPORT'; text: string; filename?: string }
  | { type: 'SKILLS_EXPORT'; ids?: string[] };   // 缺省 = 全部

// ---------- 脚本运行时调试台（sidepanel → bg request/response，走 MessageRouter）----------

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

/** bg → 扩展页面广播：更新检查后的全量更新状态 map（fire-and-forget；spec §2） */
export interface ScriptsUpdatesEvent {
  type: 'SCRIPTS_UPDATES';
  updates: Record<string, ScriptUpdateState>;
}

/** 脚本清单变更原因（跨界面同步：侧栏 refresh、详情页刷新/删除、popup 重载） */
export type ScriptsChangedReason = 'create' | 'update' | 'enable' | 'delete' | 'import';

/** bg → 扩展页面广播：脚本清单发生写变更（增/改/启停/删/导入）。
 *  与 SCRIPTS_RUNTIME 区别：后者只报某 tab 运行集，本事件报「清单本体变了」，
 *  接收方据此重拉 summaries / 重取详情，修 name/enabled/matches/删除卡片残留不同步。
 *  ids：受影响脚本 id（删除/改单条时给；批量或不确定可省，接收方全量 refresh）。 */
export interface ScriptsChangedEvent {
  type: 'SCRIPTS_CHANGED';
  reason: ScriptsChangedReason;
  ids?: string[];
}

/** popup/侧边栏跨面导航通知（popup → sidepanel，fire-and-forget；sidepanel 未开时由 pendingView 兜底） */
export interface UiNavNotification {
  type: 'UI_NAV';
  view: 'chat' | 'scripts' | 'settings';
}

// ---------- 扩展自身更新（sidepanel → bg request/response + bg → 扩展页面广播）----------

export type ExtUpdateRequest =
  | { type: 'EXT_UPDATE_GET' }    // 读当前状态（不发网络）
  | { type: 'EXT_UPDATE_CHECK' }; // 立即检查（无视节流）

/** bg → 扩展页面广播：扩展自身更新状态（每次检查落库后，fire-and-forget） */
export interface ExtUpdateStateEvent {
  type: 'EXT_UPDATE_STATE';
  update: ExtUpdateState | null;
}

/** SCRIPTS_LIST 响应 data 形状 */
export interface ScriptsListData {
  scripts: ScriptSummary[];
  /** chrome.userScripts 可用性（false → UI 顶部警示条） */
  engineAvailable: boolean;
}

// ---------- 深度观测（CDP）（sidepanel → bg request/response，走 MessageRouter）----------
// 类型定义在 shared/cdp.ts（agent 工具与 SW 也消费），此处 re-export 保持消息协议单一入口。
export type { DeepObserveState, DeepObserveStateNotification, DeepObserveRequest } from './cdp';
