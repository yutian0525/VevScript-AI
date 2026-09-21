# CDP 深度观测 设计

- 日期：2026-09-21
- 状态：已确认（对话中设计获用户批准）
- 背景：网络与控制台观测现由 MAIN world hook（`entrypoints/hook.content.ts`，`document_start` 包装 `console` 五方法 + `fetch` + `XHR.open/send`）承担，两个问题：① 包装行为构成廉价且易被探测的扩展指纹，Boss直聘等强风控站据此拒服务（此前只能靠敏感站排除名单绕过）；② 观测天然残缺——响应体只覆盖 fetch/XHR、无浏览器自动头、无 WebSocket、无浏览器级错误、console 无堆栈。CDP（`chrome.debugger`）是保真度上限更高的通道，Phase 3b 设计时已将其列为预留的「深度诊断模式」，`observe-store` 当初即按「可并入第二数据源」模块化。

## 1. 关键决策记录

| # | 决策 | 选择 | 理由 |
|---|------|------|------|
| 1 | hook 去留 | **CDP 全面取代 hook**（删除） | 从根上消除 MAIN world 注入指纹；避免两套通道长期并存腐化 |
| 2 | 模型开启授权 | **直接附着，Chrome 信息条即提示** | 复用 confirm-queue 会新开 hub 标签页并抢焦点，对「模型想开个调试器」过重；信息条本身可见、可撤销（点「取消」即 `canceled_by_user`） |
| 3 | 作用域 | **钉在开启时那个标签页** | 与 DevTools 的 per-tab 语义一致；CDP 附着天然跨导航存活 |
| 4 | 保真范围 | **主帧 + 自动附着子 target**（flatten） | 现有 hook 是 `allFrames: true` 注入，只做主帧会让跨域 iframe 成为净回退 |
| 5 | CDP 开启时的 webRequest | **该 tab 静默** | 两套 `requestId` 命名空间无法对齐，硬合并只产生幽灵重复条目 |
| 6 | 响应体抓取时机 | **`loadingFinished` 时立即拉取**（类型白名单） | CDP 的 body 缓冲会被淘汰，等工具调用时再拉不可靠 |
| 7 | ask 模式 | **`enable`/`disable` 进 `ASK_MODE_TOOLS`** | 见 §4，此条为推荐项，用户可否决 |

## 2. 目标与非目标

**目标**

1. 新增 CDP 观测通道，覆盖网络（含响应体、完整 headers、WebSocket 帧）与控制台（含堆栈、浏览器级条目）。
2. 默认关闭，用户点侧边栏圆形开关或模型调用工具开启。
3. 删除 MAIN world hook 及其整条链路（注入、动态注册、敏感站排除名单、postMessage 中继）。
4. CDP 关闭时保留 webRequest 元数据主干，观测工具不报错、不空转。

**非目标（YAGNI）**

- 不改 ISOLATED `content.ts` 的页面操作能力（uid 树、DOM 动作照旧）。
- 不做 CDP 的写能力（`Fetch` 域改写请求、`Emulation` 域、性能 trace、内存快照）——本期只做只读观测。
- 不做「新标签页自动开启」的持久化偏好。
- 不做 Shared Worker / Service Worker 覆盖（技术不可达，见 §8）。
- 不为 CDP 通道加脱敏开关——沿用现有 `networkCaptureHeaders` 读取时脱敏逻辑不变。

## 3. 架构

### 3.1 新增模块

| 文件 | 职责 |
|---|---|
| `background/cdp/session.ts` | 附着/脱离、per-tab 会话注册表、冷启动对账自愈 |
| `background/cdp/domains.ts` | 域启用 + CDP 事件 → observe-store 摄入（含 sessionId 路由） |
| `background/cdp/console-text.ts` | `RemoteObject[]` → 文本（纯函数，可单测） |
| `background/cdp/bodies.ts` | 响应体抓取策略（类型白名单 + 截断） |
| `shared/cdp.ts` | 跨环境类型（`DeepObserveState`、消息形状） |
| `agent/tools/deep-observe.ts` | 两个工具执行器 |
| `components/chat/DeepObserveToggle.tsx` | 圆形开关 |
| `stores/deep-observe.ts` | 侧边栏侧状态缓存（SW 权威，广播同步） |

### 3.2 改造点

