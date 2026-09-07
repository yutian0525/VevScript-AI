# GM_* API 全集目录（ecosystem 盘点 + 本扩展支持状态）

> 定位：**GM_* API 的完整清单**——聚合 Tampermonkey / Violentmonkey / ScriptCat 三家生态（源码调研 2026-09-02），逐个标注本扩展的支持状态。
> 面向脚本作者的签名/示例/差异细节见下方「Phase 5 实现说明」与「Tier A+B 实现说明」；Phase 5 设计见 `docs/superpowers/specs/2026-09-02-ai-browser-extension-phase5-gm-api-design.md`，Tier A+B 设计见 `docs/superpowers/specs/2026-09-07-gm-api-expansion-tier-ab-design.md`。
> 状态图例：**Phase 5**（首批实现，15 个）· **Tier A+B**（2026-09-07 扩充实现，14 个函数型 + 3 特殊 grant）· **后续候选**（架构可容纳，按需排期）· **明确不做**（架构不匹配或 YAGNI，附理由与替代）。

## Phase 5 实现说明（本扩展的落地细节）

面向脚本作者的实现细节，补充上面清单里 **Phase 5** 标注项的行为：

- **双形态**：`GM_xxx` 下划线形式同步返回（值类 API 读注入时快照，零 RPC）；`GM.xxx` 点形式返回 Promise。同 TM/VM/SC。
- **值存储**：注入时把当前值快照直嵌进 wrapper（同步读快照）；写操作经桥穿透到 SW 落库，并广播到匹配同脚本 @match 的其它 tab（`GM_addValueChangeListener` 收到的跨 tab 事件 `remote=true`，发起 tab 本地事件 `remote=false`）。
- **GM_xmlhttpRequest**：@connect 三分支——self（同 host / 请求为页面子域）与 @connect 命中直接放行；列了 @connect 但不命中直接拒绝；未列入则弹确认卡（允许一次 / 总是允许 / 拒绝，60s 无响应按拒绝），「总是允许」记入 `local:gm:permissions` 授权库。被 fetch 禁的头（`user-agent`/`referer`/`cookie`/`origin`/`host`）忽略并在响应 `droppedHeaders` 列出。响应非流式、`≤1MB` 截断（超出置 `truncated:true`）。`credentials: 'include'`（带浏览器会话 cookie）。
- **GM_addStyle**：当前 world 直接 `createElement('style')` 建 DOM。
- **GM_log**：写本地 `console`，带 `[脚本名]` 前缀。
- **GM_registerMenuCommand**：菜单命令入口在**侧边栏脚本页「菜单命令」区**（非浏览器右键菜单）；点击经 SW 回发到注册来源 tab 触发回调。
- **GM_setClipboard**：仅文本。MV3 SW 无文档上下文（`navigator.clipboard` 为 undefined），经专用 offscreen 文档（reason CLIPBOARD）+ `execCommand('copy')`（writeText 要求文档焦点，offscreen 永无焦点）写入；失败返回可读错误文本。
- **GM_notification**：图标为扩展内占位 PNG（`/gm-notif.png`，Chrome basic 通知不接受 data: URI）；后续可通过 `details.image` 扩展自定义图标。
- **unsafeWindow**：MAIN world 下 = `window`（真页面 window）；USER_SCRIPT world 下 = 隔离世界 window（要真页面 window 请 `@world MAIN`）。
- **GM_llmChat**：脚本调用扩展配置的大模型（OpenAI 兼容，`设置 → 模型设置` 同源配置，脚本不可自选模型/覆盖）。`messages` 数组（system/user/assistant；content 为字符串或多段 `{type:'text'|'image_url',...}`，图片 data URL ≤5MB 或 http(s) URL）；`onChunk(delta)` 可选收流式文本增量；Promise resolve `{ text, usage, finishReason }`。权限档 per-script（默认「每次询问」弹确认卡：允许一次 / 本会话内允许 / 拒绝 60s 超时），脚本详情 → 设置 → 模型调用 可改档。限制：消息载荷 ≤2MB、响应聚合 ≤1MB（超限报错不截断）、整调用超时默认 120s（可传 `timeout` 覆盖）。无 abort、无 tool 角色、reasoning 不下发。已知差异：直调（调试台）为非流式语义（无 onChunk 通道）；「本会话内允许」为 SW 内存态，扩展进程重启后回到档位语义。

