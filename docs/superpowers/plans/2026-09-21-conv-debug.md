# AI 会话调试页 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 agent loop 补一层轻量结构化 trace 落盘，并新增一个独立标签页承载「会话列表 + 轮次时间线 + 原始消息流」的只读调试视图，入口挂在设置页「开发者工具」组。

**Architecture:** 三层分离——`storage/traces.ts` 只管持久化（每会话一个环形数组，独立 key 避免与消息数组共用写放大）；`agent/trace.ts` 是采集器（把 storage 细节封在 `createTurnRecorder` 里，loop 只调语义方法）；`components/convdebug/*` 是纯只读投影（页面直接 import `storage/*` 读数据，不走消息协议）。`drive()` 的每轮迭代包一层 `try/finally`，9 处出口一处收口 commit。

**Tech Stack:** WXT 0.21（新增 html entrypoint，自动发现，无需改 `wxt.config.ts`）、React 19、TypeScript、lucide-react（图标，禁用 emoji）、vitest 4 + jsdom + `wxt/testing/fake-browser`。

**Spec:** `docs/superpowers/specs/2026-09-21-conv-debug-design.md`

## Global Constraints

- 所有样式写在 `entrypoints/sidepanel/styles.css`，新页面通过 `import '../sidepanel/styles.css'` 复用（`entrypoints/script-detail/main.tsx:5` 是模板）。
- 只使用 CSS 变量（`:root` tokens），**禁止硬编码色值**。可用 token：`--paper --surface --sunken --ink --ink-2 --ink-3 --line --line-strong --signal --signal-ink --signal-wash --ok --ok-wash --err --err-wash --warn --warn-wash --mono --sans --r-sm --r-md --r-lg --ease --t-fast --t-mid --t-slow`。
- 双声道排版：`mono` 类用于机器语言（工具名、uid、JSON、状态令牌、耗时、token），`sans` 用于人语言。
- 图标一律用 `lucide-react`，**禁止用 emoji 代替图标**。
- 动画必须带 `@media (prefers-reduced-motion: reduce)` 兜底。
- 测试命令：`npm run test`（全量）、`npx vitest run <path>`（单文件）。类型检查：`npm run compile`。
- 新 entrypoint 建好后必须跑一次 `npx wxt prepare`，让 `.wxt/types/paths.d.ts` 收录 `/conv-debug.html`。
- 每个任务结束都要 `git add` **明确列出的文件**再 commit——工作树里有一个无关的 `package-lock.json` 改动，不要把它卷进来。

---

### Task 1: trace 持久化层

**Files:**
- Create: `storage/traces.ts`
- Modify: `storage/conversations.ts:106-110`（`deleteConversation` 加一行清理）
- Test: `tests/storage/traces.test.ts`

**Interfaces:**
- Consumes: 无（本任务是最底层）
- Produces:
  - 类型 `TurnTrace`、`ConvTraceStore`、`TurnContextSummary`、`TurnLlmRecord`、`TurnToolRecord`、`TurnOutcome`
  - 常量 `MAX_TURNS = 200`
  - `readTraces(convId: string): Promise<ConvTraceStore>`
  - `appendTurnTrace(convId: string, t: TurnTrace): Promise<void>`
  - `clearTraces(convId: string): Promise<void>`

- [ ] **Step 1: 写失败测试**

创建 `tests/storage/traces.test.ts`：

```ts
// tests/storage/traces.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { readTraces, appendTurnTrace, clearTraces, MAX_TURNS, type TurnTrace } from '../../storage/traces';
import { createConversation, deleteConversation } from '../../storage/conversations';

function turn(n: number): TurnTrace {
  return {
    turn: n,
    startedAt: n * 1000,
    endedAt: n * 1000 + 500,
    tabId: 1,
    mode: 'agent',
    context: {
      messageCount: 1, chars: 10, hasSummary: false, summaryChars: 0,
      skillCount: 0, systemPromptChars: 5, pageUrl: 'https://x.com',
    },
    llm: { ms: 400, finishReason: 'stop', textChars: 3, reasoningChars: 0 },
    tools: [],
    outcome: 'done',
  };
}

describe('traces storage', () => {
  beforeEach(() => fakeBrowser.reset());

  it('未知 convId 返回空壳，不抛错', async () => {
    expect(await readTraces('nope')).toEqual({ seq: 0, turns: [] });
  });

  it('appendTurnTrace 追加一轮并推进 seq', async () => {
    await appendTurnTrace('c1', turn(1));
    await appendTurnTrace('c1', turn(2));
    const { seq, turns } = await readTraces('c1');
    expect(seq).toBe(2);
    expect(turns.map((t) => t.turn)).toEqual([1, 2]);
  });

  it('超过 MAX_TURNS 裁掉最旧，seq 不回退', async () => {
    for (let i = 1; i <= MAX_TURNS + 1; i += 1) await appendTurnTrace('c2', turn(i));
    const { seq, turns } = await readTraces('c2');
    expect(seq).toBe(MAX_TURNS + 1);
    expect(turns).toHaveLength(MAX_TURNS);
    expect(turns[0]!.turn).toBe(2);                          // 第 1 轮被裁
    expect(turns[turns.length - 1]!.turn).toBe(MAX_TURNS + 1); // 最新一轮还在
  });

  it('clearTraces 清空该会话的 trace', async () => {
    await appendTurnTrace('c3', turn(1));
    await clearTraces('c3');
    expect(await readTraces('c3')).toEqual({ seq: 0, turns: [] });
  });

  it('deleteConversation 连带清掉该会话的 trace', async () => {
    const c = await createConversation();
    await appendTurnTrace(c.id, turn(1));
    await deleteConversation(c.id);
    expect(await readTraces(c.id)).toEqual({ seq: 0, turns: [] });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/storage/traces.test.ts`
Expected: FAIL —— `Failed to resolve import "../../storage/traces"`

- [ ] **Step 3: 实现 `storage/traces.ts`**

创建 `storage/traces.ts`：

```ts
// storage/traces.ts
// agent loop 轮次 trace 持久化（spec §4）。key = local:conv:{id}:trace。
// 与 messages 分开存：trace 每轮写一次，共用 key 会把写放大到整个消息数组。
import { storage } from 'wxt/utils/storage';
import type { AgentMode } from '../agent/mode';

/** 保留轮数上限，与 conversations 的 MAX_MESSAGES 对齐。 */
export const MAX_TURNS = 200;

/** buildContext 的组装摘要——刻意不存 prompt 全文（无 unlimitedStorage，quota 即 10MB）。 */
export interface TurnContextSummary {
  messageCount: number;
  chars: number;
  hasSummary: boolean;
  summaryChars: number;
  skillCount: number;
  systemPromptChars: number;
  pageUrl: string;
}

export interface TurnLlmRecord {
  ms: number;
  firstTokenMs?: number;
  finishReason: string;
  usage?: { promptTokens?: number; completionTokens?: number };
  textChars: number;
  reasoningChars: number;
  error?: string;
}

export interface TurnToolRecord {
  name: string;
  callId: string;
  argsBytes: number;
  ms: number;
  ok: boolean;
  error?: string;
  summary: string;
}

/** 轮次结束方式。'continue' = 工具跑完、循环回下一轮（最常见的非终态）。 */
export type TurnOutcome = 'continue' | 'done' | 'paused' | 'aborted' | 'error' | 'truncated-retry';

export interface TurnTrace {
  /** 会话内单调递增，从 1 起（seq 记账，环形裁剪后仍连续） */
  turn: number;
  startedAt: number;
  endedAt: number;
  /** 本轮起点的操作目标 tab */
  tabId: number;
  /** 本轮实际生效的模式（每轮重读后的值） */
  mode: AgentMode;
  context: TurnContextSummary;
  llm: TurnLlmRecord;
  /** 本轮开跑前的自动压缩（若触发） */
  compact?: { ms: number; ok: boolean; newPromptTokens?: number };
  tools: TurnToolRecord[];
  outcome: TurnOutcome;
  /** 熔断停止时的原因（checkGuards 的 verdict.reason） */
  guardReason?: string;
}

export interface ConvTraceStore {
  /** 会话内累计轮数，不随环形裁剪回退 */
  seq: number;
  /** 最近 MAX_TURNS 轮，最旧在前 */
  turns: TurnTrace[];
}

const key = (id: string) => `local:conv:${id}:trace` as const;

export async function readTraces(convId: string): Promise<ConvTraceStore> {
  const raw = await storage.getItem<ConvTraceStore>(key(convId));
  return raw ?? { seq: 0, turns: [] };
}

/** 追加一轮 trace：seq 自增、超 MAX_TURNS 裁掉最旧。 */
export async function appendTurnTrace(convId: string, t: TurnTrace): Promise<void> {
  const cur = await readTraces(convId);
  const turns = [...cur.turns, t];
  const trimmed = turns.length > MAX_TURNS ? turns.slice(turns.length - MAX_TURNS) : turns;
  await storage.setItem(key(convId), { seq: cur.seq + 1, turns: trimmed });
}

export async function clearTraces(convId: string): Promise<void> {
  await storage.removeItem(key(convId));
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/storage/traces.test.ts`
Expected: 4 passed，1 failed（`deleteConversation` 那条还没接）

- [ ] **Step 5: 在 `deleteConversation` 里连带清理**

修改 `storage/conversations.ts`。顶部 import 区加：

```ts
import { clearTraces } from './traces';
```

把 `deleteConversation`（约 106-110 行）改成：

```ts
export async function deleteConversation(id: string): Promise<void> {
  await storage.removeItem(key(id));
  await clearTraces(id);
  const index = await readIndex();
  await writeIndex(index.filter((m) => m.id !== id));
}
```

- [ ] **Step 6: 跑测试确认全部通过**

Run: `npx vitest run tests/storage/traces.test.ts tests/storage/conversations.test.ts`
Expected: 全部 PASS

- [ ] **Step 7: 提交**

```bash
git add storage/traces.ts storage/conversations.ts tests/storage/traces.test.ts
git commit -m "feat(trace): trace 持久化层，每会话环形保留最近 200 轮"
```

---

### Task 2: 上下文组装摘要（纯函数）

**Files:**
- Create: `agent/trace.ts`（本任务只放 `measureMessages` 与 `summarizeContext`，采集器在 Task 3 追加）
- Test: `tests/agent/trace.test.ts`

**Interfaces:**
- Consumes: `TurnContextSummary`（Task 1）、`ChatMessage` / `ContentPart`（`agent/provider/types.ts`）、`SkillBrief`（`agent/context.ts:32`）
- Produces:
  - `measureMessages(messages: ChatMessage[]): number`
  - `summarizeContext(messages: ChatMessage[], opts: { summary?: { text: string; coversUpTo: number }; skills?: SkillBrief[]; pageUrl: string }): TurnContextSummary`

- [ ] **Step 1: 写失败测试**

创建 `tests/agent/trace.test.ts`：

```ts
// tests/agent/trace.test.ts
import { describe, it, expect } from 'vitest';
import { measureMessages, summarizeContext } from '../../agent/trace';
import type { ChatMessage } from '../../agent/provider/types';

describe('measureMessages', () => {
  it('累加字符串 content 的长度', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: '12345' },
      { role: 'user', content: '123' },
    ];
    expect(measureMessages(msgs)).toBe(8);
  });

  it('数组 content 里图片 part 按 data URL 长度计入', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'ab' }, { type: 'image_url', imageUrl: 'data:image/png;base64,XXXX' }] },
    ];
    expect(measureMessages(msgs)).toBe(2 + 'data:image/png;base64,XXXX'.length);
  });

  it('toolCalls 与 reasoning 计入', () => {
    const msgs: ChatMessage[] = [
      { role: 'assistant', content: 'x', reasoning: 'yy', toolCalls: [{ id: 'a', name: 'click', arguments: '{}' }] },
    ];
    const expected = 1 + 2 + JSON.stringify([{ id: 'a', name: 'click', arguments: '{}' }]).length;
    expect(measureMessages(msgs)).toBe(expected);
  });
});

describe('summarizeContext', () => {
  it('system 消息长度取 messages[0]（即真正发出去的那份）', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: '1234567890' },
      { role: 'user', content: 'hi' },
    ];
    const s = summarizeContext(msgs, { pageUrl: 'https://x.com' });
    expect(s.messageCount).toBe(2);
    expect(s.systemPromptChars).toBe(10);
    expect(s.pageUrl).toBe('https://x.com');
    expect(s.hasSummary).toBe(false);
    expect(s.summaryChars).toBe(0);
    expect(s.skillCount).toBe(0);
  });

  it('带摘要与技能时反映在字段里', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '【前情摘要】\nabc' },
    ];
    const s = summarizeContext(msgs, {
      summary: { text: 'abc', coversUpTo: 3 },
      skills: [{ name: 'A', command: 'a', description: '' }],
      pageUrl: '',
    });
    expect(s.hasSummary).toBe(true);
    expect(s.summaryChars).toBe(3);
    expect(s.skillCount).toBe(1);
  });

  it('首条不是 system 时 systemPromptChars 为 0', () => {
    const msgs: ChatMessage[] = [{ role: 'user', content: 'hi' }];
    expect(summarizeContext(msgs, { pageUrl: '' }).systemPromptChars).toBe(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/agent/trace.test.ts`
