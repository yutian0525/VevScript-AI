# GM API 人工测试脚本族（gmt-manual-*）设计

> 日期：2026-09-04 · 分支：feat/add-skills
> 前置：Phase 5（GM_* API）+ gmt-selftest 自动自检脚本（`fixtures/userscripts/gmt-selftest.user.js`）已完成。
> 定位区分：**gmt-selftest 回答「引擎链路通不通」（自动断言）**；本脚本族回答「每个 API 用起来对不对」（人工主断言，脚本只提供说明、步骤与记录）。

## 1. 背景与目标

gmt-selftest 端到端冒烟抓出 5 个引擎缺陷（CSP 禁 eval、通知 data: URI、CloseTab undefined、sender.url 缺失、wrapper 错误钩子缺口），证明自动化覆盖不了「人眼看到的现象是否正确」：通知文案可读、剪贴板真粘上了、样式真生效、确认卡交互顺畅。本设计补一套**人工测试脚本族**：一个 GM 模块一个脚本，每张卡片给出 API 签名、语义说明、测试步骤与期望结果，人工操作后标记通过/失败，结果持久化。

**非目标**：

- 不做自动断言（gmt-selftest 已覆盖链路层）；
- 不覆盖「后续候选」API（清单见 `docs/gm-api.md`，只测已实现的 14 个 + unsafeWindow）；
- 不改引擎/侧边栏代码——纯脚本族交付。

## 2. 交付物与目录结构

```text
fixtures/userscripts/manual/
  _panel-core.js            面板内核源（卡片渲染 / GM 存储读写 / 汇总计数；非 .user.js，不导入脚本池）
  storage.user.js.src       模块 1 信息与值存储（7 卡）
  dom-resource.user.js.src  模块 2 DOM/资源/日志（5 卡）
  interaction.user.js.src   模块 3 菜单/通知/剪贴板（4 卡）
  tabs.user.js.src          模块 4 标签页（2 卡）
  network.user.js.src       模块 5 网络（4 卡）
scripts/build-manual.mjs    拼接脚本：_panel-core.js + <模块>.src + 元头 → gmt-manual-<模块>.user.js
tests/shared/gmt-manual-fixtures.test.ts  五产物 fixture 单测
```

产物命名 `gmt-manual-storage.user.js` 等，直接导入脚本池使用。源文件用 `.user.js.src` 后缀避免被误导入（拼接时剥壳）。

## 3. 元头设计

五脚本公共骨架（各模块只 grant 自己卡片用到的 API）：

```text
// ==UserScript==
// @name         GM 手测·值存储
// @namespace    ai-browser-extend/gmt-manual
// @version      1.0.0
// @description  GM 值存储模块人工测试：说明 + 步骤 + 人工标记
// @match        *://*/*
// @run-at       document-end
// @grant        GM_info
// @grant        GM_getValue
// ...（按模块裁剪）
// @noframes
// ==/UserScript==
```

- `@match *://*/*`：任意页可测（与 gmt-selftest 同理由）；用完在脚本池停用。
- 模块 5 额外 `@connect cdn.jsdelivr.net`（命中分支目标）；确认卡分支靠「一键复制无 @connect 版本文」引导另导临时脚本，不在本脚本头里预埋。
- `@require`/`@resource` 不进本脚本族——资源读取的验证归 gmt-selftest（模块 2 卡片只测 `GM_getResourceText` 的空值与错误语义，不依赖真实预取）。各脚本 grants 即模块卡片 API 的并集，fixture 单测逐一断言。

## 4. 面板内核（_panel-core.js）

纯 ES5 风格 IIFE，注入面板（复用 gmt-selftest 的视觉骨架：右下角固定卡、`#gmt-panel` id、`GM_addStyle` 注入样式、内联 SVG 图标、z-index 2147483647）。内核 API：

