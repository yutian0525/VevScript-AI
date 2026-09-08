// shared/script-result.ts
// run_page_script 的返回值形状（spec §5）。设计原则：成功极简、失败极详——
// 这个不对称是控制 token 成本的关键（成功步一行 15~25 tokens，失败才展开诊断）。
//
// 【只放类型与常量】截断与序列化算法在 content/script-runtime.ts 的 scriptRunner 里内联：
// 它由 scripting.executeScript 序列化注入，不能引用模块作用域。此处的常量是那些内联值的
// 单一出处（改动时两边一起改，tests/shared/script-result.test.ts 锁死数字）。

/** 失败分类。每类对应一个明确不同的修复方向（spec §5.3）。
 *  顺序固定：schema 文案与技能文档按此列出。 */
export const SCRIPT_KINDS = [
  'locator-miss',       // 匹配 0 个 → 定位符错了
  'locator-ambiguous',  // 期望 1 个但匹配 N 个 → 加 nth/within 收窄
  'blocked',            // 找到了但被遮挡 → 先处理遮挡物
  'state',              // 找到了但 disabled/readonly/不可输入 → 前置条件没满足
  'timeout',            // waitFor 超时 → 条件写错或页面真没变化
  'assert',             // expect 失败 → 逻辑判断不成立
  'script-error',       // agent 代码本身错 → 改代码
  'page-error',         // 页面 JS 抛错 → 操作触发页面 bug，换路径
] as const;

export type ScriptKind = (typeof SCRIPT_KINDS)[number];

/** 一条成功步的记录。op 之外的字段按 op 类型不同（on/value/key/cond/waited/matched…）。 */
export interface TraceStep {
  i: number;
  op: string;
  [k: string]: unknown;
}

/** trace 里也可能出现折叠标记（超 TRACE_CAP 步时中间段被折叠）。 */
export type TraceEntry = TraceStep | { collapsed: number };

export interface DataTruncation {
  returned: number;
  total: number;
  hint: string;
}

// ---------- 上限常量（spec §5.5）----------
// DATA_CHAR_CAP 单位是 UTF-16 code units（字符串 .length 口径），与 js-balance 的 bytes
// 同口径——bytes 也是 UTF-16 code units 非严格字节（shared/types.ts 的 ScriptSummary.bytes、
// storage/scripts.ts 直接取 text.length）。
export const DATA_CHAR_CAP = 8192;      // UTF-16 code units，与 js-balance 的 bytes 同口径
export const TRACE_CAP = 50;
export const TRACE_KEEP = 15;           // 折叠时前后各保留
export const LOG_CAP = 30;
export const LOG_CHAR_CAP = 500;
export const SERIALIZE_DEPTH_CAP = 6;
export const SERIALIZE_ARRAY_CAP = 200;
