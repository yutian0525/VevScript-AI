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
- 已安装的脚本可以用 GM_* 系列 API（跨域请求 GM_xmlhttpRequest、存取数据 GM_setValue/getValue、菜单命令 GM_registerMenuCommand 等，共 14 个）。
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

| 脚本 | 简介 | 安装量 | 评分 | 更新 |
|---|---|---|---|---|
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
description: 确认需求后探索目标页面结构，定制编写、安装并调试用户脚本；用户想定制脚本时触发
command: write-script
---

# 编写脚本：为用户定制一个用户脚本

严格按三步执行。需求不清楚就先问，页面结构没摸清就别写代码。

## 第 1 步：确认需求

向用户确认清楚（一次问全）：
1. **在哪个网站**（最好给出示例页面 URL）。
2. **做什么**：期望的行为，最好有具体例子（「把 XX 隐藏」「点 YY 时自动 ZZ」）。
3. **什么时候生效**：每次进入页面都跑，还是特定条件下（如只在列表页、只在晚上）。
4. 边界：哪些情况不要动。

## 第 2 步：探索页面结构

1. 用 `new_page` / `navigate_page` 打开目标页面，`take_snapshot` 获取可交互元素树。
2. 用 `evaluate_script`（默认 isolated world 即可）确认关键节点的选择器、类名是否稳定：
   - 推荐一次性收集：`document.querySelectorAll('...')` 的数量、父级链、文本特征；
   - 动态渲染（滚动加载、React/Vue SPA）的站点，确认 `@run-at` 时机和是否要 MutationObserver 监听 DOM 变化；
   - 需要看接口时用 `list_network_requests` / `get_network_request` 找数据源。
3. 把探索结论（选择器、时机、数据源）简要讲给用户听，确认理解无误再动手。

## 第 3 步：编写、安装、调试（分步写入）

**为什么分步**：单次工具调用的参数有长度上限，长脚本一次性塞进 `create_script` 会被截断作废。骨架 → 追加 → 闭合，每步都是一次独立调用，输出量小、可恢复。

1. **提交骨架**：`create_script(source=...)` 只含元数据头 + 未闭合 IIFE：
   - 头部必备：`@name`（中文）、`@match`（精确到作用站点，宁窄勿宽）、`@version`、`@description`；必要时 `@run-at`（document-end 默认、SPA 考虑 document-start/idle）。
   - 代码体写到 `(function () {\n  'use strict';\n` 为止，**不写** `})();`——提前闭合会让后续追加落到全局作用域。
   - source 上限 200 行 / 8192 字符，骨架远小于此，不会触发。
   - 本扩展支持的 GM API 共 14 个（GM_xmlhttpRequest / GM_setValue / GM_getValue / GM_registerMenuCommand 等），除此之外的 GM 函数（GM_addStyle 之外的 unsafeWindow 高级用法等）不要用，写纯 DOM/JS 实现。
2. **分段追加**：`update_script(id, { append: '...' })` 按功能块逐段追加，每段 50~80 行：
   - 硬规则：切在函数或语句块边界，绝不切在语句/字符串中间；
   - 最后一段带上 `})();` 闭合 IIFE；
   - 每次 append 都会返回 `balance` 配平状态：过程中 `unclosed` 是正常的（骨架本来就没闭合），最后一段写完应为 `ok`。
3. **配平不对就修**：`balance` 不是 `ok` 时，用 `grep_script` 搜漏掉的括号/引号，用 `update_script(id, { replace: { old, new } })` 修正（old 要带上足够上下文保证唯一）。
4. **注入验证**：
   - `navigate_page` 到目标页（刷新触发注入），`list_console_messages` 看有无报错（语法错误会在 console 报 SyntaxError）；
   - `take_screenshot` 或 `evaluate_script` 检查效果是否符合预期。
5. **迭代修正**：优先 `patch.replace`（精确、不依赖行号）；需要看代码时用 `get_script` 按区间读（返回带行号，默认只给前 200 行）或 `grep_script` 定位，不要整份读回；改完再刷新验证，直到符合预期。
6. 收尾：告诉用户脚本已安装、作用在哪些站点、如何启停（脚本池开关）、想改需求随时再说。

---

---
name: 页面脚本 API
description: 编写页内批量执行脚本的 helper 函数参考；调用 run_page_script 前加载
command: page-script
---

# 页面脚本 API 参考

`run_page_script` 在页面里执行一段 async 函数体，一次往返完成多个动作。下面是可用的 10 个 helper。

**原生 JS 照常可用**——helper 只封装三类难写对的东西：事件序列、等待条件、失败诊断。滚动、数组处理、字符串操作直接写原生。

