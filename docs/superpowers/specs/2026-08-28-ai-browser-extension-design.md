# AI Browser Extension（AI 浏览器操控扩展）设计文档

- 日期：2026-08-28
- 状态：已确认（用户逐节认可）
- 项目根：`d:\workspace-mou8\ai-browser-extend`

---

## 1. 目标与定位

一个 Chromium 浏览器扩展（Manifest V3），提供 **AI 对话侧边栏 + 自研 agent harness**，让 AI 能够：

1. **操控浏览器**：读取页面 DOM（a11y 树快照）、截图、点击/滚动/hover/填表/按键、执行脚本、读取与发起网络请求、导航/刷新页面。
2. **管理脚本池**：类 Tampermonkey 的脚本管理器；AI 能为页面增/删/改/启用/禁用脚本（经用户确认门控）。
3. **记忆池（延后）**：agent 按需记忆内容、用户可编辑，拆分临时记录与长期记忆。MVP 不实现，架构预留接口。

**非目标（MVP 明确不做）**：

- CDP（chrome.debugger）驱动的全能力（网络拦截/改写、性能 trace、Lighthouse、内存快照）。
- Firefox/Safari 适配。
- 记忆池（延后到 backlog）。
- 云端后端、账号体系、计费。
- 环境模拟（视口/弱网/地理位置伪装）。
- 文件上传、拖拽交互。

### 已确认的关键决策

| 决策点 | 结论 |
|---|---|
| AI 接入 | 用户自带 API Key，仅 OpenAI 兼容协议（自定义 baseURL + key + model），架构预留 Anthropic 适配器 |
| 平台 | 仅 Chromium（MV3），Chrome/Edge/Brave |
| 技术栈 | WXT + React + TypeScript |
| 浏览器控制路径 | 混合 API（content script + chrome.scripting + chrome.tabs + webRequest），不用 CDP |
| 会话模型 | 每标签页独立会话，切换标签页侧边栏跟随 |
| Agent 实现 | 纯自研 agent loop（无 LangChain/Vercel AI SDK 依赖，只用原生 fetch 调 OpenAI 兼容 API） |
| 工具集 | 参考 chrome-devtools-mcp 语义，MVP 实现"核心 + 标签页管理"子集（详见 §5） |
| 网络观察 | webRequest + 页面 fetch/XHR hook 双通道 |
| 脚本执行唤起 | 同步等待结果（脚本 await，完成后结果作为 tool result 回给 agent 继续） |
| 脚本池安全 | 确认门控 + 同页权限（AI 改脚本需用户在 UI 确认 diff；不做伪沙箱） |
| 记忆池 | 延后，预留 tool 接口 |
| UI | 浅色主题侧边栏 |

---

## 2. 总体架构

```
┌─────────────────────────────────────────────────────────────┐
│ Chromium                                                     │
│                                                              │
│  ┌────────────────┐  ┌──────────────────────────────────┐  │
│  │  Service Worker │  │  Side Panel (React app)          │  │
│  │  (background)   │  │  - 会话 UI / 流式渲染            │  │
│  │  - Agent Loop   │◄─┤  - 工具调用卡片                  │  │
│  │  - Tool Router  │  │  - 脚本池管理页                   │  │
│  │  - Provider 适配 │  │  - Provider 设置页               │  │
│  │  - 会话存储      │  └──────────────────────────────────┘  │
│  │  - 脚本池存储    │                                          │
│  └───────┬────────┘   ┌──────────────────────────────────┐  │
│          │            │  Content Scripts (每页面)         │  │
│          ├───────────►│  - a11y 快照生成器 + uid 标注     │  │
│          │            │  - 交互执行器（click/fill/hover…）│  │
│          │            │  - 网络观察 hook（fetch/XHR）      │  │
│          │            │  - 用户脚本注入（脚本池）          │  │
│          │            └──────────────────────────────────┘  │
│          │                                                    │
│          │            ┌──────────────────────────────────┐  │
│          ├───────────►│  chrome.tabs / scripting /        │  │
│          │            │  webRequest / storage.local       │  │
│          │            └──────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼ (fetch, 流式 SSE)
                    OpenAI 兼容 API（用户配置 baseURL）
```