Expected: FAIL —— `Failed to resolve import "../../agent/trace"`

- [ ] **Step 3: 实现纯函数**

创建 `agent/trace.ts`：

```ts
// agent/trace.ts
// loop 轮次 trace 采集（spec §5）。本模块是 storage 与 loop 之间的唯一接缝：
// loop 只调语义方法（markLlm/markTool/...），storage 细节封在这里。
import type { ChatMessage } from './provider/types';
import type { SkillBrief } from './context';
import type { TurnContextSummary } from '../storage/traces';

/** 统计消息数组的字符体积（content + toolCalls + reasoning）。 */
export function measureMessages(messages: ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') {
      chars += m.content.length;
    } else {
      for (const p of m.content) {
        chars += p.type === 'text' ? p.text.length : p.imageUrl.length;
      }
    }
    if (m.reasoning) chars += m.reasoning.length;
    if (m.toolCalls) chars += JSON.stringify(m.toolCalls).length;
  }
  return chars;
}

/** buildContext 输出的组装摘要。system 长度取 messages[0]——那是真正发出去的正文，
 *  比 getSystemPrompt() 的返回值更诚实（后者缺省时用的是内置提示词）。 */
export function summarizeContext(
  messages: ChatMessage[],
  opts: { summary?: { text: string; coversUpTo: number }; skills?: SkillBrief[]; pageUrl: string },
): TurnContextSummary {
  const head = messages[0];
  const systemChars = head && head.role === 'system' && typeof head.content === 'string'
    ? head.content.length
    : 0;
  return {
    messageCount: messages.length,
    chars: measureMessages(messages),
    hasSummary: opts.summary != null,
    summaryChars: opts.summary?.text.length ?? 0,
    skillCount: opts.skills?.length ?? 0,
    systemPromptChars: systemChars,
    pageUrl: opts.pageUrl,
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/agent/trace.test.ts`
Expected: 6 passed

- [ ] **Step 5: 提交**

```bash
git add agent/trace.ts tests/agent/trace.test.ts
git commit -m "feat(trace): 上下文组装摘要纯函数，不存 prompt 全文"
```

---

### Task 3: 轮次采集器 `createTurnRecorder`

**Files:**
- Modify: `agent/trace.ts`（追加采集器，保留 Task 2 的函数）
- Test: `tests/agent/trace.test.ts`（追加 describe 块）

**Interfaces:**
- Consumes: Task 1 的 `appendTurnTrace`、`TurnTrace`、`TurnToolRecord`、`TurnOutcome`；Task 2 的 `summarizeContext`；`TurnResult`（`agent/run-turn.ts:6`）
- Produces:
  - `createTurnRecorder(init: { convId: string; turn: number; tabId: number }): TurnRecorder`
  - `TurnRecorder` 形状：`{ rec: TurnTrace; setMode(mode: AgentMode): void; markContext(messages, opts): void; markLlm(args: { startedAt: number; firstTokenAt?: number; result: TurnResult }): void; markTool(t: TurnToolRecord): void; markCompact(c: { ms: number; ok: boolean; newPromptTokens?: number }): void; commit(): Promise<void> }`

- [ ] **Step 1: 写失败测试**

在 `tests/agent/trace.test.ts` 末尾追加：

```ts
import { createTurnRecorder } from '../../agent/trace';
import { readTraces } from '../../storage/traces';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { beforeEach, vi } from 'vitest';
import type { TurnResult } from '../../agent/run-turn';

const llmResult = (over?: Partial<TurnResult>): TurnResult => ({
  text: '好的',
  toolCalls: [],
  finishReason: 'stop',
  usage: { promptTokens: 100, completionTokens: 20 },
  ...over,
});

describe('createTurnRecorder', () => {
  beforeEach(() => fakeBrowser.reset());

  it('commit 补 endedAt 并把整轮写进 storage', async () => {
    const tr = createTurnRecorder({ convId: 'r1', turn: 1, tabId: 3 });
    tr.setMode('ask');
    tr.markLlm({ startedAt: Date.now() - 50, result: llmResult() });
    await tr.commit();
    const { seq, turns } = await readTraces('r1');
    expect(seq).toBe(1);
    expect(turns[0]!.tabId).toBe(3);
    expect(turns[0]!.mode).toBe('ask');
    expect(turns[0]!.llm.finishReason).toBe('stop');
    expect(turns[0]!.llm.usage).toEqual({ promptTokens: 100, completionTokens: 20 });
    expect(turns[0]!.llm.textChars).toBe(2);
    expect(turns[0]!.endedAt).toBeGreaterThanOrEqual(turns[0]!.startedAt);
  });

  it('未赋值时 outcome 默认 error（漏设是 bug，不做静默伪装）', async () => {
    const tr = createTurnRecorder({ convId: 'r2', turn: 1, tabId: 1 });
    await tr.commit();
    expect((await readTraces('r2')).turns[0]!.outcome).toBe('error');
  });

  it('firstTokenAt 换算成 firstTokenMs；缺省则字段不存在', async () => {
    const startedAt = 1000;
    const a = createTurnRecorder({ convId: 'r3', turn: 1, tabId: 1 });
    a.markLlm({ startedAt, firstTokenAt: 1240, result: llmResult() });
    await a.commit();

    const b = createTurnRecorder({ convId: 'r4', turn: 1, tabId: 1 });
    b.markLlm({ startedAt, result: llmResult() });
    await b.commit();

    const [ta] = (await readTraces('r3')).turns;
    const [tb] = (await readTraces('r4')).turns;
    expect(ta!.llm.firstTokenMs).toBe(240);
    expect(tb!.llm.firstTokenMs).toBeUndefined();
  });

  it('markContext 走 summarizeContext', async () => {
    const tr = createTurnRecorder({ convId: 'r5', turn: 1, tabId: 1 });
    tr.markContext([{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }], { pageUrl: 'https://a.com' });
    await tr.commit();
    const c = (await readTraces('r5')).turns[0]!.context;
    expect(c.messageCount).toBe(2);
    expect(c.systemPromptChars).toBe(3);
    expect(c.pageUrl).toBe('https://a.com');
  });

  it('markTool 按调用顺序累计，markCompact 记下压缩', async () => {
    const tr = createTurnRecorder({ convId: 'r6', turn: 1, tabId: 1 });
    tr.markTool({ name: 'click', callId: 'c1', argsBytes: 9, ms: 12, ok: true, summary: '成功' });
    tr.markTool({ name: 'scroll', callId: 'c2', argsBytes: 20, ms: 30, ok: false, error: '炸了', summary: '炸了' });
    tr.markCompact({ ms: 800, ok: true, newPromptTokens: 340 });
    await tr.commit();
    const t = (await readTraces('r6')).turns[0]!;
    expect(t.tools.map((x) => x.callId)).toEqual(['c1', 'c2']);
    expect(t.tools[1]!.error).toBe('炸了');
    expect(t.compact).toEqual({ ms: 800, ok: true, newPromptTokens: 340 });
  });

  it('storage 写失败被吞掉，不阻断 loop', async () => {
    const spy = vi.spyOn(browser.storage.local, 'set').mockRejectedValue(new Error('QUOTA_BYTES exceeded'));
    const tr = createTurnRecorder({ convId: 'r7', turn: 1, tabId: 1 });
    await expect(tr.commit()).resolves.toBeUndefined();
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/agent/trace.test.ts`
Expected: FAIL —— `createTurnRecorder is not a function`

- [ ] **Step 3: 实现采集器**

在 `agent/trace.ts` 末尾追加（同时把顶部 import 补齐）：

```ts
import type { TurnResult } from './run-turn';
import type { AgentMode } from './mode';
import type { TurnToolRecord, TurnTrace } from '../storage/traces';
import { appendTurnTrace } from '../storage/traces';
```

```ts
export interface TurnRecorder {
  /** 可变轮次记录：loop 直接写 rec.outcome / rec.guardReason。 */
  rec: TurnTrace;
  /** 模式在轮体中部才重读出来，晚于 recorder 创建。 */
  setMode(mode: AgentMode): void;
  markContext(
    messages: ChatMessage[],
    opts: { summary?: { text: string; coversUpTo: number }; skills?: SkillBrief[]; pageUrl: string },
  ): void;
  markLlm(args: { startedAt: number; firstTokenAt?: number; result: TurnResult }): void;
  markTool(t: TurnToolRecord): void;
  markCompact(c: { ms: number; ok: boolean; newPromptTokens?: number }): void;
  commit(): Promise<void>;
}

export function createTurnRecorder(init: { convId: string; turn: number; tabId: number }): TurnRecorder {
  const now = Date.now();
  const rec: TurnTrace = {
    turn: init.turn,
    startedAt: now,
    endedAt: now,
    tabId: init.tabId,
    mode: 'agent',
    context: {
      messageCount: 0, chars: 0, hasSummary: false, summaryChars: 0,
      skillCount: 0, systemPromptChars: 0, pageUrl: '',
    },
    llm: { ms: 0, finishReason: '', textChars: 0, reasoningChars: 0 },
    tools: [],
    // 默认 'error' 是绊线：loop 的 9 处出口都必须显式赋值，漏设即暴露为错误而非伪装成 done
    outcome: 'error',
  };

  return {
    rec,
    setMode(mode) { rec.mode = mode; },
    markContext(messages, opts) { rec.context = summarizeContext(messages, opts); },
    markLlm({ startedAt, firstTokenAt, result }) {
      rec.llm = {
        ms: Date.now() - startedAt,
        ...(firstTokenAt != null ? { firstTokenMs: firstTokenAt - startedAt } : {}),
        finishReason: result.finishReason ?? '',
        ...(result.usage ? { usage: result.usage } : {}),
        textChars: result.text.length,
        reasoningChars: result.reasoning?.length ?? 0,
        ...(result.error ? { error: result.error } : {}),
      };
    },
    markTool(t) { rec.tools.push(t); },
    markCompact(c) { rec.compact = c; },
    async commit() {
      rec.endedAt = Date.now();
      // 调试设施不该有能力搞挂主流程：quota 打满就丢这一轮 trace
      await appendTurnTrace(init.convId, rec).catch(() => {});
    },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/agent/trace.test.ts`
Expected: 12 passed

- [ ] **Step 5: 提交**

```bash
git add agent/trace.ts tests/agent/trace.test.ts
git commit -m "feat(trace): 轮次采集器，commit 吞掉写失败不阻断 loop"
```

---

### Task 4: `drive()` 接线

**Files:**
- Modify: `agent/loop.ts`（`drive()` 整个函数体重写，其余函数不动）
- Test: `tests/agent/loop-trace.test.ts`

**Interfaces:**
- Consumes: `readTraces`（Task 1）、`createTurnRecorder`（Task 3）
- Produces: 无新导出——`runAgentLoop` / `resumeAgentLoop` 签名不变，副作用是每轮落一条 trace

这是全案最容易漏改的任务：`drive()` 有 **9 处出口**必须各自显式赋值 `outcome`。默认值是 `'error'` 当绊线，漏一处测试就会红。

- [ ] **Step 1: 写失败测试（自然终止 + 工具轮）**

创建 `tests/agent/loop-trace.test.ts`：

