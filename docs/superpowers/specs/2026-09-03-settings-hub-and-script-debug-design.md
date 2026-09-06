# 设置页改版：二级菜单枢纽 + 脚本运行时调试台 设计

日期：2026-09-03
状态：已与用户逐节确认

## 背景与目标

当前侧边栏 railnav 四项（会话 / 脚本池 / 调试台 / 设置），调试台是纯平铺 25 工具列表，GM API 无调试入口。本次改版：

1. railnav 减为 3 项（会话 / 脚本池 / 设置），调试台入口挪进设置页。
2. 设置页改为列表页 → 二级页双页路由（与脚本池列表/详情模式同构）。
3. 工具调试台加二级标题分组 + 修正 12 个错标 tag。
4. 新增脚本运行时调试台：GM API 列表、grant/@connect 白名单视图、经真实桥链路直调。

用户已确认的取舍：二级路由状态不跨页记忆（每次进设置从列表开始）；脚本运行时调试台第一版为最小版（白名单 + API 表 + 直调），值存储/菜单/错误缓冲检视留在脚本页现有 UI。

## 1. 导航结构与文件布局

- `stores/ui.ts`：`Page` 类型删 `'debug'`；`entrypoints/sidepanel/App.tsx` NAV 数组删调试台项，渲染分支同步删除。
- 设置页二级路由放 `SettingsView` 内部 `useState`（不进 ui store，不持久化）。二级页用 `PageShell`，eyebrow `SETTING`，页眉 actions 放返回按钮（lucide `ArrowLeft`）。

```text
components/settings/
  SettingsView.tsx      壳：列表页/二级页路由（useState + 返回按钮）
  SettingsHome.tsx      列表页：三个入口卡片（模型设置 / 工具调试台 / 脚本运行时调试台）
  ModelSettings.tsx     模型设置 = 现 SettingsView 表单内容原样平移

components/debug/
  ToolBenchPage.tsx     工具调试台 = 现 DebugView 改造（分组 + 新 tag）
  ResultPanel.tsx       结果面板提取（工具台与 GM 台共用 OK/ERR + ms + well 视觉）

components/scriptdebug/
  ScriptDebugPage.tsx   脚本运行时调试台（全新）
```

删除旧 `components/debug/DebugView.tsx`（内容已迁走）。

## 2. 工具调试台：分组 + tag 修正

### tag 分类

现状 bug：`CS_TOOLS` 集合二分（在集合内 = PAGE，否则 TABS），12 个不走 content script 的工具全部误标 TABS：take_screenshot、evaluate_script、http_request、list_console_messages、list_network_requests、get_network_request、脚本池六工具。改为显式映射 + 缺省兜底：

```ts
// tag 分类：能力域四分（PAGE=碰当前页内容 / TABS=标签页管理与导航 / NET=网络与观测 / SCRIPTS=脚本池管理）
const TOOL_TAGS: Record<string, 'PAGE' | 'TABS' | 'NET' | 'SCRIPTS'> = {
  // PAGE(10)：8 个 CS 工具 + 2 个 SW 直操作当前页
  take_snapshot: 'PAGE', click: 'PAGE', fill: 'PAGE', fill_form: 'PAGE',
  hover: 'PAGE', scroll: 'PAGE', press_key: 'PAGE', wait_for: 'PAGE',
  take_screenshot: 'PAGE', evaluate_script: 'PAGE',
  // TABS(5)
  navigate_page: 'TABS', list_pages: 'TABS', new_page: 'TABS', close_page: 'TABS', select_page: 'TABS',
  // NET(4)
  http_request: 'NET', list_console_messages: 'NET',
  list_network_requests: 'NET', get_network_request: 'NET',
  // SCRIPTS(6)
  list_scripts: 'SCRIPTS', get_script: 'SCRIPTS', create_script: 'SCRIPTS',
  update_script: 'SCRIPTS', delete_script: 'SCRIPTS', toggle_script: 'SCRIPTS',
};
// 缺省兜底 'PAGE'：未来新工具忘登记时按「碰当前页」保守归类
```