**模块清单（WXT 目录结构）：**

```
ai-browser-extend/
├── wxt.config.ts
├── package.json
├── entrypoints/
│   ├── background.ts          # Service Worker：agent loop、tool router、消息中枢
│   └── sidepanel/             # 侧边栏（React）
│       ├── index.html
│       ├── App.tsx
│       └── ...
├── components/                # React 组件（共享）
│   ├── chat/                  # 会话流、消息气泡、工具卡片、输入框
│   ├── scripts/               # 脚本池管理 UI
│   └── settings/              # Provider 设置
├── agent/                     # 自研 harness（核心）
│   ├── loop.ts                # agent 循环：请求 → 工具调用 → 结果回填 → 循环
│   ├── tools/                 # 工具定义（OpenAI function calling schema）与执行器
│   │   ├── registry.ts        # 巙具注册表
│   │   ├── page-snapshot.ts   # take_snapshot
│   │   ├── page-interact.ts   # click/fill/hover/press_key/scroll
│   │   ├── page-navigate.ts   # navigate/reload/back/forward
│   │   ├── page-screenshot.ts
│   │   ├── script-exec.ts     # evaluate_script（同步等待结果）
│   │   ├── network.ts         # list_network_requests/get_network_request/http_request
│   │   ├── tabs.ts            # list/new/close/activate tabs
│   │   ├── wait.ts            # wait_for
│   │   ├── console.ts         # list_console_messages
│   │   └── script-pool.ts     # 脚本池 CRUD 工具（带确认门控）
│   │   └── memory.ts          # 预留：memory_write/memory_search（MVP 空实现或未注册）
│   ├── provider/              # LLM API 适配层
│   │   ├── types.ts           # 统一消息/流式事件/工具调用抽象
│   │   └── openai-compat.ts   # OpenAI 兼容实现（SSE 解析、tool_calls 增量聚合）
│   └── context.ts             # 上下文组装（system prompt、页面 URL/title 注入）
├── content/                   # content script 逻辑
│   ├── bridge.ts              # 与 background 双向消息协议
│   ├── snapshot/              # a11y 树 → 压缩文本快照 + uid 分配
│   ├── interact.ts            # 点击/填充/hover/滚动/按键的 DOM 执行
│   ├── net-hook/              # fetch/XHR/Response hook 与记录
│   └── userscript/            # 脚本池脚本的注入器
├── storage/                   # 持久化（chrome.storage.local 封装）
│   ├── sessions.ts            # 每标签页会话历史
│   ├── scripts.ts             # 脚本池
│   ├── settings.ts            # provider 配置（API key 用 chrome.storage.local，不进 sync）
│   └── network-log.ts         # 每标签页网络请求环形缓冲
├── shared/                    # 纯类型与协议定义（background/content/sidepanel 共享）
│   ├── messages.ts            # 消息协议类型
│   └── types.ts
└── docs/
    └── superpowers/specs/     # 本文档
```

**设计要点：**

- **agent loop 放 background service worker**，不放侧边栏：侧边栏可被关闭而不中断任务（短任务）；service worker 30s 空闲会被杀，长任务需要 keepalive（详见 §6）。
- **shared/ 放纯类型**，三个环境（background/content/sidepanel）共享同一消息协议，编译期保证一致。
- **工具执行器与工具 schema 分离**：schema 是给模型的声明（JSON Schema），执行器是运行时（分发到 content script 或 chrome API），registry 把两者绑定。

---

## 3. 数据流：一次典型的 agent 循环

以"帮我点掉这个页面的 cookie 弹窗"为例：

