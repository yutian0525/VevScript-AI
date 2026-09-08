// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { createHelpers } from '../../../content/helpers/index';
import { StepError } from '../../../content/helpers/step-error';
import { resetUidMap } from '../../../content/snapshot/build';

const setup = () => { resetUidMap(); document.body.innerHTML = ''; return createHelpers(); };

/** 同步 helper 调用转 StepError（$/$$/text/log/expect 是同步的）。 */
const syncErr = (fn: () => unknown): StepError => {
  try { fn(); throw new Error('expected StepError, but resolved'); }
  catch (e) { if (e instanceof StepError) return e; throw e; }
};

describe('helper 工厂', () => {
  beforeEach(() => { resetUidMap(); document.body.innerHTML = ''; });

  it('暴露恰好 10 个函数（窄 API 面）', () => {
    const { helpers } = setup();
    expect(Object.keys(helpers).sort()).toEqual(
      ['$', '$$', 'click', 'expect', 'hover', 'log', 'press', 'text', 'type', 'waitFor'],
    );
  });

  it('$ 命中单个返回元素并记 trace', () => {
    const { helpers, ctx } = setup();
    document.body.innerHTML = '<button>提交</button>';
    const el = (helpers.$ as (l: unknown) => Element)({ text: '提交' });
    expect(el.tagName).toBe('BUTTON');
    expect(ctx.trace).toEqual([{ i: 1, op: '$', on: 'button "提交"' }]);
  });

  it('$ 命中 0 个抛 locator-miss 并带 relaxed/nearMiss/hint', () => {
    const { helpers } = setup();
    document.body.innerHTML = '<a class="next-page">下一页 ›</a>';
    const err = syncErr(() => (helpers.$ as (l: unknown) => Element)({ role: 'button', text: '下一页' }));
    expect(err.kind).toBe('locator-miss');
    expect(err.detail.matched).toBe(0);
    expect(err.detail.relaxed).toBeDefined();
    expect(err.detail.nearMiss).toHaveLength(1);
    expect(err.detail.hint).toContain('下一页 ›');
  });

  it('$ 命中多个抛 locator-ambiguous 并列候选', () => {
    const { helpers } = setup();
    document.body.innerHTML = '<button>删</button><button>删</button>';
    const err = syncErr(() => (helpers.$ as (l: unknown) => Element)({ text: '删' }));
    expect(err.kind).toBe('locator-ambiguous');
    expect(err.detail.matched).toBe(2);
    expect(err.detail.ambiguous).toHaveLength(2);
    expect(err.detail.hint).toContain('nth');
  });

  it('$$ 返回数组、命中数进 trace（含 0 命中不抛错）', () => {
    const { helpers, ctx } = setup();
    document.body.innerHTML = '<button>a</button><button>b</button>';
    const els = (helpers.$$ as (l: unknown) => Element[])({ role: 'button' });
    expect(els).toHaveLength(2);
    expect(ctx.trace[0]).toMatchObject({ op: '$$', matched: 2 });

    const none = (helpers.$$ as (l: unknown) => Element[])({ text: '不存在' });
    expect(none).toEqual([]);
    expect(ctx.trace[1]).toMatchObject({ op: '$$', matched: 0 });
  });

  it('$ 接受 opts.within', () => {
    const { helpers } = setup();
    document.body.innerHTML = '<div id="a"><h2>A</h2></div><div id="b"><h2>B</h2></div>';
    const el = (helpers.$ as (l: unknown, o: unknown) => Element)('h2', { within: document.getElementById('b')! });
    expect(el.textContent).toBe('B');
  });

  it('click 成功记 trace（不记内部 6 个事件）', async () => {
    const { helpers, ctx } = setup();
    document.body.innerHTML = '<button>确定</button>';
    const el = document.querySelector('button')!;
    await (helpers.click as (e: Element) => Promise<void>)(el);
    expect(ctx.trace).toEqual([{ i: 1, op: 'click', on: 'button "确定"' }]);
  });

  it('type 记 trace 含 value', async () => {
    const { helpers, ctx } = setup();
    document.body.innerHTML = '<input type="text">';
    await (helpers.type as (e: Element, v: string) => Promise<void>)(document.querySelector('input')!, 'abc');
    expect(ctx.trace[0]).toMatchObject({ op: 'type', value: 'abc' });
  });

  it('type 的长 value 在 trace 里截断', async () => {
    const { helpers, ctx } = setup();
    document.body.innerHTML = '<input type="text">';
    await (helpers.type as (e: Element, v: string, o: unknown) => Promise<void>)(
      document.querySelector('input')!, 'x'.repeat(200), { instant: true },
    );
    // TraceEntry 是 TraceStep | {collapsed} 联合，直接 cast 报不重叠——经 unknown 中转
    expect(String((ctx.trace[0] as unknown as { value: string }).value).length).toBeLessThanOrEqual(61);
  });

  it('press 记 trace 含 key', async () => {
    const { helpers, ctx } = setup();
    await (helpers.press as (k: string) => Promise<void>)('Enter');
    expect(ctx.trace[0]).toMatchObject({ op: 'press', key: 'Enter' });
  });

  it('waitFor 记 trace 含 cond 与 waited', async () => {
    const { helpers, ctx } = setup();
    document.body.innerHTML = '<div role="dialog">x</div>';
    await (helpers.waitFor as (c: unknown) => Promise<unknown>)({ role: 'dialog' });
    expect(ctx.trace[0]).toMatchObject({ op: 'waitFor' });
    expect(String((ctx.trace[0] as unknown as { cond: string }).cond)).toContain('dialog');
    expect((ctx.trace[0] as unknown as { waited: number }).waited).toBeGreaterThanOrEqual(0);
  });

  it('失败的步骤也占 i 序号（trace 与 failedAt.i 对得上）', async () => {
    const { helpers, ctx } = setup();
    document.body.innerHTML = '<button>a</button>';
    await (helpers.click as (e: Element) => Promise<void>)(document.querySelector('button')!);
    syncErr(() => (helpers.$ as (l: unknown) => Element)({ text: '不存在' }));
    expect(ctx.stepCount).toBe(2);
    expect(ctx.trace).toHaveLength(1);   // 失败步不进 trace（进 failedAt）
  });

  it('text 归一化取文本，不记 trace（纯读）', () => {
    const { helpers, ctx } = setup();
    document.body.innerHTML = '<div>  多  空白\n 文本 </div>';
    const t = (helpers.text as (e: Element) => string)(document.querySelector('div')!);
    expect(t).toBe('多 空白 文本');
    expect(ctx.trace).toHaveLength(0);
  });

  it('text 对 null/undefined 返回空串（不抛错打断脚本）', () => {
    const { helpers } = setup();
    expect((helpers.text as (e: unknown) => string)(null)).toBe('');
    expect((helpers.text as (e: unknown) => string)(undefined)).toBe('');
  });

  it('log 进 logs 不进 trace，多参数拼接', () => {
    const { helpers, ctx } = setup();
    (helpers.log as (...a: unknown[]) => void)('第', 1, '页', { n: 2 });
    expect(ctx.logs).toEqual(['第 1 页 {"n":2}']);
    expect(ctx.trace).toHaveLength(0);
  });

  it('log 对循环引用对象不抛错', () => {
    const { helpers, ctx } = setup();
    const a: Record<string, unknown> = {};
    a.self = a;
    (helpers.log as (...a: unknown[]) => void)(a);
    expect(ctx.logs).toHaveLength(1);
  });

  it('expect 条件为真时静默通过', () => {
    const { helpers, ctx } = setup();
    (helpers.expect as (c: unknown, m: string) => void)(true, '不该触发');
    expect(ctx.trace).toHaveLength(0);
  });

  it('expect 条件为假时抛 assert 类 StepError', () => {
    const { helpers } = setup();
    const err = syncErr(() => (helpers.expect as (c: unknown, m: string) => void)(false, '仍在登录页'));
    expect(err.kind).toBe('assert');
    expect(err.message).toContain('仍在登录页');
    expect(err.detail.hint).toContain('screenshot');
  });
});
