// content/script-runtime.ts
// 脚本执行包裹（spec §3.7）。
//
// 【架构约束】scriptRunner 必须自包含：它由 scripting.executeScript 序列化注入，
// 不能 import 任何模块作用域的东西。eval 只能发生在这里——扩展默认 CSP 不给 eval，
// 而 executeScript 注入的函数体是已验证可用的路径（同 evaluate.ts 的 pageRunner）。
// helper 工厂由 content script 启动时挂到 globalThis（Task 19），两者经此交接。
import type { ScriptKind, TraceEntry, DataTruncation } from '../shared/script-result';

/** helper 工厂在 globalThis 上的键名。content script 启动时安装，scriptRunner 读取。 */
export const HELPER_GLOBAL = '__ABE_HELPERS';

/** 10 个 helper 的名字。script-error 时判断未定义名是否属于本运行时，决定要不要引导查文档。 */
export const HELPER_NAMES = [
  '$', '$$', 'click', 'type', 'hover', 'press', 'waitFor', 'text', 'log', 'expect',
] as const;

export interface RunnerResult {
  ok: boolean;
  kind?: ScriptKind;
  error?: string;
  hint?: string;
  data?: unknown;
  dataTruncated?: DataTruncation;
  trace?: TraceEntry[];
  logs?: string[];
  logsDropped?: number;
  failedAt?: Record<string, unknown>;
  url?: string;
  urlFrom?: string;
  elapsed?: number;
  /** 最后一个成功步的 op（失败时才有）。对「点完 A 后 B 失败」的场景给参照——
   *  失败步自己的 op 在 failedAt.op（Task 17 的 op 戳随 detail 摊平进入）。 */
  lastOkOp?: string;
}

/**
 * 在页内执行 agent 的脚本。自包含——由 executeScript 注入。
 * 返回值已完成截断与序列化归一，SW 侧只做透传与截图合并。
 */
