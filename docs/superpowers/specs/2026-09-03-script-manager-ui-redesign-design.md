# 脚本管理器 UI 重设计 + popup + 全屏详情页 设计规格

日期：2026-09-03
分支：feature/settings-hub-script-debug（worktree feat/script-optimize）
状态：已经用户逐节确认

## 0. 背景与目标

Phase 4/5 落地的脚本池 UI（侧边栏列表 + 侧边栏内详情子页）存在三类问题：

1. 侧边栏脚本页混了三种职责（管理 + 运行观测 + 菜单触发），密度高、圆角等样式不统一；
2. 详情页挤在 ~300px 侧边栏里，源码编辑体验差；
3. 扩展图标点击行为只是「开侧边栏」，没有轻量入口查看当前页在跑什么脚本。

本次重设计：

- 侧边栏脚本页简化为**纯脚本管理器**；
- 详情页迁出侧边栏，成为**全屏新标签页**（Tab 式四分区）；
- 扩展图标改为打开 **popup 浮窗**（开侧边栏 + 脚本管理直达 + 当前页运行中脚本 + 菜单命令触发）；
- 三个面（侧边栏 / popup / 全屏页）统一设计语言（paper/signal 双声道 tokens）。

非目标：不改「文本为源」哲学（`.user.js` 原文唯一真源，头部 @字段 即配置）；不改 @connect 三分支校验语义；不引入代码编辑器库（CodeMirror 等，仍 textarea）；不做 TM 四名单完整复刻。

## 1. 侧边栏脚本页（纯管理器）

### 布局（自上而下）

```
┌──────────────────────────────────┐
│ SCRIPTS                    [+][↑]│  ← PageShell：eyebrow SCRIPTS / 标题「脚本」
│ 脚本                             │     右侧：新建(Plus)、导入(Upload) 两个
├──────────────────────────────────┤     btn--icon ghost 按钮，右对齐
│ ⚠ 引擎不可用警告（条件渲染）        │
│ ▢ 确认卡（@connect 批准，条件渲染） │
├──────────────────────────────────┤
│ 🔍 搜索名称 / 匹配规则…            │
├──────────────────────────────────┤
│ ┌──────────────────────────────┐ │
│ │ 脚本名称A              [⬤─]  │ │  ← 脚本卡片
│ │ *://example.com/*  user GM2  │ │
│ └──────────────────────────────┘ │
│ ...                              │
└──────────────────────────────────┘
```

- **移除**：RUNNING 区（运行观测归 popup）、MENU 命令区（触发归 popup）。
- **保留**：引擎警告（`scripts-notice`）；确认卡（`ScriptsConfirmCard`，位置在警告区——确认需要驻留面，popup 点外即关不适合承载）；导入警告行（搜索下、列表上）。
- **新建/导入**：从底部文字按钮改为页眉 `shell__actions` 槽的两个 `btn--icon` ghost 图标按钮（Plus / Upload），样式同会话页新会话按钮。
- **脚本卡片**（`.scripts-card`，取代 `.scripts-row`）：
  - 独立卡片，`--r-md` 圆角 + 1px 边框，hover 边框加深（`--line-strong`）；
  - 第一行：脚本名（600 权重）+ 右侧 switch；
  - 第二行：mono 小字匹配规则 + 徽标（来源 user/agent/TM、GM 数、错误数）；
  - 整卡可点 → `tabs.create` 开全屏详情页；点击 switch 阻止冒泡；
  - 禁用脚本整卡 55% 透明，switch 仍可操作。
- **switch 组件**（`.switch`）：40×22 轨道 + 滑块，选中态 `--signal` 底白色滑块；滑块过渡 150ms，`prefers-reduced-motion` 下关动画；`role="switch"` + `aria-checked`。

### 路由变更

- 删除 `ui.scriptId` / `openScript` 侧边栏二级页状态与 `ScriptDetailView` 挂载点。
- 新增共享 `openScriptTab(id: string)`：`browser.tabs.create({ url: browser.runtime.getURL('/script-detail.html?id=xxx') })`。放 `stores/scripts.ts` 导出。
- `ScriptsView.tsx` 退化为列表壳（无 scriptId 分支）。

