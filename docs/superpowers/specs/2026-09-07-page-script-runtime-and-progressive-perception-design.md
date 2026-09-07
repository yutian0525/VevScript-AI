# 页内脚本运行时 + 渐进式感知设计

日期：2026-09-07
分支：`feat/better-tools`

## 1. 目标与范围

现有「全量无障碍树快照 → 逐个动作」的操控模式有两个实测确认的问题，本设计分别对症：

**问题一：单次感知贵，且随任务变长二次增长。** jsdom 实测（源 HTML 均约 178KB）：

| 页面 | 快照字符 | 行数 | 估算 tokens |
|---|---|---|---|
| MDN `fetch` 文档 | 45,658 | 844 | ~11,430（已撞 1200 节点上限被截断） |
| 知乎发现页 | 22,581 | 449 | ~9,258 |

两个纯浪费点占 65~79% 字符：StaticText 与父节点 name 重复（37~48%）、每个 link 带绝对 URL（28~31%）。更要紧的是 `agent/loop.ts` 对 tool 输出零截断，`truncateMessages` 保留最近 60 条，于是一个任务里多次快照全文**同时驻留**上下文——8 步任务约 80k tokens。

**问题二：动作失真与覆盖盲区，表现为「点了没反应」。** 四个已定位的原因：

1. **iframe 完全不可见**：`buildSnapshot(document.body)` 只遍历主文档的 `childNodes` + shadowRoot，不进 `iframe.contentDocument`；工具调用又钉死 `frameId: 0`。嵌入式表单、支付组件、第三方登录框在快照里不存在。
2. **事件序列不完整**：`doClick` 发 `pointerdown → mousedown → mouseup → click`，缺 `pointerup`。
3. **点击前不 `focus()`**：依赖 focus/blur 驱动状态的组件不响应；上一个元素的 blur 不发生，前一步填的值可能未提交。
4. **事件坐标恒为 0**：`new MouseEvent(type, {bubbles, cancelable})` 的 `clientX/clientY` 默认 0，读坐标定位的组件误判。同理 `doFill` 只发 `input/change` 不发键盘事件，搜索联想框不触发；`contenteditable` 完全不支持。

**本设计的四块内容：**

1. **页内脚本运行时**（`run_page_script` 工具 + 10 个 helper）：一次往返执行多个动作，helper 内部保证事件序列正确。
2. **渐进式感知**（`take_snapshot` 分级 + `query_page` 查询工具）：默认档瘦身 54%，按意图定向查询。
3. **覆盖面修补**：iframe 默认穿透、`wait_for` 扩展条件形式。
4. **API 文档走 skill 按需加载**：常驻成本压到约 210 tokens。

**不在本次范围**：CDP/debugger 真事件注入、视觉坐标定位、脚本沉淀复用进脚本池、跨域 iframe 穿透。理由见 §10。

### 1.1 目标模型与任务画像（决定取舍基准）

- **任务画像：陌生站一次性探索为主**。故「首次探查便宜」优先级高于「脚本沉淀复用」；本设计不做脚本持久化。
- **目标模型：旗舰大窗口（Claude / GPT-4.1 / Gemini，200k~1M，视觉可用）**。故截图可进方案，但仅作兜底通道（§5.4）；同时因 `agent/model-windows.ts` 里 deepseek 64k / qwen 32k 的存在，默认档仍按小窗口能跑通来设计。

## 2. 设计原则

三条原则贯穿全文，冲突时按序优先：

1. **原生 JS 能一行写对的，不进 helper。** helper 只封装三类「难写对」的东西：事件序列（错了静默失败）、等待条件（写不好是死循环或误判）、诊断信息（原生做不到）。脚本本身就是 JS，包一层只多一个要学的名字。
2. **框架保证正确，而非每次靠模型写对。** 事件序列在 helper 实现里一次写对，所有脚本受益。这是修「点了没反应」的核心杠杆。
3. **失败时 agent 只看返回值就能知道下一步怎么改。** 不用再花一次往返去查。诊断信息的成本远低于一次额外往返。

## 3. 页内脚本运行时

### 3.1 helper 清单（10 个）

