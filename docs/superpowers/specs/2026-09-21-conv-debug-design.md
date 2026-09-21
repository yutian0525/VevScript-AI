# AI 会话调试页 设计

- 日期：2026-09-21
- 状态：已确认（对话中设计获用户批准）
- 背景：会话排障目前只能靠侧边栏里逐条翻消息。消息流只持久化了「结果」——assistant 正文、reasoning、toolCalls、tool 输出；而 agent loop 的「过程」全无记录：单轮耗时、TTFT、usage 明细、每个工具的执行耗时与成败、压缩触发与效果、熔断原因、上下文组装体积。这些量要么是瞬态广播（`compact-start/done`）、要么纯内存（`loop-guards` 的 `GuardState`、`agent-tail` 的流式尾巴、`observe-store` 的环形缓冲），SW 一重启即失，事后无从追溯。本设计给 loop 补一层轻量结构化 trace 落盘，并新增一个独立标签页承载「会话列表 + 轮次时间线 + 原始消息流」的只读调试视图。

## 1. 关键决策记录

| # | 决策 | 选择 | 理由 |
|---|------|------|------|
| 1 | trace 深度 | **轻量轮次元数据，不存 prompt 全文** | manifest 无 `unlimitedStorage`，quota 即默认 10MB。prompt 全文与已落盘的消息流高度重复，存它等于把配额翻倍消耗；组装摘要（条数/字符数/是否带 summary）已足够解释 token 为什么涨 |
| 2 | 生命周期 | **每会话一个 trace 环形，随会话删除** | 与消息的 `MAX_MESSAGES=200` 滚动裁剪同一套心智模型，不引入新的清理逻辑；独立 key 避免与消息共用写放大 |
| 3 | 页面形态 | **单页 master-detail + `?convId=` 深链** | 一个 entrypoint 搞定；切会话看对比不用来回跳；刷新/分享链接可直达 |
| 4 | 详情组织 | **轮次时间线为主 + 「原始消息流」切换开关** | 一轮 loop 迭代 = 一条 trace，天然对齐；消息流存得更久，trace 裁剪后仍能兜底 |
| 5 | 数据通道 | **页面直接 import `storage/*`，不走消息协议** | 扩展页面读 `chrome.storage` 无障碍，已有先例（`ChatView`/`MemoryPage`/`ModelSettings`）；新增消息类型 + 后台路由是纯开销 |
| 6 | 实时跟随 | **`storage.watch`** | wxt 0.21 经 `@wxt-dev/storage` 导出 `watch(key, cb)`，本仓尚未用过但可用；loop 每轮 commit 一次，页面自然跳动，无需轮询 |
| 7 | trace 落盘粒度 | **每轮一次写，轮内工具记录在内存累计** | 与 `appendMessage` 的整轮写语义一致；一轮一次写把写放大压到最低 |
| 8 | 轮次编号 | **`seq` 独立记账，不随环形裁剪回退** | 裁剪后仍能显示「第 1–N 轮已裁剪」，而非从 1 重新计数造成误导 |
| 9 | 入口分流 | **设置条目加可选 `tabUrl`，壳按它决定开标签页还是进二级页** | 保持 `SettingsHome` 是纯数据、`SettingsView` 是纯路由；不为一个条目特判 key |
| 10 | 已开标签页 | **`tabs.query` 命中则 `tabs.update` 导航 + 聚焦，否则 `tabs.create`** | 复用 `confirm-queue.ts` 的 hub 标签页复用模式；顺带解决「已开但停在别的会话」 |

## 2. 目标与非目标

**目标**

1. loop 每轮落一条结构化 trace：耗时、TTFT、usage、工具明细、压缩事件、熔断原因、上下文组装摘要、结束方式。
2. 新增独立标签页 `conv-debug.html`：左栏会话列表，右栏「轮次时间线 / 原始消息流」双视图。
3. 设置页「开发者工具」组新增入口，点击开标签页；已开则复用并导航到目标会话。
4. 运行中的会话可实时跟随（每轮 commit 后页面自动刷新）。
5. trace 环形裁剪后优雅降级：时间线只覆盖保留下来的轮次，头部明确提示，并引导去看完整消息流。

**非目标（YAGNI）**

