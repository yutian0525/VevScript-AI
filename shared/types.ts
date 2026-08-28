// shared/types.ts

/** 通用工具结果：所有工具执行器的统一返回格式（设计 §4.3） */
export interface ToolResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

/** 标签页概要信息 */
export interface TabInfo {
  tabId: number;
  url: string;
  title: string;
  active: boolean;
}

/** 快照里的元素 uid（content script 分配，见设计 §3） */
export type Uid = number;
