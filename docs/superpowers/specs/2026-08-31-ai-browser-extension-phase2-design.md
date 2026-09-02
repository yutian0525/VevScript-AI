# AI Browser Extension — Phase 2 设计文档（Agent 核心）

- 日期：2026-08-31
- 状态：已确认（用户逐节认可）
- 项目根：`d:\workspace-mou8\ai-browser-extend`
- 上游规格：[2026-08-28-ai-browser-extension-design.md](./2026-08-28-ai-browser-extension-design.md)（总设计 §7 Phase 2）
- 依赖：Phase 1（[phase1 计划](../plans/2026-08-28-ai-browser-extension-phase1.md)）冻结的接口契约

---

## 1. 目标与范围

实现自研 agent 核心，让侧边栏能真正驱动模型操控当前标签页。Phase 2 交付一条端到端可用的最小闭环：

**用户在侧边栏输入 → background agent loop 调模型 → 模型调工具看/操作页面 → 结果回填续推 → 流式回复渲染到侧边栏。**

**范围内**：

- Agent loop 状态机（无硬上限 + 熔断阀 + 每轮持久化 + 暂停/恢复）。
- Provider 回调 → Promise 的单轮适配层（run-turn）。
- 完整 a11y 树快照生成器（`take_snapshot`）。
- 交互工具：`click` / `fill` / `fill_form` / `hover` / `scroll` / `press_key`。
- 导航工具：`navigate_page`（url/back/forward/reload）。
- 等待工具：`wait_for`。
- Content script：快照管线 + 交互执行 + 握手/存活探测（静态注册，导航自动重注入）。
- sidepanel ↔ background 的 long-lived Port 流式协议。
- `storage/sessions.ts` 会话持久化（Phase 1 只留骨架）。
- 会话页 UI（`ChatView`）：消息流 + 流式渲染 + 工具调用卡片 + 输入框 + 停止按钮。

**范围外（后续 Phase）**：

- `take_screenshot` / `evaluate_script` / 网络双通道 / `http_request` / `list_console_messages` / tabs 管理 → Phase 3。
- 脚本池 CRUD + 注入引擎 + AI 工具 → Phase 4。
- keepalive 完备化、SW 被杀的完整恢复演练、E2E 进 CI → Phase 5。
- LLM 摘要式 compaction（Phase 2 用简单截断顶替）。
- closed shadow DOM、跨域 iframe 快照。

### 已确认的关键决策

| 决策点 | 结论 |
|---|---|
| Loop 终止 | 无硬上限（去掉"最多 N 步"一刀切）+ 熔断阀（打转/连续错误/软预算，触发时暂停问用户而非硬杀） |
| 快照精度 | 完整 a11y 树（role/name/state + 隐藏过滤 + uid 映射 + 折叠 + same-origin iframe + open shadow DOM） |
| 流式传输 | sidepanel ↔ background 用 long-lived Port（`runtime.connect`）；cs ↔ bg 继续用 sendMessage 请求/响应 |
| Provider 适配 | 复用 Phase 1 冻结的回调式 `Provider.streamChat`，包一层 run-turn 适配为 Promise |
| token 溢出 | Phase 2 用简单截断（保留 system + 首条 user + 最近 N 条），不做 LLM 摘要 |
| content script 注册 | 静态声明 `<all_urls>` + allFrames + document_idle，导航后浏览器自动重注入 |
| 协议演进 | 对 Phase 1 冻结类型只做"扩展新增"，不改已冻结签名 |
| click 回附快照 | `includeSnapshot` 可选，默认关（省 token），模型需要时显式传 true |

### 借鉴 pi harness 的要点（来自子代理探索 `D:\workspace-mou8\pi`）

