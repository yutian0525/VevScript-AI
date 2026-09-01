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

Phase 3b（MAIN world hook 基础设施 + 观测三工具）已完成：新增 MAIN world content script（`world:'MAIN'` + document_start）包装 fetch/XHR/console + window.onerror/unhandledrejection，经 window.postMessage 桥给同页 ISOLATED content.ts（RELAY_READY 握手 + backlog flush 补早期观测），后者 runtime.sendMessage 中继到 SW 的 per-tab 环形缓冲（`background/observe-store.ts`）；webRequest 三事件（onBeforeRequest/onCompleted/onErrorOccurred）建全量网络元数据主干，hook 捕获的 fetch/XHR body 按 (method+url+±2s) best-effort 关联富化；主帧导航清网络缓冲、tab 关闭清全缓冲。新增 3 个工具 —— list_console_messages、list_network_requests、get_network_request（读 SW 缓冲、零 CS 往返、豁免受限页预检）。headers 只从 hook 取，入缓冲存原文、读取时按 `settings.agent.networkCaptureHeaders`（redacted 默认 / full）脱敏敏感头。工具总数 16→19。

待做（Phase 3c+）：见 `docs/superpowers/plans/2026-09-01-ai-browser-extension-phase3b.md` 末尾 handoff（已知降级：postMessage 同源页内可被监听、console.toString 反爬指纹、hookKeys 长命 SPA 增长、翻页迟到 flush、rel=noopener 无 openerTabId；未做：深度诊断模式 debugger/CDP、networkCaptureHeaders 设置页 UI）。
