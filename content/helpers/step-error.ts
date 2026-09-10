// content/helpers/step-error.ts
// waitFor 链路抛出的结构化错误（spec §5.2/§5.3）。单独成文件避免循环 import。

/** 失败诊断附加字段。按 kind 填不同子集。 */
export interface StepErrorDetail {
  /** 涉及的元素简要信息。 */
  element?: Record<string, unknown>;
  /** locator 相关：命中数、放宽结果、相似候选。 */
  matched?: number;
  /** timeout 时：等待条件描述与已等时长。 */
  cond?: string;
  waited?: number;
  /** 可执行的修复建议。 */
  hint?: string;
  [k: string]: unknown;
}

/** 失败分类。每类对应一个明确不同的修复方向。 */
export const SCRIPT_KINDS = [
  'locator-miss',       // 匹配 0 个 → 定位符错了
  'locator-ambiguous',  // 期望 1 个但匹配 N 个 → 加限定收窄
  'blocked',            // 找到了但被遮挡 → 先处理遮挡物
  'state',              // 找到了但 disabled/readonly/不可输入 → 前置条件没满足
  'timeout',            // waitFor 超时 → 条件写错或页面真没变化
  'assert',             // 断言失败 → 逻辑判断不成立
  'script-error',       // 调用方代码本身错 → 改代码
  'page-error',         // 页面 JS 抛错 → 操作触发页面 bug，换路径
] as const;

export type ScriptKind = (typeof SCRIPT_KINDS)[number];

/** waitFor 链路抛出的结构化错误：kind 走八分类，detail 携带按 kind 的诊断子集。
 *  content/wait.ts 捕获后把 message 与 detail.hint 并入 ToolResult 的 error。 */
export class StepError extends Error {
  readonly kind: ScriptKind;
  readonly detail: StepErrorDetail;

  constructor(kind: ScriptKind, message: string, detail: StepErrorDetail = {}) {
    super(message);
    this.name = 'StepError';
    this.kind = kind;
    this.detail = detail;
  }
}
