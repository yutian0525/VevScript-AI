# 脚本详情页优化设计（header 重构 + 详情 Tab 中文化 + 字体层级）

日期：2026-09-04
状态：已确认（用户 ok）
分支：feat/script-ui-opt

## 0. 背景与目标

当前全屏脚本详情页（`script-detail.html` → `components/detail/`）存在三个问题：

1. Header 信息密度低：`SCRIPT` eyebrow + 单行标题 + 启停 switch + 关闭 X，作者/版本等关键信息藏在详情 Tab 的 mono 英文键值行里。
2. 详情 Tab 是英文 mono 键值卡片，对人不友好；「重载当前页」「导出 .user.js」按钮使用频率低且重载与详情页语义冲突（详情页自身就是 active tab）。
3. 整页字体偏小（12.5px 正文），主副标题/正文层级不明显，英文装饰过多。

目标：header 变成「头像 + 标题/副标题 + 外链 icon」的信息头；详情 Tab 去卡片框、字段中文化、操作收敛为「启停 + 删除」；整体字体层级拉大、少用英文装饰。

## 1. 澄清结论（用户已确认）

| 问题 | 结论 |
|---|---|
| 删除按钮位置 | 详情 Tab 内（danger 按钮）；左栏底部删除移除 |
| header 右侧启停 switch / 关闭 X | 去掉；页面内不提供关闭钮（独立标签页用浏览器自带关闭） |
| 启用/禁用操作位置 | 详情 Tab 内（按钮形式） |
| homepageURL/supportURL 外链 | 新增解析 `@homepage`/`@homepageURL`/`@supportURL`/`@icon`/`@downloadURL`/`@updateURL` 键存入 meta，header 渲染外链 icon |
| @icon 头像 | @icon 优先，加载失败回退名称首字 |
| Q1 操作区排布 | A：信息字段之后页面底部横排「启用/禁用（signal 主操作）+ 删除脚本（danger ghost）」 |
| Q2 首字头像底色 | A：`--signal-wash` 底 + `--signal-ink` 字 |

## 2. 数据层变更

### 2.1 `shared/types.ts` — `UserScriptMeta` 新增展示性外链字段

```ts
export interface UserScriptMeta {
  namespace?: string;
  version?: string;
  author?: string;
  description?: string;
  /** @homepage / @homepageURL（主页，TM 兼容双键名） */
  homepage?: string;
  /** @supportURL（反馈/支持页） */
  supportURL?: string;
  /** @icon（图标图片 URL，详情页头像） */
  iconURL?: string;
  /** @downloadURL（安装源） */
  downloadURL?: string;
  /** @updateURL（更新源） */
  updateURL?: string;
  grants?: string[];
  connects?: string[];
  requires?: string[];
  resources?: Record<string, string>;
  noframes?: boolean;
}
```

语义：纯展示性元数据，不参与注入（与 namespace/version 同级）。不校验 URL 合法性、不产生解析警告——值存在即渲染对应入口，非法 URL 由浏览器标签页自己报错（与 TM 行为一致）。

### 2.2 `shared/userscript-meta.ts` — 解析与反拼

- `parseUserScript` switch 新增：
  - `case 'homepage': case 'homepageURL': if (value) meta.homepage = value; break;`（两键名写同一字段，后写覆盖）
  - `case 'supportURL': if (value) meta.supportURL = value; break;`
  - `case 'icon': case 'iconURL': if (value) meta.iconURL = value; break;`（`@icon` 为主，`@iconURL` 为顺带兼容）
  - `case 'downloadURL': if (value) meta.downloadURL = value; break;`
  - `case 'updateURL': if (value) meta.updateURL = value; break;`
- `stringifyUserScript` 反拼顺序：namespace → homepage（有则 `// @homepage`）→ version → author → description → supportURL → iconURL → downloadURL → updateURL → matches → run-at → world → grants → connects → requires → resources → noframes。键名输出规范形式（`@homepage`、`@supportURL`、`@iconURL`、`@downloadURL`、`@updateURL`）。

