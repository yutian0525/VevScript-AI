---
name: 帮助
description: 介绍本扩展的功能与用法；当用户询问扩展能做什么、怎么用时触发
command: help
---

# 帮助：介绍本扩展的能力

用户想了解这个扩展有什么用。请以简洁友好的方式介绍下列能力，并按用户的提问重点展开——问什么讲什么，不要整篇背诵。

## 你的介绍要点

**1. AI 操控浏览器（核心能力）**

- 用户用自然语言下达任务，AI 通过截图、页面快照（uid 树）、点击/输入/滚动等动作直接操控网页。
- 能力包括：多标签页管理（打开/切换/关闭）、导航、填表单、抓取页面信息、执行 JS、发 HTTP 请求、看 console 和网络请求。
- 典型例子：「帮我把这个页面的表格整理成 Excel 能用的格式」「打开 XX 网站，搜一下 YY，把前十条标题和链接给我」「盯着这个页面，出现库存两个字就告诉我」。

**2. 脚本池（用户脚本管理器）**

- 像 Tampermonkey 一样安装和管理用户脚本（.user.js），在匹配的网站上自动运行。
- AI 可以帮忙安装（从 URL 直链或源码创建）、修改、启停、检查更新。
- 配合 /find-scripts 技能可以从脚本网站找现成脚本；配合 /write-script 技能可以让 AI 定制编写。

**3. GM API（脚本高级能力）**

- 已安装的脚本可以用 GM\_\* 系列 API（跨域请求 GM_xmlhttpRequest、存取数据 GM_setValue/getValue、菜单命令 GM_registerMenuCommand 等，共 14 个）。
- 从其它脚本管理器（如 Tampermonkey）导入的脚本大多可直接使用。

**4. 技能系统**

- 技能是预设的任务指令包，用 /命令 触发，也可以直接说需求让 AI 自动套用。
- 内置了 /help（本技能）、/find-scripts（找现成脚本）、/write-script（定制写脚本）。

**5. 设置与调试**

- 设置页里有：模型设置、工具调试台（手动调每个工具）、脚本运行时调试台（GM API 白名单/直调）。

## 收尾

介绍完后主动引导：「你可以直接说出想做的事，或者用 /find-scripts 找现成脚本、/write-script 定制一个。」

---

---

name: 发现脚本
description: 从 Greasy Fork / OpenUserJS 搜索、推荐并安装用户脚本；用户想找现成脚本时触发
command: find-scripts

---

# 发现脚本：帮用户找到并安装合适的用户脚本

严格按四步执行。每一步都要给用户反馈再进入下一步，不要自作主张跳步。

## 第 1 步：确认需求

向用户确认（一次问全，不要挤牙膏式追问）：

1. **想解决什么问题**（如：去广告、下载视频、自动签到、界面增强）。
2. **针对哪个网站**（域名或网站名；说「不限站点」也行）。
3. 有无特别要求（如必须是中文、更新活跃、不要需要授权的）。

同时调用 `list_scripts` 查看已安装脚本，避免推荐重复的。

## 第 2 步：导航搜索

用 `new_page`（或 `navigate_page`）打开脚本站的搜索页，用 `take_snapshot` 解析结果。

**Greasy Fork（首选，中文站，无限流）：**

- 搜索：`https://greasyfork.org/zh-CN/scripts?q={关键词}&sort=total_installs`
  - 关键词用中英文各试一次，取并集；`language=zh-CN` 可筛中文；`&page=2` 翻页。
- 列表行结构：`ol.script-list > li`，行上带有数据属性可直接读取：
  - `data-script-name` 名称、`data-script-id` 编号、`data-script-daily-installs` 日安装、
    `data-script-total-installs` 总安装、`data-script-rating-score` 评分（0-100）、
    `data-script-updated-date` 更新日期、`data-code-url` .user.js 直链。
  - 可以用 `evaluate_script` 一次性提取全部行：`Array.from(document.querySelectorAll('ol.script-list > li[data-script-id]')).map(li => ({...li.dataset}))`。
  - 注意：首行可能是广告位（无 data-script-id 属性），跳过。
- 脚本详情页：`https://greasyfork.org/zh-CN/scripts/{id}`；「安装此脚本」按钮即 `data-code-url` 那个直链。
- .user.js 直链形如 `https://update.greasyfork.org/scripts/{id}/{名称}.user.js`。

**OpenUserJS（备选，英文站，严格限流）：**

