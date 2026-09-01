# 思考过程折叠显示 + 工具卡片展开 设计文档

- 日期：2026-09-01
- 状态：待评审
- 项目根：`d:\workspace-mou8\ai-browser-extend`
- 关联：Phase 2（agent 核心，已完成）；本特性是 Phase 2 之上的增量增强
- 上游设计：[2026-08-31-ai-browser-extension-phase2-design.md](./2026-08-31-ai-browser-extension-phase2-design.md)

---

## 1. 目标与范围

推理模型（DeepSeek-R1、OpenAI o 系列、及经中转站的同类）在"思考"阶段输出的是独立字段（`reasoning_content` 或 `reasoning`），正文 `content` 要等思考结束才开始吐。当前 provider **只读 `choice.delta.content`**，导致：

1. 思考阶段侧边栏一片空白，用户以为"AI 没反应"（这是之前"发消息没回应"表象的一部分成因）。
2. 用户看不到 AI 的推理过程。

本特性打通 reasoning 这条数据链（解析 → 传输 → UI），并顺带把工具调用卡片做成可展开看完整参数与输出。

**范围内：**

- provider/SSE 解析 `reasoning_content` / `reasoning`，产出 `reasoning-delta` 流事件。
- run-turn / loop / Port 把 reasoning 增量转发到侧边栏。
- 思考持久化到会话 storage（供重开回看），但**组装发给 LLM 的消息时剔除 reasoning**（不回填）。
- 侧边栏挂载时从 storage 恢复历史会话渲染（含思考折叠、工具卡片）——即"重开可回看"。
- store / ChatView：思考过程可折叠块（边想边展开、出正文自动收起）；工具卡片可点击展开看完整参数 + 输出。

**范围外：**

- 完整的 agent:attach 重连 + 运行中状态回放（仍归 Phase 5）。本特性只做"从 storage 读历史渲染"这一读取侧，不做"重连到正在跑的 loop 并接管其事件流"。
- 多模态思考、思考内容的搜索/导出。
- 非推理模型的行为变化（它们不吐 reasoning 字段，链路对它们是无害透传）。

### 已确认的交互决策（用户拍板）

| 决策点 | 结论 |
|---|---|
| 折叠行为 | 思考阶段**实时展开流式显示**；一旦开始吐正文，自动**收起**成一行"已思考"，可点开重看 |
| 持久化 | 思考内容**持久化**到 storage，侧边栏关闭重开后仍可展开回看 |
| 工具卡片 | 一起做成**可点击展开**，看完整参数 + 完整输出（如快照全文） |
| 回填 LLM | 思考内容**绝不回填**给 LLM（display + storage only） |

---

## 2. 数据流（端到端，标出改动点）

```
LLM SSE chunk
  choice.delta.reasoning_content / reasoning   ← 【新】provider 解析
  choice.delta.content
  choice.delta.tool_calls
        │
        ▼  openai-compat.ts
  StreamEvent:
    { type:'reasoning-delta'; text }           ← 【新】
    { type:'text-delta'; text }
    { type:'tool-call-delta'; ... }
    { type:'message-done'; ... }
        │
        ▼  run-turn.ts（消费者聚合）
  TurnResult { text; reasoning?; toolCalls; ... }   ← 【新】reasoning 字段
  hooks.onReasoningDelta(text)                       ← 【新】
        │
        ▼  loop.ts
  emit({ type:'reasoning-delta', text })             ← 【新】转发到 Port
  appendMessage(assistant, { content, reasoning })   ← 【新】存 reasoning 进 storage
  buildContext 组装发 LLM 时【剔除 reasoning】        ← 关键：不回填
        │
        ▼  Port（PortMsgToPanel）
  { type:'reasoning-delta'; text }                   ← 【新】
        │
        ▼  stores/chat.ts applyEvent
  当前 assistant 项累积 reasoning，标记 thinking 展开
  收到首个 text-delta → 自动收起 reasoning
        │
        ▼  ChatView.tsx
  思考折叠块（展开/收起 + 点击切换）
  工具卡片可展开看 args + output
        │
  侧边栏挂载 → 从 storage 读 session.messages → 渲染历史（含 reasoning 折叠）  ← 【新】恢复读取侧
```

---

## 3. 分层设计

### 3.1 解析层（`agent/provider/openai-compat.ts` + `types.ts`）

