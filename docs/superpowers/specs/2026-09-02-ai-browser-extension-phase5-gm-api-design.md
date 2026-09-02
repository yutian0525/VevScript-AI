# AI Browser Extension 设计文档（Phase 5：GM_* API 支持 + 脚本管理器优化）

> 状态：设计定稿，待实施。前置：Phase 4（脚本池 + 文本为源修订）已完成于 `feature/phase4-script-pool`。
> 本阶段目标：给脚本池补上 GM_* API 集支持（含 API 文档）、脚本错误捕获展示、grant 徽标精确化、菜单命令入口、@require/@resource 支持。
> 调研基础：本地violentmonkey（v2.48.x MV3）与 scriptcat（v1.5.0）源码调研（2026-09-02），关键结论见 §1.2。

## 1. 目标与范围

### 1.1 目标

1. **GM_* API 首批 13 个**：GM_info、GM_getValue、GM_setValue、GM_deleteValue、GM_listValues、GM_addValueChangeListener、GM_addStyle、GM_log、GM_registerMenuCommand、GM_setClipboard、GM_notification、GM_openInTab、GM_xmlhttpRequest。
2. **API 文档**：`docs/gm-api.md`，面向脚本作者（签名/示例/与 TM 差异/未实现清单）。
3. **管理器优化四项**：脚本错误捕获展示、grant 徽标精确化、菜单命令入口（侧边栏）、@require/@resource 支持。

### 1.2 调研结论（影响设计的部分）

**Violentmonkey**：桥接四层链（页面脚本 → GM wrapper 按 @grant 精确生成 → ISOLATED 世界 CustomEvent 双事件桥 → SW 命令分发 → offscreen）；三张 API 表 + `context.async` 实现「下划线同步 / 点形式 Promise」一份实现双形态；值存储「注入时预载 + 写穿透 + UpdatedValues 广播」读零 RPC；@grant 即权限粒度。完整复刻是冰山（表面 ~700 行、配套 ~9k 行 safe-globals/vault/bfcache 加固）——本设计取骨架、砍加固。

**ScriptCat**：三层权限（@grant 静态校验 → 运行时确认弹窗六档授权 + PermissionDAO → @connect 域名校验）；`@GMContext.API` 装饰器 + 中央 Map 按 @grant 精确安装；值广播用 `chrome.storage.local` + `onChanged` 当类 UDP。

### 1.3 brainstorming 已拍板的地基决策

1. **桥接 = ISOLATED world + wrapper（VM 路线）**：脚本注入时前置 wrapper，GM_* 调用经 window 事件桥给同帧 ISOLATED content script，再 `runtime.sendMessage` 到 SW。安全隔离好（页面拿不到 GM_*），world 语义不变。不采用 userScripts 世界直连 SW（messaging:true 方案 MAIN world 隔离差）。
2. **API 范围 = 核心 13 个**：GM_download/GM_cookie/GM_setValues 系列等留待后续。
3. **双形态语义**：下划线形式同步返回（快照读），`GM.*` 点形式返回 Promise——同 TM/VM/SC。
4. **GM_xmlhttpRequest 跨域 = @connect 白名单 + 运行时确认弹窗（SC 路线）**：同域/子域/@connect 命中放行；列了 @connect 不匹配→拒绝；未列→确认卡（允许一次/总是允许/拒绝）。
5. **管理器优化四项全做**：错误捕获、grant 精确化、菜单入口、@require/@resource。
6. **文档 = 面向脚本作者的单文档** `docs/gm-api.md`。
7. **实施 = 一份计划串行**。

## 2. 非目标（YAGNI）

- 不做 GM_download、GM_cookie、GM_setValues/GM_getValues/GM_deleteValues、GM_addElement、GM_getResourceURL、GM_unregisterMenuCommand、GM_removeValueChangeListener、GM_saveTab/GM_getTab/GM_getTabs、CAT_* 全家（后续按需补，注册表加一行即可）。
- 不做 unsafe header 改写（无 DNR session 规则；被 fetch 禁的头忽略并记 warning）。
- 不做流式响应 / stream responseType；响应体 ≤1MB 截断。
- 不做 offscreen document（VM/SC 用于 SW 侧 XHR/DOM/剪贴板；本扩展 SW 用 fetch + navigator.clipboard 已覆盖首批 API 需要）。
- 不做 chrome.contextMenus 右键菜单（菜单入口只在侧边栏）。
- 不做脚本更新检查（@updateURL/@downloadURL 仍仅记录）、@require 版本锁定/SRI/到期重验、file:// 资源。
- 不做 VM 级安全加固：safe-globals 原语快照、vault 握手、closed shadow root 防窃取、bfcache/prerender 处理全部不做。
- 不做 `@exclude`/正则 `@include`（维持 Phase 4 降级）。
- 不新增 AI 工具（仅 `list_scripts` summary 增字段）。

