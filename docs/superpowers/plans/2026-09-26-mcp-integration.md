# MCP 接入实施计划（2026-09-26）

设计依据：`docs/superpowers/specs/2026-09-26-mcp-integration-design.md`。
TDD：每个模块先写失败测试，再写最小实现。

## T1 协议层纯函数（无依赖，先测先写）

| 文件 | 内容 |
|---|---|
| `tests/agent/mcp-sse.test.ts` | SSE 帧解析：单/多事件、`data` 多行拼接、`event:` 名、无 `event:` 默认 message、粘包半行、CRLF |
| `agent/mcp/sse.ts` | `parseSseChunk(buffer)` → `{ events, rest }`；`sseTextToResult(events)` 取首个含 `result`/`error` 的 JSON |
| `tests/agent/mcp-naming.test.ts` | 净化、64 字符截断 + 哈希、`mcp__` 前缀判定与反查 |
| `agent/mcp/naming.ts` | `sanitizeSlug`、`exposeToolName(slug, tool)`、`isMcpToolName`、`toolNameToSlugAndTool` |

验收：`npx vitest run tests/agent/mcp-sse.test.ts tests/agent/mcp-naming.test.ts` 绿。

## T2 MCP 客户端

| 文件 | 内容 |
|---|---|
| `tests/agent/mcp-client.test.ts` | 用注入的假 fetch 覆盖：Streamable 直连成功、`initialize` 失败回退 SSE、SSE endpoint 事件解析、`tools/list` 分页无关、`tools/call` 结果/错误、会话 id 回传、超时 |
| `agent/mcp/client.ts` | `createMcpClient({ url, transport, headers, timeoutMs, fetchImpl })` → `{ initialize, listTools, callTool, close }` |

验收：上述测试绿。

## T3 配置存储

| 文件 | 内容 |
|---|---|
| `shared/mcp.ts` | `McpServerConfig` / `McpServerState` / `McpStatus` / `McpToolInfo` |
| `storage/mcp.ts` | `listMcpServers` / `saveMcpServer` / `removeMcpServer` / `setMcpServerEnabled` / `exportMcpJson` / `importMcpJson` |
| `tests/storage/mcp.test.ts` | 增删改、重复名、非法 URL、导入只吃 url 条目 + stdio 条目进 warning、导出可回环 |

验收：上述测试绿。

## T4 后台管理模块

| 文件 | 内容 |
|---|---|
| `agent/mcp/bridge.ts` | `setMcpBridge` / `getMcpBridge`，接口 `{ toolSchemas(): Promise<ToolSchema[]>; callTool(name, args, ctx): Promise<ToolResult> }` |
| `background/mcp.ts` | 连接表 `Map<id, Entry>`；`ensureConnected` / `connect` / `disconnect` / `statusList` / `broadcast`；注册 handler |
| `shared/messages.ts` | 新增 `McpRequest` 联合类型 + `MCP_STATE` 广播事件 |
| `tests/background/mcp.test.ts` | 用假 client 注入：连接成功/失败状态流转、禁用不连接、重连、状态广播、toolSchemas 只出启用且已连的 |

验收：上述测试绿。

## T5 接入 agent 链路

| 文件 | 改动 |
|---|---|
| `agent/tools/registry.ts` | 新增 `export async function buildToolSchemas(mode, memory)`；`executeTool` 开头加 MCP 分支（受限页预检之前） |
| `agent/loop.ts` | 第 153 行 `tools: getToolSchemas(...)` → `await buildToolSchemas(...)` |
| `entrypoints/background.ts` | `initMcpModule(router)` 注册 + 挂 bridge |
| `tests/agent/mcp-registry.test.ts` | MCP 工具进 schema、禁用 server 的工具不进、未注册 bridge 时安全降级、executeTool 派发 |

验收：`tests/agent/**` 全绿（含既有 `registry.test.ts` / `mode.test.ts` / `loop.test.ts` 不回归）。

## T6 设置页

| 文件 | 改动 |
|---|---|
| `components/settings/SettingsHome.tsx` | `SettingsSub` 加 `'mcp'`；「模型与会话」组加 `McpSettings` 入口卡（图标 `Plug`） |
| `components/settings/SettingsView.tsx` | 路由 `mcp` → `<McpSettings onBack={back} />` |
| `components/settings/McpSettings.tsx` | 新建：列表 + 表单 + 测连 + 导入导出 |

## T7 输入框状态钮

| 文件 | 改动 |
|---|---|
| `stores/mcp.ts` | zustand：`servers`、`states`、refresh/connect/disconnect/setEnabled、订阅 `MCP_STATE` |
| `components/chat/McpStatusButton.tsx` | 新建：图标钮 + 状态浮层（重连 / 禁用） |
| `components/chat/ChatView.tsx` | 在 `<DeepObserveToggle />` 之后插入 `<McpStatusButton />` |
| `entrypoints/sidepanel/styles.css` | `.mcpbtn`（同 `.deepobs` 形态）、`.mcppop` 浮层、`.mcprow` 行、`prefers-reduced-motion` 兜底 |

## T8 全量校验

- `npm run compile`（tsc --noEmit）零错误。
- `npm test` 全绿。
- 更新 `docs/history.md` 记录本节。
