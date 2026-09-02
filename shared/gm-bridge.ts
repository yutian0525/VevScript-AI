// shared/gm-bridge.ts
// GM 桥协议（spec §6）：page wrapper ↔ ISOLATED content script ↔ SW 三界共用的常量与 payload 类型。
// 事件名带 scriptId 后缀（gmreq/gmres/gmevt 三事件），token 防伪造（spec §6 确定性派生）。

/** 请求方向：wrapper → content。detail 形状（CustomEvent detail）。 */
export interface GmBridgeRequest {
  token: string;
  reqId: number;
  api: string;
  params: unknown[];
}

/** 响应方向：content → wrapper（同 reqId 配对）。 */
export interface GmBridgeResponse {
  reqId: number;
  ok: boolean;
  data?: unknown;
  error?: string;
}

/** SW → content → wrapper 下行事件（tabs.sendMessage GM_EVENT 的 payload）。 */
export type GmEventKind = 'VALUE_CHANGE' | 'MENU_CLICK' | 'NOTIF_CLICK' | 'TAB_EVENT';

export interface GmEventPayload {
  kind: GmEventKind;
  /** VALUE_CHANGE: { key, oldValue, newValue, remote }；MENU_CLICK: { key }；NOTIF_CLICK: { id, byUser }；TAB_EVENT: { tabId, closed } */
  data: Record<string, unknown>;
}

/** content script → SW：索取当前 URL 的桥 token 表（SW 用 matchUrl 算匹配脚本集）。 */
export interface GmBridgeTokens {
  entries: Array<{ scriptId: string; token: string }>;
}

export const gmReqEvent = (scriptId: string) => `gmreq:${scriptId}`;
export const gmResEvent = (scriptId: string) => `gmres:${scriptId}`;
export const gmEvtEvent = (scriptId: string) => `gmevt:${scriptId}`;
