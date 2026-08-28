# Chrome DevTools MCP 功能文档

> 本文档基于当前会话中实际加载的工具定义整理，描述 `chrome-devtools` MCP 服务器提供的全部能力。
> 该 MCP 通过 Chrome DevTools Protocol（CDP）驱动真实的 Chrome 浏览器，可用于自动化操作、页面调试、性能分析与质量审计。

---

## 目录

1. [总览](#总览)
2. [页面与标签管理](#一页面与标签管理)
3. [页面导航](#二页面导航)
4. [页面内容快照](#三页面内容快照)
5. [元素交互](#四元素交互)
6. [键盘与输入](#五键盘与输入)
7. [表单填写](#六表单填写)
8. [文件上传](#七文件上传)
9. [对话框处理](#八对话框处理)
10. [脚本执行](#九脚本执行)
11. [等待机制](#十等待机制)
12. [控制台消息](#十一控制台消息)
13. [网络请求](#十二网络请求)
14. [环境模拟](#十三环境模拟)
15. [截图与可视化](#十四截图与可视化)
16. [性能分析](#十五性能分析)
17. [内存分析](#十六内存分析)
18. [质量审计 Lighthouse](#十七质量审计-lighthouse)
19. [典型工作流示例](#典型工作流示例)

---

## 总览

Chrome DevTools MCP 一共提供 **34 个工具**，按职责可分为以下几大类：

| 类别 | 工具数 | 主要用途 |
|------|--------|----------|
| 页面与标签管理 | 5 | 列出/打开/关闭/切换标签页 |
| 页面导航 | 1 | URL 跳转、前进后退、刷新 |
| 内容快照 | 1 | 获取可访问性树文本快照 |
| 元素交互 | 4 | 点击、悬停、拖拽、填充 |
| 键盘输入 | 2 | 按键、输入文本 |
| 表单填写 | 1 | 批量填表 |
| 文件上传 | 1 | 上传本地文件 |
| 对话框处理 | 1 | 处理 alert/confirm/prompt |
| 脚本执行 | 1 | 在页面中执行 JavaScript |
| 等待 | 1 | 等待文本出现 |
| 控制台 | 2 | 列出/获取控制台消息 |
| 网络 | 2 | 列出/获取网络请求 |
| 环境模拟 | 2 | 视口、网络、CPU、地理位置等模拟 |
| 截图可视化 | 1 | 页面/元素截图 |
| 性能分析 | 3 | 录制 trace、分析洞察 |
| 内存分析 | 1 | 堆快照 |
| 质量审计 | 1 | Lighthouse 报告 |

> **重要约定**：大量交互类工具（click、fill、hover、drag 等）需要传入元素的 `uid`。这个 `uid` 来自 `take_snapshot` 生成的页面内容快照。所以典型流程是：**先 `take_snapshot` → 拿到元素 uid → 再执行交互**。官方建议优先用快照而非截图来定位元素。

---

## 一、页面与标签管理

### `list_pages`
列出浏览器中当前打开的所有页面（标签页）。
- **参数**：无
- **用途**：在做任何针对特定页面的操作前，先了解有哪些页面及其 ID。

### `new_page`
打开一个新标签页并加载指定 URL。
- **参数**：
  - `url`（必填）：要加载的 URL
  - `background`：是否在后台打开（不切到前台），默认 `false`
  - `isolatedContext`：指定一个隔离的浏览器上下文名称。相同上下文的页面共享 Cookie 和存储；不同上下文之间完全隔离（适合多账号、隔离测试）
  - `timeout`：最大等待时间（毫秒），0 表示用默认值

### `select_page`
将某个页面设置为后续工具调用的操作上下文。
- **参数**：
  - `pageId`（必填）：页面 ID（通过 `list_pages` 获取）
  - `bringToFront`：是否聚焦并置顶该页面

### `close_page`
按索引关闭页面。最后一个打开的页面无法关闭。
- **参数**：
  - `pageId`（必填）：要关闭的页面 ID

### `resize_page`
调整当前选中页面的窗口尺寸，使页面达到指定宽高。
- **参数**：
  - `width`（必填）：页面宽度
  - `height`（必填）：页面高度

---

## 二、页面导航

### `navigate_page`
跳转 URL，或在历史记录中前进/后退/刷新。
- **参数**：
  - `type`：导航类型，枚举 `url` / `back` / `forward` / `reload`
  - `url`：目标 URL（仅当 `type=url` 时使用）
  - `ignoreCache`：刷新时是否忽略缓存
  - `handleBeforeUnload`：是否自动接受/拒绝 `beforeunload` 对话框，枚举 `accept` / `decline`
  - `initScript`：在下一次导航的每个新文档中、所有其他脚本之前执行的 JS 脚本（适合注入 hook、mock）
  - `timeout`：最大等待时间（毫秒）

---

## 三、页面内容快照

### `take_snapshot`
基于可访问性（a11y）树生成页面的**文本快照**。快照会列出页面元素及其唯一标识 `uid`。
- **参数**：
  - `verbose`：是否输出 a11y 树中所有可用信息，默认 `false`
  - `filePath`：将快照保存到文件而非附在响应中
- **说明**：
  - 这是元素交互的基础——其他工具用到的 `uid` 都来自这里。
  - 官方建议**优先用快照而非截图**来理解页面结构。
  - 始终使用最新的快照（页面变化后 uid 可能失效）。
  - 快照还会指示 DevTools Elements 面板中当前选中的元素。

---

## 四、元素交互

### `click`
点击指定元素。
- **参数**：
  - `uid`（必填）：来自快照的元素 uid
  - `dblClick`：是否双击，默认 `false`
  - `includeSnapshot`：响应中是否附带新快照，默认 `false`（开启后省去再次手动 take_snapshot）

### `hover`
悬停在指定元素上（触发 hover 态、下拉菜单等）。
- **参数**：
  - `uid`（必填）
  - `includeSnapshot`

### `drag`
将一个元素拖拽到另一个元素上。
- **参数**：
  - `from_uid`（必填）：被拖拽元素
  - `to_uid`（必填）：放置目标元素
  - `includeSnapshot`

### `fill`
向输入框、文本域填入文本，或从 `<select>` 中选择选项。
- **参数**：
  - `uid`（必填）
  - `value`（必填）：要填入的值。复选框/开关填 `"true"`/`"false"`，单选按钮填 `"true"`
  - `includeSnapshot`

---

## 五、键盘与输入

### `press_key`
按下某个键或组合键。适用于 `fill` 等方法无法实现的场景（键盘快捷键、导航键、特殊组合键）。
- **参数**：
  - `key`（必填）：单键或组合键，如 `"Enter"`、`"Control+A"`、`"Control++"`、`"Control+Shift+R"`。修饰键支持 `Control`、`Shift`、`Alt`、`Meta`
  - `includeSnapshot`

### `type_text`
通过键盘向**之前已聚焦**的输入框输入文本。
- **参数**：
  - `text`（必填）：要输入的文本
  - `submitKey`：输入后要按下的键，如 `"Enter"`、`"Tab"`、`"Escape"`

> `fill` vs `type_text`：`fill` 直接对指定 uid 元素赋值，适合一般表单；`type_text` 模拟真实逐字键入到已聚焦元素，适合需要触发 `keydown`/输入联想的场景。

---

## 六、表单填写

### `fill_form`
一次性填写多个表单元素（输入框、下拉、复选框、单选按钮）。
- **参数**：
  - `elements`（必填）：元素数组，每项含 `uid` 和 `value`
  - `includeSnapshot`
- **说明**：官方**强烈建议**在处理表单时优先用此工具，而不是多次单独调用 `fill` / `click`——它明显更快、更可靠，并减少交互轮数。例如一次性填写用户名、密码并勾选"记住我"。

---

## 七、文件上传

### `upload_file`
通过指定元素上传本地文件。
- **参数**：
  - `uid`（必填）：file input 元素，或能打开文件选择器的元素
  - `filePath`（必填）：要上传的本地文件路径
  - `includeSnapshot`

---

## 八、对话框处理

### `handle_dialog`
当浏览器弹出对话框（alert / confirm / prompt）时进行处理。
- **参数**：
  - `action`（必填）：`accept`（接受）或 `dismiss`（取消）
  - `promptText`：要填入 prompt 对话框的文本

---

## 九、脚本执行

### `evaluate_script`
在当前选中页面中执行一段 JavaScript 函数，返回 JSON 序列化后的结果。
- **参数**：
  - `function`（必填）：一段 JS 函数声明。
    - 无参示例：`() => { return document.title }` 或 `async () => { return await fetch("example.com") }`
    - 带参示例：`(el) => { return el.innerText; }`
  - `args`：传给函数的参数列表（传入元素 uid 列表，会被解析为对应 DOM 元素）
  - `dialogAction`：执行过程中处理对话框，`"accept"` / `"dismiss"` / 或作为 `window.prompt` 的返回字符串，默认 accept
  - `filePath`：将脚本输出保存到文件，省略则内联返回
- **用途**：读取/修改 DOM、注入逻辑、提取数据、调用页面内 API，能力非常灵活。返回值必须可 JSON 序列化。

---

## 十、等待机制

### `wait_for`
等待指定文本出现在当前选中页面上。
- **参数**：
  - `text`（必填）：非空文本数组，**任意一个**出现即视为成功
  - `timeout`：最大等待时间（毫秒），0 表示用默认值
- **用途**：在异步加载、跳转后、动态渲染后用作同步点，避免操作过早执行。

---

## 十一、控制台消息

### `list_console_messages`
列出当前选中页面自上次导航以来的所有控制台消息。
- **参数**：
  - `types`：按类型过滤，可选 `log` / `debug` / `info` / `error` / `warn` / `dir` / `dirxml` / `table` / `trace` / `clear` / `startGroup` / `startGroupCollapsed` / `endGroup` / `assert` / `profile` / `profileEnd` / `count` / `timeEnd` / `verbose` / `issue`
  - `includePreservedMessages`：是否返回最近 3 次导航内保留的消息，默认 `false`
  - `serviceWorkerId`：仅返回指定 Service Worker 的消息
  - `pageIdx`：分页页码（0 起始）
  - `pageSize`：每页最大消息数

### `get_console_message`
按 ID 获取单条控制台消息（ID 可通过 `list_console_messages` 获取）。
- **参数**：
  - `msgid`（必填）：消息 ID

---

## 十二、网络请求

### `list_network_requests`
列出当前选中页面自上次导航以来的所有请求。
- **参数**：
  - `resourceTypes`：按资源类型过滤，可选 `document` / `stylesheet` / `image` / `media` / `font` / `script` / `texttrack` / `xhr` / `fetch` / `prefetch` / `eventsource` / `websocket` / `manifest` / `signedexchange` / `ping` / `cspviolationreport` / `preflight` / `fedcm` / `other`
  - `includePreservedRequests`：是否返回最近 3 次导航内保留的请求，默认 `false`
  - `pageIdx`：分页页码（0 起始）
  - `pageSize`：每页最大请求数

### `get_network_request`
获取单个网络请求的详情。
- **参数**：
  - `reqid`：请求 ID。**省略时返回 DevTools Network 面板中当前选中的请求**
  - `requestFilePath`：将请求体保存到 `.network-request` 文件
  - `responseFilePath`：将响应体保存到 `.network-response` 文件
- **用途**：检查请求头、响应体、状态码，调试 API、排查接口异常。

---

## 十三、环境模拟

### `emulate`
在选中页面上模拟各种环境特性，用于响应式测试、弱网测试、性能测试等。
- **参数**（均为可选，按需组合）：
  - `viewport`：模拟设备视口，格式 `<width>x<height>x<devicePixelRatio>[,mobile][,touch][,landscape]`。加 `mobile`/`touch` 模拟移动设备，`landscape` 模拟横屏
  - `colorScheme`：模拟深色/浅色模式，`dark` / `light` / `auto`（重置）
  - `networkConditions`：网络限速，`Offline` / `Slow 3G` / `Fast 3G` / `Slow 4G` / `Fast 4G`，省略则关闭限速
  - `cpuThrottlingRate`：CPU 降速倍数（1–20），1 或省略表示不限速
  - `geolocation`：模拟地理位置，格式 `<纬度>,<经度>`（纬度 -90~90，经度 -180~180），省略则清除
  - `userAgent`：模拟 User-Agent，空字符串清除
  - `extraHttpHeaders`：额外 HTTP 头（JSON 字符串，如 `{"Authorization":"Bearer token"}`）。会注入到该页面发起的每个请求，跨导航保留直到清除；空字符串清除所有额外头

---

## 十四、截图与可视化

### `take_screenshot`
对页面或某个元素截图。
- **参数**：
  - `format`：`png`（默认）/ `jpeg` / `webp`
  - `quality`：JPEG/WebP 的压缩质量（0–100），PNG 忽略
  - `fullPage`：是否截取整个页面（而非仅可视区域），**不能与 `uid` 同时使用**
  - `uid`：仅截取指定元素；省略则截整页/视口
  - `filePath`：保存到文件而非附在响应中

---

## 十五、性能分析

### `performance_start_trace`
在选中页面上开始性能录制（trace），用于排查前端性能问题、Core Web Vitals（LCP、INP、CLS）和加载速度。
- **参数**：
  - `reload`：开始 trace 后是否自动重新加载当前页面，默认 `true`
  - `autoStop`：是否自动停止录制，默认 `true`
  - `filePath`：保存原始 trace 数据的路径，如 `trace.json.gz`（压缩）或 `trace.json`（未压缩）
- **注意**：若 `reload` 或 `autoStop` 为 true，应在开始 trace **之前**用 `navigate_page` 把页面导航到正确 URL。

### `performance_stop_trace`
停止当前活动的性能录制。
- **参数**：
  - `filePath`：保存原始 trace 数据的路径

### `performance_analyze_insight`
对 trace 录制结果中高亮出来的某个"性能洞察（Insight）"提供更详细的信息。
- **参数**：
  - `insightSetId`（必填）：洞察集 ID（只能用结果中"Available insight sets"列出的 ID）
  - `insightName`（必填）：洞察名称，如 `"DocumentLatency"`、`"LCPBreakdown"`

---

## 十六、内存分析

### `take_heapsnapshot`
捕获当前选中页面的堆快照，用于分析 JS 对象的内存分布、排查内存泄漏。
- **参数**：
  - `filePath`（必填）：保存 `.heapsnapshot` 文件的路径

---

## 十七、质量审计 Lighthouse

### `lighthouse_audit`
获取 Lighthouse 评分与报告，覆盖**可访问性、SEO、最佳实践、智能体浏览（agentic browsing）**。
- **参数**：
  - `device`：模拟设备，`desktop`（默认）/ `mobile`
  - `mode`：`navigation`（重新加载并审计）/ `snapshot`（分析当前状态），默认 `navigation`
  - `outputDirPath`：报告输出目录，省略则用临时文件
- **注意**：此工具**不含性能（performance）审计**。性能审计请用 `performance_start_trace`。

---

## 典型工作流示例

### 1. 自动化操作页面（点击 / 填表）
```
navigate_page (url)        → 打开目标页
take_snapshot              → 获取元素 uid
fill_form / click          → 用 uid 交互
wait_for (text)            → 等待结果出现
take_screenshot            → 截图确认
```

### 2. 调试网络接口
```
navigate_page              → 触发请求
list_network_requests      → 按 xhr/fetch 过滤找到目标
get_network_request (reqid)→ 查看请求头/响应体
```

### 3. 排查前端报错
```
list_console_messages (types=[error]) → 列出报错
get_console_message (msgid)           → 查看详情堆栈
```

### 4. 性能分析
```
navigate_page                         → 导航到目标 URL
performance_start_trace (reload=true) → 录制并自动重载
performance_stop_trace                → 停止（若未 autoStop）
performance_analyze_insight           → 深入分析 LCP/CLS 等洞察
```

### 5. 响应式 / 弱网测试
```
emulate (viewport=375x812x3,mobile,touch, networkConditions=Slow 3G)
navigate_page (reload)
take_screenshot (fullPage)
```

### 6. 质量审计
```
lighthouse_audit (device=mobile, mode=navigation)
→ 得到可访问性 / SEO / 最佳实践评分与建议
```

---

## 使用要点小结

1. **uid 来自快照**：交互前先 `take_snapshot`，页面变化后要重新取快照。
2. **快照优先于截图**：理解结构用快照，视觉确认才用截图。
3. **表单优先用 `fill_form`**：比多次 `fill`/`click` 更快更稳。
4. **多页面要先 `select_page`**：明确操作上下文。
5. **性能与 Lighthouse 分工**：性能用 trace 工具，Lighthouse 负责 a11y/SEO/最佳实践。
6. **`evaluate_script` 是万能逃生口**：标准工具覆盖不到的场景可用它直接跑 JS。