- `wxt.config.ts`：`permissions` 增加 `'debugger'`。
- `background/observe-store.ts`：接纳 CDP 数据源；附着时抑制该 tab 的 webRequest 摄入；id 命名空间加前缀。
- `entrypoints/background.ts`：接线 `debugger.onEvent` / `onDetach`（**必须在 SW 顶层同步注册**，见 §5.6）、新消息 handler、冷启动对账。
- `shared/messages.ts`：新增深度观测消息。
- `agent/tools/schemas.ts`、`agent/tools/registry.ts`：两个新工具。
- `agent/mode.ts`：`ASK_MODE_TOOLS` 增补。
- `components/chat/ChatView.tsx`：`.composer__bar` 左侧挂开关；`ModeSelect` 移入 `.composer__actions`。
- `entrypoints/sidepanel/styles.css`：`.deepobs` 样式；`.modeselect` 间隙方向调整与注释更新。

## 4. 工具与权限模型

### 4.1 两个新工具

均无参数，作用于 agent 当前标签页（tabId 由工具上下文提供，与 `agent/tools/observe.ts` 现有签名一致）：

- `enable_deep_observe` → `{ ok: true, data: { tabId, status: 'on' } }`；失败 `{ ok: false, error }`，文案直指原因（如「页面 DevTools 已打开，无法附着」）。
- `disable_deep_observe` → `{ ok: true, data: { tabId, status: 'off' } }`；未附着时幂等成功。

工具描述里写明开启代价（页面顶部出现 Chrome 调试提示条、与页面 DevTools 互斥），让模型知道自己在做什么。

### 4.2 降级语义

CDP 关闭时三个观测工具**不报错**，返回空数据 + `deepObserve: false` + `hint`：

- `list_console_messages` → `{ messages: [], deepObserve: false, hint: '控制台观测需要深度观测（CDP），当前未开启；可调用 enable_deep_observe 开启（会在页面顶部显示 Chrome 调试提示条，且与页面 DevTools 互斥）' }`
- `list_network_requests` → 照常返回 webRequest 元数据 + `deepObserve: false`（该 tab 未附着时无 body、无 headers）
- `get_network_request` → 条目来自 webRequest 且无 body 时附 `hint` 说明原因

### 4.3 ask 模式（推荐项，可否决）

`enable_deep_observe` / `disable_deep_observe` 进 `ASK_MODE_TOOLS`。

- 支持理由：ask 模式正是「这页为什么报错」的诊断主场；若不进白名单，三个只读观测工具在 ask 下全部失效，而它们本身在白名单里。附着不修改页面内容，符合 ask 的「不改网页状态」语义。
- 反对理由：附着确实改变浏览器状态（信息条常驻、DevTools 互斥）。
- 硬闸兜底照旧：`registry.ts` 的 mode 守卫拦截幻觉调用。

## 5. 模块设计

### 5.1 `background/cdp/session.ts`

per-tab 会话注册表 `Map<tabId, { status: 'on' | 'error'; reason?: string; sessions: Set<string> }>`。

- `attach(tabId)`：`browser.debugger.attach({ tabId }, '1.3')` → 记录 → `domains.enableAll(tabId)`。失败（典型：「Another debugger is already attached」）落 `error` 态 + reason，返回结构化错误，不抛出。
- `detach(tabId)`：`browser.debugger.detach({ tabId })`；「not attached」错误视为成功（幂等）。
- `getState(tabId)`：读注册表，未记录返回 `{ tabId, status: 'off' }`。
- `reconcile()`：冷启动对账。`browser.debugger.getTargets()` 取 `attached: true` 的 tab 列表，与内存注册表比对：
  - 浏览器侧附着而内存无记录 → 补记录并重新 enable 域（SW 重启后内存记账丢失，但附着本身存活）。子 session 映射无从恢复，重新 `setAutoAttach` 会让子 target 以新 sessionId 重新报到，旧映射的残留不影响正确性。
  - 内存有记录而浏览器侧未附着 → 清记录（僵尸态）。
  - **绝不信任内存标志位**：对已记录的 tab 仍以 `getTargets()` 为准，否则会出现「以为附着着、实际已断」，之后 `sendCommand` 抛 "Debugger is not attached"。
- `onDetached(tabId, reason)`：`target_closed` → 清记录 + `clearTab`；`canceled_by_user`（用户开 DevTools 或点信息条取消）→ 置 `error` 态 + reason + 广播。

