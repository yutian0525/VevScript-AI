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

/** SW → content → wrapper 下行事件类别（tabs.sendMessage GM_EVENT 的 kind）。 */
export type GmEventKind = 'VALUE_CHANGE' | 'MENU_CLICK' | 'NOTIF_CLICK' | 'TAB_EVENT';

export const gmReqEvent = (scriptId: string) => `gmreq:${scriptId}`;
export const gmResEvent = (scriptId: string) => `gmres:${scriptId}`;
export const gmEvtEvent = (scriptId: string) => `gmevt:${scriptId}`;