```
用户在侧边栏输入 → sidepanel
  │ (chrome.runtime.sendMessage: agent:start {tabId, userMessage})
  ▼
background: agent loop
  │ 1. 组装上下文（system prompt + 会话历史 + 当前页 URL/title）
  │ 2. fetch OpenAI 兼容 API（stream=true）
  │    ├── 文本增量 → 转发 sidepanel 渲染
  │    └── tool_calls 增量聚合
  │ 3. 对每个完成的 tool_call：
  │    ├── page-snapshot 类 → chrome.tabs.sendMessage(tabId, {type:'SNAPSHOT'})
  │    │     content script 生成 a11y 快照 + uid 标注 → 返回
  │    ├── click 类 → chrome.tabs.sendMessage(tabId, {type:'CLICK', uid})
  │    │     content script 查 uid→元素映射，scrollIntoView + dispatch click → 返回
  │    │     （回传 includeSnapshot 语义：交互后自动附新快照）
  │    ├── navigate → chrome.tabs.update / reload（background 直接执行）
  │    └── http_request → background fetch（受 CORS 时走 content script 代理）
  │ 4. tool results 拼回 messages → 回到 2，直到模型不再调工具（或达到步数上限）
  │ 5. 最终文本回复 → 持久化会话 → 通知 sidepanel 完成
  ▼
sidepanel 渲染最终回复 + 工具调用过程卡片（可展开看快照/截图）
```

**关键机制说明：**

- **快照 uid 机制**（对齐 chrome-devtools-mcp）：content script 对页面 a11y 树做深度受限遍历（跳过 display:none、限制子树数量），为每个可交互元素分配递增 uid；快照返回给模型的同时，uid→WeakRef<Element> 映射留在 content script 内存中；交互工具传 uid，content script 查映射执行。**页面发生结构性变化后 uid 可能失效，交互失败时返回"stale snapshot"错误，模型会自然重新 take_snapshot。**
- **截图**：chrome.tabs.captureVisibleTab（可视区域），返回 base64。作为独立的 `take_screenshot` 工具，与 DOM 快照分开，由模型按需调用（多模态模型可见图，纯文本模型也拿得到 base64 引用供 UI 展示）。
- **执行脚本重新唤起**：`evaluate_script` 工具的 function 以 `async` 方式在 content script 中执行（MAIN world 或 isolated world 可选），执行完成/超时后**结果作为该 tool call 的 result 返回**，agent loop 自动继续下一轮推理——"执行结束重新唤起 agent"在同步方案下天然成立，无需额外唤醒机制。
- **页面导航的会话连续性**：导航会销毁 content script。agent loop 在执行 navigate 后等待页面 load 完成、content script 重新注入，再继续（工具执行器内置等待逻辑）。

---

## 3b. 数据流：脚本池确认门控

AI 修改脚本池时（script-pool 工具），不能直接落库：

```
agent 决定调 create_script/update_script/delete_script/toggle_script
  → 工具执行器不立即执行，而是：
    1. 生成"待确认操作"对象（含脚本内容、匹配规则、diff）
    2. 持久化到 pendingOperations + 通知 sidepanel
    3. 返回 tool result："操作已提交，等待用户确认"（agent 停止循环或继续无害操作）
  → sidepanel 弹出确认卡（展示脚本全文/diff、目标 URL 匹配规则）
  → 用户点"批准/拒绝"
    ├── 批准 → 真正执行 CRUD → 通知 agent（下一次对话轮次生效）
    └── 滋绝 → 记录拒绝原因，agent 下一轮告知用户
```

---

## 3c. 数据流：网络观察双通道

```
通道 1：webRequest（background，全局观察）
  chrome.webRequest.onBeforeRequest/onCompleted/onErrorOccurred
  → 按 tabId 记录：URL、方法、资源类型、状态码、时间戳、耗时
  → 存入每标签页环形缓冲（上限 500 条，FIFO）

通道 2：页面 hook（content script，深度数据）
  在 MAIN world（或页面最早注入时机）hook window.fetch / XMLHttpRequest / Response.prototype.json
  → 记录：请求/响应头、请求/响应体（截断至 64KB）、堆栈采样
  → 通过 postMessage/CustomEvent 转发到 content script（isolated world）→ background

合并：list_network_requests 返回两通道按时间合并的视图
  get_network_request 返回单条详情（响应体只有通道 2 能提供）
```

