# Markdown 渲染实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 侧边栏聊天的 assistant 消息正文按 GFM Markdown 渲染（流式渐进、贴合现有设计系统、零 XSS 面）。

**Architecture:** 新增纯渲染组件 `components/chat/Markdown.tsx`（react-markdown + remark-gfm，components 覆盖表定制 code/pre/a/table/img），ChatView 一行替换 `{item.text}`，样式走 styles.css 新增 `.md` 容器类（全部用现有 CSS 变量）。流式期间每帧全量重渲染，caret 由 CSS 伪元素改为组件内内联 span。

**Tech Stack:** react-markdown@10、remark-gfm@4、@testing-library/react + @testing-library/jest-dom（dev）、vitest v4 + jsdom。

**Spec:** `docs/superpowers/specs/2026-09-02-markdown-rendering-design.md`

**关键背景（执行者必读）：**

- 项目是 WXT + React 19 + TypeScript 扩展，样式全部集中在 `entrypoints/sidepanel/styles.css`，禁止硬编码色值（只用 `:root` 里的 CSS 变量，见下）。
- 现有渲染点：`components/chat/ChatView.tsx:225` 的 `{item.text}`（纯文本 + `white-space: pre-wrap`）。
- 现有 CSS 变量（styles.css:6-41）：`--paper --surface --sunken --ink --ink-2 --ink-3 --line --line-strong --signal --signal-ink --signal-wash --ok --ok-wash --err --err-wash --warn --warn-wash --mono --sans --r-sm --r-md --r-lg --ease --t-fast --t-mid --t-slow`。
- 代码井 `.well`（styles.css:458）是项目现成的"机器语言块"视觉（mono + `--sunken` 底 + `--line` 边），Markdown 代码块复用该语言。
- 流式状态：`MessageRow` 已接收 `streaming` prop（`ChatView.tsx:141`，仅最后一条 running 时为 true）。
- 项目测试：vitest v4 + `WxtVitest()` 插件（`vitest.config.ts`），现有测试全是 `.ts` 纯逻辑测试，本计划新增首个 `.tsx` 组件测试。
- commit 规范：中文 conventional commits（`feat:`/`test:`/`style:` 前缀）。

---

### Task 1: 安装依赖

**Files:**
- Modify: `package.json`（npm 自动改）

- [ ] **Step 1: 安装运行时依赖**

```bash
npm install react-markdown@10 remark-gfm@4
```

预期：package.json `dependencies` 多出 `"react-markdown": "^10.1.0"`、`"remark-gfm": "^4.0.1"`，安装无 peer 冲突（react-markdown@10 peer 是 `react: >=18`，本项目 React 19 满足）。

- [ ] **Step 2: 安装测试依赖**

```bash
npm install -D @testing-library/react @testing-library/jest-dom
```

预期：devDependencies 多出 `@testing-library/react@16.x`、`@testing-library/jest-dom@7.x`。

- [ ] **Step 3: 验证安装**

```bash
npm run compile
```