### 5.2 `background/cdp/domains.ts`

- `enableAll(tabId)`：`Network.enable({ maxTotalBufferSize: 10 * 1024 * 1024, maxResourceBufferSize: 5 * 1024 * 1024 })`（响应体在 `loadingFinished` 即被取走，缓冲只需覆盖「取走前」的窗口，量级给到 MB 足够）、`Runtime.enable`、`Log.enable`、`Page.enable`，然后 `Target.setAutoAttach({ autoAttach: true, waitForDebuggerOnStart: false, flatten: true })`。
  **`waitForDebuggerOnStart` 必须为 false**——置 true 会把页面冻在启动断点上。此约束需单测断言。
- 子 target：`Target.attachedToTarget` → 记 `sessionId → tabId` 并对该 session 单独 enable 三域（不含 `Target.setAutoAttach`，避免无限递归）；`Target.detachedFromTarget` → 清映射。
- 事件路由：`onEvent` 的 `source.sessionId` 存在时按 sessionId 查回 tabId。
- 事件映射表：

| CDP 事件 | 摄入动作 |
|---|---|
| `Network.requestWillBeSent` | `recordRequestStart`（method、url、type、request headers、`request.postData`） |
| `Network.responseReceived` | 补 status、response headers、mimeType |
| `Network.loadingFinished` | `recordRequestEnd`；按 §5.4 白名单拉响应体 |
| `Network.loadingFailed` | `recordRequestError`（含 `errorText`、`canceled`） |
| `Network.webSocketFrameSent` / `Received` | 按 `requestId` 挂到握手条目（§5.5） |
| `Runtime.consoleAPICalled` | `ingestConsole`（level 由 `type` 映射，文本经 §5.3 序列化，附 `stackTrace`） |
| `Runtime.exceptionThrown` | `ingestConsole`（level `error`，文本含 `exceptionDetails.text` + `exception.description`，附 `stackTrace`） |
| `Log.entryAdded` | `ingestConsole`（level 由 `entry.level` 映射，文本 `entry.text`，附来源 URL/行号）——CSP 违规、资源加载失败、弃用警告等浏览器级条目 |

### 5.3 `background/cdp/console-text.ts`

`serializeRemoteObjects(args: RemoteObject[]): string`，纯函数：

- 原始值（`type` 为 `string`/`number`/`boolean`/`undefined`/`bigint`/`symbol`）→ `String(value)`。
- `subtype === 'null'` → `'null'`。
- 对象 → 优先 `description`；无则用 `preview` 拼浅层摘要（`preview.properties` 的 `name: value`，最多 5 项，超出加 `…`）；再无则 `<object>`。
- Error → `description`（含堆栈首行）。
- 多参以空格连接，单条文本总长截断（`MAX_CONSOLE_TEXT = 4096`）。
- **不做 `Runtime.getProperties` 往返**：objectId 会过期，逐条往返在高频 console 下代价不可接受。深度内容拿不到属接受的降级。

### 5.4 `background/cdp/bodies.ts`

- `shouldFetchBody(type, mimeType)`：类型白名单 `XHR` / `Fetch` / `Document`；mimeType 为非文本（`image/*`、`font/*`、`audio/*`、`video/*`）时跳过；`event-stream` 跳过（对齐现有 hook 对 SSE 的处理）。
- `fetchBody(tabId, sessionId, requestId)`：`Network.getResponseBody` → `{ body, base64Encoded }`；`base64Encoded` 为真时不落库（二进制）。截断 `MAX_BODY = 64 * 1024`（沿用现有常量）。失败（已淘汰/重定向/缓存命中）best-effort 吞掉，条目标 `hasBody: false`。

### 5.5 `background/observe-store.ts` 改造

- `NetEntry` 增可选字段：`wsFrames?: { dir: 'sent' | 'received'; opcode: number; payload: string; ts: number }[]`，上限 `MAX_WS_FRAMES = 200`，单帧 payload 截断 `MAX_WS_PAYLOAD = 4096`。
- id 命名空间：webRequest 条目 id 加 `wr:` 前缀，CDP 条目加 `cdp:` 前缀（现为裸 `requestId`，此变更为格式调整，无外部持久化依赖）。
- 抑制：`recordRequestStart` / `recordRequestEnd` / `recordRequestError` 入口先查 `cdpSession.getState(tabId).status`，为 `'on'` 则直接 return——该 tab 的网络缓冲由 CDP 独占。
- 删除 `ingestHookNet` 与 `MATCH_WINDOW_MS` 关联窗口逻辑（hook 退役后无消费方）。

