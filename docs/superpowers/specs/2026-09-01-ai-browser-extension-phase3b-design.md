# AI Browser Extension 设计文档（Phase 3b：MAIN world hook 基础设施 + 观测三工具）

> 状态：已定稿，待实现。前置：Phase 3a（tabs/screenshot/evaluate/http_request，工具 9→16）已完成。
> 本阶段目标：新增 MAIN world hook 基础设施，落地 `list_console_messages` / `list_network_requests` / `get_network_request` 三个观测工具（16→19）。

## 1. 目标与范围

给 agent 补上「看见页面自己在说什么、在发什么请求」的能力：

- **console 观测**：捕获页面 JS 的 `console.{log,info,warn,error,debug}` + 运行时错误（`window.onerror` / `unhandledrejection`）。
- **网络观测（双通道）**：webRequest 元数据主干（全量请求）+ MAIN hook 的 fetch/XHR body 富化（页面 JS 发起的请求）。

### 三个地基决策（brainstorming 已拍板）

1. **观测模型 = 全程常驻**：manifest 静态注册 MAIN world content script（`document_start`）→ 页面加载即静默缓冲到 SW 环形缓冲。AI 随时能问「刚才发生了什么」都有历史。开销靠环形缓冲上限兜住。
2. **网络通道 = 统一列表**：webRequest 作主干（稳定 `requestId` + 元数据，覆盖全部请求）；MAIN hook 捕到的 fetch/XHR body 按 `(method+url+时间窗)` best-effort 关联附加到对应条目；关联不上的 hook body 作独立条目保留。
3. **隐私 = 默认头脱敏 + 可选全量**：`Authorization`/`Cookie`/`Set-Cookie`/`Proxy-Authorization`/`api-key` 类头默认替换为 `[REDACTED]`；头值长度截断防膨胀；全量开关走 `settings.agent.networkCaptureHeaders: 'redacted'|'full'`（默认 `'redacted'`，用户控，**非** AI 可自调参数）。

### 网络机制 = 方案 A（双通道，非 debugger/CDP）

MAIN hook + webRequest。理由：无「扩展正在调试此页面」黄条、权限零新增（`webRequest` 已声明）、body 拿得到、匹配上述三决策。debugger/CDP（方案 B）保真度最高但有常驻黄条 + 需 `debugger` 权限 + 与页面 DevTools 互斥，留作未来「深度诊断模式」可选增强。

## 2. 非目标（YAGNI）

- 不做 debugger/CDP。
- 不做 webRequest `extraHeaders`（非 JS 请求无 headers，接受此降级）。
- 不做缓冲持久化（SW 重启缓冲丢失，best-effort）。
- 不做跨 tab 聚合、请求 replay/修改、fullPage。
- 全量开关不做成 AI 可自调参数（否则脱敏形同虚设）。

## 3. 架构总览

```
页面(MAIN world)            页面(ISOLATED)          background / SW
──────────────────          ──────────────────      ───────────────────────────
hook.content.ts             content.ts(现有,改)      background/observe-store.ts(新)
 · 包装 fetch/XHR    postMsg  · 监听 window.msg  sendMsg  · console 环形缓冲/tab
 · 包装 console     ───────▶  · 中继到 SW      ───────▶  · network 环形缓冲/tab
 · window.onerror /          · attach 发         · webRequest 监听器(元数据主干)
   unhandledrejection          RELAY_READY       · hook body 按时间窗关联富化
 · 页面侧 backlog(补早期)                              · 入缓冲时脱敏 + 截断
                                                       
                                                       agent/tools/observe.ts(新)
                                                        · doListConsoleMessages
                                                        · doListNetworkRequests   ← 纯读 SW 缓冲
                                                        · doGetNetworkRequest         零 CS 往返
```

关键点：三个读工具直接读 SW 同进程内存缓冲，不经 content script 往返；webRequest 与工具执行同在 SW，两通道天然汇聚。

## 4. 数据流

### 4.1 console 通道（全靠 hook）

1. MAIN hook 在 `document_start` 包装 `console.{log,info,warn,error,debug}` + 挂 `error`/`unhandledrejection` 监听。
2. 每条经 `serialize.ts` 序列化（循环引用/DOM/函数安全处理 + 值截断）后 `window.postMessage`，并存入页面侧 bounded backlog（带 `loadNonce:seq` 单调 id）。
3. ISOLATED `content.ts` 收到带标记的 message → `runtime.sendMessage(HOOK_CONSOLE)` 中继；attach 时先发 `RELAY_READY`，hook 收到后 flush backlog（补齐 `document_idle` 前的早期日志）。
4. SW 按 tabId 写入 console 环形缓冲，按 id 去重。

### 4.2 network 通道（webRequest 主干 + hook body 富化）

