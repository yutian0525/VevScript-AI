// shared/mcp.ts
// MCP（Model Context Protocol）领域类型：配置、运行时状态、工具描述、广播事件。
// 浏览器（MV3）里跑不了 stdio 子进程，故本项目的 MCP 只覆盖 HTTP 类传输：
//   streamable = Streamable HTTP（2025-06-18，单端点 POST）
//   sse        = HTTP+SSE（2024-11-05，GET 事件流 + POST /messages）
//   auto       = 先试 streamable，失败回退 sse

export type McpTransport = 'auto' | 'streamable' | 'sse';

/** 一台 MCP 服务的持久化配置（storage 层唯一真相）。 */
export interface McpServerConfig {
  id: string;
  /** 展示名，同时决定工具名前缀 slug。 */
  name: string;
  url: string;
  transport: McpTransport;
  /** false = 不连接、不下发工具（设置页开关与输入框浮层的「禁用」同一字段）。 */
  enabled: boolean;
  /** 附加请求头（Authorization / X-Api-Key 等）。空对象而非 undefined，便于表单直接受控。 */
  headers: Record<string, string>;
  /** 单次请求超时（毫秒），缺省 15000。 */
  timeoutMs?: number;
  createdAt?: number;
  updatedAt?: number;
}

/**
 * 状态机：
 *   disabled ──(启用)──> idle ──(连接)──> connecting ──> connected
 *                          ^                  │
 *                          └──(禁用/失败)──── error
 * idle 不自动重连：SW 每次唤醒都打一遍外部服务既浪费又易被限流。
 */
export type McpStatus = 'disabled' | 'idle' | 'connecting' | 'connected' | 'error';

/** 服务端声明的一个工具 + 净化后下发模型的名字。 */
export interface McpToolInfo {
  /** MCP 原名 */
  name: string;
  /** 下发模型的名字：mcp__<slug>__<tool> */
  exposedName: string;
  description?: string;
}

/** 运行时状态（后台权威，广播到面板；不持久化——SW 重启即回到 idle）。 */
export interface McpServerState {
  id: string;
  status: McpStatus;
  /** status === 'error' 时的原因文案。 */
  error?: string;
  tools: McpToolInfo[];
  /** 服务端 initialize 回包的 serverInfo。 */
  serverInfo?: { name?: string; version?: string };
  /** 服务端协商出的协议版本，仅展示，不做强校验。 */
  protocolVersion?: string;
  connectedAt?: number;
}

/** 面板用的合并视图 = 配置字段 + 运行时状态（省得前端两侧各查一次再自己拼）。 */
export interface McpStatusItem extends McpServerState {
  name: string;
  url: string;
  transport: McpTransport;
  enabled: boolean;
}

/** bg → 扩展页面广播（fire-and-forget）：任一台 server 状态变化后推全量。 */
export interface McpStateEvent {
  type: 'MCP_STATE';
  states: McpServerState[];
}

// ---------- 协议层（agent/mcp/client.ts 消费）----------

/** JSON-RPC 2.0 请求 */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number | string;
  result?: Record<string, unknown>;
  error?: JsonRpcError;
}

/** tools/list 返回的工具定义（只取本项目用得到的三个字段）。 */
export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** tools/call 返回的内容块。只消费 text 与 resource，其余类型降级为 JSON 原文。 */
export interface McpContentBlock {
  type: string;
  text?: string;
  [k: string]: unknown;
}

export interface McpCallResult {
  content?: McpContentBlock[];
  isError?: boolean;
  [k: string]: unknown;
}

/** 下发模型的 MCP 工具名前缀：mcp__<slug>__<tool>，供 registry 分流与 UI 识别。 */
export const MCP_PREFIX = 'mcp__';

/** 默认连接/请求超时（毫秒）。 */
export const MCP_DEFAULT_TIMEOUT_MS = 15_000;

/** 下发模型的工具名长度上限（OpenAI function name 约束）。 */
export const MCP_MAX_TOOL_NAME = 64;

// ---------- 展示派生（纯函数：输入坞浮层与设置页共用）----------
// 颜色即信息，一套色档三个消费点：状态点 / 状态胶囊 / 聚合仪表条。

/** 展示色档：ok=连上，busy=进行中，warn=异常，idle=未连，off=禁用。 */
export type McpTone = 'ok' | 'busy' | 'warn' | 'idle' | 'off';

export function mcpTone(status: McpStatus): McpTone {
  switch (status) {
    case 'connected': return 'ok';
    case 'connecting': return 'busy';
    case 'error': return 'warn';
    case 'disabled': return 'off';
    default: return 'idle';
  }
}

export const MCP_STATUS_LABEL: Record<McpStatus, string> = {
  connected: '已连接',
  connecting: '连接中',
  idle: '未连接',
  error: '异常',
  disabled: '已禁用',
};

export interface McpSummary {
  /** 聚合色档；empty 仅在从未配置时出现，与 off（全禁用）区分开。 */
  tone: McpTone | 'empty';
  /** 总台数 */
  total: number;
  /** 启用中的台数 */
  live: number;
  /** 已连接的台数 */
  online: number;
  /** 启用服务加起来可用的工具数 */
  tools: number;
  /** 仪表条内一行短文案 */
  label: string;
  /** 长文案（触发钮 tooltip） */
  tip: string;
}

/** 多台服务的聚合视图。判定优先级：没配置 > 全禁用 > 有异常 > 连接中 > 全连上 > 部分未连。 */
export function summarizeMcp(items: McpStatusItem[]): McpSummary {
  const total = items.length;
  const liveList = items.filter((i) => i.enabled);
  const live = liveList.length;
  const online = liveList.filter((i) => i.status === 'connected').length;
  const bad = liveList.filter((i) => i.status === 'error').length;
  const tools = liveList.reduce((n, i) => n + i.tools.length, 0);
  const base = { total, live, online, tools };

  if (total === 0) {
    return { ...base, tone: 'empty', label: '未配置', tip: 'MCP：未配置服务器（点开可去设置页添加）' };
  }
  if (live === 0) {
    return { ...base, tone: 'off', label: '全部禁用', tip: `MCP：${total} 台服务器已全部禁用（点开可启用）` };
  }
  if (bad) {
    return { ...base, tone: 'warn', label: `${bad} 台异常`, tip: `MCP：${bad} 台连接异常 · ${online} 台正常 · ${tools} 个工具可用（点开可重连）` };
  }
  if (liveList.some((i) => i.status === 'connecting')) {
    return { ...base, tone: 'busy', label: '连接中…', tip: `MCP：正在连接（${online}/${live} 已就绪）` };
  }
  if (online === live) {
    return { ...base, tone: 'ok', label: `${online} 台已连接`, tip: `MCP：${online} 台已连接 · ${tools} 个工具可用（点开可管理）` };
  }
  return { ...base, tone: 'idle', label: `${live - online} 台未连接`, tip: `MCP：${live - online} 台未连接（点开可重连）` };
}