- 搜索：`https://openuserjs.org/?q={关键词}&orderBy=installs&orderDir=desc`
- 结果是表格行，脚本链接形如 `/scripts/{作者}/{名称}`；安装直链为 `/install/{作者}/{名称}.user.js`（相对域名 openuserjs.org）。
- 该站限流很严（约一分钟一页），请求过快会 429。遇 429 等 60 秒再试，或直接改用 Greasy Fork。

## 第 3 步：推荐候选

从搜索结果挑 **5~8 个**最匹配的，用 Markdown 表格呈现让用户选择：

| 脚本               | 简介       | 安装量        | 评分  | 更新 |
| ------------------ | ---------- | ------------- | ----- | ---- |
| [名称](详情页链接) | 一句话说明 | 日安装/总安装 | x/100 | 日期 |

- 简介用你自己的话概括，不要整段复制。
- 有明显劣质的（多年未更、评分很低、安装量为 0）直接筛掉，不用列。
- 用户对某个感兴趣时，可打开详情页核实「适用于」的站点范围，如实告知。

**安全提示必须讲**：用户脚本是任意代码，安装前把脚本的功能和作用站点说清楚；功能描述含糊或要求授权过多的要提醒用户谨慎。

## 第 4 步：安装与使用说明

用户选定后：

1. 取该脚本的 .user.js 直链（Greasy Fork 用列表/详情页里的 `data-code-url`；OpenUserJS 拼 `https://openuserjs.org/install/{作者}/{名称}.user.js`）。
2. 调用 `create_script`，参数 `url` = 直链（扩展会下载安装并自动记录更新源）。
3. 安装成功后，读返回的 `matches`（作用站点）和解析出的 `@description`，向用户介绍：
   - 脚本做什么、在哪些网站上生效；
   - **如何验证**：用 `navigate_page` 打开一个匹配站点，让用户亲眼看到效果（如脚本有界面元素，可 `take_screenshot` 展示）；
   - 如何启停：脚本池页面开关；日后更新：脚本池会自动检查更新源。
4. 直链下载失败（网络/CORS）时降级：`new_page` 打开脚本详情页，引导用户手动点「安装此脚本」按钮，装完让用户回侧边栏确认列表里出现了。
5. 最后提醒：脚本下次访问匹配站点时自动生效；不满意随时可以停用或删除。

---

---

name: 编写脚本
description: 先查脚本池查重、与用户确认需求与方案，再分步编写安装用户脚本；用户想定制脚本时触发
command: write-script

---

# 编写脚本：为用户定制一个用户脚本

严格按四步执行。四步中三次停下来等用户（需求、方案、交付），不要替用户做决定。最忌把简单需求做复杂：能 20 行解决的不要写 60 行，没有明确要求的功能（设置面板、菜单命令、配置项）一律不加。

## 第 1 步：确认需求，先查脚本池

1. **先查重**：调用 `list_scripts` 看已装脚本里有没有同站点或功能相近的——能直接复用、或在既有脚本上加几行，就不要新写一个。看 `matches` 判断会不会和新脚本在同一页面打架；有近似脚本时把它的作用讲给用户，问「复用改造还是另写一个」。
2. 向用户确认需求（一次问全）：
   - **在哪个网站**（最好给出示例页面 URL）。
   - **做什么**：期望的行为，最好有具体例子（「把 XX 隐藏」「点 YY 时自动 ZZ」）。
   - **什么时候生效**：每次进入页面都跑，还是特定条件下（如只在列表页、只在晚上）。
   - 边界：哪些情况不要动。
3. 简单明确的小需求不要拿来问一轮：用户说「把 h3 变红」就直接进第 2 步，有歧义或方案分叉时才问。

## 第 2 步：探索页面结构

1. 用 `new_page` / `navigate_page` 打开目标页面，`take_snapshot` 获取可交互元素树。
2. 用 `evaluate_script`（默认 isolated world 即可）确认关键节点的选择器、类名是否稳定：
   - 推荐一次性收集：`document.querySelectorAll('...')` 的数量、父级链、文本特征；
   - 动态渲染（滚动加载、React/Vue SPA）的站点，确认 `@run-at` 时机和是否要 MutationObserver 监听 DOM 变化；
   - 需要看接口时用 `list_network_requests` / `get_network_request` 找数据源。