- **纯数据驱动退出**：pi 无任何 max-turns/max-steps，靠"无 tool_calls / 出错 / abort / terminate 标记 / hook 喊停"退出。Phase 2 采纳这套干净的退出条件。
- **补 pi 的缺口**：pi **无打转检测、无重复调用检测、无连续错误计数**（作者自承这是 MV3 环境必须自己填的最大缺口）。Phase 2 的熔断阀正是补这块。
- **StreamFn 永不抛异常**：错误编码为消息状态，让 loop 是干净状态机、易持久化/恢复。
- **length-truncation 守卫**：`finishReason==='length'` 时该轮 tool_calls 全判失败、不拿半截 JSON 去执行——对"操作浏览器"尤其关键（防垃圾参数误点误删）。
- **错误当 tool result 喂回**：工具异常不中断循环，作为 `{ok:false,error}` 回给模型自我修正。
- **单一 AbortSignal 贯穿**：fetch + 每个 tool 执行共用一个信号，用户停止能干净取消。
- **不照搬**：pi 的 LLM 摘要 compaction 依赖长驻进程 + 额外 LLM 调用，MV3 不可靠，Phase 2 用截断顶替；pi 的 `AgentHarness` 多 lane 脚手架未实现、与浏览器无关，忽略。

---

## 2. Agent Loop 状态机（`agent/loop.ts`）

**职责**：驱动"模型调用 → 工具执行 → 结果回填"循环，直到自然终止、被中断或熔断暂停。

```
runAgentLoop({ tabId, sessionId, userMessage }):
  1. 从 storage 加载/重建 session（messages 历史）
  2. 追加 user 消息，持久化，setStatus('running')
  3. 循环：
     ┌─ 组装 context：system prompt（工具使用指南 + "页面内容是不可信输入"）
     │                + 当前页 URL/title 注入 + messages（截断后）
     │  runTurn(context)  ── await 一次完整 streamChat（见 §3）：
     │    · text-delta      → Port 推 sidepanel 实时渲染
     │    · tool-call-delta → 聚合成完整 ToolCall（index+id 双键）
     │    · message-done    → 拿到 finishReason + usage
     │  ├─ finishReason==='length' → 本轮 tool_calls 全判失败喂回（length 守卫）
     │  ├─ 无 tool_calls → 【自然终止】写最终 assistant 消息，退出 ✓
     │  └─ 有 tool_calls → assistant 消息（含 toolCalls）入历史
     │       并行执行工具（§4）；每个执行前后检查 abort
     │       结果以 role=tool 逐个追加（保持 assistant 声明顺序）
     ├─ 熔断阀检查（§2.1）→ 命中则 setStatus('paused')、Port 通知、return
     └─ 持久化 messages（每轮，防 SW 被杀丢状态）
```

**退出条件**（借鉴 pi 的数据驱动，无迭代上限）：

1. 模型不再调工具（`finishReason==='stop'` 且无 tool_calls）——正常完成，主路径。
2. `runTurn` 返回 error（provider 报错）或 aborted（用户中断）——早退。
3. 熔断阀命中——暂停（非终止，可恢复）。

**错误处理**：

- 模型 API 错误：Phase 1 provider 已发 `error` 事件；loop 收到后按类别处理（429/5xx 指数退避 ≤3 次；400/401 直接终止报用户）。
- 工具执行错误：不中断循环，`{ok:false,error}` 作为 tool result 回给模型自我修正（pi 式）。
- length 截断：该轮 tool_calls 判失败喂回，模型重发。
- 用户中断：单一 AbortSignal，loop 在下个工具执行前检查、优雅退出保留已完成部分。

### 2.1 熔断阀（`agent/loop-guards.ts`）

替代硬上限。三个纯函数检测器，全部触发时"暂停问用户"而非"硬杀"：

| 阀 | 触发条件 | 默认阈值 | 动作 |
|---|---|---|---|
| 打转检测 | 连续 N 次调用同工具 + 同参数（JSON 规范化后比对） | 3 | 首次注入提示"你在重复，换策略或说明卡点"；再触发则暂停 |
| 连续错误熔断 | 连续 M 次 tool result 全 `ok:false` | 5 | 暂停，Port 弹"连续失败，继续/停止" |
| 软预算 | 步数 ≥ S 或累计 token ≥ T | 步数 50 / token 由 usage 累加 | 暂停弹"已执行 X 步/消耗 Y token，继续吗" |