```ts
// tests/agent/loop-trace.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { runAgentLoop, type LoopDeps } from '../../agent/loop';
import { readTraces } from '../../storage/traces';
import type { Provider, StreamEvent, ChatParams } from '../../agent/provider/types';
import type { ToolResult } from '../../shared/types';

function queuedProvider(scripts: StreamEvent[][]): Provider {
  let i = 0;
  return {
    streamChat(_p: ChatParams, onEvent: (e: StreamEvent) => void) {
      const script = scripts[i++] ?? [{ type: 'message-done', finishReason: 'stop' }];
      queueMicrotask(() => { for (const e of script) onEvent(e); });
      return { cancel: vi.fn() };
    },
  };
}

const deps = (provider: Provider, exec: LoopDeps['executeTool'], extra?: Partial<LoopDeps>): LoopDeps => ({
  provider,
  executeTool: exec,
  getPageInfo: async () => ({ url: 'https://x.com', title: 'X' }),
  emit: vi.fn(),
  ...extra,
});

describe('agent loop trace', () => {
  beforeEach(() => fakeBrowser.reset());

  it('自然终止的一轮落一条 trace，outcome=done', async () => {
    const provider = queuedProvider([[
      { type: 'text-delta', text: '完成了' },
      { type: 'message-done', finishReason: 'stop' },
    ]]);
    const exec = vi.fn<LoopDeps['executeTool']>();
    await runAgentLoop({ convId: 't1', tabId: 7, userMessage: '你好' }, deps(provider, exec));

    const { seq, turns } = await readTraces('t1');
    expect(seq).toBe(1);
    expect(turns).toHaveLength(1);
    const t = turns[0]!;
    expect(t.turn).toBe(1);
    expect(t.outcome).toBe('done');
    expect(t.tabId).toBe(7);
    expect(t.mode).toBe('agent');
    expect(t.llm.finishReason).toBe('stop');
    expect(t.llm.textChars).toBe(3);
    expect(t.llm.ms).toBeGreaterThanOrEqual(0);
    expect(t.context.pageUrl).toBe('https://x.com');
    expect(t.context.systemPromptChars).toBeGreaterThan(0);
    expect(t.tools).toEqual([]);
    expect(t.endedAt).toBeGreaterThanOrEqual(t.startedAt);
  });

  it('工具轮 outcome=continue，工具记录与 callId 对齐，下一轮是新 recorder', async () => {
    const provider = queuedProvider([
      [
        { type: 'tool-call-delta', index: 0, id: 'call_a', name: 'click', argsDelta: '{"uid":1}' },
        { type: 'message-done', finishReason: 'tool_calls' },
      ],
      [{ type: 'text-delta', text: '好了' }, { type: 'message-done', finishReason: 'stop' }],
    ]);
    const exec = vi.fn<LoopDeps['executeTool']>().mockResolvedValue({ ok: true, data: { clicked: true } } as ToolResult);
    await runAgentLoop({ convId: 't2', tabId: 1, userMessage: '点一下' }, deps(provider, exec));

    const { seq, turns } = await readTraces('t2');
    expect(seq).toBe(2);
    expect(turns).toHaveLength(2);

    const first = turns[0]!;
    expect(first.outcome).toBe('continue');
    expect(first.tools).toHaveLength(1);
    expect(first.tools[0]!.name).toBe('click');
    expect(first.tools[0]!.callId).toBe('call_a');
    expect(first.tools[0]!.argsBytes).toBe('{"uid":1}'.length);
    expect(first.tools[0]!.ok).toBe(true);
    expect(first.tools[0]!.summary).toBe('成功');
    expect(first.tools[0]!.ms).toBeGreaterThanOrEqual(0);

    expect(turns[1]!.turn).toBe(2);
    expect(turns[1]!.outcome).toBe('done');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/agent/loop-trace.test.ts`
Expected: FAIL —— `readTraces('t1')` 返回 `{ seq: 0, turns: [] }`，`seq` 断言失败

- [ ] **Step 3: 重写 `drive()`**

修改 `agent/loop.ts`。顶部 import 区加：

```ts
import { readTraces } from '../storage/traces';
import { createTurnRecorder } from './trace';
```

把 `drive()`（66-259 行）整体替换为下面这版。**逐字照抄**——9 处 `outcome` 赋值点、3 处 `markTool`、以及 `firstTokenAt` 的采集都在里面：

```ts
async function drive(
  convId: string,
  startTabId: number,
  deps: LoopDeps,
  guardState: GuardState,
  signal: AbortSignal,
): Promise<void> {
  let guard = guardState;
  let targetTab = startTabId;
  let lastPromptTokens: number | undefined;

  for (;;) {
    // 轮次序号从 storage 读（而非 loop 内自增）：SW 被杀重启后计数不重置
    const { seq } = await readTraces(convId);
    const tr = createTurnRecorder({ convId, turn: seq + 1, tabId: targetTab });
    // try/finally 是刻意的：轮体内有 1 处 continue（截断重试）+ 8 处 return，
    // finally 在 continue 前同样执行，一处收口覆盖全部 9 处出口。
    try {
      if (signal.aborted) {
        tr.rec.outcome = 'aborted';
        return void (await finishAborted(convId, deps));
      }

      // 自动压缩：上一轮 usage 达阈值 → 进下一轮前先摘要一次（不打断已完成的工具链）
      if (deps.compact && deps.getContextWindow && lastPromptTokens != null) {
        const windowSize = await deps.getContextWindow();
        if (meterRatio(lastPromptTokens, windowSize) >= COMPACT_THRESHOLD) {
          deps.emit({ type: 'compact-start' });
          const compactAt = Date.now();
          const r = await deps.compact(convId).catch(() => ({ ok: false as const }));
          tr.markCompact({
            ms: Date.now() - compactAt,
            ok: r.ok,
            ...(r.ok && r.newPromptTokens != null ? { newPromptTokens: r.newPromptTokens } : {}),
          });
          if (r.ok && r.newPromptTokens != null) {
            lastPromptTokens = r.newPromptTokens;
            await setLastPromptTokens(convId, r.newPromptTokens);
            deps.emit({ type: 'usage', promptTokens: r.newPromptTokens });
          } else {
            // 压缩无法再缩减（无新内容可摘）：清空 lastPromptTokens，避免每轮反复空触发
            // compact-start/done（UI 闪烁 + 浪费调用）；等下一轮 runTurn 的真实 usage 再判定。
            lastPromptTokens = undefined;
          }
          deps.emit({ type: 'compact-done', newPromptTokens: r.ok ? r.newPromptTokens : undefined });
        }
      }
      // 压缩期间用户可能已中断：进 runTurn 前再检查一次，避免浪费一次 API 调用
      if (signal.aborted) {
        tr.rec.outcome = 'aborted';
        return void (await finishAborted(convId, deps));
      }

      const conv = await getConversation(convId);
      const page = await deps.getPageInfo(targetTab).catch(() => ({ url: '', title: '' }));
      const skills = (await deps.getSkills?.()) ?? [];
      // 模式每轮重读：任务中途用户切 ask/agent，下一轮立即生效（已发出的轮次不回收）
      const mode = (await deps.getMode?.()) ?? 'agent';
      const systemPrompt = await deps.getSystemPrompt?.();
      const memory = await deps.getMemoryState?.();
      const messages = buildContext(conv.messages, page, { summary: conv.summary, skills, mode, systemPrompt, memory });
      const memoryCap = memory ? memoryStateToCap(memory) : 'full';
      tr.setMode(mode);
      tr.markContext(messages, { summary: conv.summary, skills, pageUrl: page.url });

      const maxTokens = (await deps.getMaxTokens?.()) ?? 0;
      // 参数生成进度节流器：每轮新建，状态不跨轮（下一轮从 0 重新计）
      const onArgs = makeArgsThrottle((name, bytes) => deps.emit({ type: 'tool-args-delta', name, bytes }));
      // TTFT：三个流式 hook 里首次回调即算首 token（工具参数先于正文到达是常态，必须计入）
      const llmAt = Date.now();
      let firstTokenAt: number | undefined;
      const markFirst = () => { if (firstTokenAt == null) firstTokenAt = Date.now(); };
      const result = await runTurn(deps.provider, {
        messages, tools: getToolSchemas(mode, memoryCap), signal,
        ...(maxTokens > 0 ? { maxTokens } : {}),
      }, {
        onTextDelta: (t) => { markFirst(); deps.emit({ type: 'text-delta', text: t }); },
        onReasoningDelta: (t) => { markFirst(); deps.emit({ type: 'reasoning-delta', text: t }); },
        onToolArgsDelta: (name, bytes) => { markFirst(); onArgs(name, bytes); },
      });
      tr.markLlm({ startedAt: llmAt, firstTokenAt, result });

      if (signal.aborted) {
        tr.rec.outcome = 'aborted';
        if (result.text || result.reasoning) {
          await appendMessage(convId, { role: 'assistant', content: result.text, reasoning: result.reasoning });
        }
        await finishAborted(convId, deps);
        return;
      }

      // usage 计量：无论 finishReason 都消费（供上下文标识 + 下一轮自动压缩判定）
      if (result.usage?.promptTokens != null) {
        lastPromptTokens = result.usage.promptTokens;
        await setLastPromptTokens(convId, result.usage.promptTokens);
        deps.emit({ type: 'usage', promptTokens: result.usage.promptTokens, completionTokens: result.usage.completionTokens });
      }

      if (result.error) {
        tr.rec.outcome = 'error';
        deps.emit({ type: 'error', message: result.error });
        await setStatus(convId, 'idle');
        return;
      }

      if (result.finishReason === 'length' && result.toolCalls.length > 0) {
        tr.rec.outcome = 'truncated-retry';
        await appendMessage(convId, assistantMsg(result.text, result.toolCalls, result.reasoning));
        const truncFailed: ToolResult[] = [];
        for (const tc of result.toolCalls) {
          await appendMessage(convId, { role: 'tool', toolCallId: tc.id, name: tc.name, content: '错误：模型输出被截断，该工具调用参数不完整。若在写长脚本，请改用分步方式：'
            + '先 create_script 只提交元数据头 + 未闭合的 IIFE 骨架（如 `(function () {` 结尾，不写 `})();`），'
            + '再用 update_script 的 patch.append 分次追加代码体，最后一段带上 `})();` 闭合。' });
          truncFailed.push({ ok: false, error: '模型输出被截断' });
        }
        guard = recordTurn(guard, result.toolCalls, truncFailed);
        const verdict = checkGuards(guard, DEFAULT_GUARD_CONFIG);
        if (verdict.stop) {
          tr.rec.outcome = 'paused';
          tr.rec.guardReason = verdict.reason ?? '';
          await setStatus(convId, 'paused');
          deps.emit({ type: 'paused', reason: verdict.reason ?? '' });
          return;
        }
        continue;
      }

      if (result.toolCalls.length === 0) {
        const truncated = result.finishReason === 'length';
        const finalText = truncated
          ? `${result.text}\n\n[注意：回复因达到长度上限被截断，可能不完整]`
          : result.text;
        tr.rec.outcome = 'done';
        await appendMessage(convId, { role: 'assistant', content: finalText, reasoning: result.reasoning });
        deps.emit({ type: 'done', finalText });
        await setStatus(convId, 'idle');
        return;
      }

      await appendMessage(convId, assistantMsg(result.text, result.toolCalls, result.reasoning));
      const results: ToolResult[] = [];
      for (const tc of result.toolCalls) {
        if (signal.aborted) {
          tr.rec.outcome = 'aborted';
          await finishAborted(convId, deps);
          return;
        }
        let toolArgs: Record<string, unknown> = {};
        try { toolArgs = tc.arguments ? JSON.parse(tc.arguments) : {}; } catch { /* 保持空对象 */ }
        deps.emit({ type: 'tool-start', name: tc.name, args: tc.arguments, callId: tc.id });
        const toolAt = Date.now();
        const argsBytes = tc.arguments?.length ?? 0;
        const r = await deps.executeTool(tc.name, toolArgs, targetTab, signal);
        results.push(r);

        if (r.ok && (tc.name === 'new_page' || tc.name === 'select_page')) {
          const d = r.data as { targetTab?: number } | undefined;
          if (typeof d?.targetTab === 'number') targetTab = d.targetTab;
        }
        if (r.ok && tc.name === 'close_page') {
          const d = r.data as { closed?: number } | undefined;
          if (d?.closed === targetTab) targetTab = startTabId;
        }
        if (r.ok && deps.resolveOpenedTab && TAB_OPENING_TOOLS.has(tc.name)) {
          const opened = await deps.resolveOpenedTab(tc.name, targetTab, signal);
          if (typeof opened === 'number') targetTab = opened;
        }

        if (tc.name === 'load_skill' && r.ok) {
          // 工具卡摘要显示「已加载「技能名」」；tool 消息 content = 正文，喂给模型遵循执行。
          const d = r.data as { name?: string; command?: string; content?: string } | undefined;
          const summary = d?.name ? `已加载「${d.name}」` : '已加载技能';
          const output = `【技能指令 /${d?.command ?? ''}】\n${d?.content ?? ''}`;
          deps.emit({ type: 'tool-end', name: tc.name, callId: tc.id, ok: true, summary, output });
          tr.markTool({ name: tc.name, callId: tc.id, argsBytes, ms: Date.now() - toolAt, ok: true, summary });
          await appendMessage(convId, { role: 'tool', toolCallId: tc.id, name: tc.name, content: output });
          continue;
        }

        // take_screenshot 产截图：tool 消息只留一句话，base64 走独立 user 图片消息
        //（进视觉通道 + 受 trimImageParts 管理）——若让它留在 toToolContent 的 JSON 里，
        // 会成为数万 token 的纯文本废料且永不回收。
        if (tc.name === 'take_screenshot') {
          const data = (r as { data?: { screenshot?: string } | undefined }).data;
          const shot = data?.screenshot;
          const summary = r.ok ? '已截图' : (r.error ?? '失败');
          deps.emit({ type: 'tool-end', name: tc.name, callId: tc.id, ok: r.ok, summary, image: shot });
          tr.markTool({
            name: tc.name, callId: tc.id, argsBytes, ms: Date.now() - toolAt, ok: r.ok,
            ...(r.ok ? {} : { error: r.error }), summary,
          });
          const rest = toToolContent(r.ok ? { ok: true } : r);
          await appendMessage(convId, { role: 'tool', toolCallId: tc.id, name: tc.name, content: rest });
          if (shot) {
            const parts: ContentPart[] = [
              { type: 'text', text: SCREENSHOT_SENTINEL },
              { type: 'image_url', imageUrl: shot },
            ];
            await appendMessage(convId, { role: 'user', content: parts });
          }
          continue;
        }

        const summary = r.ok ? '成功' : (r.error ?? '失败');
        // data 里若混入 screenshot（防御性：任何工具都不得让 base64 进文本上下文），
        // 摘掉后单独走 user 图片消息；其余字段照常序列化进 tool 消息。
        const shot = (r as { data?: { screenshot?: string } | undefined }).data?.screenshot;
        let output: string;
        if (shot != null) {
          const data = (r as { data?: Record<string, unknown> | undefined }).data;
          const { screenshot: _s, ...keep } = data ?? {};
          output = r.ok
            ? toToolContent({ ok: true, data: keep })
            : `错误：${r.error ?? '未知错误'}\n${JSON.stringify(keep)}`;
        } else {
          output = toToolContent(r);
        }
        deps.emit({ type: 'tool-end', name: tc.name, callId: tc.id, ok: r.ok, summary, image: shot, output });
        tr.markTool({
          name: tc.name, callId: tc.id, argsBytes, ms: Date.now() - toolAt, ok: r.ok,
          ...(r.ok ? {} : { error: r.error }), summary,
        });
        await appendMessage(convId, { role: 'tool', toolCallId: tc.id, name: tc.name, content: output });
        if (shot) {
          const parts: ContentPart[] = [
            { type: 'text', text: SCREENSHOT_SENTINEL },
            { type: 'image_url', imageUrl: shot },
          ];
          await appendMessage(convId, { role: 'user', content: parts });
        }
      }

      guard = recordTurn(guard, result.toolCalls, results);
      const verdict = checkGuards(guard, DEFAULT_GUARD_CONFIG);
      if (verdict.stop) {
        tr.rec.outcome = 'paused';
        tr.rec.guardReason = verdict.reason ?? '';
        await setStatus(convId, 'paused');
        deps.emit({ type: 'paused', reason: verdict.reason ?? '' });
        return;
      }

      // 轮体末尾自然落下 = 工具跑完、循环回下一轮（最常见的非终态）
      tr.rec.outcome = 'continue';
    } finally {
      await tr.commit();
    }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/agent/loop-trace.test.ts`
