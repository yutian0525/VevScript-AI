# 脚本更新功能设计（URL 导入 + 启动检查更新 + 手动更新）

日期：2026-09-04　分支：`feat/update-scripts`　worktree：`D:\workspace-mou8\abe-dev`

## 0. 目标与范围

三个用户故事：

1. **URL 导入脚本**：侧边栏脚本管理器粘贴 .user.js 直链 → 下载安装。
2. **自动检查更新**：每次浏览器启动（`runtime.onStartup`）+ 扩展安装/更新（`runtime.onInstalled`）时，对有更新源的脚本批量查 `@version`，有更新在列表页标徽标提醒；用户确认后才更新。
3. **详情页手动检查更新**：详情 Tab 内「检查更新」按钮，行内显示结果，确认后更新。

不做（YAGNI）：页面 URL 归一化（GreasyFork 详情页 → 直链解析）、周期性 `alarms` 检查、系统通知、自动静默更新、更新 diff/合并、AI 工具暴露更新操作。

## 1. 数据模型与后台模块

### 1.1 新模块 `background/scripts-update.ts`

`background/scripts.ts` 已 439 行，更新逻辑独立成模块。导出：三个编排函数（§2 消息 handler 用）+ 启动检查入口 + storage 工具。

### 1.2 更新状态存储（独立于 UserScript）

现有架构「`text` 为唯一真源，其余字段是解析投影」（`buildFromText` 整体重解析）。更新状态是运行时数据不是投影，塞进 `UserScript` 会被重建流程冲掉或需要特判，故独立单键：

```ts
// shared/types.ts
export interface ScriptUpdateState {
  remoteVersion: string;      // 远端 @version 原文
  checkedAt: number;
  status: 'available' | 'up-to-date' | 'error';
  message?: string;           // status='error' 时的原因（HTTP 404 / 超时 / 解析失败…）
}
type ScriptUpdateMap = Record<string /* scriptId */, ScriptUpdateState>;
```

存储键：`local:scripts:update-state`（`chrome.storage.local`，单键整写，沿用 storage/scripts.ts 单键哲学）。

**不变量**：

- 任何脚本 text 更新（`handleUpdate` 文本路径）→ 删该脚本条目（本地改过，旧检查结果过期，下轮启动重查）
- 脚本删除（`handleDelete`）→ 删该脚本条目
- 应用更新成功 → 删该脚本条目（版本已对齐）

### 1.3 检查/下载源（TM 语义回退链）

- 检查用 `meta.updateURL ?? meta.downloadURL`；下载用 `meta.downloadURL ?? meta.updateURL`
- 两者皆无 → 不参与自动检查（文件导入/手写的脚本无徽标，详情页按钮置灰）
- fetch 用 host 权限 `<all_urls>`（manifest 已有，无 CORS 问题）；超时模式复用 gm-resources.ts 的 AbortController 惯例——检查 15s / 下载 30s

### 1.4 URL 导入保住「text 为唯一真源」

meta 是解析投影，不能直接改 `meta.updateURL`。fetch 拿到文本后，若头部没有 `@updateURL`/`@downloadURL`，把导入 URL 以 `// @updateURL    <url>` 一行**插进 `==UserScript==` 块内**，再走现有 `parseUserScript` → `handleImport` 管线。无有效头的文本不注入（无头脚本本来就不解析 meta）。

**应用更新同理**：远端新文本可能不含这两个键，覆盖前把本地已有的 `updateURL`/`downloadURL` 值重新注入新文本头部（保留安装源，TM 同此行为）。

### 1.5 版本比较 `compareVersions(a, b)`

纯函数（放 `shared/version.ts`）：按 `.` 分段逐段比，数字段数值比较、非数字段字符串比较、段数不齐短补零。仅「远端 > 本地」才算有更新（降级不提示）。

- 任一方版本缺失 → 视为 `0`；两边都缺 → 相等 → up-to-date
- `1.2.10 > 1.2.9`（数值）；`1.2a vs 1.2b`（字符串段）

### 1.6 启动检查流程

```
browser.runtime.onStartup / onInstalled
  → 批量检查：listScripts() 过滤有更新源的脚本，并发上限 4
  → 每脚本独立 try/catch：fetch(updateURL) → parseUserScript 取 @version
    → compareVersions(remote, local) → 写 local:scripts:update-state
  → 广播 { type: 'SCRIPTS_UPDATES', updates } 全量 map（fire-and-forget，无接收方吞掉）
```

fire-and-forget：不 await、不阻塞 SW 空闲回收。检查中途 SW 被杀 → storage 只留已完成部分，下轮启动重查，单键整写无损坏风险。扩展启动时侧边栏大概率未开 → 结果落 storage，侧边栏打开时读出渲染。

## 2. 消息协议（shared/messages.ts）

`ScriptsRequest` 联合类型追加 3 个成员：

```ts
| { type: 'SCRIPTS_IMPORT_URL'; url: string }   // → { script, warnings } 同 SCRIPTS_IMPORT
| { type: 'SCRIPTS_CHECK_UPDATE'; id: string }  // → ScriptUpdateState
| { type: 'SCRIPTS_APPLY_UPDATE'; id: string }  // → { script } 更新后的脚本
```

