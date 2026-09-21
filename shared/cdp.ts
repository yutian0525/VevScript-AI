// shared/cdp.ts
// 深度观测（CDP）的跨环境类型：SW 权威状态 + 消息协议。
export type DeepObserveStatus = 'off' | 'on' | 'error';

export interface DeepObserveState {
  tabId: number;
  status: DeepObserveStatus;
  /** status==='error' 时的原因文案（附着失败 / DevTools 占用）。 */
  reason?: string;
}

/** SW → 面板广播（fire-and-forget，面板按 tabId 过滤）。 */
export interface DeepObserveStateNotification {
  type: 'DEEP_OBSERVE_STATE';
  payload: { state: DeepObserveState };
}

export type DeepObserveRequest =
  | { type: 'DEEP_OBSERVE_GET'; tabId: number }
  | { type: 'DEEP_OBSERVE_SET'; tabId: number; enabled: boolean };
