# take_snapshot 完整内容树改造 · 设计

日期：2026-09-01
状态：待实现
相关文件：`content/snapshot/build.ts`、`content/snapshot/roles.ts`、`content/snapshot/visibility.ts`（`agent/context.ts`、`content/interact.ts` 不改，仅作回归验证）

## 背景与问题

`take_snapshot` 返回的内容远少于 Chrome MCP 对同一页面的快照（实测 13 行 vs 94 行）。模型只能看到导航骨架，看不见页面主体内容（列表项、卡片文字、按钮文案），因而既无法理解页面，也无法定位「使用模板」这类点击区。

这不是 bug，是当前实现的设计取向——它是一个「可交互元素清单」，而非「完整内容树」。三处过滤共同造成内容缺失：

1. **`shouldEmit` 丢弃所有 `generic` 无名节点**（`build.ts`）。页面里的 `<div>/<span>/<p>` 都算 `generic`，于是「模板 5」「供应商准入排查」「使用模板」等纯文本内容整片消失。
2. **只有 9 种可交互 role 能拿 uid**（`roles.ts` 的 `INTERACTIVE_ROLES`）。卡片上的「预览/使用模板/收藏」在 React SPA 里多是绑在 `div` 上的点击区，不是 `<button>`，于是既没 uid 又被 `shouldEmit` 丢掉——模型看不到、也点不了。
3. **遍历只走 `elem.children`（Element），从不产出独立文本节点**。文本只能作为某具名元素的 `name` 露出，且被截到 100 字符。

附带缺失：根节点没有 `RootWebArea`（URL/title 被塞进 system prompt 而非快照里）、缺 `haspopup`/`autocomplete`/`selectable` 状态、链接不带 `url`、无隐藏子菜单的 `description` 聚合。

## 目标

把 `take_snapshot` 从「可交互元素清单」升级为「完整内容树」，对齐 Chrome MCP 的信息密度，同时保持前后台通信与点击链路不变。

设计取向（已与用户确认）：

1. **完整内容树**——保留 StaticText、generic 容器、url、description。
2. **每个出现在树里的节点都带 `[uid]`、可点**。
3. **节点数上限 + 截断标记**兜底大页面。
4. **隐藏子菜单聚合成 `description` 摘要**（对齐 Chrome）。

## 非目标

- 不改 uid 输出格式（保留 `[N]`，不换成 Chrome 的 `uid=1_N`）——`interact.ts`、click/fill schema、聊天卡片全按 `[N]` 约定，改格式牵连广、收益为零。
- 不支持跨 iframe / 跨 frame 编号。
- 不做视口优先 / 离屏折叠（大页面先用节点数上限兜底）。
- 不改 `interact.ts`（uid→Element 语义不变）、不改 `agent/context.ts`（`pageBlock` 保留）。

## 设计

### 1. 遍历与产出模型（`build.ts`）

**遍历从 `children` 换成 `childNodes`**，以便看见 DOM 文本节点。对每个节点分三类处理：

- **Element**：计算 role / name / states / description / extras，进 uidMap（映射到自身），递归其 `childNodes`（含 open shadow root 的 childNodes）。
- **Text 节点（非纯空白）**：产出一行 `StaticText "文本"`。它的 uid **映射到父 Element**（复用父元素的 WeakRef，不新建映射目标）。同一父下多个文本节点各自成行，但 uid 都指向同一个父元素——点任意一行即触发父元素的点击区。
- **空白文本 / 注释 / 隐藏节点**：跳过（隐藏节点的文本另由 `computeDescription` 收集，见 §2）。

**产出规则 `shouldEmit` 放开**（解决「内容少」的核心）。凡满足「可见 且（有 role 语义 / 有名字 / 是非空文本 / 有 uid）」的节点都输出。仅折叠**纯布局包裹**：`generic` 且无名、无 description 的容器不单独成行，其子节点上提到当前缩进层——与 Chrome 不给每个 `<div>` 套壳编号的行为一致。

**每个输出节点都带 `[uid]`**：Element 用自身引用，StaticText 用父元素引用。`resolveUid` 语义不变（`WeakRef<Element>` + `isConnected` 判 stale），故 click / hover / fill 零改动。

**根节点**输出为 `RootWebArea "标题" url="..."`，让快照自带页面身份。`agent/context.ts` 的 `pageBlock` **保留不动**：它在「尚未调用 take_snapshot」时为模型提供当前页 URL/title，与快照内的 `RootWebArea`（调用后才有）互补，不冲突。此项不改 `context.ts`。