## 3. 架构总览

```
用户脚本（chrome.userScripts.register 注入，world 尊重 @world）
  └─ 前置 wrapper（buildWrappedCode 纯函数拼装）：
       preamble（事件桥客户端、值快照、回调注册表、错误上报）
       var GM_info = {...};  var __values = {...};  var __resources = {...};
       GM 对象按 @grant 精确安装
       [@require 内容逐段前置;]
       new Function 预编译探测（语法错误上报）
       try { 用户代码 } catch (e) { console.error + GM_REPORT_ERROR }
            ↓ 事件桥（确定性 token，防伪造）
ISOLATED content script（entrypoints/content.ts，同帧同页）
  └─ 识别 GM_* 事件 → browser.runtime.sendMessage({type:'GM_API_CALL', ...})
            ↓ 现有 MessageRouter
background/gm-api.ts（SW 侧实现中心）
  ├─ 权限校验：scriptId + grants 对照（@grant 白名单）
  ├─ @connect 校验（仅 GM_xmlhttpRequest）
  ├─ 未匹配 → 确认队列 → 侧边栏批准卡
  └─ 执行：值存储 / tabs / notifications / clipboard / fetch
```

- **注入路径不变**：仍是每脚本一条 `userScripts.register`，`js[0].code` 从裸 `s.code` 变为 `buildWrappedCode(script, deps)` 产物。无 grant / `@grant none` 脚本零开销（不加 wrapper，维持现状）。
- **零同步跨桥 RPC**：所有跨桥调用异步（快照读/本地 DOM/console 同步）。砍掉 VM 方案里最难的「同步事件往返」。
- **GM_addStyle 本地实现**：USER_SCRIPT world 可直接建 DOM，无需 VM 的跨世界往返。

## 4. 数据模型与存储

### 4.1 存储键

| 键 | 内容 | 说明 |
|---|---|---|
| `local:scripts:index` | `UserScript[]`（现有） | meta 投影新增 `connects?: string[]`、`requires?: string[]`、`resources?: Record<name, url>` |
| `local:script-values:<id>` | `Record<string, unknown>` | GM 值存储，脚本独立命名空间 |
| `local:gm:permissions` | `Record<scriptId, { cors: Record<host, 'allow'> }>` | 「总是允许」的跨域授权 |
| `local:gm:resources` | `Record<url, { content: string, fetchedAt: number }>` | @require/@resource 内容缓存 |
| `local:gm:seed` | 随机字符串 | 桥 token 派生种子（安装时生成一次） |

SW 内存（重启丢失、可自重建）：菜单命令表 `Map<scriptId, Map<key, name>>`、错误环形缓冲（每脚本最近 20 条）、待确认 XHR 队列（60s 超时）。

### 4.2 类型增量（`shared/types.ts`）

```ts
// UserScriptMeta 追加
connects?: string[];                      // @connect 域名白名单
requires?: string[];                      // @require URL 列表
resources?: Record<string, string>;       // @resource name → url

// ScriptSummary 追加
errorCount: number;                       // SW 错误缓冲条数（0 = 无）
hasRequires: boolean;                     // 有 @require（资源缺失时详情页提示）
```

上限：资源总量 ≤10MB（`storage/scripts.ts` 校验，超限保存报错）；单文件 ≤2MB。

## 5. wrapper 生成（`shared/gm-wrapper.ts`，纯函数）

`buildWrappedCode(script, deps) → string`，注册时拼装，替代裸 `s.code`：

```
[runtime preamble ~150 行]      // 事件桥客户端、值快照、回调注册表、错误上报
var GM_info = {...};            // 构建期 JSON 直嵌
var __values = {...};           // 注入时值快照直嵌（GM_getValue 零 RPC）
var __resources = {...};        // @resource 内容直嵌
GM 对象按 @grant 精确安装        // 未 grant 的 API 不存在（VM/SC 同款语义）
[@require 内容逐段前置;]
try { new Function(用户代码) 预编译探测 }  // 语法错误上报（只编译不执行）
try { 用户代码 } catch (e) { console.error('[脚本名]', e) + GM_REPORT_ERROR }
```