**限制（设计上接受）**：webRequest 无法读响应体；hook 通道拿不到非 XHR/fetch 资源与 service worker 请求；hook 需要在页面脚本运行前注入（MAIN world content script `document_start`），个别站点 CSP 报警属预期。

---

## 4. 核心组件设计

### 4.1 Agent Loop（`agent/loop.ts`）

**职责**：驱动"模型调用 → 工具执行 → 结果回填"循环，直到模型停止调工具或触达上限。

```
输入：{ tabId, userMessage, sessionId }
状态：messages: Message[]（含 system + 历史 + 当前轮）

循环（maxSteps 默认 25）：
  1. context 组装：system prompt（工具使用指南）+ 当前页 URL/title + messages
  2. provider.streamChat(messages, tools)
  3. 流式事件分发：
     - text delta → 推给 sidepanel（实时渲染）
     - tool_call delta → 聚合（OpenAI 格式增量拼接 arguments 字符串）
  4. 若有 tool_calls：逐个执行（详见工具执行器），结果以 role=tool 追加
  5. 若无 tool_calls：循环结束，最终文本即回复
  6. 每步之后持久化会话（防 SW 被杀丢状态）
   循环结束后写入会话记录并通知 UI
```

**错误处理**：

- 模型 API 错误：按错误类别重试（429/5xx 指数退避 ≤3 次；400/401 直接报错给用户）。
- 工具执行错误：不中断循环，错误信息作为 tool result 返回（模型可自行调整策略）。工具错误是 agent 的正常输入，不是异常。
- 步数上限：达到后强制停止，回复用户"已达最大步数"，UI 显示已执行步骤列表。
- 用户中断：sidepanel 发 stop 信号，loop 在下一个工具执行前检查并优雅退出，保留已完成部分。
- SW 生命周期：每步持久化 + chrome.runtime keepalive（工具执行/流式传输期间的 ping）。若 SW 仍被杀，恢复策略见 §6。

### 4.2 Provider 适配层（`agent/provider/`）

**统一抽象**（`types.ts`）：

```ts
interface ChatParams {
  messages: ChatMessage[];      // 统一内部格式
  tools: ToolSchema[];
  stream: true;
  signal?: AbortSignal;
}
type StreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call-delta'; index: number; id?: string; name?: string; argsDelta?: string }
  | { type: 'message-done'; usage?: Usage; finishReason?: string };

class OpenAICompatProvider implements Provider {
  // fetch(baseURL + '/chat/completions', {stream:true})
  // SSE 逐行解析；tool_calls 增量聚合为完整调用后统一发出
}
```

- OpenAI 兼容意味着：`baseURL`、`apiKey`、`model` 全部用户可配（覆盖 OpenAI/DeepSeek/Qwen/Ollama/中转站）。
- **不做**多 provider 抽象的过度设计：`Provider` 接口只有一个实现（openai-compat），Anthropic 原生协议作为未来适配器加入时再扩展（接口已按最小需要设计）。
- 流式解析为手写 SSE 解析器（~100 行），不引入 SDK。

### 4.3 工具执行器架构（`agent/tools/`）

**两层结构**：

1. **schema 层**：OpenAI function calling 的 JSON Schema 定义（名称、描述、参数），描述文案对齐 chrome-devtools-mcp 的语义（模型经过相关训练，熟悉的工具名与参数风格能降低调用错误率）。
2. **executor 层**：`execute(toolName, args, ctx: {tabId, sessionId}) → ToolResult`。ctx 绑定当前会话的标签页。分发逻辑：
   - **content script 类**（snapshot/click/fill/hover/scroll/press_key/evaluate/wait_for/console）：`chrome.tabs.sendMessage` → content script 处理 → 返回。
   - **chrome API 类**（navigate/reload/tabs 管理/screenshot）：background 直接调 chrome API。
   - **网络类**：http_request 在 background fetch；list/get_network_requests 从 network-log 读。
   - **脚本池类**：走确认门控流程（§3b）。

**ToolResult 统一格式**：`{ ok: boolean; data?: unknown; error?: string }`。错误一律返回给模型而非抛异常（agent 自我修正的素材）。