**注意 world**：helper 只在 `world:'isolated'`（默认）下可用。`world:'main'` 只跑原生 DOM/JS，10 个 helper 全部不可用（仅 `log` 例外，只收集埋点）。要读写页面自身的 JS 变量才用 main。

## 定位

```js
$(loc, opts?)    // 单个。找不到或命中多个都抛错（附诊断）
$$(loc, opts?)   // 多个。返回数组，可能为空
```

`loc` 三种形状：

```js
$('button.submit')                        // CSS 选择器
$(46)                                     // uid（来自 take_snapshot / query_page）
$({ role:'button', text:'登录' })          // 语义：角色 + 文本
$({ role:'textbox', near:'密码' })         // 相对：'密码'附近的输入框
$({ text:'删除', nth:2 })                  // 命中多个取第 3 个（0-based）
$({ text:'确定', exact:true })             // 精确匹配（默认包含匹配）
$('h2', { within: item })                 // 限定在某元素内查找
```

- `role` 常用值：`button` `link` `textbox` `combobox` `checkbox` `radio` `option` `tab` `heading` `listitem` `img`。
- `text` 匹配前会折叠空白。匹配对象是元素的可访问名，无名时退回其可见文本。
- `near` 判定顺序：显式 `label[for]`/`aria-labelledby` 关联 → DOM 邻近（从锚点逐层向上找）→ 几何最近（纵向距离加权 3 倍，保护同一视觉行）。**这是启发式，会猜错**；trace 里的 `nearTier`（label/dom/geometry）告诉你走了哪一级，命中不对就换成选择器。
- `$` 命中多个即抛错是刻意的：避免「点了三个里的第一个」这种静默干错事。真有多个时用 `$$` 取，或加 `nth`/`within` 收窄。
- **同源 iframe 自动穿透**，无需额外处理。跨域 iframe 内容无法访问，trace 里 `skippedFrames` 会计数告知盲区。

## 动作

```js
await click(el, opts?)         // opts: { dbl:true 双击, force:true 跳过遮挡检测 }
await type(el, value, opts?)   // opts: { instant:true 跳过逐字符 }
await hover(el)
await press(key, mods?)        // press('Enter') / press({key:'a', ctrl:true})
```

- `click` 内部发完整序列（`pointerdown`→`mousedown`→`pointerup`→`mouseup`→`click`）+ 点击前 `focus()` + 真实坐标 + 遮挡检测（取元素**中心点**采样 `elementFromPoint`，pointer-events:none 的装饰层不算遮挡）。不用自己 `dispatchEvent`。
- `type` 通吃 `input`/`textarea`/`<select>`/`contenteditable`。传 `<select>` 时按 option 的 value 匹配，不中再按显示文本匹配。
- `type` 默认**逐字符发键盘事件**——搜索联想框需要 `keydown` 才触发。长文本用 `{ instant:true }` 加速。
- `type` 填完发 `change` 但**不 blur**（blur 可能触发提交或校验）。需要 blur 时显式 `press('Tab')`。
- `type` 的不可输入是**显式报错**而非静默成功：disabled/readonly 直接抛 `state`；`contenteditable="false"` 的节点（富文本编辑器里的 mention/徽章岛）不算可编辑；number 输入框收到非数字值会抛错（原生 setter 会把它清洗成空）。产生大写字符的按键自动带 shiftKey。
- `press('Enter')` 是合成事件，**不触发表单的隐式提交**。监听 keydown 的搜索框正常工作（Enter 也会发 keypress，旧式监听也能收到）；需要提交表单时点提交按钮，或 `$('form').requestSubmit()`。修饰键：`press({key:'a', ctrl:true})` 或 `press('a', { ctrl:true })`。

## 等待

```js
await waitFor({ role:'dialog' })          // 元素出现
await waitFor({ gone:'.loading' })        // 元素消失
await waitFor({ text:'搜索结果' })         // 文本出现
await waitFor({ idle:600 })               // 网络静默 600ms
await waitFor(() => items.length > 10)    // 自定义谓词（可 async）
await waitFor(cond, { timeout:8000, interval:100 })   // 缺省 timeout 10000、interval 100
```

- `interval` 会被压到不超过 `timeout`，不用自己算。
- `{ idle }` 依赖网络请求计数判断静默，**纯前端渲染（不发请求）的变化等不到**——那种情况用元素条件或谓词。
- uid 条件只适合「等快照里已有 uid 的元素消失」；等待期间才出现的元素没有 uid，用 CSS/语义 locator。

## 观测

```js
text(el)              // 归一化取文本（trim + 折叠空白）。el 为空返回空串
log(...args)          // 埋点，结果里的 logs 会回给你（上限 30 条，每条 500 字符）
expect(cond, msg)     // 断言，失败即中止并诊断
```

