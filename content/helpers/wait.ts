// content/helpers/wait.ts
// waitFor 四种条件形式（spec §3.5）：元素出现 / 元素消失 / 网络静默 / 自定义谓词。
// 合成一个函数而非四个（原则 1）；等待写不好就是死循环或误判，故封装在此一次写对。
import type { Locator } from '../../shared/types';
import { queryLocator, describeLocator } from '../locator';
import { StepError } from './step-error';

export interface GoneCond { gone: Locator }
export interface IdleCond { idle: number }
export type Predicate = () => boolean | Promise<boolean>;
export type WaitCond = Locator | GoneCond | IdleCond | Predicate;

export interface WaitOpts {
  /** 缺省 10000ms。 */
  timeout?: number;
  /** 轮询间隔，缺省 100ms。 */
  interval?: number;
}

const DEFAULT_TIMEOUT = 10_000;
const DEFAULT_INTERVAL = 100;

function isGone(c: WaitCond): c is GoneCond {
  return typeof c === 'object' && c !== null && 'gone' in c;
}
function isIdle(c: WaitCond): c is IdleCond {
  return typeof c === 'object' && c !== null && 'idle' in c;
}

export function describeCond(cond: WaitCond): string {
  if (typeof cond === 'function') return '自定义谓词';
  if (isIdle(cond)) return `网络静默 ${cond.idle}ms`;
  if (isGone(cond)) return `${describeLoc(cond.gone)} 消失`;
  return `${describeLoc(cond)} 出现`;
}

function describeLoc(loc: Locator): string {
  if (typeof loc === 'string') return `"${loc}"`;
  if (typeof loc === 'number') return `uid ${loc}`;   // 见下方 uid 局限注释
  return describeLocator(loc);   // 语义 locator 复用 locator.ts 的可读描述
}

// uid 条件的局限（文档性，写给 run_page_script 的调用方）：uid 是某次快照分配的
// 快照期映射，页面 DOM 一变（增删节点、翻页、框架重渲染）就可能与真实元素错位
// ——waitFor(uid) 等到的可能是「快照旧位置上如今长着别的元素的节点」。且等待期间
// 元素若尚未出现，快照根本来不及给它编 uid，waitFor(uid) 天然只适合「等快照里
// 已有 uid 的元素的状态变化（出现→消失）」。新出现的元素请用 CSS/语义 locator。

/** 已加载资源条数。网络静默判定的依据：连续 idle ms 内条数不增即视为静默。
 *  已知局限（真实浏览器）：resource buffer 默认上限 250 条，超限后按
 *  clearResourceTimings 默认行为整批清空——计数会骤降再从 0 重建，「计数变化」
 *  不再等价于「有新请求」。对 waitFor 的判定影响是双向的：清空被当成新活动
 *  重置静默窗口（保守方向，只是多等）；清空后 250 条窗口内新请求又把计数推
 *  回旧值附近的「净变化为 0」则可能漏报活动。高频请求的长寿命页面才会触发，
 *  此时超时错误文案已提示改用元素条件/谓词。根治要换 PerformanceObserver，
 *  见文件尾自审建议。 */
