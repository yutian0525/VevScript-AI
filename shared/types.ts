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

// ---- Phase 4：脚本池（spec §4）----

export type ScriptRunAt = 'document_start' | 'document_end' | 'document_idle';
export type ScriptWorld = 'USER_SCRIPT' | 'MAIN';
export type ScriptSource = 'user' | 'agent' | 'import';

/** TM 导入保留的展示性元数据（不参与注入） */
export interface UserScriptMeta {
  namespace?: string;
  version?: string;
  author?: string;
  description?: string;
  /** @grant 记录；仅用于「需要 GM_*（本扩展不支持）」警告徽标 */
  grants?: string[];
  /** @connect 域名白名单（GM_xmlhttpRequest 跨域放行表，spec §8.1） */
  connects?: string[];
  /** @require URL 列表（创建/更新时预取，wrapper 前置拼接） */
  requires?: string[];
  /** @resource name → url（GM_getResourceText 的数据源） */
  resources?: Record<string, string>;
  noframes?: boolean;
}

export interface UserScript {
  id: string;
  /** 完整 .user.js 原文（含 ==UserScript== 头）——唯一真源（修订 2026-09-02）；name/matches/code/runAt/world/meta 均为保存时解析生成的投影 */
  text: string;
  name: string;
  enabled: boolean;
  matches: string[];
  code: string;
  runAt: ScriptRunAt;
  world: ScriptWorld;
  source: ScriptSource;
  meta?: UserScriptMeta;
  createdAt: number;
  updatedAt: number;
}

/** 列表/摘要形状（无 code） */
export interface ScriptSummary {
  id: string;
  name: string;
  matches: string[];
  enabled: boolean;
  source: ScriptSource;
  runAt: ScriptRunAt;
  world: ScriptWorld;
  updatedAt: number;
  description?: string;
  hasGrants: boolean;
  /** SW 错误环形缓冲当前条数（0 = 无错误；spec §9.1） */
  errorCount: number;
  /** 有 @require（资源缺失时详情页提示，spec §9.4） */
  hasRequires: boolean;
}
