# GM 运行环境全功能自检用户脚本（gmt-selftest）设计

> 日期：2026-09-04 · 分支：feat/add-skills
> 前置：Phase 4（脚本池）+ Phase 5（GM_* API）+ Phase 5 修订（文本为源）已完成。

## 1. 背景与目标

本扩展的脚本池 + GM API 运行环境（解析器 / wrapper / 事件桥 / SW 中心）已有单元测试覆盖，但缺少一条**端到端真实链路**验证：`chrome.userScripts` 真实注入、token 握手、bridge 三事件回环、SW 落库广播、CDN 预取等，均只能在真实浏览器里证明。

目标：写**一个**用户脚本 `gmt-selftest.user.js`，注入任意 http(s) 页面后自动运行全部可自动化检查，在页面上渲染结果面板；需要人工参与的项（菜单点击、通知点击、错误徽标）单独分组并给操作指引。

**非目标**：

- 不测 `@world MAIN` 注入形态（脚本自身即 USER_SCRIPT world，无法自证另一 world；MAIN 变体脚本留待后续可选）。
- 不测 @connect 确认卡分支（本脚本 @connect 非空 → 未列 host 直接走 DENY，CONFIRM 分支在 `matchConnect` 语义下不可达；替代法见 §8）。
- 不替换单元测试；fixture 单测（§7）只是把本脚本复用为解析器的真实全字段用例。

## 2. 交付物

| # | 文件 | 说明 |
|---|---|---|
| 1 | `fixtures/userscripts/gmt-selftest.user.js` | 自检脚本本体（完整 .user.js 文本，可直接经脚本池「导入」或 `create_script` 装入） |
| 2 | `tests/shared/gmt-selftest-fixture.test.ts` | fixture 完整性单测：读入脚本文件 → `parseUserScript` 全字段断言 + `buildWrappedCode` 安装面断言 |
| 3 | 本 spec | 设计文档 + 使用说明（§9） |

## 3. 脚本元数据头设计

头部本身就是**元字段解析的全字段 fixture**——除 `@world`（MAIN 留后续）与正则 `@include`（属解析容错路径，单测已覆盖）外，解析器支持的键全部用到：

```text
// ==UserScript==
// @name         GM 运行环境全功能自检
// @namespace    ai-browser-extend/gmt-selftest
// @version      1.0.0
// @author       gmt-selftest
// @description  本扩展脚本池运行环境全功能自检：元字段解析自证 + 14 个 GM API 可用性
// @homepage     https://example.com/gmt-selftest
// @supportURL   https://example.com/gmt-selftest/support
// @iconURL      https://example.com/favicon.ico
// @downloadURL  https://example.com/gmt-selftest.user.js
// @updateURL    https://example.com/gmt-selftest.meta.js
// @match        *://*/*
// @run-at       document-end
// @grant        GM_info
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_addValueChangeListener
// @grant        GM_addStyle
// @grant        GM_getResourceText
// @grant        GM_log
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @grant        GM_notification
// @grant        GM_openInTab
// @grant        GM_xmlhttpRequest
// @connect      cdn.jsdelivr.net
// @require      https://cdn.jsdelivr.net/npm/zepto@1.2.0/dist/zepto.min.js
// @resource     gmtPkg https://cdn.jsdelivr.net/npm/zepto@1.2.0/package.json
// @noframes
// ==/UserScript==
```

各键意图：

- `@match *://*/*`：任意 http(s) 页可跑；探针页（§6.1）天然命中。副作用是全站出现面板——不用时在脚本池禁用（使用说明写明）。
- `@run-at document-end`：走「非默认 runAt」解析路径（fixture 断言 `runAt==='document_end'`）；脚本体内仍防御性等待 `document.body`。
- 15 个 `@grant`（14 API + `unsafeWindow`）：全部命中注册表 → 解析零 warning；同时作为「按 grant 精确安装」的正向用例（未 grant 的 API 断言不存在，见 §4 组 2）。
- `@connect cdn.jsdelivr.net`：GM_xmlhttpRequest 的命中/DENY 两分支（§4 组 8）。
- `@require`：zepto@1.2.0 min（约 26KB，纯浏览器全局、无 UMD 副作用），断言 `typeof Zepto !== 'undefined'`——require 与用户代码共享同一 Function 作用域，var 变量直接可见。若 jsDelivr 不可达可换 unpkg 同路径，断言不变。
- `@resource gmtPkg`：同包 package.json（约 1.4KB），断言 `GM_getResourceText` 返回含 `"name"` 的非空文本。
- `@noframes`：防 iframe 重复面板；解析器已支持（`meta.noframes`）。注入引擎若未落实该键，表现为多面板——本身就是观测点。