预期：通过（此时还没写新代码，只确认依赖没破坏类型环境）。

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: 引入 react-markdown/remark-gfm 与 testing-library 依赖"
```

---

### Task 2: Markdown 组件（TDD）

**Files:**
- Create: `components/chat/Markdown.tsx`
- Test: `tests/chat/markdown.test.tsx`

- [ ] **Step 1: 写失败测试（渲染冒烟 + XSS + 链接 + 空文本 + 流式增量）**

创建 `tests/chat/markdown.test.tsx`：

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Markdown } from '../../components/chat/Markdown';

afterEach(cleanup);

describe('Markdown 组件', () => {
  it('标题渲染为对应层级', () => {
    render(<Markdown text={'## 标题二'} />);
    expect(screen.getByRole('heading', { level: 2, name: '标题二' })).toBeTruthy();
  });

  it('粗体渲染为 strong', () => {
    render(<Markdown text={'**加粗**'} />);
    expect(screen.getByText('加粗').tagName).toBe('STRONG');
  });

  it('无序列表渲染 li', () => {
    render(<Markdown text={'- 甲\n- 乙'} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('GFM 表格渲染 thead/tbody', () => {
    render(<Markdown text={'| a | b |\n| --- | --- |\n| 1 | 2 |'} />);
    expect(document.querySelector('table thead')).toBeTruthy();
    expect(document.querySelector('table tbody tr')).toBeTruthy();
  });

  it('代码块渲染 pre 且不丢内容', () => {
    render(<Markdown text={'```ts\nconst a = 1;\n```'} />);
    const pre = document.querySelector('pre');
    expect(pre?.textContent).toContain('const a = 1;');
  });

  it('行内 code 有 md-code 类', () => {
    render(<Markdown text={'行内 `code` 片段'} />);
    expect(document.querySelector('code.md-code')?.textContent).toBe('code');
  });

  it('原始 HTML 不执行：script/img 均不出现', () => {
    render(<Markdown text={'<script>alert(1)</script>\n\n<img src=x onerror=alert(2)>'} />);
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('img')).toBeNull();
  });

  it('链接 _blank + noreferrer', () => {
    render(<Markdown text={'[点我](https://example.com)'} />);
    const a = screen.getByRole('link', { name: '点我' }) as HTMLAnchorElement;
    expect(a.target).toBe('_blank');
    expect(a.rel).toBe('noreferrer noopener');
    expect(a.getAttribute('href')).toBe('https://example.com');
  });

  it('javascript: 链接被过滤', () => {
    render(<Markdown text={'[坏链](javascript:alert(1))'} />);
    const a = screen.getByRole('link', { name: '坏链' }) as HTMLAnchorElement;
    expect(a.getAttribute('href')).not.toContain('javascript');
  });

  it('空文本不渲染内容', () => {
    const { container } = render(<Markdown text={''} />);
    expect(container.querySelector('.md')?.textContent ?? '').toBe('');
  });

  it('流式增量：未闭合标记渲染为纯文本，闭合后渲染为 strong', () => {
    const { rerender } = render(<Markdown text={'**bo'} />);
    expect(screen.getByText('**bo')).toBeTruthy();
    rerender(<Markdown text={'**bold**'} />);
    expect(screen.getByText('bold').tagName).toBe('STRONG');
  });
});

describe('Markdown 流式 caret', () => {
  it('streaming=true 时末尾出现 caret-dot', () => {
    render(<Markdown text={'回复中'} streaming />);
    expect(document.querySelector('.md .caret-dot')).toBeTruthy();
  });
  it('streaming 缺省时无 caret-dot', () => {
    render(<Markdown text={'回复完成'} />);
    expect(document.querySelector('.md .caret-dot')).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run tests/chat/markdown.test.tsx
```

预期：FAIL——`Cannot find module '../../components/chat/Markdown'`（组件还不存在）。

- [ ] **Step 3: 实现 Markdown 组件**

创建 `components/chat/Markdown.tsx`：

```tsx
// components/chat/Markdown.tsx
// assistant 正文的 Markdown 渲染：纯组件，字符串 → React 元素树。
// 安全边界 = react-markdown 默认行为：不渲染原始 HTML、过滤危险 URL scheme、
// img 显式拒绝。项目保持零 dangerouslySetInnerHTML。
import type { ComponentPropsWithoutRef } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** 行内代码 / 代码块内代码（pre 内不再套 md-code，由 .md 覆盖样式）。 */
function Code({ className, children, ...rest }: ComponentPropsWithoutRef<'code'>) {
  return (
    <code className={className ?? 'md-code'} {...rest}>
      {children}
    </code>
  );
}

/** 代码块：复用 .well 井视觉 + 顶部语言标签。语言取 className="language-ts"。 */
function Pre({ children, ...rest }: ComponentPropsWithoutRef<'pre'>) {
  // children 是 <code className="language-xxx">…</code>
  const lang =
    typeof children === 'object' && children !== null && 'props' in (children as object)
      ? String((children as { props?: { className?: string } }).props?.className ?? '').match(
          /language-([\w+-]+)/,
        )?.[1]
      : undefined;
  return (
    <div className="md-codeblock">
      {lang && <span className="md-codeblock__lang">{lang}</span>}
      <pre className="md-codeblock__pre" {...rest}>
        {children}
      </pre>
    </div>
  );
}

const components: Components = {
  code: Code,
  pre: Pre,
  a: ({ node, ...rest }) => <a {...rest} target="_blank" rel="noreferrer noopener" />,
  table: ({ node, ...rest }) => (
    <div className="md-table-scroll">
      <table {...rest} />
    </div>
  ),
  img: () => null,
};

export function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
      {streaming && <span className="caret-dot" />}
    </div>
  );
}
```