```js
// —— 定位（2）——
$(locator, opts?)      // 单个。找不到抛错（附匹配诊断）
$$(locator, opts?)     // 多个。返回数组，可能为空

// —— 动作（4）——
click(el, opts?)       // 完整事件序列 + focus + 真实坐标 + 遮挡检测
type(el, value, opts?) // input/textarea/select/contenteditable 通吃
hover(el)              // 悬停展开菜单
press(key, opts?)      // 'Enter' / 'Escape' / { key:'a', ctrl:true }

// —— 等待（1）——
waitFor(cond, opts?)   // 出现 / 消失 / 网络空闲 / 自定义谓词

// —— 观测（3）——
text(el)               // 归一化取文本（trim + 折叠空白）
log(...args)           // 埋点，进 trace 回给 agent
expect(cond, msg)      // 断言，失败即中止并诊断
```

刻意的合并（每个省一个函数位，均按原则 1）：

| 不做 | 理由 |
|---|---|
| `select()` | 合进 `type()`：传 `<select>` 时内部走 option 匹配。语义统一为「让控件的值变成 value」 |
| `waitGone()` / `waitIdle()` | 合进 `waitFor(cond)` 的条件形式 |
| `exists()` / `count()` | `$$(x).length` 即是答案 |
| `scrollTo()` | `window.scrollTo(0, document.body.scrollHeight)` 是原生一行 |
| `extract()` 的 map DSL | 用原生 `.map()` 拼。少一套 `'a@href'` 语法要学，代价是多写两行 |
| `frame()` | `$`/`$$` 默认穿透同源 iframe（§6.1），不指望 agent 记得用 |

`$` **找不到即抛错**是刻意的：定位失败时 90% 场景该中止，别在错误状态上继续操作。需要「可能不存在」的分支判断时用 `$$` 判 `length`。

### 3.2 locator 三种形状

```js
$('button.submit')                   // CSS 选择器（字符串）
$(46)                                // uid（数字，来自 take_snapshot / query_page）
$({ role:'button', text:'登录' })     // 语义（对象）
$({ role:'textbox', near:'密码' })    // 相对定位
$({ text:'删除', nth:2 })             // 多个命中取第 3 个（0-based）
$('h2', { within: item })            // 限定在某元素内找
```

语义 locator 字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `role` | string | 复用 `content/snapshot/roles.ts` 的 `computeRole`，保证与快照口径一致 |
| `text` | string | 默认包含匹配（折叠空白后），`exact: true` 转精确 |
| `near` | string | 该文本附近的、满足其余条件的元素 |
| `nth` | number | 命中多个时取第 n 个（0-based）。不传且期望单个时，多命中触发 `locator-ambiguous` |
| `exact` | boolean | `text` 转精确匹配 |

`opts.within`：限定搜索根。抓列表逐项取字段是刚需；原生 `item.querySelector` 虽也一行，但会绕过语义定位与 iframe 穿透，故保留。

**`near` 的判定顺序**（启发式，见 §9）：

1. 显式关联：`label[for]` / `aria-labelledby` / 包裹式 `<label>`。
2. DOM 邻近：文本节点的父元素向上找共同祖先，在该祖先内查满足条件的元素，取 DOM 序最近。
3. 几何邻近：`getBoundingClientRect` 距离最近（同一视觉行优先）。

命中数与命中元素简要信息必须回 trace 让 agent 判断，不假装总对。

### 3.3 `click` 实现（修问题二的 2/3/4）

```js
async function click(el, opts = {}) {
  el.scrollIntoView({ block: 'center' });
  await raf();                                    // 等布局稳定
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;

  // 遮挡检测：命中点上的元素既不是目标、也不在目标内/外层 → 被覆盖
  const hit = el.ownerDocument.elementFromPoint(x, y);
  if (hit && !el.contains(hit) && !hit.contains(el)) {
    throw new StepError('blocked', { element: el, blockedBy: hit });
  }

  el.focus?.();                                   // 补 focus
  const init = { bubbles:true, cancelable:true, clientX:x, clientY:y,
                 view: el.ownerDocument.defaultView, detail:1 };
  const pid = { pointerId:1, isPrimary:true, pointerType:'mouse' };
  el.dispatchEvent(new PointerEvent('pointerdown', { ...init, ...pid }));
  el.dispatchEvent(new MouseEvent('mousedown', init));
  el.dispatchEvent(new PointerEvent('pointerup', { ...init, ...pid }));   // 补上
  el.dispatchEvent(new MouseEvent('mouseup', init));
  el.dispatchEvent(new MouseEvent('click', init));
  if (opts.dbl) el.dispatchEvent(new MouseEvent('dblclick', { ...init, detail:2 }));
}
```

