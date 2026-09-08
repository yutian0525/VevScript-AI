// agent/tools/page-script.ts
// run_page_script 工具（spec §4.1/§5.4/§8）。SW 侧只做四件事：
// 注入 scriptRunner、超时竞速、合并页面错误、按需截图。返回值的形状由页内 runner 定好。
import type { ToolResult } from '../../shared/types';
import { scriptRunner, type RunnerResult } from '../../content/script-runtime';
import { readConsole } from '../../background/observe-store';
import { doScreenshot } from './screenshot';

export type ScreenshotPolicy = 'never' | 'on-failure' | 'always';

export interface RunPageScriptArgs {
  script: string;
  world?: 'isolated' | 'main';
  timeoutMs?: number;
  screenshot?: ScreenshotPolicy;
}

/** 页内 runner 的返回值 + SW 侧补充的字段（超时上限回显 + MAIN world 提示）。 */
type RunnerOut = RunnerResult & { timeoutMs?: number; worldNotice?: string };

const DEFAULT_TIMEOUT = 30_000;   // 脚本内含多次 waitFor 是常态，故远大于 evaluate_script 的 5s
const MAX_TIMEOUT = 120_000;

export async function doRunPageScript(tabId: number, args: RunPageScriptArgs): Promise<ToolResult> {
  if (!args?.script) return { ok: false, error: 'run_page_script 缺少 script 参数' };

  const world = args.world === 'main' ? 'MAIN' : 'ISOLATED';
  // 缺省远大于 evaluate_script 的 5s（脚本内含多次 waitFor 是常态）；夹在 [1s, 120s]——
  // 更小则 race 判定粒度无意义（注入往返本身就要几十 ms），更大则卡死的脚本占住 SW 往返过久。
  const timeoutMs = Math.min(Math.max(1000, args.timeoutMs ?? DEFAULT_TIMEOUT), MAX_TIMEOUT);
  const policy: ScreenshotPolicy = args.screenshot ?? 'never';
  const startedAt = Date.now();

  // MAIN world 没有 helper（工厂挂在 ISOLATED 的 globalThis，见 Task 22）。
  // 这句随返回值回给 agent，避免它在 MAIN 里反复试 $(uid)——注意 MAIN 里可用的是
  // 页面原生 API，uid 表归 ISOLATED 世界所有，故 MAIN 拿 uid 没有意义。
  const worldNotice = world === 'MAIN'
    ? 'MAIN world：可读写页面自身的 JS 变量，但没有 helper（$ / click / waitFor 等均不可用，log 例外），uid 也不可用（uid 表属于 ISOLATED 世界）。请写原生 DOM 代码，或把 world 换成 isolated 以获得完整 helper。'
    : undefined;

  const exec = browser.scripting.executeScript({
    target: { tabId },
    world,
    func: scriptRunner,
    args: [args.script],
  }) as Promise<Array<{ result?: RunnerResult }>>;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'__timeout'>((res) => {
    timer = setTimeout(() => res('__timeout'), timeoutMs);
  });

  let runner: RunnerOut;
  try {
    const raced = await Promise.race([exec, timeout]);
    if (raced === '__timeout') {
      // 超时时页内 trace 拿不回来（执行仍在进行），但 error/hint 要明确告知「可能仍在跑」
      // 并给出可执行的下一步——这比干巴巴一句「超时」有用得多。
      return finish(tabId, startedAt, policy, {
        ok: false, kind: 'timeout',
        error: `run_page_script 超时（${timeoutMs}ms），脚本可能仍在页面中运行`,
        hint: '脚本整体超时。常见原因：某个 waitFor 的条件永不满足（给它更短的 timeout 以便快速失败）、脚本里有死循环、或页面持续有网络活动导致 waitFor({idle}) 等不到。把长脚本拆成几段分别执行，能定位到是哪一段卡住。',
        timeoutMs, worldNotice,
      });
    }
    const r = raced[0]?.result;
    if (!r) {
      return finish(tabId, startedAt, policy, {
        ok: false, kind: 'script-error',
        error: 'run_page_script 无返回（页面可能已卸载或导航）',
        hint: '脚本执行期间页面发生了导航或被关闭。若脚本本身会触发跳转，把跳转后的操作拆成下一次调用（导航会重置页内运行时）。',
        timeoutMs, worldNotice,
      });
    }
    runner = { ...r, timeoutMs, worldNotice };
  } catch (err) {
    return finish(tabId, startedAt, policy, {
      ok: false, kind: 'script-error',
      error: `run_page_script 失败：${err instanceof Error ? err.message : String(err)}`,
      hint: '注入失败。该页可能不允许注入（受限页/扩展商店页），或标签页已关闭。用 list_pages 确认目标页状态。',
      timeoutMs, worldNotice,
    });
  } finally {
    if (timer) clearTimeout(timer);
  }

  return finish(tabId, startedAt, policy, runner);
}

/** 合并页面错误 + 按需截图 + 组装 ToolResult。 */
async function finish(
  tabId: number, startedAt: number, policy: ScreenshotPolicy, runner: RunnerOut,
): Promise<ToolResult> {
  // ok/error 提到 ToolResult 顶层，其余（trace/logs/data/kind/failedAt/hint/url/
  // worldNotice/timeoutMs…）进 data。undefined 字段 JSON 序列化时自然省略。
  const data: Record<string, unknown> = { ...runner };
  delete data.ok;
  delete data.error;

  // 页面自己抛的错误（Phase 3b 的 hook 缓冲白拿），按时间窗只取本次执行期间的。
  // readConsole 返回最新在前，故「最后一条」是数组头部。关键价值是区分
  // 「我的脚本错了」与「我触发了页面 bug」——两者修复方向相反。
  const errors = readConsole(tabId, { level: 'error', limit: 50 }).filter((e) => e.ts >= startedAt);
  data.pageErrors = errors.length;
  if (errors.length && !runner.ok) data.lastPageError = errors[0]!.text;

  const need = policy === 'always' || (policy === 'on-failure' && !runner.ok);
  if (need) {
    // 截图失败不影响主结果——它是兜底通道，拿不到只少一份信息
    const shot = await doScreenshot(tabId, { format: 'jpeg' });
    if (shot.ok) data.screenshot = (shot.data as { screenshot?: string }).screenshot;
    else data.screenshotError = shot.error;
  }

  // 失败也带 data：kind/trace/failedAt/hint/pageErrors 等结构化诊断随返回值到达 loop 层。
  // ToolResult 判别联合的失败分支类型上没有 data——这是既有类型面的收窄，value 层带出
  // 后由 loop 的 tool 消息序列化消费（Task 21 接线时 toToolContent 需同步支持失败分支）。
  return runner.ok
    ? { ok: true, data }
    : ({ ok: false, error: runner.error ?? '脚本执行失败', data } as ToolResult);
}