## Tier A+B 实现说明（2026-09-07）

补充上面清单里 **Tier A+B** 标注项的落地细节（设计见 `docs/superpowers/specs/2026-09-07-gm-api-expansion-tier-ab-design.md`）：

- **@connect 门控复用**：GM_cookie / GM_download 的域校验与 GM_xmlhttpRequest 共用同一套 `matchConnect` + always-allow 授权库（`local:gm:permissions`）——用户对某脚本「总是允许 host X」会同时覆盖 XHR / cookie / download 三者的确认卡；反之确认卡也可能由三者任一触发。manifest 相应新增 `downloads` / `cookies` / `webNavigation` 三权限。
- **window.onurlchange**：SW 监听 `webNavigation` 的 `onHistoryStateUpdated`（pushState/replaceState）与 `onReferenceFragmentUpdated`（hash），仅主帧（frameId=0），下行到 @grant window.onurlchange 且 @match 命中的启用脚本；wrapper 侧 `window.onurlchange` 属性回调 + `window.addEventListener('urlchange', ...)` 事件双形态。
- **GM_getTab / GM_saveTab / GM_getTabs**：per-tab 临时数据存 `chrome.storage.session`（键 `gm-tab:{scriptId}:{tabId}`），tab/浏览器关闭随会话失效，不持久化；getTabs 按前缀枚举回 `{[tabId]: data}`。
- **GM_getResourceURL**：@resource 预取管线按 content-type 分流——文本类存原文（GM_getResourceText 同源兼容）、二进制存 base64+mime；返回完整 `data:` URL（`data:{mime};base64,…`）。`isBlobUrl` 参数忽略（不做 blob: 生命周期管理）。
- **GM_cookie 对象型**：`@grant GM_cookie` 一次装齐 list/set/delete 三方法（对象型 grant，注册表 `objectApi` 声明）；点形式 `GM.cookie` 与之同引用。
- **已知边界**：GM_download 无 onprogress（首版仅 onload/onerror，返回的 `{abort}` 为空实现）；window.close/focus 作用于脚本所在整个 tab（非 window 级）；urlchange 仅主帧（frameId=0），不覆盖 iframe；cookie/download 与 XHR 共用同一 @connect 授权库（耦合见上）。

## 0. @grant 语义（三家通用，本扩展遵循）

- `@grant <API名>` 声明即授权：只有声明过的 API 才会被安装到脚本上下文，未声明的 API **不存在**（调用报 `undefined is not a function`，而非运行时弹权限窗）。
- `@grant none`：不建 GM 沙箱，脚本裸执行（仅注入 `GM_info` / `GM` 最小对象）。
- `GM.xxx` 点形式是 `GM_xxx` 的别名（Promise 形态），不作为独立 API 计数。
- 特殊 grant 名（不是函数）：`unsafeWindow`、`window.close`、`window.focus`、`window.onurlchange`。

## 1. 信息与元数据

| API | 点形式 | 语义 | TM | VM | SC | 本扩展 |
|---|---|---|---|---|---|---|
| `GM_info` | `GM.info` | 脚本与扩展元数据（scriptHandler/version/script{...}/injectInto） | ✓ | ✓ | ✓ | **Phase 5**（构建期直嵌） |

## 2. 值存储