对比现有 `content/interact.ts` 的 `doClick`：补 `pointerup`、补 `focus()`、补真实坐标、补 `view`/`detail`、加遮挡检测。

`opts.force: true` 跳过遮挡检测（目标被半透明装饰层覆盖但实际可点的场景）。

### 3.4 `type` 实现

四种目标分派，默认逐字符发键盘事件（搜索联想框需 `keydown` 才触发）：

| 目标 | 行为 |
|---|---|
| `<select>` | 按 value 精确匹配 option，未命中再按 option 文本匹配；发 `input` + `change` |
| `contenteditable` | `focus()` → 清空 → 逐字符 `beforeinput`/`input` + 更新 `textContent` |
| `<input>` / `<textarea>` | `focus()` → 清空 → 逐字符 `keydown`/`keypress`/原生 value setter/`input`/`keyup` → `change` → 不 blur |
| 其余 | 抛 `state` 类错误，说明该元素不可输入 |

- 用原生 value setter（`Object.getOwnPropertyDescriptor(proto,'value').set`）绕过 React 的值劫持——沿用现有 `doFill` 已有的做法。
- `{ instant: true }` 走快路径：直接设值 + 一次 `input`/`change`。长文本用。
- **不自动 blur**：blur 可能触发提交或校验，交给 agent 显式 `press('Tab')` 决定。

### 3.5 `waitFor` 条件形式

```js
waitFor({ role:'dialog' })                    // 元素出现（locator）
waitFor({ gone: '.loading' })                 // 元素消失（locator）
waitFor({ text: '搜索结果' })                  // 文本出现
waitFor({ idle: 500 })                        // 网络静默 500ms
waitFor(() => items.length > 10)              // 自定义谓词
waitFor(cond, { timeout: 8000, interval: 100 })
```

- 默认 `timeout: 10000`、`interval: 100`。
- `idle` 依赖 `PerformanceObserver` 观察 `resource` 条目 + 复用 Phase 3b 的 hook 计数：连续 N ms 无新请求即静默。纯前端渲染（无请求）的变化等不到，需用谓词形式（§9）。
- 返回 `{ waited: ms }` 进 trace。超时抛 `timeout` 类错误，附「已等待多久 / 条件是什么 / 当时命中数」。

### 3.6 运行时注入与 world

- **helper 跑在 ISOLATED world**（与现有 `content/interact.ts` 及 uid map 同 world），故 `$(46)` 直接复用 `resolveUid`。DOM 与事件跨 world 共享，ISOLATED 派发的事件页面框架照样收到（React 用事件委托挂 root，冒泡即达，不检查 `isTrusted`）。
- **MAIN world 作逃生舱**：`world: 'main'` 参数用于读页面 JS 变量。此时 `$(uid)` 不可用（uid map 在 ISOLATED），需用选择器或语义 locator；trace 里显式提示这一限制。
- **注入时机**：注入时挂版本标记 `globalThis.__ABE_HELPER_V = '<version>'`，每次执行前检查，缺失或版本不符才重注入。导航自然清标记 → 翻页后自动重注入。同一页连续跑 N 段脚本只注入一次。
- helper 运行时代码**不进 LLM 上下文，0 token**；估计 8~15KB。

### 3.7 脚本执行包裹

复用 `agent/tools/evaluate.ts` 的 `pageRunner` 模式（`(0, eval)` 包裹 + 错误归一化），但：

- 脚本体作为 async 函数体执行，helper 以参数注入（不污染页面全局）。
- 包裹器负责收集 trace/logs、捕获 `StepError`、序列化校验、截断（§5.5）。
- `StepError` 携带 `kind` 与结构化诊断字段，包裹器据此组装 §5.2 的失败返回。

## 4. 工具参数

### 4.1 `run_page_script`