## 2. 全屏脚本详情页（新标签页）

### 入口与载体

- 新 WXT 多页入口 `entrypoints/script-detail/`（`index.html` + `main.tsx`，复用 `styles.css`）；URL `script-detail.html?id=<scriptId>`。
- 打开：`browser.tabs.create`（不设 openerTabId）；一个脚本一个标签，可多开对比。
- 生命周期独立：挂载按 id `SCRIPTS_GET` 拉取；SW 休眠后重开自动重拉；脚本被删 → 「脚本不存在或已被删除」空态。
- 通信：复用 `sendScriptsRequest`（`runtime.sendMessage` 对扩展内所有页面可用），按需订阅 `SCRIPTS_ERROR` 广播。无 Port。

### 骨架

```
┌──────────────────────────────────────────────────────┐
│ SCRIPT · 未命名脚本                        [switch] [×]│ ← 顶栏（细，sticky）
├─────────┬────────────────────────────────────────────┤
│ ◈ 详情   │   （Tab 内容区，max-width 840px 居中）       │
│ ◈ 代码   │                                            │
│ ◈ 设置   │                                            │
│ ◈ 日志 3 │                                            │
│         │                                            │
│ ────────│                                            │
│ 删除     │                                            │
└─────────┴────────────────────────────────────────────┘
```

- **顶栏**：eyebrow `SCRIPT` + 脚本名（截断）+ 右侧启停 switch（同卡片组件）+ 关闭按钮（X → `window.close()`）。
- **左栏导航**（~160px，mono 大写）：`详情 / 代码 / 设置 / 日志 N`；选中项 signal 竖线 + 文字 signal 色；日志项带错误计数。左栏底部「删除」（danger 色，`window.confirm` 确认，成功后 `tabs.create` 无处可回 → 直接 `window.close()`）。
- **Tab 式切换**（四选一独占显示）。
- **响应式**：窗口 <720px 时左栏收窄为顶部横排 Tab。

### 四个 Tab

1. **详情**：元信息卡（name/version/author/description/matches/run-at/world，mono 键 + sans 值双声道行）+ grant 列表（支持 `--ink-2` / 不支持 `--warn` 分色）+ 脚本级操作按钮：重载当前页、导出 .user.js。
2. **代码**：源码编辑器**全宽破格**（不受 840px 限宽）；textarea + Tab 键两空格缩进；dirty 未保存指示；保存按钮（保存 → `SCRIPTS_UPDATE` patch `{text}` → 「已重新注册，刷新页面生效」状态行）。
3. **设置**：XHR 安全 = 「总是允许」域名管理——按当前脚本列出已授权 host（`local:gm:permissions`），逐条撤销（`Undo2` 图标按钮）；空态文案「无已授权域名——脚本请求跨域时将逐次询问」。**校验语义不动**，纯查看/撤销 UI。
4. **日志**：脚本错误环形缓冲展示（时间 · line · 消息，可展开 stack），复用调试台 `.well` 井视觉 + 清空按钮；订阅 `SCRIPTS_ERROR` / `SCRIPTS_ERROR_CLEARED` 广播实时更新。

- 脏状态离开保护：代码 Tab 有未保存修改时关闭页面 → 不弹 confirm 拦截，仅视觉提示「有未保存修改」（刻意轻量）。

### 新增消息类型（shared/messages.ts）

- `{ type: 'SCRIPTS_GET_PERMISSIONS'; id }` → `{ hosts: string[] }`（读 `local:gm:permissions[scriptId].cors` 的 keys）
- `{ type: 'SCRIPTS_REVOKE_PERMISSION'; id; host }` → 删除该条目；后台同时 `removeScriptPermissions` 复用。

后台路由挂 `background/scripts.ts` 编排层。

## 3. 扩展图标 popup

### manifest 与行为

- `action: {}` → `action: { default_popup: 'popup.html' }`；`background.ts` 的 `setPanelBehavior({openPanelOnActionClick})` 移除。
- 新 WXT 入口 `entrypoints/popup/`（`popup.html` + `main.tsx`，复用 `styles.css`），宽 360px。