| API | 点形式 | 下划线形态 | 语义 | TM | VM | SC | 本扩展 |
|---|---|---|---|---|---|---|---|
| `GM_getValue(key, def?)` | `GM.getValue` | 同步返回 | 读脚本命名空间的持久值 | ✓ | ✓ | ✓ | **Phase 5**（快照同步读，零 RPC） |
| `GM_setValue(key, val)` | `GM.setValue` | void | 写值 + 跨 tab 广播 | ✓ | ✓ | ✓ | **Phase 5** |
| `GM_deleteValue(key)` | `GM.deleteValue` | void | 删值 | ✓ | ✓ | ✓ | **Phase 5** |
| `GM_listValues()` | `GM.listValues` | 同步返回 key[] | 列全部键 | ✓ | ✓ | ✓ | **Phase 5** |
| `GM_addValueChangeListener(key, fn)` | `GM.addValueChangeListener` | 返回 listenerId | 值变更监听（remote 标记跨 tab） | ✓ | ✓ | ✓ | **Phase 5** |
| `GM_removeValueChangeListener(id)` | `GM.removeValueChangeListener` | void | 移除监听 | ✓ | ✓ | ✓ | **Tier A+B**（listenerId 按 `key:idx` 解析，监听槽置空） |
| `GM_getValues(keysOrDefaults)` | `GM.getValues` | 同步返回 obj | 批量读 | ✓ | ✓ | ✓ | **Tier A+B**（读注入时值快照，零 RPC；键数组 / 带默认值对象 / 全量三形态） |
| `GM_setValues(obj)` | `GM.setValues` | void | 批量写 | ✓ | ✓ | ✓ | **Tier A+B**（写快照 + 桥 SetValues 逐键广播） |
| `GM_deleteValues(keys)` | `GM.deleteValues` | void | 批量删 | ✓ | ✓ | ✓ | **Tier A+B**（删快照 + 桥 DeleteValues 逐键广播） |

## 3. 页面与 DOM

| API | 点形式 | 语义 | TM | VM | SC | 本扩展 |
|---|---|---|---|---|---|---|
| `GM_addStyle(css)` | `GM.addStyle` | 注入 `<style>` 元素，同步返回元素 | ✓ | ✓ | ✓ | **Phase 5**（当前 world 直接 createElement） |
| `GM_addElement(tag\|parent, attrs?)` | `GM.addElement` | 创建并插入元素（绕扩展 CSP） | ✓ | ✓ | ✓ | **Tier A+B**（当前 world createElement 本地完成，attrs 支持 textContent/innerHTML/其余 setAttribute） |
| `unsafeWindow`（特殊 grant） | — | 页面真实 window | ✓ | ✓ | ✓ | **Phase 5**（MAIN world = window；USER_SCRIPT world = 隔离世界 window——要真页面 window 请 `@world MAIN`） |
| `window.close`（特殊 grant） | — | 关闭脚本所在 tab | ✓ | ✓ | ✓ | **Tier A+B**（桥 → SW `tabs.remove`，作用于脚本所在整个 tab） |
| `window.focus`（特殊 grant） | — | 激活脚本所在 tab | ✓ | ✓ | ✓ | **Tier A+B**（桥 → SW `tabs.update({active:true})`） |
| `window.onurlchange`（特殊 grant） | — | SPA 路由变化的 urlchange 事件 | ✓ | ✗ | ✓ | **Tier A+B**（SW webNavigation onHistoryStateUpdated/onReferenceFragmentUpdated 主帧下行；`window.onurlchange` 属性回调 + `'urlchange'` 事件双形态） |

## 4. 资源

| API | 点形式 | 语义 | TM | VM | SC | 本扩展 |
|---|---|---|---|---|---|---|
| `GM_getResourceText(name)` | `GM.getResourceText` | 同步返回 `@resource` 文本 | ✓ | ✓ | ✓ | **Phase 5**（快照直嵌；随 @resource 预取） |
| `GM_getResourceURL(name, isBlobUrl?)` | `GM.getResourceUrl` | 资源的 data:/blob: URL | ✓ | ✓ | ✓ | **Tier A+B**（注入时 data: URL 快照直嵌；二进制资源经预取 base64+mime 拼完整 data: URL，blob: 形态不做） |

## 5. 菜单命令