```js
run_page_script({
  script: '...',          // 必填。async 函数体，可用 await
  world: 'isolated',      // 默认。'main' 用于读页面 JS 变量
  timeoutMs: 30000,       // 默认 30s（脚本含多个 waitFor），上限 120000
  screenshot: 'never',    // 'never'（默认）| 'on-failure' | 'always'
})
```

`timeoutMs` 默认远大于 `evaluate_script` 的 5s——脚本内含多次 `waitFor` 是常态。超时时**返回已完成的 trace**（不是干巴巴一句超时），agent 能看出卡在第几步、那步等的什么条件。

### 4.2 schema description 里的速查表（约 180 tokens，常驻）

```
可用 helper（详细用法与示例调 load_skill('page-script')）：
$(loc,opts?) $$(loc,opts?) click(el,opts?) type(el,val,opts?) hover(el)
press(key) waitFor(cond,opts?) text(el) log(...) expect(cond,msg)
loc = 'CSS选择器' | uid数字 | {role,text,near,nth,exact}
opts.within 限定范围内查找；$ 找不到即抛错，用 $$ 判 length
waitFor: {role}出现 {gone}消失 {text}文本 {idle:ms}网络静默 ()=>bool
```

只放签名，不含说明与示例。目的是即使 agent 不加载文档也不会凭空造 `$x()` / `page.click()` 这类别处见过的 API（§7）。

## 5. 返回值

设计原则：**成功极简、失败极详**。这个不对称是控制成本的关键。

### 5.1 成功

```js
{
  ok: true,
  url: 'https://www.zhihu.com/search?q=React',   // 有变化时附 urlFrom
  elapsed: 2140,
  trace: [
    { i:1, op:'$',       on:'combobox "搜索"' },
    { i:2, op:'type',    on:'combobox "搜索"', value:'React 性能优化' },
    { i:3, op:'press',   key:'Enter' },
    { i:4, op:'waitFor', cond:'idle 600', waited:1240 },
    { i:5, op:'$$',      matched:20, sel:'.SearchResult-Card' },
  ],
  logs: ['搜索页已加载 https://...'],
  data: [ /* 脚本 return 的值 */ ],
  pageErrors: 0,
}
```

- 成功步骤一行 15~25 tokens，10 步约 200 tokens。`click` 内部的 6 个事件成功时**完全不记**，失败时才展开。
- **例外：locator 命中数 ≠ 1 时必须显示。** `{ op:'click', matched:3, on:'button "删除"' }`——三个「删除」点了第一个，属「执行成功但可能干错事」，静默最危险。

### 5.2 失败

```js
{
  ok: false,
  kind: 'blocked',
  error: '点击被遮挡：目标 <button class="submit"> 被 <div class="cookie-banner"> 覆盖',
  failedAt: {
    i: 3, op: 'click',
    locator: { role:'button', text:'提交' },
    matched: 1,
    element: { tag:'button', class:'submit', text:'提交',
               rect:{x:120,y:890,w:88,h:36}, visible:true, disabled:false, inViewport:true },
    blockedBy: { tag:'div', class:'cookie-banner', text:'本站使用 Cookie…' },
  },
  trace: [ /* 前 2 步成功记录 */ ],
  logs: [ /* 中止前埋点 */ ],
  hint: '页面有 cookie 提示条遮挡目标。可先关闭它（找"同意"/"接受"按钮点掉），或滚动使目标离开遮挡区域后重试。',
  pageErrors: 0,
  url: 'https://...',
}
```

### 5.3 `kind` 八分类

每类对应一个明确不同的修复方向——这是诊断体系的骨架。

| kind | 含义 | agent 该怎么改 |
|---|---|---|
| `locator-miss` | 匹配 0 个 | 定位符错了。换文本/角色，或先探查 |
| `locator-ambiguous` | 期望 1 个但匹配 N 个 | 加 `nth` 或 `within` 收窄（附 N 个的简要信息供挑选） |
| `blocked` | 找到了但被遮挡 | 先处理遮挡物 |
| `state` | 找到了但 disabled/readonly/隐藏/不可输入 | 前置条件没满足，先做别的 |
| `timeout` | `waitFor` 超时 | 条件写错，或页面真没变化 |
| `assert` | `expect()` 失败 | 逻辑判断不成立，重新理解页面 |
| `script-error` | agent 代码本身错（`ReferenceError` 等） | 改代码。未定义函数名不在 helper 清单时，hint 引导 `load_skill('page-script')` |
| `page-error` | 页面 JS 在操作期间抛错 | 操作触发了页面 bug，换路径 |