- 不做 trace 导出 JSON / 复制。后续有需要再加。
- 不做 trace 的独立清理 UI——随会话删除即可。
- 不做跨会话对比视图。
- 不改 `ConversationMeta` / `local:conv-index` schema（左栏因此不显示轮数、消息数）。
- 不存 prompt 全文、不存 LLM 原始响应体、不存工具输出的完整副本（工具输出已在 tool 消息里）。
- 不做 trace 的写入失败重试或降级告警（quota 打满时静默丢该轮 trace，不阻断 loop）。
- 不动 `observe-store` / `agent-tail` / `loop-guards` 的既有内存语义。

## 3. 架构

### 3.1 新增模块

| 文件 | 职责 |
|---|---|
| `storage/traces.ts` | trace 持久化：读写、环形裁剪、`seq` 记账、清除。纯存储层，风格对齐 `storage/conversations.ts` |
| `agent/trace.ts` | `createTurnRecorder()` 采集器 + `summarizeContext()` 纯函数。把 storage 细节封在里面，loop 只调语义方法 |
| `entrypoints/conv-debug/index.html` | 标签页入口（照抄 `script-detail/index.html` 模板） |
| `entrypoints/conv-debug/main.tsx` | 挂载 `ConvDebugApp`，解析 `?convId=`，import `../sidepanel/styles.css` |
| `components/convdebug/ConvDebugApp.tsx` | 壳：左列表 + 右详情 + 视图切换 + 自动跟随 |
| `components/convdebug/TurnTimeline.tsx` | 轮次时间线（每轮一个折叠块） |
| `components/convdebug/RawMessages.tsx` | 原始消息流（role 标签 + Markdown 正文 + toolCalls） |
| `components/convdebug/convdebug-utils.ts` | 纯函数投影：trace/消息 → 视图模型、时间/耗时/token 格式化 |
| `stores/extension-tabs.ts` | `openExtensionTab(url)`：已开则 update + 聚焦，否则 create |

### 3.2 改造点

- `storage/conversations.ts`：`deleteConversation` 增补一行 `clearTraces(id)`。
- `agent/loop.ts`：`drive()` 每轮建 recorder，轮体包 `try/finally` 收口 commit；8 处出口显式赋 `outcome`；各接入点调 `markLlm` / `markTool` / `markCompact` / `markContext`。
- `components/settings/SettingsHome.tsx`：`SettingsSub` 加 `'convdebug'`；`Entry` 加可选 `tabUrl`；GROUPS「开发者工具」组加条目；导出 `TAB_ENTRIES` 供壳查表。
- `components/settings/SettingsView.tsx`：`onOpen` 分流——命中 `TAB_ENTRIES` 则 `openExtensionTab`，否则 `setSub`。
- `entrypoints/sidepanel/styles.css`：新增 `.convdebug*` 样式（走既有 CSS 变量与 `.btn` / `.mono` 等工具类）。

## 4. 数据模型

### 4.1 存储形状

key：`local:conv:{id}:trace`

```ts
interface ConvTraceStore {
  /** 会话内单调递增的轮次计数，不随环形裁剪回退 */
  seq: number;
  /** 最近 MAX_TURNS 轮，最旧在前 */
  turns: TurnTrace[];
}

interface TurnTrace {
  turn: number;              // 从 1 起
  startedAt: number;
  endedAt: number;
  tabId: number;             // 本轮起点的操作目标 tab
  mode: AgentMode;           // 本轮实际生效的模式（每轮重读后的值）

  /** buildContext 的组装摘要——不存全文 */
  context: {
    messageCount: number;    // 送进 provider 的消息条数
    chars: number;           // 总字符数（粗估体积）
    hasSummary: boolean;     // 本轮是否带压缩摘要
    summaryChars: number;
    skillCount: number;      // 注入的技能简述条数
    systemPromptChars: number; // 自定义 vs 内置可对比
    pageUrl: string;         // 本轮观测的页面
  };

  llm: {
    ms: number;              // runTurn 整体耗时
    firstTokenMs?: number;   // 首个流式增量到达的时间（TTFT）
    finishReason: string;
    usage?: { promptTokens?: number; completionTokens?: number };
    textChars: number;
    reasoningChars: number;
    error?: string;
  };

  /** 本轮开跑前的自动压缩（若触发） */
  compact?: { ms: number; ok: boolean; newPromptTokens?: number };

  tools: Array<{
    name: string;
    callId: string;          // 与 tool 消息的 toolCallId 对齐，是两边对账的 join key
    argsBytes: number;
    ms: number;
    ok: boolean;
    error?: string;
    summary: string;         // 与 tool-end 事件的 summary 同源
  }>;

  outcome: 'continue' | 'done' | 'paused' | 'aborted' | 'error' | 'truncated-retry';
  /** 熔断停止时的原因（checkGuards 的 verdict.reason） */
  guardReason?: string;
}
```

