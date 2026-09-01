# 多会话管理 + 输入框重构 + 上下文压缩 设计文档

- 日期：2026-09-01
- 状态：已确认（用户逐节认可）
- 项目根：`d:\workspace-mou8\ai-browser-extend`
- 关联设计：`docs/superpowers/specs/2026-08-28-ai-browser-extension-design.md`（§8 会话存储、§4.6 侧边栏 UI）

---

## 0. 目标

三件事，围绕「会话」这个实体展开：

1. **多会话管理**：会话升为独立一等实体（不再按标签页绑定），持久化 + 列表管理（新建/切换/重命名/删除）。侧边栏默认打开是一个空的新会话，会话之间上下文隔离。
2. **输入框重构**：主体回归干净（textarea + 环形指示器 + 发送键）。环形指示器兼作上下文用量标识与压缩按钮。每轮 token 用量在消息下方弱化标注。
3. **上下文压缩**：LLM 智能摘要（B1），到阈值自动 + 手动点击双触发（C2）。上限来自「内置模型窗口映射表 + 设置页可覆盖」（D3）。

### 关键决策速查

| 决策点 | 结论 | 代号 |
|---|---|---|
| 会话与标签页关系 | 会话彻底独立于标签页；标签页只做 agent 运行时的操作目标 | A |
| 会话是否持久化 | 持久化 + 会话列表管理（新建/切换/重命名/删除） | A2 |
| 会话列表入口 | 顶部下拉抽屉 | E1 |
| 压缩方式 | LLM 智能摘要（前情摘要替换旧消息） | B1 |
| 压缩触发 | 自动（≥80% 阈值）+ 手动（点环） | C2 |
| 上下文窗口来源 | 内置模型映射表兜底 + 设置页可覆盖 | D3 |
| 保留边界 | 近 20 条原始消息不摘要 | — |
| 每轮 token 展示 | 消息下方弱化 mono 标注 `↑输入 ↓输出` | 追加需求 |

---

## 1. 会话模型与存储层

### 1.1 数据模型

会话升为独立实体，不再挂 tabId：

```ts
interface Conversation {
  id: string;              // nanoid，存储主键
  title: string;           // 首条用户消息截取，或用户重命名
  messages: ChatMessage[]; // 完整历史（含被摘要覆盖的原始消息，供 UI 回看）
  status: 'idle' | 'running' | 'paused';
  createdAt: number;
  updatedAt: number;
  // —— 上下文计量与压缩 ——
  lastPromptTokens?: number;                       // 最近一轮真实发出的 token（来自 usage）
  summary?: { text: string; coversUpTo: number };  // 前情摘要 + 覆盖到第几条原始消息（index）
}

// 列表元数据（conv-index），供列表 UI 快速渲染，不必全量读会话
interface ConversationMeta {
  id: string;
  title: string;
  updatedAt: number;
  status: 'idle' | 'running' | 'paused';
}
```

### 1.2 存储层改造

`storage/sessions.ts` → `storage/conversations.ts`：

| key | 内容 | 说明 |
|---|---|---|
| `local:conv:{id}` | `Conversation` | 单会话全量（含 messages） |
| `local:conv-index` | `ConversationMeta[]` | 会话列表元数据，按 updatedAt 倒序 |

API（对齐现有 sessions.ts 风格）：

- `getConversation(id): Promise<Conversation>`
- `saveConversation(conv): Promise<void>`（同步更新 conv-index 对应项）
- `appendMessage(id, msg): Promise<void>`（最近 200 条裁剪，保留现有 `MAX_MESSAGES` 语义）
- `setStatus(id, status): Promise<void>`
- `createConversation(): Promise<Conversation>`（新建空会话 + 写 index）
- `renameConversation(id, title): Promise<void>`
- `deleteConversation(id): Promise<void>`（删会话 + 移除 index 项）
- `listConversations(): Promise<ConversationMeta[]>`（读 conv-index）

**标题生成**：首条用户消息发出时，取其前 ~30 字作为 title 写入 index（用户后续可重命名覆盖）。