### 布局（三区）

```
┌────────────────────────────┐
│ ◈ 打开侧边栏                │  ← PanelLeft 图标 + 文案，整行按钮
│ ◈ 脚本管理                  │  ← ScrollText 图标 + 文案，直达脚本 tab
├────────────────────────────┤
│ RUNNING · 2                │  ← 下区头：mono 计数 + dot 呼吸动画
│ ┌────────────────────────┐ │
│ │ 脚本A          [编辑✎] │ │  ← hover 显编辑按钮（SquarePen）
│ └────────────────────────┘ │
│ （空态：无脚本在此页运行）     │
└────────────────────────────┘
```

### 行为

- **打开侧边栏**：`tabs.query` 取当前 tabId → `browser.sidePanel.open({ tabId })`（Chrome ≥116）。
- **脚本管理**：直达侧边栏脚本列表 tab。两步：`sidePanel.open` + 导航通知——popup 发 `runtime.sendMessage({ type: 'UI_NAV', view: 'scripts' })`，侧边栏监听收到后 `useUi.setState({ view: 'scripts' })`；侧边栏未开时消息无人接收 → 侧边栏挂载时读 `storage.session` 的 `pendingView` 待航标记消费跳转（popup 写标记 + 发消息，双通道保证时序）。
- **脚本行点击 = 触发菜单命令**：单条直触；多条行内展开命令子列表再点选；零条行呈禁用观感（title「无菜单命令」）。**触发成功后浮窗关闭**（`window.close()`）。
- **编辑按钮**（hover 显形）：`tabs.create` 开全屏详情页；新标签获焦时 popup 自动关闭（浏览器默认）。
- **运行态数据**：短命页面冷读——打开时发 `SCRIPTS_GET_RUNTIME`（**新增消息**：SW 返回当前 tab 的 `ScriptsRuntimeEntry` + 相关脚本摘要 name/enabled），不订阅广播；菜单调用走既有 `SCRIPTS_MENU_INVOKE`。
- 确认卡不进 popup。

### 导航联动（UI_NAV）

- `shared/messages.ts` 新增 `{ type: 'UI_NAV'; view: Page }`（复用 `stores/ui.ts` 的 `Page` 类型 = `'chat' | 'scripts' | 'debug' | 'settings'`；messages.ts 原地内联同形字符串联合，避免扩展页面 import React store）。
- 现状勘误：`stores/ui.ts` 的字段名是 `page/setPage`（非 `view`）；`UI_NAV` 到达后调 `useUi.getState().setPage(msg.view)`。
- 侧边栏 `App.tsx` 挂 `runtime.onMessage` 监听：收到 `UI_NAV` 即 `setPage`；挂载时消费 `storage.session` key `ui:pendingView`（popup 写标记 + 发消息，双通道保证时序；读后即删）。

## 4. 样式规范

### 圆角统一

- 侧边栏卡片/输入框/按钮：`--r-md`；徽标/芯片：`--r-sm`；会话气泡维持现有不对称（刻意）；popup 卡片 `--r-md`；全屏页大卡片 `--r-lg`；switch 轨道全圆 999px。

### 新增 CSS 类（全走 styles.css，用 CSS 变量，禁硬编码色值）

- `.switch` / `.switch__thumb` / `.switch--on`
- `.scripts-card` / `__name` / `__match` / `__badges` / `--off`
- `.popup` / `__navbtn` / `__runhead` / `__runrow` / `__editbtn`
- `.detail` / `__topbar` / `__side` / `__navitem` / `__content` / `__tabcard` / `.detail-code__editor`
- 删除被取代的 `.scripts-row` 系列。

### 图标（lucide，零 emoji）

新建 `Plus`、导入 `Upload`、编辑 `SquarePen`、侧边栏 `PanelLeft`、脚本管理 `ScrollText`、关闭 `X`、撤销 `Undo2`、重载 `RotateCw`、导出 `Download`、保存 `Save`。

### 动效

switch 滑块 150ms + reduced-motion 关闭；popup 区块 rise 入场（复用既有 keyframes）；其余从简。

## 5. 组件与数据流