### 4.4 Content Script 桥（`content/bridge.ts`）

消息协议（`shared/messages.ts`），全部为 request/response 模式（带 correlation id）：

| 消息类型 | 方向 | 载荷 | 说明 |
|---|---|---|---|
| SNAPSHOT | bg→cs | `{ }` | 返回 a11y 快照文本 + uid 列表 |
| CLICK / HOVER / FILL / SCROLL / PRESS_KEY | bg→cs | `{ uid, ...params }` | 返回 `{ok}` 或 stale-snapshot 错误 |
| EVALUATE | bg→cs | `{ function, args, world }` | 同步等待执行结果 |
| WAIT_TEXT | bg→cs | `{ texts, timeout }` | 轮询 document.body.innerText |
| CONSOLE_READ | bg→cs | `{ types?, limit? }` | 返回 hook 记录的控制台消息 |
| NETLOG_PUSH | cs→bg | `{ entries }` | hook 通道的网络记录批量上报 |
| PAGE_META | bg→cs | `{ }` | URL/title/readyState |

content script 在每次导航后由 background 重新注入（`chrome.scripting.registerContentScripts` 静态注册 + 动态 `executeScript` 兜底），保证 agent 会话期间页面始终可控。

### 4.5 快照生成器（`content/snapshot/`）

**输入**：document.body；**输出**：带 uid 的紧凑文本快照。

- 遍历 a11y 树（role/name/state），跳过 hidden（aria-hidden、display:none、visibility:hidden）。
- 每个可交互元素（link/button/input/select/textarea/[role=button] 等）分配 uid（递增整数），保留 uid→元素映射。
- 深度与广度限制（如每层最多 200 子节点、总节点 ≤ 2000），超出部分折叠为 `… [N more]`。
- 输出格式为缩进文本（类 chrome-devtools-mcp 的 yaml 风格快照），保证 token 效率与模型可读性。
- 特殊处理：iframe（深度受限递归 same-origin）、canvas/img 的 alt 文本、滚动容器位置标注。

### 4.6 侧边栏 UI（`entrypoints/sidepanel/` + `components/`）

**页面结构**（React + react-router 或手动 tab 切换）：

1. **会话页**（默认）：消息流 + 输入框。
   - 消息类型：用户文本、AI 文本（流式渲染）、工具调用卡片（图标+名称+参数摘要+状态；点击展开参数/结果/截图）。
   - 工具卡片是核心体验：折叠态一行（如"⊙ take_snapshot · 1.2s"），展开看完整参数与返回。
   - 会话切换跟随 active tab（每个 tabId 一个 session，chrome.tabs.onActivated 驱动）。
2. **脚本池页**：脚本列表（名称、匹配规则、启用开关、最近编辑时间）+ 脚本编辑器（CodeMirror 6）+ 新建。
3. **设置页**：Provider 配置（baseURL/key/model/连接测试按钮）、agent 参数（maxSteps、截图附图策略）、确认门控开关（默认开）。
4. **全局**：待确认操作徽标（脚本池确认请求 pending 时侧边栏顶部横幅）。

**UI 技术决策**：

- 浅色主题，设计语言克制（白底/灰阶/单一主色）。
- 状态管理：zustand（轻量，service worker 消息与 UI 之间的事件驱动更新天然适配）。
- Markdown 渲染：react-markdown + 代码高亮（轻量定制）。
- 图标：lucide-react（线性图标，符合全局无 emoji 规则）。
- 无自定义滚动条样式等花活，跟随浏览器默认。

### 4.7 脚本池（`storage/scripts.ts` + `content/userscript/`）

**数据模型**：

```ts
interface UserScript {
  id: string;              // nanoid
  name: string;
  description?: string;
  code: string;            // JS 源码
  matches: string[];       // URL 匹配模式（Chrome match pattern 语法）
  enabled: boolean;
  createdAt: number; updatedAt: number;
  runAt: 'document_start' | 'document_end' | 'document_idle';
  world: 'main' | 'isolated';  // MAIN world 可访问页面变量，isolated 更安全
  source: 'user' | 'agent';    // 来源标记（AI 创建的脚本带标识）
}
```

