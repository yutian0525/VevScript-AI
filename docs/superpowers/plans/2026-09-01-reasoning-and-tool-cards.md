# 思考过程折叠显示 + 工具卡片展开 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 打通推理模型的 reasoning 数据链（解析→传输→存储→UI），让思考过程实时流式展开、出正文自动收起、重开可回看；并把工具卡片做成可点击展开看完整参数与输出。

**Architecture:** 沿用既有分层——provider 把 SSE 的 `reasoning_content`/`reasoning` 归一化为 `reasoning-delta` 纯增量事件；run-turn 聚合；loop 转发到 Port 并把 reasoning 存进会话 storage（但 `toWireMessages` 天然不读 reasoning，故绝不回填 LLM）；zustand store 累积 reasoning + thinking 态；ChatView 渲染折叠块与可展开工具卡；挂载时从 storage 恢复历史。

**Tech Stack:** TypeScript、WXT（浏览器扩展）、React 19、zustand、lucide-react、Vitest + `wxt/testing/fake-browser`。

**关联规范：** [docs/superpowers/specs/2026-09-01-reasoning-and-tool-cards-design.md](../specs/2026-09-01-reasoning-and-tool-cards-design.md)

**全局约束：** 图标一律用 lucide-react，禁止用 emoji 代替图标。

---

## 命令速查

- 单测（单文件）：`npx vitest run <path> -t "<用例名>"`
- 全量单测：`npm test`
- 类型检查：`npm run compile`
- 构建：`npm run build`

---

## 文件结构

| 文件 | 职责 | 本计划改动 |
|---|---|---|
| `agent/provider/types.ts` | 统一消息/流事件类型 | `StreamEvent` 加 `reasoning-delta`；`ChatMessage` 加 `reasoning?` |
| `agent/provider/openai-compat.ts` | SSE 解析 + wire 互转 | 解析 `reasoning_content`/`reasoning`；`toWireMessages` 不动（加测试锁定） |
| `agent/run-turn.ts` | provider 回调→单轮 Promise | `TurnResult.reasoning`、`onReasoningDelta` 聚合 |
| `agent/loop.ts` | agent 主循环 | emit `reasoning-delta`、append 带 reasoning、`tool-end` 带 output |
| `shared/messages.ts` | Port 协议 | `PortMsgToPanel` 加 `reasoning-delta` + `tool-end.output?` |
| `stores/chat.ts` | 侧边栏状态 | `ChatItem` 扩展 + `applyEvent` 分支 + `toggleExpand` + `loadFromStorage` |
| `components/chat/ChatView.tsx` | 会话 UI | 思考折叠块 + 工具卡展开 + 挂载恢复 |
| `entrypoints/sidepanel/styles.css` | 样式 | `.think*` + `.toolcard--btn/__chev/__detail` |

---

## Task 1: provider 解析 reasoning 字段 → `reasoning-delta`

**Files:**
- Modify: `agent/provider/types.ts:43-47`（`StreamEvent` 联合加 `reasoning-delta`）
- Modify: `agent/provider/openai-compat.ts:117-140`（chunk 类型 + 解析）
- Test: `tests/agent/provider/openai-compat.test.ts`（追加用例）

- [ ] **Step 1: 写失败测试**

在 `tests/agent/provider/openai-compat.test.ts` 的 `describe('OpenAICompatProvider', ...)` 内、最后一个 `it` 之后追加：

```ts
  it('reasoning_content 归一化为 reasoning-delta，先于 text-delta', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(
      new Response(
        sseStream([
          { choices: [{ delta: { reasoning_content: '让我' } }] },
          { choices: [{ delta: { reasoning_content: '想想' } }] },
          { choices: [{ delta: { content: '答案是 42' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
        ]),
        { status: 200 },
      ),
    );
    const p = new OpenAICompatProvider({ baseUrl: 'https://api.x.com/v1', apiKey: 'sk', model: 'r1' });
    const events: StreamEvent[] = [];
    await new Promise<void>((resolve) => {
      p.streamChat(baseParams(), (e) => {
        events.push(e);
        if (e.type === 'message-done') resolve();
      });
    });
    const reasoning = events.filter((e) => e.type === 'reasoning-delta').map((e) => (e as { text: string }).text);
    expect(reasoning.join('')).toBe('让我想想');
    const texts = events.filter((e) => e.type === 'text-delta').map((e) => (e as { text: string }).text);
    expect(texts.join('')).toBe('答案是 42');
  });

  it('reasoning 别名（无 _content 后缀）同样命中', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(
      new Response(
        sseStream([
          { choices: [{ delta: { reasoning: '思考中' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
        ]),
        { status: 200 },
      ),
    );
    const p = new OpenAICompatProvider({ baseUrl: 'https://api.x.com/v1', apiKey: 'sk', model: 'o1' });
    const events: StreamEvent[] = [];
    await new Promise<void>((resolve) => {
      p.streamChat(baseParams(), (e) => {
        events.push(e);
        if (e.type === 'message-done') resolve();
      });
    });
    expect(events.some((e) => e.type === 'reasoning-delta' && (e as { text: string }).text === '思考中')).toBe(true);
  });

  it('非推理模型 chunk 不发 reasoning-delta', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(
      new Response(
        sseStream([
          { choices: [{ delta: { content: '直接回答' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
        ]),
        { status: 200 },
      ),
    );
    const p = new OpenAICompatProvider({ baseUrl: 'https://api.x.com/v1', apiKey: 'sk', model: 'gpt' });
    const events: StreamEvent[] = [];
    await new Promise<void>((resolve) => {
      p.streamChat(baseParams(), (e) => {
        events.push(e);
        if (e.type === 'message-done') resolve();
      });
    });
    expect(events.some((e) => e.type === 'reasoning-delta')).toBe(false);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/agent/provider/openai-compat.test.ts -t "reasoning"`
