// shared/types.ts

/** 通用工具结果：所有工具执行器的统一返回格式（设计 §4.3）。
 * 判别联合：成功时 ok=true 且可选 data；失败时 ok=false 且必有 error。 */
export type ToolResult<T = unknown> =
  | { ok: true; data?: T }
  | { ok: false; error: string };

/** 标签页概要信息 */
export interface TabInfo {
  tabId: number;
  url: string;
  title: string;
  active: boolean;
}

/** 快照里的元素 uid（content script 分配，见设计 §3） */
export type Uid = number;
