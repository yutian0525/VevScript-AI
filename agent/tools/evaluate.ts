// agent/tools/evaluate.ts
// evaluate_script 工具（设计 §6）：scripting.executeScript 注入固定包裹器，
// 在目标页 eval 模型传入的 function 字符串并 await 结果。结果须可 JSON 序列化。
import type { ToolResult } from '../../shared/types';

/** 在目标页运行的包裹器：eval 模型代码字符串 → 调用 → await → 归一化结果。 */
async function pageRunner(
  code: string,
  args: unknown[],
): Promise<{ __ok: true; __value: unknown } | { __ok: false; __error: string }> {
  try {
    // eslint-disable-next-line no-eval
    const fn = (0, eval)(`(${code})`);
    const value = typeof fn === 'function' ? await fn(...args) : fn;
    return { __ok: true, __value: value };
  } catch (e) {
    return { __ok: false, __error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
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