### 5.6 `entrypoints/background.ts` 接线

- **`browser.debugger.onEvent` 与 `onDetach` 必须在 SW 顶层同步注册**（不在 `main()` 内的异步分支里）。MV3 下 SW 重启后事件可能早于异步初始化到达，顶层注册是唯一能保证收到的写法。
- 新消息 handler：`DEEP_OBSERVE_GET` / `DEEP_OBSERVE_SET`。
- 冷启动：`void cdpSession.reconcile()`（失败静默，下次自愈——同 `syncRegistrations` 的启动自愈约定）。
- `tabs.onRemoved`：现有 `clearTab` 之外追加 `cdpSession.forget(tabId)`。

### 5.7 `shared/messages.ts` 新增

```ts
export interface DeepObserveState { tabId: number; status: 'off' | 'on' | 'error'; reason?: string }
export interface DeepObserveStateNotification { type: 'DEEP_OBSERVE_STATE'; payload: { state: DeepObserveState } }
export type DeepObserveRequest =
  | { type: 'DEEP_OBSERVE_GET'; tabId: number }
  | { type: 'DEEP_OBSERVE_SET'; tabId: number; enabled: boolean };
```

- `DEEP_OBSERVE_GET` → `{ ok: true, data: DeepObserveState }`
- `DEEP_OBSERVE_SET` → 成功 `{ ok: true, data: DeepObserveState }`；attach 失败 `{ ok: false, error }`（同时广播 `error` 态）
- 状态变更一律广播 `DEEP_OBSERVE_STATE`，面板按 tabId 过滤（同 Port 下行消息按 `convId` 过滤的既有约定）

### 5.8 `stores/deep-observe.ts`

zustand store，仅缓存 SW 权威状态、不做判定：

```ts
interface DeepObserveStore {
  states: Record<number, DeepObserveState>;   // 按 tabId
  applyState: (s: DeepObserveState) => void;  // 广播到达时写入
  fetchState: (tabId: number) => Promise<void>; // DEEP_OBSERVE_GET 拉取
  setEnabled: (tabId: number, enabled: boolean) => Promise<void>; // DEEP_OBSERVE_SET
}
```

订阅 `DEEP_OBSERVE_STATE` 广播的位置与既有 `CONFIRM_PENDING` 广播订阅同款（`browser.runtime.onMessage`）。`setEnabled` 失败时把返回的 `error` 态写入 store（开关据此转 warn 色），不抛给调用方。

## 6. UI 设计

- **位置**：`ChatView.tsx` 的 `.composer__bar` **左侧**，紧跟 `.composer__attach` 之后——即原 `ModeSelect` 的位置。`ModeSelect` 相应移入右侧操作簇 `.composer__actions`，成为该簇最左元素（`ContextRing` 之前），保持环形钮与发送钮的既有相邻关系。

  新布局：
  ```
  .composer__bar
  ├─ [hidden file input]
  ├─ .composer__attach  (30×30)
  ├─ .deepobs           (26×26)   ← 新增
  └─ .composer__actions (margin-left: auto)
     ├─ .modeselect     ← 从左侧移来
     ├─ .ctxring
     └─ .composer__send
  ```

  两点须同步改的样式：`.modeselect` 的 `margin-right: 2px` 删除（右簇已有 `gap: 6px`，且间隙方向反转）；`.composer__actions` 上方注释「附件钮 + 模式选择器成组靠左」改写。
  `.modeselect__pop` 浮层锚定 `.composer` 卡片（`position: absolute; left: 8px; right: 8px`）而非触发器，**移动触发器不影响浮层定位**，无需改动。

- **形态**：26×26 圆形按钮，尺寸与 `.ctxring` 对齐（`border-radius: 50%`），内嵌 lucide 图标 `size={14}`。图标用 `Activity`（心电线），与 ContextRing 的环形几何明确区分；备选 `Radar` / `Stethoscope`。
- **三态颜色**（全部走 CSS 变量，禁硬编码色值）：