阈值默认写在代码常量，`storage/settings.ts` 的 `AgentConfig` 后续可暴露为用户可配（Phase 2 先用常量，接口预留）。

### 2.2 暂停 / 恢复原语

暂停时：`setStatus('paused')` 持久化当前 messages → Port 通知 sidepanel 弹确认卡 → loop return（不占 SW）。

恢复：用户在 sidepanel 点"继续" → 发 `agent:resume` → `resumeAgentLoop(sessionId)` 从持久化 session 续跑（重置对应熔断计数或提高阈值一次）。

**这套暂停/恢复是同一套原语，三处复用**：熔断阀暂停、脚本池确认门控（Phase 4 §3b）、SW 被杀后恢复（Phase 5 §6）。Phase 2 先实现熔断阀这一处，接口按三处通用设计。

---

## 3. Provider 单轮适配（`agent/run-turn.ts`）

Phase 1 冻结的 `Provider.streamChat(params, onEvent) → {cancel}` 是**回调式**，不是 async iterator。loop 每步需要"跑完一次流直到 message-done/error"的 Promise 语义，故包一层适配：

```ts
interface TurnResult {
  text: string;                 // 完整助手文本
  toolCalls: ToolCall[];        // 聚合完成的工具调用
  finishReason?: string;
  usage?: Usage;
  error?: string;
}

runTurn(provider, params, { onTextDelta }): Promise<TurnResult>
```

内部：订阅 `onEvent`，`text-delta` 转发给 `onTextDelta`（→ Port）并累加；`tool-call-delta` 按 index 聚合 args 字符串、记 id/name；`message-done` → resolve；`error` → resolve（带 error 字段，**不 reject**，保持 loop 是干净状态机，pi 式）。持有 `cancel`，abort 时调用。

**不改 Phase 1 的 `Provider` / `StreamEvent` / `ChatParams` 冻结签名**——run-turn 是纯消费侧胶水。

---

## 4. 工具层（`agent/tools/`）

**两层结构**（总设计 §4.3）：

- **schema 层**（`registry.ts`）：每工具一个 Phase 1 冻结的 `ToolSchema`（OpenAI function calling 格式），描述对齐 chrome-devtools-mcp。导出 `getToolSchemas()`（拼进 `ChatParams.tools`）与 `getExecutor(name)`。
- **executor 层**：`execute(name, args, ctx:{tabId,sessionId,signal}) → Promise<ToolResult>`。分发：
  - **content script 类**（snapshot/click/fill/fill_form/hover/scroll/press_key/wait_for）→ `createRequest()` + `browser.tabs.sendMessage(tabId, req)`，`isResponseFor` 匹配响应（Phase 1 冻结的往返原语）。
  - **chrome API 类**（navigate_page）→ background 直调 `browser.tabs.update/reload/goBack/goForward`。
  - **执行前预检** `tab.url`：`chrome://`/`chrome-extension://`/Web Store/`about:` → 直接 `{ok:false,error:'无法操作受限页面'}`。

**Phase 2 工具清单（9 个）**：

| 工具 | 参数 | 路径 | 备注 |
|---|---|---|---|
| `take_snapshot` | verbose? | cs | 完整 a11y 树（§5） |
| `click` | uid, dblClick?, includeSnapshot? | cs | includeSnapshot 默认关 |
| `fill` | uid, value | cs | 原生 setter + input/change 事件 |
| `fill_form` | elements[{uid,value}] | cs | 批量 fill |
| `hover` | uid | cs | pointer events |
| `scroll` | direction, amount? | cs | window 或最近可滚动容器 |
| `press_key` | key, modifiers? | cs | 合成 KeyboardEvent |
| `navigate_page` | type:url/back/forward/reload, url? | bg | 导航后等 CS_READY（超时 15s 报错） |
| `wait_for` | texts[], timeoutMs? | cs | 轮询 innerText |