export async function scriptRunner(src: string): Promise<RunnerResult> {
  const started = Date.now();
  const urlBefore = location.href;

  // ---- 常量与工具全部内联（自包含约束）----
  // 这些数字的单一出处是 shared/script-result.ts 的同名常量，改动时两边一起改
  // （tests/shared/script-result.test.ts 锁死了那边的值）。此处不能 import——本函数
  // 由 executeScript 序列化注入，模块作用域的引用在目标世界不存在。
  const DATA_CHAR_CAP = 8192;
  const TRACE_CAP = 50, TRACE_KEEP = 15;
  const LOG_CAP = 30, LOG_CHAR_CAP = 500;
  const DEPTH_CAP = 6, ARRAY_CAP = 200;
  const HELPERS = ['$', '$$', 'click', 'type', 'hover', 'press', 'waitFor', 'text', 'log', 'expect'];

  const factory = (globalThis as Record<string, unknown>)[
    '__ABE_HELPERS'
  ] as undefined | (() => { helpers: Record<string, unknown>; ctx: { trace: TraceEntry[]; logs: string[]; stepCount: number } });

  if (typeof factory !== 'function') {
    return {
      ok: false, kind: 'script-error', elapsed: Date.now() - started, url: urlBefore,
      error: '页面脚本运行时未就绪（helper 未安装）',
      hint: '该页的 content script 可能尚未注入或已被卸载。刷新页面后重试；若页面刚打开，先用 wait_for 等它加载完成。',
    };
  }

  const looksLikeNode = (v: object): boolean => {
    const n = v as { nodeType?: unknown; tagName?: unknown; nodeName?: unknown };
    return typeof n.nodeType === 'number' && (typeof n.tagName === 'string' || typeof n.nodeName === 'string');
  };

  const serializeSafe = (value: unknown, depth: number, seen: WeakSet<object>): unknown => {
    if (value === null) return null;
    const t = typeof value;
    if (t === 'function') return '[函数]';
    if (t === 'symbol') return '[symbol]';
    if (t === 'bigint') return String(value);
    if (t !== 'object') return value;
    const obj = value as object;
    if (looksLikeNode(obj)) {
      const tag = String(
        (obj as { tagName?: unknown }).tagName ?? (obj as { nodeName?: unknown }).nodeName ?? '节点',
      ).toLowerCase();
      throw new Error(`返回值含 DOM 节点（<${tag}>），无法序列化。改为返回标量：文本用 text(el)、链接用 el.href、值用 el.value。`);
    }
    if (seen.has(obj)) return '[循环引用]';
    if (depth >= DEPTH_CAP) return '[层级过深]';
    seen.add(obj);
    try {
      if (Array.isArray(obj)) {
        const out: unknown[] = obj.slice(0, ARRAY_CAP).map((v) => serializeSafe(v, depth + 1, seen));
        if (obj.length > ARRAY_CAP) out.push(`[已截断 ${obj.length - ARRAY_CAP} 项]`);
        return out;
      }
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) out[k] = serializeSafe(v, depth + 1, seen);
      return out;
    } finally {
      seen.delete(obj);
    }
  };

  const describeThrown = (e: unknown): string => {
    const capStr = (s: string) => (s.length > 500 ? `${s.slice(0, 500)}…` : s);
    if (typeof DOMException !== 'undefined' && e instanceof DOMException) {
      return capStr(`DOMException(${e.name}): ${e.message}`);
    }
    if (e instanceof Error) return capStr(`${e.name}: ${e.message}`);
    if (e === null) return 'null';
    if (e === undefined) return 'undefined';
    if (typeof e === 'object') {
      const msg = (e as { message?: unknown }).message;
      if (typeof msg === 'string' && msg) return capStr(msg);
      try { return capStr(JSON.stringify(e) ?? String(e)); } catch { return Object.prototype.toString.call(e); }
    }
    return capStr(String(e));
  };

  const { helpers, ctx } = factory();

  const finishTrace = (): { trace: TraceEntry[]; logs: string[]; logsDropped?: number } => {
    const trace = ctx.trace.length > TRACE_CAP
      ? [
          ...ctx.trace.slice(0, TRACE_KEEP),
          { collapsed: ctx.trace.length - TRACE_KEEP * 2 } as TraceEntry,
          ...ctx.trace.slice(-TRACE_KEEP),
        ]
      : ctx.trace;
    const capped = ctx.logs.map((l) => (l.length > LOG_CHAR_CAP ? `${l.slice(0, LOG_CHAR_CAP)}…` : l));
    if (capped.length <= LOG_CAP) return { trace, logs: capped };
    return { trace, logs: capped.slice(capped.length - LOG_CAP), logsDropped: capped.length - LOG_CAP };
  };

  const withUrl = (r: RunnerResult): RunnerResult => {
    r.url = location.href;
    if (location.href !== urlBefore) r.urlFrom = urlBefore;
    r.elapsed = Date.now() - started;
    return r;
  };

  // ---- 编译 + 执行 ----
  let fn: (...args: unknown[]) => Promise<unknown>;
  const names = HELPERS;
  try {
    const AsyncFn = Object.getPrototypeOf(async function () {}).constructor as new (
      ...a: string[]
    ) => (...args: unknown[]) => Promise<unknown>;
    fn = new AsyncFn(...names, src);
  } catch (e) {
    const { trace, logs, logsDropped } = finishTrace();
    return withUrl({
      ok: false, kind: 'script-error', error: describeThrown(e), trace, logs, logsDropped,
      hint: '脚本语法错误，整段未执行。检查括号/引号配平与语句完整性后重发。',
    });
  }

  try {
    const raw = await fn(...names.map((n) => helpers[n]));
    const { trace, logs, logsDropped } = finishTrace();
    let data: unknown;
    try {
      data = serializeSafe(raw, 0, new WeakSet());
    } catch (e) {
      return withUrl({
        ok: false, kind: 'script-error', error: describeThrown(e), trace, logs, logsDropped,
        hint: '返回值无法序列化。只返回标量、纯对象与数组；元素信息用 text(el) / el.href / el.value 取出。',
      });
    }

    let json = '';
    try { json = JSON.stringify(data) ?? ''; } catch { json = ''; }
    let dataTruncated: DataTruncation | undefined;
    // 大数组专修：serializeSafe 的 ARRAY_CAP(200) 会先把 5000 项削成 201 项（约 5.2k
    // 字符），按 data 量出的 json 永远够不着 8192 截断线——超限对脚本不可见，agent 拿到
    // 静默缩水的数据。故对未削的原始数组重新量长度，超限则直接二分截断（serializeSafe
    // 已对 raw 跑通过一次，此处不会再抛；超限抛错时 data 保持原样、落入下方兜底分支）。
    // plan 原文的「data 超限截断」测试夹具（5000 条小对象）恰好落进该盲区，实测
    // dataTruncated 恒 undefined，与用例断言直接矛盾，故修正而非照抄。
    // isFinite 守卫：顶层数组含循环引用时 JSON.stringify(raw) 抛错 → fullLen=Infinity
    // → 误触发截断，产出 returned===total 的假 dataTruncated（审查探针实录）。
    // serializeSafe 已把循环引用替换成标记字符串，data 本身可安全 stringify，
    // fullLen=Infinity 只说明「原始值量不出大小」，按未超限放行即可。
    if (Array.isArray(raw) && Array.isArray(data)) {
      // isFinite 守卫：顶层数组含循环引用时 JSON.stringify(raw) 抛错 → fullLen=Infinity
      // → 误触发截断，产出 returned===total 的假 dataTruncated（审查探针实录）。
      // serializeSafe 已把循环引用替换成标记字符串，data 本身可安全 stringify，
      // fullLen=Infinity 只说明「原始值量不出大小」，按未超限放行即可。
      let fullLen = 0;
      try { fullLen = (JSON.stringify(raw) ?? '').length; } catch { fullLen = Infinity; }
      if (isFinite(fullLen) && fullLen > DATA_CHAR_CAP) {
        const hint = `返回值超 ${DATA_CHAR_CAP} 字符上限已截断。用 slice 分批取（如脚本内 .slice(0, 20)），或在脚本里先聚合（只回需要的字段、算好统计值）再返回。`;
        let work: unknown[];
        try {
          work = serializeSafe(raw, 0, new WeakSet()) as unknown[];
        } catch {
          work = data;   // 理论不可达（raw 已成功序列化过一次）；兜底退回已削的 data
        }
        let lo = 0, hi = work.length;
        while (lo < hi) {
          const mid = Math.ceil((lo + hi) / 2);
          let size = Infinity;
          try { size = (JSON.stringify(work.slice(0, mid)) ?? '').length; } catch { size = Infinity; }
          if (size <= DATA_CHAR_CAP) lo = mid; else hi = mid - 1;
        }
        dataTruncated = { returned: lo, total: (raw as unknown[]).length, hint };
        data = work.slice(0, lo);
        json = '';
      }
    }
    if (json.length > DATA_CHAR_CAP) {
      const hint = `返回值超 ${DATA_CHAR_CAP} 字符上限已截断。用 slice 分批取（如脚本内 .slice(0, 20)），或在脚本里先聚合（只回需要的字段、算好统计值）再返回。`;
      if (Array.isArray(data)) {
        let lo = 0, hi = data.length;
        while (lo < hi) {
          const mid = Math.ceil((lo + hi) / 2);
          let size = Infinity;
          try { size = (JSON.stringify(data.slice(0, mid)) ?? '').length; } catch { size = Infinity; }
          if (size <= DATA_CHAR_CAP) lo = mid; else hi = mid - 1;
        }
        dataTruncated = { returned: lo, total: data.length, hint };
        data = data.slice(0, lo);
      } else if (typeof data === 'string') {
        dataTruncated = { returned: DATA_CHAR_CAP, total: data.length, hint };
        data = data.slice(0, DATA_CHAR_CAP);
      } else {
        dataTruncated = { returned: 0, total: json.length, hint };
        data = `[返回值过大（${json.length} 字符）已丢弃]`;
      }
    }

    return withUrl({ ok: true, data, dataTruncated, trace, logs, logsDropped });
  } catch (e) {
    const { trace, logs, logsDropped } = finishTrace();
    const se = e as { name?: unknown; kind?: unknown; detail?: unknown; message?: unknown };

    // StepError：kind + detail 直接转 failedAt（Task 17 已在 detail 上盖好失败步的 op 戳，
    // 摊平即得，无需在此按 helper 名推断）
    if (se?.name === 'StepError' && typeof se.kind === 'string') {
      const detail = (se.detail ?? {}) as Record<string, unknown>;
      const lastOp = ctx.trace.length ? (ctx.trace[ctx.trace.length - 1] as { op?: string }).op : undefined;
      const failedAt: Record<string, unknown> = { i: ctx.stepCount, ...detail };
      delete failedAt.hint;
      return withUrl({
        ok: false, kind: se.kind as ScriptKind, error: String(se.message ?? ''),
        hint: typeof detail.hint === 'string' ? detail.hint : undefined,
        failedAt, trace, logs, logsDropped,
        // 点完 A 后 B 失败的场景：lastOkOp 指明最后成功的操作，失败步的 op 在 failedAt 里
        ...(lastOp ? { lastOkOp: lastOp } : {}),
      });
    }

    // ReferenceError：未定义名不在 helper 清单内时引导查文档（spec §7.3 第二道防线）。
    // 名字字符类含 $：plan 正则的 \w[\w$]* 要求首字符是 \w，而 helper/常用名多以 $ 开头
    // （$x 等），实测永远不命中——首字符类扩成 [\w$]。
    const msg = describeThrown(e);
    let hint = '脚本执行出错。按错误信息修正代码；必要时先用 query_page 确认页面实际结构。';
    const ref = /ReferenceError:\s*([\w$][\w$]*)\s+is not defined/.exec(msg);
    if (ref) {
      const name = ref[1]!;
      hint = HELPERS.includes(name)
        ? `${name} 是本运行时的 helper，但此处未定义——检查是否被局部变量遮蔽（如 let ${name}）。`
        : `未定义的函数 ${name} —— 本运行时的可用函数只有：${HELPERS.join(' ')}。完整用法与示例调 load_skill('page-script')。`;
    }
    return withUrl({ ok: false, kind: 'script-error', error: msg, hint, trace, logs, logsDropped });
  }
}