| 态 | 前景 | 背景 | 边框 |
|---|---|---|---|
| 关 | `--ink-3` | 透明（hover `--sunken`） | 无 |
| 开 | `--signal` | `--signal-wash` | `--signal` |
| 异常 | `--warn` | `--warn-wash` | `--warn` |

- **Tooltip** 三态文案：
  - 关：`深度观测：关（点击开启）`
  - 开：`深度观测：开 · 本页已附着（点击关闭）`
  - 异常：`深度观测：已断开——页面 DevTools 占用中（点击重试）`（reason 有值时替换破折号后文案）
- **当前标签页跟踪**：组件内部维护 `useActiveTabId()`（监听 `browser.tabs.onActivated` 与 `onRemoved`，初值用 `tabs.query({ active: true, currentWindow: true })`，回退 `lastFocusedWindow`——同 `ChatView.tsx:140` 现有写法）。tabId 变化时 `DEEP_OBSERVE_GET` 重新取态。
- **disabled 条件**：无当前会话或无当前标签页（同 ContextRing 的 `!currentId` 口径）。
- **点击**：`DEEP_OBSERVE_SET { tabId, enabled: !isOn }`；异常态点击等同重试开启。
- 状态切换 transition 走 `prefers-reduced-motion` 兜底。
- **不设设置页项**：附着态跨浏览器重启不存活，无可持久化状态——「默认关闭」即这个无状态的自然结果。

## 7. 退役清单

**删除文件**：`entrypoints/hook.content.ts`、`background/hook-registration.ts`、`background/hook-exclusions.ts`、`components/settings/HookExclusionsPage.tsx`、`stores/hook-exclusions.ts`、`shared/hook-bridge.ts`，及其对应测试。

**删除代码**：
- `entrypoints/content.ts` 的 postMessage 中继块（`HOOK_MSG` 监听 + `RELAY_READY` 回发）。该文件本身保留。
- `entrypoints/background.ts` 的 `HOOK_CONSOLE` / `HOOK_NETWORK` handler、`syncHookRegistration()` 调用、`initHookRegistration(router)`。
- `shared/messages.ts` 的 `HookConsoleNotification` / `HookNetworkNotification` / `HOOK_EXCLUSIONS_GET` / `HOOK_EXCLUSIONS_SAVE` 及相关类型。
- `SettingsHome.tsx` 的「敏感站点排除」入口、`SettingsView.tsx` 路由、`SettingsSub` 联合类型成员。
- `observe-store.ts` 的 `ingestHookNet` 与 `MATCH_WINDOW_MS`。

**保留**：`scripting` 权限（脚本池仍用）、`webRequest` 权限与主干逻辑、`entrypoints/content.ts`。

**文档联动**（口径从「hook + webRequest 双通道」改为「CDP 深度观测 + webRequest 兜底」）：`README.md:144`、`docs/使用指南.md:116`、`landing/src/pages/Home.tsx:440`、`docs/history.md` 追加本迭代小节。

## 8. 错误处理

| 场景 | 处理 |
|---|---|
| attach 时页面 DevTools 已开 | 落 `error` 态 + reason「页面 DevTools 已打开」；工具返回 `{ ok: false, error }`；开关转 warn 色 |
| 附着后被用户开 DevTools / 点信息条取消 | `onDetach('canceled_by_user')` → `error` 态 + 广播；工具下次读取返回明确文案，不返回静默空数据 |
| 标签页关闭 | `onDetach('target_closed')` → 清记录 + `clearTab` + 广播 `off` |
| SW 重启 | 附着存活但记账丢失 → `reconcile()` 用 `getTargets()` 对账重建；对账失败静默，下次冷启动自愈 |
| `sendCommand` 抛 "not attached" | 视为僵尸态 → 清记录 + 广播 `error`；不自动重附着（避免与 DevTools 抢占死循环） |
| `Network.getResponseBody` 失败 | best-effort 吞掉，条目标 `hasBody: false` |
| 子 target enable 失败 | 吞掉并记 debug 日志；不影响主 target 观测 |

## 9. 测试

单测（vitest + jsdom，`browser.debugger` 全 mock）：