3. 探索深度与需求复杂度匹配：简单需求（改样式、隐藏元素、加个按钮）确认选择器存在即可，不要穷尽父级链和所有边界情况。

## 第 3 步：提出方案，停下来等确认

写代码前把方案讲清楚，**说完就结束本轮回复等用户点头，不要自行开写**：

1. 说清三件事：脚本会**做什么动作**（注入什么、改什么、监听什么）、**@match 作用范围**、**实现思路**（纯 CSS、DOM 改写、拦截请求等）。
2. 有分叉的决策（写法 A 还是 B、要不要带设置面板、@grant 用哪些）列出来让用户选；没有分叉就不列。
3. 用户确认后才进第 4 步。用户改了需求就回到第 1/2 步，不要将就旧方案。

## 第 4 步：编写、安装、交付（分步写入）

**为什么分步**：单次工具调用的参数有长度上限，长脚本一次性塞进 `create_script` 会被截断作废。骨架 → 追加 → 闭合，每步都是一次独立调用，输出量小、可恢复。

1. **提交骨架**：`create_script(source=...)` 只含元数据头 + 未闭合 IIFE：
   - 头部必备：`@name`（中文）、`@match`（精确到作用站点，宁窄勿宽）、`@version`、`@description`；必要时 `@run-at`（document-end 默认、SPA 考虑 document-start/idle）。
   - 代码体写到 `(function () {\n  'use strict';\n` 为止，**不写** `})();`——提前闭合会让后续追加落到全局作用域。
   - source 上限 200 行 / 8192 字符，骨架远小于此，不会触发。
   - 本扩展支持 29 个函数型 GM\_\* API + 4 个特殊 grant（unsafeWindow / window.close / window.focus / window.onurlchange），与 Tampermonkey 高度兼容；不确定某 GM 函数可用性时优先写纯 DOM/JS 实现。
2. **分段追加**：`update_script(id, { append: '...' })` 按功能块逐段追加，每段 50~80 行：
   - 硬规则：切在函数或语句块边界，绝不切在语句/字符串中间；
   - 最后一段带上 `})();` 闭合 IIFE；
   - 每次 append 都会返回 `balance` 配平状态：过程中 `unclosed` 是正常的（骨架本来就没闭合），最后一段写完应为 `ok`。
3. **配平不对就修**：`balance` 不是 `ok` 时，用 `grep_script` 搜漏掉的括号/引号，用 `update_script(id, { replace: { old, new } })` 修正（old 要带上足够上下文保证唯一）。
4. **交付使用说明，不要自行验证**：写完确认最后一段 `balance` 为 `ok` 即可，**不主动**去刷新页面、截图或跑 console 检查——用户就在浏览器旁，让他亲眼看效果最直接。交付时告诉用户：
   - 脚本已安装，作用在哪些站点（读 `matches`）；
   - 怎么验证：刷新目标页即可看到效果；没生效时先查脚本池开关是否打开，再看是否要等页面加载完；
   - 如何启停（脚本池开关）、想改需求随时再说。
   - 仅当用户明确要求「帮我测一下」时才做注入验证：`navigate_page` 刷新触发注入 → `list_console_messages` 看报错 → `take_screenshot` 看效果 → 优先 `update_script(id, { replace: { old, new } })` 修正（需要看代码时 `get_script` 按区间读、`grep_script` 定位，不要整份读回）。

## 附：GM API 参考（写脚本时遵循，不要凭 Tampermonkey 记忆臆测）

**通用约定**：

- **@grant 声明即授权**：只有 `@grant` 声明过的 API 才注入脚本上下文；未声明的 API 不存在（调用报 `undefined is not a function`）。用到几个声明几个，不要全量罗列。
- **@grant none**：不建 GM 沙箱，脚本裸执行（仅注入 `GM_info`/`GM` 最小对象）。纯 DOM/CSS 脚本用它。
- **双形态**：`GM_xxx` 下划线形式——值/DOM 类**同步**返回；`GM.xxx` 点形式统一返回 **Promise**（`GM_info` 例外）。同一脚本两种形态都可写。
- **世界**：脚本默认跑在 `USER_SCRIPT`（隔离世界，共享 DOM 但 JS 隔离）；`@world MAIN` 跑在页面真实世界（要碰页面 JS 变量时才用，风控站慎用）。
- **跨 tab 广播**：值写操作会广播到匹配同脚本 `@match` 的其它 tab。
- **受限页**（`chrome://`、扩展页等）脚本不注入。

