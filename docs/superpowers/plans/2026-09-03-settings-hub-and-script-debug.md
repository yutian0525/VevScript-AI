# 设置页枢纽 + 脚本运行时调试台 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 railnav 调试台入口收进设置页二级路由，工具调试台按能力域分组并修正 tag，新增经真实桥链路的脚本运行时 GM API 调试台。

**Architecture:** 设置页改为壳（`SettingsView` 内部 `useState` 路由，不持久化）→ 三个二级页（模型设置 / 工具调试台 / 脚本运行时调试台），同构脚本池列表/详情模式。GM 直调复用现有 gmreq/gmres 事件桥：面板发 `GM_DEBUG_CALL`→SW 查 token→`GM_DEBUG_INVOKE`下行 content→`gm-bridge-host.debugCall()` 在页面 dispatch `gmreq`→宿主真实 token 校验+`handleGmCall`→`gmres` 回环，除 wrapper 函数体外全链路真实。

**Tech Stack:** WXT + React 19 + TypeScript 7（strict + noUncheckedIndexedAccess）、Zustand、lucide-react、vitest v4 + jsdom + `wxt/testing/fake-browser` + @testing-library/react。

**规格文档：** [docs/superpowers/specs/2026-09-03-settings-hub-and-script-debug-design.md](../specs/2026-09-03-settings-hub-and-script-debug-design.md)

---

## 关键实现约定

- **工具总数为 25**（`agent/tools/schemas.ts` 的 `TOOL_SCHEMAS`），tag 四分计数 PAGE 10 / TABS 5 / NET 4 / SCRIPTS 6。
- **直调 api 用点形式短名**（`SetValue`/`XmlHttpRequest`…），与 wrapper 实际发出形式一致；发 `GM_` 全名会落到 `handleGmCall` 的「未知 GM API」。
- **绝不 `git add -A`**：每个 commit 只 add 本 task 明确列出的文件；commit 前 `git diff --cached --name-only` 核对暂存区。
- **禁止硬编码色值**：只用 `styles.css` 的 `:root` CSS 变量；禁止用 emoji 代替图标（用 lucide-react）。
- **PageShell 归属**：三个二级页各自渲染自己的 `PageShell`，通过 `onBack` prop 在 `actions` 槽放返回钮（lucide `ArrowLeft`），与 `ScriptDetailView` 一致。

## 文件结构

```text
components/settings/
  SettingsView.tsx      壳：useState 路由 home/model/toolbench/scriptdebug（改写）
  SettingsHome.tsx      列表页：三入口卡（新增）
  ModelSettings.tsx     模型设置 = 现 SettingsView 表单原样平移 + onBack（新增）
components/debug/
  tool-tags.ts          TOOL_TAGS + GROUPS 纯模块（新增，可测）
  ResultPanel.tsx       OK/ERR + ms + well 结果面板（从 DebugView 提取，新增）
  ToolBenchPage.tsx     工具调试台 = DebugView 改造（分组 + 新 tag + onBack，新增）
  DebugView.tsx         删除（内容已迁走）
components/scriptdebug/
  ScriptDebugPage.tsx   脚本运行时调试台（新增）
```

---

## Task 1: TOOL_TAGS 纯模块 + 完备性测试

能力域四分与分组元数据抽到可导入的纯模块，先写测试锁定完备性与计数。

**Files:**
- Create: `components/debug/tool-tags.ts`
- Test: `tests/debug/tool-tags.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/debug/tool-tags.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { TOOL_TAGS, GROUPS } from '../../components/debug/tool-tags';
import { TOOL_SCHEMAS } from '../../agent/tools/schemas';

describe('TOOL_TAGS 完备性', () => {
  it('每个工具都有 tag', () => {
    for (const t of TOOL_SCHEMAS) {
      expect(TOOL_TAGS[t.function.name], `工具 ${t.function.name} 缺 tag`).toBeDefined();
    }
  });

  it('四类计数 PAGE 10 / TABS 5 / NET 4 / SCRIPTS 6', () => {
    const count = (tag: string) => Object.values(TOOL_TAGS).filter((v) => v === tag).length;
    expect(count('PAGE')).toBe(10);
    expect(count('TABS')).toBe(5);
    expect(count('NET')).toBe(4);
    expect(count('SCRIPTS')).toBe(6);
  });

  it('TOOL_TAGS 键集 = TOOL_SCHEMAS 名字集（无多余、无遗漏）', () => {
    const names = new Set(TOOL_SCHEMAS.map((t) => t.function.name));
    expect(new Set(Object.keys(TOOL_TAGS))).toEqual(names);
  });

  it('GROUPS 按组序 PAGE/TABS/NET/SCRIPTS', () => {
    expect(GROUPS.map((g) => g.key)).toEqual(['PAGE', 'TABS', 'NET', 'SCRIPTS']);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test -- tool-tags`
Expected: FAIL（`Cannot find module '../../components/debug/tool-tags'`）

- [ ] **Step 3: 写最小实现**

`components/debug/tool-tags.ts`：

```ts
// components/debug/tool-tags.ts
// 工具能力域四分（spec §2）：调试台分组 + tag chip 的唯一数据源。
// 缺省兜底 'PAGE'：未来新工具忘登记时按「碰当前页」保守归类（getTag 用）。

export type ToolTag = 'PAGE' | 'TABS' | 'NET' | 'SCRIPTS';

export const TOOL_TAGS: Record<string, ToolTag> = {
  // PAGE(10)：8 个 CS 工具 + 2 个 SW 直操作当前页（截图/注入脚本）
  take_snapshot: 'PAGE', click: 'PAGE', fill: 'PAGE', fill_form: 'PAGE',
  hover: 'PAGE', scroll: 'PAGE', press_key: 'PAGE', wait_for: 'PAGE',
  take_screenshot: 'PAGE', evaluate_script: 'PAGE',
  // TABS(5)：标签页管理与导航
  navigate_page: 'TABS', list_pages: 'TABS', new_page: 'TABS', close_page: 'TABS', select_page: 'TABS',
  // NET(4)：后台 fetch / console / 网络元数据
  http_request: 'NET', list_console_messages: 'NET',
  list_network_requests: 'NET', get_network_request: 'NET',
  // SCRIPTS(6)：userScripts CRUD 与启停
  list_scripts: 'SCRIPTS', get_script: 'SCRIPTS', create_script: 'SCRIPTS',
  update_script: 'SCRIPTS', delete_script: 'SCRIPTS', toggle_script: 'SCRIPTS',
};

/** 缺省兜底 PAGE：未登记的新工具保守归「碰当前页」。 */
export function getTag(name: string): ToolTag {
  return TOOL_TAGS[name] ?? 'PAGE';
}

export const GROUPS: ReadonlyArray<{ key: ToolTag; label: string; hint: string }> = [
  { key: 'PAGE', label: '页面操作', hint: 'content script 或 SW 直操作当前页' },
  { key: 'TABS', label: '标签页与导航', hint: 'tabs API / 导航控制' },
  { key: 'NET', label: '网络与观测', hint: '后台 fetch / console / 网络元数据' },
  { key: 'SCRIPTS', label: '脚本池管理', hint: 'userScripts CRUD 与启停' },
] as const;

/** tag → chip 修饰类（styles.css 四档）。 */
export const CHIP_CLASS: Record<ToolTag, string> = {
  PAGE: 'chip--page', TABS: 'chip--tabs', NET: 'chip--net', SCRIPTS: 'chip--script',
};
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test -- tool-tags`
Expected: PASS（4 用例）

- [ ] **Step 5: 提交**

```bash
git add components/debug/tool-tags.ts tests/debug/tool-tags.test.ts
git diff --cached --name-only
git commit -m "feat(debug): 工具能力域四分纯模块 tool-tags + 完备性测试"
```

---

## Task 2: 提取 ResultPanel（工具台与 GM 台共用）

结果面板从 DebugView 抽出为独立组件（含 `Outcome` 判别联合与 `formatData`），供工具台与脚本调试台共用。GM 直调复用 `DebugExecResponse` 形状。

**Files:**
- Create: `components/debug/ResultPanel.tsx`
- Test: `tests/debug/result-panel.test.tsx`

- [ ] **Step 1: 写失败测试**

`tests/debug/result-panel.test.tsx`：

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ResultPanel } from '../../components/debug/ResultPanel';

afterEach(cleanup);