- 无 grant / `@grant none` 脚本不加 wrapper——维持现状零开销。
- `@grant unsafeWindow`：MAIN world 下 = `window`；USER_SCRIPT world 下 = 隔离世界 window（VM Chrome 同款限制），文档明示「要真页面 window 请 `@world MAIN`」。
- preamble 每脚本内联（不做共享 lib 注册——跨 world 共享全局不可靠）。~150 行 × 20 脚本量级无压力。
- 语法错误盲区处理：wrapper 对用户代码先 `new Function(code)` 预编译探测（不执行），编译错误即上报——只探测编译，不改变执行语义（探测通过后仍以拼接形式原样执行）。

## 6. 事件桥协议（page ↔ ISOLATED content script，`shared/gm-bridge.ts` 定义类型）

- **请求**：wrapper 在 `window` 派发 CustomEvent `gmreq:<scriptId>`，detail = `{ token, reqId, api, params }`；content script 监听并转发 `runtime.sendMessage({ type: 'GM_API_CALL', scriptId, api, reqId, params })`。
- **响应**：SW sendResponse → content script 派发 `gmres:<scriptId>`（detail 带 reqId）→ wrapper pending map 命中回调。
- **下行推送**（值变更/菜单点击/通知点击/tab 关闭）：SW 经 `tabs.sendMessage` 发 `GM_EVENT { scriptId, kind, payload }` → content script 派发 `gmevt:<scriptId>` → wrapper 分发本地回调。kind ∈ `VALUE_CHANGE | MENU_CLICK | NOTIF_CLICK | TAB_EVENT`。
- **防伪造**：token = `hash(seed + scriptId)`，seed 只存 SW/storage，永不出现在页面 JS 可见处（wrapper 闭包持有）。页面可猜事件名但猜不中 token。content script 启动/URL 变化时向 SW 请求当前 URL 的 `[{scriptId, token}]`（SW 用现有 `matchUrl` 计算——复用运行集逻辑）。**token 确定性派生 → SW 重启不换 token → 已开页面的桥不断**（MV3 SW 随时会死，这是不用随机数的原因）。
- 降级声明：token 防伪 ≠ VM 级（不防同页其它扩展 listener 枚举；仍需猜 token）。与 Phase 3b postMessage 已知降级同级。

## 7. GM API 注册表（`shared/gm-apis.ts`）

单张声明表 `Record<grantName, { impl: 'snapshot' | 'local' | 'bridge', promiseForm: boolean }>`，同时驱动三件事：wrapper 按 grant 安装、`classifyGrants()`（徽标精确化）、`docs/gm-api.md` 文档目录。新增 API = 表里加一行 + 实现一处。

`classifyGrants(grants, registry) → { supported: string[], unsupported: string[] }`（纯函数）。

## 8. GM API 语义表（首批 13 个）

| API | 下划线形式 | 点形式 | 实现 |
|---|---|---|---|
| `GM_info` | 只读对象 | `GM.info`（同引用） | wrapper 构建期直嵌：`{ scriptHandler: 'ai-browser-extend', version, script: {name, version, description, matches, grants}, injectInto: world }` |
| `GM_getValue(key, def)` | 同步返回快照 | Promise | 快照直嵌 + `GM_setValue` 后本地即时更新 |
| `GM_setValue(key, val)` | void | Promise | 本地改 + 桥 `SetValue` → SW 落库 + 广播其它 tab |
| `GM_deleteValue(key)` | void | Promise | 同上 |
| `GM_listValues()` | 同步返回 key[] | Promise | 快照派生 |
| `GM_addValueChangeListener(key, fn)` | 返回 listenerId | Promise | 本地注册；SW 广播 `VALUE_CHANGE` 下行触发（remote=true）；本地写同 tab 触发 remote=false |
| `GM_addStyle(css)` | 同步返回 `<style>` 元素 | Promise | **本地实现**：当前 world 直接 `document.createElement('style')` 并 append 到 head |
| `GM_log(...args)` | void（console.log） | 同 | 本地 console；格式 `[脚本名] args` |
| `GM_registerMenuCommand(name, fn)` | 返回 key | Promise | 桥 `RegisterMenu` → SW 菜单表 → 侧边栏脚本页「菜单命令」区；点击走 `MENU_CLICK` 下行 |
| `GM_setClipboard(text)` | void | Promise | 桥 → SW `navigator.clipboard.writeText`（MV3 SW 可用；无手势链时可能失败，返回可读错误） |
| `GM_notification(details, ondone)` | void | Promise | 桥 → SW `chrome.notifications`；点击/关闭经 `NOTIF_CLICK` 下行触发回调 |
| `GM_openInTab(url, opts)` | 返回 `{close(), onclose, closed}` | Promise | 桥 → SW `tabs.create({active: !opts.active})`；句柄经 `TAB_EVENT` 下行维护 `closed` |
| `GM_xmlhttpRequest(details)` | 返回 `{abort}` | Promise | 桥 → SW `fetch`；`onload/onerror/ontimeout` 事件化回传（一次性桥，非流式，响应体 ≤1MB 截断） |