Expected: 2 passed

- [ ] **Step 5: 跑既有 loop 测试确认没回归**

Run: `npx vitest run tests/agent/`
Expected: 全部 PASS（尤其 `loop.test.ts` 的熔断与 abort 用例）

- [ ] **Step 6: 补齐出口测试**

在 `tests/agent/loop-trace.test.ts` 的 describe 内追加：

```ts
  it('轮首 abort → outcome=aborted', async () => {
    const provider = queuedProvider([[]]);
    const ac = new AbortController();
    ac.abort();
    await runAgentLoop({ convId: 't3', tabId: 1, userMessage: 'x' }, deps(provider, vi.fn()), ac.signal);
    const { turns } = await readTraces('t3');
    expect(turns).toHaveLength(1);
    expect(turns[0]!.outcome).toBe('aborted');
  });

  it('工具失败记 error 字段，summary 为错误文本', async () => {
    const provider = queuedProvider([
      [
        { type: 'tool-call-delta', index: 0, id: 'call_f', name: 'click', argsDelta: '{}' },
        { type: 'message-done', finishReason: 'tool_calls' },
      ],
      [{ type: 'text-delta', text: '算了' }, { type: 'message-done', finishReason: 'stop' }],
    ]);
    const exec = vi.fn<LoopDeps['executeTool']>().mockResolvedValue({ ok: false, error: '元素不存在' } as ToolResult);
    await runAgentLoop({ convId: 't4', tabId: 1, userMessage: 'x' }, deps(provider, exec));
    const t = (await readTraces('t4')).turns[0]!;
    expect(t.tools[0]!.ok).toBe(false);
    expect(t.tools[0]!.error).toBe('元素不存在');
    expect(t.tools[0]!.summary).toBe('元素不存在');
  });

  it('打转熔断 → 该轮 outcome=paused 且带 guardReason', async () => {
    const turn = (): StreamEvent[] => [
      { type: 'tool-call-delta', index: 0, id: `c${Math.random()}`, name: 'scroll', argsDelta: '{"direction":"down"}' },
      { type: 'message-done', finishReason: 'tool_calls' },
    ];
    const provider = queuedProvider([turn(), turn(), turn(), turn(), turn()]);
    const exec = vi.fn<LoopDeps['executeTool']>().mockResolvedValue({ ok: true } as ToolResult);
    await runAgentLoop({ convId: 't5', tabId: 1, userMessage: 'x' }, deps(provider, exec));

    const { turns } = await readTraces('t5');
    expect(turns).toHaveLength(3);              // repeatThreshold=3
    expect(turns[0]!.outcome).toBe('continue');
    expect(turns[2]!.outcome).toBe('paused');
    expect(turns[2]!.guardReason).toContain('重复调用同一工具');
  });

  it('截断重试 → 前几轮 truncated-retry，熔断那轮 paused', async () => {
    // argsDelta 每轮必须不同：signature() 只取 name+arguments，若各轮相同会先撞「打转」
    // 熔断（repeatThreshold=3 且优先判定），到不了第 5 轮的「连续失败」。
    const turn = (): StreamEvent[] => [
      { type: 'tool-call-delta', index: 0, id: `c${Math.random()}`, name: 'click', argsDelta: `{"uid":${Math.random()}}` },
      { type: 'message-done', finishReason: 'length' },
    ];
    const provider = queuedProvider(Array.from({ length: 20 }, () => turn()));
    const exec = vi.fn<LoopDeps['executeTool']>();
    await runAgentLoop({ convId: 't6', tabId: 1, userMessage: 'x' }, deps(provider, exec));

    const { turns } = await readTraces('t6');
    expect(turns).toHaveLength(5);              // errorThreshold=5
    expect(turns.slice(0, 4).map((t) => t.outcome)).toEqual([
      'truncated-retry', 'truncated-retry', 'truncated-retry', 'truncated-retry',
    ]);
    expect(turns[4]!.outcome).toBe('paused');
    expect(turns[4]!.guardReason).toContain('全部失败');
    expect(exec).not.toHaveBeenCalled();
  });

  it('usage 落进 llm.usage', async () => {
    const provider: Provider = {
      streamChat(_p, onEvent) {
        queueMicrotask(() => {
          onEvent({ type: 'text-delta', text: 'ok' });
          onEvent({ type: 'message-done', finishReason: 'stop', usage: { promptTokens: 1234, completionTokens: 56 } });
        });
        return { cancel: vi.fn() };
      },
    };
    await runAgentLoop({ convId: 't7', tabId: 1, userMessage: 'x' }, deps(provider, vi.fn()));
    const t = (await readTraces('t7')).turns[0]!;
    expect(t.llm.usage).toEqual({ promptTokens: 1234, completionTokens: 56 });
  });

  it('触发自动压缩 → compact 字段有记录', async () => {
    // 第 1 轮必须带工具调用，否则 loop 在第 1 轮就 done 返回，走不到第 2 轮开头的压缩判定
    const provider = queuedProvider([
      [
        { type: 'tool-call-delta', index: 0, id: 'c1', name: 'click', argsDelta: '{}' },
        { type: 'message-done', finishReason: 'tool_calls', usage: { promptTokens: 9000, completionTokens: 10 } },
      ],
      [{ type: 'text-delta', text: 'b' }, { type: 'message-done', finishReason: 'stop' }],
    ]);
    const compact = vi.fn().mockResolvedValue({ ok: true, newPromptTokens: 400 });
    const exec = vi.fn<LoopDeps['executeTool']>().mockResolvedValue({ ok: true } as ToolResult);
    // 第 2 轮开头：promptTokens=9000 / window=10000 → 0.9 ≥ COMPACT_THRESHOLD(0.8) 触发
    await runAgentLoop({ convId: 't8', tabId: 1, userMessage: 'x' },
      deps(provider, exec, { getContextWindow: async () => 10000, compact }));

    expect(compact).toHaveBeenCalledTimes(1);
    const { turns } = await readTraces('t8');
    expect(turns[0]!.compact).toBeUndefined();
    expect(turns[1]!.compact).toEqual({ ms: expect.any(Number), ok: true, newPromptTokens: 400 });
  });
```

- [ ] **Step 7: 跑测试确认通过**

Run: `npx vitest run tests/agent/loop-trace.test.ts`
Expected: 8 passed

- [ ] **Step 8: 类型检查 + 全量测试**

Run: `npm run compile && npm run test`
Expected: 均无错

- [ ] **Step 9: 提交**

```bash
git add agent/loop.ts tests/agent/loop-trace.test.ts
git commit -m "feat(trace): drive 每轮落一条 trace，try/finally 收口 9 处出口"
```

---

### Task 5: 视图投影纯函数

**Files:**
- Create: `components/convdebug/convdebug-utils.ts`
- Test: `tests/convdebug/utils.test.ts`

**Interfaces:**
- Consumes: `ConvTraceStore` / `TurnOutcome`（Task 1）、`ChatMessage` / `ContentPart`（`agent/provider/types.ts`）、`Conversation`（`storage/conversations.ts`）
- Produces:
  - `isTrimmed(store: ConvTraceStore): boolean`
  - `firstKeptTurn(store: ConvTraceStore): number`
  - `isMissingConversation(conv: Conversation): boolean`
  - `formatMs(ms: number): string`
  - `compactNumber(n: number): string`
  - `formatTokens(promptTokens?: number, completionTokens?: number): string`
  - `formatChars(n: number): string`
  - `formatRelativeTime(ts: number, now?: number): string`
  - `outcomeClass(o: TurnOutcome): string`
  - 类型 `MessageRow`、`toMessageRows(messages: ChatMessage[]): MessageRow[]`

- [ ] **Step 1: 写失败测试**

创建 `tests/convdebug/utils.test.ts`：

