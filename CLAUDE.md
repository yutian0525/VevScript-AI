# ai-browser-extend

AI 驱动的浏览器操控助手。

让 AI 通过 accessibility snapshot（uid 树）和 DOM 动作操控网页。本项目是 Phase 1 骨架，已完成设计系统、侧边栏导航、聊天视图、脚本视图、设置视图和调试台。

## 技术栈

- **WXT** + **React 19** + **TypeScript 7**，面向 Chrome MV3（后续兼容 Firefox）。
- **Zustand**：状态管理（`stores/chat.ts`、`stores/ui.ts`）。
- **lucide-react**：图标（禁止用 emoji 代替图标）。
- **vitest v4** + **jsdom**：单元测试。

## 项目结构

```text
entrypoints/
  sidepanel/          侧边栏主 UI（App.tsx、styles.css）
  background.ts       Service Worker 入口
  content/            content script 入口
agent/
  tools/              工具注册表、schema、具体工具实现
  provider/           LLM provider 抽象
  run-turn.ts         agent 单轮执行
background/
  router.ts           消息路由
  agent-port.ts       长连接管理、CS_READY 等待
  debug-exec.ts       调试台工具执行通道
components/
  ui/                 通用 UI 组件
  chat/               聊天视图
  scripts/            脚本/快捷指令视图
  settings/           设置视图
  debug/              调试台视图
shared/
  messages.ts         前后台/CS 消息类型
stores/
  chat.ts             会话状态
  ui.ts               UI 状态
```

## 开发约定

### 样式

- 所有样式走 `entrypoints/sidepanel/styles.css`。
- 使用 CSS 变量（`:root` tokens），禁止硬编码色值。
- 当前主题色 `--signal: #53589a`，背景 `--paper: #efefef`。
- 双声道排版：`mono` 类用于机器语言（工具名、uid、JSON、状态令牌），`sans` 用于人语言。
- 组件通过 `className` 复用 `.btn`、`.input`、`.gauge` 等工具类。
- 动画必须考虑 `prefers-reduced-motion` 兜底。

### 工具开发

- 新增工具：在 `agent/tools/` 实现，注册到 `registry.ts`，并补充 schema。
- schema 会自动同步到调试台，无需额外修改 UI。
- 工具返回值统一使用 `{ ok: true, data? } | { ok: false; error }` 判别联合类型。

### 前后台通信

- 消息类型统一定义在 `shared/messages.ts`。
- 后台路由在 `background/router.ts`，入口挂在 `entrypoints/background.ts`。
- content script 就绪通知走 `CS_READY`，由 `background/agent-port.ts` 唤醒等待者。

## 常用命令

```bash
npm run dev          # 开发模式
npm run build        # 生产构建
npm run compile      # TypeScript 检查
npm run test         # 运行测试
```

## 当前阶段

`feature/phase1-skeleton` 已完成：

1. 设计系统落地（tokens、组件类、动效 keyframes、reduced-motion 兜底）。
2. 组件 className 化：`Button`、`Input`、`PageShell`、`ChatView`、`SettingsView`、`ScriptsView`。
3. Live 仪表条、滑动信号条导航、调试页入口。
4. 调试台 `DebugView` + 后台 `DEBUG_EXEC_TOOL` 通道 + 单测覆盖。

后续 Phase 2+ 将逐步接入真实 LLM 调用、完整 agent 循环、网络日志、多步任务等能力。

Phase 3a（感知与外联轻量集）已完成：新增 7 个工具 —— tabs 管理（list_pages/new_page/close_page/select_page，loop 持有可变 targetTab）、take_screenshot（喂多模态模型，注入 user 图片消息，压缩长边≤1024/jpeg，UI 卡片渲染缩略图）、evaluate_script（scripting.executeScript 注入包裹器 + 超时 + 序列化校验）、http_request（带凭证 fetch + 响应头白名单 + body 截断 64KB + 30s 超时）。工具总数 9→16。

待做（Phase 3b）：MAIN world hook 基础设施 + list_console_messages + 网络双通道观察（list/get_network_requests）。

Phase 4（脚本池）已完成（`feature/phase4-script-pool`）：`chrome.userScripts` 注入引擎（enabled↔register/unregister diff 同步 + 启动自愈）、脚本 CRUD/搜索/导入导出/启停 UI（列表 + 详情双页）、per-tab 运行态跟踪（「预期注入」语义，SCRIPTS_RUNTIME 广播）、TM 元数据兼容（`shared/userscript-meta.ts` 解析/序列化，GM_* 不做、带警告徽标）、AI 六工具 `list/get/create/update/delete/toggle_script`（工具 16→22，与 UI 共用 `background/scripts.ts` 编排层；确认门控下阶段经该文件 handler 拦截位接入 `confirmGate`）。

Phase 4 修订（2026-09-02，文本为源）：`UserScript.text`（完整 .user.js 原文）为唯一真源，name/matches/code/runAt/world/meta 均为保存时 `parseUserScript` 的解析投影（旧记录 `stringifyUserScript` 反拼惰性迁移，text 上限 280KB）；`@include` pattern 形式并入 matches、新增 `@world` 键；`@match` 容错（合法并入、非法警告+跳过该条，不因一条坏规则整条拒绝导入——贴合 TM 导入即可用）；详情页=源码编辑器+实时解析面板（无表单填空）；工具修订：`get_script` 行区间读取（offset/limit + totalLines）、`create_script` 参数改 `source`（完整 .user.js 文本）、`update_script` patch={text | edit 行区间 | enabled}，替换后整体重解析。

Phase 5（GM_* API + 管理器优化）已完成：14 个 GM API（`shared/gm-apis.ts` 注册表为唯一入口；wrapper `shared/gm-wrapper.ts` 按 @grant 精确安装 + 值快照直嵌 + 语法预探测；桥 `shared/gm-bridge.ts` 三事件 gmreq/gmres/gmevt + 确定性 token `background/gm-token.ts`；ISOLATED 桥宿主 `content/gm-bridge-host.ts`；SW 中心 `background/gm-api.ts`——grant 白名单/值广播/菜单表/错误缓冲 + @connect 三分支 60s 确认队列 + 批准卡）；脚本错误捕获展示（环形缓冲 20 条 + 列表徽标 + 详情折叠区）；grant 徽标精确化（classifyGrants）；菜单命令入口（侧边栏脚本页）；@require/@resource 预取缓存（`background/gm-resources.ts`，7 天 TTL/单文件 2MB/总量 10MB）。API 文档 `docs/gm-api.md`。已知降级：无 unsafe header 改写（无 DNR）、XHR 非流式 ≤1MB、token 防伪非 VM 级、SW 重启丢内存态（菜单靠 reload 自愈）、handleUpdate 预取告警不进 UI、早到 gmreq 竞态（Phase 6 握手+backlog 收口）。工具计数 22 不变（summary 增字段）。
