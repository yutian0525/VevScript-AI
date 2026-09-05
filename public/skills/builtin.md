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

## 第 3 步：编写、安装、调试

1. 写完整的 `.user.js`，要求：
   - `==UserScript==` 头必须有：`@name`（中文）、`@match`（精确到作用站点，宁窄勿宽）、`@version`、`@description`；必要时 `@run-at`（document-end 默认、SPA 页面考虑 document-start/idle）。
   - 代码用 IIFE 包裹，避免污染页面；CSS 注入用 GM_addStyle 或手动 `<style>`。
   - 本扩展支持的 GM API 共 14 个（GM_xmlhttpRequest / GM_setValue / GM_getValue / GM_registerMenuCommand 等），除此之外的 GM 函数（GM_addStyle 之外的 unsafeWindow 高级用法等）不要用，写纯 DOM/JS 实现。
2. 调用 `create_script`，参数 `source` = 完整脚本文本（解析后必须带 @match 才能创建）。
3. **测试闭环**：
   - `navigate_page` 到目标页（刷新使脚本注入），`take_screenshot` 或 `evaluate_script` 检查效果是否符合预期；
   - 不符合 → 改代码，用 `update_script` 的 `text`（整文替换）或 `edit`（行区间替换）修正，再刷新验证；
   - 直到符合预期，并把最终效果截图/描述给用户。
4. 收尾：告诉用户脚本已安装、作用在哪些站点、如何启停（脚本池开关）、想改需求随时再说。