```ts
// tests/convdebug/utils.test.ts
import { describe, it, expect } from 'vitest';
import {
  isTrimmed, firstKeptTurn, isMissingConversation, formatMs, compactNumber,
  formatTokens, formatChars, formatRelativeTime, outcomeClass, toMessageRows,
} from '../../components/convdebug/convdebug-utils';
import type { ConvTraceStore, TurnTrace } from '../../storage/traces';
import type { ChatMessage } from '../../agent/provider/types';

const turn = (n: number): TurnTrace => ({
  turn: n, startedAt: 0, endedAt: 0, tabId: 1, mode: 'agent',
  context: { messageCount: 0, chars: 0, hasSummary: false, summaryChars: 0, skillCount: 0, systemPromptChars: 0, pageUrl: '' },
  llm: { ms: 0, finishReason: '', textChars: 0, reasoningChars: 0 },
  tools: [], outcome: 'done',
});
const store = (seq: number, n: number): ConvTraceStore => ({ seq, turns: Array.from({ length: n }, (_, i) => turn(i + 1)) });

describe('convdebug-utils', () => {
  it('isTrimmed：seq 大于现存轮数即被裁过', () => {
    expect(isTrimmed(store(3, 2))).toBe(true);
    expect(isTrimmed(store(2, 2))).toBe(false);
    expect(isTrimmed(store(0, 0))).toBe(false);
  });

  it('firstKeptTurn：空 store 返回 0', () => {
    expect(firstKeptTurn(store(5, 2))).toBe(1);
    expect(firstKeptTurn(store(0, 0))).toBe(0);
  });

  it('isMissingConversation：createdAt 为 0 是未知会话哨兵', () => {
    expect(isMissingConversation({ id: 'x', title: '新会话', messages: [], status: 'idle', createdAt: 0, updatedAt: 0 })).toBe(true);
    expect(isMissingConversation({ id: 'x', title: 'a', messages: [], status: 'idle', createdAt: 1, updatedAt: 1 })).toBe(false);
  });

  it('formatMs：>=1000 用秒一位小数，否则毫秒整数', () => {
    expect(formatMs(240)).toBe('240ms');
    expect(formatMs(2400)).toBe('2.4s');
    expect(formatMs(0)).toBe('0ms');
    expect(formatMs(Number.NaN)).toBe('—');
    expect(formatMs(-1)).toBe('—');
  });

  it('compactNumber / formatChars / formatTokens', () => {
    expect(compactNumber(999)).toBe('999');
    expect(compactNumber(1200)).toBe('1.2k');
    expect(formatChars(420)).toBe('420 字');
    expect(formatChars(42000)).toBe('42.0k 字');
    expect(formatTokens(1200, 340)).toBe('1.2k→340');
    expect(formatTokens(1200)).toBe('1.2k');
    expect(formatTokens(undefined, 340)).toBe('—');
  });

  it('formatRelativeTime 按档位退化', () => {
    const now = 10_000_000;
    expect(formatRelativeTime(now - 30_000, now)).toBe('刚刚');
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5 分钟前');
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe('3 小时前');
    expect(formatRelativeTime(now - 3 * 86_400_000, now)).toBe(new Date(now - 3 * 86_400_000).toLocaleDateString());
  });

  it('outcomeClass 产出 CSS 修饰名', () => {
    expect(outcomeClass('truncated-retry')).toBe('convdebug-turn--truncated-retry');
  });

  it('toMessageRows：字符串 content、toolCalls、name', () => {
    const msgs: ChatMessage[] = [
      { role: 'assistant', content: '好的', toolCalls: [{ id: 'a', name: 'click', arguments: '{"uid":1}' }] },
      { role: 'tool', content: 'ok', name: 'click', toolCallId: 'a' },
    ];
    const rows = toMessageRows(msgs);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.text).toBe('好的');
    expect(rows[0]!.toolCalls).toEqual([{ name: 'click', args: '{"uid":1}' }]);
    expect(rows[1]!.name).toBe('click');
    expect(rows[0]!.key).not.toBe(rows[1]!.key);
  });

  it('toMessageRows：图片 part 折叠成占位文本，不把 base64 渲进 DOM', () => {
    const msgs: ChatMessage[] = [{
      role: 'user',
      content: [{ type: 'text', text: '看这个' }, { type: 'image_url', imageUrl: 'data:image/png;base64,AAAA' }],
    }];
    const row = toMessageRows(msgs)[0]!;
    expect(row.text).toContain('看这个');
    expect(row.text).toContain('[图片');
    expect(row.text).not.toContain('AAAA');
  });

  it('toMessageRows：reasoning 单独成字段', () => {
    const rows = toMessageRows([{ role: 'assistant', content: 'x', reasoning: '想想' }]);
    expect(rows[0]!.reasoning).toBe('想想');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/convdebug/utils.test.ts`
Expected: FAIL —— `Failed to resolve import`

- [ ] **Step 3: 实现**

创建 `components/convdebug/convdebug-utils.ts`：

```ts
// components/convdebug/convdebug-utils.ts
// 会话调试页的纯投影函数（无 React 依赖，可单测）。
import type { ChatMessage, ContentPart } from '../../agent/provider/types';
import type { Conversation } from '../../storage/conversations';
import type { ConvTraceStore, TurnOutcome } from '../../storage/traces';

/** trace 是否已被环形裁剪（累计轮数 > 现存轮数）。 */
export function isTrimmed(store: ConvTraceStore): boolean {
  return store.seq > store.turns.length;
}

/** 现存最早轮次序号；空 store 返回 0。 */
export function firstKeptTurn(store: ConvTraceStore): number {
  return store.turns[0]?.turn ?? 0;
}

/** getConversation 对未知 id 返回 createdAt=0 的空壳（conversations.ts 的 EPOCH 哨兵）。 */
export function isMissingConversation(conv: Conversation): boolean {
  return conv.createdAt === 0;
}

/** 毫秒 → 人读耗时。>=1000 用秒一位小数，否则毫秒整数。 */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

/** 1000 以下原样；以上保留一位小数的 k。 */
export function compactNumber(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** token 变化：`1.2k→340`；缺 prompt 端退化为 '—'，缺 completion 端只显示单值。 */
export function formatTokens(promptTokens?: number, completionTokens?: number): string {
  if (promptTokens == null) return '—';
  const p = compactNumber(promptTokens);
  return completionTokens == null ? p : `${p}→${compactNumber(completionTokens)}`;
}

/** 字符体积。 */
export function formatChars(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k 字` : `${n} 字`;
}

/** 相对时间：<60s「刚刚」，<60m「N 分钟前」，<24h「N 小时前」，否则本地日期。 */
export function formatRelativeTime(ts: number, now = Date.now()): string {
  const diff = now - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return new Date(ts).toLocaleDateString();
}

/** outcome → styles.css 里的修饰类名。 */
export function outcomeClass(o: TurnOutcome): string {
  return `convdebug-turn--${o}`;
}

/** 原始消息流的一行视图模型。 */
export interface MessageRow {
  key: string;
  role: ChatMessage['role'];
  text: string;
  reasoning?: string;
  toolCalls?: Array<{ name: string; args: string }>;
  name?: string;
}

/** ChatMessage[] → 可渲染行（图片 part 折叠为占位文本，避免把 base64 渲进 DOM）。 */
export function toMessageRows(messages: ChatMessage[]): MessageRow[] {
  return messages.map((m, i) => ({
    key: `${i}-${m.role}`,
    role: m.role,
    text: typeof m.content === 'string' ? m.content : contentPartsToText(m.content),
    ...(m.reasoning ? { reasoning: m.reasoning } : {}),
    ...(m.toolCalls ? { toolCalls: m.toolCalls.map((tc) => ({ name: tc.name, args: tc.arguments })) } : {}),
    ...(m.name ? { name: m.name } : {}),
  }));
}

function contentPartsToText(parts: ContentPart[]): string {
  return parts
    .map((p) => (p.type === 'text' ? p.text : `[图片 ${p.imageUrl.length} 字符]`))
    .join('\n');
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/convdebug/utils.test.ts`
Expected: 10 passed

- [ ] **Step 5: 提交**

```bash
git add components/convdebug/convdebug-utils.ts tests/convdebug/utils.test.ts
git commit -m "feat(convdebug): 会话调试页视图投影纯函数"
```

---

### Task 6: 标签页入口与页面壳

**Files:**
- Create: `entrypoints/conv-debug/index.html`
- Create: `entrypoints/conv-debug/main.tsx`
- Create: `components/convdebug/ConvDebugApp.tsx`
- Modify: `entrypoints/sidepanel/styles.css`（追加 `.convdebug*` 壳层样式）
- Test: `tests/convdebug/conv-debug-app.test.tsx`

**Interfaces:**
- Consumes: Task 5 的全部纯函数、Task 1 的 `readTraces`、`listConversations` / `getConversation`（`storage/conversations.ts`）、`TurnTimeline`（Task 7）、`RawMessages`（Task 8）
- Produces: `ConvDebugApp({ initialConvId }: { initialConvId: string })`、`entrypoints/conv-debug/main.tsx` 挂载

**注意**：本任务 import 了 Task 7/8 尚未创建的组件。先按下面的签名建**最小占位**（只渲染一行文本），Task 7/8 再替换成真实实现——这样本任务能独立测通、独立提交。

- [ ] **Step 1: 建占位组件（让 Task 6 能独立编译）**

创建 `components/convdebug/TurnTimeline.tsx`：

```tsx
// components/convdebug/TurnTimeline.tsx
import type { TurnTrace } from '../../storage/traces';

export function TurnTimeline({ turns }: { turns: TurnTrace[] }) {
  return <p className="convdebug__empty">共 {turns.length} 轮（时间线待实现）</p>;
}
```

创建 `components/convdebug/RawMessages.tsx`：

```tsx
// components/convdebug/RawMessages.tsx
import type { ChatMessage } from '../../agent/provider/types';

export function RawMessages({ messages }: { messages: ChatMessage[] }) {
  return <p className="convdebug__empty">共 {messages.length} 条消息（消息流待实现）</p>;
}
```

- [ ] **Step 2: 建 entrypoint**

创建 `entrypoints/conv-debug/index.html`（照抄 `entrypoints/script-detail/index.html` 的模板）：

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>会话调试</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

创建 `entrypoints/conv-debug/main.tsx`：

```tsx
// entrypoints/conv-debug/main.tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConvDebugApp } from '../../components/convdebug/ConvDebugApp';
import '../sidepanel/styles.css';

const params = new URLSearchParams(location.search);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConvDebugApp initialConvId={params.get('convId') ?? ''} />
  </React.StrictMode>,
);
```

- [ ] **Step 3: 生成 WXT 类型**

Run: `npx wxt prepare`
Expected: 无错，`.wxt/types/paths.d.ts` 里出现 `/conv-debug.html`

- [ ] **Step 4: 写失败测试**

创建 `tests/convdebug/conv-debug-app.test.tsx`：

```tsx
// tests/convdebug/conv-debug-app.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { ConvDebugApp } from '../../components/convdebug/ConvDebugApp';
import { createConversation, appendMessage } from '../../storage/conversations';
import { appendTurnTrace, type TurnTrace } from '../../storage/traces';

const turn = (n: number): TurnTrace => ({
  turn: n, startedAt: 1000, endedAt: 1400, tabId: 1, mode: 'agent',
  context: { messageCount: 2, chars: 100, hasSummary: false, summaryChars: 0, skillCount: 0, systemPromptChars: 50, pageUrl: 'https://x.com' },
  llm: { ms: 300, finishReason: 'stop', textChars: 2, reasoningChars: 0 },
  tools: [], outcome: 'done',
});

describe('ConvDebugApp', () => {
  beforeEach(() => fakeBrowser.reset());
  afterEach(cleanup);

  it('无会话时显示空态', async () => {
    render(<ConvDebugApp initialConvId="" />);
    await waitFor(() => expect(screen.getByText('还没有任何会话')).toBeTruthy());
  });

  it('initialConvId 命中时直接展示该会话详情', async () => {
    const c = await createConversation();
    await appendMessage(c.id, { role: 'user', content: '你好' });
    await appendTurnTrace(c.id, turn(1));

    render(<ConvDebugApp initialConvId={c.id} />);
    await waitFor(() => expect(screen.getByText(/1 轮/)).toBeTruthy());
    // 标题同时出现在左栏条目与详情 h1，故用 getAllByText
    expect(screen.getAllByText('你好').length).toBeGreaterThan(0);
  });

  it('trace 被裁剪时给出降级提示', async () => {
    const c = await createConversation();
    // 直接写裸 driver key（wxt 把 'local:conv:x:trace' 映射成 chrome.storage.local 里的
    // 'conv:x:trace'），模拟「累计 5 轮、只剩最近 2 轮」的裁剪态
    await fakeBrowser.storage.local.set({ [`conv:${c.id}:trace`]: { seq: 5, turns: [turn(4), turn(5)] } });

    render(<ConvDebugApp initialConvId={c.id} />);
    await waitFor(() => expect(screen.getByText(/trace 仅保留最近/)).toBeTruthy());
  });

  it('initialConvId 指向不存在的会话 → 提示不存在', async () => {
    render(<ConvDebugApp initialConvId="ghost" />);
    await waitFor(() => expect(screen.getByText('会话不存在或已删除')).toBeTruthy());
  });
});
```

**注意** `fakeBrowser.reset()` 在 `afterEach(cleanup)` 之前跑——`beforeEach` 里 reset 就够，顺序无冲突。

- [ ] **Step 5: 跑测试确认失败**

Run: `npx vitest run tests/convdebug/conv-debug-app.test.tsx`
Expected: FAIL —— `Failed to resolve import "../../components/convdebug/ConvDebugApp"`

- [ ] **Step 6: 实现页面壳**

创建 `components/convdebug/ConvDebugApp.tsx`：

```tsx
// components/convdebug/ConvDebugApp.tsx
// 会话调试页壳（spec §6）：左列表 + 右详情，?convId= 深链，storage.watch 自动跟随。
// 数据直接 import storage/*（扩展页面读 chrome.storage 无障碍，先例见 ChatView/MemoryPage）。
import { useEffect, useMemo, useState } from 'react';
import { storage } from 'wxt/utils/storage';
import { Activity } from 'lucide-react';
import { listConversations, getConversation, type Conversation, type ConversationMeta } from '../../storage/conversations';
import { readTraces, type ConvTraceStore } from '../../storage/traces';
import { firstKeptTurn, formatRelativeTime, isMissingConversation, isTrimmed } from './convdebug-utils';
import { TurnTimeline } from './TurnTimeline';
import { RawMessages } from './RawMessages';

type DetailView = 'timeline' | 'messages';

const INDEX_KEY = 'local:conv-index';
const traceKey = (id: string) => `local:conv:${id}:trace` as const;
const convKey = (id: string) => `local:conv:${id}` as const;
const EMPTY_TRACES: ConvTraceStore = { seq: 0, turns: [] };