**StreamEvent 扩展**（`agent/provider/types.ts`）：

```ts
export type StreamEvent =
  | { type: 'reasoning-delta'; text: string }   // 新增
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call-delta'; index: number; id?: string; name?: string; argsDelta?: string }
  | { type: 'message-done'; usage?: Usage; finishReason?: string }
  | { type: 'error'; error: string };
```

**provider 解析**：在读 `choice.delta.content` 之前，先读 reasoning 字段（两种命名都认，DeepSeek 用 `reasoning_content`，部分中转/o 系列用 `reasoning`）：

```ts
const delta = choice?.delta as {
  content?: string | null;
  reasoning_content?: string | null;
  reasoning?: string | null;
  tool_calls?: ...;
};
const reasoning = delta?.reasoning_content ?? delta?.reasoning;
if (reasoning) onEvent({ type: 'reasoning-delta', text: reasoning });
if (delta?.content) onEvent({ type: 'text-delta', text: delta.content });
```

纯增量转发，聚合责任仍在消费者（run-turn），与现有 text/tool-call 一致。非推理模型不吐这俩字段 → 零 `reasoning-delta`，无副作用。

### 3.2 run-turn（`agent/run-turn.ts`）

- `TurnResult` 加 `reasoning?: string`（聚合的完整思考文本）。
- `RunTurnHooks` 加 `onReasoningDelta?: (text: string) => void`。
- 事件循环加 `case 'reasoning-delta'`：累加到 `reasoning` 局部变量 + 调 `onReasoningDelta`。
- message-done 时把 `reasoning`（非空才带）放进 TurnResult。

### 3.3 loop（`agent/loop.ts`）

- runTurn 的 hooks 加 `onReasoningDelta: (t) => deps.emit({ type: 'reasoning-delta', text: t })`。
- 自然终止 / 工具分支 append assistant 消息时，带上 `reasoning`（若有）：
  `appendMessage(tabId, { role:'assistant', content, reasoning, toolCalls })`。
- **关键**：reasoning 只是 ChatMessage 上的额外字段，`openai-compat.ts` 的 `toWireMessages` 本就只取 `role/content/toolCalls`、不读 reasoning——所以**天然不回填**，无需额外剔除逻辑。设计上明确写一条测试锁定"toWireMessages 不含 reasoning"。

### 3.4 类型与协议（`agent/provider/types.ts` + `shared/messages.ts`）

- `ChatMessage` 加可选 `reasoning?: string`（存储 + 内部用；wire 转换不读它）。
- `PortMsgToPanel` 加 `{ type: 'reasoning-delta'; text: string }`。

### 3.5 存储（`storage/sessions.ts`）

- `ChatMessage` 已含 reasoning 字段，`appendMessage` 无需改动（原样存整条消息）。
- **容量考量**：reasoning trace 往往比正文长得多，会话上限 200 条不变，但可考虑对**历史** assistant 消息的 reasoning 做裁剪（只保留最近 N 条的 reasoning，更早的丢弃 reasoning 只留正文）——避免 storage 膨胀。MVP 先不裁、观察实际体积，若 `chrome.storage.local` 配额告警再加（记为开放项）。

### 3.6 store（`stores/chat.ts`）

`ChatItem` 扩展：

```ts
export interface ChatItem {
  role: 'user' | 'assistant' | 'tool' | 'error';
  text?: string;
  reasoning?: string;        // 新增：思考文本
  thinking?: boolean;        // 新增：是否处于"思考中"（控制默认展开）
  expanded?: boolean;        // 新增：用户手动展开/收起（思考块 & 工具卡片共用语义）
  name?: string; args?: string; callId?: string;
  status?: 'running' | 'done'; ok?: boolean; summary?: string;
  output?: string;           // 新增：工具完整输出（供展开）
}
```

`applyEvent` 新增/调整分支：

- `reasoning-delta`：找当前流式 assistant 项（无则新建 `{ role:'assistant', reasoning:'', thinking:true }`），累加 reasoning，保持 `thinking:true`（展开态）。
- `text-delta`：**首次**收到时，把当前 assistant 项的 `thinking` 置 false（自动收起思考块），再累加 content。
- `tool-end`：把完整结果 summary 之外，带上 `output`（完整输出文本）供展开。
- 其余不变。

