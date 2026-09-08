# GM API 扩充对齐 TM/VM/SC（Tier A + B）设计

> 定位：把 [docs/gm-api.md](../../gm-api.md) 里标注「后续候选」的 GM_* API 分两批（Tier A 零新权限 / Tier B 需新权限或新 hook）落地，向 Tampermonkey / Violentmonkey / ScriptCat 三家生态对齐。
> 前置：Phase 5 已建成 GM 桥基建（wrapper 生成 + 三事件桥 + SW 中心 + @connect 门控 + 确认队列），本设计在既有基建上增量扩充，不重构桥协议。
> 日期：2026-09-07。

## 1. 目标与非目标

### 目标

- 新增 14 个函数型 GM API（12 Tier A + GM_download + GM_cookie）+ 3 个特殊 grant，覆盖三家现役管理器的高频缺口。
- 复用既有基建：注册表唯一真源、三事件桥、`matchConnect` + `always-allow` 授权库、确认队列、菜单表、错误缓冲。
- 敏感能力（cookie / download）复用 `@connect` 门控 + 确认卡，不引入新的权限模型。
- 在 `fixtures/userscripts/manual` 补齐人工验证脚本，覆盖每个新 API。
- `npm run compile` + `npm run test` 全绿。

### 非目标（本设计不做，维持 docs/gm-api.md「明确不做」判定）

- unsafe header 改写（`user-agent`/`referer`/`cookie` 等）——需引入 declarativeNetRequest，Tier C。
- `GM_xmlhttpRequest` 流式响应 / `responseType:'stream'`——需长连接通道，Tier C。
- `GM_webRequest`——MV3 无 blocking webRequest，Tier C。
- ScriptCat `CAT_*` 全家、Greasemonkey4 `GM_connect`、Firefox Xray（`cloneInto` 等）——生态绑定/架构不匹配。

## 2. API 清单（现 15 函数 + 1 特殊 grant → 目标 29 函数 + 4 特殊 grant，共 33 grant 名）

### Tier A — 低成本，零新权限

| API | 点形式 | impl | 落点 |
|---|---|---|---|
| `GM_removeValueChangeListener(id)` | `GM.removeValueChangeListener` | local | wrapper 删 `__GM_valueHooks` 项 |
| `GM_getValues(keysOrDefaults)` | `GM.getValues` | snapshot | wrapper 读 `__values` |
| `GM_setValues(obj)` | `GM.setValues` | bridge | SW 批量写 + 合并广播 |
| `GM_deleteValues(keys)` | `GM.deleteValues` | bridge | SW 批量删 + 合并广播 |
| `GM_addElement(tag\|parent, tag?, attrs?)` | `GM.addElement` | local | wrapper createElement + setAttribute |
| `GM_unregisterMenuCommand(key)` | `GM.unregisterMenuCommand` | bridge | SW 删 menuTable + 广播 |
| `GM_getResourceURL(name, isBlobUrl?)` | `GM.getResourceUrl` | snapshot | wrapper 拼 data: URL（依赖二进制预取） |
| `GM_getTab(cb)` | `GM.getTab` | bridge | per-tab 存储子系统 |
| `GM_saveTab(data)` | `GM.saveTab` | bridge | per-tab 存储子系统 |
| `GM_getTabs(cb)` | `GM.getTabs` | bridge | per-tab 存储子系统 |
| `GM_closeNotification(id)` | `GM.closeNotification` | bridge | SW notifications.clear |
| `GM_updateNotification(id, details)` | `GM.updateNotification` | bridge | SW notifications.update |
| `window.close`（特殊 grant） | — | bridge | SW tabs.remove（脚本所在 tab） |
| `window.focus`（特殊 grant） | — | bridge | SW tabs.update(active) |

### Tier B — 中成本，需新权限/hook