`outcome` 的取值语义：

- `continue` — 本轮工具执行完毕、循环回到下一轮（轮体末尾自然落下，最常见的非终态）
- `done` — 模型不再调工具，任务自然收尾
- `paused` — 熔断阀判定停止（`guardReason` 带原因）
- `aborted` — 用户中断
- `error` — `runTurn` 返回 error
- `truncated-retry` — 模型输出被 length 截断，走重试分支

`MAX_TURNS = 200`，与 `MAX_MESSAGES` 对齐。

体积估算：每轮 300–600 字节，200 轮约 60–120KB/会话。10MB quota 下即使几十个长会话也不构成压力。

### 4.2 `storage/traces.ts` API

```ts
readTraces(convId: string): Promise<ConvTraceStore>
appendTurnTrace(convId: string, t: TurnTrace): Promise<void>  // 内部 trim + seq 推进
clearTraces(convId: string): Promise<void>
```

`appendTurnTrace` 的 `seq` 由存储层自增（读旧值 +1），调用方传入的 `t.turn` 由采集器从 `seq + 1` 取——避免采集器与存储层各记一份计数。

`readTraces` 对不存在的 key 返回 `{ seq: 0, turns: [] }`，不抛错。

## 5. 采集层

### 5.1 采集器

`agent/trace.ts`：

```ts
createTurnRecorder(init: { convId: string; turn: number; tabId: number }): TurnRecorder
```

`TurnRecorder` 暴露：

- `rec: TurnTrace`（可变对象，loop 直接写 `rec.outcome`）
- `setMode(mode)` — 模式在轮体中部才重读出来，晚于 recorder 创建
- `markContext(messages, opts)` — 调 `summarizeContext` 填 `rec.context`
- `markLlm(startedAt, result, firstTokenAt)` — 填 `rec.llm`
- `markTool(name, callId, argsBytes, ms, result)` — push 一条工具记录
- `markCompact(ms, ok, newPromptTokens?)`
- `commit()` — 补 `endedAt`、调 `appendTurnTrace`，写入失败静默吞掉（不阻断 loop）

`summarizeContext(messages, { summary, skills, systemPrompt, pageUrl })` 是纯函数：遍历 `messages` 累加 `content` 字符串长度与 `toolCalls` 的 `JSON.stringify` 长度。可单测。

`turn` 的取值：采集器不知道全局计数，由 loop 在每轮开头 `readTraces(convId)` 拿 `seq` 再 +1。这会引入每轮一次额外读——可接受（storage 读远廉价于一次 LLM 调用），且保证了 SW 重启后计数正确。

### 5.2 `drive()` 的接线

```ts
for (;;) {
  const { seq } = await readTraces(convId);
  const tr = createTurnRecorder({ convId, turn: seq + 1, tabId: targetTab });
  try {
    // ... 原有轮体，接入点见下表 ...
    tr.rec.outcome = 'continue';   // 轮体末尾自然落下 = 工具跑完继续下一轮
    // 8 处 return 出口各自显式赋值 tr.rec.outcome
  } finally {
    await tr.commit();   // continue / return 均经此收口
  }
}
```

`try/finally` 是关键：轮体内有一处 `continue`（模型输出被截断的重试路径，L160）和 8 处 `return`，`finally` 在 `continue` 前同样执行，一处收口覆盖全部出口。

**9 处出口与 `outcome` 取值**

| loop.ts 位置 | 场景 | outcome |
|---|---|---|
| L78 | 轮首 signal.aborted | `aborted` |
| L99 | 压缩后 signal.aborted | `aborted` |
| L127 | runTurn 返回后 signal.aborted（已追加半截 assistant） | `aborted` |
| L141 | `result.error` | `error` |
| L157 | 截断重试 + 熔断停止 | `paused` |
| L170 | 无工具调用，正常收尾 | `done` |
| L177 | 工具循环中 signal.aborted | `aborted` |
| L255 | 工具执行后熔断停止 | `paused` |
| 轮体末尾（落下） | 工具执行完毕，循环回下一轮 | `continue` |

