# AI 写脚本流程优化 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 AI 写长脚本走「骨架 → 分次追加」路径，消除参数生成期的卡死观感，并把脚本读写改为按需分页/检索。

**Architecture:** 三层改动互不耦合 —— (1) `shared/` 加纯函数（配平扫描、文本原语）；(2) `background/scripts.ts` 编排层接入新 patch 分支；(3) `agent/tools/` 工具层做硬闸、行号标注、返回瘦身、新增 `grep_script`。另有一条纵向切片：`tool-args-delta` 事件贯穿 provider → run-turn → loop → agent-tail → chat store → ChatView。

**Tech Stack:** TypeScript 7、WXT（Chrome MV3）、React 19、Zustand、vitest v4 + jsdom、`@testing-library/react`。

**设计依据：** [docs/superpowers/specs/2026-09-06-ai-script-authoring-optimization-design.md](../specs/2026-09-06-ai-script-authoring-optimization-design.md)

---

## 文件结构

**新建：**

| 文件 | 职责 |
|---|---|
| `shared/js-balance.ts` | 词法扫描器：跳过字符串/模板串/注释/正则字面量，检查 `{}()[]` 配平与未闭合引号。纯函数、零依赖。 |
| `agent/tools/script-grep.ts` | `grep_script` 执行器。与 `script-pool.ts` 分文件：前者是检索、后者是 CRUD，职责不同且都在增长。 |
| `tests/shared/js-balance.test.ts` | 配平扫描用例 |
| `tests/agent/tools/script-grep.test.ts` | grep 用例 |

**修改：**

| 文件 | 改动 |
|---|---|
| `shared/messages.ts` | `ScriptPatch` 扩 `append`/`replace`；`AgentEvent` 加 `tool-args-delta` |
| `shared/types.ts` | `ScriptSummary` 加 `lines`/`bytes` |
| `storage/scripts.ts` | `toSummary` 计算 `lines`/`bytes` |
| `storage/settings.ts` | `AgentConfig` 加 `maxTokens`；`llmTimeoutSec` 默认 10→60 |
| `background/scripts.ts` | 加 `appendText`/`replaceText` 纯函数；`handleUpdate` 接新分支 + 互斥报错 |
| `agent/tools/script-pool.ts` | 硬闸、行号标注、默认限量、返回瘦身 + balance |
| `agent/tools/schemas.ts` | 新增 `grep_script` schema；四个脚本工具 description 改写 |
| `agent/tools/registry.ts` | `grep_script` 分发 |
| `agent/mode.ts` | `grep_script` 进 `ASK_MODE_TOOLS` |
| `agent/provider/openai-compat.ts` | `max_tokens` 下发；`timeoutMs=0` 时 300s 硬兜底 |
| `agent/provider/types.ts` | `RunTurnHooks` 无关；`ChatParams.maxTokens` 已存在，无需改 |
| `agent/run-turn.ts` | `onToolArgsDelta` hook |
| `agent/loop.ts` | `getMaxTokens` dep、节流 emit `tool-args-delta`、截断文案改写 |
| `agent/context.ts` | `SYSTEM_PROMPT` 加分步规则 |
| `background/agent-tail.ts` | `argsProgress` 字段 |
| `background/agent-port.ts` | 注入 `getMaxTokens` |
| `stores/chat.ts` | `argsProgress` 顶层态 |
| `components/chat/ChatView.tsx` | 渲染参数生成进度 |
| `components/settings/ModelSettings.tsx` | `maxTokens` 输入框 |
| `public/skills/builtin.md` | write-script 第 3 步重写 |
| `entrypoints/sidepanel/styles.css` | 进度条样式 |

---

## Task 1: 配平扫描器 `checkBalance`

分步 append 最典型的错误是「少个右括号」。这个纯函数负责在每次写入后报告配平状态。**只报告不阻断** —— 中间态必然不平衡。

**Files:**
- Create: `shared/js-balance.ts`
- Test: `tests/shared/js-balance.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `tests/shared/js-balance.test.ts`：

```ts
// tests/shared/js-balance.test.ts
import { describe, it, expect } from 'vitest';
import { checkBalance } from '../../shared/js-balance';