| API | 点形式 | impl | 权限 | 门控 |
|---|---|---|---|---|
| `GM_download(details\|url, name?)` | `GM.download` | bridge | `downloads` | 源 URL 走 `@connect` + 首次确认卡 |
| `GM_cookie.list/set/delete(details)` | `GM.cookie.*` | bridge（对象型） | `cookies` | 目标域走 `@connect`（复用 matchConnect + always-allow） |
| `window.onurlchange`（特殊 grant） | — | bridge | `webNavigation` | SW 监听导航事件下行 URL_CHANGE |

`manifest.permissions` 追加 `'downloads'`、`'cookies'`、`'webNavigation'`。

## 3. 决策记录（brainstorming 已定）

- **对齐深度** = Tier A + B（Tier C 明确不做）。
- **GM_cookie 门控** = 复用 `@connect` 判定（与 `GM_xmlhttpRequest` 同一套 `matchConnect` + 确认卡 + always-allow）。
- **GM_download 实现** = `chrome.downloads` API（新增 downloads 权限，浏览器自带下载条，支持 onload/onerror/onprogress），源 URL 走 `@connect`。
- **window.onurlchange 实现** = SW 监听 `webNavigation.onHistoryStateUpdated` + `onReferenceFragmentUpdated`，按 tabId 下行 URL_CHANGE（跨 world 健壮，不依赖 wrapper 本地 history patch）。
- **GM_getResourceURL 二进制** = 扩展预取管线，按 content-type 分文本（存原文）/ 二进制（存 base64 + mime），wrapper 拼完整 data: URL。

## 4. 各层改动

### 4.1 注册表 `shared/gm-apis.ts`（唯一真源）

- `GM_API_REGISTRY` 增 14 条（12 Tier A + GM_download + GM_cookie，特殊 grant 不入注册表）：每条声明 `impl`（`snapshot`/`local`/`bridge`）与 `promiseForm`。
- `SPECIAL_GRANTS` 从 `{unsafeWindow}` 扩为 `{unsafeWindow, 'window.close', 'window.focus', 'window.onurlchange'}`。
- `classifyGrants` 无需改逻辑（读注册表 + SPECIAL_GRANTS 二分），扩充后徽标/调试台 GM 列表自动同步。
- `GM_cookie` 作为**单一 grant 名**登记（对象型，`@grant GM_cookie` 一次装齐 list/set/delete 三方法）；注册表新增可选字段 `objectApi?: string[]`（子方法名，仅 `GM_cookie` 用），供 wrapper 判定安装形态。

### 4.2 wrapper `shared/gm-wrapper.ts`

- **本地/快照类**（`GM_getValues`/`GM_addElement`/`GM_removeValueChangeListener`/`GM_getResourceURL`）：`GM_INSTALLS` 表加一行 ES5 函数体，零 RPC。
  - `GM_getValues(keys)`：`keys` 为数组时逐键读 `__values`；为对象时用其值作默认值。返回对象。
  - `GM_addElement`：两种签名 `(tagName, attrs)` 与 `(parentNode, tagName, attrs)`；createElement + 遍历 attrs setAttribute（`textContent`/`innerHTML` 特判），append 到 parent 或 head。返回元素。
  - `GM_removeValueChangeListener(id)`：id 形如 `key:idx`，拆出 key 后置空 `__GM_valueHooks` 对应槽（保持 idx 稳定）。
  - `GM_getResourceURL(name)`：读注入时快照 `__resourceUrls[name]`（预取产物的完整 data: URL），无则 undefined。