### 8.1 GM_xmlhttpRequest 跨域确认流

```
SW: 校验 grants → @connect 匹配？
  ├─ self/子域/@connect 命中 → 直接 fetch
  ├─ 列了 @connect 但不命中 → 拒绝（错误文本提示补 @connect）   // SC 同款
  ├─ 未列 @connect：
  │    ├─ permissions[scriptId].cors[host] === 'allow' → fetch
  │    └─ 入确认队列 → 广播 GM_CONFIRM_PENDING → 侧边栏批准卡
  │         「允许一次」→ fetch；「总是允许」→ 写 local:gm:permissions + fetch
  │         「拒绝」→ onerror('permission denied')；队列 60s 超时同拒绝
  └─ 响应经桥回传（status/headers 白名单/body/finalUrl）
```

- self 判定：请求 URL host === 发起页面（sender tab）host；子域 = `*.host` 后缀匹配。@connect 值匹配：精确 host、`*`（任何域，含子域通配 `*.example.com`）。
- unsafe header：`user-agent`/`referer`/`cookie` 等被 fetch 禁的头忽略并记 warning（无 DNR，与 TM/VM 差异明示）。
- 响应头白名单沿用 `http_request` 工具的 `HEADER_ALLOW` 子集。

### 8.2 与 TM/VM/SC 的已知差异（docs/gm-api.md 如实记录）

- 无 unsafe header 改写（无 DNR）；响应非流式、≤1MB；无 stream responseType。
- GM_download/GM_cookie/GM_setValues 系列/GM_addElement/GM_getResourceURL 未实现——调用即 undefined（未 grant 的 API 不存在语义），文档列替代方案（如 GM_xmlhttpRequest 手动处理）。
- `GM_getResourceText` 仅对 `@resource` 文本资源有效（本阶段随 @resource 支持一并提供；不在首批 13 个内则记为未实现）。
- unsafeWindow 在 USER_SCRIPT world 下是隔离世界 window。

## 9. 管理器优化

### 9.1 脚本错误捕获展示

- wrapper try/catch 捕获顶层运行时异常；`new Function` 预编译探测捕获语法错误。
- catch 分支：本地 `console.error('[脚本名]', e)` + 桥上报 `ReportError { scriptId, message, stack, url, line }`。
- SW 环形缓冲（每脚本 ≤20 条：时间戳/message/行号），新错误广播 `SCRIPTS_ERROR`。
- UI：列表页脚本行红色徽标 `N errors`；详情页「运行错误」折叠区（时间 + message + 行号 + 清空按钮）。store 加 `errors: Record<scriptId, ErrorEntry[]>`。
- `list_scripts` summary 增 `errorCount`——模型可据此主动排查。

### 9.2 grant 徽标精确化

- `classifyGrants(grants, registry)`：列表页徽标改为「`@grant GM_getValue ×3 可用 · GM_download ×1 不支持`」（unsupported 黄色警示、supported 中性）；详情页解析面板列全量 grant 逐条标注。
- 解析器：`@connect`/`@require`/`@resource` 从「忽略的未知键」升级为解析进 meta（§4.2）；原「@grant 非 none → 不支持 GM_*」警告改为按注册表判定（有 unsupported grant 才警示）。

### 9.3 菜单命令入口