```js
GMTManual.render({
  module: 'storage',            // 模块键（存储命名空间的一部分）
  title: 'GM 手测·值存储',
  cards: [ { id, api, desc, steps, expect }, ... ],   // 纯数据卡片定义
  probe: { mark: '__gmt_probe=1', key: '__gmt_manual_probe_storage' },  // 可选，模块 4/5 用
});
```

卡片模型四段：**API 签名（mono）→ 语义说明（desc）→ 测试步骤（steps，有序列表）→ 期望结果（expect）→ 结果按钮（通过 / 失败 + 失败备注输入框）**。

结果持久化：点击写入 `GM_setValue('__gmt_manual_<module>', [{id, verdict: 'pass'|'fail', note?, at}])`；面板头部常驻 `N 过 / N 挂 / N 未测` + 「重置本模块」按钮（清该键）。刷新后从 `GM_getValue` 复水（值快照直嵌，同步读零 RPC）。

探针页机制沿用 gmt-selftest：内核检测 `location.search` 含 `probe.mark` → 只写 `probe.key` 后 return，不建面板；模块卡片用 `GM_openInTab(location.pathname + '?' + mark)` 开探针页完成跨 tab/跨脚本验证。

## 5. 各模块卡片清单（22 卡）

### 模块 1 信息与值存储（storage，7 卡）

| # | 卡片 | 要点 |
|---|---|---|
| 1 | GM_info 元数据自读 | 面板展示 `GM_info.script` 全字段，人工比对脚本名/版本/命名空间 |
| 2 | GM_getValue / GM_setValue 往返 | 脚本 `setValue('probe','v1')` → 卡片显示读回值，人工核对 |
| 3 | 对象值往返 | 存 `{a:1,b:'x'}` 读回 JSON 展示 |
| 4 | 默认值分支 | 读不存在的键 + 默认值，展示返回 |
| 5 | GM_deleteValue | 删除后读回 undefined，展示 |
| 6 | GM_listValues | 列全部 `__gmt_manual_*` 键，展示 |
| 7 | GM_addValueChangeListener 本地事件 | 卡上按钮触发 setValue，监听回调把 (old,new,remote) 打到卡片，人工核对 remote=false |

### 模块 2 DOM/资源/日志（dom-resource，5 卡）

| # | 卡片 | 要点 |
|---|---|---|
| 1 | GM_addStyle 真实生效 | 注入色块样式 + 页面角落挂色块 div，人工肉眼判断颜色 |
| 2 | GM_getResourceText 语义 | 未声明资源时返回 undefined，卡片展示返回值 |
| 3 | GM_log | `GM_log('...')` 后引导开 F12 console 查 `[脚本名]` 前缀行，人工勾选 |
| 4 | unsafeWindow | 展示 `unsafeWindow === window`（USER_SCRIPT world 下为隔离 window）与 `unsafeWindow.document === document` |
| 5 | 点形式 GM.getValue | 卡上按钮 `GM.getValue(key).then(...)` 展示 Promise resolve 值 |

### 模块 3 菜单/通知/剪贴板（interaction，4 卡）

| # | 卡片 | 要点 |
|---|---|---|
| 1 | GM_registerMenuCommand | 注册「GMT 手测：点我」，引导去侧边栏脚本页菜单命令区点击；回调把点击时间打到卡片 |
| 2 | GM_notification | 发通知（标题/文案含模块名），引导点掉；ondone 回调把 click/close 打到卡片 |
| 3 | GM_setClipboard | 写入标记文本，引导粘贴到卡片备注框核对 |
| 4 | GM.info 同引用 | 展示 `GM.info === GM_info`，人工勾选 |

### 模块 4 标签页（tabs，2 卡）

| # | 卡片 | 要点 |
|---|---|---|
| 1 | GM_openInTab 句柄 | 自动开探针页（inactive），卡片展示 `closed:false` 与 `close` 函数存在 |
| 2 | close()/onclose | 卡上按钮调 `handle.close()`，探针页自关后 onclose 打时间戳，人工核对 |

### 模块 5 网络（network，4 卡）