**ToolResult**：统一 Phase 1 冻结的 `{ok, data?, error?}`。错误一律返回不抛异常。

---

## 5. 快照生成器（`content/snapshot/`）

完整 a11y 树，拆成可测纯函数管线：

```
buildSnapshot(root=document.body, opts) →
  1. walk：DFS 遍历，每个 Element 算 { role, name, states }
     · role：显式 role 属性优先，否则 tagName→隐式 role 映射表
     · name：aria-label > aria-labelledby > <label for>/包裹 label > placeholder > alt > textContent（截断）
     · states：disabled / checked / expanded / selected / value
  2. 过滤隐藏：display:none、visibility:hidden、aria-hidden=true、hidden 属性、0 尺寸
  3. uid 分配：仅给可交互/有语义节点递增 uid；uid→WeakRef<Element> 存模块级 Map
  4. 折叠：每层 > 200 子节点、总节点 > 2000 → "… [N more]"
  5. 序列化：缩进 yaml 风格，如：
       [12] button "登录"
       [13] textbox "邮箱" placeholder="you@example.com"
       link "忘记密码?"       ← 纯展示节点可带、但不给 uid
  6. same-origin iframe：递归进入（深度受限），uid 命名空间加 frame 前缀
  7. open shadow DOM：.shadowRoot 递归；closed 跳过（backlog）
```

**uid 生命周期**：映射存 content script 模块级作用域，每次 `take_snapshot` **重置重建**。交互工具拿 uid 查 Map：命中 → `deref()` 拿元素、校验仍在 DOM → 执行；查不到/已脱离 → `{ok:false, error:'stale snapshot, please take_snapshot again'}`，模型据此自然重拍。页面导航销毁 content script → Map 随之清空，旧 uid 自动失效（符合 stale 语义）。

**序列化格式**：`[uid] role "name" 属性` 缩进文本，对齐 chrome-devtools-mcp 的 yaml 风格，兼顾 token 效率与模型可读性。

**拆 task 粒度**：walk+role/name 计算 / 隐藏过滤 / uid 映射+stale 处理 / 折叠+序列化 / iframe+shadow 递归——每块独立 jsdom 单测。

---

## 6. Content Script（`content/`）

```
content/
├── index.ts        # WXT content entry：注册 onMessage 处理器 + uid 映射持有者 + CS_READY 通知
├── snapshot/       # §5 快照管线
├── interact.ts     # click/fill/fill_form/hover/scroll/press_key 的 DOM 执行
└── wait.ts         # wait_for 轮询
```

**注册方式**：WXT content script 静态声明 `matches:['<all_urls>']`、`runAt:'document_idle'`、`allFrames:true`（iframe 快照需要）。静态注册 → 导航后浏览器**自动重注入**，无需 background 手动 executeScript 兜底。

**握手/存活探测**：content script 加载完向 background 发 `CS_READY` 通知（fire-and-forget）；`navigate_page` 执行后 `await` 该 tab 的 CS_READY（超时 15s 报错给模型，对齐总设计 §6）。

**交互执行细节**：

- `click`：scrollIntoView（若不在视口）→ 派发 pointerdown/mousedown/mouseup/click（dblClick 则加 dblclick）。
- `fill`：用原生 `HTMLInputElement.prototype.value` setter 绕过框架劫持 → 派发 input + change 事件（React 受控组件兼容）。
- `hover`：派发 pointerover/mouseover/mouseenter。
- `press_key`：合成 KeyboardEvent（keydown/keyup + modifiers）；受页面权限限制时降级直接派发。
- `scroll`：目标容器（就近可滚动祖先）或 window，按 direction/amount。

---

## 7. sidepanel ↔ background Port 协议 + 消息协议扩展

**Port（长连接）**：sidepanel `browser.runtime.connect({name:'agent'})`。

- sidepanel → bg：`agent:start {tabId,userMessage}`、`agent:stop`、`agent:attach {tabId}`（重连拉状态）、`agent:resume`。
- bg → sidepanel：`text-delta`、`tool-start {name,args}`、`tool-end {name,result}`、`paused {reason}`、`done {finalText}`、`error {msg}`。