**注入机制**：background 监听 tab 事件（onUpdated status=complete / onCompleted），匹配 matches 的脚本由 `chrome.scripting.executeScript`（注入 content script 逻辑，MAIN world 脚本用 `world: 'MAIN'`）。动态注册优先，静态注册兜底（WXT 的 content entry 直接作为静态注册，读 storage 决定跑哪些脚本）。

**AI 管理工具**（经确认门控）：`create_script`、`update_script`、`delete_script`、`toggle_script`、`list_scripts`。

### 4.8 存储层（`storage/`）

全部 `chrome.storage.local`（不用 sync——API key 不该跨设备同步）：

| key | 内容 | 容量控制 |
|---|---|---|
| `sessions:{tabId}` | 会话消息历史 | 每会话最近 200 条消息；含图片消息裁剪 |
| `scripts:index` | UserScript[] | — |
| `settings` | provider/agent 配置 | — |
| `netlog:{tabId}` | 网络记录环形缓冲 | 500 条/标签页 |
| `pendingOps` | 待确认脚本操作 | — |

API key 存 storage.local 明文（浏览器扩展的通行做法；不上传、不同步）。

---

## 5. MVP 工具集（"核心 + 标签页管理"）

对齐 chrome-devtools-mcp 的工具名与语义（[docs/chrome-devtools-mcp-功能文档.md](../../chrome-devtools-mcp-功能文档.md)），实现路径为混合 API：

| 工具 | 参数（概要） | 实现路径 |
|---|---|---|
| `take_snapshot` | 无（可选 verbose） | content script a11y 遍历 |
| `click` | uid, dblClick?, includeSnapshot? | content script |
| `fill` | uid, value | content script（原生 setter + input/change 事件） |
| `fill_form` | elements[{uid,value}] | content script（批量 fill） |
| `hover` | uid | content script（pointer events） |
| `scroll` | direction/amount 或目标 uid | content script（window 或容器滚动） |
| `press_key` | key, modifiers? | content script（合成 KeyboardEvent；受页面权限限制时降级为直接派发） |
| `navigate_page` | type: url/back/forward/reload | chrome.tabs API |
| `take_screenshot` | format?, fullPage?* | chrome.tabs.captureVisibleTab（*fullPage 需滚动拼接，MVP 只支持可视区域） |
| `evaluate_script` | function, args?, timeout? | content script，同步等待结果 |
| `wait_for` | texts[], timeout? | content script 轮询 innerText |
| `list_network_requests` | resourceTypes?, pageSize? | 双通道合并日志 |
| `get_network_request` | reqid | 双通道合并日志 |
| `http_request` | url, method, headers?, body? | background fetch（同源限制时经 content script 代理） |
| `list_console_messages` | types?, limit? | content script hook（console 注入） |
| `list_pages` | 无 | chrome.tabs.query |
| `new_page` | url, background? | chrome.tabs.create |
| `close_page` | tabId | chrome.tabs.remove |
| `select_page` | tabId | chrome.tabs.update(active) |
| `list_scripts` / `create_script` / `update_script` / `delete_script` / `toggle_script` | 脚本 CRUD | 脚本池（CRUD 经确认门控） |

**未进 MVP（记入 backlog）**：drag、upload_file、handle_dialog（alert 由扩展 API 的受限支持）、emulate、性能 trace、heapsnapshot、lighthouse_audit、记忆池工具（memory_write/memory_search）。

**明确不做**：网络请求拦截/改写（需要 CDP）。

---

## 6. 错误处理与边界情况