chip 样式：新增 `.chip--net`、`.chip--script` 色档（styles.css 补 CSS 变量）；现有 `.chip--cs` 更名 `.chip--page`、`.chip--api` 更名 `.chip--tabs`（语义化，四档命名与 tag 值一致）。

### 分组渲染

分组与 tag 同源：`TOOL_TAGS` 按组序 `[PAGE, TABS, NET, SCRIPTS]` 反转分组，每组渲染 mono 二级标题（组名 + tag 名 + 计数，如 `── 页面操作 PAGE · 10 ──`）+ 组说明 hint，组间分隔线；组内按 `TOOL_SCHEMAS` 原顺序排列。

```ts
const GROUPS = [
  { key: 'PAGE', label: '页面操作', hint: 'content script 或 SW 直操作当前页' },
  { key: 'TABS', label: '标签页与导航', hint: 'tabs API / 导航控制' },
  { key: 'NET', label: '网络与观测', hint: '后台 fetch / console / 网络元数据' },
  { key: 'SCRIPTS', label: '脚本池管理', hint: 'userScripts CRUD 与启停' },
] as const;
```

工具台现有行为全部保留：skeleton 生成、JSON 参数编辑、执行、OK/ERR 结果回显、目标页 host 仪表条。

## 3. 脚本运行时调试台

三个功能块自上而下（mono 二级标题，同工具台风格）：

### ① 白名单视图

选中脚本后展示：

- `@grant` 解析结果：supported（`classifyGrants` 正常列表）/ unsupported（警告徽标，注入期即被拒装）。
- `@connect` 列表 + 已「始终允许」主机（`background/gm-permissions` 的 always-allow 库）。
- `matchConnect` 三分支语义标注：self/子域放行；列了不中 → DENY；未列 → 查 always 库，否则弹确认。

### ② GM API 列表

直接读 `GM_API_REGISTRY`（shared/gm-apis.ts）渲染 14 行：API 名 + impl chip（`SNAPSHOT`/`LOCAL`/`BRIDGE`）+ Promise 标记。可展开行填 JSON params 直调。

### ③ 直调执行链路

关键事实：snapshot 类 API 的值快照在注入时直嵌 wrapper，不走桥；`GM_addStyle`/`GM_log` 是页面内 local 完成。直调按三类呈现：

| 类别 | API | 直调行为 |
|---|---|---|
| bridge 7 个 | setValue / deleteValue / xmlhttpRequest / registerMenu / setClipboard / notification / openInTab | 完整真实链路：token 校验 → SW `grantAllowed` 白名单 → `handleGmCall` → `@connect` 确认流（XmlHttpRequest 会真实弹批准卡） |
| SW 有分支 2 个 | getValue / listValues | 经桥调 SW 的 `GetValue`/`ListValues` 分支，返回 storage 实时值（UI 标注「非页面快照」） |
| 页面内 5 个 | info / getResourceText / addStyle / log / addValueChangeListener | 不可远程直调，行内置灰 + 提示「页面内 API」 |

注：`GM_getValue`/`GM_listValues` 在注册表里 impl 是 `snapshot`，但 SW 侧 `handleGmCall` 有 `GetValue`/`ListValues` 分支，归「SW 有分支」类（UI 标注「非页面快照」的原因）；`GM_info`/`GM_getResourceText` 虽同为 snapshot impl 但无 SW 分支，与 local impl 的 `GM_addStyle`/`GM_log`/`GM_addValueChangeListener` 同归「页面内」类。

直调时 `api` 参数用点形式短名（`SetValue`/`XmlHttpRequest`…），与 wrapper 实际发出的形式一致——`handleGmCall` 的 switch 分支与 `API_TO_GRANT` 白名单映射都按短名匹配，发 `GM_` 全名会落到「未知 GM API」。

