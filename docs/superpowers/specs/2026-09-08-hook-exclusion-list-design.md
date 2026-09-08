# MAIN world hook 敏感站排除名单 设计

- 日期：2026-09-08
- 状态：已确认（对话中设计获用户批准）
- 背景：Boss直聘等强风控站打不开，根因是 MAIN world 观测 hook 包装了 console 五方法、fetch、XHR open/send（构建产物 manifest `"world":"MAIN"` + `document_start`），站点反爬指纹检测命中后拒绝服务。

## 1. 目标

给 MAIN world hook（`entrypoints/hook.content.ts`）加**敏感站点排除名单**：命中名单的站点不注入 hook，消除扩展指纹，让风控站正常打开。名单用户可编辑，设置页管理。

非目标（YAGNI）：
- 不排除 ISOLATED content.ts（对页面 JS 不可见、无指纹风险，排除即丢全部工具能力）。
- 不做按站细粒度开关（console/fetch 分开排除）。
- 不枚举第三方风控 iframe 域名（跨域 iframe 挡不住是已知边界）。
- 不做用户脚本联动警告。

## 2. 架构

hook 从 manifest 静态声明改为 **SW 动态注册**，excludeMatches 承载名单：

- `entrypoints/hook.content.ts` 的 `defineContentScript` 加 `registration: 'runtime'`（WXT 0.21.4 原生支持：构建时不再写进 manifest 的 `content_scripts`，其 `matches` 并入 host_permissions；注册由我们经 `browser.scripting.registerContentScripts` 完成）。其余字段（`<all_urls>` / allFrames / document_start / MAIN）不变。
- `entrypoints/content.ts`（ISOLATED）保持 manifest 静态注入不动。

## 3. 模块设计

### 3.1 `background/hook-exclusions.ts`（新，名单存储）

仿 `gm-permissions.ts` 的独立存储模式：

- key：`local:hook:exclusions`，形状 `{ patterns: string[] }`。
- 默认名单（存储为空/无该 key 时生效）：
  - `*://*.zhipin.com/*`（Boss直聘）
  - `*://*.lagou.com/*`（拉勾）
  - `*://*.zhaopin.com/*`（智联招聘）
  - `*://*.51job.com/*`（前程无忧）
- 导出：
  - `getHookExclusions(): Promise<string[]>` —— 读已存名单；未存过返回默认名单。
  - `saveHookExclusions(patterns: string[]): Promise<void>` —— 全量覆盖落库（先经 `isValidMatchPattern` 校验，非法 throw 并列出条目，调用方展示）。
  - `resetHookExclusions(): Promise<string[]>` —— 删除存储键回默认，返回默认名单。

### 3.2 `background/hook-registration.ts`（新，注册同步）

`browser.scripting` 注册薄封装 + diff 同步（同 `scripts.ts` 期望注册集自愈模式）：

- 注册详情：`id: 'hook-observe'`，`matches: ['<all_urls>']`，`excludeMatches: await getHookExclusions()`，`runAt: 'document_start'`，`world: 'MAIN'`，`allFrames: true`，`js: [hook 构建产物路径]`。
- `syncHookRegistration(): Promise<void>`：
  - `getRegisteredContentScripts()` 找 `id === 'hook-observe'`；
  - 已注册且 `excludeMatches` 与名单一致（比较 JSON.stringify）→ 跳过；
  - 已注册但名单变了 → `updateContentScripts`；
  - 未注册 → `registerContentScripts`。
  - SW 冷启动时 `getRegisteredContentScripts` 可能抛错（极端漂移）→ 按「未注册」处理走 register 自愈。
- hook 构建产物路径：WXT `registration: 'runtime'` 时产物仍在 `content-scripts/hook.js`，用 `browser.runtime.getManifest()` 不可得（动态注册不进 manifest），直接写死相对路径常量 `'content-scripts/hook.js'` + `browser.runtime.getURL()`。（实施时验证产物文件名；若 WXT 产物名不同，以实际产物为准。）

### 3.3 消息协议（`shared/messages.ts`）

RequestMessage 联合加两条，router 接线：