**`locator-miss` 多给一层诊断**（最高频失败，逐级放宽 + nearMiss 让 agent 一次修对）：

```js
{
  kind: 'locator-miss',
  error: '未找到匹配 { role:"button", text:"下一页" } 的元素',
  failedAt: {
    i:4, op:'$', locator:{ role:'button', text:'下一页' }, matched:0,
    relaxed: {
      'text 精确匹配（忽略 role）': 0,
      'text 包含匹配（忽略 role）': 1,      // ← 关键线索
      'role=button 全部': 12,
    },
    nearMiss: [ { tag:'a', class:'next-page', text:'下一页 ›' } ],
  },
  hint: '有一个元素文本为"下一页 ›"（含额外字符），但它是 <a> 不是 button。改用 { text:"下一页" } 不限 role，或直接用选择器 a.next-page。',
}
```

`nearMiss` 上限 3 条。`relaxed` 各档命中数为 0 时也列出（「全都是 0」本身是信息：可能整个区域还没渲染）。

`locator-ambiguous` 附命中元素简要信息（上限 5 条，每条 `{tag, class, text}` 截 40 字符）。

### 5.4 截图（兜底通道）

`screenshot` 参数默认 `'never'`。理由：失败大多能从结构化诊断看明白（尤其 `locator-miss` 有 relaxed + nearMiss），花约 1.5k tokens 截图是浪费。

`assert` 与 `timeout` 两类属「trace 都正常但结果不对」，其 hint 主动附一句：「如需看页面实况，重跑时传 `screenshot:'on-failure'`」。

截图复用 `agent/tools/screenshot.ts` 的 `doScreenshot`（含 `screenshotPolicy: 'never'` 设置门控——设置禁用时即使传参也不截，返回值里注明）。图片按现有 `take_screenshot` 路径注入（tool 消息 + 后续 user 图片消息），受 `trimImageParts` 管理。

### 5.5 截断策略

| 字段 | 上限 | 超限行为 |
|---|---|---|
| `data` | 8192 字符（UTF-16 code units，与 `js-balance` 的 `bytes` 同口径；英文约 2k tokens、中文约 8k） | 截断 + `dataTruncated: {returned, total, hint:'用 slice 分批取，或在脚本里先聚合'}` |
| `trace` | 50 步 | 保留前 15 + 后 15 + `{ collapsed: N }` |
| `logs` | 30 条 / 每条 500 字符 | 丢弃最早的，标注丢弃数 |
| `nearMiss` | 3 条 | 直接截断 |
| `ambiguous` 候选 | 5 条 | 直接截断 |

序列化沿用 `evaluate_script` 已有教训：DOM 节点拒绝返回，错误提示「取 `text(el)` 或 `.href` 而非节点本身」。深度上限 6 层、数组元素上限 200，超限位置留 `'[已截断]'` 标记。

`pageErrors` 复用 Phase 3b 的 MAIN world hook 缓冲（`background/observe-store.ts`）：成功时只给数字，失败时附最后一条。关键价值是区分「我的脚本错了」与「我触发了页面 bug」——修复方向相反。

## 6. 渐进式感知

### 6.1 iframe 默认穿透

`$` / `$$` 自动进同源 iframe 查找，命中时 trace 标明 frame（`{ op:'$', on:'button "提交"', frame:'iframe#pay' }`）。

跨域 iframe 无法穿透（浏览器限制），trace 附 `skippedFrames: N` 明确标注，让 agent 知道有看不到的区域，而不是以为页面就这些内容。

同样应用于 `take_snapshot`：`buildSnapshot` 遍历时递归进同源 `iframe.contentDocument`，节点预算全局共享（不因 iframe 翻倍），序列化时以 `Iframe "src"` 行标记边界并缩进子树。

### 6.2 `take_snapshot` 分级

新增 `detail` 参数：