export function ConvDebugApp({ initialConvId }: { initialConvId: string }) {
  const [list, setList] = useState<ConversationMeta[]>([]);
  const [convId, setConvId] = useState(initialConvId);
  const [conv, setConv] = useState<Conversation | null>(null);
  const [traces, setTraces] = useState<ConvTraceStore>(EMPTY_TRACES);
  const [view, setView] = useState<DetailView>('timeline');
  const [follow, setFollow] = useState(true);

  // 会话列表：挂载读一次，清单变更靠 watch 兜
  useEffect(() => {
    const load = async () => {
      const l = await listConversations();
      setList(l);
      // 深链缺省：没指定就选最近一个
      setConvId((cur) => cur || (l[0]?.id ?? ''));
    };
    void load();
    return storage.watch(INDEX_KEY, () => void load());
  }, []);

  // 详情：convId / follow 变化重读；跟随开启时 watch 该会话的 conv + trace key
  useEffect(() => {
    if (!convId) {
      setConv(null);
      setTraces(EMPTY_TRACES);
      return;
    }
    let alive = true;
    const load = async () => {
      const [c, t] = await Promise.all([getConversation(convId), readTraces(convId)]);
      if (!alive) return;
      setConv(c);
      setTraces(t);
    };
    void load();
    if (!follow) return () => { alive = false; };
    const unwatchConv = storage.watch(convKey(convId), () => void load());
    const unwatchTrace = storage.watch(traceKey(convId), () => void load());
    return () => { alive = false; unwatchConv(); unwatchTrace(); };
  }, [convId, follow]);

  const select = (id: string) => {
    setConvId(id);
    // replaceState 而非 push：切会话不该堆返回历史
    history.replaceState(null, '', `?convId=${encodeURIComponent(id)}`);
  };

  const missing = conv != null && isMissingConversation(conv);
  const trimmed = isTrimmed(traces);
  const selectedMeta = useMemo(() => list.find((m) => m.id === convId), [list, convId]);

  return (
    <div className="convdebug">
      <header className="convdebug__bar">
        <span className="convdebug__brand">
          <Activity size={16} strokeWidth={1.8} aria-hidden />
          会话调试
        </span>
        <label className="convdebug__follow">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          自动跟随
        </label>
      </header>

      <div className="convdebug__body">
        <aside className="convdebug__list" aria-label="会话列表">
          {list.length === 0 && <p className="convdebug__empty">还没有任何会话</p>}
          {list.map((m) => (
            <button
              key={m.id}
              type="button"
              className={`convdebug-item${m.id === convId ? ' convdebug-item--active' : ''}`}
              onClick={() => select(m.id)}
            >
              <span className="convdebug-item__title">{m.title}</span>
              <span className="convdebug-item__meta mono">
                {formatRelativeTime(m.updatedAt)} · {m.status}
              </span>
            </button>
          ))}
        </aside>

        <main className="convdebug__detail">
          {!convId ? (
            <p className="convdebug__empty">从左侧选一个会话</p>
          ) : missing ? (
            <p className="convdebug__empty">会话不存在或已删除</p>
          ) : (
            <>
              <div className="convdebug__head">
                <h1 className="convdebug__title">{conv?.title ?? selectedMeta?.title ?? ''}</h1>
                <span className="convdebug__meta mono">
                  {conv?.status ?? '—'} · {conv?.messages.length ?? 0} 消息 · {traces.turns.length} 轮
                </span>
                <div className="convdebug__views">
                  <button
                    type="button"
                    className={`btn${view === 'timeline' ? ' btn--primary' : ''}`}
                    onClick={() => setView('timeline')}
                  >
                    轮次时间线
                  </button>
                  <button
                    type="button"
                    className={`btn${view === 'messages' ? ' btn--primary' : ''}`}
                    onClick={() => setView('messages')}
                  >
                    原始消息流
                  </button>
                </div>
              </div>

              {trimmed && (
                <p className="convdebug__note mono">
                  trace 仅保留最近 {traces.turns.length} 轮（第 {firstKeptTurn(traces)}–{traces.seq} 轮），更早的轮次请查看原始消息流
                </p>
              )}

              {view === 'timeline'
                ? <TurnTimeline turns={traces.turns} />
                : <RawMessages messages={conv?.messages ?? []} />}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
```

- [ ] **Step 7: 追加壳层样式**

在 `entrypoints/sidepanel/styles.css` 末尾追加：

```css
/* ---------- AI 会话调试页（conv-debug.html）---------- */
/* 独立标签页：全宽仪表盘。左列表 + 右详情，双声道排版。 */
.convdebug { display: flex; flex-direction: column; height: 100%; background: var(--paper); }

.convdebug__bar {
  display: flex; align-items: center; justify-content: space-between;
  gap: 12px; padding: 10px 16px;
  background: var(--surface); border-bottom: 1px solid var(--line);
}
.convdebug__brand { display: inline-flex; align-items: center; gap: 8px; font-weight: 600; color: var(--ink); }
.convdebug__follow { display: inline-flex; align-items: center; gap: 6px; color: var(--ink-2); font-size: 13px; cursor: pointer; }

.convdebug__body { display: flex; flex: 1; min-height: 0; }

.convdebug__list {
  width: 240px; flex: none; overflow-y: auto;
  border-right: 1px solid var(--line); background: var(--surface); padding: 6px;
}
.convdebug-item {
  display: flex; flex-direction: column; gap: 2px; width: 100%; text-align: left;
  padding: 8px 10px; border: 1px solid transparent; border-radius: var(--r-md);
  background: transparent; color: var(--ink); font: inherit; cursor: pointer;
  transition: background var(--t-fast) var(--ease);
}
.convdebug-item:hover { background: var(--sunken); }
.convdebug-item--active { background: var(--signal-wash); border-color: var(--signal); }
.convdebug-item__title { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.convdebug-item__meta { font-family: var(--mono); font-size: 11px; color: var(--ink-3); }

.convdebug__detail { flex: 1; min-width: 0; overflow-y: auto; padding: 16px 20px; }
.convdebug__head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 10px; margin-bottom: 10px; }
.convdebug__title { font-size: 16px; margin: 0; }
.convdebug__meta { font-family: var(--mono); font-size: 12px; color: var(--ink-3); }
.convdebug__views { margin-left: auto; display: inline-flex; gap: 6px; }
.convdebug__note {
  font-family: var(--mono); font-size: 12px; color: var(--warn);
  background: var(--warn-wash); border: 1px solid var(--line); border-radius: var(--r-md);
  padding: 6px 10px; margin: 0 0 12px;
}
.convdebug__empty { color: var(--ink-3); font-size: 13px; padding: 24px 8px; }
.convdebug-bad { color: var(--err); }
```

- [ ] **Step 8: 跑测试确认通过**

Run: `npx vitest run tests/convdebug/conv-debug-app.test.tsx`
Expected: 4 passed

- [ ] **Step 9: 类型检查**

Run: `npm run compile`
Expected: 无错

- [ ] **Step 10: 提交**

```bash
git add entrypoints/conv-debug components/convdebug/ConvDebugApp.tsx components/convdebug/TurnTimeline.tsx components/convdebug/RawMessages.tsx entrypoints/sidepanel/styles.css tests/convdebug/conv-debug-app.test.tsx
git commit -m "feat(convdebug): 会话调试页 entrypoint 与壳（列表/深链/自动跟随）"
```

---

### Task 7: 轮次时间线组件

**Files:**
- Modify: `components/convdebug/TurnTimeline.tsx`（把 Task 6 的占位换成真实实现）
- Modify: `entrypoints/sidepanel/styles.css`（追加时间线样式）
- Test: `tests/convdebug/turn-timeline.test.tsx`

**Interfaces:**
- Consumes: `TurnTrace`（Task 1）、`formatMs` / `formatChars` / `formatTokens` / `outcomeClass`（Task 5）
- Produces: `TurnTimeline({ turns }: { turns: TurnTrace[] })`

- [ ] **Step 1: 写失败测试**

创建 `tests/convdebug/turn-timeline.test.tsx`：

```tsx
// tests/convdebug/turn-timeline.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { TurnTimeline } from '../../components/convdebug/TurnTimeline';
import type { TurnTrace } from '../../storage/traces';

const turn = (n: number, over?: Partial<TurnTrace>): TurnTrace => ({
  turn: n, startedAt: 0, endedAt: 2400, tabId: 1, mode: 'agent',
  context: { messageCount: 18, chars: 42000, hasSummary: false, summaryChars: 0, skillCount: 0, systemPromptChars: 500, pageUrl: 'https://x.com' },
  llm: { ms: 1900, firstTokenMs: 400, finishReason: 'stop', usage: { promptTokens: 1200, completionTokens: 340 }, textChars: 20, reasoningChars: 0 },
  tools: [], outcome: 'done',
  ...over,
});

describe('TurnTimeline', () => {
  afterEach(cleanup);

  it('空 trace 显示空态', () => {
    render(<TurnTimeline turns={[]} />);
    expect(screen.getByText(/还没有 loop 记录/)).toBeTruthy();
  });

  it('最近一轮默认展开，其余收起', () => {
    render(<TurnTimeline turns={[turn(1), turn(2)]} />);
    // #2 展开 → 它的工具表头可见；#1 收起 → 没有
    expect(screen.getAllByText('上下文').length).toBe(1);
    expect(screen.getByText('#2')).toBeTruthy();
    expect(screen.getByText('#1')).toBeTruthy();
  });

  it('点击折叠头切换展开态', () => {
    render(<TurnTimeline turns={[turn(1), turn(2)]} />);
    fireEvent.click(screen.getByText('#1'));
    expect(screen.getAllByText('上下文').length).toBe(2);
    fireEvent.click(screen.getByText('#2'));
    expect(screen.getAllByText('上下文').length).toBe(1);
  });

  it('折叠头展示耗时 / LLM 耗时 / token / 工具数 / outcome', () => {
    render(<TurnTimeline turns={[turn(3, { tools: [
      { name: 'click', callId: 'c1', argsBytes: 9, ms: 12, ok: true, summary: '成功' },
    ] })]} />);
    expect(screen.getByText('2.4s')).toBeTruthy();
    expect(screen.getByText('LLM 1.9s')).toBeTruthy();
    expect(screen.getByText('1.2k→340')).toBeTruthy();
    expect(screen.getByText('1 工具')).toBeTruthy();
    expect(screen.getByText('done')).toBeTruthy();
  });

  it('展开体渲染上下文摘要、TTFT、工具明细与压缩', () => {
    render(<TurnTimeline turns={[turn(1, {
      compact: { ms: 800, ok: true, newPromptTokens: 400 },
      tools: [{ name: 'scroll', callId: 'c9', argsBytes: 20, ms: 30, ok: false, error: '元素不存在', summary: '元素不存在' }],
    })]} />);
    expect(screen.getByText(/18 条/)).toBeTruthy();
    expect(screen.getByText(/42.0k 字/)).toBeTruthy();
    expect(screen.getByText(/TTFT 400ms/)).toBeTruthy();
    expect(screen.getByText(/压缩后 400 tok/)).toBeTruthy();
    expect(screen.getByText('scroll')).toBeTruthy();
    expect(screen.getByText('元素不存在')).toBeTruthy();
  });

  it('熔断轮展示 guardReason', () => {
    render(<TurnTimeline turns={[turn(1, { outcome: 'paused', guardReason: '连续 3 次重复调用同一工具，可能卡住' })]} />);
    expect(screen.getByText(/重复调用同一工具/)).toBeTruthy();
    expect(screen.getByText('paused')).toBeTruthy();
  });

  it('outcome 落到修饰类名上', () => {
    const { container } = render(<TurnTimeline turns={[turn(1, { outcome: 'aborted' })]} />);
    expect(container.querySelector('.convdebug-turn--aborted')).toBeTruthy();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/convdebug/turn-timeline.test.tsx`
Expected: FAIL —— 占位组件渲染的是「共 N 轮（时间线待实现）」

- [ ] **Step 3: 实现**

把 `components/convdebug/TurnTimeline.tsx` 整体替换为：

```tsx
// components/convdebug/TurnTimeline.tsx
// 轮次时间线（spec §6.3）：一轮一个折叠块，头部是元数据，展开是上下文/LLM/工具/压缩四段。
import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { TurnTrace } from '../../storage/traces';
import { formatChars, formatMs, formatTokens, outcomeClass } from './convdebug-utils';

export function TurnTimeline({ turns }: { turns: TurnTrace[] }) {
  // 只记「用户手动改过」的轮次，最近一轮的默认展开由 lastTurn 推导——
  // 这样 turns 异步到达后默认展开仍然生效，不需要 effect 补状态。
  const lastTurn = turns[turns.length - 1]?.turn;
  const [toggled, setToggled] = useState<Record<number, boolean>>({});
  const isOpen = (t: number) => toggled[t] ?? (t === lastTurn);

  if (turns.length === 0) {
    return <p className="convdebug__empty">这个会话还没有 loop 记录（trace 从本功能上线后开始记录）</p>;
  }

  return (
    <div className="convdebug-timeline">
      {turns.map((t) => {
        const expanded = isOpen(t.turn);
        return (
          <section key={t.turn} className={`convdebug-turn ${outcomeClass(t.outcome)}`}>
            <button
              type="button"
              className="convdebug-turn__head"
              aria-expanded={expanded}
              onClick={() => setToggled((s) => ({ ...s, [t.turn]: !expanded }))}
            >
              <ChevronRight
                size={14}
                className={`convdebug-turn__chev${expanded ? ' convdebug-turn__chev--open' : ''}`}
                aria-hidden
              />
              <span className="convdebug-turn__no mono">#{t.turn}</span>
              <span className="convdebug-turn__stat mono">{formatMs(t.endedAt - t.startedAt)}</span>
              <span className="convdebug-turn__stat mono">LLM {formatMs(t.llm.ms)}</span>
              <span className="convdebug-turn__stat mono">
                {formatTokens(t.llm.usage?.promptTokens, t.llm.usage?.completionTokens)}
              </span>
              <span className="convdebug-turn__stat mono">{t.tools.length} 工具</span>
              <span className="convdebug-turn__outcome mono">{t.outcome}</span>
            </button>

            {expanded && (
              <div className="convdebug-turn__body">
                <dl className="convdebug-grid">
                  <dt>上下文</dt>
                  <dd className="mono">
                    {t.context.messageCount} 条 · {formatChars(t.context.chars)} · 摘要{' '}
                    {t.context.hasSummary ? formatChars(t.context.summaryChars) : '无'} · 技能 {t.context.skillCount} · 系统提示词{' '}
                    {formatChars(t.context.systemPromptChars)}
                  </dd>
                  <dt>页面</dt>
                  <dd className="mono">{t.context.pageUrl || '—'}</dd>
                  <dt>模式</dt>
                  <dd className="mono">{t.mode} · tab {t.tabId}</dd>
                  <dt>LLM</dt>
                  <dd className="mono">
                    TTFT {t.llm.firstTokenMs != null ? formatMs(t.llm.firstTokenMs) : '—'} · {t.llm.finishReason || '—'} · 正文{' '}
                    {formatChars(t.llm.textChars)} · reasoning {formatChars(t.llm.reasoningChars)}
                  </dd>
                  {t.llm.error && (
                    <>
                      <dt>错误</dt>
                      <dd className="mono convdebug-bad">{t.llm.error}</dd>
                    </>
                  )}
                  {t.compact && (
                    <>
                      <dt>压缩</dt>
                      <dd className="mono">
                        {formatMs(t.compact.ms)} · {t.compact.ok ? '成功' : '未生效'}
                        {t.compact.newPromptTokens != null ? ` · 压缩后 ${t.compact.newPromptTokens} tok` : ''}
                      </dd>
                    </>
                  )}
                  {t.guardReason && (
                    <>
                      <dt>熔断</dt>
                      <dd className="mono convdebug-bad">{t.guardReason}</dd>
                    </>
                  )}
                </dl>

                {t.tools.length > 0 && (
                  <table className="convdebug-tools">
                    <thead>
                      <tr>
                        <th>工具</th>
                        <th>参数</th>
                        <th>耗时</th>
                        <th>结果</th>
                      </tr>
                    </thead>
                    <tbody>
                      {t.tools.map((tool) => (
                        <tr key={tool.callId} className={tool.ok ? '' : 'convdebug-bad'}>
                          <td className="mono">{tool.name}</td>
                          <td className="mono">{tool.argsBytes}B</td>
                          <td className="mono">{formatMs(tool.ms)}</td>
                          <td>{tool.ok ? tool.summary : (tool.error ?? tool.summary)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: 追加时间线样式**

在 `entrypoints/sidepanel/styles.css` 末尾追加：

```css
/* 轮次时间线 */
.convdebug-timeline { display: flex; flex-direction: column; gap: 6px; }
.convdebug-turn {
  background: var(--surface); border: 1px solid var(--line);
  border-left: 3px solid var(--line-strong); border-radius: var(--r-md);
}
.convdebug-turn--continue { border-left-color: var(--line-strong); }
.convdebug-turn--done { border-left-color: var(--ink-3); }
.convdebug-turn--paused, .convdebug-turn--error { border-left-color: var(--err); }
.convdebug-turn--aborted { border-left-color: var(--ink-3); opacity: 0.75; }
.convdebug-turn--truncated-retry { border-left-color: var(--warn); }

.convdebug-turn__head {
  display: flex; align-items: center; gap: 10px; width: 100%;
  padding: 8px 12px; background: transparent; border: 0; font: inherit;
  color: var(--ink); cursor: pointer; text-align: left;
}
.convdebug-turn__head:hover { background: var(--sunken); }
.convdebug-turn__chev { color: var(--ink-3); transition: transform var(--t-fast) var(--ease); }
.convdebug-turn__chev--open { transform: rotate(90deg); }
.convdebug-turn__no { font-weight: 600; }
.convdebug-turn__stat, .convdebug-turn__outcome { font-family: var(--mono); font-size: 12px; color: var(--ink-2); }
.convdebug-turn__outcome { margin-left: auto; color: var(--ink-3); }

.convdebug-turn__body { padding: 4px 12px 12px; border-top: 1px solid var(--line); }

.convdebug-grid { display: grid; grid-template-columns: 72px 1fr; gap: 4px 12px; margin: 10px 0; font-size: 12px; }
.convdebug-grid dt { color: var(--ink-3); }
.convdebug-grid dd { margin: 0; font-family: var(--mono); color: var(--ink-2); word-break: break-all; }

.convdebug-tools { width: 100%; border-collapse: collapse; font-size: 12px; }
.convdebug-tools th {
  text-align: left; color: var(--ink-3); font-weight: 400;
  padding: 4px 8px; border-bottom: 1px solid var(--line);
}
.convdebug-tools td { padding: 4px 8px; border-bottom: 1px solid var(--line); color: var(--ink-2); }

@media (prefers-reduced-motion: reduce) {
  .convdebug-turn__chev { transition: none; }
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run tests/convdebug/turn-timeline.test.tsx`
Expected: 7 passed

- [ ] **Step 6: 提交**

```bash
git add components/convdebug/TurnTimeline.tsx entrypoints/sidepanel/styles.css tests/convdebug/turn-timeline.test.tsx
git commit -m "feat(convdebug): 轮次时间线组件"
```

---

### Task 8: 原始消息流组件

**Files:**
- Modify: `components/convdebug/RawMessages.tsx`（把 Task 6 的占位换成真实实现）
- Modify: `entrypoints/sidepanel/styles.css`（追加消息流样式）
- Test: `tests/convdebug/raw-messages.test.tsx`

**Interfaces:**
- Consumes: `toMessageRows` / `MessageRow`（Task 5）、`Markdown`（`components/chat/Markdown.tsx:57`，签名 `{ text: string; streaming?: boolean }`）
- Produces: `RawMessages({ messages }: { messages: ChatMessage[] })`

- [ ] **Step 1: 写失败测试**

创建 `tests/convdebug/raw-messages.test.tsx`：

```tsx
// tests/convdebug/raw-messages.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { RawMessages } from '../../components/convdebug/RawMessages';
import type { ChatMessage } from '../../agent/provider/types';

describe('RawMessages', () => {
  afterEach(cleanup);

  it('空消息显示空态', () => {
    render(<RawMessages messages={[]} />);
    expect(screen.getByText('这个会话还没有消息')).toBeTruthy();
  });

  it('逐条渲染 role 与正文', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: '帮我点掉弹窗' },
      { role: 'assistant', content: '好的' },
    ];
    render(<RawMessages messages={msgs} />);
    expect(screen.getByText('帮我点掉弹窗')).toBeTruthy();
    expect(screen.getByText('好的')).toBeTruthy();
    expect(screen.getByText('user')).toBeTruthy();
    expect(screen.getByText('assistant')).toBeTruthy();
  });

  it('assistant 的 toolCalls 折叠成可展开块', () => {
    const msgs: ChatMessage[] = [
      { role: 'assistant', content: '先点一下', toolCalls: [{ id: 'a', name: 'click', arguments: '{"uid":1}' }] },
    ];
    render(<RawMessages messages={msgs} />);
    expect(screen.getByText('调用 click')).toBeTruthy();
  });

  it('tool 消息显示工具名与输出', () => {
    const msgs: ChatMessage[] = [{ role: 'tool', content: '{"clicked":true}', name: 'click', toolCallId: 'a' }];
    render(<RawMessages messages={msgs} />);
    expect(screen.getByText('tool · click')).toBeTruthy();
    expect(screen.getByText('{"clicked":true}')).toBeTruthy();
  });

  it('reasoning 折叠成 details', () => {
    const msgs: ChatMessage[] = [{ role: 'assistant', content: 'x', reasoning: '先看看' }];
    render(<RawMessages messages={msgs} />);
    expect(screen.getByText('reasoning')).toBeTruthy();
  });

  it('图片 part 不把 base64 渲进 DOM', () => {
    const msgs: ChatMessage[] = [{
      role: 'user',
      content: [{ type: 'text', text: '看这个' }, { type: 'image_url', imageUrl: 'data:image/png;base64,SECRETBASE64' }],
    }];
    const { container } = render(<RawMessages messages={msgs} />);
    expect(container.textContent).not.toContain('SECRETBASE64');
    expect(container.textContent).toContain('[图片');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/convdebug/raw-messages.test.tsx`
Expected: FAIL —— 占位组件渲染的是「共 N 条消息（消息流待实现）」

- [ ] **Step 3: 实现**

把 `components/convdebug/RawMessages.tsx` 整体替换为：

```tsx
// components/convdebug/RawMessages.tsx
// 原始消息流（spec §6.4）：逐条渲染，user/assistant 走 Markdown，tool 与 toolCalls 走等宽折叠块。
// 不追求与聊天界面像素级一致，只求可读；trace 被裁剪后这里是唯一的完整历史。
import type { ChatMessage } from '../../agent/provider/types';
import { Markdown } from '../chat/Markdown';
import { toMessageRows, type MessageRow } from './convdebug-utils';

const ROLE_LABEL: Record<MessageRow['role'], string> = {
  system: 'system',
  user: 'user',
  assistant: 'assistant',
  tool: 'tool',
};

export function RawMessages({ messages }: { messages: ChatMessage[] }) {
  const rows = toMessageRows(messages);
  if (rows.length === 0) return <p className="convdebug__empty">这个会话还没有消息</p>;

  return (
    <div className="convdebug-msgs">
      {rows.map((r) => (
        <article key={r.key} className={`convdebug-msg convdebug-msg--${r.role}`}>
          <header className="convdebug-msg__role mono">
            {ROLE_LABEL[r.role]}
            {r.name ? ` · ${r.name}` : ''}
          </header>

          {r.reasoning && (
            <details className="convdebug-msg__fold">
              <summary className="mono">reasoning</summary>
              <pre className="convdebug-msg__pre">{r.reasoning}</pre>
            </details>
          )}

          {r.text && (r.role === 'user' || r.role === 'assistant'
            ? <Markdown text={r.text} />
            : <pre className="convdebug-msg__pre">{r.text}</pre>)}

          {r.toolCalls?.map((tc, i) => (
            <details key={i} className="convdebug-msg__fold">
              <summary className="mono">调用 {tc.name}</summary>
              <pre className="convdebug-msg__pre">{tc.args}</pre>
            </details>
          ))}
        </article>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: 追加消息流样式**

在 `entrypoints/sidepanel/styles.css` 末尾追加：

```css
/* 原始消息流 */
.convdebug-msgs { display: flex; flex-direction: column; gap: 10px; }
.convdebug-msg {
  background: var(--surface); border: 1px solid var(--line);
  border-radius: var(--r-md); padding: 10px 12px;
}
.convdebug-msg--system { background: var(--sunken); color: var(--ink-2); }
.convdebug-msg--tool { border-left: 3px solid var(--line-strong); }
.convdebug-msg__role {
  font-family: var(--mono); font-size: 11px; color: var(--ink-3);
  text-transform: uppercase; margin-bottom: 6px;
}
.convdebug-msg__pre {
  margin: 0; font-family: var(--mono); font-size: 12px;
  white-space: pre-wrap; word-break: break-all; color: var(--ink-2);
}
.convdebug-msg__fold { margin: 6px 0; }
.convdebug-msg__fold summary { font-family: var(--mono); font-size: 12px; color: var(--ink-3); cursor: pointer; }
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run tests/convdebug/raw-messages.test.tsx`
Expected: 6 passed

- [ ] **Step 6: 提交**

```bash
git add components/convdebug/RawMessages.tsx entrypoints/sidepanel/styles.css tests/convdebug/raw-messages.test.tsx
git commit -m "feat(convdebug): 原始消息流组件"
```

---

### Task 9: 设置页入口接线

**Files:**
- Create: `stores/extension-tabs.ts`
- Modify: `components/settings/SettingsHome.tsx`（`SettingsSub` 加 key、`Entry` 加 `tabUrl`、GROUPS 加条目、导出 `TAB_ENTRIES`）
- Modify: `components/settings/SettingsView.tsx`（`onOpen` 分流）
- Test: `tests/stores/extension-tabs.test.ts`、`tests/settings/tab-entries.test.ts`

**Interfaces:**
- Consumes: `getCurrentConvId`（`storage/conversations.ts:133`）
- Produces:
  - `openExtensionTab(path: string, opts?: { convId?: string | null }): Promise<void>`
  - `TAB_ENTRIES: Partial<Record<SettingsSub, string>>`

- [ ] **Step 1: 写失败测试（openExtensionTab）**

创建 `tests/stores/extension-tabs.test.ts`：

```ts
// tests/stores/extension-tabs.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { openExtensionTab } from '../../stores/extension-tabs';

describe('openExtensionTab', () => {
  beforeEach(() => { fakeBrowser.reset(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('无已开标签页 → tabs.create 带 convId 参数', async () => {
    vi.spyOn(browser.tabs, 'query').mockResolvedValue([]);
    const create = vi.spyOn(browser.tabs, 'create').mockResolvedValue({ id: 1 } as never);
    await openExtensionTab('/conv-debug.html', { convId: 'abc' });
    expect(create).toHaveBeenCalledTimes(1);
    const arg = create.mock.calls[0]![0] as { url: string; active: boolean };
    expect(arg.url).toContain('/conv-debug.html?convId=abc');
    expect(arg.active).toBe(true);
  });

  it('无 convId 时不带查询串', async () => {
    vi.spyOn(browser.tabs, 'query').mockResolvedValue([]);
    const create = vi.spyOn(browser.tabs, 'create').mockResolvedValue({ id: 1 } as never);
    await openExtensionTab('/conv-debug.html');
    const arg = create.mock.calls[0]![0] as { url: string };
    expect(arg.url).not.toContain('?');
  });

  it('已开 → tabs.update 导航 + 聚焦，不再 create', async () => {
    vi.spyOn(browser.tabs, 'query').mockResolvedValue([{ id: 7 }] as never);
    const update = vi.spyOn(browser.tabs, 'update').mockResolvedValue({ id: 7 } as never);
    const create = vi.spyOn(browser.tabs, 'create').mockResolvedValue({ id: 8 } as never);
    await openExtensionTab('/conv-debug.html', { convId: 'xyz' });
    expect(update).toHaveBeenCalledTimes(1);
    const [tabId, props] = update.mock.calls[0]! as [number, { url: string; active: boolean }];
    expect(tabId).toBe(7);
    expect(props.url).toContain('convId=xyz');
    expect(props.active).toBe(true);
    expect(create).not.toHaveBeenCalled();
  });

  it('convId 做 URL 编码', async () => {
    vi.spyOn(browser.tabs, 'query').mockResolvedValue([]);
    const create = vi.spyOn(browser.tabs, 'create').mockResolvedValue({ id: 1 } as never);
    await openExtensionTab('/conv-debug.html', { convId: 'a b/c' });
    const arg = create.mock.calls[0]![0] as { url: string };
    expect(arg.url).toContain('convId=a%20b%2Fc');
  });
});
```

创建 `tests/settings/tab-entries.test.ts`：

```ts
// tests/settings/tab-entries.test.ts
import { describe, it, expect } from 'vitest';
import { TAB_ENTRIES } from '../../components/settings/SettingsHome';

describe('TAB_ENTRIES', () => {
  it('会话调试项指向 conv-debug.html', () => {
    expect(TAB_ENTRIES.convdebug).toBe('/conv-debug.html');
  });

  it('只收带 tabUrl 的条目——进二级页的项不该出现在表里', () => {
    expect(TAB_ENTRIES.model).toBeUndefined();
    expect(TAB_ENTRIES.prompt).toBeUndefined();
    expect(TAB_ENTRIES.memory).toBeUndefined();
    expect(TAB_ENTRIES.skills).toBeUndefined();
    expect(TAB_ENTRIES.toolbench).toBeUndefined();
    expect(TAB_ENTRIES.scriptdebug).toBeUndefined();
    expect(TAB_ENTRIES.about).toBeUndefined();
  });

  it('表里每一项都有非空路径', () => {
    for (const [k, v] of Object.entries(TAB_ENTRIES)) {
      expect(typeof v, k).toBe('string');
      expect(v, k).toMatch(/^\/.+\.html$/);
    }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/stores/extension-tabs.test.ts tests/settings/tab-entries.test.ts`
Expected: FAIL —— 两个 import 都解析不到

- [ ] **Step 3: 实现 `openExtensionTab`**

创建 `stores/extension-tabs.ts`：

```ts
// stores/extension-tabs.ts
// 扩展自有页面在新标签页打开：已开则导航 + 聚焦，未开则新建。
// 复用模式来自 background/confirm-queue.ts 的 hub 标签页（开过就 tabs.update 聚焦）。

/** 打开扩展自有页面（path 形如 '/conv-debug.html'）。
 * 已存在同路径标签页时用 tabs.update 导航到目标 URL 并聚焦——既避免开一堆重复调试页，
 * 也让「已开但停在别的会话」能切过去。 */
export async function openExtensionTab(path: string, opts: { convId?: string | null } = {}): Promise<void> {
  const query = opts.convId ? `?convId=${encodeURIComponent(opts.convId)}` : '';
  const url = browser.runtime.getURL(path) + query;
  const [existing] = await browser.tabs.query({ url: browser.runtime.getURL(path) + '*' });
  if (existing?.id != null) {
    await browser.tabs.update(existing.id, { url, active: true });
    return;
  }
  await browser.tabs.create({ url, active: true });
}
```

- [ ] **Step 4: 改造 `SettingsHome.tsx`**

四处改动：

① 顶部 lucide import 加 `Activity`：

```tsx
import { SlidersHorizontal, SquareTerminal, FlaskConical, ChevronRight, Sparkles, ScrollText, Brain, Info, Activity } from 'lucide-react';
```

② `SettingsSub` 加 `'convdebug'`，`Entry` 加 `tabUrl?`：

```tsx
export type SettingsSub = 'model' | 'prompt' | 'memory' | 'toolbench' | 'scriptdebug' | 'skills' | 'about' | 'convdebug';

/** tabUrl 存在 = 该条目不开二级页，直接在新标签页打开该扩展页面。 */
type Entry = { key: SettingsSub; title: string; desc: string; Icon: typeof SlidersHorizontal; tabUrl?: string };
```

③ 「开发者工具」组加条目：

```tsx
  {
    label: '开发者工具',
    entries: [
      { key: 'toolbench', title: '工具调试台', desc: '绕过模型，直接对当前页调用全部工具', Icon: SquareTerminal },
      { key: 'scriptdebug', title: '脚本运行时调试台', desc: 'GM API 白名单视图 + 经真实桥链路直调', Icon: FlaskConical },
      { key: 'convdebug', title: 'AI 会话调试', desc: '会话历史与 agent loop 调用记录（新标签页打开）', Icon: Activity, tabUrl: '/conv-debug.html' },
    ],
  },
```

④ 在 `GROUPS` 定义之后导出查表：

```tsx
/** 不走二级页、直接开独立标签页的设置项（key → 目标页面路径）。由 GROUPS 派生，避免两处漂移。 */
export const TAB_ENTRIES: Partial<Record<SettingsSub, string>> = Object.fromEntries(
  GROUPS.flatMap((g) => g.entries)
    .filter((e): e is Entry & { tabUrl: string } => e.tabUrl != null)
    .map((e) => [e.key, e.tabUrl]),
) as Partial<Record<SettingsSub, string>>;
```

- [ ] **Step 5: 改造 `SettingsView.tsx`**

① import 区加：

```tsx
import { SettingsHome, TAB_ENTRIES, type SettingsSub } from './SettingsHome';
import { openExtensionTab } from '../../stores/extension-tabs';
import { getCurrentConvId } from '../../storage/conversations';
```

② 在 `back` 之后加分流函数，并把 `<SettingsHome onOpen={setSub} />` 改成 `onOpen={open}`：

```tsx
export function SettingsView() {
  const [sub, setSub] = useState<SettingsSub | null>(null);
  const back = () => setSub(null);

  // 带 tabUrl 的条目开独立标签页（默认停在你正在看的会话），其余照旧切二级页
  const open = (key: SettingsSub) => {
    const url = TAB_ENTRIES[key];
    if (url) {
      void getCurrentConvId().then((convId) => openExtensionTab(url, { convId }));
      return;
    }
    setSub(key);
  };

  return (
    <div className="view-swap" key={sub ?? 'home'}>
      {/* ...二级页三元链不变... */}
      ) : (
        <SettingsHome onOpen={open} />
      )}
    </div>
  );
}
```

- [ ] **Step 6: 跑测试确认通过**

Run: `npx vitest run tests/stores/extension-tabs.test.ts tests/settings/tab-entries.test.ts tests/settings/settings-view.test.tsx`
Expected: 全部 PASS（`settings-view.test.tsx` 是既有回归）

- [ ] **Step 7: 类型检查 + 全量测试**

Run: `npm run compile && npm run test`
Expected: 均无错

- [ ] **Step 8: 提交**

```bash
git add stores/extension-tabs.ts components/settings/SettingsHome.tsx components/settings/SettingsView.tsx tests/stores/extension-tabs.test.ts tests/settings/tab-entries.test.ts
git commit -m "feat(settings): AI 会话调试入口，设置项直接开独立标签页"
```

---

### Task 10: 文档同步

**Files:**
- Modify: `CLAUDE.md`（项目结构 + 当前阶段）
- Modify: `docs/history.md`（追加迭代记录）

**Interfaces:**
- Consumes: 前 9 个任务的全部产出
- Produces: 无代码

- [ ] **Step 1: 更新 `CLAUDE.md` 项目结构**

在 `entrypoints/` 代码块里，`sidepanel/` 那一行之后加：

```text
  conv-debug/         AI 会话调试页（独立标签页，从设置页打开）
```

在 `components/` 代码块里，`debug/` 那一行之后加：

```text
  convdebug/          AI 会话调试页（会话列表 + 轮次时间线 + 原始消息流）
```

- [ ] **Step 2: 更新 `CLAUDE.md` 当前阶段**

在「当前阶段」的已完成清单末尾（`...品牌、宣传页）全部在 docs/history.md`）追加 `、AI 会话调试页`。

- [ ] **Step 3: 追加 `docs/history.md` 一节**

先读 `docs/history.md` 末尾两节，**照抄它的标题层级与行文体例**，然后追加一节，内容需覆盖：

- 动机：消息流只存「结果」，loop 的「过程」（耗时/TTFT/usage/工具耗时/压缩/熔断）此前全无记录
- 数据模型：`local:conv:{id}:trace`，`{ seq, turns }` 环形保留 200 轮，随会话删除
- 关键取舍：不存 prompt 全文（无 `unlimitedStorage`，quota 即 10MB）；页面直读 `storage/*` 不走消息协议
- `drive()` 的 `try/finally` 收口与 9 处 `outcome` 出口（含 `'continue'` 这个最常见的非终态）
- 页面：`conv-debug.html` 单页 master-detail，`?convId=` 深链，`storage.watch` 自动跟随
- 入口：设置页「开发者工具」组，`Entry.tabUrl` 分流，已开标签页则 `tabs.update` 导航 + 聚焦
- 降级：trace 裁剪后时间线只覆盖保留轮次，提示引导去看完整消息流

- [ ] **Step 4: 提交**

```bash
git add CLAUDE.md docs/history.md
git commit -m "docs(convdebug): 同步项目结构与迭代记录"
```

---

## 完成判据

全部任务完成后，以下命令必须全绿：

```bash
npm run compile && npm run test
```

手工验收（需 `npm run dev` 加载扩展）：

1. 侧边栏跑一轮对话（至少含一次工具调用），让 loop 真实跑起来。
2. 设置 → 开发者工具 → 「AI 会话调试」→ 新标签页打开，默认停在该会话。
3. 轮次时间线显示该轮，头部有耗时/LLM 耗时/token/工具数/outcome；展开可见上下文摘要与工具明细。
4. 切「原始消息流」，能看到完整消息序列。
5. 回到侧边栏再跑一轮 → 调试页自动跟随刷新（勾选框开启时）。
6. 刷新调试页 → `?convId=` 深链仍在，选中会话不丢。
7. 再点一次设置项 → 不新开标签页，而是聚焦并导航到当前会话。
