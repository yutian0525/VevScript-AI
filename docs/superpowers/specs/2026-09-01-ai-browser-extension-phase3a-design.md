# AI Browser Extension 设计文档（Phase 3a：感知与外联 · 轻量集）

> 本文档是整体设计 [2026-08-28-ai-browser-extension-design.md](./2026-08-28-ai-browser-extension-design.md) §7 路线图里 **Phase 3「感知与网络」的前半**。Phase 3 被切成两轮：
> - **3a（本文档）**：不依赖 MAIN world 注入基础设施的轻量集 —— tabs 管理、take_screenshot、evaluate_script、http_request。
> - **3b（后续单独 spec）**：MAIN world hook 基础设施 + list_console_messages + 网络双通道观察（list/get_network_requests）。

## 1. 目标与定位

给 agent 补上「看得更全 + 够得更远」的能力，且**不引入新的运行时基础设施**（继续只用 isolated world content script + background chrome API）：

- **看得更全**：`take_screenshot` 让 agent 用视觉理解页面（布局、图表、验证码、canvas 渲染内容），弥补 a11y 快照的纯文本盲区。
- **够得更远**：`evaluate_script` 在页面里跑任意 JS 取深层数据；`http_request` 直接打接口；tabs 四工具让 agent 跨标签干活。

**非目标（明确排除，归 3b / 后续 Phase）**：MAIN world hook、console 读取、网络观察双通道、http_request 的确认门控、fullPage 滚动拼接截图。

### 已确认的关键决策（来自 brainstorming）

1. **范围切分**：Phase 3 拆 3a + 3b，本轮只做 3a 四类工具。
2. **截图定位**：**喂给模型（多模态）**。provider wire 层已支持 `image_url`（`ContentPart`），无需改造 provider；模型不支持 vision 时由用户配置负责，视为已知限制。
3. **标签模型**：**可变操作目标** —— loop 持有 `targetTab`，`new_page`/`select_page` 改变它，后续 snapshot/click/screenshot 作用于新目标；**会话历史统一归属启动标签**（单一上下文）。手动会话/上下文管理留待后续 Phase。
4. **http_request 安全**：**带 same-origin cookie（credentials:'include'）**，确认门控留待后续完善。当前存在「被注入可冒用登录态」风险，记入 §7 已知风险。

## 2. 工具清单（9 → 16）

对齐 chrome-devtools-mcp 的工具名与语义（[docs/chrome-devtools-mcp-功能文档.md](../../chrome-devtools-mcp-功能文档.md)）。

| 工具 | 参数（概要） | 实现路径 | 类别 |
|---|---|---|---|
| `list_pages` | 无 | `tabs.query` | chrome-API |
| `new_page` | url, background? | `tabs.create` | chrome-API · **改 targetTab** |
| `close_page` | tabId | `tabs.remove` | chrome-API |
| `select_page` | tabId | `tabs.update({active:true})` | chrome-API · **改 targetTab** |
| `take_screenshot` | format?, quality? | `tabs.captureVisibleTab` + 压缩 | chrome-API · **注入图片消息** |
| `evaluate_script` | function, args?, world?, timeoutMs? | `scripting.executeScript` | chrome-API · 受限页预检 |
| `http_request` | url, method?, headers?, body? | background `fetch` | 网络 |

> 全部走 **chrome-API 分支**（background 直接调 chrome API / fetch），不经过 `messages.ts` 的 content script request/response 协议。`evaluate_script` 用 `chrome.scripting.executeScript` 直接注入执行，比走 content 消息更干净；现有 `entrypoints/content.ts` 里的 `EVALUATE` 占位分支废弃（保留 `CONSOLE_READ` 占位给 3b）。

## 3. 文件改动清单

```
agent/tools/
  tabs.ts        新建  list/new/close/select 执行器（纯函数式，返回 ToolResult + targetTab）
  screenshot.ts  新建  capture + 压缩（压缩函数抽出便于 mock）
  evaluate.ts    新建  executeScript 包裹 + JSON 序列化 + 超时
  http.ts        新建  fetch + 响应头裁剪 + body 截断
  schemas.ts     改    +7 个 ToolSchema
  registry.ts    改    chrome-API 分发扩展 + 受限页预检适用面收窄 + targetTab 透传
agent/
  loop.ts        改    持有 targetTab；工具后更新；截图后注入 user 图片消息
  context.ts     改    历史图片消息裁剪（保留最近 N 条）
shared/
  messages.ts    改    PortMsgToPanel.tool-end 加可选 image?
stores/
  chat.ts        改    tool-end 读 image → 卡片缩略图
components/chat/
  ChatView.tsx   改    工具卡片渲染截图缩略图
```

## 4. 机制一：可变操作目标 targetTab

Phase 2 的 loop 假设「一个 tabId 绑定整个会话，所有工具作用于它」。引入多标签工具后，需要区分**操作目标**（会变）与**会话归属**（不变）。

**接口改动**：`LoopDeps.executeTool` 签名增加 `tabId` 参数：

