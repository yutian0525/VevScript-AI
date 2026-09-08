// content/helpers/index.ts
// helper 工厂（spec §3.1）：组装 10 个函数 + trace/logs 收集。
// 窄 API 面是刻意的（原则 1：原生一行能写对的不包）——没有 select/waitGone/exists/
// scrollTo/extract，它们分别合进 type/waitFor、用 $$().length、用原生一行、用原生 .map()。
import type { Locator } from '../../shared/types';
import type { TraceEntry } from '../../shared/script-result';
import { queryLocator, describeLocator, norm, type QueryOpts } from '../locator';
import { diagnoseMiss, diagnoseAmbiguous } from '../locator-diagnose';
import { StepError } from './step-error';
import { click, type as typeInto, hover, press, briefOf, type ClickOpts, type TypeOpts, type PressArg, type PressMods } from './events';
import { waitFor, describeCond, type WaitCond, type WaitOpts } from './wait';

const TRACE_VALUE_CAP = 60;

export interface HelperCtx {
  trace: TraceEntry[];
  logs: string[];
  /** 已执行步数（含失败的那步）。失败时 failedAt.i 取它，故与 trace 长度可能不等。 */
  stepCount: number;
}

/** 元素在 trace/错误里的短描述：`button "确定"`。 */
function onOf(el: Element): string {
  const b = briefOf(el);
  const text = String(b.text ?? '');
  return text ? `${b.tag} "${text}"` : String(b.tag);
}

function cap(s: string): string {
  return s.length > TRACE_VALUE_CAP ? `${s.slice(0, TRACE_VALUE_CAP)}…` : s;
}

/** log 的参数拼接：对象 JSON 化，循环引用等不可序列化的退回 Object.prototype.toString。 */
function stringifyArg(a: unknown): string {
  if (typeof a === 'string') return a;
  if (a === null || a === undefined || typeof a !== 'object') return String(a);
  try {
    return JSON.stringify(a) ?? String(a);
  } catch {
    return Object.prototype.toString.call(a);
  }
}

export function createHelpers(): { helpers: Record<string, unknown>; ctx: HelperCtx } {
  const ctx: HelperCtx = { trace: [], logs: [], stepCount: 0 };

  /** 开一步：递增序号并返回记录函数。失败时不调记录函数，该步只体现在 stepCount。 */
  const step = (): ((op: string, fields?: Record<string, unknown>) => void) => {
    ctx.stepCount += 1;
    const i = ctx.stepCount;
    return (op, fields = {}) => { ctx.trace.push({ i, op, ...fields }); };
  };

  /** 给 StepError 盖上失败步的 op 戳。失败步不进 trace，failedAt（Task 18 组装）
   *  的 op 全靠它——Task 18 层只能按 kind 猜，而 state/blocked 由四个动作共享抛出，
   *  仅凭 kind 无法归因（审查裁定：op 是 Task 17 层的静态已知量，必须在此带上）。 */
  const stampOp = (e: unknown, op: string): unknown => {
    if (e instanceof StepError && e.detail.op == null) e.detail.op = op;
    return e;
  };

  const $ = (loc: Locator, opts: QueryOpts = {}): Element => {
    const rec = step();
    let res: ReturnType<typeof queryLocator>;
    try {
      res = queryLocator(loc, opts);
    } catch (e) {
      throw new StepError('script-error', `locator 非法：${e instanceof Error ? e.message : String(e)}`, {
        op: '$',
        hint: '修正 locator 语法。CSS 选择器要合法；语义 locator 至少要有 role/text/near 之一。',
      });
    }
    const root = opts.within ?? document.body;

    if (res.elements.length === 0) {
      const d = diagnoseMiss(loc, root);
      throw new StepError('locator-miss', `未找到匹配 ${describeLocator(loc)} 的元素`, {
        op: '$', matched: 0, relaxed: d.relaxed, nearMiss: d.nearMiss, hint: d.hint,
      });
    }
    if (res.elements.length > 1) {
      const d = diagnoseAmbiguous(loc, res.elements);
      throw new StepError('locator-ambiguous', `${describeLocator(loc)} 命中 ${res.elements.length} 个元素，无法确定操作哪个`, {
        op: '$', matched: d.matched, ambiguous: d.ambiguous, hint: d.hint,
      });
    }
    const el = res.elements[0]!;
    const fields: Record<string, unknown> = { on: onOf(el) };
    if (res.nearTier) fields.nearTier = res.nearTier;
    if (res.skippedFrames) fields.skippedFrames = res.skippedFrames;
    rec('$', fields);
    return el;
  };

  const $$ = (loc: Locator, opts: QueryOpts = {}): Element[] => {
    const rec = step();
    let res: ReturnType<typeof queryLocator>;
    try {
      res = queryLocator(loc, opts);
    } catch (e) {
      throw new StepError('script-error', `locator 非法：${e instanceof Error ? e.message : String(e)}`, {
        op: '$$',
        hint: '修正 locator 语法。CSS 选择器要合法；语义 locator 至少要有 role/text/near 之一。',
      });
    }
    const fields: Record<string, unknown> = { matched: res.elements.length };
    if (typeof loc === 'string') fields.sel = loc;
    if (res.skippedFrames) fields.skippedFrames = res.skippedFrames;
    rec('$$', fields);
    return res.elements;
  };

  /** async 动作的统一包裹：StepError 盖 op 戳后原样重抛。 */
  const stamped = async (op: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (e) {
      throw stampOp(e, op);
    }
  };

  const helpers = {
    $, $$,

    click: async (el: Element, opts?: ClickOpts): Promise<void> => {
      const rec = step();
      await stamped('click', () => click(el, opts));
      rec('click', { on: onOf(el) });
    },

    type: async (el: Element, value: string, opts?: TypeOpts): Promise<void> => {
      const rec = step();
      await stamped('type', () => typeInto(el, value, opts));
      rec('type', { on: onOf(el), value: cap(value) });
    },

    hover: async (el: Element): Promise<void> => {
      const rec = step();
      await stamped('hover', () => hover(el));
      rec('hover', { on: onOf(el) });
    },

    press: async (arg: PressArg, mods?: PressMods): Promise<void> => {
      const rec = step();
      await stamped('press', () => press(arg, mods));
      rec('press', { key: typeof arg === 'string' ? arg : arg.key });
    },

    waitFor: async (cond: WaitCond, opts?: WaitOpts): Promise<{ waited: number }> => {
      const rec = step();
      let r: { waited: number };
      try {
        r = await waitFor(cond, opts);
      } catch (e) {
        throw stampOp(e, 'waitFor');
      }
      rec('waitFor', { cond: describeCond(cond), waited: r.waited });
      return r;
    },

    /** 归一化取文本。纯读不记 trace（成功极简原则）；空值返回空串不打断脚本。 */
    text: (el: Element | null | undefined): string => (el ? norm(el.textContent ?? '') : ''),

    /** 埋点。进 logs 不进 trace——两者分开，避免同一句话付两遍 token。 */
    log: (...args: unknown[]): void => { ctx.logs.push(args.map(stringifyArg).join(' ')); },

    /** 断言。失败即中止——不在错误状态上继续操作（spec §9.7）。 */
    expect: (cond: unknown, msg: string): void => {
      if (cond) return;
      throw new StepError('assert', `断言失败：${msg}`, {
        op: 'expect',
        hint: '预期与实际不符，说明对页面状态的理解有误。用 query_page 看当前实际内容；若 trace 各步都正常但结果不对，重跑时传 screenshot:"on-failure" 看页面实况。',
      });
    },
  };

  return { helpers, ctx };
}