| API | 点形式 | 语义 | TM | VM | SC | 本扩展 |
|---|---|---|---|---|---|---|
| `GM_registerMenuCommand(name, fn, opts?)` | `GM.registerMenuCommand` | 注册菜单命令，返回 key | ✓ | ✓ | ✓ | **Phase 5**（入口在侧边栏脚本页，非右键菜单） |
| `GM_unregisterMenuCommand(key)` | `GM.unregisterMenuCommand` | 注销命令 | ✓ | ✓ | ✓ | **Tier A+B**（删 SW 菜单表条目 + 广播侧边栏刷新） |

## 6. 网络

| API | 点形式 | 语义 | TM | VM | SC | 本扩展 |
|---|---|---|---|---|---|---|
| `GM_xmlhttpRequest(details)` | `GM.xmlHttpRequest` | 跨域请求，返回 `{abort}` | ✓ | ✓ | ✓ | **Phase 5**（@connect 白名单 + 确认卡；无 unsafe header 改写；非流式、响应 ≤1MB） |
| `GM_download(detailsOrUrl, name?)` | `GM.download` | 下载文件 | ✓ | ✓ | ✓ | **Tier A+B**（`chrome.downloads` + downloads 权限；@connect 门控与确认卡；onload/onerror 回调，onprogress 暂缺，返回 `{abort}` 空实现） |
| `GM_cookie.list/set/delete(details)` | `GM.cookie.list` 等 | 读写站点 cookie | ✓ | ✓ | ✓ | **Tier A+B**（cookies 权限 + @connect 门控复用；对象型 grant `@grant GM_cookie` 一次装齐三方法，点形式 GM.cookie 同引用） |
| `GM_webRequest(rule)` | — | 注册 webRequest 规则 | ✓ | ✗ | ✗ | **明确不做**（TM 独有；MV3 无 blocking webRequest，需 DNR 重设计） |

## 7. 标签页

| API | 点形式 | 语义 | TM | VM | SC | 本扩展 |
|---|---|---|---|---|---|---|
| `GM_openInTab(url, opts?)` | `GM.openInTab` | 开新 tab，返回 `{close(), onclose, closed}` 句柄 | ✓ | ✓ | ✓ | **Phase 5** |
| `GM_getTab(cb)` | `GM.getTab` | 读本脚本在本 tab 的持久数据 | ✓ | ✗ | ✓ | **Tier A+B**（`storage.session` per-tab 键 `gm-tab:{scriptId}:{tabId}`，随会话失效；Promise + 回调双形态） |
| `GM_saveTab(data)` | `GM.saveTab` | 写该数据 | ✓ | ✗ | ✓ | **Tier A+B**（同上存储） |
| `GM_getTabs(cb)` | `GM.getTabs` | 全部 tab 的该脚本数据 | ✓ | ✗ | ✓ | **Tier A+B**（前缀枚举 session 存储，`{[tabId]: data}`） |
| `GM_closeInTab(tabId)` | — | 按 id 关 tab | ✗ | ✗ | ✓ | **明确不做**（SC 扩展；用 `GM_openInTab` 返回句柄的 `close()`） |

## 8. 通知与剪贴板

| API | 点形式 | 语义 | TM | VM | SC | 本扩展 |
|---|---|---|---|---|---|---|
| `GM_notification(details, ondone?)` | `GM.notification` | 系统通知，点击/关闭回调 | ✓ | ✓ | ✓ | **Phase 5**（SW `chrome.notifications`） |
| `GM_setClipboard(data, type?)` | `GM.setClipboard` | 写剪贴板 | ✓ | ✓ | ✓ | **Phase 5**（offscreen 文档 + execCommand；仅文本） |
| `GM_closeNotification(id)` | — | 关闭/更新已发通知 | ✗ | ✗ | ✓ | **Tier A+B**（SW `notifications.clear`，id 为 GM_notification 的返回 id） |
| `GM_updateNotification(id, details)` | — | 同上 | ✗ | ✗ | ✓ | **Tier A+B**（SW `notifications.update`，仅 title/text） |