实现说明（执行者注意）：

- react-markdown 的 `components` 覆盖签名里每个组件收到 `(props, node)`——解构掉 `node` 只转发 DOM props，避免把 hast node 泄进 DOM 属性。
- `Code` 组件同时服务行内 code 与 pre 内 code；react-markdown 给 fenced code 的 code 元素带 `className="language-xxx"`，行内 code 没有 className。所以 `className ?? 'md-code'` 让行内 code 拿到 `md-code`，块内 code 保持 `language-xxx`（样式由 `.md-codeblock__pre code` 接管）。测试「行内 code 有 md-code 类」正基于此行为。
- 若 TS 对 `Pre` 里 children 的窄化写法报错，可改为 `React.isValidElement(children) ? … : undefined` 等价实现，语义不变。

- [ ] **Step 4: 跑测试确认通过**

```bash
npx vitest run tests/chat/markdown.test.tsx
```

预期：全部 PASS（13 个用例）。若 `javascript:` 链接用例失败（react-markdown 版本行为差异导致 href 保留），检查 react-markdown 默认 urlTransform 行为并在组件里显式传 `urlTransform`（默认 `defaultUrlTransform` 已过滤 javascript:）——先跑再改，不要预防性加。

- [ ] **Step 5: 全量回归**

```bash
npm run compile && npm run test
```

预期：全部通过（新测试 + 现有测试无回归）。

- [ ] **Step 6: Commit**

```bash
git add components/chat/Markdown.tsx tests/chat/markdown.test.tsx
git commit -m "feat: Markdown 渲染组件（GFM + XSS 防御 + 流式 caret）"
```

---

### Task 3: `.md` 样式与 caret 光标 CSS

**Files:**
- Modify: `entrypoints/sidepanel/styles.css`（在 `.think__body` 块之后、`/* 可展开工具卡 */` 注释之前，约 368 行处插入；`.caret-dot` 放到现有 `.caret::after` 旁边，约 252 行处）

- [ ] **Step 1: 添加 `.md` 容器样式块**

在 styles.css 的 `.think__body` 规则（368 行 `}` 处）之后、`/* 可展开工具卡 */`（370 行）之前插入：

```css
/* ============ Markdown 正文（.md） ============ */
/* assistant 消息的 Markdown 渲染容器。块级排版接管换行，样式全部走 :root 变量。 */
.md {
  font-size: 13.5px;
  line-height: 1.65;
  color: var(--ink);
  word-break: break-word;
}
.md > :last-child, .md > .md-codeblock:last-child .md-codeblock__pre { margin-bottom: 0; }
.md p { margin: 0 0 8px; }
.md h1, .md h2, .md h3, .md h4, .md h5, .md h6 {
  margin: 14px 0 6px;
  line-height: 1.4;
  font-weight: 600;
  color: var(--ink);
}
.md h1 { font-size: 15px; }
.md h2 { font-size: 14px; }
.md h3 { font-size: 13.5px; }
.md h4, .md h5, .md h6 { font-size: 13px; color: var(--ink-2); }
.md h1:first-child, .md h2:first-child, .md h3:first-child { margin-top: 0; }
.md ul, .md ol { margin: 0 0 8px; padding-left: 18px; }
.md li { margin: 2px 0; }
.md li > p { margin: 0; }
.md blockquote {
  margin: 0 0 8px;
  padding: 5px 10px;
  border-left: 2px solid var(--signal);
  background: var(--signal-wash);
  border-radius: 0 var(--r-sm) var(--r-sm) 0;
}
.md blockquote > p { margin: 0; }
.md hr { border: none; border-top: 1px solid var(--line-strong); margin: 12px 0; }

/* 行内 code：机器声道 */
.md-code {
  font-family: var(--mono);
  font-size: 12.5px;
  background: var(--sunken);
  border-radius: var(--r-sm);
  padding: 0.5px 4px;
}

/* 代码块：.well 井视觉 + 语言标签 */
.md-codeblock { margin: 0 0 10px; }
.md-codeblock__lang {
  display: block;
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ink-3);
  margin-bottom: 3px;
}
.md-codeblock__pre {
  margin: 0;
  font-family: var(--mono);
  font-size: 12.5px;
  line-height: 1.5;
  background: var(--sunken);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  padding: 9px 10px;
  color: var(--ink);
  white-space: pre-wrap;
  word-break: break-word;
  overflow: auto;
}
.md-codeblock__pre code { font-family: inherit; background: none; padding: 0; }

/* GFM 表格：横向滚动容器防溢出 */
.md-table-scroll { overflow-x: auto; margin: 0 0 10px; }
.md table { border-collapse: collapse; font-size: 12.5px; }
.md th, .md td {
  border: 1px solid var(--line);
  padding: 4px 8px;
  text-align: left;
  word-break: break-word;
}
.md th { background: var(--sunken); font-weight: 600; }

/* 任务列表 + 链接 + 删除线 */
.md input[type='checkbox'] { accent-color: var(--signal); margin-right: 4px; }
.md a { color: var(--signal-ink); }
.md a:hover { text-decoration: underline; }
.md a:focus-visible { outline: 2px solid var(--signal); outline-offset: 2px; }
.md del { color: var(--ink-2); }
```