```
entrypoints/popup/          新增（popup.html + main.tsx + PopupApp.tsx）
entrypoints/script-detail/  新增（index.html + main.tsx + DetailApp.tsx）
components/scripts/
  ScriptsView.tsx           退化为列表壳
  ScriptsListView.tsx       重构：卡片 + switch + 页眉 icon 按钮；删 RUNNING/MENU 区
  ScriptDetailView.tsx      删除（逻辑迁至全屏页组件）
  ScriptsConfirmCard.tsx    保留不动
components/detail/          新增（全屏详情页组件，可拆 DetailTopbar/DetailNav/四 Tab 子组件）
stores/scripts.ts           增 openScriptTab；增 permissions 相关请求封装
stores/ui.ts                删 scriptId/openScript；UI_NAV 到达调 setPage
background/scripts.ts       增 SCRIPTS_GET_PERMISSIONS / SCRIPTS_REVOKE_PERMISSION / SCRIPTS_GET_RUNTIME handler
shared/messages.ts          增 UI_NAV / SCRIPTS_GET_PERMISSIONS / SCRIPTS_REVOKE_PERMISSION / SCRIPTS_GET_RUNTIME
```

数据流：三面统一 `sendScriptsRequest`（`runtime.sendMessage` 请求-响应）；运行态/错误/确认走既有 SW 广播（侧边栏订阅、全屏页按需订阅 ERROR、popup 冷读不订阅）。

## 6. 错误处理

- 全屏页脚本不存在 → 空态 + 关闭按钮。
- SW 休眠：sendMessage 自动唤醒；失败 catch → 错误状态行（不静默）。
- popup 打开时无活动 tab（极端）→ RUN 区显示空态文案。
- `sidePanel.open` 失败（如 Chrome <116）→ catch 后按钮降级为禁用态 + title 提示。
- 撤销不存在的授权（竞态）→ 幂等成功。
- 删除脚本时另一全屏标签开着同一脚本 → 该标签下次操作时报「脚本不存在」，不主动失效（YAGNI）。

## 7. 测试

- **单测**（vitest + jsdom）：
  - `shared/messages.ts` 类型完备性（现有模式延续）；
  - `stores/scripts.ts` 的 `openScriptTab`（mock `browser.tabs.create`）、permissions 请求封装；
  - popup 组件：脚本行点击 → 单命令直触 / 多命令展开 / 零命令禁用观感；触发后 `window.close` 被调用（mock）；
  - 全屏页组件：四 Tab 切换渲染、XHR 安全空态/列表/撤销、日志展开 stack、脏状态提示；
  - 侧边栏列表：卡片渲染（名称/matches/徽标/switch 态）、switch 点击冒泡阻断、新建/导入 icon 按钮存在。
- **手动验收清单**：popup 三区行为；侧边栏卡片启停；全屏页编辑保存重载生效；XHR 撤销后再请求重新弹确认卡；UI_NAV 直达（侧边栏开/未开两种时序）。

## 8. 已确认决策记录

| 问题 | 决策 |
|---|---|
| 脚本设置区语义 | 用户级运行配置：XHR 安全先行 |
| XHR 安全实现 | A：管理「总是允许」名单（查看+撤销），校验语义不动 |
| popup 菜单命令点击 | A：单条直触/多条二级选择/零条禁用观感 |
| 触发后浮窗 | B：自动关闭 |
| 详情页载体 | B：`tabs.create` 扩展自有 HTML 页 |
| 侧边栏 RUNNING/MENU | 全移除，侧边栏=纯管理器 |
| 确认卡驻留 | 侧边栏脚本页顶部（popup 不承载） |
| 详情页布局 | C：Tab 切换式四分区 |
| Tab 划分 | 详情=元信息+操作；代码=编辑器；设置=XHR 安全；日志=错误 |
| popup 视觉 | A：paper/signal 双声道 tokens |
| 全屏页通信 | A：复用 sendScriptsRequest |
| popup 直达脚本 tab | A：UI_NAV 消息 + pendingView storage.session 兜底 |
| 设计路线 | 方案二：卡片改造 + 全屏页专属排版（840px 内容 + 编辑器破格） |