## 4. 测试项清单

状态图例：**A**=全自动 · **A+M**=自动断言 + 人工动作后自动翻转 · 结果三态：通过（SVG 勾）/ 失败（SVG 叉，附错误详情）/ 待人工（SVG 时钟 + 指引）。

### 组 1 元字段解析自证（8 项 A）

经 `GM_info` 自证（脚本运行即证明解析+注入成功，字段逐项比对）：

1. `GM_info.scriptHandler === 'ai-browser-extend'`
2. `typeof GM_info.version === 'string'` 且非空
3. `GM_info.script.name === 'GM 运行环境全功能自检'`
4. `GM_info.script.version === '1.0.0'`，`namespace`、`description` 非空
5. `GM_info.script.matches` 含 `'*://*/*'`
6. `GM_info.script.grants` 共 15 项且含全部 14 个 API 名 + `unsafeWindow`
7. `GM_info.injectInto === 'UserScript'`（@world 默认解析自证）
8. `GM.info === GM_info`（同引用，非 Promise）

### 组 2 环境与 grant 语义（5 项 A）

1. `typeof GM === 'object'`
2. `typeof GM.getValue === 'function'`（点形式已装）
3. **未 grant 的 API 不存在**：`typeof GM_getTab === 'undefined'` 且 `GM.getTab === undefined`（「声明即授权」语义）
4. `unsafeWindow` 为对象且 `unsafeWindow.document === document`
5. `@require` 已执行：`typeof Zepto !== 'undefined'`

### 组 3 值存储（8 项 A）

测试键统一前缀 `__gmt_`；运行开始先 `GM_listValues()` + 逐个 `GM_deleteValue` 清残留（幂等，可反复重跑）。

1. 运行前清理完成（清后快照无 `__gmt_` 键）
2. `GM_setValue('k1','v1')` → `GM_getValue('k1') === 'v1'`（同步返回，非 Promise）
3. 对象值往返：`{obj:true}` 存取相等
4. `GM_getValue('missing','def') === 'def'`（默认值分支）
5. `GM_getValue('never-set') === undefined`
6. `GM_listValues()` 含 k1/k3
7. `GM_deleteValue('k2')` → `getValue` undefined 且 list 不含
8. 点形式 `GM.getValue('k1')` 返回 Promise 且 resolve `'v1'`

### 组 4 值变更监听（3 项）

1. **A** `GM_addValueChangeListener` 返回字符串 id（形如 `key:index`）
2. **A** 本地事件：`GM_setValue('k3','x')` 后收到 `remote===false`、oldValue/newValue 正确
3. **A** 跨 tab 事件（remote=true）：探针页写入 `__gmt_remote_probe` 后 10s 内收到（§6.1）；超时标黄并提示「探针页可能未及注入即被关闭」

### 组 5 DOM / 资源 / 日志（4 项 A）

1. `GM_addStyle` 返回已连接（`isConnected`）的 `<style>` 元素
2. 样式真实生效：注入 `.gmt-styleprobe{position:absolute}` 后创建探针 div，`getComputedStyle().position === 'absolute'`（真实消费场景；页面 CSP 可能拦截——失败即真实发现，建议在无严格 CSP 页面如 example.com 跑）
3. `GM_getResourceText('gmtPkg')` 非空且含 `'"name"'`
4. `GM_log('...')` 不抛异常（console 出现 `[GM 运行环境全功能自检]` 前缀行——人工可查，不阻断）

### 组 6 剪贴板 / 通知 / 菜单（5 项）