- `HOOK_EXCLUSIONS_GET` → `{ ok: true, data: { patterns: string[]; defaults: string[] } }`（defaults 一并返回，UI 判「已改动」状态）。
- `HOOK_EXCLUSIONS_SAVE` → `{ patterns: string[] }`，全量覆盖语义。handler 流程：校验（非法 → `{ ok: false, error: '非法 match pattern：…' }` 列出坏条目，整体拒绝）→ 落库 → `syncHookRegistration()`（注册失败不回滚落库，返回 warnings 提示「已保存但注册同步失败」）。

### 3.4 设置页 UI

- `SettingsHome` 加第五张入口卡「敏感站点排除」（desc：`风控站（如 Boss直聘）不注入观测 hook，防止被指纹检测拒开`）。
- 新二级页 `components/settings/HookExclusionsPage.tsx`：
  - 名单列表：每条 pattern + 删除钮（lucide `Trash2`）。
  - 添加行：输入框 + 添加钮（回车等同添加）；添加时前端先过 `isValidMatchPattern`，非法行内报错不落库。
  - 「恢复默认」钮：resetHookExclusions 后刷新列表。
  - 说明区（两句话）：作用（命中站点不注入 MAIN world 观测 hook，消除扩展指纹，防风控站拒开）+ 限制（保存后需刷新已打开的页面才生效；该站 console 观测失效、网络请求/响应 body 不可用；自己的用户脚本不受此名单约束）。
  - 保存即生效（每次增删直接调 SAVE），无独立保存钮。
  - 样式复用 `.setting-card` / `.btn` / `.input` tokens + lucide 图标（禁 emoji）。

## 4. 数据流

```
设置页 SAVE → SW handler 校验 → storage 落库 → syncHookRegistration()
                                                → updateContentScripts（excludeMatches 更新）
之后导航 → Chrome 按 excludeMatches 决定是否注入 hook → 命中名单的站零注入、零指纹
```

SW 冷启动 → `syncHookRegistration()`（与 `initScriptsModule` 的启动自愈同款时序）→ 注册/对齐。

## 5. 错误处理

- 非法 pattern：SAVE 整体拒绝，错误信息列出非法条目（同脚本 matches 校验文案风格）。
- 注册 API 失败（旧 Chrome 无 configureWorld 场景不涉及；`updateContentScripts` 打在未注册 id 上等极端漂移）：降级 unregister+register；仍失败则返回 warnings，落库不回滚（下次 SW 冷启动自愈）。
- SW 冷启动注册失败：静默（catch 空吞，同 `syncRegistrations` 启动自愈的静默约定）。

## 6. 测试

单测（vitest + fakeBrowser）：
- `hook-exclusions`：默认名单兜底（未存时）、save/reset 往返。
- SAVE handler：非法 pattern 整体拒绝且不落库；合法路径落库。
- `hook-registration` diff：未注册 → register；一致 → 跳过（不调 update/register）；名单变更 → updateContentScripts；getRegisteredContentScripts 抛错 → 自愈 register。

手测清单：
1. `npm run build` 后 manifest.json 不含 `content_scripts` 中 world:MAIN 的 hook 条目。
2. chrome://extensions 重载扩展 → 打开 Boss直聘能正常加载。
3. 普通站（如 example.com）console 观测照常（list_console_messages 有数据）。
4. 设置页增删条目 → 重新加载某页生效/恢复注入。
5. 「恢复默认」回四站名单。

## 7. 已知边界

- 排除只对**之后的导航**生效；已打开页面需刷新。
- dev 模式 WXT 热重载不自动注册动态 content script；SW 重启后的启动 sync 兜底——开发期改 hook 代码需重载扩展一次。
- 第三方风控 iframe（独立跨域文档）不覆盖——excludeMatches 按文档 URL 判定，iframe 是另一文档。
- 用户自己的脚本池脚本 patch 页面函数的指纹不归本名单管。
- 排除站上：console 观测失效；网络观测只剩 webRequest 主干元数据（无 body、无 hook 富化）。
- Firefox 的 `scripting.registerContentScripts` 形状差异（本项目当前 Chrome-only，与 userScripts 同一立场）。
