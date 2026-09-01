// shared/messages.ts
// 三环境（background / content script / sidepanel）共享的消息协议。
// 设计决策：request/response 模式 + correlation id（设计 §4.4）；
// 例外：cs→bg 的 fire-and-forget 通知（见 HookConsoleNotification / HookNetworkNotification）。

import type { ToolResult, Uid } from './types';
import type { ConsoleEntry, HookNetEntry } from './hook-bridge';

export interface BgToCsRequestMap {
  SNAPSHOT: { verbose?: boolean };
  CLICK: { uid: Uid; dblClick?: boolean };
  FILL: { uid: Uid; value: string };
  FILL_FORM: { elements: Array<{ uid: Uid; value: string }> };
  HOVER: { uid: Uid };
  SCROLL: { direction: 'up' | 'down' | 'left' | 'right'; amount?: number };
  PRESS_KEY: { key: string; modifiers?: string[] };
  EVALUATE: { function: string; args?: unknown[]; world?: 'main' | 'isolated'; timeoutMs?: number };
  WAIT_TEXT: { texts: string[]; timeoutMs?: number };
  CONSOLE_READ: { types?: string[]; limit?: number };
  PAGE_META: Record<string, never>;
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
  | { type: 'agent:start'; tabId: number; userMessage: string }
  | { type: 'agent:stop'; tabId: number }
  | { type: 'agent:attach'; tabId: number }
  | { type: 'agent:resume'; tabId: number };

export type PortMsgToPanel =
  | { type: 'reasoning-delta'; text: string }
  | { type: 'text-delta'; text: string }
  | { type: 'tool-start'; name: string; args: string; callId: string }
  | { type: 'tool-end'; name: string; callId: string; ok: boolean; summary: string; output?: string; image?: string }
  | { type: 'paused'; reason: string }
  | { type: 'done'; finalText: string }
  | { type: 'error'; message: string }
  | { type: 'state'; status: 'idle' | 'running' | 'paused'; messageCount: number };
