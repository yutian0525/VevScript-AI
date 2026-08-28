// shared/messages.ts
// 三环境（background / content script / sidepanel）共享的消息协议。
// 设计决策：request/response 模式 + correlation id（设计 §4.4）；
// 例外：cs→bg 的 fire-and-forget 通知（见 CsToBgNotification）。

import type { ToolResult, Uid } from './types';

export interface BgToCsRequestMap {
  SNAPSHOT: { verbose?: boolean };
  CLICK: { uid: Uid; dblClick?: boolean };
  FILL: { uid: Uid; value: string };
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

/** cs→bg 的 fire-and-forget 通知（无 correlationId，无需 background 逐条应答）。 */
export interface CsToBgNotification {
  type: 'NETLOG_PUSH';
  payload: { entries: unknown[] };
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