新增 action `toggleExpand(index)`：切换某条消息的 `expanded`（思考块和工具卡片共用）。

新增 action `loadFromStorage(messages)`：把 storage 里的 `ChatMessage[]` 映射为 `ChatItem[]`（含 reasoning）填充 store——供侧边栏挂载时恢复历史。

### 3.7 UI（`components/chat/ChatView.tsx`）

- **思考折叠块**：assistant 项若有 reasoning，正文上方渲染一个折叠块：
  - `thinking:true`（思考中）→ 默认展开，流式显示 reasoning，顶部标"思考中…"（lucide `Brain`/`Loader2` 图标）。
  - `thinking:false`（已出正文或历史）→ 默认收起为一行"已思考"（可点开），点击切 `expanded`。
  - 用户手动 `expanded` 优先于默认。
- **工具卡片可展开**：点击卡片切 `expanded`，展开区显示完整 `args`（格式化 JSON）+ 完整 `output`（如快照全文，等宽字体 + 滚动区 + 高度上限）。
- **挂载恢复**：ChatView 挂载 effect 里，若 store 为空，读当前 tab 的 `getSession(tabId).messages` → `loadFromStorage` 渲染历史（含思考折叠）。
- 图标一律 lucide-react，无 emoji（遵全局规则）。

---

## 4. 测试策略

- **单元（Vitest）**：
  - provider：喂含 `reasoning_content` 的 SSE chunk → 断言发出 `reasoning-delta`；喂 `reasoning` 变体同样命中；非推理 chunk 不发 reasoning-delta。
  - run-turn：reasoning-delta 聚合进 TurnResult.reasoning + onReasoningDelta 实时回调。
  - **toWireMessages 不含 reasoning**（锁定"不回填"不变量）。
  - store：reasoning-delta 累积 + thinking 态；首个 text-delta 自动收起（thinking→false）；toggleExpand；loadFromStorage 映射 reasoning；tool-end 带 output。
  - loop：assistant 消息 append 时带 reasoning（mock provider 发 reasoning-delta）。
- **构建**：tsc + build 绿。
- **手动冒烟**：真实推理模型（如 DeepSeek-R1 / 经中转的 o 系列）跑一次，看思考实时流式展开→出正文收起→可点开回看；关闭侧边栏重开，历史思考仍可展开；工具卡片点开看快照全文。

---

## 5. 风险与开放问题

| 风险 | 缓解 |
|---|---|
| 中转站的 reasoning 字段命名不统一（除 reasoning_content/reasoning 外还有别名） | 先覆盖两种主流命名；遇到新变体再加（解析处集中一行，易扩展） |
| reasoning trace 体积大撑爆 storage 配额 | MVP 先不裁、观察；超限则对历史消息只留最近 N 条 reasoning（§3.5 开放项） |
| 挂载恢复与 Phase 5 的 agent:attach 重连边界模糊 | 本特性只做"读 storage 渲染历史"，不接管运行中 loop 的事件流；运行中重连仍归 Phase 5 |
| 思考块流式高频 setState 卡顿 | reasoning-delta 与 text-delta 同频，现有流式渲染已验证可接受；必要时节流（开放项） |
| 部分模型思考很长但正文很短，收起后用户以为没答复 | 收起态明确标"已思考"且正文紧随其下；正文为空+仅思考的情况按 message-done 正常处理 |

**开放问题（实施阶段定）**：reasoning trace 的 storage 裁剪阈值；思考块流式渲染是否需要节流；折叠块的具体视觉（缩进/竖线/灰字）。

---

## 6. 涉及文件清单

```
agent/provider/types.ts        # StreamEvent + reasoning-delta；ChatMessage + reasoning?
agent/provider/openai-compat.ts # 解析 reasoning_content/reasoning
agent/run-turn.ts               # TurnResult.reasoning + onReasoningDelta 聚合
agent/loop.ts                   # emit reasoning-delta + append 带 reasoning
shared/messages.ts              # PortMsgToPanel + reasoning-delta
stores/chat.ts                  # ChatItem 扩展 + applyEvent + toggleExpand + loadFromStorage
components/chat/ChatView.tsx    # 思考折叠块 + 工具卡片展开 + 挂载恢复
storage/sessions.ts             # 无改动（ChatMessage 带 reasoning 原样存）
```

（`toWireMessages` 不读 reasoning，无需改动，仅加测试锁定。）