## 3. Header 重构（`DetailApp.tsx` + 样式）

```
┌──────────────────────────────────────────────┐
│ [头像40px]  脚本名称（18px/600，主标题）        [⌂][?][↓] │
│             作者 someone · v1.2.0（12px ink-2）          │
└──────────────────────────────────────────────┘
```

结构：

- 移除：`SCRIPT` eyebrow、启停 switch、关闭 X 按钮、`detail__title` 单行样式。
- 新增左侧头像：40×40 圆角（`--r-md`）。有 `meta.iconURL` 时渲染 `<img>`（`object-fit: cover`），`onError` 回退首字块（组件内 `useState` 记录加载失败，切换脚本时重置）；无 iconURL 直接首字块。首字取 `script.name.trim()[0]`（空名兜底「未」），样式 `--signal-wash` 底 + `--signal-ink` 字、18px/600。
- 新增标题块（头像右侧、上下排布）：
  - 主标题：脚本名，18px/600，`--ink`，超长省略（保留现有 ellipsis 策略）。
  - 副标题：`作者 {author} · v{version}`，12px，`--ink-2`；author/version 都无则显示「未标注版本」（保持有内容）；仅其一有则只显示其一，分隔符 `·` 不悬空。
- 新增右侧外链 icon 组（`meta` 对应字段存在才渲染，横排 gap 4px）：
  - `homepage` → lucide `House`，title「脚本主页」
  - `supportURL` → lucide `LifeBuoy`，title「反馈与支持」
  - `downloadURL` → lucide `Download`，title「安装源」
  - `updateURL` → lucide `RefreshCw`，title「更新源」
  - 每个 icon 为 ghost 圆角小按钮（复用 `.btn--icon` 形态），点击 `browser.tabs.create({ url })` 新标签打开；`title` 属性含完整 URL 供悬停查看。
- header 布局：`display:flex; align-items:center; gap:12px`，icon 组 `margin-left:auto`。
- 删除确认文案中的名称不变；`window.close()` 在删除成功后仍保留（详情 Tab 用）。

## 4. 详情 Tab 重构（`DetailInfoTab.tsx`）

### 4.1 去卡片框

- `DetailInfoTab` / `DetailSettingsTab` / `DetailLogsTab` 不再包 `.detail__tabcard`（边框+白底卡片），信息直接铺在 `detail__content` 上。各 Tab 自行用 `display:grid; gap` 组织。代码 Tab（`detail-code` 全宽破格）不动。
- `.detail__tabcard` 样式类保留给剩余引用或直接删除（实现时以无引用即删为准）。

### 4.2 字段中文化 + tooltip

标签改中文（sans、`--ink-3` 12px），`title` 属性保留原英文键名供悬停：

| 原键 | 中文标签 | 值形态 |
|---|---|---|
| version | 版本 | sans |
| author | 作者 | sans |
| description | 描述 | sans |
| match | 匹配规则 | mono（机器值） |
| run-at · world | 注入时机 · 沙箱 | mono（`document_idle · USER_SCRIPT`） |
| grant | 权限申请 | mono 徽标（保留 Check/X 分色） |

双声道约定保留：标签用 sans 人话，机器形态值（match/grant/run-at/world/URL）保持 mono。

### 4.3 URL 可点击

- 值为 URL 的字段（namespace、homepage、supportURL、downloadURL、updateURL）渲染为链接：`--signal-ink` 色 + hover 下划线，`browser.tabs.create` 新标签打开（与 header 外链一致，不用 `<a target=_blank>` 以避免扩展页面对 `_blank` 的行为差异）。显示文本 = URL 本身，超长省略。
- namespace 无对应 header icon，仅在详情 Tab 字段行展示（中文标签「命名空间」）。

### 4.4 操作区（页面底部）

信息字段之后横排两个按钮：