注意：

- 规格定的是「复用 `.well` 井视觉」——上面 `.md-codeblock__pre` 的属性值与 `.well`（styles.css:458）逐字相同（mono/11.5→12.5 按规格正文档、sunken 底/line 边/r-md/9px 10px）。这里不直接写 `class="well"` 进 JSX，因为 pre 外层还有语言标签结构、且字号档位不同；CSS 层面对齐视觉即可。
- 末段零余白靠两条选择器：`.md > :last-child` 兜段落/列表等，`.md > .md-codeblock:last-child .md-codeblock__pre` 兜代码块（`margin: 0` 在 pre 上不在包裹 div 上）。

- [ ] **Step 2: 添加 `.caret-dot` 光标样式**

在现有 `.caret::after` 规则（styles.css:252-261）之后追加：

```css
/* 流式 Markdown 光标：内联元素紧跟末字符（替代 .caret 伪元素——块级 Markdown 下 ::after 位置漂移） */
.caret-dot {
  display: inline-block;
  width: 2px;
  height: 1em;
  margin-left: 1px;
  vertical-align: text-bottom;
  background: var(--signal);
  animation: blink 1s step-end infinite;
}
```

`blink` keyframes 已存在（styles.css:251），reduced-motion 全局兜底（styles.css:263）自动覆盖，无需额外处理。

- [ ] **Step 3: 验证样式无语法错误**

```bash
npm run compile && npm run test
```

预期：通过（CSS 不进编译，但跑一遍确认没顺手改坏别的）。

- [ ] **Step 4: Commit**

```bash
git add entrypoints/sidepanel/styles.css
git commit -m "style: .md Markdown 正文排版 + caret-dot 流式光标"
```

---

### Task 4: 接入 ChatView

**Files:**
- Modify: `components/chat/ChatView.tsx:2-13`（imports）、`components/chat/ChatView.tsx:218-235`（assistant 分支）
- Modify: `entrypoints/sidepanel/styles.css:292-298`（`.msg-assistant`）

- [ ] **Step 1: 改 ChatView assistant 分支**

`components/chat/ChatView.tsx` 顶部 imports 区（第 7-8 行附近，`ContextRing` import 旁）加：

```tsx
import { Markdown } from './Markdown';
```

assistant 分支（现 218-235 行）中，把：

```tsx
{item.text != null && (
  <div className={`msg-assistant${streaming && !item.thinking ? ' caret' : ''}`}>{item.text}</div>
)}
```

替换为：

```tsx
{item.text != null && (
  <div className="msg-assistant">
    <Markdown text={item.text} streaming={streaming && !item.thinking} />
  </div>
)}
```

user / error / tool / ReasoningBlock 分支一律不动。

