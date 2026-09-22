# 工具确认卡与三级确认策略 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** agent 工具调用获得会话流内确认卡（单卡双态）+ 三级确认策略（全部询问/仅敏感/自动放行），档位入口在选择器浮窗，选择器触发钮重构为「模式图标 + 权限状态」chip。

**Architecture:** 闸门在 `agent/loop.ts` 工具执行前（纯函数判定 `agent/permission.ts`），决策往返走 Port（下行 `tool-confirm` 事件 + 上行 `agent:confirm` 消息），待确认状态由 `background/agent-port.ts` 的 per-conv 确认槽持有并在 attach 时回放。卡片状态转移复用既有 `tool-start`/`tool-end` 事件。

**Tech Stack:** WXT + React 19 + TypeScript、Zustand、lucide-react、vitest v4 + jsdom。

**Spec:** `docs/superpowers/specs/2026-09-22-tool-confirm-and-permission-levels-design.md`（本计划从 spec 论证，执行者需同读两者）

## Global Constraints

- 样式全走 `entrypoints/sidepanel/styles.css`，只用 `:root` CSS 变量（`--signal`/`--signal-ink`/`--sunken`/`--warn`/`--ink-*`/`--line`/`--r-*`/`--t-fast`/`--ease` 等），禁止硬编码色值。
- 图标一律 lucide-react，禁止 emoji。
- vitest 单文件跑法：`npx vitest run <file>`；全量 `npm run test`；类型检查 `npm run compile`。
- 涉及 DOM 的组件测试文件头必须加 `// @vitest-environment jsdom`，并 `afterEach(cleanup)`。
- loop 合成的工具结果统一 `{ ok: false; error: string }` 形状（项目判别联合约定）。
- 提交信息格式：`type(scope): 中文摘要`（type ∈ feat/fix/test/docs/refactor）。
- 每个任务收尾跑一次 `npm run compile`，全绿再提交。

---

### Task 1: `agent/permission.ts` 分级判定模块

**Files:**
- Create: `agent/permission.ts`
- Test: `tests/agent/permission.test.ts`

**Interfaces:**
- Consumes: `ASK_MODE_TOOLS`、`MEMORY_WRITE_TOOLS`（`agent/mode.ts` 已有导出）。
- Produces（后续任务全部依赖，签名照抄）:
  - `export type ConfirmLevel = 'all' | 'sensitive' | 'auto'`
  - `export const SENSITIVE_TOOLS: ReadonlySet<string>`（12 个工具名）
  - `export const CONFIRM_TIMEOUT_MS = 120_000`
  - `export function needsConfirm(name: string, level: ConfirmLevel): boolean`

- [ ] **Step 1: 写失败测试**

`tests/agent/permission.test.ts` 全文：

```ts
// tests/agent/permission.test.ts
// 三级确认判定矩阵 + 工具归类完备性（spec §3）。
import { describe, it, expect } from 'vitest';
import { needsConfirm, SENSITIVE_TOOLS, CONFIRM_TIMEOUT_MS } from '../../agent/permission';
import { TOOL_SCHEMAS } from '../../agent/tools/schemas';

const LEVELS = ['all', 'sensitive', 'auto'] as const;

describe('needsConfirm 三档判定', () => {
  it('auto 档：什么都不问', () => {
    expect(needsConfirm('evaluate_script', 'auto')).toBe(false);
    expect(needsConfirm('click', 'auto')).toBe(false);
    expect(needsConfirm('take_snapshot', 'auto')).toBe(false);
  });

  it('只读堆任何档位都免确认', () => {
    for (const level of LEVELS) {
      expect(needsConfirm('take_snapshot', level)).toBe(false);
      expect(needsConfirm('memory_list', level)).toBe(false);
      expect(needsConfirm('load_skill', level)).toBe(false);
    }
  });

  it('sensitive 档：敏感集要问，微操集放行', () => {
    expect(needsConfirm('evaluate_script', 'sensitive')).toBe(true);
    expect(needsConfirm('http_request', 'sensitive')).toBe(true);
    expect(needsConfirm('navigate_page', 'sensitive')).toBe(true);
    expect(needsConfirm('new_page', 'sensitive')).toBe(true);
    expect(needsConfirm('delete_script', 'sensitive')).toBe(true);
    expect(needsConfirm('create_skill', 'sensitive')).toBe(true);
    expect(needsConfirm('click', 'sensitive')).toBe(false);
    expect(needsConfirm('fill', 'sensitive')).toBe(false);
    expect(needsConfirm('press_key', 'sensitive')).toBe(false);
    expect(needsConfirm('select_page', 'sensitive')).toBe(false);
    expect(needsConfirm('memory_write', 'sensitive')).toBe(false);
  });

  it('all 档：除只读外全部要问（含微操）', () => {
    expect(needsConfirm('click', 'all')).toBe(true);
    expect(needsConfirm('fill_form', 'all')).toBe(true);
    expect(needsConfirm('memory_delete', 'all')).toBe(true);
  });

  it('fail-safe：未分类工具在 sensitive 档默认要问', () => {
    expect(needsConfirm('some_future_tool', 'sensitive')).toBe(true);
  });

  it('超时常量 120s（面板倒计时与后台计时共用）', () => {
    expect(CONFIRM_TIMEOUT_MS).toBe(120_000);
  });
});

describe('工具归类完备性（spec §3：三堆覆盖全部分）', () => {
  it('TOOL_SCHEMAS 每个工具：all 档免确认 ⇒ 只读；sensitive 档免确认 ⇒ 微操；其余必须在敏感集', () => {
    expect(TOOL_SCHEMAS.length).toBeGreaterThan(30);
    for (const s of TOOL_SCHEMAS) {
      const name = s.function.name;
      const readonly = !needsConfirm(name, 'all');
      const microp = !readonly && !needsConfirm(name, 'sensitive');
      if (!readonly && !microp) {
        expect(SENSITIVE_TOOLS.has(name), `${name} 未归入敏感集`).toBe(true);
      }
    }
  });

  it('敏感集里没有幻影工具名', () => {
    for (const name of SENSITIVE_TOOLS) {
      expect(TOOL_SCHEMAS.some((s) => s.function.name === name), `${name} 不在 schema 里`).toBe(true);
    }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/agent/permission.test.ts`
Expected: FAIL（`Cannot find module '../../agent/permission'`）

- [ ] **Step 3: 实现 `agent/permission.ts`**

```ts
// agent/permission.ts
// 三级确认策略（spec §3）：auto（自动放行）/ sensitive（仅敏感）/ all（全部询问）。
// 判定是纯函数；闸门在 loop（spec §6），超时计时与决策往返在 background（spec §7）。
import { ASK_MODE_TOOLS, MEMORY_WRITE_TOOLS } from './mode';

export type ConfirmLevel = 'all' | 'sensitive' | 'auto';

/** 敏感集：任意 JS、跨域网络、导航/开闭标签页、脚本池与技能池写入（写入即代码未来会自动跑）。 */
export const SENSITIVE_TOOLS: ReadonlySet<string> = new Set([
  'evaluate_script', 'http_request', 'navigate_page', 'new_page', 'close_page',
  'create_script', 'update_script', 'delete_script', 'toggle_script',
  'create_skill', 'update_skill', 'delete_skill',
]);

/** 微操集：页面细节交互 + 扩展自己的笔记。只用作 sensitive 档的放行白名单（all 全问、auto 全放，不走这里）。 */
const MICROP_TOOLS: ReadonlySet<string> = new Set([
  'click', 'fill', 'fill_form', 'hover', 'scroll', 'press_key', 'select_page',
  'memory_write', 'memory_delete',
]);

/** 只读 = ask 白名单减记忆写（记忆写只动扩展自己的笔记，不算只读）。 */
function isReadonlyTool(name: string): boolean {
  return ASK_MODE_TOOLS.has(name) && !MEMORY_WRITE_TOOLS.has(name);
}

/** 确认等待上限。面板倒计时（until 时间戳）与后台超时计时共用同一常量。 */
export const CONFIRM_TIMEOUT_MS = 120_000;

/** 该工具在该档位下是否需要用户确认。
 *  fail-safe：未分类工具在 sensitive 档默认要问（漏登记的代价是多问一次，不是静默放行）。 */
export function needsConfirm(name: string, level: ConfirmLevel): boolean {
  if (level === 'auto') return false;
  if (isReadonlyTool(name)) return false;
  if (level === 'all') return true;
  return !MICROP_TOOLS.has(name);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/agent/permission.test.ts`
Expected: PASS（全部用例）