| 档位 | 内容 | 实测 tokens |
|---|---|---|
| `interactive`（**新默认**） | 可交互元素 + 标题 + 视口内文本 | ~4k（省 54%） |
| `full` | 现全量行为 | ~10k |
| `region: uid \| 选择器` | 只倒某容器子树 | 几百 |

另加两项**全档位生效**的瘦身（实测省 34%，与分级叠加）：

1. **去重 StaticText**：文本与父节点 `name` 相同且共享同一 uid 时不输出。
2. **短 URL**：`url` 属性只留 path + 查询串前 30 字符，同源省略 origin；超 40 字符前缀省略号。

`interactive` 档的「可交互角色」白名单：`link, button, textbox, combobox, checkbox, radio, option, tab, switch, menuitem, slider, heading`，加 `RootWebArea`。非白名单节点折叠为 `… [N 个纯文本/容器节点已折叠]` 计数行（保留结构感，让 agent 知道那里有东西可以 `region` 深入）。

视口判定：`getBoundingClientRect` 与视口相交。视口外的**可交互元素仍保留**（agent 常需要点击页面下方的按钮），只有非交互文本按视口过滤。

### 6.3 `query_page` 工具

```js
query_page({
  locator: { role:'textbox', near:'搜索' },   // 与脚本内 $ 同一套语法
  limit: 5,                                   // 默认 5，上限 20
})
```

返回命中元素的快照格式行（含 uid，可直接给 click/fill，也可原样搬进脚本）：

```
[46] combobox "搜索" placeholder="搜索话题、问题或人"
```

命中 0 个时返回与 §5.3 同构的 `relaxed` + `nearMiss` 诊断——探查阶段就把定位符调对，不带错进脚本。

**探查与执行共用同一套定位语言**是关键：agent 用 `query_page` 试出能命中的 locator，原样搬进脚本，不用换语言。

### 6.4 `wait_for` 扩展

现有 `content/wait.ts` 只支持文本包含匹配。扩展为与 `waitFor` 同一套条件形式（`{role}` / `{gone}` / `{text}` / `{idle}`），谓词形式除外（工具参数无法传函数）。

**向后兼容**：现有 payload 的 `texts: string[]`（任一命中即成功）保持支持，等价于 `{ text: [...] }`。新条件形式为追加的可选形状，不改既有调用。

### 6.5 工具计数与登记

工具 30 → 32（新增 `run_page_script`、`query_page`）。三处登记必须同步：

| 位置 | 内容 |
|---|---|
| `components/debug/tool-tags.ts` | 两者均为 `PAGE`（PAGE 组 10 → 12） |
| `agent/mode.ts` 的 `ASK_MODE_TOOLS` | **只加 `query_page`**（纯读，与 `take_snapshot` 同性质）。`run_page_script` 执行动作，不进 ask 白名单 |
| `agent/tools/registry.ts` | 两者都需受限页预检；`run_page_script` 与 `evaluate_script` 同分支，`query_page` 走 CS 通道（新增 `QUERY` 请求类型） |

## 7. helper API 文档走 skill

### 7.1 投放

`public/skills/builtin.md` 追加第四篇文档：

```yaml
---
name: 页面脚本 API
description: 编写页内批量执行脚本的 helper 函数参考；调用 run_page_script 前加载
command: page-script
---
```

正文为 helper API 全文（估计 2~3k tokens）：10 个函数的完整签名与 opts、locator 三形状与 `near` 判定顺序、5 个成品示例（搜索抓取 / 翻页收集 / 无限滚动 / hover 展开 / 填表提交）、返回值形状、8 类失败的修复指引。

链路全部现成：`seedBuiltinSkills` 在 onInstalled 覆盖更新且保留用户启停状态（helper 改版时文档随扩展走），`load_skill` 拉正文，简述每轮进 system prompt。

### 7.2 成本对比

| 方案 | 常驻成本 | 20 轮任务总计 |
|---|---|---|
| API 全文进 schema | 3k tokens/轮 | 60k |
| **skill 按需**（本方案） | 30（简述）+ 180（速查表） | ~4.2k（含 1 次拉全文 3k） |

### 7.3 幻觉兜底