describe('ResultPanel', () => {
  it('工具成功：OK + ms + 数据', () => {
    render(<ResultPanel outcome={{ kind: 'result', resp: { dispatched: true, ms: 12, result: { ok: true, data: { a: 1 } } } }} />);
    expect(screen.getByText('OK')).toBeTruthy();
    expect(screen.getByText('12 ms')).toBeTruthy();
    expect(screen.getByText(/"a": 1/)).toBeTruthy();
  });

  it('工具失败：ERR + 错误文案', () => {
    render(<ResultPanel outcome={{ kind: 'result', resp: { dispatched: true, ms: 3, result: { ok: false, error: '炸了' } } }} />);
    expect(screen.getByText('ERR')).toBeTruthy();
    expect(screen.getByText('炸了')).toBeTruthy();
  });

  it('参数解析失败：ERR + 参数文案', () => {
    render(<ResultPanel outcome={{ kind: 'bad-args', message: '不是对象' }} />);
    expect(screen.getByText('ERR')).toBeTruthy();
    expect(screen.getByText(/参数解析失败：不是对象/)).toBeTruthy();
  });

  it('链路异常：ERR + 链路文案', () => {
    render(<ResultPanel outcome={{ kind: 'link-error', message: '断了' }} />);
    expect(screen.getByText(/链路异常：断了/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test -- result-panel`
Expected: FAIL（`Cannot find module '../../components/debug/ResultPanel'`）

- [ ] **Step 3: 写实现**

`components/debug/ResultPanel.tsx`（从 DebugView 第 104-107、209-253 行原样迁移，导出 `Outcome`）：

```tsx
// components/debug/ResultPanel.tsx
// 调试结果面板（工具台与脚本运行时调试台共用）：OK/ERR 判定 + 耗时 + 代码井。
// 三态：参数解析失败 / 链路异常 / 工具（或 GM 直调）返回。GM 直调复用 DebugExecResponse 形状。
import type { DebugExecResponse } from '../../shared/messages';

export type Outcome =
  | { kind: 'bad-args'; message: string }
  | { kind: 'link-error'; message: string }
  | { kind: 'result'; resp: DebugExecResponse };

function formatData(data: unknown): string {
  if (data == null) return '(无返回数据)';
  if (typeof data === 'string') return data; // 快照树等长文本直接展示
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}

export function ResultPanel({ outcome }: { outcome: Outcome }) {
  let ok = false;
  let ms: number | null = null;
  let body: string;

  if (outcome.kind === 'bad-args') {
    body = `参数解析失败：${outcome.message}`;
  } else if (outcome.kind === 'link-error') {
    body = `链路异常：${outcome.message}`;
  } else {
    const { resp } = outcome;
    ms = resp.ms;
    if (!resp.dispatched) {
      body = `链路异常：${resp.error ?? '未知错误'}`;
    } else if (resp.result?.ok) {
      ok = true;
      body = formatData(resp.result.data);
    } else {
      body = resp.result?.error ?? '工具返回失败（无错误信息）';
    }
  }

  return (
    <div className="rise" style={{ marginTop: 12 }}>
      <div className="result-head">
        <span className={`dot dot--${ok ? 'ok' : 'err'}`} />
        <span className={`result-verdict ${ok ? 'result-verdict--ok' : 'result-verdict--err'}`}>
          {ok ? 'OK' : 'ERR'}
        </span>
        {ms != null && <span className="result-ms">{ms} ms</span>}
      </div>
      <div className="well" style={{ maxHeight: 260 }}>{body}</div>
    </div>
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test -- result-panel`
Expected: PASS（4 用例）

- [ ] **Step 5: 提交**

```bash
git add components/debug/ResultPanel.tsx tests/debug/result-panel.test.tsx
git diff --cached --name-only
git commit -m "feat(debug): 提取 ResultPanel 结果面板 + 组件测试"
```

---

## Task 3: ToolBenchPage（DebugView 改造：分组 + 新 tag）

DebugView 的行为原样保留（skeleton / JSON 编辑 / 执行 / 结果 / host 仪表条），改动三处：按 `GROUPS` 分组渲染组标题；chip 用 `getTag`/`CHIP_CLASS` 四档；`ResultPanel` 从 Task 2 引入；新增 `onBack` prop 在页眉 actions 放返回钮。旧 `DebugView.tsx` 留到 Task 10 删（App 仍引用它，删早了编译断）。

**Files:**
- Create: `components/debug/ToolBenchPage.tsx`

- [ ] **Step 1: 写实现（顶部：imports + 工具函数 + 主组件）**

`components/debug/ToolBenchPage.tsx`：

```tsx
// components/debug/ToolBenchPage.tsx
// 工具调试台（设置二级页）：按能力域分组列出 25 个工具，绕过 LLM 直接对当前标签页调用。
// 走后台 DEBUG_EXEC_TOOL → handleDebugExec → executeTool（与真实链路一致）。
import { useEffect, useState } from 'react';
import { ChevronRight, Play, Loader2, Globe, ArrowLeft } from 'lucide-react';
import { PageShell } from '../ui/PageShell';
import { Button } from '../ui/Button';
import { TOOL_SCHEMAS } from '../../agent/tools/schemas';
import type { ToolSchema } from '../../agent/provider/types';
import type { DebugExecResponse } from '../../shared/messages';
import { GROUPS, getTag, CHIP_CLASS, type ToolTag } from './tool-tags';
import { ResultPanel, type Outcome } from './ResultPanel';

interface JsonSchema {
  type?: string;
  description?: string;
  enum?: unknown[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
}

function placeholderFor(s: JsonSchema): unknown {
  if (s.enum?.length) return s.enum[0];
  switch (s.type) {
    case 'number': return 0;
    case 'string': return '';
    case 'boolean': return false;
    case 'array': return [];
    case 'object': return {};
    default: return null;
  }
}

/** 从 schema 的 required 生成参数骨架 JSON（可选参数留空，用户按需补） */
function skeletonOf(params: JsonSchema): string {
  const props = params.properties ?? {};
  const obj: Record<string, unknown> = {};
  for (const key of params.required ?? []) obj[key] = placeholderFor(props[key] ?? {});
  return JSON.stringify(obj, null, 2);
}

async function activeTabId(): Promise<number | undefined> {
  let [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab) [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  return tab?.id;
}
```

- [ ] **Step 2: 写实现（主组件 + 分组渲染）**

续写同文件：

```tsx
export function ToolBenchPage({ onBack }: { onBack: () => void }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [targetHost, setTargetHost] = useState<string>('—');

  useEffect(() => {
    const resolve = async () => {
      const id = await activeTabId();
      if (id == null) { setTargetHost('—'); return; }
      const tab = await browser.tabs.get(id).catch(() => undefined);
      try {
        setTargetHost(tab?.url ? new URL(tab.url).host || tab.url : '—');
      } catch {
        setTargetHost(tab?.url ?? '—');
      }
    };
    void resolve();
    const onActivate = () => void resolve();
    browser.tabs.onActivated.addListener(onActivate);
    browser.tabs.onUpdated.addListener(onActivate);
    return () => {
      browser.tabs.onActivated.removeListener(onActivate);
      browser.tabs.onUpdated.removeListener(onActivate);
    };
  }, []);

  // 按能力域分组（组内保持 TOOL_SCHEMAS 原序）
  const byTag = new Map<ToolTag, ToolSchema[]>();
  for (const t of TOOL_SCHEMAS) {
    const tag = getTag(t.function.name);
    (byTag.get(tag) ?? byTag.set(tag, []).get(tag)!).push(t);
  }

  return (
    <PageShell
      title="工具调试台"
      eyebrow="TOOLBENCH"
      right={
        <span className="gauge" title={targetHost}>
          <Globe size={12} color="var(--ink-3)" />
          <span className="gauge__label mono" style={{ maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {targetHost}
          </span>
        </span>
      }
      actions={<Button variant="ghost" onClick={onBack} aria-label="返回"><ArrowLeft size={14} /></Button>}
    >
      <div className="hint" style={{ marginBottom: 14 }}>
        直接对当前标签页调用工具，不经模型。共 {TOOL_SCHEMAS.length} 个工具。
      </div>
      {GROUPS.map((g) => {
        const tools = byTag.get(g.key) ?? [];
        if (tools.length === 0) return null;
        return (
          <section key={g.key} style={{ marginBottom: 18 }}>
            <div className="toolgroup__head mono">── {g.label} {g.key} · {tools.length} ──</div>
            <div className="toolgroup__hint">{g.hint}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {tools.map((tool) => (
                <ToolItem
                  key={tool.function.name}
                  tool={tool}
                  open={expanded === tool.function.name}
                  onToggle={() => setExpanded((cur) => (cur === tool.function.name ? null : tool.function.name))}
                />
              ))}
            </div>
          </section>
        );
      })}
    </PageShell>
  );
}
```

- [ ] **Step 3: 写实现（ToolItem 子组件）**

续写同文件（从 DebugView 109-207 行迁移，仅改 chip 那一行与 ResultPanel 引用）：

```tsx
function ToolItem({ tool, open, onToggle }: { tool: ToolSchema; open: boolean; onToggle: () => void }) {
  const params = tool.function.parameters as JsonSchema;
  const props = params.properties ?? {};
  const required = new Set(params.required ?? []);
  const keys = Object.keys(props);
  const tag = getTag(tool.function.name);

  const [argsText, setArgsText] = useState(() => skeletonOf(params));
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const run = async () => {
    let args: Record<string, unknown>;
    try {
      const parsed = argsText.trim() === '' ? {} : JSON.parse(argsText);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('参数必须是 JSON 对象');
      }
      args = parsed as Record<string, unknown>;
    } catch (e) {
      setOutcome({ kind: 'bad-args', message: e instanceof Error ? e.message : String(e) });
      return;
    }
    setRunning(true);
    setOutcome(null);
    const tabId = await activeTabId();
    if (tabId == null) {
      setRunning(false);
      setOutcome({ kind: 'link-error', message: '无法获取当前标签页，请切到普通网页后重试' });
      return;
    }
    try {
      const resp = (await browser.runtime.sendMessage({
        type: 'DEBUG_EXEC_TOOL', tabId, name: tool.function.name, args,
      })) as DebugExecResponse;
      setOutcome({ kind: 'result', resp });
    } catch (e) {
      setOutcome({ kind: 'link-error', message: e instanceof Error ? e.message : String(e) });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div>
      <button className="tool-row" aria-expanded={open} onClick={onToggle}>
        <span className="tool-row__head">
          <ChevronRight
            size={13}
            color="var(--ink-3)"
            style={{ transition: 'transform var(--t-fast) var(--ease)', transform: open ? 'rotate(90deg)' : 'none' }}
          />
          <span className="tool-row__name">{tool.function.name}</span>
          <span className={`chip ${CHIP_CLASS[tag]}`}>{tag}</span>
        </span>
        {!open && <span className="tool-row__desc" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tool.function.description}</span>}
      </button>

      {open && (
        <div className="rise" style={{ padding: '10px 2px 4px' }}>
          <p className="tool-row__desc" style={{ margin: '0 0 10px' }}>{tool.function.description}</p>
          {keys.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              <div className="token" style={{ marginBottom: 5 }}>PARAMS</div>
              {keys.map((k) => (
                <div className="param" key={k}>
                  <span className="param__key">{k}</span>
                  <span className="param__type">{props[k]?.enum ? props[k]!.enum!.join('|') : props[k]?.type ?? '?'}</span>
                  {required.has(k) && <span className="param__req">*必填</span>}
                  {props[k]?.description && <span className="param__desc">{props[k]!.description}</span>}
                </div>
              ))}
            </div>
          )}
          <div className="token" style={{ marginBottom: 5 }}>ARGS · JSON</div>
          <textarea
            className="textarea mono-input"
            value={argsText}
            onChange={(e) => setArgsText(e.target.value)}
            spellCheck={false}
            rows={Math.min(8, Math.max(2, argsText.split('\n').length))}
            style={{ marginBottom: 8 }}
          />
          <Button variant="signal" onClick={run} disabled={running}>
            {running ? <Loader2 size={14} className="spin" /> : <Play size={14} />}
            {running ? '执行中…' : '运行'}
          </Button>
          {outcome && <ResultPanel outcome={outcome} />}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: 编译验证**

Run: `npm run compile`
Expected: 无错误（ToolBenchPage 暂未被 import，属正常——Task 9 接线）。

- [ ] **Step 5: 提交**

```bash
git add components/debug/ToolBenchPage.tsx
git diff --cached --name-only
git commit -m "feat(debug): ToolBenchPage 分组渲染 + 四档 tag chip"
```

---

## Task 4: styles.css — chip 四档 + 组标题 + 设置入口卡

纯样式，无测试。`.chip--cs`→`.chip--page`、`.chip--api`→`.chip--tabs`（改名），新增 `.chip--net`/`.chip--script`；新增 `.toolgroup__head`/`.toolgroup__hint`（组标题）与 `.setting-card`（列表入口卡）；脚本调试台复用现有类，仅补 `.gm-api-row`（置灰态）。旧 `DebugView.tsx` 此刻起 chip 无样式，Task 10 删除它前属过渡态（同分支内可接受）。

**Files:**
- Modify: `entrypoints/sidepanel/styles.css`（614-615 行 chip 改档 + 追加新块）

- [ ] **Step 1: 改 chip 两档 → 四档**

把 [entrypoints/sidepanel/styles.css:614-615](../../../entrypoints/sidepanel/styles.css#L614-L615) 的：

```css
.chip--cs { color: var(--signal-ink); border-color: #c3c5e0; background: var(--signal-wash); }
.chip--api { color: var(--ink-2); background: var(--sunken); }
```

替换为：

```css
.chip--page { color: var(--signal-ink); border-color: #c3c5e0; background: var(--signal-wash); }
.chip--tabs { color: var(--ink-2); background: var(--sunken); }
.chip--net { color: var(--ok); border-color: #bfe0cb; background: var(--ok-wash); }
.chip--script { color: var(--warn); border-color: #e4c169; background: var(--warn-wash); }
```

- [ ] **Step 2: 追加组标题 + 设置卡 + GM 行样式**

在同文件 `.divider` 规则（约第 628 行）之后追加：

```css
/* ============ 调试台分组标题 ============ */
.toolgroup__head { font-size: 11px; font-weight: 600; letter-spacing: 0.06em; color: var(--ink-2); margin: 4px 0 2px; }
.toolgroup__hint { font-size: 11px; color: var(--ink-3); margin-bottom: 8px; }

/* ============ 设置枢纽入口卡 ============ */
.setting-card {
  display: flex; align-items: center; gap: 10px;
  border: 1px solid var(--line); border-radius: 10px; background: var(--surface);
  padding: 12px 14px; margin-bottom: 8px; cursor: pointer; text-align: left; width: 100%;
  transition: border-color var(--t-fast) var(--ease), background var(--t-fast) var(--ease);
}
.setting-card:hover { border-color: var(--line-strong); background: var(--paper); }
.setting-card:focus-visible { outline: 2px solid var(--signal); outline-offset: 1px; }
.setting-card__icon { color: var(--signal-ink); flex-shrink: 0; display: flex; }
.setting-card__body { min-width: 0; }
.setting-card__title { font-size: 13px; font-weight: 600; color: var(--ink); }
.setting-card__desc { font-size: 11.5px; color: var(--ink-3); line-height: 1.5; }
.setting-card__chev { color: var(--ink-3); flex-shrink: 0; margin-left: auto; }

/* ============ 脚本运行时调试台 GM API 行 ============ */
.gm-api-row.is-disabled { opacity: 0.5; }
.gm-api-row.is-disabled .tool-row { cursor: not-allowed; }
.gm-api-note { font-size: 11px; color: var(--ink-3); margin: 2px 0 0 21px; }
.gm-whitelist { font-family: var(--mono); font-size: 11.5px; color: var(--ink); line-height: 1.6; }
.gm-whitelist__row { display: flex; align-items: center; gap: 5px; padding: 1px 0; }
```

- [ ] **Step 3: 编译 + 全量测试兜底**

Run: `npm run test`
Expected: PASS（样式不入测试；确认无回归）

- [ ] **Step 4: 提交**

```bash
git add entrypoints/sidepanel/styles.css
git diff --cached --name-only
git commit -m "style: chip 四档改名/新增 + 调试台组标题 + 设置入口卡"
```

---

## Task 5: gm-bridge-host.debugCall() + ensureAttached

在桥宿主里加 `debugCall()`：dispatch `gmreq:<scriptId>`（token + debug 命名空间 reqId 从 `1_000_000_000` 起）→ 宿主已有的 gmreq 监听器真实校验并转发 `GM_API_CALL` → 监听 `gmres:<scriptId>` 按 reqId 配对，超时可注入（默认 10s，测试传短值）。`ensureAttached` 防「debug 早于 host 监听器挂载」竞态。此任务必须在 Task 6 之前（content.ts route case 依赖 `debugCall`）。

**Files:**
- Modify: `content/gm-bridge-host.ts`
- Test: `tests/content/gm-bridge-host.test.ts`（扩展）

- [ ] **Step 1: 写失败测试（追加到现有 describe 块内）**

在 [tests/content/gm-bridge-host.test.ts](../../../tests/content/gm-bridge-host.test.ts) 的 `handleGmEvent` 用例之后、`describe` 闭合 `});` 之前追加：

```ts
  it('debugCall：拉 token + 真实链路调 GM_API_CALL，回 data', async () => {
    browser.runtime.onMessage.addListener((msg: { type: string }, _s, sendResponse) => {
      if (msg.type === 'GM_BRIDGE_TOKENS') { sendResponse({ ok: true, data: { entries: [{ scriptId: 's1', token: 'tok' }] } }); return true; }
      if (msg.type === 'GM_API_CALL') { sendResponse({ ok: true, data: { got: (msg as { params: unknown[] }).params } }); return true; }
      sendResponse({ ok: false, error: 'x' }); return true;
    });
    const { debugCall } = await import('../../content/gm-bridge-host');
    const r = await debugCall('s1', 'GetValue', ['k'], 500);
    expect(r).toMatchObject({ ok: true, data: { got: ['k'] } });
  });

  it('debugCall：token 拉不到时报错（脚本未注入此页）', async () => {
    browser.runtime.onMessage.addListener((msg: { type: string }, _s, sendResponse) => {
      if (msg.type === 'GM_BRIDGE_TOKENS') { sendResponse({ ok: true, data: { entries: [] } }); return true; }
      sendResponse({ ok: true }); return true;
    });
    const { debugCall } = await import('../../content/gm-bridge-host');
    const r = await debugCall('sX', 'GetValue', ['k'], 500);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/未注入|token/);
  });

  it('debugCall：无 gmres 时超时', async () => {
    browser.runtime.onMessage.addListener((msg: { type: string }, _s, sendResponse) => {
      if (msg.type === 'GM_BRIDGE_TOKENS') { sendResponse({ ok: true, data: { entries: [{ scriptId: 's1', token: 'tok' }] } }); return true; }
      // GM_API_CALL 永不响应（模拟宿主转发后 SW 卡住）
      return true;
    });
    const { debugCall } = await import('../../content/gm-bridge-host');
    const r = await debugCall('s1', 'SetValue', ['k', 1], 30);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/超时/);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test -- gm-bridge-host`
Expected: FAIL（`debugCall is not a function` / 无此导出）

- [ ] **Step 3: 写实现（ensureAttached + debugCall）**

在 [content/gm-bridge-host.ts](../../../content/gm-bridge-host.ts) 的 `handleGmEvent` 函数之前追加（`refreshTokens`/`attachFor`/`tokens` 已在文件内，直接复用）：

```ts
// ---- 面板直调（脚本运行时调试台，spec §3）----
// debug 命名空间 reqId：从 10 亿起，与 wrapper 的自增 reqId 不撞。
let debugReqId = 1_000_000_000;

/** token 表缺该 id 时先拉一次（防 debug gmreq 早于 host 监听器挂载的竞态）。 */
async function ensureAttached(scriptId: string): Promise<boolean> {
  if (!tokens.has(scriptId)) await refreshTokens();
  return tokens.has(scriptId);
}

/**
 * 经真实桥链路直调 GM API（面板调试用，不经 wrapper 函数体）：
 * dispatch gmreq → 宿主已有监听器做 token 校验 + 转发 GM_API_CALL → 监听 gmres 按 reqId 配对。
 * 覆盖 token 防伪 / grant 白名单 / handleGmCall / @connect 确认流 / gmres 回环。
 */
export async function debugCall(
  scriptId: string, api: string, params: unknown[], timeoutMs = 10_000,
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const ready = await ensureAttached(scriptId);
  const token = tokens.get(scriptId);
  if (!ready || !token) {
    return { ok: false, error: '脚本未注入此页（查不到 token）——请切到该脚本 @match 命中的标签页后重试' };
  }
  const reqId = debugReqId++;
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      window.removeEventListener(gmResEvent(scriptId), onRes);
      resolve({ ok: false, error: `直调超时（${timeoutMs}ms 无 gmres 回环）` });
    }, timeoutMs);
    const onRes = (e: Event) => {
      const detail = (e as CustomEvent<{ reqId: number; ok: boolean; data?: unknown; error?: string }>).detail;
      if (!detail || detail.reqId !== reqId) return; // 配对：只认自己那次
      if (done) return;
      done = true;
      clearTimeout(timer);
      window.removeEventListener(gmResEvent(scriptId), onRes);
      resolve({ ok: detail.ok, data: detail.data, error: detail.error });
    };
    window.addEventListener(gmResEvent(scriptId), onRes);
    window.dispatchEvent(new CustomEvent(gmReqEvent(scriptId), { detail: { token, reqId, api, params } }));
  });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test -- gm-bridge-host`
Expected: PASS（原 3 用例 + 新 3 用例 = 6）

- [ ] **Step 5: 提交**

```bash
git add content/gm-bridge-host.ts tests/content/gm-bridge-host.test.ts
git diff --cached --name-only
git commit -m "feat(gm): gm-bridge-host.debugCall 经真实桥链路直调 + ensureAttached 防竞态"
```

---

## Task 6: 协议 — messages.ts + content.ts route case

加三条消息类型：`GM_DEBUG_INVOKE`（进 `BgToCsRequestMap`，SW→CS）、`GM_DEBUG_CALL` / `GM_DEBUG_INFO`（进 `ScriptsRequest`，面板→SW），及 `GmDebugInfoData` 白名单视图数据形状。`GM_DEBUG_INVOKE` 进 map 后 content.ts `route()` 的穷尽 never 会编译断，必须同步补 case 调 `debugCall`（Task 5 已导出）。此任务编译即验证（穷尽检查兜底），无独立单测。

**Files:**
- Modify: `shared/messages.ts`
- Modify: `entrypoints/content.ts`

- [ ] **Step 1: messages.ts — BgToCsRequestMap 加项**

把 [shared/messages.ts:9-19](../../../shared/messages.ts#L9-L19) 的 `BgToCsRequestMap` 末项 `PAGE_META` 行之后（`}` 之前）加一行：

```ts
  PAGE_META: Record<string, never>;
  /** 脚本运行时调试台直调：SW→CS，宿主 debugCall 经真实桥链路发 GM_API_CALL（spec §3） */
  GM_DEBUG_INVOKE: { scriptId: string; api: string; params: unknown[] };
```

- [ ] **Step 2: messages.ts — ScriptsRequest 加两项 + GmDebugInfoData**

把 [shared/messages.ts:161-173](../../../shared/messages.ts#L161-L173) 的 `ScriptsRequest` 联合末项（`GM_CONFIRM_RESOLVE` 那行）改为带后续两项：

```ts
  | { type: 'GM_CONFIRM_RESOLVE'; confirmId: string; decision: 'allow-once' | 'always' | 'deny' }
  | { type: 'GM_DEBUG_CALL'; scriptId: string; api: string; params: unknown[]; tabId?: number }
  | { type: 'GM_DEBUG_INFO'; scriptId: string; tabId?: number };
```

在 `ScriptsRequest` 定义之后追加白名单视图数据形状：

```ts
/** GM_DEBUG_INFO 响应 data：脚本运行时调试台白名单视图（spec §3.①）。 */
export interface GmDebugInfoData {
  connects: string[];
  grantSupported: string[];
  grantUnsupported: string[];
  /** 已「始终允许」的跨域主机（background/gm-permissions） */
  alwaysAllow: string[];
  /** 该脚本当前是否注入目标页（bridgeTokensForUrl 命中） */
  injected: boolean;
  /** 目标页 URL（host 仪表条 + @connect self 判定展示） */
  tabUrl: string;
}
```

- [ ] **Step 3: content.ts — import debugCall + route 补 case**

把 [entrypoints/content.ts:10](../../../entrypoints/content.ts#L10) 的 import 行：

```ts
import { initBridgeHost, handleGmEvent } from '../content/gm-bridge-host';
```

改为：

```ts
import { initBridgeHost, handleGmEvent, debugCall } from '../content/gm-bridge-host';
```

在 [entrypoints/content.ts:31-32](../../../entrypoints/content.ts#L31-L32) 的 `PAGE_META` case 之后、`default:` 之前插入：

```ts
    case 'PAGE_META':
      return { ok: true, data: { url: location.href, title: document.title, readyState: document.readyState } };
    case 'GM_DEBUG_INVOKE': {
      const r = await debugCall(req.payload.scriptId, req.payload.api, req.payload.params);
      return r.ok ? { ok: true, data: r.data } : { ok: false, error: r.error ?? '直调失败' };
    }
```

- [ ] **Step 4: 编译验证**

Run: `npm run compile`
Expected: 无错误（穷尽 never 满足；`debugCall` 已导入）。

- [ ] **Step 5: 提交**

```bash
git add shared/messages.ts entrypoints/content.ts
git diff --cached --name-only
git commit -m "feat(protocol): GM_DEBUG_INVOKE/CALL/INFO 消息 + content route 直调分支"
```

---

## Task 7: gm-api debug handlers + gm-permissions.listAlwaysAllow

SW 侧接两个 handler：`GM_DEBUG_CALL`（查 token → `tabs.sendMessage` 下发 `GM_DEBUG_INVOKE` → 回 `DebugExecResponse` 形状）、`GM_DEBUG_INFO`（回白名单视图数据）。`gm-permissions` 加 `listAlwaysAllow` 供白名单视图。

**Files:**
- Modify: `background/gm-permissions.ts`
- Modify: `background/gm-api.ts`
- Test: `tests/background/gm-debug.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/background/gm-debug.test.ts`：

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { MessageRouter } from '../../background/router';
import { initGmApi } from '../../background/gm-api';
import { listAlwaysAllow, setAlwaysAllow } from '../../background/gm-permissions';
import { saveScript } from '../../storage/scripts';
import type { UserScript } from '../../shared/types';

(browser as unknown as Record<string, unknown>).notifications = { create: vi.fn(async () => 'id') };

function mkScript(over: Partial<UserScript> = {}): UserScript {
  return {
    id: 's1', text: '// ==UserScript==\n// @name t\n// @match https://a.com/*\n// @connect api.a.com\n// @grant GM_setValue\n// @grant GM_wat\n// ==/UserScript==\nx();',
    name: 't', enabled: true, matches: ['https://a.com/*'], code: 'x();',
    runAt: 'document_idle', world: 'USER_SCRIPT', source: 'user', createdAt: 1, updatedAt: 1,
    meta: { grants: ['GM_setValue', 'GM_wat'], connects: ['api.a.com'] }, ...over,
  };
}

describe('gm-debug handlers', () => {
  beforeEach(() => { fakeBrowser.reset(); vi.restoreAllMocks(); });

  it('GM_DEBUG_CALL：token 查不到（脚本未匹配目标页）时报错', async () => {
    await saveScript(mkScript());
    const router = new MessageRouter();
    initGmApi(router);
    vi.spyOn(browser.tabs, 'get').mockResolvedValue({ id: 9, url: 'https://other.com/' } as never);
    const r = await router.dispatch({ type: 'GM_DEBUG_CALL', scriptId: 's1', api: 'SetValue', params: ['k', 1], tabId: 9 }) as { dispatched: boolean; error?: string };
    expect(r.dispatched).toBe(false);
    expect(r.error).toMatch(/未注入|token|匹配/);
  });

  it('GM_DEBUG_CALL：命中则下发 GM_DEBUG_INVOKE，回 result', async () => {
    await saveScript(mkScript());
    const router = new MessageRouter();
    initGmApi(router);
    vi.spyOn(browser.tabs, 'get').mockResolvedValue({ id: 9, url: 'https://a.com/x' } as never);
    const send = vi.spyOn(browser.tabs, 'sendMessage').mockResolvedValue({ result: { ok: true, data: 42 } } as never);
    const r = await router.dispatch({ type: 'GM_DEBUG_CALL', scriptId: 's1', api: 'GetValue', params: ['k'], tabId: 9 }) as { dispatched: boolean; result?: { ok: boolean; data?: unknown } };
    expect(send).toHaveBeenCalled();
    const sent = send.mock.calls[0]![1] as { type: string; payload: { api: string } };
    expect(sent.type).toBe('GM_DEBUG_INVOKE');
    expect(sent.payload.api).toBe('GetValue');
    expect(r.dispatched).toBe(true);
    expect(r.result).toEqual({ ok: true, data: 42 });
  });

  it('GM_DEBUG_INFO：回 grant 二分 + connects + alwaysAllow + injected', async () => {
    await saveScript(mkScript());
    await setAlwaysAllow('s1', 'cdn.x.com');
    const router = new MessageRouter();
    initGmApi(router);
    vi.spyOn(browser.tabs, 'get').mockResolvedValue({ id: 9, url: 'https://a.com/x' } as never);
    const r = await router.dispatch({ type: 'GM_DEBUG_INFO', scriptId: 's1', tabId: 9 }) as { ok: boolean; data: { grantSupported: string[]; grantUnsupported: string[]; connects: string[]; alwaysAllow: string[]; injected: boolean } };
    expect(r.ok).toBe(true);
    expect(r.data.grantSupported).toContain('GM_setValue');
    expect(r.data.grantUnsupported).toContain('GM_wat');
    expect(r.data.connects).toContain('api.a.com');
    expect(r.data.alwaysAllow).toContain('cdn.x.com');
    expect(r.data.injected).toBe(true);
  });

  it('listAlwaysAllow：无记录返回空', async () => {
    expect(await listAlwaysAllow('nope')).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test -- gm-debug`
Expected: FAIL（`listAlwaysAllow` 无导出 / 无 handler，dispatch 回 `no handler`）

- [ ] **Step 3: gm-permissions.ts 加 listAlwaysAllow**

在 [background/gm-permissions.ts](../../../background/gm-permissions.ts) 的 `getAlwaysAllow` 之后追加：

```ts
/** 某脚本已「始终允许」的全部跨域主机（白名单视图，spec §3.①）。 */
export async function listAlwaysAllow(scriptId: string): Promise<string[]> {
  const all = await readAll();
  return Object.keys(all[scriptId]?.cors ?? {});
}
```

- [ ] **Step 4: gm-api.ts 顶部补 import + 静态 classifyGrants**

把 [background/gm-api.ts:6-10](../../../background/gm-api.ts#L6-L10) 的 import 段：

```ts
import type { GmEventKind } from '../shared/gm-bridge';
import { storage } from 'wxt/utils/storage';
import { getScript } from '../storage/scripts';
import { matchUrl } from '../shared/match-pattern';
import { bridgeTokensForUrl } from './gm-token';
```

改为：

```ts
import type { GmEventKind } from '../shared/gm-bridge';
import { storage } from 'wxt/utils/storage';
import { getScript } from '../storage/scripts';
import { matchUrl } from '../shared/match-pattern';
import { bridgeTokensForUrl } from './gm-token';
import { classifyGrants } from '../shared/gm-apis';
import { createRequest, type CsResponse, type GmDebugInfoData } from '../shared/messages';
```

- [ ] **Step 5: gm-api.ts 加直调 helper + 两个函数（在 initGmApi 之前）**

在 [background/gm-api.ts](../../../background/gm-api.ts) 的 `handleGmCall` 函数之后、`initGmApi` 之前追加：

```ts
// ---- 面板直调（脚本运行时调试台，spec §3）----

async function resolveTab(tabId?: number): Promise<{ id: number; url: string } | null> {
  let id = tabId;
  if (id == null) {
    let [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab) [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    id = tab?.id;
  }
  if (id == null) return null;
  const tab = await browser.tabs.get(id).catch(() => undefined);
  return tab?.id != null ? { id: tab.id, url: tab.url ?? '' } : null;
}

/** GM_DEBUG_CALL：查 token（=脚本是否注入目标页）→ tabs.sendMessage 下发 GM_DEBUG_INVOKE。 */
async function handleDebugCall(
  scriptId: string, api: string, params: unknown[], tabId: number | undefined,
): Promise<{ dispatched: boolean; result?: { ok: boolean; data?: unknown; error?: string }; ms: number; error?: string }> {
  const started = Date.now();
  const tab = await resolveTab(tabId);
  if (!tab) return { dispatched: false, ms: Date.now() - started, error: '无法获取目标标签页（请切到普通网页）' };
  const entries = await bridgeTokensForUrl(tab.url);
  if (!entries.some((e) => e.scriptId === scriptId)) {
    return { dispatched: false, ms: Date.now() - started, error: '脚本未注入目标页（@match 未命中或未启用），无法直调' };
  }
  try {
    const req = createRequest('GM_DEBUG_INVOKE', { scriptId, api, params });
    // frameId: 0 钉主帧——content script allFrames 注册，不钉会广播到所有帧（iframe 重复执行 debugCall，抢答）
    const resp = (await browser.tabs.sendMessage(tab.id, req, { frameId: 0 })) as CsResponse | undefined;
    return { dispatched: true, result: resp?.result, ms: Date.now() - started };
  } catch (e) {
    return { dispatched: false, ms: Date.now() - started, error: e instanceof Error ? e.message : String(e) };
  }
}

/** GM_DEBUG_INFO：白名单视图数据（grant 二分 + connects + alwaysAllow + 注入态）。 */
async function handleDebugInfo(scriptId: string, tabId: number | undefined): Promise<{ ok: boolean; data?: GmDebugInfoData; error?: string }> {
  const script = await getScript(scriptId);
  if (!script) return { ok: false, error: '脚本不存在' };
  const tab = await resolveTab(tabId);
  const tabUrl = tab?.url ?? '';
  const { supported, unsupported } = classifyGrants(script.meta?.grants ?? []);
  const { listAlwaysAllow } = await import('./gm-permissions');
  const entries = tabUrl ? await bridgeTokensForUrl(tabUrl) : [];
  return {
    ok: true,
    data: {
      connects: script.meta?.connects ?? [],
      grantSupported: supported,
      grantUnsupported: unsupported,
      alwaysAllow: await listAlwaysAllow(scriptId),
      injected: entries.some((e) => e.scriptId === scriptId),
      tabUrl,
    },
  };
}
```

- [ ] **Step 6: gm-api.ts 在 initGmApi 内注册两个 handler**

在 [background/gm-api.ts](../../../background/gm-api.ts) 的 `initGmApi` 内，`SCRIPTS_GET_GM_STATE` handler 之后（`browser.notifications?.onClicked` 之前）追加：

```ts
  router.on('GM_DEBUG_CALL', async (msg) => {
    const { scriptId, api, params, tabId } = msg as unknown as { scriptId: string; api: string; params: unknown[]; tabId?: number };
    return handleDebugCall(scriptId, api, params, tabId);
  });

  router.on('GM_DEBUG_INFO', async (msg) => {
    const { scriptId, tabId } = msg as unknown as { scriptId: string; tabId?: number };
    return handleDebugInfo(scriptId, tabId);
  });
```

- [ ] **Step 7: 跑测试确认通过**

Run: `npm run test -- gm-debug`
Expected: PASS（4 用例）

- [ ] **Step 8: 全量测试 + 编译**

Run: `npm run test && npm run compile`
Expected: 全 PASS，编译无错误。

- [ ] **Step 9: 提交**

```bash
git add background/gm-permissions.ts background/gm-api.ts tests/background/gm-debug.test.ts
git diff --cached --name-only
git commit -m "feat(gm): GM_DEBUG_CALL/INFO SW handler + listAlwaysAllow + 测试"
```

---

## Task 8: ScriptDebugPage（脚本运行时调试台）

三块自上而下：白名单视图（`GM_DEBUG_INFO`）+ GM API 列表（`GM_API_REGISTRY` 14 行）+ 三类直调（bridge 7 / SW 分支 2 完整链路，页面内 5 置灰）。结果复用 `ResultPanel`。挂载自拉脚本列表（不依赖脚本页是否访问过）。

**Files:**
- Create: `components/scriptdebug/ScriptDebugPage.tsx`

- [ ] **Step 1: 写实现（imports + API 三类分类表 + host helper）**

`components/scriptdebug/ScriptDebugPage.tsx`：

```tsx
// components/scriptdebug/ScriptDebugPage.tsx
// 脚本运行时调试台（设置二级页，spec §3）：白名单视图 + GM API 列表 + 经真实桥链路直调。
// 直调 api 用点形式短名（SetValue/XmlHttpRequest…），与 wrapper 实际发出形式一致。
import { useEffect, useState } from 'react';
import { ArrowLeft, ChevronRight, Play, Loader2, Globe, Check, X } from 'lucide-react';
import { PageShell } from '../ui/PageShell';
import { Button } from '../ui/Button';
import { GM_API_REGISTRY } from '../../shared/gm-apis';
import { sendScriptsRequest } from '../../stores/scripts';
import type { DebugExecResponse, GmDebugInfoData } from '../../shared/messages';
import type { ScriptSummary } from '../../shared/types';
import { ResultPanel, type Outcome } from '../debug/ResultPanel';

type CallKind = 'bridge' | 'sw' | 'page';

/** 14 个 GM API 的直调分类 + 点形式短名（spec §3③）。 */
const CALL: Record<string, { kind: CallKind; short?: string; hint: string }> = {
  // bridge 7：完整真实链路
  GM_setValue: { kind: 'bridge', short: 'SetValue', hint: '["key", "value"]' },
  GM_deleteValue: { kind: 'bridge', short: 'DeleteValue', hint: '["key"]' },
  GM_registerMenuCommand: { kind: 'bridge', short: 'RegisterMenu', hint: '["cmdKey", "菜单名"]' },
  GM_setClipboard: { kind: 'bridge', short: 'SetClipboard', hint: '["要复制的文本"]' },
  GM_notification: { kind: 'bridge', short: 'Notification', hint: '[{"title":"标题","text":"正文"}, "notifId"]' },
  GM_openInTab: { kind: 'bridge', short: 'OpenInTab', hint: '["https://example.com", {"active":true}]' },
  GM_xmlhttpRequest: { kind: 'bridge', short: 'XmlHttpRequest', hint: '[{"url":"https://api.a.com","method":"GET"}]' },
  // SW 有分支 2：经桥调 SW 的 GetValue/ListValues，返回 storage 实时值（非页面快照）
  GM_getValue: { kind: 'sw', short: 'GetValue', hint: '["key", "默认值"]' },
  GM_listValues: { kind: 'sw', short: 'ListValues', hint: '[]' },
  // 页面内 5：不可远程直调（值快照直嵌 / local 完成）
  GM_info: { kind: 'page', hint: '页面内 API（注入期快照）' },
  GM_getResourceText: { kind: 'page', hint: '页面内 API（注入期资源快照）' },
  GM_addStyle: { kind: 'page', hint: '页面内 API（DOM 本地完成）' },
  GM_log: { kind: 'page', hint: '页面内 API（console 本地完成）' },
  GM_addValueChangeListener: { kind: 'page', hint: '页面内 API（本地注册监听）' },
};

const KIND_NOTE: Record<CallKind, string> = {
  bridge: '完整真实链路（token 校验 → grant 白名单 → handleGmCall → @connect 确认流）',
  sw: '经桥调 SW 分支，返回 storage 实时值（非页面快照）',
  page: '页面内 API，不可远程直调（第一版取舍）',
};

function hostOf(url: string): string {
  try { return new URL(url).host || url; } catch { return url || '—'; }
}
```

- [ ] **Step 2: 写实现（主组件：脚本选择 + 白名单视图）**

续写同文件：

```tsx
export function ScriptDebugPage({ onBack }: { onBack: () => void }) {
  const [scripts, setScripts] = useState<ScriptSummary[]>([]);
  const [scriptId, setScriptId] = useState<string>('');
  const [info, setInfo] = useState<GmDebugInfoData | null>(null);

  useEffect(() => {
    void (async () => {
      const resp = await sendScriptsRequest<{ ok: boolean; data?: { scripts: ScriptSummary[] } }>({ type: 'SCRIPTS_LIST' });
      const list = resp.data?.scripts ?? [];
      setScripts(list);
      if (list.length > 0 && list[0]) setScriptId(list[0].id);
    })();
  }, []);

  useEffect(() => {
    if (!scriptId) { setInfo(null); return; }
    void (async () => {
      const resp = await sendScriptsRequest<{ ok: boolean; data?: GmDebugInfoData }>({ type: 'GM_DEBUG_INFO', scriptId });
      setInfo(resp.data ?? null);
    })();
  }, [scriptId]);

  const targetHost = info ? hostOf(info.tabUrl) : '—';

  return (
    <PageShell
      title="脚本运行时调试台"
      eyebrow="SCRIPTDEBUG"
      right={
        <span className="gauge" title={info?.tabUrl}>
          <Globe size={12} color="var(--ink-3)" />
          <span className="gauge__label mono" style={{ maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{targetHost}</span>
        </span>
      }
      actions={<Button variant="ghost" onClick={onBack} aria-label="返回"><ArrowLeft size={14} /></Button>}
    >
      {scripts.length === 0 ? (
        <div className="chat__empty">脚本池为空——先在脚本池新建或导入脚本</div>
      ) : (
        <>
          <div className="field">
            <label className="field-label">目标脚本</label>
            <select className="input" value={scriptId} onChange={(e) => setScriptId(e.target.value)}>
              {scripts.map((s) => <option key={s.id} value={s.id}>{s.name}{s.enabled ? '' : '（已禁用）'}</option>)}
            </select>
          </div>

          <section style={{ marginBottom: 18 }}>
            <div className="toolgroup__head mono">── 白名单视图 ──</div>
            {info == null ? (
              <div className="hint">加载中…</div>
            ) : (
              <div className="gm-whitelist">
                <div className="gm-whitelist__row">
                  <span className={`dot dot--${info.injected ? 'ok' : 'err'}`} />
                  注入态：{info.injected ? '已注入目标页（可直调 bridge/SW 类）' : '未注入目标页（切到 @match 命中的页再调）'}
                </div>
                <div style={{ marginTop: 6 }}>@grant supported：</div>
                {info.grantSupported.length === 0 ? <div className="gm-api-note">（无）</div> :
                  info.grantSupported.map((g) => <div key={g} className="gm-whitelist__row" style={{ color: 'var(--ink-2)' }}><Check size={11} aria-hidden /> {g}</div>)}
                {info.grantUnsupported.length > 0 && (
                  <>
                    <div style={{ marginTop: 6 }}>@grant unsupported（注入期即被拒装）：</div>
                    {info.grantUnsupported.map((g) => <div key={g} className="gm-whitelist__row" style={{ color: 'var(--warn)' }}><X size={11} aria-hidden /> {g}</div>)}
                  </>
                )}
                <div style={{ marginTop: 6 }}>@connect：{info.connects.length > 0 ? info.connects.join('  ') : '（无——仅 self/子域放行，其余弹确认）'}</div>
                <div style={{ marginTop: 2 }}>始终允许主机：{info.alwaysAllow.length > 0 ? info.alwaysAllow.join('  ') : '（无）'}</div>
                <div className="gm-api-note" style={{ margin: '6px 0 0 0' }}>
                  matchConnect 三分支：self/子域放行；列了不中 → DENY；未列 → 查始终允许库，否则弹确认卡。
                </div>
              </div>
            )}
          </section>

          <section>
            <div className="toolgroup__head mono">── GM API 列表 · {Object.keys(GM_API_REGISTRY).length} ──</div>
            <div className="toolgroup__hint">bridge/SW 类可展开填 JSON params 直调；页面内 API 置灰。</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {Object.keys(GM_API_REGISTRY).map((name) => (
                <GmApiRow key={name} name={name} scriptId={scriptId} injected={info?.injected ?? false} />
              ))}
            </div>
          </section>
        </>
      )}
    </PageShell>
  );
}
```

- [ ] **Step 3: 写实现（GmApiRow 子组件 + 直调）**

续写同文件：

```tsx
function GmApiRow({ name, scriptId, injected }: { name: string; scriptId: string; injected: boolean }) {
  const def = GM_API_REGISTRY[name]!;
  const call = CALL[name]!;
  const impl = def.impl.toUpperCase(); // SNAPSHOT / LOCAL / BRIDGE
  const callable = call.kind !== 'page';

  const [open, setOpen] = useState(false);
  const [argsText, setArgsText] = useState(call.hint.startsWith('[') ? call.hint : '[]');
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const run = async () => {
    let params: unknown[];
    try {
      const parsed = argsText.trim() === '' ? [] : JSON.parse(argsText);
      if (!Array.isArray(parsed)) throw new Error('params 必须是 JSON 数组，如 ["key", "value"]');
      params = parsed;
    } catch (e) {
      setOutcome({ kind: 'bad-args', message: e instanceof Error ? e.message : String(e) });
      return;
    }
    setRunning(true);
    setOutcome(null);
    try {
      const resp = await sendScriptsRequest<DebugExecResponse>({ type: 'GM_DEBUG_CALL', scriptId, api: call.short!, params });
      setOutcome({ kind: 'result', resp });
    } catch (e) {
      setOutcome({ kind: 'link-error', message: e instanceof Error ? e.message : String(e) });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className={`gm-api-row${callable ? '' : ' is-disabled'}`}>
      <button className="tool-row" aria-expanded={open} disabled={!callable} onClick={() => callable && setOpen((v) => !v)}>
        <span className="tool-row__head">
          {callable && (
            <ChevronRight size={13} color="var(--ink-3)" style={{ transition: 'transform var(--t-fast) var(--ease)', transform: open ? 'rotate(90deg)' : 'none' }} />
          )}
          <span className="tool-row__name">{name}</span>
          {def.promiseForm && <span className="param__type" style={{ fontSize: 10 }}>Promise</span>}
          <span className={`chip ${call.kind === 'bridge' ? 'chip--net' : call.kind === 'sw' ? 'chip--page' : 'chip--tabs'}`}>{impl}</span>
        </span>
      </button>
      {!callable && <div className="gm-api-note">{call.hint}</div>}
      {open && callable && (
        <div className="rise" style={{ padding: '10px 2px 4px' }}>
          <div className="gm-api-note" style={{ margin: '0 0 8px 0' }}>{KIND_NOTE[call.kind]}</div>
          {!injected && <div className="scripts-warnline">脚本未注入目标页——直调会因查不到 token 报错。</div>}
          <div className="token" style={{ marginBottom: 5 }}>PARAMS · JSON 数组（短名 {call.short}）</div>
          <textarea
            className="textarea mono-input"
            value={argsText}
            onChange={(e) => setArgsText(e.target.value)}
            spellCheck={false}
            rows={2}
            style={{ marginBottom: 8 }}
          />
          <Button variant="signal" onClick={run} disabled={running || !scriptId}>
            {running ? <Loader2 size={14} className="spin" /> : <Play size={14} />}
            {running ? '执行中…' : '直调'}
          </Button>
          {outcome && <ResultPanel outcome={outcome} />}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: 编译验证**

Run: `npm run compile`
Expected: 无错误（ScriptDebugPage 暂未被 import，Task 9 接线）。

- [ ] **Step 5: 提交**

```bash
git add components/scriptdebug/ScriptDebugPage.tsx
git diff --cached --name-only
git commit -m "feat(scriptdebug): 脚本运行时调试台——白名单视图 + GM API 三类直调"
```

---

## Task 9: SettingsHome + ModelSettings + SettingsView 壳 + 测试

`ModelSettings` = 现 SettingsView 表单内容原样平移 + `onBack`；`SettingsHome` = 三入口卡；`SettingsView` 改写为 `useState` 路由壳（`home`/`model`/`toolbench`/`scriptdebug`，不持久化）。二级页 eyebrow 用领域标签（`MODEL`/`TOOLBENCH`/`SCRIPTDEBUG`）而非规格的统一 `SETTING`——更利定位（自审记录声明偏差）。

**Files:**
- Create: `components/settings/ModelSettings.tsx`
- Create: `components/settings/SettingsHome.tsx`
- Modify: `components/settings/SettingsView.tsx`（改写为壳）
- Test: `tests/settings/settings-view.test.tsx`

- [ ] **Step 1: 写失败测试**

`tests/settings/settings-view.test.tsx`：

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { SettingsView } from '../../components/settings/SettingsView';

beforeEach(() => { fakeBrowser.reset(); vi.restoreAllMocks(); });
afterEach(cleanup);

describe('SettingsView 壳', () => {
  it('默认渲染列表页三入口', async () => {
    render(<SettingsView />);
    expect(await screen.findByText('模型设置')).toBeTruthy();
    expect(screen.getByText('工具调试台')).toBeTruthy();
    expect(screen.getByText('脚本运行时调试台')).toBeTruthy();
  });

  it('点「工具调试台」入口进二级页（TOOLBENCH），返回回列表', async () => {
    render(<SettingsView />);
    fireEvent.click(await screen.findByText('工具调试台'));
    expect(await screen.findByText('TOOLBENCH')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('返回'));
    expect(await screen.findByText('脚本运行时调试台')).toBeTruthy(); // 回到了列表
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test -- settings-view`
Expected: FAIL（SettingsView 仍是旧模型表单，无「工具调试台」入口文案）

- [ ] **Step 3: ModelSettings.tsx（现 SettingsView 表单平移 + onBack）**

`components/settings/ModelSettings.tsx`（正文与现 [components/settings/SettingsView.tsx](../../../components/settings/SettingsView.tsx) 一致，改函数名/加 onBack/换页眉）：

```tsx
// components/settings/ModelSettings.tsx
// 模型设置（设置二级页）：AI 服务表单（原 SettingsView 内容平移，加 onBack 返回钮）。
import { useEffect, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { PageShell } from '../ui/PageShell';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { getSettings, saveSettings, type Settings } from '../../storage/settings';
import { testConnection, type ConnectionTestResult } from '../../agent/provider/connection-test';
import { resolveContextWindow } from '../../agent/model-windows';

/** 解析额外参数 JSON：空串→undefined；非对象或非法→抛错（供保存时拦截）。 */
function parseExtraBody(text: string): Record<string, unknown> | undefined {
  const t = text.trim();
  if (!t) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(t);
  } catch {
    throw new Error('不是合法 JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('必须是 JSON 对象，如 {"enable_thinking": true}');
  }
  return parsed as Record<string, unknown>;
}

export function ModelSettings({ onBack }: { onBack: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);
  const [extraText, setExtraText] = useState('');
  const [extraError, setExtraError] = useState<string | null>(null);

  useEffect(() => {
    getSettings().then((s) => {
      setSettings(s);
      setExtraText(s.provider.extraBody ? JSON.stringify(s.provider.extraBody, null, 2) : '');
    });
  }, []);

  const back = <Button variant="ghost" onClick={onBack} aria-label="返回"><ArrowLeft size={14} /></Button>;

  if (!settings) {
    return (
      <PageShell title="模型设置" eyebrow="MODEL" actions={back}>
        <div className="hint">加载中…</div>
      </PageShell>
    );
  }

  const setProvider = (patch: Partial<Settings['provider']>) =>
    setSettings({ ...settings, provider: { ...settings.provider, ...patch } });

  const resolveProvider = (): Settings['provider'] | null => {
    try {
      const extraBody = parseExtraBody(extraText);
      setExtraError(null);
      return { ...settings.provider, extraBody };
    } catch (e) {
      setExtraError(e instanceof Error ? e.message : String(e));
      return null;
    }
  };

  const handleSave = async () => {
    const provider = resolveProvider();
    if (!provider) return;
    setSettings({ ...settings, provider });
    await saveSettings({ provider, agent: settings.agent });
    setTestResult(null);
  };

  const handleTest = async () => {
    const provider = resolveProvider();
    if (!provider) return;
    setSettings({ ...settings, provider });
    setTesting(true);
    setTestResult(null);
    await saveSettings({ provider });
    const r = await testConnection(provider);
    setTestResult(r);
    setTesting(false);
  };
```

- [ ] **Step 4: ModelSettings.tsx（return JSX，续同文件）**

续写 `components/settings/ModelSettings.tsx`（表单与现 SettingsView 一致，仅页眉加 `actions={back}`）：

```tsx
  return (
    <PageShell title="模型设置" eyebrow="MODEL" actions={back}>
      <section className="section">
        <h2 className="section__title">AI 服务（OpenAI 兼容）</h2>
        <div className="field">
          <label className="field-label">Base URL</label>
          <Input value={settings.provider.baseUrl} onChange={(e) => setProvider({ baseUrl: e.target.value })} placeholder="https://api.deepseek.com/v1" />
        </div>
        <div className="field">
          <label className="field-label">API Key</label>
          <Input type="password" value={settings.provider.apiKey} onChange={(e) => setProvider({ apiKey: e.target.value })} placeholder="sk-…" />
        </div>
        <div className="field">
          <label className="field-label">模型</label>
          <Input value={settings.provider.model} onChange={(e) => setProvider({ model: e.target.value })} placeholder="deepseek-chat" />
        </div>
        <div className="field">
          <label className="field-label">上下文窗口（token，选填）</label>
          <Input
            type="number"
            value={settings.provider.contextWindow ?? ''}
            onChange={(e) => {
              const v = e.target.value.trim();
              setProvider({ contextWindow: v === '' ? undefined : Number(v) });
            }}
            placeholder={String(resolveContextWindow(settings.provider.model))}
          />
          <span className="hint">留空则按模型名自动推断。用于上下文用量标识与压缩阈值。</span>
        </div>
        <div className="field">
          <label className="field-label">额外请求参数（JSON，选填）</label>
          <textarea
            className="textarea mono-input"
            value={extraText}
            onChange={(e) => { setExtraText(e.target.value); setExtraError(null); }}
            placeholder={'{\n  "enable_thinking": true\n}'}
            spellCheck={false}
            rows={4}
          />
          {extraError ? (
            <span className="status-text status-text--err">参数无效：{extraError}</span>
          ) : (
            <span className="hint">合并进请求体，用于开启各网关的思考等开关（如 enable_thinking / reasoning_effort）。核心字段受保护不被覆盖。</span>
          )}
        </div>
      </section>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <Button variant="primary" onClick={handleSave}>保存</Button>
        <Button onClick={handleTest} disabled={testing}>{testing ? '测试中…' : '测试连接'}</Button>
        {testResult && (
          <span className={`status-text ${testResult.ok ? 'status-text--ok' : 'status-text--err'}`}>
            {testResult.ok ? `连接成功：${testResult.data}` : testResult.error}
          </span>
        )}
      </div>
    </PageShell>
  );
}
```

- [ ] **Step 5: SettingsHome.tsx（三入口卡）**

`components/settings/SettingsHome.tsx`：

```tsx
// components/settings/SettingsHome.tsx
// 设置列表页（spec §1）：三入口卡片，点卡走 onOpen 切二级页。
import { SlidersHorizontal, SquareTerminal, FlaskConical, ChevronRight } from 'lucide-react';
import { PageShell } from '../ui/PageShell';

export type SettingsSub = 'model' | 'toolbench' | 'scriptdebug';

const ENTRIES: Array<{ key: SettingsSub; title: string; desc: string; Icon: typeof SlidersHorizontal }> = [
  { key: 'model', title: '模型设置', desc: 'AI 服务地址 / API Key / 模型 / 上下文窗口', Icon: SlidersHorizontal },
  { key: 'toolbench', title: '工具调试台', desc: '绕过模型，直接对当前页调用 25 个工具', Icon: SquareTerminal },
  { key: 'scriptdebug', title: '脚本运行时调试台', desc: 'GM API 白名单视图 + 经真实桥链路直调', Icon: FlaskConical },
];

export function SettingsHome({ onOpen }: { onOpen: (sub: SettingsSub) => void }) {
  return (
    <PageShell title="设置" eyebrow="CONFIG">
      {ENTRIES.map(({ key, title, desc, Icon }) => (
        <button key={key} className="setting-card" onClick={() => onOpen(key)}>
          <span className="setting-card__icon"><Icon size={18} strokeWidth={1.8} /></span>
          <span className="setting-card__body">
            <span className="setting-card__title">{title}</span>
            <div className="setting-card__desc">{desc}</div>
          </span>
          <ChevronRight size={16} className="setting-card__chev" aria-hidden />
        </button>
      ))}
    </PageShell>
  );
}
```

- [ ] **Step 6: SettingsView.tsx 改写为壳**

把 [components/settings/SettingsView.tsx](../../../components/settings/SettingsView.tsx) 整个文件替换为：

```tsx
// components/settings/SettingsView.tsx
// 设置枢纽壳（spec §1）：useState 二级路由（不持久化，每次进设置从列表开始）。
import { useState } from 'react';
import { SettingsHome, type SettingsSub } from './SettingsHome';
import { ModelSettings } from './ModelSettings';
import { ToolBenchPage } from '../debug/ToolBenchPage';
import { ScriptDebugPage } from '../scriptdebug/ScriptDebugPage';

export function SettingsView() {
  const [sub, setSub] = useState<SettingsSub | null>(null);
  const back = () => setSub(null);

  if (sub === 'model') return <ModelSettings onBack={back} />;
  if (sub === 'toolbench') return <ToolBenchPage onBack={back} />;
  if (sub === 'scriptdebug') return <ScriptDebugPage onBack={back} />;
  return <SettingsHome onOpen={setSub} />;
}
```

- [ ] **Step 7: 跑测试确认通过**

Run: `npm run test -- settings-view`
Expected: PASS（2 用例）

- [ ] **Step 8: 提交**

```bash
git add components/settings/ModelSettings.tsx components/settings/SettingsHome.tsx components/settings/SettingsView.tsx tests/settings/settings-view.test.tsx
git diff --cached --name-only
git commit -m "feat(settings): 设置枢纽壳 + 三入口列表 + 模型设置平移 + 测试"
```

---

## Task 10: railnav 3 项 + Page 删 'debug' + 删 DebugView

`stores/ui.ts` 的 `Page` 删 `'debug'`；`App.tsx` NAV 删调试台项 + 删 import/渲染分支；删 `components/debug/DebugView.tsx`（内容已迁 ToolBenchPage/ResultPanel）。此刻 SettingsView 已能路由 ToolBenchPage，可安全删。

**Files:**
- Modify: `stores/ui.ts`
- Modify: `entrypoints/sidepanel/App.tsx`
- Delete: `components/debug/DebugView.tsx`

- [ ] **Step 1: stores/ui.ts 删 'debug'**

把 [stores/ui.ts:4](../../../stores/ui.ts#L4)：

```ts
export type Page = 'chat' | 'scripts' | 'debug' | 'settings';
```

改为：

```ts
export type Page = 'chat' | 'scripts' | 'settings';
```

- [ ] **Step 2: App.tsx NAV 3 项 + 删 DebugView 引用**

把 [entrypoints/sidepanel/App.tsx](../../../entrypoints/sidepanel/App.tsx) 整个文件替换为：

```tsx
// entrypoints/sidepanel/App.tsx
import { MessageSquare, Puzzle, Settings as SettingsIcon } from 'lucide-react';
import { useUi, type Page } from '../../stores/ui';
import { ChatView } from '../../components/chat/ChatView';
import { ScriptsView } from '../../components/scripts/ScriptsView';
import { SettingsView } from '../../components/settings/SettingsView';

const NAV: Array<{ page: Page; label: string; Icon: typeof MessageSquare }> = [
  { page: 'chat', label: '会话', Icon: MessageSquare },
  { page: 'scripts', label: '脚本池', Icon: Puzzle },
  { page: 'settings', label: '设置', Icon: SettingsIcon },
];

const PITCH = 42; // 每个导航按钮的纵向节距（40 高 + 2 gap）

export default function App() {
  const { page, setPage } = useUi();
  const activeIndex = NAV.findIndex((n) => n.page === page);

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      <nav className="railnav" aria-label="主导航">
        <span
          className="railnav__marker"
          style={{ ['--i' as string]: activeIndex, ['--pitch' as string]: `${PITCH}px` }}
          aria-hidden
        />
        {NAV.map(({ page: p, label, Icon }) => (
          <button
            key={p}
            className="railnav__btn"
            title={label}
            aria-label={label}
            aria-current={page === p}
            onClick={() => setPage(p)}
          >
            <Icon size={18} strokeWidth={1.8} />
          </button>
        ))}
      </nav>
      <main style={{ flex: 1, minWidth: 0, height: '100%' }}>
        {page === 'chat' && <ChatView />}
        {page === 'scripts' && <ScriptsView />}
        {page === 'settings' && <SettingsView />}
      </main>
    </div>
  );
}
```

- [ ] **Step 3: 删 DebugView.tsx**

```bash
git rm components/debug/DebugView.tsx
```

- [ ] **Step 4: 全量测试 + 编译（关键门禁）**

Run: `npm run test && npm run compile`
Expected: 全 PASS，编译无错误，无对 `DebugView` / `page==='debug'` / `chip--cs` 的残留引用。

- [ ] **Step 5: 提交**

```bash
git add stores/ui.ts entrypoints/sidepanel/App.tsx components/debug/DebugView.tsx
git diff --cached --name-only
git commit -m "refactor(nav): railnav 减为 3 项，调试台入口收进设置页；删 DebugView"
```

---

## Task 11: CLAUDE.md 同步 + 手动验收

文档同步 + 浏览器手动验收（自动化测试覆盖不到 MAIN world wrapper 与真实注入）。

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: CLAUDE.md 追加阶段说明**

在 [CLAUDE.md](../../../CLAUDE.md) 末尾（Phase 5 段之后）追加一段：

```markdown
设置页枢纽 + 脚本运行时调试台（2026-09-03）已完成：railnav 减为 3 项（会话/脚本池/设置），调试台入口收进设置页。设置页改为壳（`components/settings/SettingsView.tsx` 内部 `useState` 二级路由，不持久化）→ 三入口：模型设置（`ModelSettings.tsx`，原表单平移）/ 工具调试台（`components/debug/ToolBenchPage.tsx`，按能力域 PAGE/TABS/NET/SCRIPTS 四分分组 + tag chip 四档，修正原 12 个错标 TABS）/ 脚本运行时调试台（`components/scriptdebug/ScriptDebugPage.tsx`）。工具能力域数据抽 `components/debug/tool-tags.ts`（可测），结果面板抽 `components/debug/ResultPanel.tsx`（工具台与 GM 台共用）。脚本运行时调试台三块：白名单视图（`GM_DEBUG_INFO` 回 grant 二分/@connect/始终允许主机/注入态）、GM API 列表（读 `GM_API_REGISTRY` 14 行）、三类直调（bridge 7 + SW 分支 2 完整真实链路，页面内 5 置灰）。直调链路：面板 `GM_DEBUG_CALL`→SW `bridgeTokensForUrl` 查 token→`GM_DEBUG_INVOKE` 下行 content→`gm-bridge-host.debugCall()` 在页面 dispatch `gmreq`（debug 命名空间 reqId 从 10 亿起）→宿主真实 token 校验 + `handleGmCall`→`gmres` 回环（10s 超时），除 wrapper 函数体外全链路真实。直调 api 用点形式短名（SetValue/XmlHttpRequest…）。已知边界：SW 内存态随重启丢失；页面内 5 API 置灰是第一版取舍；受限页因查不到 token 直接报错。
```

- [ ] **Step 2: 提交**

```bash
git add CLAUDE.md
git diff --cached --name-only
git commit -m "docs: 同步设置页枢纽 + 脚本运行时调试台阶段说明"
```

- [ ] **Step 3: 手动验收（`npm run dev` 加载扩展）**

- [ ] railnav 只剩 3 项（会话/脚本池/设置），滑动 marker 落位正确。
- [ ] 进设置 → 列表页三入口卡；点「模型设置」进表单、返回回列表；工具调试台/脚本运行时调试台同理。
- [ ] 工具调试台：4 组标题（页面操作 PAGE·10 / 标签页与导航 TABS·5 / 网络与观测 NET·4 / 脚本池管理 SCRIPTS·6），chip 四色区分；随便跑一个 `take_snapshot` 出 OK 结果。
- [ ] 在一个 `*://*/*` 命中的普通网页，脚本运行时调试台选中一个启用脚本 → 白名单视图注入态为「已注入」；直调 `GM_setValue`（params `["k",1]`）出 OK；再直调 `GM_getValue`（`["k"]`）返回 1。
- [ ] 直调 `GM_xmlhttpRequest` 到非 @connect 主机 → 脚本页弹批准卡（确认流真实触发）。
- [ ] 页面内 5 API（GM_info 等）行置灰不可展开。

---

## 计划自审记录

### 1. 规格覆盖

| 规格节 | 落地任务 |
|---|---|
| §1 导航结构与文件布局 | Task 3（ToolBenchPage）、Task 9（设置壳/Home/ModelSettings）、Task 10（railnav 3 项 + Page 删 debug） |
| §2 工具台分组 + tag 修正 | Task 1（tool-tags 纯模块 + 完备性/计数测试）、Task 3（分组渲染）、Task 4（chip 四档） |
| §3① 白名单视图 | Task 6（`GmDebugInfoData`）、Task 7（`handleDebugInfo` + `listAlwaysAllow`）、Task 8（视图渲染） |
| §3② GM API 列表 | Task 8（读 `GM_API_REGISTRY` 14 行 + impl chip + Promise 标记） |
| §3③ 三类直调 | Task 8（`CALL` 三类分类表 + 页面内置灰）、Task 5（bridge/SW 经真实桥 `debugCall`） |
| §3 直调协议 | Task 5（`debugCall`/`ensureAttached`）、Task 6（三消息 + content route case）、Task 7（SW 两 handler） |
| §4 测试 4 项 | tool-tags（T1）、gm-bridge-host 扩展（T5）、gm-debug（T7）、设置壳路由（T9）；另加 ResultPanel（T2）与 result-panel 测试 |
| §5 文件清单 | 全覆盖（改 ui/App、改写 SettingsView、迁移 DebugView→ToolBenchPage+ResultPanel、新增 ScriptDebugPage、协议四文件、样式、CLAUDE.md） |
| §6 已知边界 | Task 11 CLAUDE.md + 本文档声明 |

无遗漏节。

### 2. 占位符扫描

全任务代码块均为完整可编译代码，无 TBD/TODO/"类似上文"/"补充错误处理"等占位。每个 code step 附完整代码，每个验证 step 附精确命令与预期输出。

### 3. 类型一致性

- `debugCall(scriptId, api, params, timeoutMs=10_000)`（T5）↔ content route `debugCall(payload.scriptId, payload.api, payload.params)`（T6，用默认超时）↔ 测试传第 4 参短超时——签名一致。
- `handleDebugCall` 返回 `{dispatched, result?, ms, error?}` ≡ `DebugExecResponse`（T6 定义）↔ `ScriptDebugPage` 以 `sendScriptsRequest<DebugExecResponse>` 收 ↔ `ResultPanel` 的 `Outcome.result.resp` 消费——形状一致。
- `GmDebugInfoData`（T6 messages）↔ `handleDebugInfo` 返回（T7）↔ `ScriptDebugPage` 消费（T8）——字段名一致（connects/grantSupported/grantUnsupported/alwaysAllow/injected/tabUrl）。
- `createRequest('GM_DEBUG_INVOKE', …)`（T7）依赖 `GM_DEBUG_INVOKE ∈ BgToCsRequestMap`（T6）——任务顺序 T6→T7 满足。
- `ToolTag`/`GROUPS`/`getTag`/`CHIP_CLASS`（T1）↔ ToolBenchPage 消费（T3）——导出名一致。
- `listAlwaysAllow`（T7 gm-permissions）静态导入（测试）与动态导入（handleDebugInfo）同名。
- `CALL` 表 14 键 ≡ `GM_API_REGISTRY` 14 键（T8），bridge/sw 类均带 `short`，`call.short!` 安全（page 类不可调用不取 short）。

### 4. 与规格的实现细化（偏差声明）

1. **reqId 由 content 侧 `debugCall()` 生成**（10 亿起自增），`GM_DEBUG_INVOKE` payload 收窄为 `{scriptId, api, params}`——规格 §3 原写 payload 含 `token, reqId`。理由：reqId 唯一性只在页面内有意义，由 content 侧内聚生成；token 由宿主按同一 `bridgeTokensForUrl` 源实时取，SW 仅做「查得到 token 才下发」的 fail-fast 预检（不下传 token）。
2. **新增 `ensureAttached(scriptId)`**（规格未列）：token 表缺该 id 时先 `refreshTokens()` 一次，防「debug gmreq 早于 host 监听器挂载」竞态。
3. **新增 `GM_DEBUG_INFO` 消息 + `gm-permissions.listAlwaysAllow`**：规格 §3① 提到读 `gm-permissions` 但未定义 list 函数/独立消息。一次性回全部白名单数据，使面板无需 import background 模块即可渲染视图。
4. **二级页 eyebrow 用领域标签**（`MODEL`/`TOOLBENCH`/`SCRIPTDEBUG`）而非规格 §1 的统一 `SETTING`——更利定位与调试。
5. **工具总数为 25**（此前交接摘要笔误 22）：已核 `agent/tools/schemas.ts` 的 `TOOL_SCHEMAS`，四类计数 10/5/4/6 与 §2 一致。
6. **额外为 `ResultPanel` 写组件测试**（规格 §4 列 4 项，此为第 5 项冗余保险）。

### 5. 过渡态说明

`DebugView.tsx` 在 Task 4（chip 改名）到 Task 10（删除）之间，其 `chip--cs/api` 类名失配 → 该页 chip 无底色。因 App 在 Task 10 前仍 import DebugView（删早了编译断），此过渡态限于同一 feature 分支内的中间 commit，不影响最终态，可接受。