L160 的 `continue` 不是出口：该轮 trace 记 `truncated-retry` 并照常 commit，下一轮迭代新建 recorder。

`TurnTrace.outcome` 的默认值是 `'error'`——漏赋值即是 bug，宁可显式报错也不要静默伪装成 `done`。

**接入点**

| loop.ts 位置 | 调用 |
|---|---|
| L81-97 | 压缩块前后计时 → `tr.markCompact(...)` |
| L105 | `tr.setMode(mode)` |
| L108 | `tr.markContext(messages, { summary, skills, systemPrompt, pageUrl })` |
| L114-121 | `runTurn` 前后计时；三个流式 hook 里首次回调记 `firstTokenAt` |
| L132-136 | usage 分支 → 并入 `markLlm` |
| L180-241 | 每个工具 `executeTool` 前后计时 → `tr.markTool(...)`（`argsBytes = tc.arguments?.length ?? 0`） |
| L251-257 | 熔断停止 → `tr.rec.guardReason = verdict.reason` |

`firstTokenMs` 的采集：在 `runTurn` 调用前记 `t0`，在 `onTextDelta` / `onReasoningDelta` / `onToolArgsDelta` 三个 hook 里用一个 `let firstAt: number | undefined` 记首次触发时刻。

## 6. 页面层

### 6.1 入口与深链

`entrypoints/conv-debug/index.html` + `main.tsx`，产出 `conv-debug.html`。`main.tsx` 照抄 `entrypoints/script-detail/main.tsx`：解析 `?convId=`，有则传给 `ConvDebugApp`，无则传空串（由组件决定默认选最近一个会话）。

`wxt.config.ts` **无需改动**——WXT 自动发现 `entrypoints/*/index.html`。

选中会话时 `history.replaceState(null, '', '?convId=' + id)` 写回 URL（不 push，避免返回键堆历史）。

### 6.2 布局

```text
┌ 会话调试 ──────────────────────── [⟳ 自动跟随] ┐
│ 会话列表        │ 标题 · running · 12 消息 · 47 轮 │
│ ─────────────  │ [轮次时间线] [原始消息流]        │
│ ▸ 会话 A        │ ┌ #47  2.4s · LLM 1.9s · 3 工具 ┐│
│   会话 B        │ │ ctx 18 条/42k 字 · 1.2k→340tok││
│   会话 C        │ │ ▾ load_skill  210ms  ok       ││
│                 │ │ ▾ snapshot     88ms  ok       ││
│                 │ └ outcome: done ────────────────┘│
│                 │ ┌ #46  ...                       │
└─────────────────┴──────────────────────────────────┘
```

左栏：`listConversations()` 直出，显示标题、相对时间、状态点。不显示轮数/消息数（见非目标）。

右栏头部：会话标题、状态、消息数、trace 覆盖的轮次范围。消息数从 `getConversation(id).messages.length` 取。

### 6.3 轮次时间线

每轮一个折叠块。**折叠头**（一行，`.mono` 承载机器语言）：轮次序号、总耗时、LLM 耗时、token 变化、工具数、outcome 令牌。outcome 用颜色区分（`done` 中性、`paused`/`error` 警示、`aborted` 弱化、`truncated-retry` 提示色）。

**展开体**分四段：

1. **上下文** — 消息条数 / 字符数 / 是否带摘要 / 技能条数 / 系统提示词长度 / 页面 URL
2. **LLM** — TTFT、总耗时、finishReason、usage 明细、正文与 reasoning 字符数、error
3. **工具** — 每行：名称、参数字节数、耗时、成败、summary；失败行展开显示 error
4. **压缩** — 仅当本轮触发：耗时、成败、压缩后 promptTokens

折叠态默认收起，最近一轮默认展开。

### 6.4 原始消息流

逐条渲染 `ChatMessage[]`：role 标签 + 正文（user/assistant 走 `components/chat/Markdown.tsx`）+ assistant 的 toolCalls（名称 + 参数 JSON）+ tool 消息（名称 + 内容，长内容折叠）。不做与聊天界面像素级一致，只求可读。

trace 与消息流的对账靠 `toolCallId` / `callId` 对齐，以及轮次时间戳。

### 6.5 降级与空态

