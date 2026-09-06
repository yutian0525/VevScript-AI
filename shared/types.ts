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
  /** @homepage / @homepageURL（主页，TM 兼容双键名；纯展示不参与注入） */
  homepage?: string;
  /** @supportURL（反馈/支持页） */
  supportURL?: string;
  /** @icon / @iconURL（图标图片 URL，详情页头像） */
  iconURL?: string;
  /** @downloadURL（安装源） */
  downloadURL?: string;
  /** @updateURL（更新源） */
  updateURL?: string;
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

/** 启动/手动更新检查结果（独立于 UserScript：运行时状态，非解析投影，spec §1.2） */
export interface ScriptUpdateState {
  remoteVersion: string;
  checkedAt: number;
  status: 'available' | 'up-to-date' | 'error';
  /** status='error' 时的原因（HTTP 404 / 超时 / 解析失败…） */
  message?: string;
}

/** chrome.storage.local 键：脚本更新检查结果 map（scriptId → ScriptUpdateState，spec §1.2）。
 * 读写必须都走 WXT storage（它把 local: 当区域前缀剥离）——裸 browser.storage.local 会按字面量键查找，永远读不到。 */
export const UPDATE_STATE_KEY = 'local:scripts:update-state';

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
  /** 已支持的 grant（classifyGrants，spec §9.2） */
  grantSupported: string[];
  /** 不支持的 grant（列表页黄色警示） */
  grantUnsupported: string[];
  /** 原文总行数（text.split('\n').length），供模型判断读取策略（spec §4.3） */
  lines: number;
  /** 原文字符数 */
  bytes: number;
}

// ---------- Skill 系统（spec：skills-and-slash-commands）----------

export interface Skill {
  id: string;
  /** 显示名（可中文） */
  name: string;
  /** 斜杠调用名（唯一键，kebab-case ASCII） */
  command: string;
  /** 简述（注入上下文 + 浮层副标题，≤300 字符） */
  description: string;
  /** Markdown 指令正文（≤64KB） */
  content: string;
  enabled: boolean;
  /** 内置技能（安装时投放）：不可删除，可停用；升级时内容随扩展更新 */
  builtin?: boolean;
  createdAt: number;
  updatedAt: number;
}

/** 列表/摘要形状（无 content） */
export interface SkillSummary {
  id: string;
  name: string;
  command: string;
  description: string;
  enabled: boolean;
  builtin?: boolean;
  updatedAt: number;
}

// ---------- 输入框附件（聊天上传：纯文本 / 图片）----------

/** 用户在输入框上传的附件。text：读出的文件正文；image：压缩后的 dataURL。
 *  经 Port 的 agent:start 携带 → loop 组装进 user 消息（文本内联、图片作 image_url part）。 */
export interface ChatAttachment {
  kind: 'text' | 'image';
  /** 文件名（展示 + 内联包裹头） */
  name: string;
  /** 字节大小（展示用；kind=text 为原文字节数，kind=image 为压缩后估算） */
  size: number;
  /** kind=text：文件正文（UTF-8 解码后） */
  text?: string;
  /** kind=image：压缩后的 data URL（data:image/...;base64,...） */
  dataUrl?: string;
}
