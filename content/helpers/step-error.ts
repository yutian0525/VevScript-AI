// content/helpers/step-error.ts
// helper 抛出的结构化错误（spec §5.2/§5.3）。单独成文件：events/wait/index 都要用，
// 放 index.ts 会造成循环 import。
import type { ScriptKind } from '../../shared/script-result';

/** 失败诊断附加字段。按 kind 填不同子集，序列化后进返回值的 failedAt。 */
export interface StepErrorDetail {
  /** 涉及的元素简要信息。 */
  element?: Record<string, unknown>;
  /** blocked 时的遮挡物。 */
  blockedBy?: Record<string, unknown>;
  /** locator 相关：命中数、放宽结果、相似候选。 */
  matched?: number;
  relaxed?: Record<string, number>;
  nearMiss?: unknown[];
  ambiguous?: unknown[];
  /** timeout 时：等待条件描述与已等时长。 */
  cond?: string;
  waited?: number;
  /** 可执行的修复建议。 */
  hint?: string;
  [k: string]: unknown;
}

/** helper 层抛出的结构化错误：kind 走 ScriptKind 八分类，detail 携带按 kind 的诊断子集。
 *  对象留在页内 world——scriptRunner 捕获后序列化 kind/message/detail 进返回值，不跨 world 传递。 */
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

/** 元素状态是否阻止交互。点击/输入前的前置检查。
 *  返回原因短句（进 message），null = 可交互。 */
export function disabledReason(el: Element): string | null {
  if (el.hasAttribute('disabled')) return 'disabled 属性';
  if (el.getAttribute('aria-disabled') === 'true') return 'aria-disabled="true"';
  return null;
}
