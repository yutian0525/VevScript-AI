# AI 对话输出 Markdown 渲染设计

日期：2026-09-02
状态：已确认（用户批准 2026-09-02）

## 背景与目标

侧边栏聊天视图中 assistant 消息目前以纯文本渲染（`ChatView.tsx` 的 `{item.text}`，`white-space: pre-wrap`）。AI 输出天然携带 Markdown 格式（标题、列表、代码块、表格），纯文本显示导致格式标记裸露、可读性差。

目标：assistant 消息正文按 Markdown（GFM）渲染，与现有设计系统（tokens、`.well` 代码井、双声道排版）视觉一致，流式输出体验良好，且不引入 XSS 面。

## 决策记录

| 决策点 | 选择 | 备选与否决理由 |
|---|---|---|
| 渲染范围 | 仅 assistant 消息 | user 消息保持纯文本气泡，改动最小、用户输入语义不被意外格式化 |
| 库 | react-markdown + remark-gfm | 否决 marked + DOMPurify（绕过 React 逃生舱、需引两个库）；否决手写解析器（嵌套列表/表格边界 case 维护成本高） |
| 流式策略 | 每帧全量文本重渲染 | react-markdown 默认行为，未闭合标记自然不渲染为格式，无需节流/分段复杂度 |
| 代码块 | 纯样式，无复制按钮/语法高亮 | 高亮库体积与配色适配留待后续迭代 |
| 语法范围 | GFM（表格、删除线、任务列表、自动链接） | 匹配 AI 输出习惯 |

## 架构

新增 `components/chat/Markdown.tsx`：

```tsx
export function Markdown({ text }: { text: string })
```

纯渲染组件：字符串 → React 元素树。不知道 store、不知道流式状态。内部 `ReactMarkdown` + `remark-gfm`，通过 `components` 覆盖表定制元素。将来 reasoning 块需要渲染时直接复用。

ChatView 唯一改动：assistant 正文 `{item.text}` → `<Markdown text={item.text} />`（`ChatView.tsx:225` 处）。user/error/reasoning/toolcard 均不动，现有纯文本路径保持。

### 依赖

package.json 新增两个运行时依赖：`react-markdown`、`remark-gfm`（均 v9+，React 19 兼容）。

## 流式行为

- 流式期间每帧对全量文本重新解析，React 元素树 diff 由 React 处理，实测开销可接受。
- 未闭合标记（如写到一半的 `**bo`）不渲染为格式，视觉上逐字浮现、格式到位——标准 AI 聊天行为。
- **caret 光标**：`.msg-assistant.caret` 的 CSS `::after` 在块级元素后位置漂移，改为 Markdown 组件在流式时（`streaming` prop 为 true）于渲染内容尾部追加内联 `<span className="caret-dot">`，光标始终紧跟末字符。CSS 侧移除/停用原 `caret` 伪元素方案对 assistant 正文的作用。
- **white-space**：`.msg-assistant` 移除 `pre-wrap`（保留 `word-break: break-word`），换行语义交给 Markdown 块级结构，由 `.md` 容器接管排版。

## 元素定制（components 覆盖表）

| 元素 | 定制 | 理由 |
|---|---|---|
| 行内 `code` | `className="md-code"`，mono + `--sunken` 底 | 双声道排版：机器语言 mono |
| 代码块 `pre` | 复用 `.well` 视觉 + 顶部语言标签（`--ink-3` 10px mono） | 项目已有代码井语言 |
| `a` | `target="_blank"` + `rel="noreferrer noopener"` | 扩展页防自导航 |
| `table` | 包横向滚动容器 `.md-table-scroll` | 侧边栏窄，GFM 表格溢出 |
| `img` | 拒绝渲染（返回 null） | 正文不应有图片，杜绝 dataURL/外链注入 |

其余元素走 react-markdown 默认渲染，样式由 `.md` 容器类 CSS 约束。

### 安全性

react-markdown 默认不渲染原始 HTML（未启用 `rehype-raw`，自动转义）；URL scheme 默认过滤（`javascript:` 等被清除）；`img` 显式禁用。**不引入 DOMPurify**，React 元素树即安全边界。项目保持零 `dangerouslySetInnerHTML`。

## 样式（entrypoints/sidepanel/styles.css）

新增 `.md` 容器类，全部使用现有 CSS 变量，零硬编码色值：

- 标题 `h1-h4`：sans，字号从正文 13.5px 向下压（12px / 12.5px 档位），`--ink` 加粗；不喧宾夺主
- `p`：`margin: 0 0 8px`（末段 margin-bottom 0 由 `:last-child` 处理）
- `ul/ol`：`padding-left: 18px`，项间距 4px
- `blockquote`：左 2px `var(--signal)` 边 + `var(--signal-wash)` 底，内边 6px 10px
- 行内 `code`（`.md-code`）：`var(--sunken)` 底、`--r-sm` 圆角、mono 12.5px
- 代码块：`.well` 同款 `--sunken` 底 + mono 12.5px + 语言标签
- `table`：`--line` 边线、表头 `--sunken` 底、单元格 padding 4px 8px、`word-break: break-word`
- `hr`：`--line-strong` 1px
- 任务列表 checkbox：原生样式，`accent-color: var(--signal)`
- 链接：`var(--signal-ink)`，hover 下划线
- 删除线：默认

无新增动画，无需 reduced-motion 处理。

## 测试（tests/markdown.test.tsx，vitest + jsdom）

1. 渲染冒烟：标题/粗体/列表/表格/代码块各渲染出对应 DOM 结构
2. XSS 防御：`<script>alert(1)</script>`、`<img onerror=...>` 输入 → DOM 无 script/img 节点
3. 链接安全：markdown 链接带 `_blank` + `noreferrer`
4. 空文本：`text=""` 不崩、无多余节点
5. 流式增量：`"**bo"` 渲染纯文本，`"**bold**"` 渲染 `<strong>`

## 验收

- `npm run compile`、`npm run test` 通过
- 手动确认：流式输出格式渐进出现、代码块/表格在窄侧边栏可读、caret 紧跟末字符

## 非目标

- 代码块复制按钮、语法高亮（后续迭代）
- user 消息、reasoning 块的 Markdown 渲染
- 消息级「原文/渲染」切换视图