1. **A** `GM.setClipboard('gmt clipboard probe')` Promise resolve（MV3 SW 无手势链可能被拒——失败标黄并附可读错误，属已知降级非缺陷）
2. **A** `GM_notification({title,text}, cb)` 调用不抛
3. **A+M** 通知点击/关闭 → `ondone` 回调触发后行自动翻转（人工：点掉通知）
4. **A** `GM_registerMenuCommand('GMT 自检：点我', fn)` 返回非空字符串 key
5. **A+M** 菜单命令点击回环：侧边栏脚本页「菜单命令」区点击 → 回调执行 → 行自动翻转

### 组 7 标签页（2 项 A）

1. `GM_openInTab('https://example.com/?__gmt_probe=1', {active:false})` 返回句柄（`closed:false`、`close` 为函数）
2. 句柄 `close()` 后 `closed === true` 且 `onclose` 触发（SW onRemoved → TAB_EVENT 下行 → wrapper 更新句柄，全自动闭环；探针页等跨 tab 事件收到后即关，10s 兜底）

### 组 8 网络（3 项 A）

1. `@connect` 命中：`GM_xmlhttpRequest` GET `https://cdn.jsdelivr.net/npm/zepto@1.2.0/package.json` → status 200、body 非空、headers 有 content-type、`finalUrl` 非空
2. droppedHeaders：带 `{ 'user-agent': 'gmt', 'x-gmt': '1' }` 请求同 URL → `droppedHeaders` 含 `'user-agent'` 且请求成功（禁头忽略语义）
3. `@connect` 拒绝：GET 未列 host（如 `https://example.org/`）→ ok=false 且 error 含 `@connect`（「列了不中→DENY」分支，无网络 I/O）

### 组 9 人工引导（1 项 A+M）

1. 错误上报链路：面板「测试错误上报」按钮 → `throw new Error('GMT 测试错误')` → wrapper 捕获 → `ReportError` → SW 环形缓冲 → 侧边栏脚本页徽标 +1（人工：去侧边栏确认错误列表出现该条并含 stack）

合计：约 36 行（32 自动 + 4 人工动作翻转）。

## 5. 面板设计

- 容器：`document.body` 下固定定位卡片（右下角，`z-index: 2147483647`，宽约 320px，`max-height` 60vh 内部滚动），id `gmt-panel`；创建前先移除已存在的同 id 节点（防重复）。
- 样式：**全部经 `GM_addStyle` 注入**（id `gmt-style`）——把 GM_addStyle 的真实消费场景兼做测试对象；选择器一律 `#gmt-panel` / `.gmt-*` 前缀防污染页面。配色中性（白底黑字 13px 系统字体），不引 emoji：状态图标用内联 SVG path（勾/叉/时钟）。
- 结构：头部（标题 + 版本 + 汇总徽标 `N 过 / N 挂 / N 待人工` + 折叠钮 + 重跑钮）→ 测试行列表（组标题分节；行 = SVG 图标 + 名称，失败行展开错误详情）→ 存储区（运行后的 `__gmt_` 键值列表，直观展示跨刷新持久化）。
- 按钮：**重跑** = `location.reload()`（值快照是注入时直嵌，reload 即全新快照，语义最诚实）；**测试错误上报**（§4 组 9）。
- 人工行：状态待人工 + 指引文字 + 「标记通过」小钮（本地翻绿，不入存储）。
- 无动画（无 reduced-motion 诉求）；不使用 Shadow DOM——样式穿透要求面板样式可被 `GM_addStyle`（页面 DOM 层）真实作用。

## 6. 关键机制

### 6.1 探针页防递归

`GM_openInTab` 开的 example.com 页会再次命中 `@match` 而注入第二实例。第二实例启动时检测 `location.search` 含 `__gmt_probe` → **休眠模式**：仅 `GM_setValue('__gmt_remote_probe', …)`（为第一实例提供 remote=true 事件）后不建面板、不跑测试、不清理。第一实例监听该键，收到事件即验证跨 tab 广播，随后立刻 `close()` 探针页（10s 兜底强制关）。

### 6.2 异步与等待原语