```ts
executeTool: (name, args, tabId, signal) => Promise<ToolResult>;
```

**loop 内状态机**（`drive` 内）：

```
let targetTab = startTabId;   // 启动标签
每轮工具执行：executeTool(name, args, targetTab, signal)
  执行后检查结果：
    - name==='new_page'    && r.ok → targetTab = r.data.targetTab
    - name==='select_page' && r.ok → targetTab = r.data.targetTab
    - name==='close_page'  && r.ok && r.data.closed===targetTab → targetTab = startTabId
getPageInfo(targetTab)  // context 里的当前页信息也跟随 targetTab
```

- **会话历史仍 `keyed` 到 `startTabId`**（`storage/sessions.ts` 不变），实现「统一会话上下文」：跨标签的所有动作都追加到同一条会话。
- `getPageInfo` 从 `startTabId` 改为读 `targetTab` —— system prompt 里注入的「当前页面 URL/title」跟随操作目标，模型不会对着旧标签下判断。
- background 的 `makeDeps`（`agent-port.ts`）里 `executeTool` 从「闭包固定 tabId」改为「透传 loop 传入的 tabId」。`ToolCtx.tabId` 由每次调用注入。

## 5. 机制二：截图流与图片注入

### 5.1 捕获与压缩（`screenshot.ts`）

```
doScreenshot(tabId, { format='jpeg', quality=0.7 }):
  1. tabs.get(tabId) → windowId；若 tab 非 active，先 tabs.update(tabId,{active:true})
     （captureVisibleTab 只能截当前窗口可见标签）
  2. dataUrl = tabs.captureVisibleTab(windowId, { format:'jpeg', quality: 90 })
  3. compressed = await compressDataUrl(dataUrl, { maxEdge:1024, quality })
  4. 返回 { ok:true, data:{ screenshot: compressed, width, height } }
```

- `compressDataUrl` 用 `OffscreenCanvas` 降采样（长边 ≤ 1024，等比缩放）+ 重新编码 JPEG。**抽为独立导出函数**，jsdom 下 `OffscreenCanvas` 不可用 → 单测走 mock，真实压缩留手测（沿用 Phase 2 对 jsdom 限制的处理惯例）。
- MVP **只截可视区域**（fullPage 滚动拼接归 backlog）。

### 5.2 注入 messages（loop 内）

`take_screenshot` 的 tool result 不直接携带图片（tool-role 消息塞图片兼容性差），改由 loop 特判：

```
if tc.name==='take_screenshot' && r.ok:
  append { role:'tool', toolCallId, name, content: '截图已捕获，见下一条消息' }
  append { role:'user', content: [
    { type:'text', text:'（take_screenshot 返回的页面截图）' },
    { type:'image_url', imageUrl: r.data.screenshot },
  ]}
else:
  （原有 tool 消息追加逻辑）
```

- 复用已建好的 `toWireContent`（`openai-compat.ts`）→ image_url 转 wire 格式，无需改 provider。
- tool result 的 `data.screenshot` 不写进 tool 消息 content（避免 dataURL 进 tool-role），只用于 §5.2 的 user 消息与 §5.4 的 UI 事件。

### 5.3 历史图片裁剪（`context.ts`）

`buildContext` 组装时，对图片 `ContentPart` 做窗口保留：

```
只保留最近 KEEP_IMAGES=2 条含图片的 user 消息的图片 part；
更早的图片 part 原地替换为 { type:'text', text:'[历史截图已省略]' }。
```

防止长会话里累积的 base64 图片撑爆 token / storage。文本部分保留不动。

### 5.4 UI 缩略图

- `PortMsgToPanel` 的 `tool-end` 事件加可选字段 `image?: string`（截图 dataURL）。
- loop 在 `take_screenshot` 成功后，`emit({ type:'tool-end', ..., image: r.data.screenshot })`。
- `stores/chat.ts` 的 `tool-end` 分支把 `image` 存进 ChatItem；`ChatView.tsx` 工具卡片展开时渲染 `<img>` 缩略图。

## 6. 各工具返回契约（喂给模型的 tool result）

统一 `ToolResult<T>`；`data` 经 `toToolContent` JSON 序列化为 tool 消息 content。

| 工具 | 成功 data | 失败 error |
|---|---|---|
| `list_pages` | `{ pages:[{tabId,url,title,active,isTarget}] }` | `tabs.query` 异常 |
| `new_page` | `{ targetTab, url }` | url 缺失 / 创建失败 |
| `close_page` | `{ closed: tabId }` | tabId 缺失 / 移除失败 |
| `select_page` | `{ targetTab, url }` | tabId 无效 |
| `take_screenshot` | 文本占位（图片走 §5.2） | 受限页 / 捕获失败 |
| `evaluate_script` | `{ result: <JSON值> }` | 受限页 / 超时 / 抛异常 / 结果不可序列化 |
| `http_request` | `{ status, statusText, headers:{子集}, body:<截断64KB> }` | 网络错误 / URL 非法 |

