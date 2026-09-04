# 详情页设置/日志 Tab 排版重设计 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 设置/日志两 Tab 统一为「明显主标题 + 灰副题 + 正文左对齐」层级，空态改左对齐空态卡（spec：`docs/superpowers/specs/2026-09-04-detail-settings-logs-redesign-design.md`）。

**Architecture:** 新建两个纯展示组件 `DetailTabHeader`（h2 主标题 + mono 后缀 + 副题）与 `DetailEmptyCard`（浅底圆角卡：图标 + 主/副文案），设置/日志两 Tab 消费；CSS 新增 `detail__thead/title/suffix/toolbar/empty*` 类、重定义 `detail__hint`、删 `detail__sectiontitle`。

**Tech Stack:** React 19 + TypeScript，vitest v4 + @testing-library/react + jsdom，样式全走 `entrypoints/sidepanel/styles.css`（CSS 变量 tokens，禁硬编码色值，图标 lucide）。

**工作目录：** `d:\workspace-mou8\ai-browser-extend\.claude\worktrees\feat+script-optimize`（分支 `feat/script-optimize`）。测试命令 `npx vitest run <file>`；全量 `npm test`；类型检查 `npm run compile`。

---

### Task 1: DetailTabHeader + DetailEmptyCard 组件与样式

**Files:**
- Create: `components/detail/DetailTabHeader.tsx`
- Create: `components/detail/DetailEmptyCard.tsx`
- Create: `tests/detail/detail-tab-parts.test.tsx`
- Modify: `entrypoints/sidepanel/styles.css`（`.detail__hint` 重定义；`.detail__sectiontitle` 删除；新增 `.detail__thead` 系列）

- [ ] **Step 1: 写失败测试**

创建 `tests/detail/detail-tab-parts.test.tsx`：

```tsx
// tests/detail/detail-tab-parts.test.tsx
// DetailTabHeader（主标题+后缀+副题）与 DetailEmptyCard（空态卡）纯渲染。
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ShieldOff } from 'lucide-react';
import { DetailTabHeader } from '../../components/detail/DetailTabHeader';
import { DetailEmptyCard } from '../../components/detail/DetailEmptyCard';

describe('DetailTabHeader', () => {
  it('渲染 h2 主标题 + p 副题', () => {
    render(<DetailTabHeader title="XHR 安全" hint="副题说明" />);
    expect(screen.getByRole('heading', { level: 2, name: 'XHR 安全' })).toBeTruthy();
    expect(screen.getByText('副题说明')).toBeTruthy();
  });
  it('suffix 渲染为标题内 mono 后缀；缺省不渲染', () => {
    const { rerender } = render(<DetailTabHeader title="错误日志" suffix="0 条" hint="副题" />);
    expect(screen.getByText('0 条')).toBeTruthy();
    rerender(<DetailTabHeader title="错误日志" hint="副题" />);
    expect(screen.queryByText('0 条')).toBeNull();
  });
});

describe('DetailEmptyCard', () => {
  it('渲染图标 + 主文案 + 副文案', () => {
    render(<DetailEmptyCard icon={ShieldOff} title="无已授权域名" hint="脚本请求跨域时将逐次询问" />);
    expect(screen.getByText('无已授权域名')).toBeTruthy();
    expect(screen.getByText('脚本请求跨域时将逐次询问')).toBeTruthy();
    expect(document.querySelector('svg')).toBeTruthy(); // lucide 图标已渲染
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/detail/detail-tab-parts.test.tsx`
Expected: FAIL，`Failed to resolve import "../../components/detail/DetailTabHeader"`（组件不存在）

- [ ] **Step 3: 最小实现**

`components/detail/DetailTabHeader.tsx`：

```tsx
// components/detail/DetailTabHeader.tsx
// Tab 节头：h2 主标题 + 可选 mono 弱化后缀 + 灰副题（spec §2）。
export function DetailTabHeader({ title, suffix, hint }: { title: string; suffix?: string; hint: string }) {
  return (
    <div className="detail__thead">
      <h2 className="detail__title">
        {title}
        {suffix != null && <span className="detail__suffix mono">{suffix}</span>}
      </h2>
      <p className="detail__hint">{hint}</p>
    </div>
  );
}
```

`components/detail/DetailEmptyCard.tsx`：

```tsx
// components/detail/DetailEmptyCard.tsx
// 左对齐空态卡：浅底圆角卡 + 图标 + 主文案 + 副文案（spec §2）。
import type { LucideIcon } from 'lucide-react';

export function DetailEmptyCard({ icon: Icon, title, hint }: { icon: LucideIcon; title: string; hint: string }) {
  return (
    <div className="detail__empty">
      <span className="detail__empty-icon"><Icon size={16} aria-hidden /></span>
      <span className="detail__empty-title">{title}</span>
      <span className="detail__empty-hint">{hint}</span>
    </div>
  );
}
```