下行广播新增：`{ type: 'SCRIPTS_UPDATES'; updates: ScriptUpdateMap }`（全量替换，map 小不做增量）。

**校验规则**：

- `IMPORT_URL`：仅接受 `https?:` 协议（防 `file:`/`chrome-extension:`）；非 .user.js 后缀照收（有的直链无后缀，交给解析器判断）；脚本头无更新源时注入导入 URL（§1.4）
- `CHECK_UPDATE`：无更新源 → 直接返回 `{ status: 'error', message: '无更新源（@updateURL/@downloadURL）' }`，不落 storage
- `APPLY_UPDATE`：无源报错；下载文本超 `MAX_TEXT_LENGTH` 报错；解析后 code 为空报错（拒绝空码覆盖）

**store**（stores/scripts.ts）：加 `updates: ScriptUpdateMap` 状态；`ScriptsView` 挂载时读 storage 一次 + 监听 `SCRIPTS_UPDATES` 广播。

## 3. UI

### 3.1 列表页 ScriptsListView

1. **URL 导入入口**：工具栏 actions 第三个 icon 按钮（lucide `Link`，与 Plus/Upload 并列）→ 点击展开行内输入条（工具栏下方，与 `importWarnings` 同位置同风格）：粘贴 URL + 回车/导入按钮提交，提交中禁用，失败写 `importWarnings` 行，成功 `refresh()` + `openScriptTab`（与文件导入一致）
2. **更新徽标**：`updates[s.id]?.status === 'available'` → 卡片 meta 行加 `scripts-badge--signal`：`↑ v1.2.3`（mono 版本号），title「有可用更新，点开详情处理」
3. **确认更新**：徽标出现时该卡片底部展开操作条（`scripts-card__updatebar`，唯一新增样式类）：`更新到 v1.2.3` 主按钮 + `忽略` 幽灵按钮。更新 → `window.confirm('将下载新版本并覆盖本地修改（含代码与设置），确认更新「XX」到 v1.2.3？')` → `APPLY_UPDATE` → 成功 `refresh()`（state 已清，徽标消失）。忽略 → 本次会话隐藏操作条（store 记 `dismissed: Set<scriptId>`，不持久化——下轮启动重查还会再提醒）
4. **error 状态不进列表**：检查失败列表页安静（启动检查失败多为暂时网络问题，不制造噪音），详情页可见

### 3.2 详情页 DetailInfoTab

- 「检查更新」按钮进底部操作区（启用/禁用、删除同行）；无更新源 → 置灰（title 说明）；有源 → 点击转 busy
- 结果以一行 `detail__inforow` 插在「版本」行下：`更新检查 · <时间>` + 结果文案（已是最新 vX.Y / 有新版本 v1.2.3 / 错误信息），行内直接给「更新」按钮（confirm → APPLY_UPDATE → `onChanged` 刷 header 副标题版本号）
- 上次启动检查已有结果 → 进详情页直接显示该行，不用再点

## 4. 错误处理

- **fetch 层**：非 2xx → `HTTP {status}`；网络错/超时 → error。批量检查每脚本独立 try/catch，失败静默落 storage（`status: 'error'`），列表页不弹全局提示
- **下载层**（APPLY_UPDATE）：超长/空码拒绝，错误**会**反馈到 UI（confirm 后的失败必须可见）
- **解析层**：远端 `@version` 缺失 → 视为 `0`（低于一切本地版本，不误报）；本地也缺 → 双 `0` 相等 → up-to-date
- **并发**：`APPLY_UPDATE` 与编辑器保存冲突 → last-write-wins（`handleUpdate` 现有语义），不做锁；confirm 文案已声明覆盖风险

## 5. 测试策略（vitest，沿用现有分层；UI 组件不测——无先例且逻辑都在 store/handler 层）

- **纯函数**（`tests/shared/version.test.ts`）：compareVersions 进位/补零/字符串段/降级不提示；头部注入函数：无源注入、已有两键不覆盖、无头不注入
- **编排层**（`tests/background/scripts-update.test.ts`，mock `fakeBrowser` + fetch）：
  - 检查流程四 status 落 storage 正确（up-to-date / available / HTTP 错误 / 版本缺失）
  - `IMPORT_URL`：协议校验拒绝 / 成功路径（fetch→注入→handleImport）/ 更新源保留
  - `APPLY_UPDATE`：无源报错 / 超长拒绝 / 空码拒绝 / 成功清 update-state
  - 不变量：handleUpdate 文本路径 / handleDelete 清 update-state

## 6. 涉及文件清单

| 动作 | 文件 |
|---|---|
| 新增 | `background/scripts-update.ts`、`shared/version.ts`、`tests/shared/version.test.ts`、`tests/background/scripts-update.test.ts` |
| 修改 | `shared/types.ts`（ScriptUpdateState）、`shared/messages.ts`（3 请求 + 1 广播）、`background/scripts.ts`（接线 3 handler + onStartup/onInstalled + 不变量清理）、`stores/scripts.ts`（updates 状态 + dismissed）、`components/scripts/ScriptsListView.tsx`（导入入口 + 徽标 + 操作条）、`components/detail/DetailInfoTab.tsx`（检查更新行）、`entrypoints/sidepanel/styles.css`（scripts-card__updatebar） |