function resourceCount(): number {
  try {
    return performance.getEntriesByType('resource').length;
  } catch {
    return 0;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function waitFor(cond: WaitCond, opts: WaitOpts = {}): Promise<{ waited: number }> {
  const timeout = opts.timeout ?? DEFAULT_TIMEOUT;
  // interval clamp 到 timeout：审查探针实录——AI 生成的脚本完全可能写出
  // interval:5000 + timeout:3000 的组合，sleep 大于预算时首次超时判定被跳过，
  // 实际等待可超出预算整整一个 interval（实测 timeout=500/interval=5000 超冲到 5001ms）。
  const interval = Math.min(opts.interval ?? DEFAULT_INTERVAL, timeout);
  const start = Date.now();

  // idle 单独走：需要跨轮次保持「上次计数与其时间戳」。计数有变化（任何方向）
  // 都算新活动并重置静默窗口——只认增长会漏掉 buffer 清空造成的骤降。
  if (isIdle(cond)) {
    let lastCount = resourceCount();
    let quietSince = start;
    for (;;) {
      await sleep(interval);
      const now = resourceCount();
      if (now !== lastCount) { lastCount = now; quietSince = Date.now(); }
      else if (Date.now() - quietSince >= cond.idle) return { waited: Date.now() - start };
      if (Date.now() - start >= timeout) throw timeoutError(cond, start, undefined);
    }
  }

  const check = async (): Promise<{ hit: boolean; matched?: number }> => {
    if (typeof cond === 'function') {
      try {
        return { hit: Boolean(await cond()) };
      } catch (e) {
        // 谓词抛错必须立即上抛而非当成「条件未满足」：死等到超时既慢又把
        // 真正的病因（脚本错误）伪装成 timeout 误导排障方向。
        throw new StepError('script-error', `waitFor 的谓词抛错：${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`, {
          hint: '谓词内的代码本身有问题（如访问了不存在的变量或属性）。检查谓词逻辑，或先用 query_page 确认元素结构。',
        });
      }
    }
    const loc = isGone(cond) ? cond.gone : cond;
    let n: number;
    try {
      n = queryLocator(loc).elements.length;
    } catch (e) {
      // 非法 locator 同样立即抛：非法条件不可能随时间变合法，死等是纯浪费。
      throw new StepError('script-error', `waitFor 的 locator 非法：${e instanceof Error ? e.message : String(e)}`, {
        hint: '修正 locator 后重试。选择器语法错误或语义 locator 无任何条件时会报这个。',
      });
    }
    return { hit: isGone(cond) ? n === 0 : n > 0, matched: n };
  };

  let last = await check();
  if (last.hit) return { waited: Date.now() - start };

  for (;;) {
    await sleep(interval);
    last = await check();
    if (last.hit) return { waited: Date.now() - start };
    if (Date.now() - start >= timeout) throw timeoutError(cond, start, last.matched);
  }
}

function timeoutError(cond: WaitCond, start: number, matched: number | undefined): StepError {
  const waited = Date.now() - start;
  const desc = describeCond(cond);
  const detail: Record<string, unknown> = { cond: desc, waited, hint: buildTimeoutHint(cond, matched) };
  if (matched != null) detail.matched = matched;
  return new StepError('timeout', `waitFor 超时（${waited}ms）：条件「${desc}」未满足`, detail);
}

function buildTimeoutHint(cond: WaitCond, matched: number | undefined): string {
  const tail = '若 trace 各步都正常但结果不对，重跑时传 screenshot:"on-failure" 看页面实况。';
  if (isIdle(cond)) {
    return `网络一直没静默（可能有轮询/长连接/自动刷新在持续发请求），或页面变化是纯前端渲染不产生请求——后者请改用元素条件（如 { role:"dialog" }）或谓词形式。${tail}`;
  }
  if (typeof cond === 'function') {
    return `谓词一直返回 false。确认判断依据是否正确（可在谓词里 log 中间值），或改用元素条件。${tail}`;
  }
  if (isGone(cond)) {
    return `元素一直没消失。可能页面卡在加载态（看 list_console_messages 有无报错），或该元素本就常驻（选择器匹配范围太宽）。${tail}`;
  }
  if (matched === 0) {
    return `等待期间该元素始终不存在。可能前一步操作没生效（检查 trace 里上一步）、需要先滚动加载、内容在跨域 iframe 内，或条件本身写错。${tail}`;
  }
  return `条件未满足。用 query_page 看看当前页面实际有什么。${tail}`;
}

// ---- 自审备忘（不实现，留决策记录）----
// 1. idle 判定的局限（探针与规范核对后更新）：resource buffer 默认上限 250 条，
//    超限后新条目按规范进 secondary buffer（页面脚本读不到），getEntriesByType
//    计数封顶——之后的新请求不再推高计数 → 会误判静默。另有反向偏差：页面自身
//    调 clearResourceTimings 会令计数骤降，被当成新活动重置静默窗口（保守方向，
//    只是多等）。前者才是真风险：高频长寿命页面（直播/监控大屏）上 idle 几乎必
//    误判。根治换 PerformanceObserver（observer buffer 在 buffer-full 判定【之前】
//    追加，不受 250 上限影响，规范 performance-timeline §6.1 明确 observer 先收
//    条目再查 buffer 是否满），且语义更贴合「等待期间无新请求」的本意——现有
//    getEntriesByType 轮询把「等待开始前的存量请求」也算进活动判定。建议后续
//    有 helper 体积预算时切换，本版注释声明局限即可。
// 2. 轮询性能（探针实测 2003 节点页，jsdom）：语义 text locator 单次 check
//    ~29ms、语义 role ~16ms、CSS 选择器 ~7.8ms、CSS 未命中 ~0.1ms。10s 超时 ×
//    100ms interval = 100 次 check，语义 text 条件总匹配时间可达 ~2.9s（约 30%
//    超时预算），仍在可用范围但已不可忽略；真实浏览器 DOM 更快（jsdom 的
//    getComputedStyle/textContent 慢一个量级），实际比例更低。判断：interval 不
//    必自适应——等待通常几十到几百 ms 内命中，吃满超时的场景本来就是要失败的，
//    匹配成本只是让失败慢一点，不改变结果；若未来要优化，优先让 idle/谓词轮询
//    不与 locator 轮询共享 interval，其次才是自适应退避。注释层面已够，不改码。