Expected: 类型错误或断言失败——`reasoning-delta` 不是 `StreamEvent` 成员 / 从未发出。

- [ ] **Step 3: 扩展 `StreamEvent`**

编辑 `agent/provider/types.ts`，把 `StreamEvent` 联合（原 43-47 行）改为：

```ts
/** 流式事件（provider 把 wire 增量归一化为这几种） */
export type StreamEvent =
  | { type: 'reasoning-delta'; text: string }
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call-delta'; index: number; id?: string; name?: string; argsDelta?: string }
  | { type: 'message-done'; usage?: Usage; finishReason?: string }
  | { type: 'error'; error: string };
```

- [ ] **Step 4: provider 解析 reasoning**

编辑 `agent/provider/openai-compat.ts`。先在 `parser` 回调里 chunk 类型的 `delta` 上加两个字段（原 118-131 行 `let chunk: {...}`），把 `delta?: {` 块改为：

```ts
              delta?: {
                content?: string | null;
                reasoning_content?: string | null;
                reasoning?: string | null;
                tool_calls?: Array<{
                  index?: number;
                  id?: string;
                  function?: { name?: string; arguments?: string };
                }>;
              };
```

再在 `const choice = chunk.choices?.[0];`（原 137 行）之后、`if (choice?.delta?.content)` 之前插入：

```ts
          const reasoning = choice?.delta?.reasoning_content ?? choice?.delta?.reasoning;
          if (reasoning) onEvent({ type: 'reasoning-delta', text: reasoning });
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run tests/agent/provider/openai-compat.test.ts`
Expected: PASS（全部用例，含既有的）。

- [ ] **Step 6: 提交**

```bash
git add agent/provider/types.ts agent/provider/openai-compat.ts tests/agent/provider/openai-compat.test.ts
git commit -m "feat(provider): 解析 reasoning_content/reasoning → reasoning-delta 事件"
```

---

## Task 2: run-turn 聚合 reasoning（`TurnResult.reasoning` + `onReasoningDelta`）

**Files:**
- Modify: `agent/run-turn.ts:6-16`（`TurnResult` + `RunTurnHooks`）
- Modify: `agent/run-turn.ts:22-60`（事件循环加 `reasoning-delta` 分支）
- Test: `tests/agent/run-turn.test.ts`（追加用例）

- [ ] **Step 1: 写失败测试**

在 `tests/agent/run-turn.test.ts` 的 `describe('runTurn', ...)` 内追加：

```ts
  it('聚合 reasoning-delta 为 TurnResult.reasoning，onReasoningDelta 实时回调', async () => {
    const p = scriptedProvider([
      { type: 'reasoning-delta', text: '第一步' },
      { type: 'reasoning-delta', text: '第二步' },
      { type: 'text-delta', text: '结论' },
      { type: 'message-done', finishReason: 'stop' },
    ]);
    const deltas: string[] = [];
    const r = await runTurn(p, params(), { onReasoningDelta: (t) => deltas.push(t) });
    expect(deltas).toEqual(['第一步', '第二步']);
    expect(r.reasoning).toBe('第一步第二步');
    expect(r.text).toBe('结论');
  });

  it('无 reasoning 时 TurnResult.reasoning 为 undefined', async () => {
    const p = scriptedProvider([
      { type: 'text-delta', text: 'x' },
      { type: 'message-done', finishReason: 'stop' },
    ]);
    const r = await runTurn(p, params(), {});
    expect(r.reasoning).toBeUndefined();
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/agent/run-turn.test.ts -t "reasoning"`
Expected: 类型错误——`onReasoningDelta` 不在 `RunTurnHooks`；`r.reasoning` 不在 `TurnResult`。

- [ ] **Step 3: 扩展类型与聚合逻辑**

编辑 `agent/run-turn.ts`。把 `TurnResult` 与 `RunTurnHooks`（原 6-16 行）改为：

```ts
export interface TurnResult {
  text: string;
  reasoning?: string;
  toolCalls: ToolCall[];
  finishReason?: string;
  usage?: Usage;
  error?: string;
}

export interface RunTurnHooks {
  onTextDelta?: (text: string) => void;
  onReasoningDelta?: (text: string) => void;
}
```

在 `runTurn` 函数体内，`let text = '';`（原 24 行）之后加一行局部累加变量：

```ts
  let reasoning = '';
```

在 `switch (e.type)` 里 `case 'text-delta':` 之前插入新分支：

```ts
        case 'reasoning-delta':
          reasoning += e.text;
          try { hooks.onReasoningDelta?.(e.text); } catch { /* 忽略消费者回调异常 */ }
          break;
```

把 `case 'message-done'` 里的 `settle({...})`（原 54 行）改为带 reasoning（非空才带）：

```ts
          settle({ text, reasoning: reasoning || undefined, toolCalls, finishReason: e.finishReason, usage: e.usage, error });
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/agent/run-turn.test.ts`
Expected: PASS（含既有用例）。