Port 断开（sidepanel 关闭）**不中断 loop**——loop 在 background 继续跑并持久化；sidepanel 重开发 `agent:attach` 拉当前 session 状态重连。

**cs ↔ bg**：继续用 sendMessage 请求/响应（cs 不需长连接）。两套协议在 `shared/messages.ts` 分区共存。

**协议扩展（只新增，不改 Phase 1 冻结签名）**：

```ts
// BgToCsRequestMap 新增：
FILL_FORM: { elements: Array<{ uid: Uid; value: string }> };
// CLICK 已有，payload 加可选字段（向后兼容）：
CLICK: { uid: Uid; dblClick?: boolean; includeSnapshot?: boolean };

// 新增 cs→bg 通知（fire-and-forget，仿 CsToBgNotification）：
CS_READY: { url: string };

// 新增 Port 消息类型（独立分区，不属于 cs 协议）
```

---

## 8. 存储会话层（`storage/sessions.ts`）

Phase 1 只留骨架，Phase 2 填充：

```ts
interface Session {
  tabId: number;
  messages: ChatMessage[];              // Phase 1 冻结的 ChatMessage
  status: 'idle' | 'running' | 'paused';
  updatedAt: number;
}
getSession(tabId): Promise<Session>
saveSession(session): Promise<void>
appendMessage(tabId, msg): Promise<void>
setStatus(tabId, status): Promise<void>
```

key = `local:session:{tabId}`；每会话最近 200 条（图片消息裁剪，Phase 3 截图才用到）。**简单截断**：组装 context 时保留 system + 首条 user + 最近 N 条，超出丢弃（不做 LLM 摘要）。

---

## 9. 会话页 UI（`components/chat/ChatView.tsx`）

Phase 1 是占位，Phase 2 填充真实功能：

- 消息流：用户文本、AI 文本（流式渲染）、工具调用卡片（图标 + 名称 + 参数摘要 + 状态；点击展开参数/结果）。
- 工具卡片折叠态一行（如 `take_snapshot · 1.2s`），展开看完整参数与返回。用 lucide-react 线性图标（无 emoji，遵全局规则）。
- 输入框 + 发送；运行中显示"停止"按钮（发 `agent:stop`）。
- 暂停态：顶部横幅 + "继续/停止"（熔断阀触发时）。
- 会话跟随 active tab（`tabs.onActivated` 驱动，每 tabId 一个 session）。

Markdown 渲染在 Phase 2 可先用最小实现（纯文本 + 代码块），react-markdown 完整接入可延后。

---

## 10. 文件结构（Phase 2 新建/修改）

```
agent/
├── loop.ts               # 新建：agent 主循环状态机
├── loop-guards.ts        # 新建：熔断阀（打转/连续错误/软预算）
├── run-turn.ts           # 新建：Provider 回调 → Promise 单轮适配
├── context.ts            # 新建：system prompt + 页面信息注入 + 截断
└── tools/
    ├── registry.ts       # 新建：schema 注册 + executor 分发
    ├── schemas.ts        # 新建：9 个工具的 ToolSchema
    ├── page-snapshot.ts  # 新建：take_snapshot executor
    ├── page-interact.ts  # 新建：click/fill/fill_form/hover/scroll/press_key executor
    ├── page-navigate.ts  # 新建：navigate_page executor
    └── wait.ts           # 新建：wait_for executor
content/
├── index.ts              # 新建：WXT content entry
├── snapshot/             # 新建：快照管线（walk/role-name/filter/uid/serialize/frame）
├── interact.ts           # 新建：DOM 交互执行
└── wait.ts               # 新建：wait_for 轮询
storage/
└── sessions.ts           # 填充：会话读写（Phase 1 骨架）
shared/
└── messages.ts           # 扩展：FILL_FORM / CLICK.includeSnapshot / CS_READY / Port 消息类型
background/
└── agent-port.ts         # 新建：Port 连接管理 + loop 生命周期挂载
entrypoints/
└── background.ts         # 修改：接入 agent-port + tool router
components/chat/
└── ChatView.tsx          # 填充：消息流 + 流式 + 工具卡片 + 输入
stores/
└── chat.ts               # 新建：会话 UI 状态（zustand）
tests/                    # 各模块单元/集成测试
```