### 1.3 数据迁移

现处 Phase 1 骨架期，旧 `local:session:{tabId}` 是按 tabId 碎的调试数据。**直接弃用**：首次启动检测到旧 `local:session:*` key 就清掉，不做复杂迁移。

### 1.4 agent 运行时：tabId 两角色拆分

现状 tabId 同时承担两个角色——存储 key + agent 操作目标（`loop.ts` 的 `startTabId`）。拆开：

- **存储 key**：`convId`。`agent:start` 消息从 `{ tabId, userMessage }` 改为 `{ convId, tabId, userMessage }`。
- **操作目标**：发消息那一刻取当前活动标签页（复用 `ChatView.activeTabId()` 逻辑），作为 loop 的 `startTabId`/`targetTab`。会话历史写进 `convId`，与标签页彻底解绑。
- **并发闸门**：`background/agent-port.ts` 的 `runningTabs: Map<number, AbortController>` 改为 `runningConvs: Map<string, AbortController>`（按 convId），支持多会话并行跑在不同标签页。`agent:stop` / `resolveOpenedTab` 等按新键调整。
- `loop.ts` 的 `LoopArgs.sessionId`（现硬编码 `'main'`）改为真实 `convId`；`storage` 调用全部改指 `convId`。

---

## 2. 会话管理 UI（E1 顶部下拉抽屉）

### 2.1 入口

会话页页眉（`PageShell` title 区）改造：

```
┌────────────────────────────────────────┐
│ AGENT                          [+] [◉]  │  ← eyebrow + 新建 + Gauge
│ 帮我点掉 cookie 弹窗  ▾                  │  ← 当前会话标题（可点开下拉）
├────────────────────────────────────────┤
```

- 当前会话标题变可点按钮 + 下拉箭头（`ChevronDown`）。
- 右侧新增「新建会话」图标按钮（`SquarePen`）。
- 列表为空（首次用）时不显示下拉箭头，只有新建按钮。

### 2.2 下拉抽屉

点标题展开的浮层，盖在对话区上方：

- 顶部「新建会话」条目。
- 会话列表：每行 `标题 · 相对时间`；运行中的带状态点（`dot--running`）；当前会话高亮（`signal-wash`）。
- 每行 hover 显形操作：重命名（行内变输入框）、删除（`Trash2`）。删当前会话则自动切到最近一条，若已无会话则开一个空新会话。
- 点空白 / Esc 收起。
- 最大高度约 60% 视口，超出内部滚动。

### 2.3 默认新会话

侧边栏打开时**不再自动加载活动标签页历史**，而是开一个空的新会话（符合「默认打开是新对话」）。历史会话都在下拉里，用户主动点才切回。

### 2.4 状态管理

新增 `stores/conversations.ts`（或并入 `stores/ui.ts`）：当前 convId、下拉开合、会话列表（ConversationMeta[]）。

切会话流程：当前 store.messages 落库 → 读目标会话 `loadFromStorage` → 渲染。`stores/chat.ts` 的 `loadFromStorage`/`reset` 复用。

---

## 3. 输入框重构

### 3.1 布局

主体回归干净：textarea + 环形指示器 + 发送/停止键。

```
┌────────────────────────────────────────┐
│ 输入指令…                               │ ← textarea
│                              ◔    [ ▶ ] │ ← 环 + 发送/停止
└────────────────────────────────────────┘
     hover ◔ ┌─────────────────┐
             │ 上下文 62%       │
             │ 79k / 128k tokens│
             │ 点击压缩历史      │
             └─────────────────┘
```

### 3.2 环形指示器（= 压缩按钮）

发送键左侧，约 28px 圆，SVG 环形进度（`stroke-dasharray` 按比例填充）：