## 五个成品示例

**搜索并抓前 5 条**

```js
await type($({ role:'textbox', near:'搜索' }), 'React 性能优化');
await press('Enter');
await waitFor({ idle:600 }, { timeout:8000 });
log('搜索页已加载', location.href);
return $$('.SearchResult-Card').slice(0, 5).map((card) => ({
  title: text($('h2', { within: card })),
  link:  $('a', { within: card }).href,
}));
```

**翻页收集（含正常退出）**

```js
const all = [];
for (let p = 0; p < 3; p++) {
  all.push(...$$('.item').map(text));
  const next = $$({ text:'下一页' });
  if (!next.length) { log('无下一页，停在第', p + 1, '页'); break; }
  await click(next[0]);
  await waitFor({ idle:500 }, { timeout:8000 });
}
return all;
```

**无限滚动**（用原生滚动——原生一行能写对的不包 helper）

```js
for (let i = 0; i < 5; i++) {
  window.scrollTo(0, document.body.scrollHeight);
  await waitFor({ idle:800 }, { timeout:5000 });
}
return $$('.feed-item').length;
```

**hover 展开再点**

```js
await hover($({ text:'更多' }));
await waitFor({ text:'导出' }, { timeout:2000 });
await click($({ text:'导出' }));
```

**填表提交并确认成功**

```js
await type($({ near:'用户名', role:'textbox' }), 'alice');
await type($({ near:'密码',   role:'textbox' }), 'secret');
await click($({ role:'button', text:'登录' }));
await waitFor({ gone:{ role:'button', text:'登录' } }, { timeout:10000 });
expect(!location.pathname.includes('login'), '仍在登录页，可能凭据错误');
log('登录后', location.href);
```

## 返回值

成功：

```js
{ ok:true, url, elapsed, trace:[{i,op,on,…}], logs:[…], data:<你 return 的值>, pageErrors:0 }
```

失败：

```js
{ ok:false, kind, error, failedAt:{i,…诊断字段}, trace:[…前序成功步], logs, hint, url, pageErrors }
```

- `trace` 成功步只记一行摘要（不记 click 内部的 5 个事件）。超 50 步会折叠中间。
- `data` 上限 8192 字符，超限截断并给 `dataTruncated`。抓大量内容时**先在脚本里聚合**（只回需要的字段），或 `.slice()` 分批取。
- 返回值里不能有 DOM 节点——用 `text(el)`、`el.href`、`el.value` 取标量。
- `pageErrors` 是页面自己在这段时间抛的错误数。它 > 0 而你的 trace 正常，说明是**触发了页面 bug**，不是你的脚本错——换条路径。

## 八类失败与修法

| `kind` | 含义 | 怎么改 |
|---|---|---|
| `locator-miss` | 匹配 0 个 | 看 `failedAt.relaxed` 哪一档有命中、`nearMiss` 给的候选长什么样，据此改 locator |
| `locator-ambiguous` | 期望 1 个但命中多个 | 看 `failedAt.ambiguous` 列出的候选，加 `nth` 或 `within` 收窄 |
| `blocked` | 找到了但被遮挡 | `failedAt.blockedBy` 是遮挡物。先关掉它（找它里面的关闭/同意按钮），或滚动错开 |
| `state` | 找到了但 disabled/readonly/不可输入 | 前置条件没满足。先做别的（填必填项、勾选同意），或确认操作对象是否正确 |
| `timeout` | `waitFor` 超时 | 看 `failedAt.matched`：0 说明元素始终不存在（可能前一步没生效、需先滚动、或在跨域 iframe）；条件写错也常见 |
| `assert` | `expect` 失败 | 对页面状态的理解有误。用 `query_page` 看实际内容 |
| `script-error` | 代码本身错 | 按 `error` 改。若是「未定义的函数」且名字不在上面 10 个里，说明用了本运行时没有的 API |
| `page-error` | 页面 JS 抛错 | 你的操作触发了页面 bug，换条路径 |

`assert` 与 `timeout` 属于「trace 都正常但结果不对」——这两类值得重跑时传 `screenshot:'on-failure'` 看页面实况。其余类型的结构化诊断通常已经够用，截图是浪费。

## 工作流建议

1. 陌生页面先 `query_page` 试定位符（便宜，几百 tokens），试通了原样搬进脚本。
2. 不确定页面结构时 `take_snapshot`（默认 `interactive` 档已瘦身），只关心某区域用 `region`。
3. 脚本别写太长——出错时定位困难。一个脚本做一件事（一次搜索、一轮翻页），拿到结果再决定下一步。
4. 关键节点埋 `log`，失败时能看出走到哪了。
5. 有把握的前置条件用 `expect` 卡住，避免在错误状态上继续操作。