- runner 按组顺序 `await` 执行；异步等待统一 `waitFor(cond, timeoutMs, pollMs=100)`。
- 组 4.2/4.3 的事件断言：先挂 listener → 触发动作 → waitFor 事件标志位。
- 行状态先亮「pending」，测试函数 settle 后翻绿/翻黄/翻红，`A+M` 行等待回调翻转（无超时降级为待人工）。

### 6.3 存储边界

- 写入键一律 `__gmt_` 前缀；运行开始清残留，结束后保留（面板存储区可见、供跨刷新对比）。
- 不清理非前缀键；不触碰页面数据。

## 7. fixture 完整性单测（tests/shared/gmt-selftest-fixture.test.ts）

Node 环境（vitest）`fs.readFileSync` 读脚本文件，断言：

1. **解析面**：`parseUserScript(text)` → name/version/namespace/author/description/homepage/supportURL/iconURL/downloadURL/updateURL 全命中；`matches === ['*://*/*']`；`runAt === 'document_end'`；`world === 'USER_SCRIPT'`；`meta.grants` 15 项；`meta.connects === ['cdn.jsdelivr.net']`；`meta.requires` 1 项（zepto min）；`meta.resources.gmtPkg` 指向 package.json；`meta.noframes === true`；`warnings.length === 0`。
2. **wrapper 安装面**：`buildWrappedCode(fields, deps)` 产物含全部 14 个 `GM_xxx` 的 install 行与对应点形式行、`unsafeWindow` 形参、require 代码前置（deps.requireCodes 注入后出现在用户代码之前）、值快照/资源快照占位替换生效。
3. **体量**：text ≤ 280KB（与存储上限对齐的护栏）。

## 8. 已知边界与降级

| 边界 | 说明 | 处置 |
|---|---|---|
| 页面 CSP | 严格 CSP 页面可能拦 `GM_addStyle` 的内联 `<style>`，组 5.2 失败 | 属真实发现；建议在 example.com 等无严格 CSP 页面跑 |
| SW 剪贴板手势 | MV3 SW `clipboard.writeText` 无手势链可能被拒 | 失败标黄并附错误文本，非缺陷（docs/gm-api.md 已声明） |
| @connect 确认卡 | 本脚本 @connect 非空 → 未列 host 直接 DENY，CONFIRM 分支不可达 | 不覆盖；替代法：复制本脚本删掉 `@connect` 行即可触发确认卡（self 分支仍放行同 host） |
| 探针页时序 | 探针页 10s 内未完成注入 → 跨 tab 事件收不到 | 行标黄给提示；探针页仍会被关掉 |
| jsDelivr 可达性 | 部分网络环境 jsDelivr 受限 | @require/@resource/组 8 三行标黄；可换 unpkg 同路径 |
| MAIN world | 单脚本无法自证另一 world | 明确不在范围；后续可加 `@world MAIN` 变体脚本 |
| 全站注入副作用 | `@match *://*/*` 使面板出现在所有页面 | 使用完在脚本池禁用即可 |

## 9. 使用说明（随交付物给用户）

1. `npm run dev` 后在扩展侧边栏 → 脚本池 → 导入 `fixtures/userscripts/gmt-selftest.user.js`（或拖入文本创建）。
2. 打开任意普通网页（推荐 `https://example.com`，DOM 干净、无严格 CSP），右下角出现「GM 运行环境自检」面板，自动开始跑。
3. 绿行 = 通过；黄行 = 待人工或环境受限（面板内有指引）；红行 = 真实缺陷，点行看详情。
4. 三个动作：侧边栏脚本页点「GMT 自检：点我」菜单命令、点掉系统通知、点面板「测试错误上报」后到侧边栏脚本页看错误徽标。
5. 「重跑」按钮 = 刷新页面；不用时在脚本池把该脚本停用。

## 10. 验收标准

1. `npm run compile` 通过；`npm run test` 通过（含新 fixture 单测）。
2. 手动冒烟（example.com）：组 1–3、5、7、8 全绿；组 4.3/6 随人工动作翻转。
3. 侧边栏联动：菜单命令区出现该脚本条目、错误徽标随按钮 +1、确认区无本脚本残留。