`load_skill` 是遵循式的，无机制强制先加载。现有三个内置技能描述**流程**（猜错顶多不标准），但 helper API 是**契约**——函数名错一个字整段作废，且 agent 容易把 `$x is not defined` 误诊成页面结构问题，在错误方向上重试。

两道防线：

1. **速查表常驻 schema**（§4.2）：函数名都在眼前，不会凭空造。
2. **执行层引导**：捕获 `ReferenceError: X is not defined` 且 X 不在 helper 清单内时，返回 `kind: 'script-error'` 并在 hint 写「未定义的函数 X —— 本运行时可用函数见 `load_skill('page-script')`」。把幻觉引导回文档，而非让 agent 瞎猜。

与现有「教学式纠正」（`finishReason=length` 时给分步指引）同一套路。

## 8. 数据流

```
面板 → agent loop
  → executeTool('run_page_script', {script, world, timeoutMs, screenshot})
    → 受限页预检（RESTRICTED 正则，同 evaluate_script）
    → 检查/注入 helper 运行时（版本标记比对）
    → scripting.executeScript(world, func: scriptRunner, args:[script])
      → 页内：注入 helper 为参数 → 执行脚本体 → 收集 trace/logs
        → 成功：序列化 + 截断 → { ok:true, trace, logs, data }
        → StepError：组装 kind + failedAt + hint → { ok:false, ... }
    → 合并 pageErrors（读 observe-store 该 tab 缓冲）
    → screenshot != 'never' 且需要时 → doScreenshot
  → tool 消息进历史（截图另发 user 图片消息）
```

`run_page_script` 归入需受限页预检的分支（与 `evaluate_script` 同位置）。`query_page` 走 content script 通道（新增 `QUERY` 请求类型），与 `SNAPSHOT` 同批。

## 9. 已知限制

1. **`near` 是启发式**：显式 label 关联优先，其后按 DOM 与几何距离猜，会有猜错的时候。缓解：命中数与命中元素信息回 trace 让 agent 判断。
2. **`type()` 默认逐字符慢**：长文本需显式 `{instant:true}`。默认选兼容而非快——搜索联想框依赖 `keydown`。
3. **`waitFor({idle})` 依赖网络静默**：纯前端渲染（无请求）的变化等不到，需改用谓词形式。文档里明确写这一点。
4. **ISOLATED 派发事件 `isTrusted` 为 false**：React 等事件委托框架不受影响，少数校验 `isTrusted` 的库会拒。这是扩展的硬边界（只有 CDP/debugger 能发真事件）。
5. **`world:'main'` 时 `$(uid)` 不可用**（uid map 在 ISOLATED）。trace 显式提示。
6. **跨域 iframe 不可穿透**：浏览器限制。仅以 `skippedFrames` 计数告知存在盲区。
7. **一次往返干 N 步 = 错误也批量发生**：脚本出错可能留下半完成的页面状态（填了一半、点开了弹窗）。缓解：trace 精确到步，让 agent 知道走到哪了；`expect()` 失败即中止，不在错误状态上继续。
8. **`interactive` 档可能漏掉 agent 需要的非交互文本**（如纯文本价格、状态提示）。缓解：折叠计数行保留结构感，`region` 可深入；必要时退回 `full`。
9. **`elementFromPoint` 遮挡检测对 `pointer-events:none` 的装饰层会误报**：该层不拦事件但会被 `elementFromPoint` 命中。缓解：检测时跳过计算样式 `pointer-events:none` 的元素；仍误报时用 `{force:true}`。
10. **helper 运行时与页面同 DOM，脚本可能被页面 MutationObserver 察觉**（与现有 `interact.ts` 同等级暴露，非新增风险）。

## 10. 明确不做（v1）