`styles.css`：将 `.detail__sectiontitle` 一行删除，`.detail__hint` 一行替换，并在其附近新增：

```css
/* Tab 节头（2026-09-04 重设计：主标题+灰副题，全左对齐） */
.detail__thead { display: grid; gap: 4px; }
.detail__title { margin: 0; font-size: 15px; font-weight: 600; color: var(--ink); display: flex; align-items: baseline; gap: 8px; }
.detail__suffix { font-family: var(--mono); font-size: 11px; font-weight: 400; color: var(--ink-3); }
.detail__hint { margin: 0; font-size: 12px; color: var(--ink-3); line-height: 1.6; }
.detail__toolbar { display: flex; gap: 8px; }
.detail__empty {
  display: grid; gap: 3px; padding: 14px 16px; justify-items: start;
  background: var(--paper); border: 1px solid var(--line); border-radius: var(--r-md);
}
.detail__empty-icon { color: var(--ink-3); display: inline-flex; }
.detail__empty-title { font-size: 13px; font-weight: 500; color: var(--ink-2); }
.detail__empty-hint { font-size: 12px; color: var(--ink-3); }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/detail/detail-tab-parts.test.tsx`
Expected: PASS（3 用例）

- [ ] **Step 5: 提交**

```bash
git add components/detail/DetailTabHeader.tsx components/detail/DetailEmptyCard.tsx tests/detail/detail-tab-parts.test.tsx entrypoints/sidepanel/styles.css
git commit -m "feat(detail): DetailTabHeader + DetailEmptyCard 组件与样式"
```

### Task 2: 设置 Tab 接入

**Files:**
- Modify: `components/detail/DetailSettingsTab.tsx:40-51`
- Test: `tests/detail/detail-app.test.tsx`（现有文件补用例）

- [ ] **Step 1: 写失败测试**

在 `tests/detail/detail-app.test.tsx` 的 `describe('DetailApp')` 内追加用例（沿用文件顶部的 `mockBackend`/`mkScript`）：

```tsx
  it('设置 Tab：主标题「XHR 安全」+ 副题渲染；授权列表与撤销不受影响', async () => {
    mockBackend(mkScript());
    render(<DetailApp id="s1" />);
    await screen.findByText('测试脚本');
    fireEvent.click(screen.getByText('设置'));
    expect(screen.getByRole('heading', { level: 2, name: 'XHR 安全' })).toBeTruthy();
    expect(screen.getByText(/这些域名已获得该脚本的跨域请求授权/)).toBeTruthy();
    expect(await screen.findByText('x.com')).toBeTruthy();
    expect(screen.getByRole('button', { name: /撤销/ })).toBeTruthy();
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/detail/detail-app.test.tsx`
Expected: FAIL，`Unable to find role="heading" level=2`（还是 11px mono 小字）

- [ ] **Step 3: 改 DetailSettingsTab**

`components/detail/DetailSettingsTab.tsx` 顶部 import 增加：

```tsx
import { DetailTabHeader } from './DetailTabHeader';
import { DetailEmptyCard } from './DetailEmptyCard';
import { ShieldOff } from 'lucide-react';
```

JSX 返回块中，将这三行：

```tsx
      <div className="detail__sectiontitle mono">XHR 安全 · 总是允许名单</div>
      <p className="detail__hint">
        这些域名已获得该脚本的跨域请求授权（在确认卡点「总是允许」时记录）。撤销后，脚本再请求这些域名会重新弹确认。
      </p>
```

替换为：

```tsx
      <DetailTabHeader
        title="XHR 安全"
        hint="这些域名已获得该脚本的跨域请求授权（在确认卡点「总是允许」时记录）；撤销后，脚本再请求这些域名会重新弹确认。"
      />
```

空态分支，将：

```tsx
        <div className="chat__empty">无已授权域名——脚本请求跨域时将逐次询问</div>
```

替换为：

```tsx
        <DetailEmptyCard icon={ShieldOff} title="无已授权域名" hint="脚本请求跨域时将逐次询问" />
```

