// shared/js-balance.ts
// 轻量配平扫描（spec §4.6）：词法级扫描，跳过字符串/模板串/注释/正则字面量，
// 检查 {}()[] 配平与未闭合引号。不做 eval —— SW 的 CSP 禁 eval（wrapper 里的 new Function
// 语法预探测跑在页面 USER_SCRIPT world，后台复用不了，见 background/scripts.ts 的 WORLD_CSP）。
// 只报告不阻断：分步 append 的中间态必然 unclosed（骨架刻意不闭合 IIFE）。

export interface BalanceResult {
  ok: boolean;
  /** 不平衡时的人类可读原因（含行号）；ok 时缺省 */
  detail?: string;
}

const CLOSERS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

type Frame =
  | { kind: 'normal' }
  /** line = 模板串起始行，扫描结束仍未闭合时用于报错 */
  | { kind: 'template'; line: number }
  /** depth = 进入 ${ 时 open 栈的长度（该 { 自身已入栈），用于判定哪个 } 结束表达式 */
  | { kind: 'templateExpr'; depth: number };

/** `/` 是正则起始还是除号：靠前一个有意义字符判定（启发式，见 spec §8 已知边界）。 */
function regexCanStart(lastSig: string): boolean {
  if (lastSig === '') return true;
  if (/[)\]}]/.test(lastSig)) return false;
  return !/[\w$]/.test(lastSig);
}

export function checkBalance(code: string): BalanceResult {
  const open: Array<{ ch: string; line: number }> = [];
  const frames: Frame[] = [{ kind: 'normal' }];
  let i = 0;
  let line = 1;
  let lastSig = '';

  while (i < code.length) {
    const c = code[i]!;
    const n = code[i + 1];
    const top = frames[frames.length - 1]!;

    if (c === '\n') { line += 1; i += 1; continue; }

    // ---- 模板串内部：只找 ` 结束与 ${ 进入表达式 ----
    if (top.kind === 'template') {
      if (c === '\\') { if (n === '\n') line += 1; i += 2; continue; }
      if (c === '`') { frames.pop(); lastSig = '`'; i += 1; continue; }
      if (c === '$' && n === '{') {
        open.push({ ch: '{', line });
        frames.push({ kind: 'templateExpr', depth: open.length });
        lastSig = '{'; i += 2; continue;
      }
      i += 1; continue;
    }

    // ---- 注释 ----
    if (c === '/' && n === '/') {
      while (i < code.length && code[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && n === '*') {
      const end = code.indexOf('*/', i + 2);
      if (end < 0) return { ok: false, detail: `第 ${line} 行起的块注释未闭合（缺 */）` };
      for (let k = i; k < end; k += 1) if (code[k] === '\n') line += 1;
      i = end + 2; continue;
    }

    // ---- 引号串 ----
    if (c === '"' || c === "'") {
      const startLine = line;
      const unclosed = { ok: false as const, detail: `第 ${startLine} 行的字符串未闭合（缺 ${c}）` };
      i += 1;
      for (;;) {
        if (i >= code.length) return unclosed;
        const ch = code[i]!;
        if (ch === '\\') { if (code[i + 1] === '\n') line += 1; i += 2; continue; }
        if (ch === '\n') return unclosed;
        if (ch === c) { i += 1; break; }
        i += 1;
      }
      lastSig = c; continue;
    }

    // ---- 模板串起始 ----
    if (c === '`') { frames.push({ kind: 'template', line }); i += 1; continue; }

    // ---- 正则字面量 ----
    if (c === '/' && regexCanStart(lastSig)) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < code.length) {
        const ch = code[j]!;
        if (ch === '\\') { j += 2; continue; }
        if (ch === '\n') break;                    // 正则不能跨行 → 判定失败，回退当除号
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) { closed = true; j += 1; break; }
        j += 1;
      }
      if (closed) {
        while (j < code.length && /[a-z]/.test(code[j]!)) j += 1;  // 跳过 flags
        i = j; lastSig = '/'; continue;
      }
      lastSig = '/'; i += 1; continue;             // 未闭合 → 当除号
    }

    // ---- 括号 ----
    if (c === '(' || c === '[' || c === '{') {
      open.push({ ch: c, line });
      lastSig = c; i += 1; continue;
    }
    if (c === ')' || c === ']' || c === '}') {
      // 模板表达式的收尾 }：弹掉它自己那个 { 并退出 templateExpr 帧
      if (c === '}' && top.kind === 'templateExpr' && open.length === top.depth) {
        open.pop(); frames.pop(); lastSig = '}'; i += 1; continue;
      }
      const last = open[open.length - 1];
      if (!last) return { ok: false, detail: `第 ${line} 行多出一个 ${c}` };
      if (last.ch !== CLOSERS[c]) {
        return { ok: false, detail: `第 ${line} 行的 ${c} 与第 ${last.line} 行的 ${last.ch} 不匹配` };
      }
      open.pop(); lastSig = c; i += 1; continue;
    }

    if (!/\s/.test(c)) lastSig = c;
    i += 1;
  }

  if (frames.length > 1) {
    // 剩余帧里最底下的 template 即最早未闭合的模板串
    const tmpl = frames.find((f): f is Extract<Frame, { kind: 'template' }> => f.kind === 'template');
    return {
      ok: false,
      detail: `第 ${tmpl ? tmpl.line : 1} 行起的模板字符串未闭合（缺 \`）`,
    };
  }
  if (open.length > 0) {
    const counts = new Map<string, number>();
    for (const o of open) counts.set(o.ch, (counts.get(o.ch) ?? 0) + 1);
    const parts = [...counts].map(([ch, cnt]) => `${cnt} 个 ${ch}`);
    return { ok: false, detail: `有 ${parts.join('、')} 未闭合（最早在第 ${open[0]!.line} 行）` };
  }
  return { ok: true };
}