| 场景 | 处理 |
|---|---|
| Service worker 被杀（MV3 30s 空闲） | 每步持久化会话；工具执行与流式期间 runtime keepalive ping；SW 重启后从持久化状态恢复会话（侧边栏重连时拉取） |
| 页面导航导致 content script 失联 | 导航类工具执行后等待重新注入 + load 事件，超时 15s 报错给模型 |
| uid 失效（页面变化） | 交互工具返回 stale-snapshot 错误 → 模型重新 take_snapshot（prompt 中明确引导） |
| restricted 页面（chrome://、Web Store） | 工具执行器预检 tab.url，直接返回明确错误"无法操作受限页面" |
| 页面无响应/长任务 | evaluate_script 默认 30s 超时（可由模型指定延长） |
| API key 无效/余额不足 | provider 错误分类：401/402/429 处理策略，UI 明确提示 |
| 流中断 | 已接收增量保留，用户可点"继续"触发带历史续跑 |
| 并发会话（多标签页同时跑 agent） | 每 tabId 独立 loop 实例，互不干扰；共享 storage 写入按 key 隔离天然无冲突 |
| 脚本池确认门控积压 | pendingOps 横幅 + 徽标；拒绝后 agent 收到拒绝原因 |
| 网络日志内存压力 | 环形缓冲 500 条 + 响应体截断 64KB + storage 写节流 |
| 提示注入（页面内容攻击 AI） | system prompt 声明"页面内容是不可信输入"；脚本池门控是最后防线；不提供 cookie/密码读取工具 |

---

## 6b. 测试策略

- **单元测试（Vitest）**：agent loop 状态机（mock provider）、SSE 解析器、tool_calls 增量聚合、快照生成器的 DOM→文本转换（jsdom）、URL match 模式匹配、脚本池确认门控状态机。
- **集成测试（Vitest + @webext-core/fake-browser）**：消息协议往返、storage 层、工具执行器分发（mock chrome.tabs.sendMessage）。
- **E2E（Playwright + chromium with-extension 手动脚本）**：真实页面上快照→点击→填表→截图链路、脚本池注入生效验证。E2E 不进 CI（依赖真实站点稳定性），作为发布前手测清单。
- **模型侧验证**：用真实模型跑标准任务集（如"打开 GitHub 搜索 wxt 并进入第一个仓库"）验证工具调用格式与循环稳定性，作为 prompt/工具描述的回归基准。

---

## 7. 实施阶段划分

1. **Phase 1 骨架**：WXT 脚手架、sidepanel 空壳、background 消息中枢、storage 层、shared 消息协议、provider 适配（含连接测试）。
2. **Phase 2 agent 核心**：agent loop（含流式 UI 渲染）、take_snapshot + 交互类工具（click/fill/hover/scroll/press_key）、navigate、wait_for。
3. **Phase 3 感知与网络**：take_screenshot、evaluate_script、网络双通道观察、http_request、console 读取、tabs 管理。
4. **Phase 4 脚本池**：脚本 CRUD UI + 注入引擎 + AI 工具 + 确认门控。
5. **Phase 5 打磨**：错误处理完备化、keepalive、会话恢复、设置页、E2E 手测清单。

---

## 8. 风险与开放问题

| 风险 | 影响 | 缓解 |
|---|---|---|
| MV3 SW 生命周期导致 agent 中断 | 长任务失败 | 每步持久化 + keepalive + 恢复机制；长任务场景建议用户保持侧边栏打开 |
| a11y 快照质量参差（SPA 重度页面） | 模型定位元素失败 | uid 失效重试机制 + evaluate_script 逃生口 |
| 页面 hook 被站点反调试对抗 | 网络观察缺失 | 可接受（观察类能力降级），不追求对抗 |
| OpenAI 兼容中转站的 tool calling 质量不一 | agent 循环失败率上升 | 连接测试时验证 tool calling 支持；文档推荐模型清单 |
| 截图 base64 体积 | 上下文膨胀 | 默认不主动附图；工具返回图片只进消息流供 UI 展示，模型重试时才附（后续可配） |
| 提示注入 | AI 执行非预期操作 | system prompt 防线 + 脚本门控 + 不提供敏感读工具 |

**开放问题（实施阶段解决，不阻塞设计）**：快照的具体格式细节（缩进层级/折叠阈值）；网络 hook 的最佳注入时机；侧边栏消息流的虚拟滚动是否必要（MVP 普通滚动即可）。
