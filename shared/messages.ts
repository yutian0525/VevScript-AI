// shared/messages.ts
// 三环境（background / content script / sidepanel）共享的消息协议。
// 设计决策：全部 request/response 模式 + correlation id（设计 §4.4）。

import type { ToolResult } from './types';

export interface BgToCsRequestMap {
  SNAPSHOT: { verbose?: boolean };
  CLICK: { uid: number; dblClick?: boolean };
  FILL: { uid: number; value: string };
  HOVER: { uid: number };
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

export interface CsToBgRequestMap {
  NETLOG_PUSH: { entries: unknown[] };
}

export type CsToBgRequest = {
  [K in keyof CsToBgRequestMap]: {
    type: K;
    correlationId: string;
    payload: CsToBgRequestMap[K];
  };
}[keyof CsToBgRequestMap];

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
