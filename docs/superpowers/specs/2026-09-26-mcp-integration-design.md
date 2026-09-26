# MCP 接入设计（2026-09-26）

## 1. 目标与范围

把外部 MCP（Model Context Protocol）服务的工具接进织雀的 agent loop，让 AI 在对话里直接调用它们；同时给到两处 UI：设置页管配置，输入框左下角管连接状态。

**三条需求**：

1. AI 对话能连接并使用 MCP 工具。
2. 设置页新增「MCP 服务器」二级页（增删改、启停、测连、导入导出）。
3. 输入框左下角「网页调试」右侧新增图标，点开 MCP 连接状态列表（支持重连与禁用）。

## 2. 环境硬约束（决定架构）

- **MV3 扩展跑在浏览器里，无法启动本地子进程** → stdio 传输（Claude Desktop 那种 `npx xxx-mcp`）**不可能实现**。只支持 HTTP 类传输。
- **Service Worker 会被回收**（空闲约 30s）。长连接（SSE 的 GET 流）随 SW 死亡一起断，**无法维持常驻连接**。
- `host_permissions` 已是 `<all_urls>`，SW 内 `fetch` 跨域不需要额外授权。

**由此定下两条架构决策**：

| 决策 | 内容 | 理由 |
|---|---|---|
| 传输 | 仅 HTTP：Streamable HTTP（2025-06-18）+ HTTP+SSE（2024-11-05），`auto` 自动探测 | 覆盖现存绝大多数远端 MCP 服务；stdio 在浏览器里物理不可行 |
| 连接模型 | **按需连接 + 内存缓存**，不保活 | SW 生命周期不可控；把「重连」做成一等公民动作，与需求 3 的「支持重连」天然对齐 |

## 3. 传输实现

两种传输共用一套 JSON-RPC 2.0 编解码与 SSE 帧解析，差别只在「请求发到哪、响应从哪读」。

### 3.1 Streamable HTTP（优先）

```
POST <url>
Accept: application/json, text/event-stream
Content-Type: application/json
Mcp-Session-Id: <上次响应回传的会话 id>   // 首次不带
body: {"jsonrpc":"2.0","id":1,"method":"initialize","params":{...}}
```

- 响应 `application/json` → 直接解析。
- 响应 `text/event-stream` → 按 SSE 帧解析，取第一个带 `result`/`error` 的 message 事件。
- 响应头 `Mcp-Session-Id` → 记下，后续请求原样回传。
- 判定失败：HTTP 404/405、或返回非 MCP 内容 → 回退到 SSE 传输。

### 3.2 HTTP+SSE（回退）

```
GET  <url>            Accept: text/event-stream
→ event: endpoint
  data: /messages?sessionId=abc123     // 可能是相对或绝对 URL

POST <endpoint 解析后的绝对 URL>   body: JSON-RPC（可不带 id 的通知，或带 id 的请求）
→ 响应不在此连接的 HTTP body 里，而是从 GET 流上按 id 匹配回来
```

实现要点：GET 流用一个常驻 reader 循环，把 `{ id, result|error }` 投进 `Map<id, deferred>`；`request()` 发 POST 后 await 对应 deferred。

### 3.3 握手序列

1. `initialize`：`protocolVersion: '2025-06-18'`、`capabilities: {}`、`clientInfo: { name: 'vevscript-ai', version }`。
2. `notifications/initialized`：通知，无 id，不等响应。
3. `tools/list`：拉工具清单。
4. `tools/call`：按需。

服务端返回的 `protocolVersion` 原样记录到状态里（UI 展示用），不做强校验——各实现版本字段混乱，强校验只会制造假失败。

## 4. 工具命名

- 暴露名：`mcp__<serverSlug>__<toolName>`。
- `serverSlug` = server 名做 `[^a-zA-Z0-9_-] → _` 净化，空则回落到 id；跨 server 撞车时追加 `_2/_3`。
- OpenAI function name 上限 64 字符：超长时截断 tool 段并追加原名的 4 位哈希，保证唯一且可反查。
- 反查：后台维护 `Map<exposedName, { serverId, toolName }>`，随工具清单一起构建。

净化后的名字必须能 `JSON.parse` 进大部分网关（实测部分网关对 `.`/`/` 敏感），这是做净化的唯一理由。

## 5. 状态机