- [ ] **Step 5: 提交**

```bash
git add agent/run-turn.ts tests/agent/run-turn.test.ts
git commit -m "feat(run-turn): 聚合 reasoning-delta 到 TurnResult.reasoning + onReasoningDelta 回调"
```

---

## Task 3: `ChatMessage.reasoning?` + 锁定「不回填 LLM」不变量

**Files:**
- Modify: `agent/provider/types.ts:11-19`（`ChatMessage` 加 `reasoning?`）
- Test: `tests/agent/provider/openai-compat.test.ts`（追加锁定用例）

说明：`toWireMessages`（[openai-compat.ts:21-40](../../../agent/provider/openai-compat.ts#L21-L40)）只取 `role/content/toolCalls`，本就不读 reasoning——本任务不改它，只加字段 + 一条测试把「wire 不含 reasoning」钉死，防未来回归。

- [ ] **Step 1: 写失败测试**

在 `tests/agent/provider/openai-compat.test.ts` 追加（`ChatMessage` 已在文件顶部从 `../../../agent/provider/types` 间接可用；此处直接构造 params）：

```ts
  it('toWireMessages 不含 reasoning（锁定：思考绝不回填 LLM）', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(
      new Response(sseStream([{ choices: [{ delta: {}, finish_reason: 'stop' }] }]), { status: 200 }),
    );
    const p = new OpenAICompatProvider({ baseUrl: 'https://api.x.com/v1', apiKey: 'sk', model: 'm' });
    await new Promise<void>((resolve) => {
      p.streamChat(
        {
          messages: [
            { role: 'user', content: '算一下' },
            { role: 'assistant', content: '答案 42', reasoning: '内部推理不该外泄' },
          ],
          tools: [],
        },
        (e) => { if (e.type === 'message-done') resolve(); },
      );
    });
    const body = (fetchMock.mock.calls[0]![1] as RequestInit).body as string;
    expect(body).not.toContain('内部推理不该外泄');
    const parsed = JSON.parse(body);
    expect(parsed.messages[1].reasoning).toBeUndefined();
    expect(parsed.messages[1].content).toBe('答案 42');
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/agent/provider/openai-compat.test.ts -t "不含 reasoning"`
Expected: 类型错误——`reasoning` 不是 `ChatMessage` 的合法字段（对象字面量多余属性报错）。

- [ ] **Step 3: 给 `ChatMessage` 加 `reasoning?`**

编辑 `agent/provider/types.ts`，把 `ChatMessage`（原 11-19 行）改为：

```ts
/** 统一消息格式（内部标准，provider 负责与 wire format 互转） */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[];
  /** assistant 消息携带的完整工具调用（wire 转换时使用） */
  toolCalls?: ToolCall[];
  /** tool 消息：对应的调用 id */
  toolCallId?: string;
  name?: string; // tool 消息的工具名
  /** 推理模型的思考文本：仅存储 + 展示用，wire 转换绝不读取（不回填 LLM） */
  reasoning?: string;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/agent/provider/openai-compat.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add agent/provider/types.ts tests/agent/provider/openai-compat.test.ts
git commit -m "feat(types): ChatMessage.reasoning? + 锁定 toWireMessages 不回填 reasoning"
```

---

## Task 4: loop 转发 reasoning + 存储 reasoning + `tool-end` 带 output

**Files:**
- Modify: `shared/messages.ts:95-102`（`PortMsgToPanel` 加 `reasoning-delta` + `tool-end.output?`）
- Modify: `agent/loop.ts:48-50`（onReasoningDelta emit）、`agent/loop.ts:83`、`agent/loop.ts:90`、`agent/loop.ts:100-101`、`agent/loop.ts:115-117`
- Test: `tests/agent/loop.test.ts`（追加用例）

- [ ] **Step 1: 写失败测试**

在 `tests/agent/loop.test.ts` 的 `describe('agent loop', ...)` 内追加：

```ts
  it('reasoning-delta 转发到 Port，且 reasoning 存进 assistant 消息', async () => {
    const provider = queuedProvider([[
      { type: 'reasoning-delta', text: '先想想' },
      { type: 'text-delta', text: '好的' },
      { type: 'message-done', finishReason: 'stop' },
    ]]);
    const exec = vi.fn<LoopDeps['executeTool']>();
    const d = deps(provider, exec);
    await runAgentLoop({ tabId: 10, sessionId: 's', userMessage: 'x' }, d);
    expect(d.emit).toHaveBeenCalledWith({ type: 'reasoning-delta', text: '先想想' });
    const session = await getSession(10);
    const last = session.messages[session.messages.length - 1]!;
    expect(last.role).toBe('assistant');
    expect(last.reasoning).toBe('先想想');
    expect(last.content).toBe('好的');
  });

  it('工具分支 assistant 消息也带 reasoning；tool-end 带完整 output', async () => {
    const provider = queuedProvider([
      [{ type: 'reasoning-delta', text: '需要看页面' }, { type: 'tool-call-delta', index: 0, id: 'c1', name: 'take_snapshot', argsDelta: '{}' }, { type: 'message-done', finishReason: 'tool_calls' }],
      [{ type: 'text-delta', text: '看到了' }, { type: 'message-done', finishReason: 'stop' }],
    ]);
    const exec = vi.fn<LoopDeps['executeTool']>().mockResolvedValue({ ok: true, data: '[1] button 完整快照文本' } as ToolResult);
    const d = deps(provider, exec);
    await runAgentLoop({ tabId: 11, sessionId: 's', userMessage: 'x' }, d);
    const session = await getSession(11);
    const asst = session.messages.find((m) => m.role === 'assistant' && m.toolCalls?.length)!;
    expect(asst.reasoning).toBe('需要看页面');
    expect(d.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'tool-end', callId: 'c1', ok: true, output: '[1] button 完整快照文本' }));
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/agent/loop.test.ts -t "reasoning"`
Expected: 失败——`reasoning-delta` 不在 `PortMsgToPanel`；`emit` 未收到该事件；assistant 消息无 reasoning；`tool-end` 无 output。

- [ ] **Step 3: 扩展 Port 协议**

编辑 `shared/messages.ts`，把 `PortMsgToPanel`（原 95-102 行）改为：

```ts
export type PortMsgToPanel =
  | { type: 'reasoning-delta'; text: string }
  | { type: 'text-delta'; text: string }
  | { type: 'tool-start'; name: string; args: string; callId: string }
  | { type: 'tool-end'; name: string; callId: string; ok: boolean; summary: string; output?: string }
  | { type: 'paused'; reason: string }
  | { type: 'done'; finalText: string }
  | { type: 'error'; message: string }
  | { type: 'state'; status: 'idle' | 'running' | 'paused'; messageCount: number };
```

- [ ] **Step 4: loop 转发 + 存储 + output**

编辑 `agent/loop.ts`：

(a) `runTurn` 的 hooks（原 48-50 行）加 `onReasoningDelta`：

```ts
    const result = await runTurn(deps.provider, { messages, tools: getToolSchemas(), signal: ac.signal }, {
      onTextDelta: (t) => deps.emit({ type: 'text-delta', text: t }),
      onReasoningDelta: (t) => deps.emit({ type: 'reasoning-delta', text: t }),
    });
```

(b) 自然终止 append（原 83 行）带 reasoning：

```ts
      await appendMessage(tabId, { role: 'assistant', content: finalText, reasoning: result.reasoning });
```

(c) 工具分支 append assistant（原 90 行）与 length 截断分支 append（原 60 行）都改用带 reasoning 的 `assistantMsg`：

```ts
    await appendMessage(tabId, assistantMsg(result.text, result.toolCalls, result.reasoning));
```

（第 60 行同样替换为 `assistantMsg(result.text, result.toolCalls, result.reasoning)`。）

(d) `tool-end` emit（原 100 行）带 output（完整工具输出文本，复用 `toToolContent`）：

```ts
      const output = toToolContent(r);
      deps.emit({ type: 'tool-end', name: tc.name, callId: tc.id, ok: r.ok, summary, output });
```

(e) `assistantMsg` 签名（原 115-117 行）加 reasoning 形参：

```ts
function assistantMsg(text: string, toolCalls: ToolCall[], reasoning?: string): ChatMessage {
  return { role: 'assistant', content: text, toolCalls, reasoning };
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run tests/agent/loop.test.ts`
Expected: PASS（含既有用例）。

- [ ] **Step 6: 提交**

```bash
git add shared/messages.ts agent/loop.ts tests/agent/loop.test.ts
git commit -m "feat(loop): 转发 reasoning-delta + 存储 reasoning + tool-end 带完整 output"
```

---

## Task 5: store — `ChatItem` 扩展 + `applyEvent` + `toggleExpand` + `loadFromStorage`

**Files:**
- Modify: `stores/chat.ts`（`ChatItem`、`ChatState`、`applyEvent`、新 actions）
- Test: `tests/stores/chat.test.ts`（追加用例）

- [ ] **Step 1: 写失败测试**

在 `tests/stores/chat.test.ts` 顶部 import 后追加一个类型 import，并在 `describe('chat store', ...)` 内追加用例：

在文件顶部把 import 改为：

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useChat } from '../../stores/chat';
import type { ChatMessage } from '../../agent/provider/types';
```

在 `describe` 内追加：

```ts
  it('reasoning-delta 累积到 assistant 项并标记 thinking', () => {
    useChat.getState().applyEvent({ type: 'reasoning-delta', text: '想' });
    useChat.getState().applyEvent({ type: 'reasoning-delta', text: '一下' });
    const last = useChat.getState().messages.at(-1)!;
    expect(last).toMatchObject({ role: 'assistant', reasoning: '想一下', thinking: true });
    expect(last.text).toBeUndefined();
  });

  it('首个 text-delta 自动收起思考块（thinking→false）并累积正文', () => {
    useChat.getState().applyEvent({ type: 'reasoning-delta', text: '推理' });
    useChat.getState().applyEvent({ type: 'text-delta', text: '正' });
    useChat.getState().applyEvent({ type: 'text-delta', text: '文' });
    const last = useChat.getState().messages.at(-1)!;
    expect(last).toMatchObject({ role: 'assistant', reasoning: '推理', thinking: false, text: '正文' });
    expect(useChat.getState().messages).toHaveLength(1); // reasoning 与 text 同属一项
  });

  it('无 reasoning 时 text-delta 仍新建 assistant 项（回归保护）', () => {
    useChat.getState().applyEvent({ type: 'text-delta', text: '直接答' });
    const last = useChat.getState().messages.at(-1)!;
    expect(last).toMatchObject({ role: 'assistant', text: '直接答' });
  });

  it('tool-end 带 output 存进对应卡片', () => {
    useChat.getState().applyEvent({ type: 'tool-start', name: 'take_snapshot', args: '{}', callId: 'c1' });
    useChat.getState().applyEvent({ type: 'tool-end', name: 'take_snapshot', callId: 'c1', ok: true, summary: '成功', output: '[1] button 全文' });
    const tool = useChat.getState().messages.find((m) => m.callId === 'c1')!;
    expect(tool).toMatchObject({ status: 'done', ok: true, output: '[1] button 全文' });
  });

  it('toggleExpand 切换指定项 expanded', () => {
    useChat.getState().applyEvent({ type: 'tool-start', name: 'click', args: '{}', callId: 'c1' });
    useChat.getState().toggleExpand(0);
    expect(useChat.getState().messages[0]!.expanded).toBe(true);
    useChat.getState().toggleExpand(0);
    expect(useChat.getState().messages[0]!.expanded).toBe(false);
  });

  it('loadFromStorage 映射历史（含 reasoning + 工具卡片）', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: '看页面' },
      { role: 'assistant', content: '', reasoning: '要先截图', toolCalls: [{ id: 'c1', name: 'take_snapshot', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'c1', name: 'take_snapshot', content: '[1] button' },
      { role: 'assistant', content: '看到了一个按钮', reasoning: '分析完毕' },
    ];
    useChat.getState().loadFromStorage(history);
    const items = useChat.getState().messages;
    expect(items[0]).toMatchObject({ role: 'user', text: '看页面' });
    // 带 toolCalls 的 assistant：思考存在但正文为空 → 只出思考项
    expect(items.find((m) => m.reasoning === '要先截图')).toBeTruthy();
    const toolItem = items.find((m) => m.callId === 'c1')!;
    expect(toolItem).toMatchObject({ role: 'tool', name: 'take_snapshot', status: 'done', ok: true, output: '[1] button' });
    const finalAsst = items.at(-1)!;
    expect(finalAsst).toMatchObject({ role: 'assistant', text: '看到了一个按钮', reasoning: '分析完毕', thinking: false });
  });

  it('loadFromStorage 里失败的 tool 消息标记 ok=false', () => {
    const history: ChatMessage[] = [
      { role: 'assistant', content: '', toolCalls: [{ id: 'c9', name: 'click', arguments: '{"uid":9}' }] },
      { role: 'tool', toolCallId: 'c9', name: 'click', content: '错误：stale uid' },
    ];
    useChat.getState().loadFromStorage(history);
    const toolItem = useChat.getState().messages.find((m) => m.callId === 'c9')!;
    expect(toolItem.ok).toBe(false);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/stores/chat.test.ts`
Expected: 失败——`reasoning/thinking/expanded/output` 不在 `ChatItem`；`toggleExpand`/`loadFromStorage` 不存在。

- [ ] **Step 3: 重写 `stores/chat.ts`（类型 + import + 辅助）**

把 `stores/chat.ts` 顶部到 `ChatState` 定义（原 1-22 行）替换为：

```ts
// stores/chat.ts
import { create } from 'zustand';
import type { PortMsgToPanel } from '../shared/messages';
import type { ChatMessage } from '../agent/provider/types';

export type ChatStatus = 'idle' | 'running' | 'paused';

export interface ChatItem {
  role: 'user' | 'assistant' | 'tool' | 'error';
  text?: string;
  reasoning?: string;        // 思考文本
  thinking?: boolean;        // 是否处于「思考中」（控制默认展开）
  expanded?: boolean;        // 用户手动展开/收起（思考块 & 工具卡片共用）
  name?: string; args?: string; callId?: string;
  status?: 'running' | 'done'; ok?: boolean; summary?: string;
  output?: string;           // 工具完整输出（供展开）
}

interface ChatState {
  messages: ChatItem[];
  status: ChatStatus;
  pauseReason?: string;
  addUserMessage: (text: string) => void;
  applyEvent: (e: PortMsgToPanel) => void;
  setStatus: (s: ChatStatus) => void;
  toggleExpand: (index: number) => void;
  loadFromStorage: (messages: ChatMessage[]) => void;
  reset: () => void;
}

/** ChatMessage.content 可能是字符串或内容块数组，取其文本。 */
function contentText(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  return content.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('');
}
```

- [ ] **Step 4: 重写 `applyEvent`（reasoning-delta + text-delta 收起 + tool-end output）**

把 `applyEvent`（原 30-58 行）的实现替换为：

```ts
  applyEvent: (e) => set((s) => {
    const messages = [...s.messages];
    switch (e.type) {
      case 'reasoning-delta': {
        const last = messages[messages.length - 1];
        if (last?.role === 'assistant' && last.status == null && last.thinking) {
          messages[messages.length - 1] = { ...last, reasoning: (last.reasoning ?? '') + e.text };
        } else {
          messages.push({ role: 'assistant', reasoning: e.text, thinking: true });
        }
        return { messages };
      }
      case 'text-delta': {
        const last = messages[messages.length - 1];
        if (last?.role === 'assistant' && last.status == null) {
          // 首个正文增量：自动收起思考块（thinking→false）
          messages[messages.length - 1] = { ...last, text: (last.text ?? '') + e.text, thinking: false };
        } else {
          messages.push({ role: 'assistant', text: e.text });
        }
        return { messages };
      }
      case 'tool-start':
        messages.push({ role: 'tool', name: e.name, args: e.args, callId: e.callId, status: 'running' });
        return { messages };
      case 'tool-end': {
        const idx = messages.findIndex((m) => m.role === 'tool' && m.callId === e.callId);
        if (idx >= 0) messages[idx] = { ...messages[idx]!, status: 'done', ok: e.ok, summary: e.summary, output: e.output };
        return { messages };
      }
      case 'state': return { status: e.status };
      case 'paused': return { status: 'paused', pauseReason: e.reason };
      case 'done': return { status: 'idle' };
      case 'error':
        messages.push({ role: 'error', text: e.message });
        return { messages, status: 'idle' };
      default: return {};
    }
  }),
```

- [ ] **Step 5: 加 `toggleExpand` 与 `loadFromStorage` action**

在 `setStatus: (status) => set({ status }),`（原 28 行）之后插入：

```ts
  toggleExpand: (index) => set((s) => {
    const messages = [...s.messages];
    const cur = messages[index];
    if (!cur) return {};
    messages[index] = { ...cur, expanded: !cur.expanded };
    return { messages };
  }),
  loadFromStorage: (stored) => set(() => {
    // callId → tool result（用于把 assistant.toolCalls 还原成工具卡片状态）
    const toolResults = new Map<string, { content: string }>();
    for (const m of stored) {
      if (m.role === 'tool' && m.toolCallId) toolResults.set(m.toolCallId, { content: contentText(m.content) });
    }
    const items: ChatItem[] = [];
    for (const m of stored) {
      if (m.role === 'user') {
        items.push({ role: 'user', text: contentText(m.content) });
      } else if (m.role === 'assistant') {
        const text = contentText(m.content);
        // 历史思考块：thinking=false（默认收起，可点开）
        if (text || m.reasoning) {
          items.push({ role: 'assistant', text: text || undefined, reasoning: m.reasoning, thinking: false });
        }
        for (const tc of m.toolCalls ?? []) {
          const res = toolResults.get(tc.id);
          const output = res?.content;
          const ok = output != null ? !output.startsWith('错误：') : true;
          items.push({
            role: 'tool', name: tc.name, args: tc.arguments, callId: tc.id,
            status: 'done', ok, summary: ok ? '成功' : '失败', output,
          });
        }
      }
      // role==='tool' 已在 toolResults 里被 assistant 分支消费，不单独渲染
      // role==='system' 不持久化，天然不会出现
    }
    return { messages: items, status: 'idle', pauseReason: undefined };
  }),
```

- [ ] **Step 6: 跑测试确认通过**

Run: `npx vitest run tests/stores/chat.test.ts`
Expected: PASS（含既有 8 条 + 新增 7 条）。

- [ ] **Step 7: 提交**

```bash
git add stores/chat.ts tests/stores/chat.test.ts
git commit -m "feat(store): reasoning 累积/收起 + toggleExpand + loadFromStorage 恢复历史"
```

---

## Task 6: 样式 — 思考折叠块 + 可展开工具卡

**Files:**
- Modify: `entrypoints/sidepanel/styles.css`（在 `/* 工具卡 */` 段之后追加）

无独立测试（视觉，靠 Task 8 构建 + 手动冒烟验证）。

- [ ] **Step 1: 追加思考块样式**

在 `styles.css` 的 `.toolcard__summary--err { color: var(--err); }`（原 331 行）之后插入：

```css
/* 思考折叠块 */
.think {
  border-left: 2px solid var(--line-strong);
  padding-left: 10px;
  margin-bottom: 4px;
}
.think__toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: none;
  background: transparent;
  padding: 2px 0;
  cursor: pointer;
  color: var(--ink-3);
  font-family: var(--mono);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.think__toggle:hover { color: var(--ink-2); }
.think__toggle:focus-visible { outline: 2px solid var(--signal); outline-offset: 2px; }
.think--live .think__toggle { color: var(--signal-ink); }
.think__chev { transition: transform var(--t-fast) var(--ease); }
.think__chev--open { transform: rotate(90deg); }
.think__body {
  margin-top: 6px;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--ink-2);
  white-space: pre-wrap;
  word-break: break-word;
}

/* 可展开工具卡 */
.toolcard--btn {
  width: 100%;
  text-align: left;
  cursor: pointer;
  font: inherit;
}
.toolcard__chev { margin-left: auto; flex-shrink: 0; color: var(--ink-3); transition: transform var(--t-fast) var(--ease); }
.toolcard__chev--open { transform: rotate(90deg); }
.toolcard__detail { margin: 4px 0 0; padding-left: 12px; }
.toolcard__detail .token { display: block; margin: 8px 0 4px; }
```

- [ ] **Step 2: 提交**

```bash
git add entrypoints/sidepanel/styles.css
git commit -m "style: 思考折叠块 + 可展开工具卡样式"
```

---

## Task 7: ChatView — 思考折叠块 + 工具卡展开 + 挂载恢复

**Files:**
- Modify: `components/chat/ChatView.tsx`

无独立单测（组件层无既有测试脚手架）；靠 Task 8 的 `compile`/`build` + 手动冒烟验证。

- [ ] **Step 1: 更新 import**

把 `ChatView.tsx` 顶部两行 import（原 2-3 行）替换为：

```tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { Send, Wrench, CircleAlert, Loader2, Check, X, ChevronRight, Brain } from 'lucide-react';
import { PageShell } from '../ui/PageShell';
import { Button } from '../ui/Button';
import { Gauge } from '../ui/Gauge';
import { useChat, type ChatItem } from '../../stores/chat';
import { getSession } from '../../storage/sessions';
import type { PortMsgFromPanel, PortMsgToPanel } from '../../shared/messages';
```

- [ ] **Step 2: 加挂载恢复 effect**

在 `useEffect(() => { endRef.current?.scrollIntoView(...); }, [messages]);`（原 39 行）之后插入：

```tsx
  // 挂载恢复：store 为空时，从当前 tab 的 storage 读历史渲染（含思考折叠、工具卡片）。
  // 只读 storage 渲染，不接管运行中 loop 的事件流（重连归 Phase 5）。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (useChat.getState().messages.length > 0) return;
      const tabId = await activeTabId();
      if (tabId == null || cancelled) return;
      const session = await getSession(tabId);
      if (cancelled || useChat.getState().messages.length > 0) return;
      if (session.messages.length > 0) useChat.getState().loadFromStorage(session.messages);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
```

- [ ] **Step 3: MessageRow 传 index**

把渲染 `MessageRow` 那行（原 97-99 行）改为传 `index`：

```tsx
          {messages.map((m, i) => (
            <MessageRow key={i} index={i} item={m} streaming={status === 'running' && i === lastIdx} />
          ))}
```

- [ ] **Step 4: 重写 MessageRow（assistant 带思考块 + 工具卡可展开）**

把整个 `MessageRow` 函数（原 129-163 行，含末尾 `}`）替换为：

```tsx
function MessageRow({ item, index, streaming }: { item: ChatItem; index: number; streaming: boolean }) {
  const toggleExpand = useChat((s) => s.toggleExpand);

  if (item.role === 'user') {
    return <div className="msg-user rise">{item.text}</div>;
  }
  if (item.role === 'error') {
    return (
      <div className="msg-error rise">
        <CircleAlert size={15} />
        <span>{item.text}</span>
      </div>
    );
  }
  if (item.role === 'assistant') {
    return (
      <div className="rise">
        {item.reasoning != null && (
          <ReasoningBlock item={item} onToggle={() => toggleExpand(index)} />
        )}
        {item.text != null && (
          <div className={`msg-assistant${streaming && !item.thinking ? ' caret' : ''}`}>{item.text}</div>
        )}
      </div>
    );
  }
  // tool
  const state = item.status === 'running' ? 'running' : item.ok ? 'ok' : 'err';
  const canExpand = item.status === 'done';
  const open = !!item.expanded;
  return (
    <div className="rise">
      <button
        className={`toolcard toolcard--btn toolcard--${state}`}
        aria-expanded={canExpand ? open : undefined}
        onClick={() => canExpand && toggleExpand(index)}
        title={item.args}
      >
        <span className="toolcard__icon">
          {item.status === 'running' ? (
            <Loader2 size={13} className="spin" />
          ) : item.ok ? (
            <Check size={13} color="var(--ok)" />
          ) : (
            <X size={13} color="var(--err)" />
          )}
        </span>
        <span className="toolcard__name">{item.name}</span>
        {item.status === 'done' && item.summary && (
          <span className={`toolcard__summary${item.ok ? '' : ' toolcard__summary--err'}`}>· {item.summary}</span>
        )}
        {item.status === 'running' ? (
          <Wrench size={11} color="var(--ink-3)" style={{ marginLeft: 'auto' }} />
        ) : (
          <ChevronRight size={13} className={`toolcard__chev${open ? ' toolcard__chev--open' : ''}`} />
        )}
      </button>
      {open && canExpand && (
        <div className="toolcard__detail rise">
          {item.args && (
            <>
              <span className="token">ARGS</span>
              <div className="well" style={{ maxHeight: 160 }}>{formatArgs(item.args)}</div>
            </>
          )}
          {item.output && (
            <>
              <span className="token">OUTPUT</span>
              <div className="well" style={{ maxHeight: 260 }}>{item.output}</div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: 加 ReasoningBlock 与 formatArgs 辅助**

在 `MessageRow` 函数之后（文件末尾）追加：

```tsx
function ReasoningBlock({ item, onToggle }: { item: ChatItem; onToggle: () => void }) {
  // 思考中默认展开；出正文后（thinking=false）默认收起。用户手动 expanded 优先。
  const live = !!item.thinking;
  const open = item.expanded ?? live;
  return (
    <div className={`think${live ? ' think--live' : ''}`}>
      <button className="think__toggle" aria-expanded={open} onClick={onToggle}>
        {live ? <Loader2 size={12} className="spin" /> : <Brain size={12} />}
        <ChevronRight size={12} className={`think__chev${open ? ' think__chev--open' : ''}`} />
        <span>{live ? '思考中…' : '已思考'}</span>
      </button>
      {open && item.reasoning && <div className="think__body">{item.reasoning}</div>}
    </div>
  );
}

/** 工具参数：尽量格式化为多行 JSON，非法 JSON 原样返回。 */
function formatArgs(args: string): string {
  try {
    return JSON.stringify(JSON.parse(args), null, 2);
  } catch {
    return args;
  }
}
```

- [ ] **Step 6: 类型检查**

Run: `npm run compile`
Expected: 无错误（`tsc --noEmit` 通过）。

- [ ] **Step 7: 提交**

```bash
git add components/chat/ChatView.tsx
git commit -m "feat(chat-ui): 思考折叠块 + 工具卡片可展开 + 挂载从 storage 恢复历史"
```

---

## Task 8: 全量验证 + 手动冒烟

**Files:** 无（仅验证）

- [ ] **Step 1: 全量单测**

Run: `npm test`
Expected: 全绿。重点关注 `openai-compat`、`run-turn`、`loop`、`chat` store 四个套件全部通过。

- [ ] **Step 2: 类型检查**

Run: `npm run compile`
Expected: 无错误。

- [ ] **Step 3: 构建**

Run: `npm run build`
Expected: 构建成功（`wxt build` 无错误）。

- [ ] **Step 4: 手动冒烟（真实推理模型）**

在设置页配置一个推理模型（DeepSeek-R1 或经中转的 o 系列），加载扩展后逐项确认：

- [ ] 发一条需要思考的指令 → 思考阶段侧边栏**实时流式展开** reasoning（顶部「思考中…」+ Loader 图标），不再空白。
- [ ] 开始吐正文 → 思考块**自动收起**为一行「已思考」（Brain 图标），正文紧随其下。
- [ ] 点击「已思考」→ 展开重看完整思考文本；再点收起。
- [ ] 触发一次工具调用 → 工具卡出现；完成后点击卡片 → 展开看完整 ARGS（格式化 JSON）+ OUTPUT（如快照全文，等宽字体、可滚动、有高度上限）。
- [ ] 关闭侧边栏再重开 → 历史会话渲染出来，思考块可点开回看，工具卡可展开。
- [ ] 换一个**非推理模型**发消息 → 无思考块，正文正常流式（无回归）。

- [ ] **Step 5: 收尾提交（如有冒烟期间的微调）**

```bash
git add -A
git commit -m "chore: reasoning 折叠 + 工具卡展开 冒烟修正"
```

（若冒烟无需改动，跳过此步。）

---

## 自查（Self-Review）

**1. Spec 覆盖：**

| Spec 要求 | 对应任务 |
|---|---|
| §3.1 provider 解析 reasoning_content/reasoning → reasoning-delta | Task 1 |
| §3.1 StreamEvent 加 reasoning-delta | Task 1 |
| §3.2 TurnResult.reasoning + onReasoningDelta 聚合 | Task 2 |
| §3.4 ChatMessage.reasoning? | Task 3 |
| §3.3 / §4 toWireMessages 不含 reasoning（不回填）锁定测试 | Task 3 |
| §3.3 loop emit reasoning-delta + append 带 reasoning | Task 4 |
| §3.4 PortMsgToPanel 加 reasoning-delta | Task 4 |
| §3.6 tool-end 带 output | Task 4（emit）+ Task 5（store） |
| §3.5 storage 无改动（ChatMessage 带 reasoning 原样存） | 无需改动（Task 3 加字段后天然生效；由 Task 4 loop 测试间接覆盖存储回读） |
| §3.6 ChatItem 扩展 + applyEvent + toggleExpand + loadFromStorage | Task 5 |
| §3.7 思考折叠块（实时展开/出正文收起/点击切换） | Task 5（thinking 态）+ Task 6（样式）+ Task 7（UI） |
| §3.7 工具卡片可展开（完整 args + output） | Task 5 + Task 6 + Task 7 |
| §3.7 挂载恢复（store 空则读 storage 渲染） | Task 7 |
| §4 测试策略（provider/run-turn/toWire/store/loop） | Task 1/2/3/4/5 |
| §4 构建绿 | Task 8 |

**2. 无占位符：** 各步均有完整代码/命令/预期。

**3. 类型一致性核对：**
- `reasoning-delta` 事件形状在 `StreamEvent`（Task 1）与 `PortMsgToPanel`（Task 4）一致：`{ type:'reasoning-delta'; text:string }`。
- `TurnResult.reasoning?: string`（Task 2）↔ loop 读 `result.reasoning`（Task 4）一致。
- `assistantMsg(text, toolCalls, reasoning?)` 三参签名（Task 4 Step 4e）与三处调用（Step 4c 两处 + 既有工具分支）一致。
- `ChatItem` 字段（`reasoning/thinking/expanded/output`，Task 5 Step 3）↔ store 写入（Step 4）↔ UI 读取（Task 7）一致。
- `tool-end.output?`（Task 4）↔ store `applyEvent` 读 `e.output`（Task 5）↔ `ChatItem.output`（Task 5）一致。
- `loadFromStorage(messages: ChatMessage[])`（Task 5）↔ ChatView 调用 `loadFromStorage(session.messages)`（Task 7）一致。

**4. 开放项（实施时按需，MVP 不阻塞）：**
- reasoning trace 的 storage 裁剪阈值（Spec §3.5）——MVP 先不裁，观察体积。
- 思考块流式高频 setState 是否需节流（Spec §5）——现有流式渲染已验证可接受。
- 思考块「思考中」态下用户手动收起需点两次（首点仅置 `expanded=true` 无视觉变化，再点才收起）——`toggleExpand` 简单翻转 `expanded` 的已知小瑕疵，MVP 可接受；重展开为单击。