- SW 菜单表（内存）+ `SCRIPTS_MENUS` 广播；侧边栏脚本页顶部「菜单命令」区（仿「当前页运行中」交互）：活动 tab 匹配脚本注册的命令显示为按钮，点击 `SCRIPTS_MENU_INVOKE { scriptId, key }` → SW 路由 `MENU_CLICK` 下行 → wrapper 回调。
- 不做 chrome.contextMenus（交互都在面板；省一个权限；VM 三级结构维护成本高，YAGNI）。
- SW 重启菜单表丢失：页面 reload 后 wrapper 重跑、脚本重注册自愈；未 reload 前菜单区显示空态。

### 9.4 @require / @resource

- 创建/更新时**同步预取**（不做到期重验）：`buildFromText` 后 `prefetchResources(script)`——遍历 requires/resources 逐个 fetch（30s 超时、单文件 ≤2MB、总量 ≤10MB），存 `local:gm:resources`；已有缓存（fetchedAt < 7 天）跳过。
- 失败 = 保存成功但 warning「依赖下载失败：url（原因）」，注入时缺哪段跳哪段（不阻塞主体）。
- wrapper 拼装时从缓存读取直嵌代码头部；`toRegisterDetails` 无变化（仍拿拼好的 code）。
- 降级：无版本锁定（每次 update 重拉）、无 SRI、file:// 不支持。

## 10. 消息协议（`shared/messages.ts` 追加）

```ts
// page 桥 → content → SW（经现有 router；content 转发时带 sender.tab）
GM_API_CALL        { scriptId, api, reqId, params }
// SW → content → page（下行，经 tabs.sendMessage）
GM_EVENT           { scriptId, kind, payload }   // VALUE_CHANGE | MENU_CLICK | NOTIF_CLICK | TAB_EVENT
// content script → SW（桥宿主初始化）
GM_BRIDGE_TOKENS   { url } → { entries: Array<{ scriptId, token }> }

// 侧边栏 ↔ SW（request/response）
SCRIPTS_MENU_INVOKE  { scriptId, key }
SCRIPTS_CLEAR_ERRORS { scriptId }
GM_CONFIRM_RESOLVE   { confirmId, decision }   // 'allow-once' | 'always' | 'deny'

// 广播（SW → 侧边栏）
SCRIPTS_ERROR        { scriptId, error }
SCRIPTS_MENUS        { entries }               // 菜单表快照
GM_CONFIRM_PENDING   { confirm }               // 确认卡数据
```

## 11. UI（沿用设计系统 tokens；图标一律 lucide-react）

- **ScriptsListView**：顶部新增「菜单命令」区（当前活动 tab 匹配脚本的命令按钮）；脚本行错误徽标（红）；grant 徽标精确化；批准卡区（`ScriptsConfirmCard`，置于引擎警示条下方，三条决策路径：允许一次/总是允许/拒绝 + 60s 倒计时）。
- **ScriptDetailView**：解析面板 grant 列表逐条标注可用性；「运行错误」折叠区。
- **stores/scripts.ts**：+`errors`、`menus`、`confirm` 状态与对应广播订阅。
- **wxt.config.ts**：permissions 追加 `notifications`、`clipboardWrite`。

## 12. 测试策略（vitest + jsdom，沿用现有惯例）

| 层 | 用例 |
|---|---|
| `gm-apis.ts` | 表完整性（每个注册 API 有 impl 分支）；classifyGrants 对 13 API + 未知 grant 的分类 |
| `gm-wrapper.ts` | 拼装产物含 preamble/GM_info/快照/require 段；grant 安装精确性；`@grant none` 不含 wrapper；用户代码在 require 之后；预编译探测语法错误路径 |
| `userscript-meta.ts` | @connect/@require/@resource 解析进 meta；多条去重；grant 警告按注册表判定 |
| 桥协议（jsdom 三界模拟） | 请求→响应回路（reqId 匹配）；下行事件分发；token 校验拒绝伪造 detail |
| `background/gm-api.ts` | 值读写落库 + 广播 payload；菜单注册/点击路由；@connect 三分支 + 确认流（allow-once/always/deny/超时）；错误上报入环形缓冲；资源预取成功/失败/超限 |
| `gm-permissions.ts` | always 授权读写、按 host 匹配 |
| UI（jsdom） | 菜单区随 SCRIPTS_MENUS 更新与点击；错误徽标/详情错误区；批准卡三按钮；grant 徽标分类渲染 |
| 工具 | `list_scripts` summary 含 errorCount/hasRequires |