- [ ] **Step 5: 类型检查 + 提交**

Run: `npm run compile`
Expected: 无错误

```bash
git add agent/permission.ts tests/agent/permission.test.ts
git commit -m "feat(permission): 三级确认策略判定模块（敏感集/微操集/只读三堆划分）"
```

---

### Task 2: `settings.agent.confirmLevel` 字段

**Files:**
- Modify: `storage/settings.ts`
- Test: `tests/storage/settings.test.ts`

**Interfaces:**
- Consumes: `ConfirmLevel`（Task 1）。
- Produces: `AgentConfig.confirmLevel: ConfirmLevel`，默认 `'sensitive'`；`getSettings().agent.confirmLevel` 可读，`saveSettings({ agent: { confirmLevel } })` 可写（Task 6/8 依赖）。

- [ ] **Step 1: 更新既有测试 + 写失败测试**

`tests/storage/settings.test.ts` 有三处含 agent 段的全量 `toEqual` 断言，每处对象字面量补 `confirmLevel: 'sensitive'`：
- 44 行 `expect(s.agent).toEqual({ ... })`
- 50 行 `expect(raw).toEqual({ ... })`（持久化断言，agent 子对象内补）
- 71 行 `expect(s.agent).toEqual({ ... })`

再在 describe 内追加：

```ts
  it('confirmLevel 默认仅敏感，改档可回读', async () => {
    expect((await getSettings()).agent.confirmLevel).toBe('sensitive');
    await saveSettings({ agent: { confirmLevel: 'all' } });
    expect((await getSettings()).agent.confirmLevel).toBe('all');
    await saveSettings({ agent: { confirmLevel: 'auto' } });
    expect((await getSettings()).agent.confirmLevel).toBe('auto');
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/storage/settings.test.ts`
Expected: FAIL（新用例 `confirmLevel` 为 undefined；既有 toEqual 因字段缺失不匹配——若既有用例先跑且未更新也会红，这正是 Step 1 要同步改的原因）

- [ ] **Step 3: 实现**

`storage/settings.ts`：

```ts
import type { ConfirmLevel } from '../agent/permission';
```

`AgentConfig` 接口末尾加：

```ts
  /** 三级确认策略（spec §4）：all=全部询问 / sensitive=仅敏感 / auto=自动放行。每发工具现读，中途改档下一发生效。 */
  confirmLevel: ConfirmLevel;
```

`DEFAULT_SETTINGS.agent` 加：

```ts
    confirmLevel: 'sensitive',
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/storage/settings.test.ts`
Expected: PASS

- [ ] **Step 5: 类型检查 + 提交**

Run: `npm run compile`

```bash
git add storage/settings.ts tests/storage/settings.test.ts
git commit -m "feat(settings): agent.confirmLevel 三档确认策略字段，默认仅敏感"
```

---

### Task 3: 协议事件 + trace 字段 + 尾巴清空

**Files:**
- Modify: `shared/messages.ts`（AgentEvent 联合、PortMsgFromPanel 联合）
- Modify: `storage/traces.ts:31-39`（TurnToolRecord）
- Modify: `background/agent-tail.ts`（reduceTail）
- Test: `tests/background/agent-tail.test.ts`

**Interfaces:**
- Produces（Task 4-7 依赖，逐字使用）:
  - 事件：`{ type: 'tool-confirm'; callId: string; name: string; args: string; until: number }`
  - 上行消息：`{ type: 'agent:confirm'; convId: string; callId: string; decision: 'allow' | 'allow-session' | 'deny' }`
  - `TurnToolRecord` 新可选字段：`confirm?: 'allow' | 'allow-session' | 'deny' | 'timeout'`、`confirmMs?: number`

- [ ] **Step 1: 写失败测试（尾巴清空是本任务唯一有行为的点）**

`tests/background/agent-tail.test.ts` 追加用例（沿用该文件既有 import）：

```ts
it('tool-confirm 清空尾巴：确认等待横跨重挂载时不回放陈旧文本（assistant 已落库）', () => {
  let tail = reduceTail(emptyTail(), { type: 'text-delta', text: '半句' });
  tail = reduceTail(tail, { type: 'tool-confirm', callId: 'c1', name: 'x', args: '{}', until: 1 });
  expect(tail).toEqual(emptyTail());
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/background/agent-tail.test.ts`
Expected: FAIL（reduceTail 走 default 分支，tail 不变）

- [ ] **Step 3: 实现三处类型 + 尾巴分支**

`shared/messages.ts` AgentEvent 联合，在 `tool-start` 一行后插入：

```ts
  /** 工具调用待用户确认（三级确认策略 spec §5-6）：卡片以 confirm 态呈现；
   *  until = 截止绝对时间戳（跨面板重挂载倒计时连续）。args 为模型原始参数串（未解析）。 */
  | { type: 'tool-confirm'; callId: string; name: string; args: string; until: number }
```

`PortMsgFromPanel` 联合，`agent:setMode` 一支后追加：

```ts
  /** 确认卡决策回传：allow-session = 本会话此工具不再问（记名动作在 loop）。 */
  | { type: 'agent:confirm'; convId: string; callId: string; decision: 'allow' | 'allow-session' | 'deny' }
```

`storage/traces.ts` TurnToolRecord（`ms` 与 `summary` 之间）加：

```ts
  /** 确认决策（走确认闸门的调用才有）。 */
  confirm?: 'allow' | 'allow-session' | 'deny' | 'timeout';
  /** 决策等待时长 ms（含人思考的时间）。deny 时 ms 恒为 0（未执行），耗时看这里。 */
  confirmMs?: number;
```

`background/agent-tail.ts` reduceTail 的 switch，`case 'tool-start':` 行改为：

```ts
    case 'tool-start':
    case 'tool-confirm':
      // tool-confirm 与 tool-start 同界：assistant 消息此前必已 appendMessage，
      // 文本尾巴作废（确认等待可能长达 120s，不清会在重挂载时回放出重复段落）。
```

（即 tool-confirm 落入与 tool-start 相同的 `return emptyTail()` 分支，其余 case 不动。）

- [ ] **Step 4: 跑测试确认通过 + 类型检查**

Run: `npx vitest run tests/background/agent-tail.test.ts && npm run compile`
Expected: PASS；类型无错误

- [ ] **Step 5: 提交**

```bash
git add shared/messages.ts storage/traces.ts background/agent-tail.ts tests/background/agent-tail.test.ts
git commit -m "feat(protocol): tool-confirm 事件、agent:confirm 上行消息、trace 确认字段、尾巴清空"
```

---

### Task 4: chat store 的 confirm 卡状态机

**Files:**
- Modify: `stores/chat.ts`
- Test: `tests/stores/chat.test.ts`

**Interfaces:**
- Consumes: `tool-confirm` 事件（Task 3）。
- Produces: `ChatItem.status` 扩为 `'running' | 'done' | 'confirm'`；`ChatItem.confirmUntil?: number`；`applyEvent` 接受 `tool-confirm`。Task 7 的 ChatView 渲染依赖这两个字段名。

- [ ] **Step 1: 写失败测试**

`tests/stores/chat.test.ts` 追加（该文件已 import `ChatMessage` type；新用例用到则补 `import type { ChatMessage } from '../../agent/provider/types';`——已有则跳过）：