1. SW 的 webRequest 监听器（`onBeforeRequest` / `onSendHeaders` / `onResponseStarted` / `onCompleted` / `onErrorOccurred`）对**全部**请求建条目：`requestId`（稳定 id）、method、url、type、status、时序。**主帧请求（`main_frame`）清空该 tab 旧缓冲**（翻页语义）。
2. MAIN hook 拿到 fetch/XHR 的 **request/response body + JS 显式设置的 headers**（浏览器自动加的 Cookie/Authorization 不在 JS 可见范围，天然规避）→ 经中继到 SW。
3. SW 把 hook body/headers 按 `(tabId + method + url + 起始时间 ±2000ms 窗口)` **best-effort 关联**到对应 webRequest 条目；关联不上的作独立 hook 条目（id 前缀 `hook:`）保留。

### 4.3 headers 来源取舍

headers 只从 **hook** 取（便宜、只覆盖 JS 请求、天然不含浏览器自动头）；**不给 webRequest 加 `extraHeaders`**——避免全程常驻下每请求的 `extraHeaders` 监听开销。代价：文档/img/script 等非 JS 请求只有元数据、无 headers。脱敏 + 头值长度截断在 SW 入缓冲时统一做。

### 4.4 读路径

三个工具直接读 SW 同进程内存缓冲，不走 content script 往返。SW 被杀 → 缓冲丢失（webRequest / 中继消息会唤醒 SW 重新填充，历史 best-effort，文档标注）。

## 5. 组件与文件改动

### 新建