- **桥类**（`GM_setValues`/`GM_deleteValues`/`GM_download`/`GM_unregisterMenuCommand`/`GM_closeNotification`/`GM_updateNotification`/getTab 系）：`__GM_post` 转发短 api 名；回调型（download 的 onprogress/onload）沿用 `GM_xmlhttpRequest` 的「函数留闭包 + .then 分发」模式，details 经 `__GM_plain` 摘函数过桥。
- **对象型 API**（`GM_cookie`）：`install` 现仅认函数值，扩展为支持对象。`@grant GM_cookie` 安装 `GM_cookie = { list: fn, set: fn, delete: fn }`，三方法各自 `__GM_post('Cookie'+Op, [details])`；点形式 `GM.cookie` 同引用（本身即 Promise 方法对象，不再包一层）。
- **特殊 grant**（preamble 内按 grant 条件安装）：
  - `window.close`：grant 命中时覆写 `unsafeWindow.close = function () { __GM_post('WindowClose', []); }`。
  - `window.focus`：同理 `__GM_post('WindowFocus', [])`。
  - `window.onurlchange`：grant 命中时 `unsafeWindow.onurlchange = null`（占位声明支持）；`gmevt` 分支加 `URL_CHANGE` → 若 `unsafeWindow.onurlchange` 为函数则调用，并 dispatch `new CustomEvent('urlchange', {detail:{url}})`（对齐 TM 的 `window.addEventListener('urlchange', ...)` 双形态）。
  - 特殊 grant 不进 `GM_INSTALLS`/`installLines` 的形参注入路径（它们改的是 `unsafeWindow`，不是 GM 对象），在 preamble 尾部按 `grants.includes(...)` 条件 emit。
- `WrapperDeps` 增 `resourceUrls: Record<string, string>`（name → data: URL 快照），`RESOURCEURLS_PLACEHOLDER` 直嵌。

### 4.3 SW 中心 `background/gm-api.ts`

- `API_TO_GRANT` 加映射：`SetValues/DeleteValues → GM_setValues/GM_deleteValues`、`UnregisterMenu → GM_unregisterMenuCommand`、`CloseNotification/UpdateNotification → GM_closeNotification/GM_updateNotification`、`GetTab/SaveTab/GetTabs → GM_getTab/GM_saveTab/GM_getTabs`、`Download → GM_download`、`CookieList/CookieSet/CookieDelete → GM_cookie`、`WindowClose → window.close`、`WindowFocus → window.focus`。
- `GRANT_EXEMPT` 加批量值 `SetValues/DeleteValues/GetValues`（与单值一致，grant 在 wrapper 安装期把关）。
- `handleGmCall` switch 加各 case，委托到新子系统模块（见 §5）。批量值 case 在 SW 内读一次 values、合并写、按变更键逐个 `broadcastValueChange`。
- `cleanupScriptState` 增清 per-tab 存储（脚本删除时）。

### 4.4 桥宿主 `content/gm-bridge-host.ts`

基本不动——`GM_API_CALL` 纯透传，`handleGmEvent` 已支持任意 `kind` 的 `gmevt` dispatch。新增的 `URL_CHANGE`/download 进度事件走既有 `GM_EVENT` 下行通道，无需改宿主。

## 5. 新增子系统

### 5.1 per-tab 存储 `background/gm-tab-store.ts`（GM_getTab/saveTab/getTabs）

- 键 `session:gm-tab:{scriptId}:{tabId}`，用 `storage.session`（tab/浏览器关闭随会话失效，符合 GM_getTab「本 tab 临时数据」语义）。
- `GetTab`：读 sender.tab.id 对应键，无则返回 `{}`（TM 语义：首次为空对象）。
- `SaveTab`：写 sender.tab.id 对应键。
- `GetTabs`：扫 `session:gm-tab:{scriptId}:*` 全部键，返回 `{tabId: data}` 映射（对齐 TM 的 `GM_getTabs(cb)` 收 `{[tabId]: data}`）。
- 无跨 tab 广播（getTab 数据是 tab 私有快照，非响应式）。

### 5.2 cookie `background/gm-cookie.ts`（GM_cookie.list/set/delete）