- `console-text`：字符串/数字/多参/对象 preview/无 description 对象/Error/超长截断。
- `session`：attach 幂等；attach 抛「Another debugger is already attached」→ `error` 态且不抛；`detach` 对未附着幂等；`onDetached` 两 reason 分支；`reconcile` 三种对账结果（补记录 / 清僵尸 / 一致跳过）。
- `domains`：七个事件 → observe-store 摄入映射；子 session 事件按 `sessionId` 路由回正确 tabId；`Target.setAutoAttach` 参数断言（**`waitForDebuggerOnStart === false`**）；`attachedToTarget` 不递归调用 `setAutoAttach`。
- `bodies`：类型白名单命中/未命中；非文本 mimeType 跳过；`base64Encoded` 不落库；截断。
- `observe-store`：CDP `on` 时 webRequest 三入口被抑制；`wr:` / `cdp:` 前缀不撞号；WS 帧挂载与上限。
- 消息 handler：`DEEP_OBSERVE_SET` 开/关往返；attach 失败返回 `{ ok: false }`。
- UI（jsdom）：三态渲染与类名；点击发 `DEEP_OBSERVE_SET`；tabId 变化触发 `DEEP_OBSERVE_GET`。

jsdom 限制：真实 `debugger` API 不可用 → 全 mock；真实附着行为留手测。

**手测清单**

1. 开关默认灰，位于附件钮右侧；模式选择器已右对齐到操作簇内、上下文环左侧，点开浮层定位正常（仍左右贴卡片边）。
2. 点开开关 → 页面顶部出现信息条 + 开关转 signal 色。
3. 页面 `console.log` / 未捕获异常 → `list_console_messages` 有数据且带堆栈。
4. fetch / XHR / img / 跨域 iframe 内请求 → `list_network_requests` 全都有；`get_network_request` 拿得到 XHR/Fetch 的 body 与完整 headers（含浏览器自动头）。
5. CSP 违规页面 → console 列表出现 `Log.entryAdded` 来源的条目。
6. 打开页面 DevTools → 开关转 warn，工具返回明确文案。
7. 先开 DevTools 再点开关 → 落 warn 态。
8. 切标签页 → 开关显示未开启；切回 → 恢复「开」。
9. 同标签页内导航 → 保持附着。
10. 关闭标签页 → 状态清理，无残留。
11. WebSocket 站 → 帧条目可见。
12. Boss直聘 → 不再有 MAIN world 注入，正常打开（且不需要排除名单）。
13. CDP 关闭状态下 → `list_network_requests` 仍有 webRequest 元数据；`list_console_messages` 返回 hint 而非报错。

## 10. 已知边界

1. **CDP 并非零可检测**。页面可用 `console.log` getter 陷阱、`debugger` 语句计时等手段探测调试器附着；Chrome 信息条本身也是明示的。相比 `window.fetch.toString()` 那类包装指纹隐蔽得多，但「彻底消除被判定异常」应理解为**去掉最廉价的那类指纹**，而非隐身。
2. **Shared Worker / Service Worker 够不到**。`chrome.debugger` 的附着单位是标签页，`Target.setAutoAttach` 只能收该页的子 target（跨域 iframe / Dedicated Worker）；Shared Worker 与 Service Worker 是独立 target、不在页的子树里。
3. **`sessionId` 定位子会话需 Chrome 125+**（`DebuggerSession` 自 Chrome 125 引入）。更低版本只能覆盖主帧。
4. **与页面 DevTools 互斥**（双向）。附着期间信息条常驻标签页顶部。
5. **新增 `debugger` 权限会让已安装的扩展被 Chrome 禁用**，直到用户重新同意——老用户升级有一次摩擦。
6. **响应体只覆盖 XHR / Fetch / Document 白名单**，img/font/media 等只有元数据（与 hook 语义一致，非回退）。
7. **console 深内容拿不到**：不做 `Runtime.getProperties` 往返，对象只到 `description` / `preview` 浅层。
8. **WebSocket 帧 payload 不过脱敏**：`networkCaptureHeaders` 只作用于 headers，帧体（可能含 token）原样落库。与响应体同一立场（响应体同样不脱敏），但 WS 场景更容易夹带凭据，实施时如要收紧需另设规则。
9. **SW 重启后内存缓冲丢失**：附着存活但历史观测 best-effort（与现状同）。
10. **敏感站排除名单随之删除**：CDP 关闭时该站无任何观测数据（webRequest 元数据仍在），但不再需要维护名单。
11. **Firefox 无同名 `chrome.debugger` API**（当前项目 Chrome-only，与 `userScripts` 同一立场）。