- `evaluate_script`：`scripting.executeScript({ target:{tabId}, world, func, args })`，`func` 包装模型传入的 `function` 字符串并 `return` 其求值结果；结果经 `JSON.stringify` 校验可序列化，失败返回明确错误（提示模型返回可序列化值）。超时用 `Promise.race`（默认 5000ms）。
- `http_request`：background `fetch(url, { method, headers, body, credentials:'include' })`；响应头只回**白名单子集**（content-type/content-length/server 等）；body 按 `Content-Type` 取 text，截断至 64KB 并标注截断。

## 7. 安全与边界

- **受限页预检适用面**（`registry.ts`）：
  - 适用：`take_screenshot`、`evaluate_script`（直接操作页面内容）。
  - 豁免：`navigate_page`（已有）、`list_pages`/`new_page`/`close_page`/`select_page`（tabs 管理不碰页面内容）、`http_request`（background 独立发起，与当前页无关）。
- **http_request 带凭证的已知风险**：`credentials:'include'` 意味着 AI 能以用户登录态访问接口。在确认门控补上前，若被恶意页面注入指令（system prompt 已声明页面内容不可信，但非硬防线），存在冒用登录态 / 数据外泄风险。**接受为 MVP 现状**，后续 Phase 补门控闭合。
- **evaluate_script 是强力工具**（任意 JS 执行）：受限页阻断是其唯一边界；MAIN world 执行模型代码符合设计原意（`world` 默认 `main`）。
- **new_page 就绪等待**：新开标签用 `waitForCsReady(newTabId)` 等 content script 就绪再返回，避免后续 snapshot 打空。
- **targetTab 失效**：`close_page` 关掉 targetTab 后回落启动标签；若启动标签也已关闭，`getPageInfo` 返回空、后续工具报「标签不存在」由模型自行处理。

## 8. 测试策略

镜像源码路径放 `tests/`（沿用 Phase 2 约定）。

| 测试文件 | 覆盖 |
|---|---|
| `tests/agent/tools/tabs.test.ts` | list（含 isTarget 标注）/ new（返回 targetTab）/ close（返回 closed）/ select；tabId 无效错误 |
| `tests/agent/tools/screenshot.test.ts` | 捕获链路（mock captureVisibleTab + mock compress）；非 active 先激活；受限由 registry 覆盖 |
| `tests/agent/tools/http.test.ts` | fetch 成功（status/headers 子集/body 截断）；网络错误；body>64KB 截断标注 |
| `tests/agent/tools/evaluate.test.ts` | executeScript 结果透传 / 超时 / 不可序列化 / 抛异常（mock scripting.executeScript） |
| `tests/agent/tools/registry.test.ts`（改） | 新增分发路由 + 受限页预检适用面 + targetTab 透传给执行器 |
| `tests/agent/loop.test.ts`（改） | new_page/select_page 后 targetTab 更新；close targetTab 回落；截图注入 user 图片消息两案 |
| `tests/agent/context.test.ts`（改） | 图片消息裁剪（保留最近 N，更早替换文本占位） |
| `tests/stores/chat.test.ts`（改） | tool-end 带 image → ChatItem 存缩略图 |

- **jsdom 限制**：`OffscreenCanvas` 不可用 → 压缩函数走 mock；真实压缩、真实 `captureVisibleTab`/`executeScript` 留手测。
- 手测清单：截图喂模型看图回答、跨标签任务（开新标签→操作→切回）、evaluate 取数据、http_request 打公开接口、受限页 screenshot/evaluate 被阻断。

## 9. 给 3b 的接口契约（本轮冻结）

- `agent/tools/registry.ts`：`executeTool(name, args, ctx)` 的 `ctx.tabId` 语义 = 当前操作目标；chrome-API 分发表可继续扩展。
- `agent/loop.ts`：`LoopDeps.executeTool` 签名含 `tabId`；`targetTab` 状态机对 3b 的 console/网络工具透明（它们也接收 targetTab）。
- `shared/messages.ts`：`CONSOLE_READ` 占位保留给 3b；`NETLOG_PUSH` 通知类型已存在（3b 的 hook 通道上报用）。
- `wxt.config.ts`：`webRequest` 权限已声明（3b 通道 1 用）。
- `storage/settings.ts`：`agent.screenshotPolicy`（never/on-demand）已存在 —— 3a 的 `take_screenshot` 应读它（never 时工具返回「截图已按设置禁用」）。

## 10. 已知降级与偏离（MVP 接受）

- 截图只截可视区域，无 fullPage 滚动拼接。
- http_request 无确认门控、带凭证（见 §7）；无同源代理降级（CORS 由目标服务器决定，跨域失败原样回模型）。
- evaluate_script 结果必须 JSON 可序列化（DOM 节点、循环引用等需模型自行取标量/文本）。
- targetTab 仅在单次 loop 运行内有效，不持久化；SW 被杀恢复后回落启动标签（完整会话恢复归 Phase 5）。
- 模型 vision 能力不检测，由用户配置负责；非 vision 模型收到 image_url 可能报错，视为配置问题。