- **占比** = `lastPromptTokens / 模型窗口`。底环灰（`--line`）+ 前环按比例填充。
- **颜色分档**：`<80%` 中性（`--ink-3`）/ `≥80%` 警示（`--warn`）/ `≥95%` 红（`--err`）。颜色即信息，贴合设计系统「单一信号色」克制原则。
- **hover** tooltip：`上下文 62% · 79k/128k tokens · 点击压缩历史`。分子未知时：`上限 128k · 点击压缩`。
- **点击** = 直接触发压缩（§4）。压缩中环转 loading spin，禁用点击。
- **阈值提示**：≥80% 环变 `--warn` + 极轻微脉冲（复用 `pulse` keyframe，`prefers-reduced-motion` 兜底静止），无弹窗打扰。
- **不可用态**：会话空 / 无历史时环置灰、不可点（无可压内容）。

### 3.3 每轮 token 用量

每条 assistant 消息结束后，下方一行极小 mono 标注 `↑79k ↓1.2k`（`ArrowUp`/`ArrowDown` 图标 + 数值），`--ink-3` 弱化，不抢视线。

- `stores/chat.ts` 的 `ChatItem` 加 `usage?: { prompt?: number; completion?: number }`。
- `applyEvent` 在收到新增 `usage` 事件时，挂到最后一条 assistant 项。

### 3.4 输入禁用态

`running` 时 textarea 灰掉（现状保留）；压缩中也灰掉 + 环 spin。

---

## 4. 上下文压缩（B1 智能摘要 + C2 自动/手动）

### 4.1 核心思路

摘要 = 把旧消息折叠成一段前情文本，塞进上下文顶部替代原始旧消息发给 LLM；**原始消息在会话里完整保留**，UI 照常回看。

### 4.2 触发（C2）

- **手动**：点环 → 面板发 `agent:compact { convId }`。
- **自动**：loop 每轮拿到 `result.usage.promptTokens` 后算占比 = `promptTokens / 模型窗口`；`≥80%` 且当前不在压缩中 → 下一个安全点（工具执行完、进下一轮 LLM 调用前）自动跑一次摘要。自动只在「新一轮开始前」触发，不打断进行中的工具链。

### 4.3 摘要流程（`agent/compact.ts`）

1. 取会话历史，切成「要摘要的旧段」+「保留的近段」。**保留边界 = 最近 20 条原始消息不动**，更早的进摘要段。
2. 若已有 `summary`：把「旧 summary + 新增旧段」一起喂——增量摘要，不重复总结已摘过的。
3. 调一次 LLM（复用 provider，独立 system prompt：「你是上下文压缩器，把以下对话浓缩成简洁的前情摘要，保留：任务目标、已完成的关键操作、重要发现/数据、待办；丢弃：冗余的工具原始输出、寒暄」）。摘要文本不进对话流，只存 `summary`。
4. 写回会话：`summary = { text, coversUpTo: 旧段最后一条的 index }`。原始 messages 不删。

### 4.4 上下文组装改造（`agent/context.ts`）

- 有 `summary`：`[system, { role:'user', content:'【前情摘要】'+summary.text }, ...coversUpTo 之后的原始消息]`。
- 无 `summary`：走现有 `truncateMessages` 逻辑（兜底不变）。
- 摘要段里的图片仍走 `trimImageParts` 清理。

### 4.5 模型窗口来源（D3）

- 新增内置映射表（model 名 → 窗口 tokens）：如 `gpt-4o→128k`、`deepseek→64k`、`claude→200k`……匹配不到给默认值（128k）。
- `storage/settings.ts` 的 `ProviderConfig` 新增可选 `contextWindow?: number`；设置页加「上下文窗口」输入框。匹配到映射时自动填占位，用户可覆盖。
- 计量取值优先级：`settings.provider.contextWindow` > 映射表匹配 > 默认 128k。

### 4.6 边界与防护

- 摘要本身占 token；连续增量摘要后若仍逼近上限，`truncateMessages` 作为最终兜底（永不真的爆）。
- 摘要 LLM 调用失败：不阻断主流程，环恢复常态 + 轻提示「压缩失败，可重试」，原始上下文照常用。
- 压缩中用户发新消息：禁用输入 + 环 spin，等压缩完。
- `agent:compact` 与运行中 loop 互斥：running 时不允许手动压缩（等这轮结束），避免并发改会话。