- `chrome.cookies.getAll/set/remove` 三方法。
- 门控：目标域（`details.url` 或 `details.domain`）走 `matchConnectWithPermissions`（复用 §gm-api.ts 现成三分支 + 确认卡 + always-allow）。CONFIRM 时弹与 XHR 同款确认卡（kind 复用 `connect`，message 换文案「读写 cookie」）。
- `list(details)`：getAll，返回 cookie 数组（name/value/domain/path/expirationDate/httpOnly/secure/sameSite）。
- `set(details)`：cookies.set。
- `delete(details)`：cookies.remove（按 url + name）。
- 高敏感：确认卡 rows 明示 host + 操作类型（list/set/delete）+ 来源页 URL。

### 5.3 download `background/gm-download.ts`（GM_download）

- 归一化两种签名：`GM_download(url, name)` 与 `GM_download({url, name, headers, saveAs, onload, onerror, onprogress})`。
- 门控：源 URL 走 `matchConnectWithPermissions`（跨域下载需 @connect / 确认）。
- `chrome.downloads.download({url, filename, saveAs, headers})`，拿到 downloadId。
- `chrome.downloads.onChanged` 监听该 id：`state=complete` → 回发 download 完成事件（wrapper .then → onload）；`state=interrupted` → onerror；进度经 `bytesReceived` 增量下行（可选，首版可仅 onload/onerror，onprogress 留 backlog）。
- downloadId → {scriptId, tabId, chan} 映射存 SW 内存态（重启丢失可接受，与通知表同款）。

### 5.4 urlchange `background/gm-urlchange.ts`（window.onurlchange）

- SW 监听 `webNavigation.onHistoryStateUpdated`（pushState/replaceState）+ `onReferenceFragmentUpdated`（hash 变化），仅主帧（frameId=0）。
- 事件到达 → 查该 tab.url 命中的、且 `@grant window.onurlchange` 的注入脚本（复用 `bridgeTokensForUrl` + getScript grants 过滤）→ 对每个脚本下行 `GM_EVENT{kind:'URL_CHANGE', data:{url}}`。
- `GmEventKind`（`shared/gm-bridge.ts`）加 `'URL_CHANGE'`。

### 5.5 预取扩展 `background/gm-resources.ts`（二进制资源）

- `CacheEntry` 从 `{content, fetchedAt}` 扩为 `{content, fetchedAt, mime?, encoding: 'text' | 'base64'}`。
- `fetchText` 拆分：按响应 `content-type` 判文本/二进制。文本走现有 text 路径（`encoding:'text'`，兼容 `GM_getResourceText`）；二进制读 arrayBuffer → base64（`encoding:'base64'` + mime），单文件上限不变（2MB，base64 前）。
- `getResourceBundle` 产出增 `resourceUrls: Record<string, string>`：文本资源拼 `data:{mime||text/plain};charset=utf-8,{encodeURIComponent(content)}`；二进制拼 `data:{mime};base64,{content}`。`GM_getResourceText` 仍只对 `encoding:'text'` 返回原文（二进制返回 undefined，对齐 TM）。
- 惰性迁移：旧缓存无 `encoding` 字段视为 `'text'`。

## 6. 人工验证脚本（fixtures/userscripts/manual）

沿用现有 `.src`（元头 + 卡片体） + `_panel-core.js` 拼接约定，`npm run build:manual` 产出 `gmt-manual-<module>.user.js`。每张卡 `{id, api, desc, steps, expect}` + 人工「通过/失败 + 备注」标记，交互步骤挂 `actions` 回调。

### 扩现有模块

- `storage.user.js.src`：加 `GM_getValues`/`GM_setValues`/`GM_deleteValues`（批量往返）、`GM_removeValueChangeListener`（注册后移除，验证事件不再触发）卡。补 `@grant`。
- `dom-resource.user.js.src`：加 `GM_addElement`（插入 div/script）、`GM_getResourceURL`（`@resource` 声明一张图片，验证 `<img>` 能加载 data: URL）卡。补 `@resource`/`@grant`。
- `tabs.user.js.src`：加 `GM_saveTab/getTab`（写后读回）、`GM_getTabs`（多 tab 场景）、`window.close`/`window.focus`（特殊 grant）卡。

