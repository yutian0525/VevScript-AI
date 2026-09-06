// shared/confirm.ts
// 通用确认抽象（三环境共享）：队列只管登记/广播/超时/解析，不含任何副作用。
// 所有文案/明细/按钮由生产者填 props；kind 仅供生产者区分自己的请求来源，队列/页面对其无特殊逻辑。

export type ConfirmKind = 'connect'; // 将来扩展：| 'script-op' 等

export interface ConfirmDetailRow {
  label: string; // "主机" / "方法" / "URL" / "来源"
  value: string;
  mono?: boolean; // 机器语言（host/url/method）走等宽
}

export interface ConfirmAction {
  decision: string; // 回传给生产者的决策标识
  label: string; // "允许一次" / "总是允许" / "拒绝"
  variant?: 'primary' | 'danger' | 'default'; // 映射 .btn 变体
  countdown?: boolean; // 是否在按钮上跑本地倒计时
}

export interface ConfirmRequest {
  confirmId: string;
  kind: ConfirmKind;
  title: string; // "跨域请求确认"
  message: string; // "脚本「My Script」请求跨域访问"
  rows: ConfirmDetailRow[];
  actions: ConfirmAction[];
  createdAt: number;
  timeoutMs: number; // 60_000
}

/** enqueueConfirm 入参：队列生成 confirmId/createdAt，生产者不传。 */
export type ConfirmSpec = Omit<ConfirmRequest, 'confirmId' | 'createdAt'>;

// ---- bg → 页面广播（fire-and-forget）----
export interface ConfirmPendingEvent {
  type: 'CONFIRM_PENDING';
  confirm: ConfirmRequest;
}
export interface ConfirmResolvedEvent {
  type: 'CONFIRM_RESOLVED';
  confirmId: string;
}