每台 server 一台：

```
disabled ──(启用)──> idle ──(连接)──> connecting ──> connected
                       ^                  │
                       └──(禁用/失败)──── error
```

- `disabled`：用户关了。不连接、不下发工具。
- `idle`：未连接（SW 刚醒、或从未连过）。**不自动重连**——避免 SW 每次唤醒都打一片外部服务。
- `connecting` / `connected` / `error`（带 `error` 文案）。

状态变更由后台广播 `MCP_STATE` 到所有扩展页面，面板 store 只做缓存（与 `DEEP_OBSERVE_STATE` 同构）。

## 6. 分层与依赖方向

```
agent/mcp/sse.ts        纯函数：SSE 帧解析
agent/mcp/naming.ts     纯函数：工具名净化 / 反查
agent/mcp/client.ts     传输 + 握手 + tools/list + tools/call（fetch 可注入，便于测试）
agent/mcp/bridge.ts     注入点：registry（agent 层）↔ 后台管理器，避免 agent 层反向依赖 background
storage/mcp.ts          配置 CRUD + 导入导出
background/mcp.ts       连接管理、路由 handler、广播
stores/mcp.ts           面板侧状态缓存
```

`agent/tools/registry.ts` 只认 `bridge` 接口，不 import 任何 background 模块——保持现有分层不被破坏。

## 7. 接入 agent loop

- `registry.buildToolSchemas(mode, memory)` → **异步**（MCP `tools/list` 是网络调用）：内置 schema + bridge 提供的 MCP schema。`getToolSchemas` 保持同步签名不变（既有测试与调试台依赖）。
- `loop.ts` 第 153 行改 `await buildToolSchemas(...)`。
- `executeTool` 开头加一条分支：名字命中 `mcp__` 前缀 → 交 bridge 派发；**放在受限页预检之前**（MCP 不碰当前页面）。
- ask 模式：MCP 工具不在 `ASK_MODE_TOOLS` 白名单里 → 自动被过滤掉。我们不逐工具判定只读性，一律不进 ask 模式（fail-safe）。
- 确认闸门：MCP 工具未在 `SENSITIVE_TOOLS`/`MICROP_TOOLS`/`READONLY_TOOLS` 任一集合里，`needsConfirm` 的 fail-safe 分支会让它在 sensitive 档**需要确认**——正是本次选定的默认行为。确认卡的「本会话允许」可逐会话放行。

## 8. UI

### 8.1 设置页

`SettingsHome` 的「模型与会话」组加一条：`MCP 服务器`（图标 `Plug`）。二级页 `components/settings/McpSettings.tsx`：

- 列表：每台一行 —— 状态点 + 名称 + URL + 工具数 + 启停开关 + 重连 + 编辑 + 删除。
- 表单（新增/编辑）：名称、URL、传输（auto / streamable / sse）、自定义请求头（键值对，支持 `Authorization`）。
- 底部：测试连接、导入 JSON、导出 JSON。
- 导入格式兼容 Claude Desktop 的 `{ "mcpServers": { "<name>": { "command": ..., "args": [...] } | { "url": ..., "headers": {...} } } }`：**只吃带 `url` 的条目**，stdio 条目跳过并汇总到 warning（浏览器跑不了，静默丢弃会让用户以为导入成功）。

### 8.2 输入框状态钮

`components/chat/McpStatusButton.tsx`，紧跟 `DeepObserveToggle` 右侧（即需求里的「网络调试右侧」）。

- 图标 `Plug`；聚合色：`--signal`=全部已连、`--warn`=有服务异常、`--ink-3`=无服务或未连接。
- 点击弹出浮层（复用会话抽屉的 scrim + 绝对定位模式）：每台一行 —— 状态点、名称、工具数、错误文案（截断 + tooltip）、「重连」钮、「禁用/启用」开关。
- 浮层打开时主动发一次 `MCP_REFRESH`：SW 若已休眠，这次请求会唤醒它并按需重连，列表不会显示一片假 idle。

## 9. 不做（YAGNI）

- stdio 传输 / Native Messaging 桥。
- OAuth 流程（只支持静态 header，含 Bearer token）。
- MCP resources / prompts（只要 tools）。
- 连接自动重试（用户手动重连，或下次用到时按需连接）。
- 单工具粒度的开关（本次选定按 server 粒度）。