| # | 卡片 | 要点 |
|---|---|---|
| 1 | @connect 命中 | `GM_xmlhttpRequest` GET jsDelivr package.json，展示 status/headers/finalUrl |
| 2 | droppedHeaders | 带 `user-agent` 头请求，展示 `droppedHeaders:['user-agent']` |
| 3 | @connect 拒绝分支 | 请求未列 host，展示拒绝 error 文案可读性 |
| 4 | 确认卡分支 | 面板「一键复制无 @connect 版本」按钮 → 人工导入临时脚本 → 请求未列 host → 侧边栏确认卡 → 批准后卡片展示响应 |

## 6. 拼接脚本（scripts/build-manual.mjs）

Node 直跑（无第三方依赖）：读 `_panel-core.js` + 五个 `.user.js.src`（元头 + 卡片定义）→ 产 `gmt-manual-<模块>.user.js` 到同目录。产物结构 = 元头 + `(function(){ <panel-core> <module-cards> })();`。幂等（重复运行产物一致）。

`package.json` 加 `"build:manual": "node scripts/build-manual.mjs"`；根 `npm run build` 不动（WXT 构建与脚本族解耦）。

## 7. fixture 单测（tests/shared/gmt-manual-fixtures.test.ts）

与 gmt-selftest-fixture 同惯例，对**五个产物**逐一断言：

1. `parseUserScript` 零警告；name/namespace/matches/runAt/noframes 命中；
2. grants = 该模块卡片 API 并集（逐一枚举断言，模块 5 含 `@connect cdn.jsdelivr.net`）；
3. 产物含 `_panel-core.js` 全部锚点函数（render/setState 存储键前缀 `__gmt_manual_`）；
4. 卡片定义条数与本文 §5 表一致（防卡片漂移）；
5. 体量 ≤ 280KB（storage/scripts MAX_TEXT_LENGTH 护栏）。

单测跑前先执行拼接（或断言产物与源同步：重跑 build 后 git diff 干净）——采用**前置拼接 + 产物入库**（产物进 git，导入即可用；单测断言「产物与源同步」防漂移）。

## 8. 已知边界与降级

| 边界 | 说明 | 处置 |
|---|---|---|
| 全站注入副作用 | 5 脚本均 `@match *://*/*` | 用完在脚本池停用（§9 使用说明写明） |
| setClipboard SW 手势 | MV3 SW 无手势链可能被拒 | 卡片备注框粘贴验证本身就是人工路径；失败给可读提示 |
| 确认卡分支 | 需另导临时脚本 | 「一键复制」引导，非全自动 |
| 探针页时序 | 探针页未及注入即被关 | 卡片步骤写明「若未收到，重跑一次」 |
| jsDelivr 可达 | 网络 1/2 卡受影响 | 失败详情给可读提示，换 unpkg 重试 |
| 资源读取全字段 | @resource 真实内容验证归 gmt-selftest | 本脚本族只测空值语义 |

## 9. 使用说明

1. `npm run build:manual`（或直接用库内产物）→ 侧边栏脚本池导入 `fixtures/userscripts/manual/gmt-manual-<模块>.user.js`；
2. 打开 `https://example.com`，右下角出现「GM 手测·<模块>」面板；
3. 逐卡按步骤操作，人工核对期望结果后点「通过」或「失败 + 备注」；
4. 刷新/切 tab 回来结果仍在；「重置本模块」清空重来；
5. 多个模块脚本请一次只启用一个：面板共用 `#gmt-panel`，同页多模块会互相覆盖（后注入者胜出）；
6. 测完在脚本池停用该脚本。

## 10. 验收标准

1. `node scripts/build-manual.mjs` 产五产物；`npm run compile`、`npm run test`、`npm run build` 全过；
2. fixture 单测五产物全绿（解析面/grants/内核锚点/卡片数/体量/源同步）；
3. 人工冒烟路径：导入模块 1 → example.com 面板出现 7 卡 → 逐卡标记 → 刷新后结果仍在 → 「重置本模块」清空；
4. 全部 22 卡人工标记通过（或已知降级项给可读备注）。