- `启用脚本` / `禁用脚本`：signal 主按钮，点击调 `SCRIPTS_SET_ENABLED`，成功后按钮文案切换 + 顶部 message 提示「已启用，刷新页面生效」/「已禁用，刷新页面生效」（沿用现文案）。启用态按钮显示「禁用脚本」还是「启用脚本」——显示**反向操作**（当前启用 → 显示「禁用脚本」），与列表页 switch 语义一致。
- `删除脚本`：danger ghost 按钮，`window.confirm` 确认后调 `SCRIPTS_DELETE`，成功 `window.close()`。

移除：「重载当前页」按钮及 `findReloadTarget` 整个函数、「导出 .user.js」按钮及 `exportFile`。

启停逻辑从 `DetailApp` 顶栏迁入 `DetailInfoTab`（`toggleEnabled` 回调传参或组件内直调 `sendScriptsRequest`，实现时取直调 + `onChanged` 回调通知 DetailApp 同步 script state，保证 header 副标题版本/作者同步刷新）。

## 5. 设置 / 日志 Tab 跟随

- 设置 Tab：去卡片框；「XHR 安全 · 总是允许名单」标题去 mono 英文风，改 sans「跨域授权名单」+ 原 hint 保留。
- 日志 Tab：去卡片框，`.well` 井与行结构不动。

## 6. 字体层级（styles.css）

| 元素 | 现状 | 目标 |
|---|---|---|
| header 主标题 | 15px/600 单行 | 18px/600 |
| header 副标题 | 无 | 12px `--ink-2` |
| 详情 Tab 字段值 | 12.5px | 13px `--ink` |
| 字段标签 | mono 11px | sans 12px `--ink-3` |
| 左栏导航 | 13px | 13px（不变） |
| 正文行高 | 1.5 | 1.6 |

新增/调整类：`.detail__topbar`（flex 重排）、`.detail__avatar`（40px 头像）、`.detail__avatar--fallback`（首字块）、`.detail__headtext`（标题块上下排布）、`.detail__h1`（18px）、`.detail__subtitle`（12px ink-2）、`.detail__links`（icon 组）、`.detail__inforow` 列宽 110px→96px（中文标签更短）、`.detail__links` 内按钮 hover 洗底。动效遵守 `prefers-reduced-motion`（仅 hover 背景过渡，沿用 `--t-fast`）。

## 7. 测试影响

- `tests/shared/userscript-meta.test.ts`：新增外链键解析用例（六键全解析、`@homepageURL` 别名、反拼回滚）；既有 fixture 不破坏。
- `tests/detail/detail-app.test.tsx` 改写：
  - 删「顶栏 switch 启停」用例 → 改「详情 Tab 启停按钮调 SCRIPTS_SET_ENABLED 且文案随状态切换」。
  - 删「重载当前页」两个用例（功能移除）。
  - 「加载后默认展示详情 Tab」用例：改断言（无 switch、有启停/删除按钮）。
  - 新增：header 外链 icon 有则渲染/无则不渲染 + 点击调 tabs.create；头像首字回退（无 iconURL 显示首字，有 iconURL 渲染 img）。
  - 删除脚本用例：confirm mock + 调 SCRIPTS_DELETE。
- 回归：`npm run compile` + `npm run test` 全绿。

## 8. 已知取舍

- `@icon` 远程图不做过期缓存/代理，反爬站点头像可能裂图——`onError` 回退首字兜底，不重试。
- `@homepageURL` 与 `@homepage` 双键名都写时后解析者覆盖，不告警（TM 同行为）。
- URL 不做合法性校验，非法值进 `browser.tabs.create` 由浏览器报错——与「纯展示性元数据不参与注入」一致。
- 导出 .user.js 移除后，用户拿原文走代码 Tab 复制（源码编辑器全文可选中）。
- `detail__title` 旧类名废弃，改 `detail__h1`；`detail__tabcard` 若无引用即删。
