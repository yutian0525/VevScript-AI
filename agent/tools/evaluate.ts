// agent/tools/evaluate.ts
// evaluate_script 工具（设计 §6）：scripting.executeScript 注入固定包裹器，
// 在目标页 eval 模型传入的 function 字符串并 await 结果。结果须可 JSON 序列化。
import type { ToolResult } from '../../shared/types';

/**
 * 在目标页运行的包裹器：eval 模型代码字符串 → 调用 → await → 归一化结果。
 * 必须完全自包含（会被 scripting.executeScript 序列化注入页面，不能引用模块作用域变量）。
 * 导出仅为单测；运行时由 executeScript 注入。
 */
export async function pageRunner(
  code: string,
  args: unknown[],
): Promise<{ __ok: true; __value: unknown } | { __ok: false; __error: string }> {
  // 自包含的错误归一化：页面里 reject/throw 的常常不是 Error（如图片加载失败抛 DOM
  // error Event、Web API 抛 DOMException）。裸 String(e) 会得到 "[object Event]" 丢光线索，
  // 让调用方只能盲猜。这里针对各类抛出物榨出可诊断信息。
  const describeError = (e: unknown): string => {
    const cap = (s: string) => (s.length > 500 ? `${s.slice(0, 500)}…` : s);
    // DOMException（如 SecurityError / 跨域 canvas tainted）继承自 Error，须先于 Error 判定
    if (typeof DOMException !== 'undefined' && e instanceof DOMException) {
      return cap(`DOMException(${e.name}): ${e.message}`);
    }
    if (e instanceof Error) {
      return cap(`${e.name}: ${e.message}`);
    }
    // DOM Event（如 <img>/<script> 加载失败的 error 事件）——提取事件类型与目标资源
    const ev = e as { type?: unknown; target?: unknown; message?: unknown };
    const isEvent =
      (typeof Event !== 'undefined' && e instanceof Event) ||
      (e != null && typeof ev.type === 'string' && 'target' in (e as object));
    if (isEvent) {
      const t = ev.target as { tagName?: unknown; src?: unknown; href?: unknown } | null;
      const tag = t && typeof t.tagName === 'string' ? t.tagName.toLowerCase() : '';
      const url = t ? (t.src ?? t.href) : undefined;
      const parts = [`${String(ev.type)} 事件`];
      if (tag) parts.push(`<${tag}>`);
      if (typeof url === 'string' && url) parts.push(`src/href=${url}`);
      if (typeof ev.message === 'string' && ev.message) parts.push(ev.message);
      return cap(`资源/事件错误：${parts.join(' ')}`);
    }
    if (e === null) return 'null';
    if (e === undefined) return 'undefined';
    if (typeof e === 'object') {
      // 普通对象：优先 message 字段，否则尝试 JSON 序列化
      const msg = (e as { message?: unknown }).message;
      if (typeof msg === 'string' && msg) return cap(msg);
      try {
        return cap(JSON.stringify(e));
      } catch {
        return cap(Object.prototype.toString.call(e));
      }
    }
    return cap(String(e));
  };
  try {
    // eslint-disable-next-line no-eval
    const fn = (0, eval)(`(${code})`);
    const value = typeof fn === 'function' ? await fn(...args) : fn;
    return { __ok: true, __value: value };
  } catch (e) {
    return { __ok: false, __error: describeError(e) };
  }
}

export async function doEvaluate(
  tabId: number,
  args: { function: string; args?: unknown[]; world?: 'main' | 'isolated'; timeoutMs?: number },
): Promise<ToolResult> {
  if (!args.function) return { ok: false, error: 'evaluate_script 缺少 function 参数' };
  const world = args.world === 'isolated' ? 'ISOLATED' : 'MAIN';
  const timeoutMs = args.timeoutMs ?? 5000;

  const exec = browser.scripting.executeScript({
    target: { tabId },
    world,
    func: pageRunner,
    args: [args.function, args.args ?? []],
  }) as Promise<Array<{ result?: { __ok: boolean; __value?: unknown; __error?: string } }>>;

  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<'__timeout'>((res) => {
    timer = setTimeout(() => res('__timeout'), timeoutMs);
  });

  try {
    const raced = await Promise.race([exec, timeout]);
    if (raced === '__timeout') return { ok: false, error: `evaluate_script 超时（${timeoutMs}ms）` };
    const wrapped = raced[0]?.result;
    if (!wrapped) return { ok: false, error: 'evaluate_script 无返回（页面可能已卸载）' };
    if (!wrapped.__ok) return { ok: false, error: `页面执行出错：${wrapped.__error ?? '未知'}` };
    try {
      JSON.stringify(wrapped.__value);
    } catch {
      return {
        ok: false,
        error: '结果无法 JSON 序列化，请让脚本返回标量/纯对象（如取 .textContent 而非 DOM 节点）',
      };
    }
    return { ok: true, data: { result: wrapped.__value } };
  } catch (err) {
    return { ok: false, error: `evaluate_script 失败：${err instanceof Error ? err.message : String(err)}` };
  } finally {
    clearTimeout(timer!);
  }
}