### 新模块

- `cookie.user.js.src`：`GM_cookie.list/set/delete`，`@connect` 门控实测（首次弹确认卡 → 允许后 list 出 cookie）。
- `download.user.js.src`：`GM_download`，触发一次下载，验证浏览器下载条出现 + onload 回调。
- `urlchange.user.js.src`：`window.onurlchange`，页内 `history.pushState` + hash 改变，验证回调 / `urlchange` 事件收到新 URL。含一张「按钮触发 pushState」交互卡。
- `notify-menu.user.js.src`：`GM_notification` + `GM_closeNotification`/`GM_updateNotification` + `GM_registerMenuCommand`/`GM_unregisterMenuCommand`（注册后注销，验证侧边栏菜单项消失）。

### 门槛验证

新模块加进 `build-manual.mjs` 扫描范围（自动，无需改脚本——它扫 `*.user.js.src`）。构建后 `git` 纳入产物 `.user.js`（与现有产物一致的提交约定）。

## 7. 测试策略

- **wrapper 单测** `tests/shared/gm-wrapper.test.ts`：补新 API 安装断言——本地/快照类生成正确函数体、桥类生成 `__GM_post`、对象型 `GM_cookie` 生成三方法对象、特殊 grant（window.close/focus/onurlchange）按 grant 条件 emit 且未 grant 时不出现。
- **子系统 SW 单测**（fakeBrowser）：
  - `gm-tab-store`：getTab 首次空对象 / saveTab 后读回 / getTabs 聚合 / 脚本删除清理。
  - `gm-cookie`：三方法参数透传、@connect DENY/CONFIRM/ALLOW 分支（复用 matchConnect 测试模式）。
  - `gm-download`：签名归一化、onChanged complete→onload / interrupted→onerror 映射。
  - `gm-urlchange`：导航事件 → 按 grant 过滤 → 下行 URL_CHANGE。
  - `gm-resources`：二进制 content-type 走 base64 路径、getResourceBundle 产 data: URL、旧缓存惰性迁移。
- **批量值广播**：SetValues 多键 → 每个变更键各一次 broadcastValueChange。
- `npm run compile`（TS 检查）+ `npm run test` 全绿为完成门槛。

## 8. 文档

- [docs/gm-api.md](../../gm-api.md)：把本设计落地项从「后续候选」移到对应能力组的「已实现」行，补签名/差异说明；更新 §11 速览计数与 §标题的「实现状态」。
- 新增/变更的 API 计数、权限清单在 `CLAUDE.md` 项目说明追加一段（与既有 Phase 记录同格式）。

## 9. 已知边界与取舍

- **per-tab 存储用 `storage.session`**：SW 重启不丢（session 存储在浏览器进程级），但浏览器关闭清空——符合 GM_getTab 临时语义，不做持久化。
- **download onprogress 首版可缺省**：onChanged 的 bytesReceived 增量下行较噪，首版仅保证 onload/onerror；onprogress 若实现，节流后下行。
- **cookie 门控复用 @connect**：语义上 cookie 域与网络请求域是同一套白名单，用户对某脚本「总是允许 host X」会同时覆盖 XHR 与 cookie——文档需明示这一耦合。
- **urlchange 依赖 webNavigation**：受限页（chrome://、扩展页）无导航事件，与现有受限页豁免一致；iframe 内 SPA 导航不下行（仅主帧）。
- **window.close/focus 作用于脚本所在整个 tab**：非 window 级（MV3 无脚本打开的 window 句柄语义时），对齐 TM 在 top frame 的行为。
- **GM_addElement 在 USER_SCRIPT world**：createElement 走隔离世界 document（与页面共享 DOM，插入可见）；`<script>` 元素注入受页面 CSP 约束（与 TM 行为一致，文档提示）。