jsdom 盲区（手测清单）：真实 `userScripts.register` 的 wrapper 执行、跨 world 事件桥实际通断、`chrome.notifications` 真通知、SW clipboard 写入、MAIN world 脚本的 unsafeWindow。

## 13. 文件改动

### 新建

| 文件 | 职责 | 可单测 |
|---|---|---|
| `shared/gm-apis.ts` | API 注册表 + classifyGrants（纯函数） | ✅ |
| `shared/gm-wrapper.ts` | wrapper preamble + buildWrappedCode（纯函数字符串拼装） | ✅ |
| `shared/gm-bridge.ts` | 桥协议常量与 payload 类型（三界共用） | 类型级 |
| `background/gm-api.ts` | SW 侧实现中心：GM_API_CALL 分发、值存储、菜单表、错误缓冲、@connect 校验、确认队列 | ✅ mock |
| `background/gm-permissions.ts` | always 授权读写（storage 薄封装） | ✅ |
| `content/gm-bridge-host.ts` | ISOLATED 侧桥宿主：token 获取、事件转发、下行分发 | ✅ jsdom |
| `docs/gm-api.md` | 脚本作者 API 参考 | — |
| `components/scripts/ScriptsConfirmCard.tsx` | 批准卡组件 | ✅ jsdom |

### 修改

| 文件 | 改动 |
|---|---|
| `shared/userscript-meta.ts` | @connect/@require/@resource 解析进 meta；grant 警告改按注册表判定 |
| `shared/types.ts` | UserScriptMeta + connects/requires/resources；ScriptSummary + errorCount/hasRequires |
| `storage/scripts.ts` | 资源总量 ≤10MB 校验 |
| `background/scripts.ts` | toRegisterDetails 走 buildWrappedCode；CRUD 后 prefetchResources；启停/删除时清理菜单表/错误缓冲 |
| `entrypoints/content.ts` | main() 挂 initBridgeHost |
| `shared/messages.ts` | +§10 消息类型 |
| `stores/scripts.ts` | +errors/menus/confirm 状态与广播订阅 |
| `components/scripts/ScriptsListView.tsx` | 菜单命令区、错误徽标、grant 徽标精确化、批准卡挂载 |
| `components/scripts/ScriptDetailView.tsx` | 错误折叠区、grant 可用性列表 |
| `agent/tools/schemas.ts` | list_scripts 描述 + errorCount/hasRequires 说明 |
| `wxt.config.ts` | permissions + notifications、clipboardWrite |
| `CLAUDE.md` | Phase 5 记录 |

## 14. 边界与已知降级

- token 防伪 ≠ VM 级（不防同页其它扩展 listener；需猜 token）——与 Phase 3b postMessage 降级同级。
- 无 unsafe header 改写、非流式 ≤1MB、无 stream responseType。
- @require 无版本锁定/SRI/到期重验；file:// 不支持。
- 确认卡依赖侧边栏打开——关闭时 60s 超时拒绝（文案引导用户打开侧边栏）。
- SW 重启：菜单表/错误缓冲/确认队列丢失（菜单靠页面 reload 重注册自愈；确认与错误静默丢弃）。
- MV3 SW clipboard 无用户手势链时 writeText 可能失败，返回可读错误。
- 值快照在注入时直嵌：注入后其它 tab 写入经广播更新本地快照；页面休眠/事件桥断开期间快照可能滞后（写穿透 SW 落库不丢，读旧值）。
- 管理器优化不含更新检查/云同步/回收站（SC 的差异化功能，后续按需）。

## 15. 给后续阶段的接口契约（本阶段冻结）

- `shared/gm-apis.ts` 注册表是 GM API 的唯一入口：后续补 API = 加一行 + 实现一处，wrapper/徽标/文档自动跟随。
- 桥协议（§6）三消息形状冻结；后续 API 复用同一桥。
- `local:gm:permissions` 形状冻结，后续确认门控（agent confirmGate）可复用批准卡交互。
- 工具计数 22 不动（本阶段无新 AI 工具，summary 增字段不改名）。

## 16. 分支

Phase 5 在 `feature/phase4-script-pool` worktree 同分支续作（GM 支持是脚本池的自然延伸，该分支未合回 main）。