| 不做 | 理由 |
|---|---|
| CDP / debugger 真事件注入 | 需 `debugger` 权限、会显示「正在调试」横幅、与现有架构差异大。仅当限制 4 成为实际阻塞时再评估 |
| 视觉坐标定位（按截图目测坐标点击） | 响应式布局 + 懒加载使坐标不稳定；模型坐标精度是当前最弱能力之一；选择器定位精确几个数量级 |
| 脚本沉淀进脚本池复用 | 任务画像是陌生站一次性探索（§1.1），复用价值低。探索出的有效选择器可落 Agent 记忆（已有站点作用域），成本更低 |
| 跨域 iframe 穿透 | 浏览器安全边界，无解 |
| `extract()` 的 map DSL / 更宽的 helper 面 | 原则 1。窄 API 好记不易错，复杂场景用原生拼 |
| 删除 `take_snapshot` 的 `full` 档 | 部分场景（理解整页结构、找不到目标时兜底）仍需要全量 |
| 移除 `evaluate_script` | 单次求值场景（读一个变量、算一个值）仍比写脚本轻。两者共存，分工写进两者 schema：**求值用 `evaluate_script`（无 helper、5s 默认超时、返回裸值），多步操作用 `run_page_script`（有 helper、30s 默认超时、返回 trace）** |

## 11. 测试

**纯函数（jsdom）**

- locator 解析与匹配：三种形状、`nth`、`exact`、`within`、`near` 三级判定顺序、命中 0/1/N。
- `relaxed` 逐级放宽与 `nearMiss` 挑选逻辑。
- 快照瘦身：StaticText 去重、短 URL、`interactive` 档白名单过滤与折叠计数、`region` 限定。
- 截断：`data` 8KB / `trace` 50 步折叠 / `logs` 30 条 / 深度与数组上限。
- 序列化拒绝 DOM 节点、错误归一化（沿用 `pageRunner` 的 describeError 用例）。
- `kind` 八分类映射：各类 `StepError` → 返回值形状与 hint 文案。
- helper 版本标记比对（注入/跳过注入的判定）。

**事件序列（jsdom 可测部分）**

- `click` 派发顺序与事件属性（含 `pointerup`、`focus` 调用、`detail`）。jsdom 的 `elementFromPoint` 与 `getBoundingClientRect` 恒返回 0，遮挡检测与真实坐标只能测「调用了」不能测「值正确」，真实浏览器手工验证。
- `type` 四种目标分派、原生 setter 调用、`instant` 快路径、不 blur。
- `waitFor` 四种条件形式的轮询与超时返回（含超时时 trace 完整）。

**集成（手工，真实浏览器）**

- 五个成品示例在真实站点跑通（搜索抓取 / 翻页 / 无限滚动 / hover 展开 / 填表）。
- 遮挡检测：cookie 横幅覆盖按钮场景。
- iframe 穿透：同源 iframe 内表单；跨域 iframe 的 `skippedFrames` 计数。
- React / Vue 站点的 `type` 联想框触发。
- 快照分级的真实 token 量对比（验证 ~4k 的估算）。

## 12. 落地顺序

单份 spec，实施分三阶段（每阶段可独立验证、独立合并）：

1. **感知层**：快照瘦身（去重 + 短 URL）+ 分级 + iframe 遍历 + `query_page`。产出：单次探查成本立降，与脚本运行时无耦合。
2. **脚本运行时**：helper 10 函数 + `run_page_script` + 返回值与诊断 + 注入管理。依赖阶段 1 的 locator 实现（`query_page` 与 `$` 共用）。
3. **收尾**：`page-script` 技能文档 + 速查表进 schema + `wait_for` 扩展 + SYSTEM_PROMPT 订正。

`SYSTEM_PROMPT` 的具体改动（现文案第 1~3 条围绕「先 take_snapshot 再逐个动作」，与新模式冲突）：

- 第 1 条改为：先 `query_page` 定向查询或 `take_snapshot`（默认 `interactive` 档）看结构，**多步操作优先用 `run_page_script` 一次执行完**，单个动作才用 click/fill。
- 保留 uid stale 规则（`take_snapshot` + click/fill 路径仍在）。
- 补一条工具分工：单次求值用 `evaluate_script`，多步操作用 `run_page_script`。

注意 `resolveSystemPrompt` 的覆盖边界——用户自定义提示词会**完整替换** `SYSTEM_PROMPT`，故这些引导对已自定义的用户不生效。这是既有取舍（见 2026-09-07 系统提示词 spec §2.3），本设计不额外补偿；但速查表在 schema 里（每轮下发，不受覆盖影响）保证了基本可用性。

阶段 1 与 2 之间 locator 实现共用，故先做 1 能让 2 的定位逻辑已经过真实验证。