`loading` 分支的 `<div className="chat__empty">加载中…</div>` 不动（spec §6 明确出范围）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/detail/detail-app.test.tsx`
Expected: PASS（含新用例，原有 9 用例不回归——其中 `detail-app.test.tsx:84-85` 的 x.com/撤销断言继续成立）

- [ ] **Step 5: 提交**

```bash
git add components/detail/DetailSettingsTab.tsx tests/detail/detail-app.test.tsx
git commit -m "feat(detail): 设置 Tab 接入节头+空态卡，标题层级重排"
```

### Task 3: 日志 Tab 接入

**Files:**
- Modify: `components/detail/DetailLogsTab.tsx:11-24`
- Modify: `tests/detail/detail-app.test.tsx:87`（空态文案断言迁移）

- [ ] **Step 1: 写失败测试**

在 `tests/detail/detail-app.test.tsx` 内追加用例：

```tsx
  it('日志 Tab：标题「错误日志」+ 计数后缀；空态卡；清空按钮在工具行', async () => {
    mockBackend(mkScript());
    render(<DetailApp id="s1" />);
    await screen.findByText('测试脚本');
    fireEvent.click(screen.getByText(/日志/));
    expect(screen.getByRole('heading', { level: 2, name: /错误日志/ })).toBeTruthy();
    expect(screen.getByText('0 条')).toBeTruthy();
    expect(screen.getByText(/脚本运行抛错将记录在此/)).toBeTruthy();
    expect(screen.getByText('暂无错误')).toBeTruthy();
    expect(screen.getByText('脚本运行正常')).toBeTruthy();
    const clear = screen.getByRole('button', { name: '清空' });
    expect(clear.hasAttribute('disabled')).toBe(true); // 0 条时禁用（原语义保留）
  });
```

同时将现有 `detail-app.test.tsx:87`：

```tsx
    expect(screen.getByText(/暂无错误/)).toBeTruthy();
```

迁移为（空态文案从单行改两行卡片）：

```tsx
    expect(screen.getByText('暂无错误')).toBeTruthy();
    expect(screen.getByText('脚本运行正常')).toBeTruthy();
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/detail/detail-app.test.tsx`
Expected: FAIL，`Unable to find role="heading" level=2 name=/错误日志/`

- [ ] **Step 3: 改 DetailLogsTab**

`components/detail/DetailLogsTab.tsx` 顶部 import 增加：

```tsx
import { CircleCheck } from 'lucide-react';
import { DetailTabHeader } from './DetailTabHeader';
import { DetailEmptyCard } from './DetailEmptyCard';
```

JSX 返回块中，将：

```tsx
      <div className="detail-code__bar">
        <span className="mono detail-code__status">{errors.length} 条记录</span>
        <Button
          variant="ghost"
          disabled={errors.length === 0}
          onClick={() => void sendScriptsRequest({ type: 'SCRIPTS_CLEAR_ERRORS', scriptId: id })}
        >
          清空
        </Button>
      </div>
```

替换为：

```tsx
      <DetailTabHeader
        title="错误日志"
        suffix={`${errors.length} 条`}
        hint="脚本运行抛错将记录在此（环形缓冲，最近 20 条）。"
      />
      <div className="detail__toolbar">
        <Button
          variant="ghost"
          disabled={errors.length === 0}
          onClick={() => void sendScriptsRequest({ type: 'SCRIPTS_CLEAR_ERRORS', scriptId: id })}
        >
          清空
        </Button>
      </div>
```

空态分支，将：

```tsx
        <div className="chat__empty">暂无错误——脚本运行正常</div>
```

替换为：

```tsx
        <DetailEmptyCard icon={CircleCheck} title="暂无错误" hint="脚本运行正常" />
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/detail/detail-app.test.tsx`
Expected: PASS（含两条新用例 + 迁移后的空态断言 + 日志展开 stack 用例不回归）

- [ ] **Step 5: 提交**

```bash
git add components/detail/DetailLogsTab.tsx tests/detail/detail-app.test.tsx
git commit -m "feat(detail): 日志 Tab 节头（错误日志·计数后缀）+ 空态卡 + 左对齐工具行"
```

### Task 4: 全量验证

- [ ] **Step 1: 类型检查**

Run: `npm run compile`
Expected: 无输出（0 错误）。若报 `Button` 未使用（Task 3 后 `DetailLogsTab` 仍用 Button，不会；若设置 Tab 出现未使用 import 则删除该行）。

- [ ] **Step 2: 全量测试**

Run: `npm test`
Expected: 全部通过（606 基线 + 新增 4 用例）。`Not implemented: Window's scrollBy()` 为 jsdom 已知噪音，非失败。

- [ ] **Step 3: 收尾提交（如有零散改动）**

```bash
git status --short
# 有未提交改动才执行：
git add -A && git commit -m "chore(detail): 设置/日志 Tab 重设计收尾"
```