**大页面兜底**：`maxNodes` 上限保留；因现在文本节点也计入产出，默认值从 2000 调整到约 1200 个「产出行」。命中上限时追加尾行 `… [还有 N 个节点未显示，快照已截断]`，让模型知道树不完整。`maxChildrenPerLevel` 同级折叠机制保留。

### 2. 节点元数据（`roles.ts`）

**`computeName` 收窄为「仅可见后代文本」**。当前 `computeName` 用 `el.textContent` 会把隐藏子菜单一并吞入名字（如 `营销` 变成一长串）。改为只聚合可见后代文本 → 名字回归 `"营销"`。aria-label / labelledby / placeholder / alt 的优先级不变。

**新增 `computeDescription`（隐藏内容聚合）**。仅对 link / button / generic 容器计算：遍历后代，收集**被 `isHidden` 判定为隐藏**的文本（悬停子菜单、tooltip 等），空格拼接并截断到约 200 字。这些内容让模型「知道菜单里有什么」，但不单独编 uid（要点得先 hover 展开再重拍）——与 Chrome 一致。

**新增 `computeExtras`**，补齐 Chrome 有而当前缺的字段：

- `url="..."`：link 的 `href` 解析为绝对地址。
- `haspopup="..."`：取自 `aria-haspopup`。
- `autocomplete="..."`：取自 input 的 `autocomplete` 或 `aria-autocomplete`。
- `selectable`：tab / option 的可选标记。

**`computeStates` 补 `selected`**（现有 disabled / checked / expanded 保留）。

**role 映射扩充**：补 `tablist`、`tab`（带 selectable / selected）、`tabpanel`、`combobox`（带 haspopup）等，使 tab 结构显示正确。`INTERACTIVE_ROLES` 的用途弱化——现在所有产出节点都编 uid，`isInteractive` 仅用于个别语义判断（如是否算 description 目标），不再是「能否编号」的闸门。

### 3. 输出格式（`build.ts` 的 `serialize`）

保留 `[uid] role "name" {states}` 基础格式，字段顺序：

```
[uid] role "name" haspopup="..." autocomplete="..." {states} description="..." url="..."
```

`description` / `url` 置于行尾（最长）。name 内双引号继续转义。`NO_NAME_FROM_CONTENT`（地标角色不取后代文本为名）逻辑保留。

### 数据流（不变）

```
content: buildSnapshot(document.documentElement)
  → { text } 经 CS→BG→run-turn→loop→provider
  → 作为 tool 结果进模型上下文
```

uid → Element 的映射仍是 `content/snapshot/build.ts` 的模块级 `uidMap`，`interact.ts` 通过 `resolveUid` 消费。快照与交互在同一 content script 上下文，映射天然共享。

## 测试

扩充 `tests/content/snapshot/`：

- **`build.test.ts`**：新增「StaticText 独立成行且带 uid」「纯布局 div 折叠、子节点上提」「generic 有 description 时保留、无 description 时折叠」「RootWebArea 根行含 url/title」「StaticText 的 uid 解析回父元素」「maxNodes 命中输出『还有 N 个』截断标记」。现有 10 条大部分保留，个别断言随格式微调。
- **`roles.test.ts`**：新增 `computeDescription`（隐藏后代聚合、可见文本不进 description）、`computeName`（只取可见、不吞隐藏子菜单）、`computeExtras`（url 绝对化 / haspopup / autocomplete）、`computeStates` 的 `selected`。
- **`interact.test.ts`**：零改动，作为「点击链路不受影响」的回归证据。

## 风险与权衡

- **token 成本上升**：完整内容树比清单大得多，且快照在 agent loop 中反复重发。`maxNodes` 上限是第一道闸；若实测仍偏大，后续可加 token 预算封顶或视口折叠（本次非目标）。
- **jsdom 限制**：`getBoundingClientRect` 恒返回 0、不渲染布局，故 0 尺寸过滤仍留给真实运行时，单测只覆盖 style / 属性 / 标签维度（沿用现状）。
- **StaticText uid 复用父元素**：同一父下多个文本行 uid 相同——这是有意为之（点哪行都点父元素），但意味着 uid 不再与「产出行」一一对应。文档与 schema 描述需说明「uid 定位到可点元素，不保证逐行唯一」。
- **description 聚合遍历隐藏子树**：额外一次后代遍历，但仅对 link/button/容器触发，成本可控。