## 9. 日志

| API | 点形式 | 语义 | TM | VM | SC | 本扩展 |
|---|---|---|---|---|---|---|
| `GM_log(...args)` | `GM.log` | 带脚本前缀的日志 | ✗ | ✓ | ✓ | **Phase 5**（本地 console，格式 `[脚本名]`） |

## 9.5 大模型（本扩展新增，非 GM 生态标准）

| API | 点形式 | 语义 | TM | VM | SC | 本扩展 |
|---|---|---|---|---|---|---|
| `GM_llmChat(details)` | `GM.llmChat` | 调扩展配置的大模型（文本/图片、流式 onChunk） | ✗ | ✗ | ✗ | **本扩展**（权限档三选一 + 确认卡；限制见 Phase 5 实现说明） |

## 10. 明确不做（含理由与替代）

| API / 能力 | 来源 | 不做理由 | 替代方案 |
|---|---|---|---|
| `CAT_*` 全家（`CAT_fileStorage`、`CAT_registerMenuInput`、`CAT_createBlobUrl`、`CAT_fetchBlob`、`CAT_userConfig`、`CAT_scriptLoaded`、`CAT.agent.*` 等） | ScriptCat 专有 | 生态绑定 ScriptCat（云同步/文件存储/AI agent），与本扩展定位不重叠 | 按需用 `GM_setValue` / `GM_xmlhttpRequest` 组合 |
| `GM_connect` | Greasemonkey4 | 三家现役管理器均未实现（历史 API） | `GM_addValueChangeListener` 跨 tab 协同 |
| `cloneInto` / `createObjectIn` / `exportFunction` | Firefox Xray 兼容（VM 无条件注入） | Chrome-only 扩展无 Xray 隔离 | 不需要 |
| unsafe header 改写（`user-agent`/`referer`/`cookie` 等被 fetch 禁的头） | TM/VM/SC（DNR session 规则实现） | 本阶段不引入 DNR；忽略禁头并记 warning | 后续若做，按 VM `dnr.js` 的 per-request session rule 模式 |
| 流式响应 / `responseType: 'stream'` | TM/SC（MessageConnect 分块流） | 首批一次性桥足够；响应 ≤1MB 截断 | 大文件场景后续升级长连接通道 |

## 11. 已实现速览（Phase 5 的 15 + Tier A+B 的 14）

Phase 5 首批 15 个：`GM_info` · `GM_getValue` · `GM_setValue` · `GM_deleteValue` · `GM_listValues` · `GM_addValueChangeListener` · `GM_addStyle` · `GM_getResourceText` · `GM_log` · `GM_registerMenuCommand` · `GM_setClipboard` · `GM_notification` · `GM_openInTab` · `GM_xmlhttpRequest` · `GM_llmChat`

Tier A+B 扩充 14 个（2026-09-07）：`GM_removeValueChangeListener` · `GM_getValues` · `GM_setValues` · `GM_deleteValues` · `GM_addElement` · `GM_unregisterMenuCommand` · `GM_getResourceURL` · `GM_getTab` · `GM_saveTab` · `GM_getTabs` · `GM_closeNotification` · `GM_updateNotification` · `GM_download` · `GM_cookie`（对象型，一次装齐 list/set/delete）

外加特殊 grant 4 个：`unsafeWindow`（Phase 5，语义见 §3）、`window.close` / `window.focus` / `window.onurlchange`（Tier A+B，语义见 §3 与 Tier A+B 实现说明）。

即本扩展已实现 **29 个函数型 API + 4 个特殊 grant**。

各家 API 总量参考：VM `GM_API_NAMES` 26 项（不含点别名与特殊 grant）；SC content 侧公开方法 30+（含 CAT_* 与通知管理扩展）；TM 文档面与 VM 大体相当另有少量独有（`GM_webRequest` 等）。本目录以三家并集为准，共 **35 个函数型 API + 4 个特殊 grant 名**（并集口径，非本扩展支持数）。