| 文件 | 职责 | 可单测 |
|---|---|---|
| `entrypoints/hook.content.ts` | MAIN world CS（`document_start`）：包装 fetch/XHR/console + backlog + flush | 逻辑抽到 observe/* 后单测，注入行为手测 |
| `observe/serialize.ts` | 纯函数：console 参数安全序列化（循环/DOM/函数/大对象截断） | ✅ |
| `observe/redact.ts` | 纯函数：headers 脱敏 + 头值/条数截断（脱敏开关由调用方 observe-store 读 settings 后传入，保持纯函数） | ✅ |
| `background/observe-store.ts` | SW 环形缓冲（console/network per-tab）+ webRequest 接线 + hook body 关联 | ✅ |
| `agent/tools/observe.ts` | `doListConsoleMessages` / `doListNetworkRequests` / `doGetNetworkRequest` | ✅ |

### 修改

| 文件 | 改动 |
|---|---|
| `entrypoints/content.ts` | + 监听 `HOOK_*` window.msg → 中继 SW；attach 发 `RELAY_READY`；删死代码 `EVALUATE` case |
| `entrypoints/background.ts` | `NETLOG_PUSH` stub → 接 observe-store 真实通道；attach webRequest 监听 |
| `shared/messages.ts` | + `HOOK_CONSOLE`/`HOOK_NETWORK`/`RELAY_READY` 通知类型；删 `CONSOLE_READ`（改读 SW 缓冲） |
| `agent/tools/schemas.ts` | +3 schema（16→19） |
| `agent/tools/registry.ts` | +3 分发，豁免受限页预检 |
| `storage/settings.ts` | `AgentConfig` + `networkCaptureHeaders: 'redacted'\|'full'`（默认 `'redacted'`） |
| `stores/chat.ts` + `components/chat/ChatView.tsx` | 工具卡片复用现有 output 文本渲染（console/network 文本化，无新 UI） |
| `wxt.config.ts` | 确认 MAIN world CS 注册（WXT `world:'MAIN'`） |

> **并发注意**：`content.ts` 被其他会话频繁改动。删 `EVALUATE` 死代码前先 `git diff` 看落定状态，只在无冲突时顺手清，否则留独立提交。全程精确 `git add <具体文件>`，绝不 `git add -A`。

## 6. 工具契约（schema）

```
list_console_messages
  level?: 'log'|'info'|'warn'|'error'|'debug'   过滤级别（默认全部）
  limit?: number                                 最多返回条数（默认 50，上限=缓冲上限 200）
  → data: { messages: [{ id, level, text, ts, url? }] }

list_network_requests
  method?: string                                过滤方法
  urlContains?: string                           url 子串过滤
  status?: number                                过滤状态码
  limit?: number                                 默认 50
  → data: { requests: [{ requestId, method, url, status, type, ts, durationMs, hasBody }] }
        // 摘要不含 body/headers（防列表膨胀）；hasBody 提示可 get 详情

get_network_request
  requestId: string                              来自 list_network_requests
  → data: { requestId, method, url, status, type, ts, durationMs,
            requestHeaders?, responseHeaders?,    // 脱敏后（若该请求有 hook 数据）
            requestBody?, responseBody?,          // 截断 64KB（若文本类且 hook 捕获到）
            truncated?, source: 'webRequest'|'hook'|'merged' }
```

设计取舍：

- `list_*` 只回**摘要**（不含 body/headers）；`get_network_request` 才回完整详情——列表轻、按需深挖，对齐 http_request body 截断惯例。
- `requestId` 用 webRequest 原生 id 作稳定句柄；纯 hook 独立条目用 `hook:<loadNonce>:<seq>` 前缀 id（含 loadNonce 防跨加载 seq 重置串号）。
- 三工具**读 SW 缓冲、零 CS 往返**，受限页返回空列表而非报错（读的是缓冲不是活页面）。此点**修正** Phase 3a handoff 中「console 属操作页面类需预检」的假设。

## 7. 协议扩展（`shared/messages.ts`）

```ts
// cs→bg fire-and-forget（扩展现有 CsToBgNotification 家族，无 correlationId）
interface HookConsoleNotification { type: 'HOOK_CONSOLE'; payload: { entries: ConsoleEntry[] } }
interface HookNetworkNotification { type: 'HOOK_NETWORK'; payload: { entries: HookNetEntry[] } }
interface RelayReadyNotification  { type: 'RELAY_READY';  payload: Record<string, never> }

// 删除：BgToCsRequestMap.CONSOLE_READ（console 改读 SW 缓冲，不再走 CS 请求）
//       → content.ts 对应 case 一并删，exhaustive never 检查须仍成立
// 处理：旧 NETLOG_PUSH stub 语义并入 HOOK_NETWORK，删 background.ts 旧 stub handler

// 数据形状（供 hook / store / 工具共享）
interface ConsoleEntry { id: string; level: string; text: string; ts: number; url?: string }
interface HookNetEntry {
  seq: number; method: string; url: string; ts: number; endTs?: number;
  status?: number; requestHeaders?: Record<string,string>; responseHeaders?: Record<string,string>;
  requestBody?: string; responseBody?: string; truncated?: boolean;
}
```

## 8. 边界与错误处理

### 8.1 hook 透明性（绝不破坏页面）

- 包装 `fetch`：用 `response.clone()` 读 body，原 response 原样返回给页面；只对文本类 content-type 且 ≤ 读取上限时读，`clone().text()` 包 try/catch，任何异常吞掉不外抛。
- 包装 `XHR`：`open`/`send` 记录，`loadend` 读 `responseText`（仅文本类型）；hook 自身错误全 try/catch 兜底。
- console 包装：**永远先调原始方法**再采集，采集失败不影响页面日志。
- 过滤自身噪声：中继用的 `runtime.sendMessage`、扩展自身请求（`chrome-extension://`）不纳入观测。

### 8.2 时序与丢失

- 早期请求（hook 安装前）：webRequest 主干仍记到（SW 早于页面），body 缺失标 `hasBody:false`。
- backlog flush 去重靠 `loadNonce:seq` 单调 id；`loadNonce` 每次页面加载重置，防跨导航串号。
- SW 重启：缓冲丢失，新事件重新填充——best-effort，不持久化（会话不 keyed 于此）。

### 8.3 缓冲上限

- console / network 各 per-tab **200 条环形**。
- 单条 body 截断 **64KB**、header 值截断 **2KB**、header 条数上限。
- tab 关闭 → 删该 tab 缓冲；`main_frame` 导航 → 清该 tab 缓冲。

## 9. 测试策略（沿用 Phase 2/3a 惯例）

- **纯函数单测**（无浏览器）：
  - `serialize.ts`：循环引用 / DOM 节点 / 函数 / 大对象截断。
  - `redact.ts`：敏感头替换 / 长度截断 / 全量开关。
  - `observe-store.ts`：环形淘汰 / 关联窗口命中与错过 / `main_frame` 清空 / 去重。
- **工具执行器单测**：`observe.ts` 三工具喂 mock 缓冲，验过滤 / 摘要 vs 详情 / 空缓冲 / 受限页豁免。
- **registry 分发单测**：三工具豁免受限页预检（`chrome://` 返回而非报错）。
- **schema 单测**：16→19，新工具必填 / 枚举断言。
- **协议类型回归**：新通知类型可赋值；`CONSOLE_READ` 删除后 content.ts exhaustive `never` 检查仍成立。
- **jsdom 限制**：真实 `webRequest` / MAIN world 注入 / 跨 world postMessage 不可用 → 单测 mock，真实行为留手测（hook 是否 `document_start` 生效、body 关联命中率、脱敏效果）。

## 10. 给后续阶段的接口契约（本阶段冻结）

- `background/observe-store.ts`：per-tab 环形缓冲 + 关联逻辑独立成模块，后续「深度诊断模式」（debugger/CDP）可作为第二数据源并入同一缓冲。
- 观测数据形状（`ConsoleEntry` / `HookNetEntry`）冻结，工具契约向后兼容。
- MAIN hook 基础设施（`hook.content.ts` + 中继 + `RELAY_READY` 握手）可复用于后续任何需要 MAIN world 能力的工具。

## 11. 已知降级（实现中接受）

- headers 只覆盖 JS 发起的请求（webRequest 无 extraHeaders）。
- body 关联是 best-effort（同 url+method 短时间多次请求可能错配，时间窗兜底）。
- SW 重启丢缓冲。
- 大流量页面环形缓冲会淘汰早期条目（200 条上限）。
- hook 无法覆盖 `document_start` 之前浏览器已发起的极早期请求的 body。
