# 织雀AI脚本（Vevscript-ai）

在侧边栏说一句话，AI 就在当前网页上替你做完。常做的事，写成用户脚本以后自动跑。AI 驱动的浏览器 agent harness——多轮 loop、上下文压缩、权限模式、流式续播、会话持久化、技能加载，机件齐全，运行时目标是你的浏览器。

让 AI 通过 accessibility snapshot（uid 树）和 DOM 动作操控网页。详细开发历程与各迭代设计记录见 `docs/history.md`，设计文档在 `docs/superpowers/specs/`。

## 技术栈

- **WXT** + **React 19** + **TypeScript 7**，面向 Chrome MV3（后续兼容 Firefox）。
- **Zustand**：状态管理（`stores/chat.ts`、`stores/ui.ts`）。
- **lucide-react**：图标（禁止用 emoji 代替图标）。
- **vitest v4** + **jsdom**：单元测试。

## 项目结构

```text
entrypoints/
  sidepanel/          侧边栏主 UI（App.tsx、styles.css）
  conv-debug/         AI 会话调试页（独立标签页，从设置页打开）
  background.ts       Service Worker 入口
  content/            content script 入口
agent/
  tools/              工具注册表、schema、具体工具实现
  provider/           LLM provider 抽象
  run-turn.ts         agent 单轮执行
  context.ts          buildContext 上下文组装
  compact.ts          上下文压缩
  memory-prompt.ts    记忆三层注入
background/
  router.ts           消息路由
  agent-port.ts       长连接管理、CS_READY 等待
  observe-store.ts    per-tab 观测环形缓冲
  scripts.ts          脚本编排层（UI 与 AI 工具共用）
  gm-api.ts           GM_* SW 中心
  ext-update.ts       扩展自身更新检查（纯自分发清单）
  storage-manager.ts  存储管理（统计/清理/备份导入导出）
components/
  ui/                 通用 UI 组件
  chat/               聊天视图（含 Markdown.tsx）
  scripts/            脚本/快捷指令视图
  settings/           设置视图（壳 + 二级页）
  debug/              调试台视图
  convdebug/          AI 会话调试页（会话列表 + 轮次时间线 + 原始消息流）
shared/
  messages.ts         前后台/CS 消息类型
  gm-apis.ts          GM API 注册表（唯一入口）
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

### 品牌资产

标识 = **编织的雀**：两条等宽斜杠交叉成展翼（mask 真挖空缺口），中央胶囊既是雀躯干也是鼠标滚轮。四份 SVG 在 `public/brand/`（`vv-weave-{mark,mono,tile,lockup}` 前缀防 mask id 撞车），几何定稿与设计约束见 `docs/history.md` 品牌资产节。

- 扩展图标 `public/icon/{16,32,48,96,128}.png` 由 `icon-tile.svg` 栅格化而来。WXT 自动发现该路径，**不要**在 `wxt.config.ts` 里显式声明 `icons`。
- slogan 口径联动六处：`wxt.config.ts` description、`package.json` description、README 引言、`landing/index.html` title/description/og、宣传页 H1。改口径时一起动。

### 工具开发

- 新增工具：在 `agent/tools/` 实现，注册到 `registry.ts`，并补充 schema。
- schema 会自动同步到调试台（能力域分组见 `components/debug/tool-tags.ts`），无需额外修改 UI。
- 工具返回值统一使用 `{ ok: true, data? } | { ok: false; error }` 判别联合类型。
- ask 模式工具白名单 `ASK_MODE_TOOLS`：收「看页面 + 答问 + 加载技能」档，口径是不产生持久化副作用，并非一切纯读工具都在内。

### 长内容写入

写长脚本/长内容先建骨架再分次追加（create 只交元数据头 + 未闭合 IIFE，末段 append 带 `})();` 闭合）；`shared/js-balance.ts` 配平扫描只报告不阻断。

### 前后台通信

- 消息类型统一定义在 `shared/messages.ts`。
- 后台路由在 `background/router.ts`，入口挂在 `entrypoints/background.ts`。
- content script 就绪通知走 `CS_READY`，由 `background/agent-port.ts` 唤醒等待者。
- Port 下行消息带 `convId`，面板按当前会话过滤；`agent:attach` 回放权威运行态 + 流式尾巴（`background/agent-tail.ts`）。

## 常用命令

```bash
npm run dev          # 开发模式
npm run build        # 生产构建
npm run compile      # TypeScript 检查
npm run test         # 运行测试
```

根 `tsconfig.json` 的 `exclude` 必须含 `landing`（`.wxt/tsconfig.json` 的 include 是 `../**/*` 会把它卷进来，而 landing 依赖 `vite/client` 类型）。

## 宣传页 landing/

独立 Vite + React 19 + TS 站点（自带 package.json，与 WXT 构建零耦合）。开源地址 <https://github.com/yutian0525/VevScript-AI>（`src/router.ts` 导出 `REPO` 常量）。字体用 `misans@4.1.0` 经 jsDelivr（自建 CDN 无 CORS 头，webfont 一律拒载；字重走 `--w-body`/`--w-bold` token，Regular=330、Semibold=520）。坑与设计约束详见 `docs/history.md` 宣传页节。

## 当前阶段

- 已完成各迭代的记录（Phase 1/3a/3b/4/5、多会话与上下文压缩、Markdown 渲染、流式续播、技能系统、写脚本流程优化、系统提示词自定义 + Agent 记忆、GM API 扩充 Tier A+B、深度观测（CDP 接管观测并退役 MAIN world hook）、品牌、宣传页、AI 会话调试页、上下文 token 优化）全部在 `docs/history.md`。
- 存储管理页（用量统计/可再生数据清理/全量备份导入导出）与扩展应用内检查更新（纯自分发方案）的迭代记录也在 `docs/history.md`。
- 工具总数 30（27 个功能工具 + 记忆三工具），GM 函数 grant 29 + 特殊 grant 4。
- 已知降级与待做清单见 `docs/history.md` 各节及 `docs/superpowers/plans/2026-09-01-ai-browser-extension-phase3b.md` 末尾 handoff。