describe('checkBalance 配平扫描', () => {
  it('平衡的代码 → ok', () => {
    expect(checkBalance('(function () { var a = [1, 2]; })();')).toEqual({ ok: true });
    expect(checkBalance('')).toEqual({ ok: true });
  });

  it('缺右括号 → 不 ok，detail 带数量与最早行号', () => {
    const r = checkBalance('(function () {\n  var a = 1;\n');
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('未闭合');
    expect(r.detail).toContain('第 1 行');
  });

  it('多出右括号 → 不 ok 且指出行号', () => {
    const r = checkBalance('var a = 1;\n}\n');
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('第 2 行');
    expect(r.detail).toContain('多出');
  });

  it('配对错位（] 对上 {）→ 报不匹配', () => {
    const r = checkBalance('{ ]');
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('不匹配');
  });

  it('字符串里的括号不计入', () => {
    expect(checkBalance('var s = "){[";')).toEqual({ ok: true });
    expect(checkBalance("var s = '}}}';")).toEqual({ ok: true });
    expect(checkBalance('var s = "a\\"){";')).toEqual({ ok: true });
  });

  it('未闭合的引号串 → 不 ok（含换行截断的情况）', () => {
    expect(checkBalance('var s = "abc').ok).toBe(false);
    const r = checkBalance('var s = "abc\nvar t = 1;');
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('字符串未闭合');
  });

  it('模板串里的括号不计入；${} 嵌套正确处理', () => {
    expect(checkBalance('var s = `){[`;')).toEqual({ ok: true });
    expect(checkBalance('var s = `a${ f({ x: [1] }) }b`;')).toEqual({ ok: true });
    expect(checkBalance('var s = `${ `${ 1 }` }`;')).toEqual({ ok: true });
  });

  it('模板串内的 ${} 缺右括号仍被发现', () => {
    expect(checkBalance('var s = `a${ f( `;').ok).toBe(false);
  });

  it('未闭合模板串 → 不 ok', () => {
    const r = checkBalance('var s = `abc;');
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('模板');
  });

  it('注释里的括号与引号不计入', () => {
    expect(checkBalance('// ) } " \'\nvar a = 1;')).toEqual({ ok: true });
    expect(checkBalance('/* ) } " it\'s */\nvar a = 1;')).toEqual({ ok: true });
  });

  it('未闭合块注释 → 不 ok', () => {
    const r = checkBalance('/* abc\nvar a = 1;');
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('块注释未闭合');
  });

  it('块注释跨行时行号继续累计', () => {
    const r = checkBalance('/* a\nb\nc */\n{');
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('第 4 行');
  });

  it('正则字面量里的括号与方括号不计入', () => {
    expect(checkBalance('var re = /[(){]/;')).toEqual({ ok: true });
    expect(checkBalance('var re = /a\\/b(/;')).toEqual({ ok: true });
    expect(checkBalance('if (/^x[(]$/.test(s)) { f(); }')).toEqual({ ok: true });
  });

  it('除号不被误判为正则起始（前一个有意义字符是标识符/数字/右括号）', () => {
    expect(checkBalance('var a = b / c; var d = (1) / 2; var e = arr[0] / 3;')).toEqual({ ok: true });
    expect(checkBalance('var a = 6 / 2 / 3;')).toEqual({ ok: true });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/shared/js-balance.test.ts`
Expected: FAIL —— `Failed to resolve import "../../shared/js-balance"`（文件还不存在）

- [ ] **Step 3: 实现扫描器**

创建 `shared/js-balance.ts`：

```ts
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
  | { kind: 'template' }
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
    if (c === '`') { frames.push({ kind: 'template' }); i += 1; continue; }

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

  if (frames.length > 1) return { ok: false, detail: '模板字符串未闭合（缺 `）' };
  if (open.length > 0) {
    const counts = new Map<string, number>();
    for (const o of open) counts.set(o.ch, (counts.get(o.ch) ?? 0) + 1);
    const parts = [...counts].map(([ch, cnt]) => `${cnt} 个 ${ch}`);
    return { ok: false, detail: `有 ${parts.join('、')} 未闭合（最早在第 ${open[0]!.line} 行）` };
  }
  return { ok: true };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/shared/js-balance.test.ts`
Expected: PASS，14 个用例全绿

- [ ] **Step 5: 提交**

```bash
git add shared/js-balance.ts tests/shared/js-balance.test.ts
git commit -m "feat(scripts): 轻量配平扫描 checkBalance（跳过串/注释/正则）"
```

---

## Task 2: 文本原语 `appendText` / `replaceText`

`spliceLines` 的两个邻居。放在同文件（都是「文本为源」的行/串级原语，`handleUpdate` 是唯一消费者）。

**Files:**
- Modify: `background/scripts.ts`（在 `spliceLines` 之后，约 [scripts.ts:249](../../../background/scripts.ts#L249)）
- Test: `tests/background/scripts.test.ts`（加进 `describe('CRUD 编排 + 注册同步（文本为源）')`，紧跟 `spliceLines` 那个 `it` 之后）

- [ ] **Step 1: 写失败测试**

在 `tests/background/scripts.test.ts` 的 `spliceLines` 用例之后插入：

```ts
  it('appendText：追加到末尾；原文无尾换行时补一个', () => {
    expect(appendText('a\nb\n', 'c();')).toBe('a\nb\nc();');
    expect(appendText('a\nb', 'c();')).toBe('a\nb\nc();');
    expect(appendText('', 'c();')).toBe('c();');
    expect(() => appendText('a\n', '')).toThrow('append 不能为空');
  });

  it('replaceText：命中 1 处替换；未命中/多处未传 all 报错；all:true 全替', () => {
    expect(replaceText('a\nfoo\nb', 'foo', 'bar')).toBe('a\nbar\nb');

    expect(() => replaceText('a\nb', 'zzz', 'x')).toThrow('未找到');

    // 命中 2 处（第 2、4 行）未传 all → 报错并列出行号
    expect(() => replaceText('a\nfoo\nb\nfoo', 'foo', 'x')).toThrow(/命中 2 处.*第 2、4 行/);

    expect(replaceText('a\nfoo\nb\nfoo', 'foo', 'x', true)).toBe('a\nx\nb\nx');
    expect(() => replaceText('a\n', '', 'x')).toThrow('不能为空');
  });

  it('replaceText：old 含正则元字符按字面量处理', () => {
    expect(replaceText('if (a.b) { c(); }', 'a.b', 'a.c')).toBe('if (a.c) { c(); }');
    expect(replaceText('x = arr[0] * 2;', 'arr[0] * 2', 'n')).toBe('x = n;');
    // 字面量语义：'a.b' 不会匹配到 'axb'
    expect(() => replaceText('axb', 'a.b', 'z')).toThrow('未找到');
  });

  it('handleUpdate：append 追加后重解析投影字段', async () => {
    installFakeUserScripts();
    const { script } = await handleCreate({ text: mkText('(function () {') });
    const next = await handleUpdate(script.id, { append: '  f();\n})();' });
    expect(next.text.endsWith('(function () {\n  f();\n})();')).toBe(true);
    expect(next.code).toContain('f();');
    expect(next.name).toBe('n');
  });

  it('handleUpdate：replace 精确替换；old 不唯一时报错且不落库', async () => {
    installFakeUserScripts();
    const { script } = await handleCreate({ text: mkText('f();\ng();\nf();') });
    await expect(handleUpdate(script.id, { replace: { old: 'f();', new: 'h();' } }))
      .rejects.toThrow('命中 2 处');
    // 报错后原文未变
    expect((await getScript(script.id))!.text).toBe(mkText('f();\ng();\nf();'));

    const next = await handleUpdate(script.id, { replace: { old: 'g();', new: 'h();' } });
    expect(next.text).toBe(mkText('f();\nh();\nf();'));
  });

  it('handleUpdate：文本分支互斥 —— 同传两支报错，列出分支名', async () => {
    installFakeUserScripts();
    const { script } = await handleCreate({ text: mkText('f();') });
    await expect(handleUpdate(script.id, { text: mkText('g();'), append: 'x();' }))
      .rejects.toThrow(/只能传一个.*text.*append/);
    await expect(handleUpdate(script.id, { append: 'x();', replace: { old: 'f', new: 'g' } }))
      .rejects.toThrow('只能传一个');
    // enabled 可与文本分支同传（不冲突）
    const next = await handleUpdate(script.id, { append: 'x();', enabled: false });
    expect(next.enabled).toBe(false);
    expect(next.text).toContain('x();');
  });

  it('handleUpdate：空 patch 报错文案含四支分支名', async () => {
    installFakeUserScripts();
    const { script } = await handleCreate({ text: mkText('f();') });
    await expect(handleUpdate(script.id, {})).rejects.toThrow(/text.*edit.*append.*replace/);
  });
```

同文件顶部 import 补 `appendText, replaceText`（加到 `spliceLines` 旁）与 `getScript`：

```ts
import {
  computeRuntimeScriptIds, recomputeTab, recomputeAllTabs, dropTab, getRuntimeSnapshot,
  handleCreate, handleUpdate, handleDelete, handleSetEnabled, handleImport, handleGet, spliceLines,
  appendText, replaceText,
  syncRegistrations, initScriptsModule, ENGINE_UNAVAILABLE_MSG,
} from '../../background/scripts';
import { listScripts, saveScript, getScript } from '../../storage/scripts';
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/background/scripts.test.ts`
Expected: FAIL —— `appendText is not a function` / 互斥用例不报错

- [ ] **Step 3: 实现原语**

在 `background/scripts.ts` 的 `spliceLines` 之后插入：

```ts
/** 追加到原文末尾（原文无尾换行时先补一个）。分步写脚本的主力原语（spec §4.1）。 */
export function appendText(text: string, addition: string): string {
  if (addition === '') throw new Error('append 不能为空');
  if (text === '' || text.endsWith('\n')) return text + addition;
  return `${text}\n${addition}`;
}

/** old 在 text 中每处出现的 1-based 行号（非重叠，与 split/join 语义一致）。 */
function occurrenceLines(text: string, needle: string): number[] {
  const lines: number[] = [];
  let idx = text.indexOf(needle);
  while (idx >= 0) {
    lines.push(text.slice(0, idx).split('\n').length);
    idx = text.indexOf(needle, idx + needle.length);
  }
  return lines;
}

/** 错误文案里的 old 预览：换行可视化 + 截断，避免把整段代码打进错误消息。 */
function previewNeedle(s: string): string {
  const flat = s.replace(/\n/g, '\\n');
  return flat.length > 60 ? `${flat.slice(0, 60)}…` : flat;
}

/**
 * 字面量精确替换（不走正则，避开元字符陷阱）。
 * old 未命中 → throw；命中多处且未传 all → throw 并列出行号；all=true 全替。
 */
export function replaceText(text: string, old: string, replacement: string, all = false): string {
  if (old === '') throw new Error('replace.old 不能为空');
  const lines = occurrenceLines(text, old);
  if (lines.length === 0) {
    throw new Error(`replace 未找到该文本：「${previewNeedle(old)}」——请先用 get_script 或 grep_script 确认原文`);
  }
  if (lines.length > 1 && !all) {
    throw new Error(
      `replace.old 命中 ${lines.length} 处（第 ${lines.join('、')} 行）：请加上下文让 old 唯一，或传 all:true 全部替换`,
    );
  }
  if (all) return text.split(old).join(replacement);
  const idx = text.indexOf(old);
  return text.slice(0, idx) + replacement + text.slice(idx + old.length);
}
```

- [ ] **Step 4: 接进 `handleUpdate`**

把 `background/scripts.ts` 的 `handleUpdate`（[scripts.ts:296-329](../../../background/scripts.ts#L296-L329)）整体替换为：

```ts
/** 文本改动分支：四支互斥（同传两支报错，不静默按优先级取一支——静默取舍会让模型
 *  误以为两处改动都生效）。applyUpdate 由调用方在此之前拦下，不参与本组判定。 */
const TEXT_BRANCHES = ['text', 'edit', 'append', 'replace'] as const;

export async function handleUpdate(id: string, patch: ScriptPatch): Promise<UserScript> {
  await requireEngine(); // spec §6.1：改注册类操作引擎不可用直接报固定文案
  const existing = await getScript(id);
  if (!existing) throw new Error(`脚本不存在：${id}`);

  const branches = TEXT_BRANCHES.filter((k) => patch[k] !== undefined);
  if (branches.length > 1) {
    throw new Error(`patch 只能传一个文本改动分支，收到 ${branches.length} 个：${branches.join('、')}`);
  }
  if (branches.length === 0 && patch.enabled === undefined) {
    throw new Error('patch 至少包含 text / edit / append / replace / enabled 之一');
  }

  let next: UserScript;
  if (branches.length === 1) {
    // 文本路径：算出新原文后整体重解析（文本为源，投影字段全部重建）
    let text: string;
    switch (branches[0]) {
      case 'edit':
        text = spliceLines(existing.text, patch.edit!.startLine, patch.edit!.endLine, patch.edit!.text);
        break;
      case 'append':
        text = appendText(existing.text, patch.append!);
        break;
      case 'replace':
        text = replaceText(existing.text, patch.replace!.old, patch.replace!.new, patch.replace!.all);
        break;
      default:
        if (!patch.text!.trim()) throw new Error('text 必填：完整的 .user.js 文本（含 ==UserScript== 头）');
        text = patch.text!;
    }
    next = buildFromText({
      text, id: existing.id, enabled: patch.enabled ?? existing.enabled,
      source: existing.source, createdAt: existing.createdAt,
    }).script;
    await clearUpdateState(id).catch(() => {}); // spec §1.2 不变量：本地改动使旧检查结果过期
  } else {
    // 仅启停：不重解析
    next = { ...existing, enabled: patch.enabled as boolean, updatedAt: Date.now() };
  }

  await saveScript(next);
  const resWarnings = await prefetchResources(next);
  if (resWarnings.length > 0) console.warn('[scripts] 依赖预取:', ...resWarnings);
  await syncRegistrations();
  await recomputeAllTabs().catch(() => {});
  return next;
}
```

- [ ] **Step 5: 扩 `ScriptPatch` 类型**

`shared/messages.ts` 的 `ScriptPatch`（[messages.ts:144](../../../shared/messages.ts#L144)）加两支：

```ts
export interface ScriptPatch {
  /** 整文替换：替换后整体重解析（投影字段全部重建） */
  text?: string;
  enabled?: boolean;
  /** 行区间替换：在当前原文上 splice 后整体重解析 */
  edit?: ScriptEditRange;
  /** 从更新源（@updateURL/@downloadURL）拉取远端最新文本并覆盖；与其余分支互斥且优先。 */
  applyUpdate?: boolean;
  /** 追加到原文末尾（不需要行号）。分步写长脚本的主力原语（spec §4.1）。 */
  append?: string;
  /** 字面量精确替换（不依赖行号）。old 需唯一，否则报错列出命中行号。 */
  replace?: { old: string; new: string; all?: boolean };
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `npx vitest run tests/background/scripts.test.ts && npx tsc --noEmit`
Expected: 测试全绿；tsc 无输出

- [ ] **Step 7: 提交**

```bash
git add background/scripts.ts shared/messages.ts tests/background/scripts.test.ts
git commit -m "feat(scripts): append/replace 写入原语 + handleUpdate 文本分支互斥"
```

---

## Task 3: `ScriptSummary` 加 `lines` / `bytes`

模型据此判断该不该分页读、要不要先 grep 定位。

**Files:**
- Modify: `shared/types.ts:83-102`、`storage/scripts.ts:61-79`
- Test: `tests/storage/scripts.test.ts`（`describe('toSummary')` 内）

- [ ] **Step 1: 写失败测试**

在 `tests/storage/scripts.test.ts` 的 `describe('toSummary')` 里追加：

```ts
  it('带 lines/bytes 规模字段（按 text 计算）', () => {
    const s = mkScript({ text: 'a\nb\nc' });
    expect(toSummary(s)).toMatchObject({ lines: 3, bytes: 5 });
    // 尾换行计入一个空行（split('\n') 语义）
    expect(toSummary(mkScript({ text: 'a\n' }))).toMatchObject({ lines: 2, bytes: 2 });
    expect(toSummary(mkScript({ text: '' }))).toMatchObject({ lines: 1, bytes: 0 });
  });
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/storage/scripts.test.ts`
Expected: FAIL —— 实际对象没有 `lines` / `bytes` 属性

- [ ] **Step 3: 加字段**

`shared/types.ts` 的 `ScriptSummary` 末尾追加：

```ts
  /** 原文总行数（text.split('\n').length），供模型判断读取策略（spec §4.3） */
  lines: number;
  /** 原文字符数 */
  bytes: number;
```

`storage/scripts.ts` 的 `toSummary` 返回对象里追加：

```ts
    lines: s.text.split('\n').length,
    bytes: s.text.length,
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/storage/scripts.test.ts && npx tsc --noEmit`
Expected: PASS；tsc 无输出（`toSummary` 是 `ScriptSummary` 的唯一构造点，加字段不会漏其它实现）

- [ ] **Step 5: 提交**

```bash
git add shared/types.ts storage/scripts.ts tests/storage/scripts.test.ts
git commit -m "feat(scripts): ScriptSummary 加 lines/bytes 规模字段"
```

---

## Task 4: 工具层返回瘦身 + `balance`

同一份代码此前在上下文存三份（模型的 `arguments` 一份、`script.text` 一份、`script.code` 一份）。这里砍掉后两份。

**Files:**
- Modify: `agent/tools/script-pool.ts`
- Test: `tests/agent/tools/script-pool.test.ts`

- [ ] **Step 1: 写失败测试**

在 `tests/agent/tools/script-pool.test.ts` 追加：

```ts
  it('create/update 返回瘦身：不含 text/code，带 lines/bytes/balance', async () => {
    installFakeUserScripts();
    const r = await doCreateScript({ source: mkTm('n', 'https://a.com/*', '(function () {') });
    expect(r.ok).toBe(true);
    const d = (r as { data: Record<string, unknown> }).data;
    // 回归断言：全文不得回灌（spec §3.4）
    expect(d).not.toHaveProperty('script');
    expect(JSON.stringify(d)).not.toContain('==UserScript==');
    expect(d).toMatchObject({ name: 'n', matches: ['https://a.com/*'], enabled: true });
    expect(typeof d.id).toBe('string');
    expect(typeof d.lines).toBe('number');
    expect(typeof d.bytes).toBe('number');
    // 骨架刻意不闭合 IIFE → 中间态 unclosed（不阻断）
    expect(d.balance).toBe('unclosed');
    expect(typeof d.balanceDetail).toBe('string');
  });

  it('update_script：append 后闭合 → balance 转 ok', async () => {
    installFakeUserScripts();
    const c = await doCreateScript({ source: mkTm('n', 'https://a.com/*', '(function () {') });
    const id = (c as { data: { id: string } }).data.id;

    const mid = await doUpdateScript({ id, patch: { append: '  f();' } });
    expect((mid as { data: { balance: string } }).data.balance).toBe('unclosed');

    const done = await doUpdateScript({ id, patch: { append: '})();' } });
    const d = (done as { data: Record<string, unknown> }).data;
    expect(d.balance).toBe('ok');
    expect(d).not.toHaveProperty('balanceDetail');
    expect(d).not.toHaveProperty('script');
  });

  it('update_script：replace 分支可用，命中多处报错', async () => {
    installFakeUserScripts();
    const c = await doCreateScript({ source: mkTm('n', 'https://a.com/*', 'f();\ng();') });
    const id = (c as { data: { id: string } }).data.id;

    const ok = await doUpdateScript({ id, patch: { replace: { old: 'g();', new: 'h();' } } });
    expect(ok.ok).toBe(true);

    const dup = await doUpdateScript({ id, patch: { replace: { old: '();', new: 'x' } } });
    expect(dup).toMatchObject({ ok: false });
    expect((dup as { error: string }).error).toContain('命中');
  });
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/agent/tools/script-pool.test.ts`
Expected: FAIL —— 返回里仍有 `script`（含 `==UserScript==` 全文），无 `balance`

- [ ] **Step 3: 实现瘦身**

`agent/tools/script-pool.ts` 顶部 import 补：

```ts
import { checkBalance } from '../../shared/js-balance';
```

在 `toUpdateHint` 之后加投影函数：

```ts
/** 写操作的精简返回（spec §3.4）：不回灌 text/code，只给模型下一步决策需要的元信息 + 配平状态。
 *  balance 只报告不阻断——分步 append 的中间态必然 unclosed（骨架刻意不闭合 IIFE）。 */
function toWriteResult(script: UserScript, warnings: string[]) {
  const bal = checkBalance(script.code);
  return {
    id: script.id,
    name: script.name,
    lines: script.text.split('\n').length,
    bytes: script.text.length,
    matches: script.matches,
    enabled: script.enabled,
    runAt: script.runAt,
    world: script.world,
    warnings,
    balance: bal.ok ? ('ok' as const) : ('unclosed' as const),
    ...(bal.ok ? {} : { balanceDetail: bal.detail }),
  };
}
```

同文件 import 补类型 `UserScript`：

```ts
import type { ScriptUpdateState, ToolResult, UserScript } from '../../shared/types';
```

`doCreateScript` 的两处 return 改为：

```ts
    if (typeof args.url === 'string' && args.url.trim()) {
      const { script, warnings } = await handleImportUrl(args.url.trim(), 'agent');
      return { ok: true, data: toWriteResult(script, warnings) };
    }
```

```ts
    const { script, warnings } = await handleCreate({ text, enabled: args.enabled, source: 'agent' });
    return { ok: true, data: toWriteResult(script, warnings) };
```

`doUpdateScript` 两处 return 改为：

```ts
    if (args.patch?.applyUpdate) {
      return { ok: true, data: toWriteResult(await handleApplyUpdate(args.id), []) };
    }
    return { ok: true, data: toWriteResult(await handleUpdate(args.id, args.patch), []) };
```

`doToggleScript` 同样瘦身（启停无需回全文）：

```ts
    return { ok: true, data: toWriteResult(await handleSetEnabled(args.id, args.enabled), []) };
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/agent/tools/script-pool.test.ts && npx tsc --noEmit`
Expected: PASS。若旧用例断言 `data.script.*`，改为断言 `data.*`（形状已变）；UI 侧 `SCRIPTS_CREATE`/`SCRIPTS_UPDATE` 走 `background/scripts.ts` 的 router handler，**不受影响**，`tests/background/scripts.test.ts` 应保持全绿。

- [ ] **Step 5: 提交**

```bash
git add agent/tools/script-pool.ts tests/agent/tools/script-pool.test.ts
git commit -m "feat(scripts): AI 工具写操作返回瘦身 + balance 配平状态"
```

---

## Task 5: `create_script` 长度硬闸

提示词对「写代码」这类任务约束力弱，错误返回才是对模型最有效的纠正信号。

**Files:**
- Modify: `agent/tools/script-pool.ts`（`doCreateScript`，在 matches 校验之前）
- Test: `tests/agent/tools/script-pool.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
  it('create_script 硬闸：超 200 行或 8192 字符报错，文案给分步指引', async () => {
    installFakeUserScripts();
    // 注意 mkTm 头部占 5 行（4 行头 + 1 空行）：body 195 行 → 恰好 200 行 → 通过
    const body200 = Array.from({ length: 195 }, (_, i) => `l${i}();`).join('\n');
    expect((await doCreateScript({ source: mkTm('n', 'https://a.com/*', body200) })).ok).toBe(true);

    // body 196 行 → 共 201 行 → 报错
    const body201 = Array.from({ length: 196 }, (_, i) => `l${i}();`).join('\n');
    const tooLong = await doCreateScript({ source: mkTm('n2', 'https://a.com/*', body201) });
    expect(tooLong).toMatchObject({ ok: false });
    const err = (tooLong as { error: string }).error;
    expect(err).toContain('过长');
    expect(err).toContain('append');   // 指引里必须提到分步原语
    expect(err).toContain('骨架');

    // 字符数超限（行数不超）→ 同样报错
    const fat = await doCreateScript({ source: mkTm('n3', 'https://a.com/*', 'x'.repeat(9000)) });
    expect(fat).toMatchObject({ ok: false });
    expect((fat as { error: string }).error).toContain('过长');
  });

  it('create_script 硬闸不管 url 导入分支', async () => {
    installFakeUserScripts();
    // url 分支不经 source 长度检查（不是模型在逐 token 吐字）；此处只断言未被硬闸拦下
    const r = await doCreateScript({ url: 'not-a-real-url' });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).not.toContain('过长');
  });
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/agent/tools/script-pool.test.ts -t 硬闸`
Expected: FAIL —— 201 行的创建返回 `ok: true`

- [ ] **Step 3: 加硬闸**

`agent/tools/script-pool.ts` 文件顶部加常量与检查函数：

```ts
// create_script 的 source 长度硬闸（spec §4.2）：阈值宽松——200 行以下仍可一次写完，
// 不白多一次往返。只拦 AI 逐 token 吐出的 source；url 导入/UI 导入/patch.text 不受限
// （那些不是模型在生成），总量另由 storage 的 MAX_TEXT_LENGTH（280KB）管。
export const MAX_CREATE_LINES = 200;
export const MAX_CREATE_CHARS = 8192;

function createGateError(text: string): string | undefined {
  const lines = text.split('\n').length;
  if (lines <= MAX_CREATE_LINES && text.length <= MAX_CREATE_CHARS) return undefined;
  return `create_script 的 source 过长（${lines} 行 / ${text.length} 字符，上限 ${MAX_CREATE_LINES} 行 / ${MAX_CREATE_CHARS} 字符）。`
    + '长脚本请分步：先只提交元数据头 + 未闭合的 IIFE 骨架（如 `(function () {` 结尾，不写 `})();`），'
    + '再用 update_script 的 patch.append 分次追加代码体，最后一段带上 `})();` 闭合。';
}
```

`doCreateScript` 里，在 `text` 取值之后、`parseUserScript` 的 matches 校验**之前**插入：

```ts
    const gate = createGateError(text);
    if (gate) return { ok: false, error: gate };
```

顺序理由：长度错误比「缺 @match」更可操作 —— 模型该先改写作策略，而不是先补头部字段。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/agent/tools/script-pool.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add agent/tools/script-pool.ts tests/agent/tools/script-pool.test.ts
git commit -m "feat(scripts): create_script 长度硬闸（200 行/8KB）+ 分步指引文案"
```

---

## Task 6: `get_script` 行号标注 + 默认限量

改动**只在 AI 工具层**：编排层 `handleGet` 的返回与语义完全不动，详情页拿到的仍是干净原文（有回归断言守着）。

**Files:**
- Modify: `agent/tools/script-pool.ts`（`doGetScript`）
- Test: `tests/agent/tools/script-pool.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
  it('get_script：每行带右对齐行号前缀', async () => {
    installFakeUserScripts();
    const c = await doCreateScript({ source: mkTm('n', 'https://a.com/*', 'a();\nb();') });
    const id = (c as { data: { id: string } }).data.id;

    const r = await doGetScript({ id });
    expect(r.ok).toBe(true);
    const text = (r as { data: { script: { text: string } } }).data.script.text;
    expect(text.split('\n')[0]).toBe('   1| // ==UserScript==');
    expect(text).toContain('| a();');
    // 行号是标注不是内容：原文本身不含它
    expect(text).not.toContain('|| ');
  });

  it('get_script：默认限量 200 行 + 超长提示；显式 offset/limit 仍生效', async () => {
    installFakeUserScripts();
    const body = Array.from({ length: 400 }, (_, i) => `l${i}();`).join('\n');
    // 走编排层直接落库，绕开 create 硬闸（模拟用户导入的长脚本）
    const created = await handleCreate({ text: mkTm('big', 'https://a.com/*', body) });
    const id = created.script.id;

    const def = await doGetScript({ id });
    const d = (def as { data: { script: { text: string }; startLine: number; endLine: number; notice?: string } }).data;
    expect(d.startLine).toBe(1);
    expect(d.endLine).toBe(200);
    expect(d.script.text.split('\n')).toHaveLength(200);
    expect(d.notice).toContain('offset=201');
    expect(d.notice).toContain('grep_script');

    const page2 = await doGetScript({ id, offset: 201, limit: 50 });
    const p = (page2 as { data: { startLine: number; endLine: number; script: { text: string } } }).data;
    expect(p.startLine).toBe(201);
    expect(p.endLine).toBe(250);
    expect(p.script.text.split('\n')[0]).toMatch(/^ 201\| /);
  });

  it('get_script：总行数不超 200 时不带 notice', async () => {
    installFakeUserScripts();
    const c = await doCreateScript({ source: mkTm('n', 'https://a.com/*', 'a();') });
    const id = (c as { data: { id: string } }).data.id;
    const r = await doGetScript({ id });
    expect((r as { data: { notice?: string } }).data.notice).toBeUndefined();
  });

  it('回归：编排层 handleGet 不带行号（UI 拿干净原文）', async () => {
    installFakeUserScripts();
    const c = await doCreateScript({ source: mkTm('n', 'https://a.com/*', 'a();') });
    const id = (c as { data: { id: string } }).data.id;
    const raw = await handleGet(id);
    expect(raw.script.text.startsWith('// ==UserScript==')).toBe(true);
    expect(raw.script.text).not.toContain('| ');
  });
```

该测试文件顶部 import 补：

```ts
import { handleCreate, handleGet } from '../../../background/scripts';
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/agent/tools/script-pool.test.ts -t get_script`
Expected: FAIL —— 首行是 `// ==UserScript==`（无行号前缀），400 行脚本全量返回

- [ ] **Step 3: 实现标注与限量**

`agent/tools/script-pool.ts` 加常量与标注函数：

```ts
/** 模型不传区间时的默认返回行数（spec §4.4）：避免整份长脚本灌进上下文。 */
export const DEFAULT_GET_LIMIT = 200;

/** 给每行加右对齐行号前缀（`%4d| `），供模型做 edit 时不必自己数行。 */
export function annotateLines(text: string, startLine: number): string {
  return text
    .split('\n')
    .map((l, i) => `${String(startLine + i).padStart(4, ' ')}| ${l}`)
    .join('\n');
}
```

`doGetScript` 整体替换为：

```ts
export async function doGetScript(args: { id: string; offset?: number; limit?: number }): Promise<ToolResult> {
  try {
    // 模型不传区间 → 工具层自己按 DEFAULT_GET_LIMIT 请求（编排层语义不变，仍支持全文）
    const explicit = args.offset !== undefined || args.limit !== undefined;
    const offset = args.offset ?? 1;
    const limit = args.limit ?? (explicit ? undefined : DEFAULT_GET_LIMIT);
    const data = await handleGet(args.id, offset, limit);
    // 行号是标注不是内容：schema description 里说明写回时不要带上前缀
    const script = { ...data.script, text: annotateLines(data.script.text, data.startLine) };
    const notice = data.endLine < data.totalLines
      ? `已返回第 ${data.startLine}-${data.endLine} 行（共 ${data.totalLines} 行）。继续读用 offset=${data.endLine + 1}，定位特定代码用 grep_script。`
      : undefined;
    return { ok: true, data: { ...data, script, ...(notice ? { notice } : {}) } };
  } catch (e) {
    return { ok: false, error: `get_script 失败：${err(e)}` };
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/agent/tools/script-pool.test.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add agent/tools/script-pool.ts tests/agent/tools/script-pool.test.ts
git commit -m "feat(scripts): get_script 行号标注 + 默认 200 行限量与翻页提示"
```

---

## Task 7: `grep_script` 执行器

单独成文件：`script-pool.ts` 是 CRUD、这个是检索，职责不同且前者已在增长。

**Files:**
- Create: `agent/tools/script-grep.ts`
- Test: `tests/agent/tools/script-grep.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `tests/agent/tools/script-grep.test.ts`：

```ts
// tests/agent/tools/script-grep.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { doGrepScript } from '../../../agent/tools/script-grep';
import { saveScript } from '../../../storage/scripts';
import type { UserScript } from '../../../shared/types';

function mkScript(id: string, name: string, text: string): UserScript {
  return {
    id, text, name, enabled: true, matches: ['https://a.com/*'],
    code: text, runAt: 'document_idle', world: 'USER_SCRIPT',
    source: 'user', createdAt: 1, updatedAt: 1,
  };
}

type GrepMatch = { scriptId: string; name: string; line: number; text: string };
type GrepData = { matches: GrepMatch[]; truncated: boolean; warning?: string };
const data = (r: unknown) => (r as { data: GrepData }).data;

describe('grep_script', () => {
  beforeEach(async () => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
    await saveScript(mkScript('s1', '一号', 'const box = 1;\nconst BOX = 2;\nfoo();'));
    await saveScript(mkScript('s2', '二号', 'bar();\nconst box = 3;'));
  });

  it('单脚本检索：返回行号 + 带行号前缀的内容', async () => {
    const r = await doGrepScript({ pattern: 'box', id: 's1' });
    expect(r.ok).toBe(true);
    const d = data(r);
    expect(d.matches).toHaveLength(1);
    expect(d.matches[0]).toMatchObject({ scriptId: 's1', name: '一号', line: 1 });
    expect(d.matches[0]!.text).toMatch(/^\s+1\| const box = 1;$/);
    expect(d.truncated).toBe(false);
  });

  it('缺省 id → 搜全库，跨脚本命中', async () => {
    const d = data(await doGrepScript({ pattern: 'const box' }));
    expect(d.matches.map((m) => `${m.scriptId}:${m.line}`)).toEqual(['s1:1', 's2:2']);
  });

  it('ignoreCase 生效', async () => {
    expect(data(await doGrepScript({ pattern: 'BOX', id: 's1' })).matches).toHaveLength(1);
    expect(data(await doGrepScript({ pattern: 'BOX', id: 's1', ignoreCase: true })).matches).toHaveLength(2);
  });

  it('contextLines 带上下文行（去重、不重复输出同一行）', async () => {
    const d = data(await doGrepScript({ pattern: 'foo', id: 's1', contextLines: 1 }));
    expect(d.matches.map((m) => m.line)).toEqual([2, 3]);
  });

  it('limit 截断 → truncated: true', async () => {
    const d = data(await doGrepScript({ pattern: 'const', limit: 1 }));
    expect(d.matches).toHaveLength(1);
    expect(d.truncated).toBe(true);
  });

  it('正则语法生效；非法正则降级为字面量并带 warning', async () => {
    expect(data(await doGrepScript({ pattern: '^const \\w+', id: 's1' })).matches).toHaveLength(2);

    const d = data(await doGrepScript({ pattern: 'box(', id: 's1' }));
    expect(d.warning).toContain('字面量');
    expect(d.matches).toHaveLength(0);   // 字面量 'box(' 不存在
  });

  it('无命中 → 空数组，不报错', async () => {
    const d = data(await doGrepScript({ pattern: 'zzz-nope' }));
    expect(d.matches).toEqual([]);
    expect(d.truncated).toBe(false);
  });

  it('脚本不存在 → 报错', async () => {
    const r = await doGrepScript({ pattern: 'x', id: 'nope' });
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toContain('脚本不存在');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/agent/tools/script-grep.test.ts`
Expected: FAIL —— `Failed to resolve import "../../../agent/tools/script-grep"`

- [ ] **Step 3: 实现执行器**

创建 `agent/tools/script-grep.ts`：

```ts
// agent/tools/script-grep.ts
// grep_script 执行器（spec §4.5）：在脚本原文里按正则/字面量检索，返回行号 + 内容。
// 与 script-pool.ts 分文件：那边是 CRUD，这边是检索。
// 纯 storage 读取，豁免受限页预检（registry 在 RESTRICTED 检查之前分发）。

import type { ToolResult } from '../../shared/types';
import { getScript, listScripts } from '../../storage/scripts';
import { annotateLines } from './script-pool';

export const DEFAULT_GREP_LIMIT = 50;

interface GrepArgs {
  pattern: string;
  id?: string;
  ignoreCase?: boolean;
  contextLines?: number;
  limit?: number;
}

interface GrepMatch { scriptId: string; name: string; line: number; text: string }

/** 正则优先；非法正则降级为字面量子串搜索（返回 warning 说明，不让模型的一个手滑变成硬失败）。 */
function buildMatcher(pattern: string, ignoreCase: boolean): { test: (l: string) => boolean; warning?: string } {
  const flags = ignoreCase ? 'i' : '';
  try {
    const re = new RegExp(pattern, flags);
    return { test: (l) => re.test(l) };
  } catch {
    const needle = ignoreCase ? pattern.toLowerCase() : pattern;
    return {
      test: (l) => (ignoreCase ? l.toLowerCase() : l).includes(needle),
      warning: `pattern 不是合法正则，已降级为字面量子串搜索：${pattern}`,
    };
  }
}

export async function doGrepScript(args: GrepArgs): Promise<ToolResult> {
  try {
    if (typeof args.pattern !== 'string' || args.pattern === '') {
      return { ok: false, error: 'grep_script 需要非空 pattern' };
    }
    const limit = Math.max(1, Math.trunc(args.limit ?? DEFAULT_GREP_LIMIT));
    const ctx = Math.max(0, Math.trunc(args.contextLines ?? 0));

    let targets;
    if (args.id) {
      const one = await getScript(args.id);
      if (!one) return { ok: false, error: `脚本不存在：${args.id}` };
      targets = [one];
    } else {
      targets = await listScripts();
    }

    const { test, warning } = buildMatcher(args.pattern, args.ignoreCase ?? false);
    const matches: GrepMatch[] = [];
    let truncated = false;

    for (const s of targets) {
      const lines = s.text.split('\n');
      // 先收命中行号，再按 contextLines 膨胀成集合去重——避免相邻命中重复输出同一行
      const wanted = new Set<number>();
      for (let i = 0; i < lines.length; i += 1) {
        if (!test(lines[i]!)) continue;
        for (let k = Math.max(0, i - ctx); k <= Math.min(lines.length - 1, i + ctx); k += 1) {
          wanted.add(k);
        }
      }
      for (const idx of [...wanted].sort((a, b) => a - b)) {
        if (matches.length >= limit) { truncated = true; break; }
        matches.push({
          scriptId: s.id,
          name: s.name,
          line: idx + 1,
          text: annotateLines(lines[idx]!, idx + 1),
        });
      }
      if (truncated) break;
    }

    return { ok: true, data: { matches, truncated, ...(warning ? { warning } : {}) } };
  } catch (e) {
    return { ok: false, error: `grep_script 失败：${e instanceof Error ? e.message : String(e)}` };
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/agent/tools/script-grep.test.ts && npx tsc --noEmit`
Expected: PASS，9 个用例全绿

- [ ] **Step 5: 提交**

```bash
git add agent/tools/script-grep.ts tests/agent/tools/script-grep.test.ts
git commit -m "feat(scripts): grep_script 执行器（正则/字面量降级、全库检索、上下文行）"
```

---

## Task 8: `grep_script` 接线（schema + registry + ask 白名单）

工具数 26 → 27。

**Files:**
- Modify: `agent/tools/schemas.ts`、`agent/tools/registry.ts`、`agent/mode.ts`
- Test: `tests/agent/tools/schemas.test.ts`、`tests/agent/tools/registry.test.ts`、`tests/agent/mode.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/agent/tools/schemas.test.ts` 追加：

```ts
  it('grep_script schema：pattern 必填，id/ignoreCase/contextLines/limit 可选', () => {
    const g = TOOL_SCHEMAS.find((s) => s.function.name === 'grep_script')!;
    expect(g).toBeDefined();
    const p = g.function.parameters as { properties: Record<string, unknown>; required: string[] };
    expect(p.required).toEqual(['pattern']);
    expect(Object.keys(p.properties).sort()).toEqual(['contextLines', 'id', 'ignoreCase', 'limit', 'pattern']);
    // 缺省搜全库这条语义必须写进 description（模型据此决定是否传 id）
    expect(g.function.description).toContain('全库');
  });
```

`tests/agent/mode.test.ts` 追加：

```ts
  it('grep_script 属只读，ask 模式可用', () => {
    expect(ASK_MODE_TOOLS.has('grep_script')).toBe(true);
  });
```

`tests/agent/tools/registry.test.ts` 追加（沿用该文件既有的 ctx 构造方式）：

```ts
  it('grep_script 走 storage 分支，不做受限页预检', async () => {
    await saveScript({
      id: 'g1', text: 'const box = 1;', name: 'g', enabled: true, matches: ['https://a.com/*'],
      code: 'const box = 1;', runAt: 'document_idle', world: 'USER_SCRIPT',
      source: 'user', createdAt: 1, updatedAt: 1,
    });
    // 目标 tab 是受限页：脚本工具豁免预检，仍应正常返回
    const r = await executeTool('grep_script', { pattern: 'box' }, {
      tabId: 1, sessionId: 'c1', signal: new AbortController().signal,
    });
    expect(r.ok).toBe(true);
  });
```

若该文件尚未 import `saveScript`，补 `import { saveScript } from '../../../storage/scripts';`。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/agent/tools/schemas.test.ts tests/agent/mode.test.ts tests/agent/tools/registry.test.ts`
Expected: FAIL —— `grep_script` schema 未定义（`g` 为 undefined）、白名单无该项、`executeTool` 返回「未知工具」

- [ ] **Step 3: 加 schema**

`agent/tools/schemas.ts` 在 `get_script` 之后插入：

```ts
  {
    type: 'function',
    function: {
      name: 'grep_script',
      description:
        '在用户脚本原文中检索（按正则；非法正则自动降级为字面量子串）。id 缺省时搜索脚本库全部脚本——可用来回答「哪个脚本动了这个选择器/接口」。返回命中行的 scriptId、脚本名、行号与带行号前缀的内容。用于在不整份读回长脚本的前提下定位代码，配合 update_script 的 patch.replace 做精确改写。',
      parameters: obj(
        {
          pattern: { type: 'string', description: '检索式（正则语法；非法时按字面量处理）' },
          id: { type: 'string', description: '限定单个脚本 id；缺省搜全库' },
          ignoreCase: { type: 'boolean', description: '忽略大小写（默认 false）' },
          contextLines: { type: 'number', description: '每处命中额外返回的上下文行数（默认 0）' },
          limit: { type: 'number', description: '最多返回行数（默认 50，超出时 truncated=true）' },
        },
        ['pattern'],
      ),
    },
  },
```

- [ ] **Step 4: 接 registry 与 ask 白名单**

`agent/tools/registry.ts`：import 补 `import { doGrepScript } from './script-grep';`，并在 `get_script` 分发那行之后插入：

```ts
  if (name === 'grep_script') {
    return doGrepScript(args as { pattern: string; id?: string; ignoreCase?: boolean; contextLines?: number; limit?: number });
  }
```

`agent/mode.ts` 的 `ASK_MODE_TOOLS` 在 `'get_script',` 之后加一行：

```ts
  'grep_script',      // 脚本检索（纯读）
```

- [ ] **Step 5: 运行确认通过**

Run: `npx vitest run tests/agent/tools/ tests/agent/mode.test.ts && npx tsc --noEmit`
Expected: PASS。`tests/agent/tools/schemas.test.ts` 里若有工具名全集断言（`TOOL_SCHEMAS.map(...).sort()`），把 `grep_script` 加进期望数组。

- [ ] **Step 6: 提交**

```bash
git add agent/tools/schemas.ts agent/tools/registry.ts agent/mode.ts tests/
git commit -m "feat(scripts): grep_script 接线（schema/registry/ask 白名单），工具 26→27"
```

---

## Task 9: `max_tokens` 下发

卡死机制 2 的根治：此前该字段永不设置，走服务端默认（多数网关 2048~4096），长脚本必然截断。

**Files:**
- Modify: `storage/settings.ts`、`agent/loop.ts`、`background/agent-port.ts`、`components/settings/ModelSettings.tsx`
- Test: `tests/storage/settings.test.ts`、`tests/agent/loop.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/storage/settings.test.ts`：把三处 `agent` 的 `toEqual` 断言改为含新字段与新默认值（搜 `llmTimeoutSec: 10`）：

```ts
    expect(s.agent).toEqual({
      screenshotPolicy: 'on-demand', confirmGate: false, networkCaptureHeaders: 'redacted',
      llmTimeoutSec: 60, llmMaxRetries: 2, maxTokens: 8192,
    });
```

（`confirmGate` 沿用各用例原值，只改 `llmTimeoutSec` 并加 `maxTokens`。）并把 `it('默认 llmTimeoutSec=10 / llmMaxRetries=2')` 改为：

```ts
  it('默认 llmTimeoutSec=60 / llmMaxRetries=2 / maxTokens=8192', async () => {
    const s = await getSettings();
    expect(s.agent.llmTimeoutSec).toBe(60);
    expect(s.agent.llmMaxRetries).toBe(2);
    expect(s.agent.maxTokens).toBe(8192);
  });

  it('maxTokens 可存取，0 表示不下发', async () => {
    await saveSettings({ agent: { maxTokens: 0 } });
    expect((await getSettings()).agent.maxTokens).toBe(0);
  });
```

`tests/agent/loop.test.ts` 追加（断言 loop 把值透传给 provider 的 `ChatParams`）：

```ts
  it('getMaxTokens 提供时透传给 provider 的 ChatParams.maxTokens', async () => {
    const seen: Array<number | undefined> = [];
    const provider: Provider = {
      streamChat(p: ChatParams, onEvent: (e: StreamEvent) => void) {
        seen.push(p.maxTokens);
        queueMicrotask(() => onEvent({ type: 'message-done', finishReason: 'stop' }));
        return { cancel: vi.fn() };
      },
    };
    await runAgentLoop({ convId: 'cmt', tabId: 1, userMessage: 'x' },
      deps(provider, vi.fn(), { getMaxTokens: async () => 4096 }));
    expect(seen).toEqual([4096]);
  });

  it('getMaxTokens 返回 0 → 不下发（maxTokens 为 undefined）', async () => {
    const seen: Array<number | undefined> = [];
    const provider: Provider = {
      streamChat(p: ChatParams, onEvent: (e: StreamEvent) => void) {
        seen.push(p.maxTokens);
        queueMicrotask(() => onEvent({ type: 'message-done', finishReason: 'stop' }));
        return { cancel: vi.fn() };
      },
    };
    await runAgentLoop({ convId: 'cmt0', tabId: 1, userMessage: 'x' },
      deps(provider, vi.fn(), { getMaxTokens: async () => 0 }));
    expect(seen).toEqual([undefined]);
  });
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/storage/settings.test.ts tests/agent/loop.test.ts`
Expected: FAIL —— `maxTokens` 不存在于类型/默认值；loop 的 `seen` 为 `[undefined]`（第一个用例）

- [ ] **Step 3: 加设置项**

`storage/settings.ts` 的 `AgentConfig` 追加字段：

```ts
  /** 单轮回复的 token 上限（下发为 max_tokens）。此前从不下发 → 走服务端默认（多数网关
   *  2048~4096），长脚本必然被截断。0 = 不下发该字段（留给对它敏感的特殊网关）。 */
  maxTokens: number;
```

`DEFAULT_SETTINGS.agent` 里 `llmTimeoutSec` 改 60 并加 `maxTokens`：

```ts
    llmTimeoutSec: 60,
    llmMaxRetries: 2,
    maxTokens: 8192,
```

- [ ] **Step 4: loop 透传**

`agent/loop.ts` 的 `LoopDeps` 追加：

```ts
  /** 单轮 token 上限（0/缺省 = 不下发 max_tokens）。 */
  getMaxTokens?: () => Promise<number>;
```

`drive()` 里 `runTurn` 调用改为（在其上方取值）：

```ts
    const maxTokens = (await deps.getMaxTokens?.()) ?? 0;
    const result = await runTurn(deps.provider, {
      messages, tools: getToolSchemas(mode), signal,
      ...(maxTokens > 0 ? { maxTokens } : {}),
    }, {
      onTextDelta: (t) => deps.emit({ type: 'text-delta', text: t }),
      onReasoningDelta: (t) => deps.emit({ type: 'reasoning-delta', text: t }),
    });
```

- [ ] **Step 5: 注入依赖**

`background/agent-port.ts` 的 `makeDeps` 里，`getContextWindow` 之后加：

```ts
    getMaxTokens: async () => (await getSettings()).agent.maxTokens,
```

- [ ] **Step 6: 设置页输入框**

`components/settings/ModelSettings.tsx` 在「超时时间（秒）」那个 `.field` **之前**插入：

```tsx
        <div className="field">
          <label className="field-label">单轮回复上限（token，0 = 不下发）</label>
          <Input
            type="number"
            min={0}
            value={settings.agent.maxTokens}
            onChange={(e) => {
              const v = Number(e.target.value);
              setSettings({ ...settings, agent: { ...settings.agent, maxTokens: Number.isFinite(v) ? Math.max(0, v) : 0 } });
            }}
          />
          <span className="hint">下发为 max_tokens。太小会让长回复/长工具参数被截断；置 0 则不下发该字段（走服务端默认）。</span>
        </div>
```

- [ ] **Step 7: 运行确认通过**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 全绿。`tests/background/agent-port.test.ts` 若断言 `makeDeps` 的键集合，补上 `getMaxTokens`。

- [ ] **Step 8: 提交**

```bash
git add storage/settings.ts agent/loop.ts background/agent-port.ts components/settings/ModelSettings.tsx tests/
git commit -m "fix(agent): 下发 max_tokens（默认 8192）+ 超时默认 10s→60s"
```

---

## Task 10: 静默窗 300s 硬兜底

`timeoutMs=0`（不限时）时网关真挂死 → `runTurn` 的 Promise 永不 resolve → `runningConvs` 永久占位 → 面板永久 running。这个兜底堵住它。

**Files:**
- Modify: `agent/provider/openai-compat.ts`
- Test: `tests/agent/provider/openai-compat.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
  it('timeoutMs=0（不限时）仍有硬兜底：超过 hardCapMs 判死并报错', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.mocked(fetch);
    // 永不 settle 的 fetch：模拟网关挂死
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const p = new OpenAICompatProvider(
      { baseUrl: 'https://api.x.com/v1', apiKey: 'k', model: 'm' },
      { timeoutMs: 0, maxRetries: 0, hardCapMs: 1000 },
    );
    const events: StreamEvent[] = [];
    const done = new Promise<void>((resolve) => {
      p.streamChat(baseParams(), (e) => {
        events.push(e);
        if (e.type === 'message-done') resolve();
      });
    });
    await vi.advanceTimersByTimeAsync(1100);
    await done;
    expect(events.some((e) => e.type === 'error' && /超时/.test(e.error))).toBe(true);
    expect(events[events.length - 1]!.type).toBe('message-done');
    vi.useRealTimers();
  });
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/agent/provider/openai-compat.test.ts -t 硬兜底`
Expected: FAIL —— `hardCapMs` 不是 `ProviderOptions` 的字段（tsc 报错），且 `timeoutMs: 0` 下永不 settle（测试超时）

- [ ] **Step 3: 实现兜底**

`agent/provider/openai-compat.ts` 的 `ProviderOptions` 追加：

```ts
  /** timeoutMs=0（不限时）时的硬兜底静默窗（毫秒）。防「网关挂死 → Promise 永不 resolve
   *  → runningConvs 永久占位 → 面板永久 running」。默认 300s；仅测试注入更小值。 */
  hardCapMs?: number;
```

同文件常量区加：

```ts
const HARD_SILENT_CAP_MS = 300_000;
```

`runAttempt` 内 `const timeoutMs = this.options.timeoutMs ?? 0;` 改为：

```ts
      // timeoutMs=0 表示用户关掉了超时保护——仍保留一个远大的硬兜底，避免永久悬挂
      const configured = this.options.timeoutMs ?? 0;
      const timeoutMs = configured > 0 ? configured : (this.options.hardCapMs ?? HARD_SILENT_CAP_MS);
```

同时把文件头注释里「`options.timeoutMs = 0` 表示不限时」一句改为：

```ts
// - options.timeoutMs = 0 表示不限时，但仍有 300s 硬兜底（hardCapMs）防永久悬挂；
//   调用方 signal 的 abort 永远优先（不重试，直接收尾）。
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/agent/provider/openai-compat.test.ts && npx tsc --noEmit`
Expected: PASS。注意原先「`timeoutMs` 缺省即不限时」的既有用例：缺省 `hardCapMs` 为 300s，短测试不会触发，应保持通过。

- [ ] **Step 5: 提交**

```bash
git add agent/provider/openai-compat.ts tests/agent/provider/openai-compat.test.ts
git commit -m "fix(provider): timeoutMs=0 时加 300s 静默硬兜底，防运行态永久悬挂"
```

---

## Task 11: `tool-args-delta` 后端链路（协议 + run-turn + loop 节流 + tail）

卡死机制 1 的根治。模型吐完文本后开始生成工具参数，此前面板收不到任何事件 —— UI 是聋的。

**Files:**
- Modify: `shared/messages.ts`、`agent/run-turn.ts`、`agent/loop.ts`、`background/agent-tail.ts`
- Test: `tests/agent/run-turn.test.ts`、`tests/agent/loop.test.ts`、`tests/background/agent-tail.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/agent/run-turn.test.ts` 追加：

```ts
  it('onToolArgsDelta：每次 tool-call-delta 回调带工具名与累计字节数', async () => {
    const seen: Array<[string, number]> = [];
    const provider: Provider = {
      streamChat(_p, onEvent) {
        queueMicrotask(() => {
          onEvent({ type: 'tool-call-delta', index: 0, id: 'c1', name: 'create_script', argsDelta: '{"a' });
          onEvent({ type: 'tool-call-delta', index: 0, argsDelta: '":1}' });
          onEvent({ type: 'message-done', finishReason: 'tool_calls' });
        });
        return { cancel: vi.fn() };
      },
    };
    await runTurn(provider, { messages: [], tools: [] }, {
      onToolArgsDelta: (name, bytes) => seen.push([name, bytes]),
    });
    expect(seen).toEqual([['create_script', 3], ['create_script', 7]]);
  });
```

`tests/agent/loop.test.ts` 追加（节流：首次立即发、1KB 阈值再发）：

```ts
  it('tool-args-delta：节流后 emit（首次立即 + 每 1KB）', async () => {
    const big = 'x'.repeat(1200);
    const provider: Provider = {
      streamChat(_p: ChatParams, onEvent: (e: StreamEvent) => void) {
        queueMicrotask(() => {
          onEvent({ type: 'tool-call-delta', index: 0, id: 'c1', name: 'create_script', argsDelta: '{}' });
          onEvent({ type: 'tool-call-delta', index: 0, argsDelta: big });
          onEvent({ type: 'message-done', finishReason: 'stop' });
        });
        return { cancel: vi.fn() };
      },
    };
    const d = deps(provider, vi.fn());
    await runAgentLoop({ convId: 'cad', tabId: 1, userMessage: 'x' }, d);
    const calls = vi.mocked(d.emit).mock.calls.map(([e]) => e).filter((e) => e.type === 'tool-args-delta');
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[0]).toMatchObject({ type: 'tool-args-delta', name: 'create_script', bytes: 2 });
    expect(calls[calls.length - 1]).toMatchObject({ name: 'create_script', bytes: 1202 });
  });
```

`tests/background/agent-tail.test.ts` 追加：

```ts
  it('tool-args-delta 写入 argsProgress，tool-start/done 清空', () => {
    let t = reduceTail(emptyTail(), { type: 'tool-args-delta', name: 'create_script', bytes: 512 });
    expect(t.argsProgress).toEqual({ name: 'create_script', bytes: 512 });
    // 覆盖写（不累加——事件里的 bytes 已是累计值）
    t = reduceTail(t, { type: 'tool-args-delta', name: 'create_script', bytes: 900 });
    expect(t.argsProgress).toEqual({ name: 'create_script', bytes: 900 });

    expect(reduceTail(t, { type: 'tool-start', name: 'create_script', args: '{}', callId: 'c1' }).argsProgress).toBeUndefined();
    expect(reduceTail(t, { type: 'done', finalText: 'x' }).argsProgress).toBeUndefined();
    expect(reduceTail(t, { type: 'error', message: 'e' }).argsProgress).toBeUndefined();
  });

  it('replayTail 末尾补发 argsProgress（重新附着能看到进度）', () => {
    const t = reduceTail(emptyTail(), { type: 'tool-args-delta', name: 'create_script', bytes: 300 });
    const events = replayTail({ ...t, text: '写脚本' });
    expect(events[events.length - 1]).toEqual({ type: 'tool-args-delta', name: 'create_script', bytes: 300 });
  });
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/agent/run-turn.test.ts tests/agent/loop.test.ts tests/background/agent-tail.test.ts`
Expected: FAIL —— `tool-args-delta` 不是 `AgentEvent` 的成员（tsc 报错），hook 未定义

- [ ] **Step 3: 加事件类型**

`shared/messages.ts` 的 `AgentEvent` 在 `tool-start` 之前插入一支：

```ts
  /** 工具参数流式生成中（bytes = 已累计字节数，非增量）。根治「模型在写长参数时 UI 全静默」。 */
  | { type: 'tool-args-delta'; name: string; bytes: number }
```

- [ ] **Step 4: run-turn 加 hook**

`agent/run-turn.ts` 的 `RunTurnHooks` 追加：

```ts
  /** 工具参数增量：name = 工具名，bytes = 该 tool_call 参数已累计字节数。 */
  onToolArgsDelta?: (name: string, bytes: number) => void;
```

`tool-call-delta` 分支末尾（`agg.set(e.index, cur);` 之后）追加：

```ts
          if (cur.name) {
            try { hooks.onToolArgsDelta?.(cur.name, cur.args.length); } catch { /* 忽略消费者回调异常 */ }
          }
```

- [ ] **Step 5: loop 节流 emit**

`agent/loop.ts` 文件底部（`toToolContent` 旁）加节流器：

```ts
const ARGS_THROTTLE_MS = 200;
const ARGS_THROTTLE_BYTES = 1024;

/** 参数进度节流：首次立即发，之后满 200ms 或涨够 1KB 才发（避免逐 token 广播）。
 *  每轮 runTurn 前新建一个，状态不跨轮。 */
function makeArgsThrottle(emit: (name: string, bytes: number) => void): (name: string, bytes: number) => void {
  let lastAt = 0;
  let lastBytes = -1;
  return (name, bytes) => {
    const now = Date.now();
    if (lastBytes >= 0 && now - lastAt < ARGS_THROTTLE_MS && bytes - lastBytes < ARGS_THROTTLE_BYTES) return;
    lastAt = now;
    lastBytes = bytes;
    emit(name, bytes);
  };
}
```

`drive()` 里 `runTurn` 调用改为（承接 Task 9 的 `maxTokens` 形态）：

```ts
    const onArgs = makeArgsThrottle((name, bytes) => deps.emit({ type: 'tool-args-delta', name, bytes }));
    const result = await runTurn(deps.provider, {
      messages, tools: getToolSchemas(mode), signal,
      ...(maxTokens > 0 ? { maxTokens } : {}),
    }, {
      onTextDelta: (t) => deps.emit({ type: 'text-delta', text: t }),
      onReasoningDelta: (t) => deps.emit({ type: 'reasoning-delta', text: t }),
      onToolArgsDelta: onArgs,
    });
```

- [ ] **Step 6: tail 记住进度**

`background/agent-tail.ts` 的 `AgentTail` 追加字段并接 reduce/replay：

```ts
export interface AgentTail {
  reasoning: string;
  text: string;
  compacting: boolean;
  /** 当前 tool_call 参数生成进度（瞬态）：切标签回来仍能看到，边界事件清空。 */
  argsProgress?: { name: string; bytes: number };
}
```

`reduceTail` 在 `compact-done` 之后加一支（`tool-start`/`done`/`paused`/`error` 已走 `emptyTail()`，自然清空）：

```ts
    case 'tool-args-delta':
      // bytes 是累计值 → 覆盖写而非累加
      return { ...tail, argsProgress: { name: e.name, bytes: e.bytes } };
```

`replayTail` 末尾补发：

```ts
  if (tail.argsProgress) {
    out.push({ type: 'tool-args-delta', name: tail.argsProgress.name, bytes: tail.argsProgress.bytes });
  }
```

- [ ] **Step 7: 运行确认通过**

Run: `npx vitest run tests/agent/ tests/background/agent-tail.test.ts && npx tsc --noEmit`
Expected: PASS。`emptyTail()` 返回不含 `argsProgress`（可选字段缺省即 undefined），既有断言不受影响。

- [ ] **Step 8: 提交**

```bash
git add shared/messages.ts agent/run-turn.ts agent/loop.ts background/agent-tail.ts tests/
git commit -m "feat(agent): tool-args-delta 参数生成进度事件（run-turn hook + loop 节流 + tail 续播）"
```

---

## Task 12: 参数进度前端渲染

**Files:**
- Modify: `stores/chat.ts`、`components/chat/ChatView.tsx`、`entrypoints/sidepanel/styles.css`
- Test: `tests/chat/args-progress.test.ts`（新建）

- [ ] **Step 1: 写失败测试**

创建 `tests/chat/args-progress.test.ts`：

```ts
// tests/chat/args-progress.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useChat } from '../../stores/chat';

describe('chat store：参数生成进度（顶层瞬态）', () => {
  beforeEach(() => useChat.getState().reset());

  it('tool-args-delta 写入顶层 argsProgress，不进 messages', () => {
    useChat.getState().applyEvent({ type: 'tool-args-delta', name: 'create_script', bytes: 512 });
    expect(useChat.getState().argsProgress).toEqual({ name: 'create_script', bytes: 512 });
    expect(useChat.getState().messages).toHaveLength(0);
  });

  it('后续事件覆盖写（bytes 是累计值）', () => {
    const { applyEvent } = useChat.getState();
    applyEvent({ type: 'tool-args-delta', name: 'create_script', bytes: 512 });
    applyEvent({ type: 'tool-args-delta', name: 'create_script', bytes: 2048 });
    expect(useChat.getState().argsProgress).toEqual({ name: 'create_script', bytes: 2048 });
  });

  it('tool-start / done / paused / error 清空进度', () => {
    const set = () => useChat.getState().applyEvent({ type: 'tool-args-delta', name: 'x', bytes: 1 });

    set();
    useChat.getState().applyEvent({ type: 'tool-start', name: 'x', args: '{}', callId: 'c1' });
    expect(useChat.getState().argsProgress).toBeUndefined();

    set();
    useChat.getState().applyEvent({ type: 'done', finalText: 'ok' });
    expect(useChat.getState().argsProgress).toBeUndefined();

    set();
    useChat.getState().applyEvent({ type: 'paused', reason: 'r' });
    expect(useChat.getState().argsProgress).toBeUndefined();

    set();
    useChat.getState().applyEvent({ type: 'error', message: 'e' });
    expect(useChat.getState().argsProgress).toBeUndefined();
  });

  it('reset 清空进度', () => {
    useChat.getState().applyEvent({ type: 'tool-args-delta', name: 'x', bytes: 1 });
    useChat.getState().reset();
    expect(useChat.getState().argsProgress).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/chat/args-progress.test.ts`
Expected: FAIL —— `argsProgress` 不存在于 store 类型（tsc 报错），运行时为 undefined 且不被清理逻辑覆盖

- [ ] **Step 3: 改 store**

`stores/chat.ts` 的 `ChatState` 追加：

```ts
  /** 当前 tool_call 参数流式生成进度（瞬态，不入 messages）：模型在写长参数时的可见反馈。 */
  argsProgress?: { name: string; bytes: number };
```

`applyEvent` 的 `switch` 里，在 `case 'tool-start'` 之前插入：

```ts
      case 'tool-args-delta':
        // bytes 是累计值 → 覆盖写
        return { argsProgress: { name: e.name, bytes: e.bytes } };
```

并把这四支的返回补上清空（参数已生成完或轮次已收尾）：

```ts
      case 'tool-start': {
        collapseTrailingThinking(messages);
        if (e.callId && messages.some((m) => m.role === 'tool' && m.callId === e.callId)) {
          return { messages, argsProgress: undefined };
        }
        messages.push({ role: 'tool', name: e.name, args: e.args, callId: e.callId, status: 'running' });
        return { messages, argsProgress: undefined };
      }
```

```ts
      case 'paused':
        collapseTrailingThinking(messages);
        return { messages, status: 'paused', pauseReason: e.reason, argsProgress: undefined };
      case 'done':
        collapseTrailingThinking(messages);
        return { messages, status: 'idle', argsProgress: undefined };
      case 'error':
        collapseTrailingThinking(messages);
        messages.push({ role: 'error', text: e.message });
        return { messages, status: 'idle', argsProgress: undefined };
```

`reset()` 的对象里追加 `argsProgress: undefined`。

- [ ] **Step 4: 渲染**

`components/chat/ChatView.tsx` 第 38 行的解构加 `argsProgress`：

```tsx
  const { messages, status, pauseReason, applyEvent, promptTokens, compacting, argsProgress } = useChat();
```

在 `{status === 'paused' && (...)}` 那个块**之前**插入（即消息列表末尾）：

```tsx
            {argsProgress && status === 'running' && (
              <div className="argsprog rise">
                <span className="mono argsprog__name">{argsProgress.name}</span>
                <span className="argsprog__text">正在生成参数…</span>
                <span className="mono argsprog__size">{formatBytes(argsProgress.bytes)}</span>
              </div>
            )}
```

同文件底部（其它辅助函数旁）加：

```tsx
/** 参数进度的体积显示：<1KB 显示字节，否则一位小数的 KB。 */
function formatBytes(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}
```

- [ ] **Step 5: 样式**

`entrypoints/sidepanel/styles.css` 末尾追加（复用现有 token，不硬编码色值）：

```css
/* 工具参数生成进度：模型在写长参数（如 create_script.source）时的可见反馈 */
.argsprog {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border: 1px dashed var(--line-strong);
  border-radius: 6px;
  background: var(--signal-wash);
  font-size: 12px;
}
.argsprog__name { color: var(--signal-ink); font-weight: 600; }
.argsprog__text { color: var(--ink-3); }
.argsprog__size { color: var(--ink-3); margin-left: auto; }
```

用到的 token 均已在 `:root` 定义（`--line-strong` / `--signal-wash` / `--signal-ink` / `--ink-3`，见 [styles.css:14-21](../../../entrypoints/sidepanel/styles.css#L14-L21)）。`.rise` 是既有入场动效类（已含 `prefers-reduced-motion` 兜底），复用即可，不新增关键帧。

- [ ] **Step 6: 运行确认通过**

Run: `npx vitest run tests/chat/ && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add stores/chat.ts components/chat/ChatView.tsx entrypoints/sidepanel/styles.css tests/chat/args-progress.test.ts
git commit -m "feat(chat): 参数生成进度指示（顶层瞬态 + 消息流末尾渲染）"
```

---

## Task 13: 截断教学文案

模型看到错误就会改路径。这是零成本的最后一道纠正。

**Files:**
- Modify: `agent/loop.ts:127-142`
- Test: `tests/agent/loop.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
  it('finishReason=length + toolCalls → tool 消息含分步指引（教学式纠正）', async () => {
    const provider = queuedProvider([[
      { type: 'tool-call-delta', index: 0, id: 'c1', name: 'create_script', argsDelta: '{"source":"//截断' },
      { type: 'message-done', finishReason: 'length' },
    ], [
      { type: 'text-delta', text: '改用分步' },
      { type: 'message-done', finishReason: 'stop' },
    ]]);
    await runAgentLoop({ convId: 'clen', tabId: 1, userMessage: 'x' }, deps(provider, vi.fn()));
    const conv = await getConversation('clen');
    const toolMsg = conv.messages.find((m) => m.role === 'tool')!;
    expect(toolMsg.content).toContain('截断');
    expect(toolMsg.content).toContain('append');
    expect(toolMsg.content).toContain('骨架');
  });
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/agent/loop.test.ts -t 教学式`
Expected: FAIL —— 现文案只有「错误：模型输出被截断，该工具调用参数不完整，请重新发起」，不含 `append`/`骨架`

- [ ] **Step 3: 改文案**

`agent/loop.ts` 的 `finishReason === 'length'` 分支里那条 `appendMessage` 的 content 改为：

```ts
        await appendMessage(convId, {
          role: 'tool', toolCallId: tc.id, name: tc.name,
          content: '错误：模型输出被截断，该工具调用参数不完整。若在写长脚本，请改用分步方式：'
            + '先 create_script 只提交元数据头 + 未闭合的 IIFE 骨架（如 `(function () {` 结尾，不写 `})();`），'
            + '再用 update_script 的 patch.append 分次追加代码体，最后一段带上 `})();` 闭合。',
        });
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/agent/loop.test.ts`
Expected: PASS。若既有用例断言旧文案原文，改为断言「截断」子串。

- [ ] **Step 5: 提交**

```bash
git add agent/loop.ts tests/agent/loop.test.ts
git commit -m "fix(agent): 截断错误文案改为分步指引（教学式纠正）"
```

---

## Task 14: schema description 与 SYSTEM_PROMPT

工具契约的自描述 —— 模型只看 description，不看我们的 spec。

**Files:**
- Modify: `agent/tools/schemas.ts`、`agent/context.ts`
- Test: `tests/agent/tools/schemas.test.ts`、`tests/agent/context.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/agent/tools/schemas.test.ts` 追加：

```ts
  it('create_script description：写明长度阈值与骨架不闭合约定', () => {
    const d = TOOL_SCHEMAS.find((s) => s.function.name === 'create_script')!.function.description;
    expect(d).toContain('200 行');
    expect(d).toContain('append');
    expect(d).toContain('})();');   // 骨架不写闭合这条必须显式出现
  });

  it('update_script description：写明 append/replace 语义与互斥', () => {
    const u = TOOL_SCHEMAS.find((s) => s.function.name === 'update_script')!;
    const props = (u.function.parameters as { properties: { patch: { properties: Record<string, unknown> } } })
      .properties.patch.properties;
    expect(Object.keys(props).sort()).toEqual(['append', 'applyUpdate', 'edit', 'enabled', 'replace', 'text']);
    expect(u.function.description).toContain('append');
    expect(u.function.description).toContain('replace');
    expect(u.function.description).toContain('balance');
  });

  it('get_script description：说明行号前缀不是内容 + 默认限量', () => {
    const d = TOOL_SCHEMAS.find((s) => s.function.name === 'get_script')!.function.description;
    expect(d).toContain('行号');
    expect(d).toContain('200');
  });

  it('list_scripts description：提及 lines 用于判断读取策略', () => {
    const d = TOOL_SCHEMAS.find((s) => s.function.name === 'list_scripts')!.function.description;
    expect(d).toContain('lines');
  });
```

`tests/agent/context.test.ts` 追加（import 行同步补 `SYSTEM_PROMPT`）：

```ts
import { buildContext, truncateMessages, SYSTEM_PROMPT } from '../../agent/context';
```

```ts
  it('SYSTEM_PROMPT 含「长内容分步写入」通用规则', () => {
    expect(SYSTEM_PROMPT).toContain('骨架');
    expect(SYSTEM_PROMPT).toContain('截断');
  });
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/agent/tools/schemas.test.ts tests/agent/context.test.ts`
Expected: FAIL —— description 不含这些子串；`patch.properties` 缺 `append`/`replace`

- [ ] **Step 3: 改 create_script description**

`agent/tools/schemas.ts` 的 `create_script.description` 末尾追加：

```
source 有长度上限（200 行 / 8192 字符）：超限会被拒绝。写长脚本请分步——本次只提交元数据头 + 未闭合的 IIFE 骨架（写到 `(function () {` 为止，不要写 `})();`），再用 update_script 的 patch.append 分次追加代码体，最后一段带上 `})();` 闭合。骨架若提前闭合，后续追加的代码会落到 IIFE 外的全局作用域。
```

- [ ] **Step 4: 改 update_script**

`description` 末尾追加：

```
append 追加到原文末尾（不需要行号，分步写脚本的主力）；replace 按字面量精确替换 {old,new,all?}（不依赖行号，old 必须在原文中唯一，命中多处会报错并列出行号，可加上下文让它唯一或传 all:true）。text/edit/append/replace 四支互斥，一次只能传一支。返回里的 balance 是括号配平状态：分步过程中骨架未闭合时为 unclosed（正常），最后一段写完应为 ok；若不为 ok 就用 grep_script 定位漏掉的括号再 replace 修正。
```

`patch` 的 `properties` 追加两项：

```ts
              append: { type: 'string', description: '追加到原文末尾（不需要行号）' },
              replace: {
                type: 'object',
                description: '字面量精确替换（不依赖行号）；old 需在原文中唯一',
                properties: {
                  old: { type: 'string', description: '要被替换的原文片段（字面量，非正则）' },
                  new: { type: 'string', description: '替换为' },
                  all: { type: 'boolean', description: 'old 命中多处时全部替换（默认 false，多处则报错）' },
                },
                required: ['old', 'new'],
              },
```

`patch` 的 `description` 改为：`'至少包含 applyUpdate / text / edit / append / replace / enabled 之一；四个文本分支互斥'`。

- [ ] **Step 5: 改 get_script / list_scripts**

`get_script.description` 末尾追加：

```
返回的每行带 `  12| ` 形式的行号前缀（右对齐 4 位）——它是标注不是文件内容，写回时不要带上。不传 offset/limit 时默认只返回前 200 行并在 notice 里给出续读位置；定位特定代码用 grep_script 更省上下文。
```

`list_scripts.description` 末尾追加：

```
summary 含 lines/bytes（脚本规模）：行数多时优先用 grep_script 定位或 get_script 按区间读，不要整份读回。
```

- [ ] **Step 6: 改 SYSTEM_PROMPT**

`agent/context.ts` 的 `SYSTEM_PROMPT`「工具使用要点」列表末尾（`- 完成任务后直接用自然语言回复用户，不要再调工具。` 之前）加一行：

```
- 写长内容（脚本、长文本）时不要一次性塞进单个工具参数——单次输出有长度上限，超限会被截断且整个调用作废。先建骨架再分次追加。
```

- [ ] **Step 7: 运行确认通过**

Run: `npx vitest run tests/agent/ && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 8: 提交**

```bash
git add agent/tools/schemas.ts agent/context.ts tests/
git commit -m "docs(agent): schema description 与 SYSTEM_PROMPT 写入分步写入规则"
```

---

## Task 15: write-script 技能正文重写

技能正文是模型写脚本时真正遵循的剧本。第 1、2 步（确认需求/探索页面）不动，第 3 步改为分步流程。

**Files:**
- Modify: `public/skills/builtin.md`（write-script 文档，约 106-146 行）

- [ ] **Step 1: 确认现行正文**

Read `public/skills/builtin.md` 的 106 行到文件尾（write-script 文档），确认文档边界（`---` 分隔）与现第 3 步内容。

- [ ] **Step 2: 重写第 3 步**

把 `## 第 3 步：编写、安装、调试` 整节替换为：

```markdown
## 第 3 步：编写、安装、调试（分步写入）

**为什么分步**：单次工具调用的参数有长度上限，长脚本一次性塞进 `create_script` 会被截断作废。骨架 → 追加 → 闭合，每步都是一次独立调用，输出量小、可恢复。

1. **提交骨架**：`create_script(source=...)` 只含元数据头 + 未闭合 IIFE：
   - 头部必备：`@name`（中文）、`@match`（精确到作用站点，宁窄勿宽）、`@version`、`@description`；必要时 `@run-at`（document-end 默认、SPA 考虑 document-start/idle）。
   - 代码体写到 `(function () {\n  'use strict';\n` 为止，**不写** `})();`——提前闭合会让后续追加落到全局作用域。
   - source 上限 200 行 / 8192 字符，骨架远小于此，不会触发。
2. **分段追加**：`update_script(id, { append: '...' })` 按功能块逐段追加，每段 50~80 行：
   - 硬规则：切在函数或语句块边界，绝不切在语句/字符串中间；
   - 最后一段带上 `})();` 闭合 IIFE；
   - 每次 append 都会返回 `balance` 配平状态：过程中 `unclosed` 是正常的（骨架本来就没闭合），最后一段写完应为 `ok`。
3. **配平不对就修**：`balance` 不是 `ok` 时，用 `grep_script` 搜漏掉的括号/引号，用 `update_script(id, { replace: { old, new } })` 修正（old 要带上足够上下文保证唯一）。
4. **注入验证**：
   - `navigate_page` 到目标页（刷新触发注入），`list_console_messages` 看有无报错（语法错误会在 console 报 SyntaxError）；
   - `take_screenshot` 或 `evaluate_script` 检查效果是否符合预期。
5. **迭代修正**：优先 `patch.replace`（精确、不依赖行号）；需要看代码时用 `get_script` 按区间读（返回带行号，默认只给前 200 行）或 `grep_script` 定位，不要整份读回；改完再刷新验证，直到符合预期。
6. 收尾：告诉用户脚本已安装、作用在哪些站点、如何启停（脚本池开关）、想改需求随时再说。
```

正文里旧的「本扩展支持的 GM API 共 14 个……」约束句保留在骨架步骤附近（挪进第 1 条或紧随其后），不要丢。

- [ ] **Step 3: 验证解析不破**

Run: `npx vitest run tests/background/builtin-skills.test.ts`
Expected: PASS（parseSkillMdDocument 对该文件的既有解析不受影响——文档仍以 `---` 分隔、frontmatter 完整）

- [ ] **Step 4: 提交**

```bash
git add public/skills/builtin.md
git commit -m "docs(skill): write-script 第 3 步改为分步写入流程（骨架→append→闭合→验证）"
```

---

## Task 16: 全量回归收口

**Files:**
- 无新改动（纯验证）

- [ ] **Step 1: 全量测试**

Run: `npx vitest run`
Expected: 全绿。若有失败，逐个修复（常见源：schemas.test 的工具名全集断言、agent-port.test 的 makeDeps 键断言、settings.test 默认值断言）。

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无输出。

- [ ] **Step 3: 生产构建冒烟**

Run: `npm run build`
Expected: 构建成功，无 error（warning 可接受）。

- [ ] **Step 4: 收尾提交**

若有散落的修复：

```bash
git add -A
git commit -m "fix: 全量回归修复（工具计数断言/默认值/makeDeps 键）"
```

- [ ] **Step 5: 更新 CLAUDE.md 项目记录**

在 `CLAUDE.md` 的 Phase 5 段落之后追加一段（沿用既有文风，一段话概括本次改动：卡死四修 + 分步原语 + grep + 进度事件），标注日期 2026-09-06 与 spec/plan 文件名。提交：

```bash
git add CLAUDE.md
git commit -m "docs(claude): 记录 AI 写脚本流程优化（2026-09-06）"
```

---

## 任务依赖与顺序

```
Task 1 (js-balance) ─┐
Task 2 (append/replace) ─┼→ Task 4 (瘦身+balance) → Task 5 (硬闸) → Task 16
Task 3 (lines/bytes) ─┘
Task 6 (get_script 标注) → Task 7 (grep 执行器) → Task 8 (接线) ↘
Task 9 (max_tokens) → Task 10 (硬兜底) → Task 11 (args-delta 后端) → Task 12 (前端) → Task 13 (文案) → Task 14 (schema/prompt) → Task 15 (技能) ↗
```

严格顺序执行即可（1→16）；Task 1/2/3 相互独立，可并行。