---

## 11. 测试策略（对齐总设计 §6b）

- **单元（Vitest + jsdom）**：快照管线每个纯函数、role/name 计算、隐藏过滤、折叠、uid stale 判定；熔断阀三个检测器；run-turn 适配器（mock Provider 发各种 StreamEvent 序列）；简单截断逻辑；context 组装。
- **集成（Vitest + fakeBrowser）**：loop 状态机全流程（mock provider + mock tabs.sendMessage，跑 snapshot→click→完成）；消息协议往返；sessions storage；暂停/恢复；受限页面预检。
- **E2E（手测清单，不进 CI）**：真实页面 take_snapshot→click→fill→wait_for 链路。

---

## 12. 风险与开放问题

| 风险 | 缓解 |
|---|---|
| SW 在暂停等待用户确认时被杀 | status='paused' 已持久化；sidepanel 重开 `agent:attach` 拉状态，点继续走 resume 重建 loop |
| 完整 a11y 树在重度 SPA 上质量参差 | uid stale 重试机制；Phase 3 的 evaluate_script 作逃生口 |
| 熔断阈值（3/5/50）不适配所有任务 | 常量起步，接口预留 AgentConfig 可配；暂停而非硬杀，用户可续 |
| 简单截断丢失早期上下文导致模型失忆 | 保留首条 user（任务目标）+ 最近 N 条；完整 compaction 记 backlog |
| Port 消息与 cs sendMessage 混淆 | 两套协议在 shared/messages.ts 分区、命名区分（Port 用 `agent:` 前缀） |
| React 受控组件 fill 不生效 | 原生 setter 绕框架劫持 + 派发 input/change（已在交互细节明确） |

**开放问题（实施阶段解决）**：快照折叠阈值微调；工具卡片展开的 UI 细节；Markdown 渲染是否 Phase 2 就上 react-markdown。

---

## 13. 与 Phase 1 冻结接口的关系

Phase 2 **消费**以下 Phase 1 冻结导出，不修改其签名：

- `shared/messages.ts`：`createRequest`、`isResponseFor`、`BgToCsRequest`、`CsToBgNotification`、`CsResponse`（本 Phase 对 `BgToCsRequestMap` 只新增键 `FILL_FORM`、给 `CLICK` 加可选字段、新增 `CS_READY` 通知——均为向后兼容扩展）。
- `agent/provider/types.ts`：`ChatMessage`、`ToolCall`、`ToolSchema`、`StreamEvent`、`ChatParams`、`Provider`、`ProviderConfig`（run-turn 是纯消费侧胶水，不改这些）。
- `agent/provider/openai-compat.ts`：`OpenAICompatProvider`（loop 通过它调模型）。
- `storage/settings.ts`：`getSettings`、`Settings`（读 provider 配置构造 Provider；AgentConfig 阈值 Phase 2 用常量、接口预留可配）。
- `shared/types.ts`：`ToolResult`、`TabInfo`、`Uid`。

**Phase 2 冻结给 Phase 3+ 的新契约**（签名此后不变）：

- `agent/tools/registry.ts`：`getToolSchemas()`、`getExecutor(name)`、`registerTool(schema, executor)`。
- `agent/loop.ts`：`runAgentLoop(args)`、`resumeAgentLoop(sessionId)`。
- `storage/sessions.ts`：`getSession`、`saveSession`、`appendMessage`、`setStatus`、`Session`。
- `content/index.ts` 的消息处理契约：每个 `BgToCsRequest.type` 对应一个返回 `ToolResult` 的处理器。
- Port 协议消息类型（`shared/messages.ts` 的 Port 分区）。