### 4.7 UI 反馈

- 压缩开始 → 环 spin；完成 → 环刷新到新占比（明显回落）。
- 会话流可选插一条极简系统提示行「已压缩早期历史」（`--ink-3` 弱化）。

### 4.8 协议改动

`shared/messages.ts`：

- `PortMsgFromPanel` 新增 `{ type: 'agent:compact'; convId: string }`；`agent:start` 载荷加 `convId`。
- `PortMsgToPanel` 新增：
  - `{ type: 'usage'; promptTokens?: number; completionTokens?: number }`
  - `{ type: 'compact-start' }`
  - `{ type: 'compact-done'; newPromptTokens?: number }`
- loop 每轮 `runTurn` 拿到 `result.usage` 后 emit `usage` + 存 `lastPromptTokens`。

---

## 5. 测试策略

沿用现有 vitest + jsdom 单测风格（对齐 `tests/agent/loop.test.ts`、`tests/storage/sessions.test.ts`）。

### 5.1 纯逻辑单测（新增）

- `storage/conversations.ts`：CRUD + conv-index 维护（新建/切换/重命名/删除/删当前会话后回退）、旧 key 弃用。
- `agent/context.ts`：`buildContext` 在「有 summary」时的组装（摘要块在顶、只带 coversUpTo 之后的原始消息）；无 summary 走旧 truncate 路径不回归。
- `agent/compact.ts`：切段逻辑（近 20 条边界）、增量摘要拼接（旧 summary + 新旧段）、摘要失败时不改会话。
- token 占比档位纯函数：`<80% / ≥80% / ≥95%` 分档。
- 模型窗口取值优先级：settings 覆盖 > 映射 > 默认。

### 5.2 loop 集成（扩现有 mock provider 测试）

- usage 接线：mock provider 返回带 usage 的 message-done → loop emit `usage` + 写 `lastPromptTokens`。
- 自动压缩触发：mock 一轮 promptTokens 超 80% 窗口 → 下一轮前触发 compact（mock 摘要 provider 调用）。
- 多会话并发闸门：`runningConvs` 按 convId 隔离，两会话可并行。

### 5.3 手测清单（不进 CI）

- 下拉抽屉新建/切换/重命名/删除 + 窄侧边栏空间表现。
- 环形指示器颜色分档、hover tooltip、点击压缩全链路、压缩后占比回落。
- 每轮 token 标注渲染。
- 默认打开是空新会话；会话间上下文确实隔离（A 会话看不到 B 的历史）。

### 5.4 不测

SVG 环像素渲染、tooltip 定位（视觉手测）。

---

## 6. 受影响文件清单

**新增**：

- `storage/conversations.ts`（替代 sessions.ts）
- `agent/compact.ts`（摘要流程）
- `agent/model-windows.ts`（模型窗口映射表 + 取值优先级）
- `stores/conversations.ts`（会话列表状态，或并入 ui.ts）
- `components/chat/ConversationMenu.tsx`（下拉抽屉）
- `components/chat/ContextRing.tsx`（环形指示器）

**改造**：

- `shared/messages.ts`（协议：convId、usage、compact 事件）
- `agent/loop.ts`（sessionId→convId、usage 消费、自动压缩钩子）
- `agent/context.ts`（summary 组装分支）
- `background/agent-port.ts`（runningConvs、agent:compact 处理、makeDeps convId）
- `entrypoints/background.ts`（旧 key 清理迁移）
- `storage/settings.ts`（contextWindow 字段）
- `components/settings/SettingsView.tsx`（上下文窗口输入框）
- `components/chat/ChatView.tsx`（默认新会话、页眉入口、输入框重构、每轮 token）
- `stores/chat.ts`（ChatItem.usage、applyEvent usage 分支）
- `entrypoints/sidepanel/App.tsx`（会话页眉集成）
- `entrypoints/sidepanel/styles.css`（下拉抽屉、环形指示器、token 标注样式）

**弃用**：

- `storage/sessions.ts`、`tests/storage/sessions.test.ts`（迁移到 conversations）