```ts
  it('tool-confirm 建确认卡（confirm 态 + 截止时间戳）', () => {
    useChat.getState().applyEvent({ type: 'tool-confirm', callId: 'c9', name: 'evaluate_script', args: '{"function":"1+1"}', until: 123456 });
    const tool = useChat.getState().messages.find((m) => m.role === 'tool');
    expect(tool).toMatchObject({ name: 'evaluate_script', status: 'confirm', confirmUntil: 123456, args: '{"function":"1+1"}' });
  });

  it('tool-confirm 幂等：翻转既有 running 卡而不建新卡（attach 回放场景）', () => {
    useChat.getState().loadFromStorage([
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'click', arguments: '{}' }] },
    ] as ChatMessage[]);
    expect(useChat.getState().messages.find((m) => m.role === 'tool')?.status).toBe('running');
    useChat.getState().applyEvent({ type: 'tool-confirm', callId: 'c1', name: 'click', args: '{}', until: 1 });
    const tools = useChat.getState().messages.filter((m) => m.role === 'tool' && m.callId === 'c1');
    expect(tools).toHaveLength(1);
    expect(tools[0]!.status).toBe('confirm');
  });

  it('tool-confirm 清空 argsProgress 并收起思考块', () => {
    useChat.getState().applyEvent({ type: 'reasoning-delta', text: '想' });
    useChat.getState().applyEvent({ type: 'tool-args-delta', name: 'x', bytes: 10 });
    useChat.getState().applyEvent({ type: 'tool-confirm', callId: 'c1', name: 'x', args: '{}', until: 1 });
    expect(useChat.getState().argsProgress).toBeUndefined();
    expect(useChat.getState().messages[0]).toMatchObject({ thinking: false });
  });

  it('tool-start 把 confirm 卡翻回 running（用户批准放行）', () => {
    useChat.getState().applyEvent({ type: 'tool-confirm', callId: 'c1', name: 'x', args: '{}', until: 1 });
    useChat.getState().applyEvent({ type: 'tool-start', name: 'x', args: '{}', callId: 'c1' });
    expect(useChat.getState().messages.find((m) => m.role === 'tool')?.status).toBe('running');
  });

  it('tool-end 直接终结 confirm 卡（拒绝/超时路径，中间没有 tool-start）', () => {
    useChat.getState().applyEvent({ type: 'tool-confirm', callId: 'c1', name: 'x', args: '{}', until: 1 });
    useChat.getState().applyEvent({ type: 'tool-end', name: 'x', callId: 'c1', ok: false, summary: '已拒绝' });
    const tool = useChat.getState().messages.find((m) => m.role === 'tool');
    expect(tool).toMatchObject({ status: 'done', ok: false, summary: '已拒绝' });
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/stores/chat.test.ts`
Expected: 新增用例 FAIL（store 无 tool-confirm 分支，default 返回空）

- [ ] **Step 3: 实现**

`stores/chat.ts`：

`ChatItem` 的 `status` 字段行改为，并新增 `confirmUntil`：

```ts
  status?: 'running' | 'done' | 'confirm'; ok?: boolean; summary?: string;
  confirmUntil?: number;       // confirm 态的确认截止绝对时间戳（ms）
```

`applyEvent` 里 `case 'tool-start':` 整支替换为：

```ts
      case 'tool-start': {
        collapseTrailingThinking(messages);
        const idx = messages.findIndex((m) => m.role === 'tool' && m.callId === e.callId);
        if (idx >= 0) {
          // 幂等；confirm 态卡（用户批准放行）翻回运行态
          if (messages[idx]!.status === 'confirm') {
            messages[idx] = { ...messages[idx]!, status: 'running' };
          }
          return { messages, argsProgress: undefined };
        }
        messages.push({ role: 'tool', name: e.name, args: e.args, callId: e.callId, status: 'running' });
        return { messages, argsProgress: undefined };
      }
      case 'tool-confirm': {
        collapseTrailingThinking(messages);
        const idx = messages.findIndex((m) => m.role === 'tool' && m.callId === e.callId);
        if (idx >= 0) {
          // 幂等：attach 回放/重复事件翻转既有卡（loadFromStorage 把无结果调用渲染成 running）
          messages[idx] = { ...messages[idx]!, status: 'confirm', confirmUntil: e.until };
        } else {
          messages.push({ role: 'tool', name: e.name, args: e.args, callId: e.callId, status: 'confirm', confirmUntil: e.until });
        }
        return { messages, argsProgress: undefined };
      }
```

