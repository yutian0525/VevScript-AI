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

// 握手（收口「早到 gmreq 竞态」）：wrapper 注入执行可能早于桥宿主挂 gmreq 监听（脚本
// @run-at document-end/start，宿主在 document_idle + 异步拉 token 后才 attachFor）。
// wrapper 派发 gmhello 宣告就绪并问询；宿主挂好 gmreq 监听后派发 gmhost 宣告就绪，
// 且收到 gmhello 时重发 gmhost（覆盖「宿主先到、wrapper 后到漏接首个 gmhost」的反向时序）。
export const gmHelloEvent = (scriptId: string) => `gmhello:${scriptId}`;
export const gmHostEvent = (scriptId: string) => `gmhost:${scriptId}`;