- **trace 被裁剪**：时间线头部提示「trace 仅保留最近 200 轮，更早的轮次请查看原始消息流」。裁剪与否由 `seq > turns.length` 判定。
- **会话无 trace**（本设计上线前产生的历史会话，或从未跑过 loop）：时间线区显示空态并引导切到原始消息流。
- **会话不存在**：URL 里的 `convId` 查不到 → 右栏显示「会话不存在或已删除」，左栏正常可用。
- **自动跟随**：`storage.watch` 订阅目标会话的 conv key 与 trace key；loop 每轮 commit 触发重读。开关关闭时只在选中会话时读一次。

## 7. 入口层

`SettingsHome.tsx`：

```ts
export type SettingsSub = 'model' | 'prompt' | 'memory' | 'toolbench'
  | 'scriptdebug' | 'skills' | 'about' | 'convdebug';

type Entry = { key: SettingsSub; title: string; desc: string; Icon: typeof SlidersHorizontal; tabUrl?: string };
```

「开发者工具」组新增：

```ts
{ key: 'convdebug', title: 'AI 会话调试', desc: '会话历史与 agent loop 调用记录（新标签页打开）', Icon: Activity, tabUrl: '/conv-debug.html' }
```

并导出 `TAB_ENTRIES: Partial<Record<SettingsSub, string>>`（由 GROUPS 派生，只收带 `tabUrl` 的条目），供壳查表。

`SettingsView.tsx`：

```tsx
const open = (sub: SettingsSub) => {
  const url = TAB_ENTRIES[sub];
  if (url) {
    // fire-and-forget，对齐仓内 `void browser.tabs.create(...)` 风格
    void getCurrentConvId().then((convId) => openExtensionTab(url, { convId }));
    return;
  }
  setSub(sub);
};
```

`stores/extension-tabs.ts`：

```ts
openExtensionTab(path: string, opts?: { convId?: string | null }): Promise<void>
```

- 拼出目标 URL（带 `?convId=` 时附上，让调试页默认停在你正在看的会话）
- `browser.tabs.query({ url: browser.runtime.getURL(path) + '*' })` 命中 → `tabs.update(tabId, { url, active: true })`
- 未命中 → `tabs.create({ url, active: true })`

图标用 `lucide-react` 的 `Activity`（禁止 emoji）。

## 8. 测试

| 文件 | 覆盖 |
|---|---|
| `tests/storage/traces.test.ts` | 环形裁剪保最旧/最新边界；`seq` 跨裁剪单调；`readTraces` 对缺失 key 返回空壳；`clearTraces` |
| `tests/agent/trace.test.ts` | `summarizeContext` 的字符数与条数统计（含 toolCalls、附件数组消息）；recorder 各 mark 方法填入的字段；`commit` 补 `endedAt`；写入失败被吞掉 |
| `tests/agent/loop-trace.test.ts` | `drive` 的 9 处出口各自 commit 出正确 `outcome`；截断重试路径产出 `truncated-retry` 且下一轮新建 recorder；工具记录条数与 callId 对齐；熔断路径带 `guardReason` |
| `tests/convdebug/utils.test.ts` | 时间线投影：`seq > turns.length` 判定为裁剪；耗时/token/相对时间格式化；空 trace 空态 |
| `tests/settings/tab-entries.test.ts` | `TAB_ENTRIES` 与 GROUPS 中带 `tabUrl` 的条目一致（防止两处漂移） |

`tests/agent/loop-trace.test.ts` 复用既有的 mock provider / executeTool 基建（见 `tests/agent/` 现有用例），断言 trace 落盘内容而非 UI。

## 9. 风险与取舍

- **`drive()` 的出口数量**：9 处显式赋值 `outcome` 是漏改风险点。缓解：默认值 `'error'` 作绊线 + `loop-trace.test.ts` 逐出口断言。
- **每轮一次额外 storage 读**（取 `seq`）：相对一次 LLM 调用可忽略。若将来成为热点，可把 `seq` 缓存进 collector 并仅在 SW 冷启动时重读。
- **`storage.watch` 首次在本仓使用**：wxt 0.21 经 `@wxt-dev/storage` 导出，已确认存在。若实测在标签页上下文行为异常，退化为「选中会话时读一次 + 手动刷新按钮」，页面其余部分不受影响。
- **trace 写失败静默**：quota 打满时丢该轮 trace 而不阻断 loop——调试设施不该有能力搞挂主流程。