（`case 'tool-end'` 不动——它按 callId 原位终结，天然覆盖「confirm 态直接 done」。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/stores/chat.test.ts tests/chat/args-progress.test.ts`
Expected: PASS（含既有幂等用例不回归）

- [ ] **Step 5: 类型检查 + 提交**

Run: `npm run compile`

```bash
git add stores/chat.ts tests/stores/chat.test.ts
git commit -m "feat(chat-store): 工具确认卡状态机（confirm 态建卡/翻转/直接终结）"
```

---

### Task 5: loop 确认闸门

**Files:**
- Modify: `agent/loop.ts`
- Test: `tests/agent/loop.test.ts`

**Interfaces:**
- Consumes: `needsConfirm`/`CONFIRM_TIMEOUT_MS`/`ConfirmLevel`（Task 1）、`tool-confirm` 事件（Task 3）、`TurnToolRecord.confirm/confirmMs`（Task 3）。
- Produces（Task 6 依赖）:
  - `LoopDeps.getConfirmLevel?: () => Promise<ConfirmLevel>`
  - `LoopDeps.confirmToolCall?: (req: { callId: string; name: string; args: Record<string, unknown>; rawArgs: string }, signal: AbortSignal) => Promise<'allow' | 'allow-session' | 'deny' | 'timeout'>`
  - rawArgs = 模型原始参数串（`tc.arguments ?? ''`），供后台构建与 tool-confirm 事件完全一致的回放数据。
  - 语义约定：`confirmToolCall` 缺省 = 整个闸门不存在（旧行为）；`getConfirmLevel` 缺省回落 `'sensitive'`。

- [ ] **Step 1: 写失败测试**

`tests/agent/loop.test.ts` 追加（复用文件顶部的 `queuedProvider` 与 `deps` 助手）：

```ts
  // ---- 三级确认闸门（spec §6）----

  const toolScript = (name: string, args: string): StreamEvent[][] => [[
    { type: 'tool-call-delta', index: 0, id: 'tc1', name, argsDelta: args },
    { type: 'message-done', finishReason: 'tool_calls' },
  ]];

  it('敏感工具先 emit tool-confirm，allow 后才 tool-start 并执行', async () => {
    const provider = queuedProvider([
      ...toolScript('evaluate_script', '{"function":"1+1"}'),
      [{ type: 'message-done', finishReason: 'stop' }],
    ]);
    const exec = vi.fn<LoopDeps['executeTool']>().mockResolvedValue({ ok: true, data: {} } as ToolResult);
    const confirmToolCall = vi.fn().mockResolvedValue('allow');
    const d = deps(provider, exec, { confirmToolCall, getConfirmLevel: async () => 'sensitive' });
    await runAgentLoop({ convId: 'cf1', tabId: 1, userMessage: 'x' }, d);
    expect(confirmToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ callId: 'tc1', name: 'evaluate_script' }),
      expect.any(AbortSignal),
    );
    const order = d.emit.mock.calls.map((c) => (c[0] as { type: string }).type);
    expect(order).toContain('tool-confirm');
    expect(order.indexOf('tool-confirm')).toBeLessThan(order.indexOf('tool-start'));
    expect(exec).toHaveBeenCalledOnce();
  });

  it('deny：不执行工具，tool 消息告知模型被拒，拒绝计入结果（熔断阀可见失败）', async () => {
    const provider = queuedProvider([
      ...toolScript('evaluate_script', '{}'),
      [{ type: 'message-done', finishReason: 'stop' }],
    ]);
    const exec = vi.fn<LoopDeps['executeTool']>().mockResolvedValue({ ok: true } as ToolResult);
    const d = deps(provider, exec, {
      confirmToolCall: async () => 'deny',
      getConfirmLevel: async () => 'sensitive',
    });
    await runAgentLoop({ convId: 'cf2', tabId: 2, userMessage: 'x' }, d);
    expect(exec).not.toHaveBeenCalled();
    const conv = await getConversation('cf2');
    const toolMsg = conv.messages.find((m) => m.role === 'tool')!;
    expect(String(toolMsg.content)).toContain('拒绝');
    expect(d.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'tool-end', ok: false, summary: '已拒绝' }));
    expect(conv.status).toBe('idle'); // 循环继续到自然终止
  });

  it('timeout：文案不同（超时未确认）', async () => {
    const provider = queuedProvider([
      ...toolScript('http_request', '{}'),
      [{ type: 'message-done', finishReason: 'stop' }],
    ]);
    const d = deps(provider, vi.fn<LoopDeps['executeTool']>(), {
      confirmToolCall: async () => 'timeout',
      getConfirmLevel: async () => 'sensitive',
    });
    await runAgentLoop({ convId: 'cf3', tabId: 3, userMessage: 'x' }, d);
    const conv = await getConversation('cf3');
    const toolMsg = conv.messages.find((m) => m.role === 'tool')!;
    expect(String(toolMsg.content)).toContain('超时');
    expect(d.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'tool-end', ok: false, summary: '确认超时' }));
  });

  it('allow-session：同工具第二发不再询问', async () => {
    const provider = queuedProvider([
      ...toolScript('evaluate_script', '{"n":1}'),
      ...toolScript('evaluate_script', '{"n":2}'),
      [{ type: 'message-done', finishReason: 'stop' }],
    ]);
    const exec = vi.fn<LoopDeps['executeTool']>().mockResolvedValue({ ok: true } as ToolResult);
    const d = deps(provider, exec, {
      confirmToolCall: async () => 'allow-session',
      getConfirmLevel: async () => 'sensitive',
    });
    await runAgentLoop({ convId: 'cf4', tabId: 4, userMessage: 'x' }, d);
    expect(d.emit.mock.calls.filter((c) => (c[0] as { type: string }).type === 'tool-confirm')).toHaveLength(1);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('sensitive 档微操不询问；all 档微操要问；confirmToolCall 缺省完全不问', async () => {
    // sensitive + click → 直接执行
    const p1 = queuedProvider([...toolScript('click', '{}'), [{ type: 'message-done', finishReason: 'stop' }]]);
    const confirmToolCall = vi.fn().mockResolvedValue('allow');
    const exec1 = vi.fn<LoopDeps['executeTool']>().mockResolvedValue({ ok: true } as ToolResult);
    await runAgentLoop({ convId: 'cf5', tabId: 5, userMessage: 'x' }, deps(p1, exec1, { confirmToolCall, getConfirmLevel: async () => 'sensitive' }));
    expect(confirmToolCall).not.toHaveBeenCalled();
    expect(exec1).toHaveBeenCalledOnce();
    // all + click → 要问
    const p2 = queuedProvider([...toolScript('click', '{}'), [{ type: 'message-done', finishReason: 'stop' }]]);
    const confirmToolCall2 = vi.fn().mockResolvedValue('allow');
    const exec2 = vi.fn<LoopDeps['executeTool']>().mockResolvedValue({ ok: true } as ToolResult);
    await runAgentLoop({ convId: 'cf6', tabId: 6, userMessage: 'x' }, deps(p2, exec2, { confirmToolCall: confirmToolCall2, getConfirmLevel: async () => 'all' }));
    expect(confirmToolCall2).toHaveBeenCalledOnce();
    // 旧行为：无 confirmToolCall 时不问
    const p3 = queuedProvider([...toolScript('evaluate_script', '{}'), [{ type: 'message-done', finishReason: 'stop' }]]);
    const exec3 = vi.fn<LoopDeps['executeTool']>().mockResolvedValue({ ok: true } as ToolResult);
    await runAgentLoop({ convId: 'cf7', tabId: 7, userMessage: 'x' }, deps(p3, exec3));
    expect(exec3).toHaveBeenCalledOnce();
  });

  it('confirm 等待中 abort → 拒绝落卡，loop 干净退出', async () => {
    const ac = new AbortController();
    const provider: Provider = {
      streamChat(_p, onEvent) {
        queueMicrotask(() => { for (const e of toolScript('evaluate_script', '{}')[0]!) onEvent(e); });
        return { cancel: vi.fn() };
      },
    };
    const exec = vi.fn<LoopDeps['executeTool']>().mockResolvedValue({ ok: true } as ToolResult);
    const d = deps(provider, exec, {
      confirmToolCall: async (_req, sig) => { ac.abort(); await 0; return sig.aborted ? 'deny' : 'allow'; },
      getConfirmLevel: async () => 'sensitive',
    });
    await runAgentLoop({ convId: 'cf8', tabId: 8, userMessage: 'x' }, d, ac.signal);
    expect(exec).not.toHaveBeenCalled();
    expect((await getConversation('cf8')).status).toBe('idle');
    expect(d.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'done' }));
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/agent/loop.test.ts`
Expected: 新增用例 FAIL（LoopDeps 无 confirmToolCall 字段 → 类型错误/用例红）

- [ ] **Step 3: 实现**

`agent/loop.ts` 三处修改：

① import 区加：

```ts
import { needsConfirm, CONFIRM_TIMEOUT_MS, type ConfirmLevel } from './permission';
```

② `LoopDeps` 接口（`getMemoryState` 之后）加：

```ts
  /** 三级确认策略档位：每发工具现读（中途改档下一发生效）。缺省回落 'sensitive'。仅在提供 confirmToolCall 时生效。 */
  getConfirmLevel?: () => Promise<ConfirmLevel>;
  /** 确认闸门：emit tool-confirm 后等决策。'deny'/'timeout' 由 loop 落拒绝终态；缺省 = 不设闸（旧行为，测试/调试链路零改动）。 */
  confirmToolCall?: (
    req: { callId: string; name: string; args: Record<string, unknown>; rawArgs: string },
    signal: AbortSignal,
  ) => Promise<'allow' | 'allow-session' | 'deny' | 'timeout'>;
```

③ `drive()` 内，`let lastPromptTokens` 声明后加一行：

```ts
  const sessionAllowed = new Set<string>(); // 「本次会话总是允许」记名：随 loop 生灭，不落库（spec 决策 #8）
```

④ 工具执行段（`for (const tc of result.toolCalls)` 内）——把现有：

```ts
        let toolArgs: Record<string, unknown> = {};
        try { toolArgs = tc.arguments ? JSON.parse(tc.arguments) : {}; } catch { /* 保持空对象 */ }
        deps.emit({ type: 'tool-start', name: tc.name, args: tc.arguments, callId: tc.id });
        const toolAt = Date.now();
        const argsBytes = tc.arguments?.length ?? 0;
        const r = await deps.executeTool(tc.name, toolArgs, targetTab, signal);
```

替换为：

```ts
        let toolArgs: Record<string, unknown> = {};
        try { toolArgs = tc.arguments ? JSON.parse(tc.arguments) : {}; } catch { /* 保持空对象 */ }
        const argsBytes = tc.arguments?.length ?? 0;

        // ---- 三级确认闸门（spec §6）：先询问后执行；决策后才 emit tool-start ----
        let confirmInfo: { confirm: 'allow' | 'allow-session' | 'deny' | 'timeout'; confirmMs: number } | undefined;
        if (
          deps.confirmToolCall
          && !sessionAllowed.has(tc.name)
          && needsConfirm(tc.name, (await deps.getConfirmLevel?.()) ?? 'sensitive')
        ) {
          const confirmAt = Date.now();
          deps.emit({ type: 'tool-confirm', callId: tc.id, name: tc.name, args: tc.arguments ?? '', until: confirmAt + CONFIRM_TIMEOUT_MS });
          const verdict = await deps.confirmToolCall({ callId: tc.id, name: tc.name, args: toolArgs, rawArgs: tc.arguments ?? '' }, signal);
          const confirmMs = Date.now() - confirmAt;
          if (verdict === 'deny' || verdict === 'timeout') {
            const summary = verdict === 'deny' ? '已拒绝' : '确认超时';
            const content = verdict === 'deny'
              ? `用户拒绝了该操作（${tc.name}）。不要原样重试；向用户说明情况或提出替代方案。`
              : `确认超时（120 秒无响应），已自动取消 ${tc.name}。可继续其他操作，或询问用户。`;
            deps.emit({ type: 'tool-end', name: tc.name, callId: tc.id, ok: false, summary });
            tr.markTool({ name: tc.name, callId: tc.id, argsBytes, ms: 0, ok: false, error: summary, summary, confirm: verdict, confirmMs });
            await appendMessage(convId, { role: 'tool', toolCallId: tc.id, name: tc.name, content });
            results.push({ ok: false, error: summary }); // 拒绝计入熔断阀失败统计（spec 决策 #13）
            continue;
          }
          if (verdict === 'allow-session') sessionAllowed.add(tc.name);
          confirmInfo = { confirm: verdict, confirmMs };
        }

        deps.emit({ type: 'tool-start', name: tc.name, args: tc.arguments, callId: tc.id });
        const toolAt = Date.now();
        const r = await deps.executeTool(tc.name, toolArgs, targetTab, signal);
```

⑤ 默认路径的 `tr.markTool`（带 `summary` 的那处，screenshot/load_skill 两个早 continue 分支不必改——只读工具永远不会被闸）加一字段展开：

```ts
          ...(confirmInfo ?? {}),
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/agent/loop.test.ts tests/agent/permission.test.ts`
Expected: PASS（既有 loop 用例全部不回归——它们没传 confirmToolCall，闸门不存在）

- [ ] **Step 5: 类型检查 + 提交**

Run: `npm run compile`

```bash
git add agent/loop.ts tests/agent/loop.test.ts
git commit -m "feat(loop): 工具调用三级确认闸门（询问后执行，deny/timeout 落拒绝终态）"
```

---

### Task 6: 后台确认槽 + Port 接线 + attach 回放

**Files:**
- Modify: `background/agent-port.ts`
- Test: `tests/background/agent-confirm.test.ts`（新建）

**Interfaces:**
- Consumes: Task 5 的 `LoopDeps.confirmToolCall`/`getConfirmLevel` 签名、Task 3 的 `tool-confirm` 事件、Task 1 的 `CONFIRM_TIMEOUT_MS`。
- Produces（模块导出，测试用）:
  - `registerToolConfirm(convId: string, entry: { callId: string; name: string; args: string }, signal: AbortSignal): Promise<'allow' | 'allow-session' | 'deny' | 'timeout'>`
  - `resolveToolConfirm(convId: string, callId: string, decision: 'allow' | 'allow-session' | 'deny'): void`
  - `discardToolConfirm(convId: string): void`
  - `__resetToolConfirms(): void`（仅测试用）
  - `buildAttachEvents` 行为扩展：running 且有 pending 时，事件序列末尾追加 tool-confirm。

- [ ] **Step 1: 写失败测试**

`tests/background/agent-confirm.test.ts` 全文：

```ts
// tests/background/agent-confirm.test.ts
// 后台确认槽：登记/决策/超时/中断 + attach 回放（spec §7）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  registerToolConfirm, resolveToolConfirm, discardToolConfirm,
  __resetToolConfirms, buildAttachEvents,
} from '../../background/agent-port';
import { emptyTail } from '../../background/agent-tail';

const ENTRY = { callId: 'call-1', name: 'evaluate_script', args: '{"function":"1+1"}' };

beforeEach(() => {
  fakeBrowser.reset();
  __resetToolConfirms();
});
afterEach(() => vi.useRealTimers());

describe('registerToolConfirm', () => {
  it('决策回传 resolve 并清槽', async () => {
    const ac = new AbortController();
    const p = registerToolConfirm('cv1', ENTRY, ac.signal);
    resolveToolConfirm('cv1', 'call-1', 'allow-session');
    await expect(p).resolves.toBe('allow-session');
  });

  it('callId 不匹配不 resolve（防陈旧确认串轮）', async () => {
    vi.useFakeTimers();
    const ac = new AbortController();
    const p = registerToolConfirm('cv2', ENTRY, ac.signal);
    resolveToolConfirm('cv2', 'other-call', 'allow');
    vi.advanceTimersByTime(120_000);
    await expect(p).resolves.toBe('timeout'); // 只能等超时兜底
  });

  it('120s 超时 resolve timeout', async () => {
    vi.useFakeTimers();
    const ac = new AbortController();
    const p = registerToolConfirm('cv3', ENTRY, ac.signal);
    vi.advanceTimersByTime(120_000);
    await expect(p).resolves.toBe('timeout');
  });

  it('abort resolve deny（停止键/loop 退出路径）', async () => {
    const ac = new AbortController();
    const p = registerToolConfirm('cv4', ENTRY, ac.signal);
    ac.abort();
    await expect(p).resolves.toBe('deny');
  });

  it('discardToolConfirm 兜底清理（loop finally）', async () => {
    const ac = new AbortController();
    const p = registerToolConfirm('cv5', ENTRY, ac.signal);
    discardToolConfirm('cv5');
    await expect(p).resolves.toBe('deny');
    discardToolConfirm('cv5'); // 幂等
  });
});

describe('buildAttachEvents 回放待确认状态', () => {
  it('running 且有 pending：事件序列末尾追加 tool-confirm', async () => {
    const ac = new AbortController();
    const p = registerToolConfirm('cv6', ENTRY, ac.signal);
    const events = await buildAttachEvents('cv6', true, emptyTail());
    const last = events.at(-1)!;
    expect(last).toMatchObject({ type: 'tool-confirm', callId: 'call-1', name: 'evaluate_script' });
    expect((last as { until?: number }).until).toBeGreaterThan(0);
    resolveToolConfirm('cv6', 'call-1', 'deny');
    await p;
  });

  it('无 pending：事件里没有 tool-confirm', async () => {
    const events = await buildAttachEvents('cv7', true, emptyTail());
    expect(events.some((e) => e.type === 'tool-confirm')).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/background/agent-confirm.test.ts`
Expected: FAIL（导出不存在）

- [ ] **Step 3: 实现**

`background/agent-port.ts`：

① import 区加：

```ts
import { CONFIRM_TIMEOUT_MS } from '../agent/permission';
```

（`getSettings` 已有 import。）

② 模块级确认槽（`convModeRef` 声明附近）：

```ts
// ---------- 三级确认槽（spec §7）：per-conv 单槽（单 conv 单 loop，loop 内逐个 await） ----------
type ConfirmVerdict = 'allow' | 'allow-session' | 'deny' | 'timeout';

interface PendingConfirm {
  callId: string;
  name: string;
  args: string;
  until: number;
  resolve: (d: ConfirmVerdict) => void;
}
const pendingConfirms = new Map<string, PendingConfirm>();

/** 登记待确认项并等决策：120s 超时 → 'timeout'；abort → 'deny'；agent:confirm 消息经 resolveToolConfirm 回传。 */
export function registerToolConfirm(
  convId: string,
  entry: { callId: string; name: string; args: string },
  signal: AbortSignal,
): Promise<ConfirmVerdict> {
  return new Promise((resolve) => {
    let settled = false;
    const until = Date.now() + CONFIRM_TIMEOUT_MS;
    const finish = (d: ConfirmVerdict) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (pendingConfirms.get(convId)?.callId === entry.callId) pendingConfirms.delete(convId);
      resolve(d);
    };
    const timer = setTimeout(() => finish('timeout'), CONFIRM_TIMEOUT_MS);
    const onAbort = () => finish('deny');
    signal.addEventListener('abort', onAbort);
    pendingConfirms.set(convId, { ...entry, until, resolve: finish });
  });
}

/** agent:confirm 消息入口：callId 一致才 resolve（防陈旧确认串轮），否则空操作（幂等）。 */
export function resolveToolConfirm(convId: string, callId: string, decision: 'allow' | 'allow-session' | 'deny'): void {
  pendingConfirms.get(convId)?.resolve(decision);
}

/** loop 结束的兜底清理：槽里还挂着就强制 resolve（理论上 abort 已收口，这里防悬挂）。 */
export function discardToolConfirm(convId: string): void {
  const p = pendingConfirms.get(convId);
  if (!p) return;
  pendingConfirms.delete(convId);
  p.resolve('deny');
}

/** 仅测试用。 */
export function __resetToolConfirms(): void {
  for (const p of pendingConfirms.values()) p.resolve('deny');
  pendingConfirms.clear();
}
```

③ `makeDeps` 返回对象加两个 dep（`getMemoryState` 之后）：

```ts
    getConfirmLevel: async () => (await getSettings()).agent.confirmLevel,
    confirmToolCall: (req, signal) =>
      registerToolConfirm(convId, { callId: req.callId, name: req.name, args: req.rawArgs }, signal),
```

④ `attachAgentPort` 的 onMessage 里，`agent:compact` 分支之后加：

```ts
      // 确认卡决策回传：查槽 resolve（callId 不匹配/已超时清槽 = 空操作）
      if (msg.type === 'agent:confirm') {
        resolveToolConfirm(msg.convId, msg.callId, msg.decision);
        return;
      }
```

⑤ start/resume 的 `finally`（`tails.delete` 之后）加：

```ts
        discardToolConfirm(msg.convId);
```

⑥ `buildAttachEvents` 的 running 分支改为：

```ts
  if (running) {
    const events: AgentEvent[] = [
      modeEvent,
      { type: 'state', status: 'running', messageCount: conv.messages.length },
      ...replayTail(tail),
    ];
    // 待确认状态跨面板重挂载：放序列末尾，让它赢下同帧的 argsProgress 清理
    const pending = pendingConfirms.get(convId);
    if (pending) {
      events.push({ type: 'tool-confirm', callId: pending.callId, name: pending.name, args: pending.args, until: pending.until });
    }
    return events;
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/background/agent-confirm.test.ts tests/background/agent-tail.test.ts`
Expected: PASS

- [ ] **Step 5: 类型检查 + 提交**

Run: `npm run compile`

```bash
git add background/agent-port.ts tests/background/agent-confirm.test.ts
git commit -m "feat(agent-port): 后台确认槽（120s 超时/abort 收口）+ agent:confirm 接线 + attach 回放"
```

---

### Task 7: ToolConfirmCard 组件 + ChatView 集成 + 样式

**Files:**
- Create: `components/chat/ToolConfirmCard.tsx`
- Modify: `components/chat/ChatView.tsx`（MessageRow + ChatView）
- Modify: `entrypoints/sidepanel/styles.css`（`.toolconfirm` 系列，插在 行为模式下拉 注释块之前）
- Test: `tests/ui/tool-confirm-card.test.tsx`（新建）、`tests/ui/chat-confirm.test.tsx`（新建）

**Interfaces:**
- Consumes: Task 1 `SENSITIVE_TOOLS`；Task 4 的 `ChatItem.status==='confirm'`/`confirmUntil`；Task 3 的 `agent:confirm` 消息；现有 `components/ui/Button`（variant: 'primary' | 'secondary' | 'signal' | 'danger' | 'ghost'）。
- Produces: `ToolConfirmCard` props `{ name: string; args?: string; until: number; disabled?: boolean; onDecide: (decision: ConfirmDecision) => void }`，`export type ConfirmDecision = 'allow' | 'allow-session' | 'deny'`。

- [ ] **Step 1: 写组件失败测试**

`tests/ui/tool-confirm-card.test.tsx` 全文：

```tsx
// tests/ui/tool-confirm-card.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { ToolConfirmCard } from '../../components/chat/ToolConfirmCard';

afterEach(cleanup);

const FUTURE = Date.now() + 120_000;

describe('ToolConfirmCard', () => {
  it('渲染工具名、敏感风险标签与三按钮', () => {
    render(<ToolConfirmCard name="evaluate_script" args="{}" until={FUTURE} onDecide={() => {}} />);
    expect(screen.getByRole('alertdialog', { name: /evaluate_script/ })).toBeInTheDocument();
    expect(screen.getByText('敏感')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '允许执行' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '本次会话总是允许' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '拒绝' })).toBeInTheDocument();
  });

  it('微操工具标签为写入', () => {
    render(<ToolConfirmCard name="fill" args="{}" until={FUTURE} onDecide={() => {}} />);
    expect(screen.getByText('写入')).toBeInTheDocument();
  });

  it('点击决策回传并锁定全部按钮（防双击）', () => {
    const onDecide = vi.fn();
    render(<ToolConfirmCard name="evaluate_script" args="{}" until={FUTURE} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole('button', { name: '拒绝' }));
    expect(onDecide).toHaveBeenCalledWith('deny');
    expect(screen.getByRole('button', { name: '允许执行' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '本次会话总是允许' })).toBeDisabled();
  });

  it('截止时间已过显示已超时（本地不做决策，权威收尾来自后台）', () => {
    render(<ToolConfirmCard name="x" args="{}" until={Date.now() - 1000} onDecide={() => {}} />);
    expect(screen.getByText('已超时')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/ui/tool-confirm-card.test.tsx`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 ToolConfirmCard**

`components/chat/ToolConfirmCard.tsx` 全文：

```tsx
// components/chat/ToolConfirmCard.tsx
// 会话流内工具确认卡（spec §8.2）：单卡双态的「待确认」态。决策后由 tool-start/tool-end
// 事件权威翻转；本组件不持有决策权威，点击即发消息并本地锁定防双击。倒计时归零只显示状态。
import { useEffect, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { Button } from '../ui/Button';
import { SENSITIVE_TOOLS } from '../../agent/permission';

export type ConfirmDecision = 'allow' | 'allow-session' | 'deny';

function secondsLeft(until: number): number {
  return Math.max(0, Math.ceil((until - Date.now()) / 1000));
}

export function ToolConfirmCard({ name, args, until, disabled, onDecide }: {
  name: string;
  args?: string;
  until: number;
  disabled?: boolean;
  onDecide: (decision: ConfirmDecision) => void;
}) {
  const [left, setLeft] = useState(() => secondsLeft(until));
  useEffect(() => {
    const t = setInterval(() => setLeft(secondsLeft(until)), 1000);
    return () => clearInterval(t);
  }, [until]);
  const [decided, setDecided] = useState(false);
  const lock = disabled || decided;

  return (
    <div className="toolconfirm" role="alertdialog" aria-label={`工具确认：${name}`}>
      <div className="toolconfirm__head">
        <ShieldAlert size={14} aria-hidden />
        <span className="mono toolconfirm__name">{name}</span>
        <span className="token toolconfirm__risk">{SENSITIVE_TOOLS.has(name) ? '敏感' : '写入'}</span>
        <span className="mono toolconfirm__left">{left > 0 ? `${left}s` : '已超时'}</span>
      </div>
      {args && <div className="well toolconfirm__args">{args}</div>}
      <div className="toolconfirm__actions">
        <Button variant="primary" disabled={lock} onClick={() => { setDecided(true); onDecide('allow'); }}>允许执行</Button>
        <Button disabled={lock} onClick={() => { setDecided(true); onDecide('allow-session'); }}>本次会话总是允许</Button>
        <Button variant="danger" disabled={lock} onClick={() => { setDecided(true); onDecide('deny'); }}>拒绝</Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 跑组件测试确认通过**

Run: `npx vitest run tests/ui/tool-confirm-card.test.tsx`
Expected: PASS

- [ ] **Step 5: 写 ChatView 集成失败测试**

`tests/ui/chat-confirm.test.tsx` 全文（沿用 chat-hello.test.tsx 的 mock 手法）：

```tsx
// tests/ui/chat-confirm.test.tsx
// ChatView 接线：tool-confirm 事件渲染确认卡，决策经 postToAgent 发 agent:confirm。
// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { ChatView } from '../../components/chat/ChatView';
import { useChat } from '../../stores/chat';
import { useConversations } from '../../stores/conversations';
import { useSkills } from '../../stores/skills';
import { postToAgent } from '../../stores/agent-port-client';

afterEach(cleanup);

vi.mock('../../stores/agent-port-client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  attachConv: vi.fn(() => false),
  postToAgent: vi.fn(() => true),
}));

beforeEach(() => {
  fakeBrowser.reset();
  vi.clearAllMocks();
  useChat.setState({ messages: [], status: 'idle', promptTokens: 0, compacting: false } as never);
  useConversations.setState({ currentId: 'conv-1', list: [], menuOpen: false } as never);
  useSkills.setState({ list: [], loading: false });
});

describe('ChatView 工具确认卡接线', () => {
  it('tool-confirm 事件渲染确认卡，点击允许发出 agent:confirm', async () => {
    render(<ChatView />);
    useChat.getState().applyEvent({ type: 'tool-confirm', callId: 'tc1', name: 'evaluate_script', args: '{"function":"1+1"}', until: Date.now() + 120_000 });
    expect(await screen.findByRole('alertdialog', { name: /evaluate_script/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '允许执行' }));
    await waitFor(() =>
      expect(vi.mocked(postToAgent)).toHaveBeenCalledWith({
        type: 'agent:confirm',
        convId: useConversations.getState().currentId,
        callId: 'tc1',
        decision: 'allow',
      }),
    );
  });

  it('tool-start 到达后确认卡翻回运行态工具卡', () => {
    render(<ChatView />);
    useChat.getState().applyEvent({ type: 'tool-confirm', callId: 'tc1', name: 'evaluate_script', args: '{}', until: Date.now() + 120_000 });
    useChat.getState().applyEvent({ type: 'tool-start', name: 'evaluate_script', args: '{}', callId: 'tc1' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});
```

Run: `npx vitest run tests/ui/chat-confirm.test.tsx`
Expected: FAIL（MessageRow 尚不渲染确认卡）

- [ ] **Step 6: ChatView 集成**

`components/chat/ChatView.tsx`：

① import 区加：

```ts
import { ToolConfirmCard, type ConfirmDecision } from './ToolConfirmCard';
```

② `ChatView` 组件内（`const title = ...` 附近）加：

```ts
  const onConfirm = (callId: string, decision: ConfirmDecision) => {
    if (!currentId) return;
    postToPort({ type: 'agent:confirm', convId: currentId, callId, decision });
  };
```

③ `<MessageRow ...>` 调用处加 prop：`onConfirm={onConfirm}`。

④ `MessageRow` 签名加参：

```ts
function MessageRow({ item, index, streaming, onConfirm }: { item: ChatItem; index: number; streaming: boolean; onConfirm?: (callId: string, decision: ConfirmDecision) => void }) {
```

⑤ MessageRow 的 tool 分支（`const state = ...` 行之前）加确认态早退：

```ts
  if (item.status === 'confirm') {
    return (
      <div className="rise">
        <ToolConfirmCard
          name={item.name ?? ''}
          args={item.args ? formatArgs(item.args) : undefined}
          until={item.confirmUntil ?? Date.now()}
          onDecide={(d) => { if (item.callId) onConfirm?.(item.callId, d); }}
        />
      </div>
    );
  }
```

- [ ] **Step 7: 样式**

`entrypoints/sidepanel/styles.css` 在 `/* ============ 行为模式下拉` 注释块（约 768 行）之前插入：

```css
/* ============ 工具确认卡（会话流内，三级确认策略） ============ */
.toolconfirm {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--signal);
  border-radius: var(--r-md);
  background: var(--sunken);
}
.toolconfirm__head { display: flex; align-items: center; gap: 6px; color: var(--signal-ink); }
.toolconfirm__name { font-size: 12px; font-weight: 600; }
.toolconfirm__risk { margin-left: auto; }
.toolconfirm__left { color: var(--ink-2); font-size: 10.5px; }
.toolconfirm__args { max-height: 160px; overflow: auto; font-size: 11px; }
.toolconfirm__actions { display: flex; gap: 6px; flex-wrap: wrap; }
```

- [ ] **Step 8: 全部测试 + 类型检查**

Run: `npx vitest run tests/ui/tool-confirm-card.test.tsx tests/ui/chat-confirm.test.tsx && npm run compile`
Expected: PASS、无类型错误

- [ ] **Step 9: 提交**

```bash
git add components/chat/ToolConfirmCard.tsx components/chat/ChatView.tsx entrypoints/sidepanel/styles.css tests/ui/tool-confirm-card.test.tsx tests/ui/chat-confirm.test.tsx
git commit -m "feat(chat): 会话流内工具确认卡（单卡双态，三按钮 + 倒计时）"
```

---

### Task 8: ModeSelect 重构（触发钮 chip + 双组浮窗）

**Files:**
- Modify: `components/chat/ModeSelect.tsx`（整体重写）
- Modify: `entrypoints/sidepanel/styles.css`（modeselect 区，约 771-844 行）
- Test: `tests/ui/modeselect.test.tsx`（新建）

**Interfaces:**
- Consumes: Task 2 的 `getSettings`/`saveSettings`（`agent.confirmLevel`）、Task 1 的 `ConfirmLevel`、现有 `useChat`（mode）与 `useConversations`（setMode）。
- Produces: 触发钮无箭头、文案 = 权限状态（ask→「只读」，agent→档位名）；浮窗两组（行为模式 / 确认策略，ask 下确认组禁用）；键盘 ↑↓ Enter 扁平跨五项。

- [ ] **Step 1: 写失败测试**

`tests/ui/modeselect.test.tsx` 全文：

```tsx
// tests/ui/modeselect.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { ModeSelect } from '../../components/chat/ModeSelect';
import { useChat } from '../../stores/chat';
import { getSettings, saveSettings } from '../../storage/settings';

afterEach(cleanup);

beforeEach(() => {
  fakeBrowser.reset();
  useChat.setState({ mode: 'agent' });
});

describe('ModeSelect 触发钮与双组浮窗', () => {
  it('触发钮无箭头，文案为权限状态（agent + 默认仅敏感）', async () => {
    const { container } = render(<ModeSelect />);
    const btn = await screen.findByRole('button', { name: /仅敏感/ });
    expect(btn.querySelector('.modeselect__chev')).toBeNull();
    expect(container.querySelector('.modeselect__chev')).toBeNull();
  });

  it('ask 模式文案为只读', async () => {
    useChat.setState({ mode: 'ask' });
    render(<ModeSelect />);
    expect(await screen.findByRole('button', { name: /只读/ })).toBeInTheDocument();
  });

  it('挂载时读取已存档位', async () => {
    await saveSettings({ agent: { confirmLevel: 'all' } });
    render(<ModeSelect />);
    expect(await screen.findByRole('button', { name: /全部询问/ })).toBeInTheDocument();
  });

  it('浮窗含两组，选档写入 settings', async () => {
    render(<ModeSelect />);
    fireEvent.click(await screen.findByRole('button', { name: /仅敏感/ }));
    expect(screen.getByText('行为模式')).toBeInTheDocument();
    expect(screen.getByText('确认策略')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: /自动放行/ }));
    await waitFor(async () => expect((await getSettings()).agent.confirmLevel).toBe('auto'));
  });

  it('ask 模式下确认策略组禁用', async () => {
    useChat.setState({ mode: 'ask' });
    render(<ModeSelect />);
    fireEvent.click(await screen.findByRole('button', { name: /只读/ }));
    expect(screen.getByRole('option', { name: /自动放行/ })).toBeDisabled();
  });

  it('键盘 ↓×4 + Enter 选到「自动放行」', async () => {
    render(<ModeSelect />);
    fireEvent.click(await screen.findByRole('button', { name: /仅敏感/ }));
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    fireEvent.keyDown(document, { key: 'Enter' });
    await waitFor(async () => expect((await getSettings()).agent.confirmLevel).toBe('auto'));
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/ui/modeselect.test.tsx`
Expected: FAIL（触发钮文案是 Agent/Ask、仍有箭头、无确认策略组）

- [ ] **Step 3: 重写 ModeSelect**

`components/chat/ModeSelect.tsx` 全文替换：

```tsx
// components/chat/ModeSelect.tsx
// 行为模式 + 确认策略双组浮层（spec §8.3）：自绘浮层（不用原生 <select>，样式不可控）。
// 触发钮 = 模式图标（Eye/Bot）+ 权限状态文案（ask→只读；agent→档位名）+ 底色 chip，无箭头。
// Esc/点外关闭；键盘 ↑↓ + Enter 扁平跨五项（行为模式 2 + 确认策略 3）。
import { useEffect, useRef, useState } from 'react';
import { Check, Eye, Bot } from 'lucide-react';
import { Tooltip } from '../ui/Tooltip';
import type { AgentMode } from '../../agent/mode';
import type { ConfirmLevel } from '../../agent/permission';
import { getSettings, saveSettings } from '../../storage/settings';
import { useChat } from '../../stores/chat';
import { useConversations } from '../../stores/conversations';

const MODE_OPTIONS: Array<{ value: AgentMode; label: string; desc: string }> = [
  { value: 'agent', label: 'Agent', desc: '完整能力：可点击、填写、导航、执行脚本、管理脚本池' },
  { value: 'ask', label: 'Ask', desc: '只读问答：仅查看页面、截图、读控制台/网络/脚本，不做任何修改' },
];

const LEVEL_OPTIONS: Array<{ value: ConfirmLevel; label: string; desc: string }> = [
  { value: 'all', label: '全部询问', desc: '每个写入/执行类操作都先问你（只读动作除外）' },
  { value: 'sensitive', label: '仅敏感', desc: '只有高危操作（任意 JS、跨域请求、导航、脚本/技能池写入）需要确认' },
  { value: 'auto', label: '自动放行', desc: '全部放行不询问；可随时回此浮窗改回' },
];

type Row =
  | { kind: 'mode'; value: AgentMode }
  | { kind: 'level'; value: ConfirmLevel; disabled: boolean };

export function ModeSelect({ disabled }: { disabled?: boolean }) {
  const mode = useChat((s) => s.mode);
  const setMode = useConversations((s) => s.setMode);
  const [level, setLevel] = useState<ConfirmLevel>('sensitive');
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // 挂载读已存档位；改档直写 settings（运行中 loop 每发工具现读，权威永远在 storage）
  useEffect(() => {
    let alive = true;
    void getSettings().then((s) => { if (alive) setLevel(s.agent.confirmLevel); });
    return () => { alive = false; };
  }, []);

  // 扁平行序：mode 2 项 + level 3 项（ask 下 level 禁用）
  const rows: Row[] = [
    ...MODE_OPTIONS.map((o) => ({ kind: 'mode' as const, value: o.value })),
    ...LEVEL_OPTIONS.map((o) => ({ kind: 'level' as const, value: o.value, disabled: mode === 'ask' })),
  ];

  const current = MODE_OPTIONS.find((o) => o.value === mode) ?? MODE_OPTIONS[0]!;
  const levelLabel = LEVEL_OPTIONS.find((o) => o.value === level)?.label ?? '仅敏感';
  const statusLabel = mode === 'ask' ? '只读' : levelLabel;
  const triggerTint = mode === 'ask' ? ' modeselect__trigger--ask' : level === 'auto' ? ' modeselect__trigger--auto' : '';

  // 打开时高亮当前项并滚入视野
  useEffect(() => {
    if (!open) return;
    const idx = rows.findIndex((r) => (r.kind === 'mode' ? r.value === mode : r.value === level));
    setHi(idx >= 0 ? idx : 0);
    requestAnimationFrame(() => itemRefs.current[idx >= 0 ? idx : 0]?.scrollIntoView({ block: 'nearest' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 点外关闭 + Esc/↑↓/Enter（展开态才拦，避免吃掉输入框的取消行为）
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setOpen(false); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setHi((v) => {
          for (let step = 1; step <= rows.length; step++) {
            const next = (v + (e.key === 'ArrowDown' ? step : rows.length - step)) % rows.length;
            const row = rows[next]!;
            if (!(row.kind === 'level' && row.disabled)) return next;
          }
          return v;
        });
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const row = rows[hi];
        if (row && !(row.kind === 'level' && row.disabled)) pick(row);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, hi, mode, level]);

  const pick = (row: Row) => {
    setOpen(false);
    if (row.kind === 'mode') {
      if (row.value !== mode) setMode(row.value);
    } else {
      setLevel(row.value);
      void saveSettings({ agent: { confirmLevel: row.value } });
    }
  };

  const onTriggerKey = (e: React.KeyboardEvent) => {
    if (open) return; // 展开态键盘交给浮层的 document 监听
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setOpen(true);
    }
  };

  return (
    <div className="modeselect" ref={rootRef}>
      <Tooltip label={`行为模式：${current.label}；确认策略：${statusLabel}${mode === 'ask' ? '（ask 只读，无需确认）' : ''}`} disabled={open}>
        <button
          type="button"
          className={`modeselect__trigger${triggerTint}`}
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          onKeyDown={onTriggerKey}
        >
          {mode === 'ask' ? <Eye size={12} /> : <Bot size={12} />}
          <span className="modeselect__label">{statusLabel}</span>
        </button>
      </Tooltip>
      {open && (
        <div className="modeselect__pop" role="listbox" aria-label="行为模式与确认策略">
          <div className="modeselect__group">行为模式</div>
          {MODE_OPTIONS.map((o, i) => (
            <button
              key={o.value}
              ref={(el) => { itemRefs.current[i] = el; }}
              type="button"
              role="option"
              aria-selected={o.value === mode}
              className={`modeselect__opt${i === hi ? ' modeselect__opt--hi' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setHi(i)}
              onClick={() => pick({ kind: 'mode', value: o.value })}
            >
              <span className="modeselect__opt-icon">
                {o.value === 'ask' ? <Eye size={13} /> : <Bot size={13} />}
              </span>
              <span className="modeselect__opt-body">
                <span className="modeselect__opt-label">{o.label}</span>
                <span className="modeselect__opt-desc">{o.desc}</span>
              </span>
              {o.value === mode && <Check size={13} className="modeselect__opt-check" />}
            </button>
          ))}
          <div className={`modeselect__group${mode === 'ask' ? ' modeselect__group--off' : ''}`}>
            确认策略{mode === 'ask' ? '（ask 只读，无需确认）' : ''}
          </div>
          {LEVEL_OPTIONS.map((o, i) => {
            const idx = i + MODE_OPTIONS.length;
            const isCur = mode !== 'ask' && o.value === level;
            return (
              <button
                key={o.value}
                ref={(el) => { itemRefs.current[idx] = el; }}
                type="button"
                role="option"
                aria-selected={isCur}
                disabled={mode === 'ask'}
                className={`modeselect__opt${idx === hi ? ' modeselect__opt--hi' : ''}`}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setHi(idx)}
                onClick={() => pick({ kind: 'level', value: o.value, disabled: mode === 'ask' })}
              >
                <span className="modeselect__opt-body">
                  <span className="modeselect__opt-label">{o.label}</span>
                  <span className="modeselect__opt-desc">{o.desc}</span>
                </span>
                {isCur && <Check size={13} className="modeselect__opt-check" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: 样式调整**

`entrypoints/sidepanel/styles.css` modeselect 区：

① `.modeselect__trigger`（772-789 行）改两处——`background: transparent;` → `background: var(--sunken);`、`padding: 0 4px;` → `padding: 0 8px;`。

② 删除 `.modeselect__chev` 两行（795-796）与 reduced-motion 块里的 `.modeselect__chev { transition: none; }` 一行（约 844）。

③ `--ask` 行之后加：

```css
.modeselect__trigger--auto { color: var(--warn); }
```

④ `.modeselect__opt--hi` 行之前加：

```css
.modeselect__group {
  padding: 6px 9px 3px;
  font-size: 10px;
  letter-spacing: 0.08em;
  color: var(--ink-3);
}
.modeselect__group--off { opacity: 0.55; }
.modeselect__opt:disabled { opacity: 0.45; cursor: not-allowed; }
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run tests/ui/modeselect.test.tsx`
Expected: PASS

- [ ] **Step 6: 类型检查 + 提交**

Run: `npm run compile`

```bash
git add components/chat/ModeSelect.tsx entrypoints/sidepanel/styles.css tests/ui/modeselect.test.tsx
git commit -m "feat(modeselect): 触发钮改权限状态 chip（去箭头），浮窗增确认策略组"
```

---

### Task 9: convdebug 决策标记 + 迭代记录 + 全量验证

**Files:**
- Modify: `components/convdebug/TurnTimeline.tsx`（约 98-103 行的工具表格）
- Modify: `docs/history.md`（文件末尾追加小节）

**Interfaces:**
- Consumes: Task 3 的 `TurnToolRecord.confirm`。

- [ ] **Step 1: convdebug 工具行加确认标记**

`components/convdebug/TurnTimeline.tsx` 工具表格行内（`<td className="mono">{tool.name}</td>` 那格）改为：

```tsx
                          <td className="mono">
                            {tool.name}
                            {tool.confirm && <span title={`确认 ${tool.confirm}`}>·{tool.confirm}</span>}
                          </td>
```

（`tool.confirm` 类型来自 Task 3 的 TurnToolRecord，TS 自动收窄。）

- [ ] **Step 2: 类型检查 + 既有测试不回归**

Run: `npm run compile && npm run test`
Expected: 全量测试 PASS（这一步同时是全项目的回归门）

- [ ] **Step 3: 迭代记录**

`docs/history.md` 文件末尾追加：

```markdown
## 工具确认卡与三级确认策略（2026-09-22）

spec: `docs/superpowers/specs/2026-09-22-tool-confirm-and-permission-levels-design.md`

- agent 工具调用新增会话流内确认卡（单卡双态：待确认展开面板 → 决策后折叠一行工具卡）与三级确认策略（全部询问 / 仅敏感 / 自动放行，默认仅敏感）。档位存 `settings.agent.confirmLevel`，全局生效，选择器浮窗切换。
- 判定核心 `agent/permission.ts`：敏感集 12（任意 JS/跨域请求/导航开闭页/脚本池技能池写入）、微操集 9（click/fill 等页面细节 + 记忆写）、只读 = ask 白名单减记忆写。sensitive 档按白名单放行微操，未分类工具默认要问（fail-safe）。
- 协议增量：下行 `tool-confirm` 事件 + 上行 `agent:confirm` 消息；卡片状态转移复用既有 `tool-start`/`tool-end`（allow 后补发 tool-start 翻卡，deny/timeout 直接 tool-end 终结）。
- 闸门在 loop（spec §6）：`confirmToolCall` 缺省 = 不设闸；会话放行集（allow-session）随 loop 生灭不落库；拒绝计入熔断阀失败统计。
- 后台确认槽（spec §7）：120s 超时自动拒绝、停止键 abort 收口为拒绝、`agent:confirm` 按 convId+callId 幂等、attach 回放待确认状态（until 为绝对时间戳，倒计时跨重挂载连续）。
- ModeSelect 触发钮改「模式图标 + 权限状态」chip（去右箭头、加底色，auto 档 warn 前景），浮窗两组（行为模式 + 确认策略，ask 下确认组禁用），键盘导航扁平跨五项。
- 确认决策进 trace（`TurnToolRecord.confirm/confirmMs`），convdebug 时间线工具行带决策标记。
```

- [ ] **Step 4: 提交**

```bash
git add components/convdebug/TurnTimeline.tsx docs/history.md
git commit -m "docs(convdebug): 工具行确认决策标记；history 记录工具确认卡迭代"
```

---

## 收尾核对清单（全部任务完成后）

- [ ] `npm run compile` 零错误
- [ ] `npm run test` 全量 PASS
- [ ] 手工冒烟（`npm run dev` 载入扩展）：agent 模式问「帮我在当前页执行 1+1」→ 触发 evaluate_script 确认卡 → 允许 → 卡片折叠为成功工具卡；切「自动放行」后同类调用不再询问；ask 模式下选择器浮窗确认组灰置