### 直调协议

新增消息（`shared/messages.ts`）：

- `GM_DEBUG_CALL`（面板→SW）：`{ scriptId, api, params, tabId? }`。tabId 缺省取当前活动标签页。SW 侧 `background/gm-api.ts` 新 handler：先取目标 tab URL，`bridgeTokensForUrl(url)` 查该脚本 token——查无 = 脚本未注入此页，直接返回错误（不进 window）。
- `GM_DEBUG_INVOKE`（SW→CS，`tabs.sendMessage`，进 `BgToCsRequestMap`）：`{ scriptId, api, params, token, reqId }`。`entrypoints/content.ts` 加分支调 `gm-bridge-host` 新导出 `debugCall()`。

`gm-bridge-host.debugCall()`：在 window 上 dispatch `gmreq:<scriptId>`（带 token + debug 命名空间 reqId，从 `1_000_000_000` 起防与 wrapper 的 reqId 撞）→ 宿主已有的 gmreq 监听器做真实 token 校验后转发 `GM_API_CALL` → `debugCall` 监听 `gmres:<scriptId>` 按 reqId 配对回传，10s 超时。覆盖环节：token 防伪、grant 白名单、`handleGmCall`、`@connect` 确认流、gmres 回环——除 wrapper 函数体本身外全部真实。

### 页面布局

顶部：脚本下拉选择器（已注册脚本列表）+ 目标页 host 仪表条（复用工具台模式）。结果面板复用 `ResultPanel`。

## 4. 测试

1. `tests/debug/tool-tags.test.ts`：TOOL_TAGS 完备性（TOOL_SCHEMAS 每个名字都有 tag）+ 四类计数 10/5/4/6——防未来加工具漏登记。TOOL_TAGS 与 GROUPS 需从组件提取到可导入的纯模块（如 `components/debug/tool-tags.ts`）以便测试。
2. 扩展 `tests/content/gm-bridge-host.test.ts`：debugCall 的 gmreq 派发 / gmres 配对 / 超时 / token 不符拒绝。
3. `tests/background/gm-debug.test.ts`：无 token 报错；bridge 类 API 透传 `handleGmCall`（mock）。
4. 设置页壳路由 + 列表页渲染 3 入口（@testing-library/react，同 markdown 测试模式）。

## 5. 文件清单

| 动作 | 文件 |
|---|---|
| 改 | `stores/ui.ts`（Page 删 'debug'）、`entrypoints/sidepanel/App.tsx`（NAV 3 项） |
| 改写 | `components/settings/SettingsView.tsx` → 壳；新增 `SettingsHome.tsx`、`ModelSettings.tsx` |
| 迁移 | `DebugView.tsx` → `components/debug/ToolBenchPage.tsx`（分组 + 新 tag），提取 `ResultPanel.tsx`，删原文件 |
| 新增 | `components/scriptdebug/ScriptDebugPage.tsx` |
| 协议 | `shared/messages.ts`、`background/gm-api.ts`、`content/gm-bridge-host.ts`、`entrypoints/content.ts` |
| 样式 | `entrypoints/sidepanel/styles.css`：chip 四档改名/新增、分组标题类、设置列表入口卡 |
| 文档 | `CLAUDE.md` 项目结构与导航描述同步（调试台入口变更） |

## 6. 已知边界

- GM 直调的 SW 内存态（菜单表、通知映射）随 SW 重启丢失，直调 RegisterMenu 成功后可在脚本页菜单入口看到，属预期行为。
- 「页面内 5 API」置灰项不可直调是第一版取舍；如后续需要，可经 `evaluate_script` 在页面内派发 CustomEvent 实现远控（不在本次范围）。
- 目标页 URL 受限（chrome:// 等）时 `GM_DEBUG_CALL` 因查不到 token 直接报错，无需额外预检分支。