- [ ] **Step 2: 调整 `.msg-assistant` 排版职责**

`entrypoints/sidepanel/styles.css` 的 `.msg-assistant`（292-298 行）改为：

```css
.msg-assistant {
  font-size: 13.5px;
  line-height: 1.65;
  word-break: break-word;
  color: var(--ink);
}
```

变更：删 `white-space: pre-wrap`（换行语义交给 `.md` 的块级结构），删后字号/行高/断词保留（`.md` 里也声明了一份，双保险、无冲突——组件将来独立复用时自带排版）。原 `caret` 类拼接已在上一步从 JSX 移除，`.caret::after` 规则不再被 assistant 正文命中（保留规则本身，无其他使用者）。

- [ ] **Step 3: 全量验证**

```bash
npm run compile && npm run test
```

预期：全部通过。若 ChatView 相关已有测试因 DOM 结构变化（`{item.text}` → `.md` 容器）失败，按失败信息调整断言——现有 store 测试不渲染组件，理论上不受影响。

- [ ] **Step 4: Commit**

```bash
git add components/chat/ChatView.tsx entrypoints/sidepanel/styles.css
git commit -m "feat: assistant 消息接入 Markdown 渲染（含流式 caret 迁移）"
```

---

### Task 5: 手动验收（真实流式）

- [ ] **Step 1: 启动开发模式**

```bash
npm run dev
```

加载扩展到 Chrome（WXT dev 模式会输出指引），打开侧边栏。

- [ ] **Step 2: 手动检查清单**

向 AI 发一条会触发丰富格式的指令（如「用 markdown 列一个表格对比 Chrome 和 Firefox，并给一段示例代码块」），逐项确认：

1. 流式输出时格式渐进出现（写到一半的 `**` 不渲染成粗体，闭合后变粗体）
2. 光标（2px 靛蓝竖线）始终紧跟最后一个字符，完成后消失
3. 代码块带语言标签、`--sunken` 井底、mono 字体
4. GFM 表格在窄侧边栏内横向滚动不溢出
5. 长消息换行正常、无多余空行（无 pre-wrap 叠加）
6. 旧会话历史消息（非流式）同样正确渲染
7. user 消息仍是纯文本气泡、reasoning 块仍是纯文本
8. 点击 markdown 链接新开标签页

- [ ] **Step 3: 结束 dev 并收尾**

确认无误后停掉 dev 进程。检查 git status 干净（`git status` 预期 only 分支 ahead）。

- [ ] **Step 4: 更新 CLAUDE.md（可选但推荐）**

在 CLAUDE.md「当前阶段」一节末尾追加一行（保持既有行文风格）：

```markdown
Markdown 渲染（`components/chat/Markdown.tsx`）已完成：assistant 正文走 react-markdown + remark-gfm（GFM 表格/任务列表），代码块复用 .well 井视觉 + 语言标签，流式 caret 改内联 span，img 拒绝渲染、原始 HTML 自动转义（零 dangerouslySetInnerHTML）。首个组件渲染测试 `tests/chat/markdown.test.tsx` 落地（@testing-library/react）。
```

```bash
git add CLAUDE.md
git commit -m "docs: CLAUDE.md 记录 Markdown 渲染交付"
```

---

## 计划自审记录

- **规格覆盖**：架构（Task 2）、流式行为+caret+white-space（Task 2/3/4）、元素定制表五项（Task 2 components 覆盖表：code/pre/a/table/img 齐全）、样式清单（Task 3 逐条对应规格样式节）、测试五类用例（Task 2 测试文件全覆盖 + caret 两条）、验收（Task 5）。规格「依赖」一节写的 v9+，实际安装 v10/v4（npm 最新、React 19 兼容），版本以 Task 1 为准——规格已过时的小偏差，无需改规格。
- **占位符扫描**：所有步骤含完整代码/命令；「若 …失败则按失败信息调整」是条件性指引而非占位。
- **类型一致性**：`Markdown({ text, streaming })` 在 Task 2 定义、Task 4 使用一致；`md-code`/`md-codeblock`/`md-table-scroll`/`caret-dot` 类名 Task 2（JSX）与 Task 3（CSS）逐一对齐。