**值存储**（下划线形式同步，读的是注入时快照）：

```js
// @grant GM_getValue
// @grant GM_setValue
GM_setValue("count", 42); // 写（对象经 JSON 往返，跨 tab 广播）
var n = GM_getValue("count", 0); // 读，缺失键回默认值
GM_deleteValue("count");
GM_listValues(); // 删 / 列全部键
GM_getValues(["a", "b"]); // 批量读 {a:…, b:…}；传对象则值为默认值
GM_setValues({ a: 1, b: 2 });
GM_deleteValues(["a"]);
var id = GM_addValueChangeListener("count", function (key, oldV, newV, remote) {
  /* remote=true 是其它 tab 改的 */
});
GM_removeValueChangeListener(id);
```

**DOM / 样式**：

```js
// @grant GM_addStyle
// @grant GM_addElement
var el = GM_addStyle("body { background: #222 }"); // 同步，返回 style 元素
GM_addElement("div", { id: "x", textContent: "hi" }); // 插到 body，返回该元素；或 (parent, tag, attrs)
```

**网络**（跨域请求/下载/cookie 共用同一套 `@connect` 门控：同 host 与 `@connect` 命中直接放行；列了但不命中拒绝；**未列则弹确认卡**——所以脚本头要列全用到的域）：

```js
// @connect api.example.com
// @grant GM_xmlhttpRequest
GM_xmlhttpRequest({
  method: "GET",
  url: "https://api.example.com/data",
  timeout: 15000,
  headers: { "X-Token": "abc" },
  onload: function (resp) {
    /* resp.status / resp.body / resp.finalUrl */
  },
  onerror: function (resp) {},
});
```

- `GM_xmlhttpRequest`：响应非流式 ≤1MB（超出 `truncated:true`）；`credentials:'include'` 带会话 cookie；`user-agent`/`referer`/`cookie` 等被禁头忽略（响应 `droppedHeaders` 列出）。
- `GM_download(url, name)` 或 `GM_download({url, name, onload, onerror})`：浏览器下载，无 `onprogress`。
- `GM_cookie`：`@grant GM_cookie` 一次装齐 list/set/delete，均返回 Promise：`GM_cookie.list({ url: location.href })`。

**标签页 / 通知 / 剪贴板 / 日志**：

```js
// @grant GM_openInTab
// @grant GM_notification
// @grant GM_setClipboard
// @grant GM_log
var h = GM_openInTab("https://example.com", { active: false }); // h.close() 关闭
GM_notification({ title: "完成", text: "任务已结束" }); // 回调 ondone('click'|'close')
GM_setClipboard("要复制的文本"); // 仅文本
GM_log("调试信息"); // console，带 [脚本名] 前缀
```

**per-tab 临时数据**（存 `storage.session`，浏览器关闭即清，不持久化）：

```js
// @grant GM_saveTab
// @grant GM_getTab
GM_saveTab({ visited: Date.now() });
GM.getTab().then(function (data) {
  /* 本 tab 数据，首次 {} */
});
GM.getTabs().then(function (all) {
  /* {tabId: data} */
});
```

**菜单命令**（入口在侧边栏脚本页「菜单命令」区，非右键菜单）：`GM_registerMenuCommand('导出', fn)` 返回 key，`GM_unregisterMenuCommand(key)` 注销。

**本扩展独有：`GM_llmChat`**（非 GM 生态标准，脚本可调用扩展配置的大模型做 AI 处理——总结/翻译/判定等）：

```js
// @grant GM_llmChat
GM_llmChat({
  messages: [{ role: "user", content: "总结：" + text }],
  onChunk: function (delta) {
    /* 可选，流式增量 */
  },
}).then(function (r) {
  /* r.text / r.usage / r.finishReason */
});
```

- 权限档 per-script 默认「每次询问」弹确认卡；载荷 ≤2MB、响应 ≤1MB、默认 120s 超时；无 abort/tool 角色。

**特殊 grant**（`@grant` 名不是函数）：

- `unsafeWindow`：页面 window。默认 USER_SCRIPT 世界下是隔离世界 window，要真页面 window 需加 `@world MAIN`。
- `window.close` / `window.focus`：作用于脚本所在整个 tab。
- `window.onurlchange`：SPA 路由变化（pushState/hash），`window.onurlchange = fn` 与 `addEventListener('urlchange', fn)` 双形态；仅主帧。
