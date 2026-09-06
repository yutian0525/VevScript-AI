# 脚本管理器 UI 重设计 + popup + 全屏详情页 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 侧边栏脚本页简化为纯管理器（卡片+switch），详情页迁出为全屏新标签页（Tab 四分区），扩展图标改为 popup（开侧边栏/脚本管理直达/当前页运行中脚本+菜单命令触发）。

**Architecture:** 三个扩展面（sidepanel / popup / script-detail）共用一套 `sendScriptsRequest`（`runtime.sendMessage` → MessageRouter）请求协议与 `styles.css` design tokens。新入口 `popup/`、`script-detail/` 为 WXT 多 HTML 入口。新增 4 个消息类型（UI_NAV / SCRIPTS_GET_RUNTIME 单 tab 变体沿用既有、SCRIPTS_GET_PERMISSIONS、SCRIPTS_REVOKE_PERMISSION），后台 handler 挂 `background/scripts.ts` 与 permissions 模块。

**Tech Stack:** WXT 0.21 + React 19 + TypeScript + zustand v5 + lucide-react + vitest v4/jsdom（WxtVitest 插件 + fakeBrowser）。

**规格:** `docs/superpowers/specs/2026-09-03-script-manager-ui-redesign-design.md`

**工作目录:** 全程在 worktree `D:\workspace-mou8\ai-browser-extend\.claude\worktrees\feat+script-optimize`（分支 `feat/script-optimize`）。

**测试约定（全计划通用）:**
- React 组件测试文件头加 `// @vitest-environment jsdom`（照 `tests/scripts/ScriptDetailView.test.tsx` 模式）。
- `afterEach(cleanup)`；`fakeBrowser.reset()` + `vi.restoreAllMocks()` 在 `beforeEach`。
- `browser.runtime.onMessage.addListener` mock 模式：handler 里 `sendResponse({ok:true, data:...}); return true;`（照 ScriptDetailView.test.tsx:29-36）。
- 每任务收尾跑 `npx vitest run <相关测试文件>`，全部完成跑 `npm run compile && npm run test`。

---

### Task 1: permissions 模块增读/撤 API + 三个新消息类型

**Files:**
- Modify: `background/gm-permissions.ts`
- Modify: `shared/messages.ts`
- Test: `tests/background/gm-permissions.test.ts`（已存在，追加用例）

- [ ] **Step 1: 写失败测试**——在 `tests/background/gm-permissions.test.ts` 末尾追加（先看该文件现有 describe 结构，保持同款 fakeBrowser/storage 模式）：

```typescript
describe('listAllowedHosts / revokeHost', () => {
  it('列出指定脚本的已授权 host，revokeHost 删除单条且幂等', async () => {
    await setAlwaysAllow('s1', 'a.com');
    await setAlwaysAllow('s1', 'b.com');
    await setAlwaysAllow('s2', 'c.com');
    expect((await listAllowedHosts('s1')).sort()).toEqual(['a.com', 'b.com']);
    await revokeHost('s1', 'a.com');
    expect(await listAllowedHosts('s1')).toEqual(['b.com']);
    await revokeHost('s1', 'not-exist.com'); // 幂等：不抛错
    expect(await listAllowedHosts('s1')).toEqual(['b.com']);
    expect(await listAllowedHosts('s3')).toEqual([]); // 无记录脚本 → 空数组
  });
});
```

文件顶部 import 行补 `listAllowedHosts, revokeHost`（与既有 `setAlwaysAllow` 等并列）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/background/gm-permissions.test.ts`
Expected: FAIL（`listAllowedHosts` 未导出）

- [ ] **Step 3: 实现**——`background/gm-permissions.ts` 追加：

```typescript
/** 指定脚本的已授权 host 列表（脚本设置页 XHR 安全区用）。 */
export async function listAllowedHosts(scriptId: string): Promise<string[]> {
  const all = await readAll();
  return Object.keys(all[scriptId]?.cors ?? {});
}

/** 撤销单条授权（幂等：条目不存在时静默成功）。 */
export async function revokeHost(scriptId: string, host: string): Promise<void> {
  const all = await readAll();
  const entry = all[scriptId];
  if (!entry || entry.cors[host] === undefined) return;
  delete entry.cors[host];
  if (Object.keys(entry.cors).length === 0) delete all[scriptId];
  await storage.setItem(KEY, all);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/background/gm-permissions.test.ts`
Expected: PASS

- [ ] **Step 5: 扩消息类型**——`shared/messages.ts` 的 `ScriptsRequest` 联合追加两支：

```typescript
  | { type: 'SCRIPTS_GET_PERMISSIONS'; id: string }
  | { type: 'SCRIPTS_REVOKE_PERMISSION'; id: string; host: string }
```

文件内（`ScriptsRuntimeEvent` 附近）新增顶层导出：

```typescript
/** popup/侧边栏跨面导航通知（popup → sidepanel，fire-and-forget；sidepanel 未开时由 pendingView 兜底） */
export interface UiNavNotification {
  type: 'UI_NAV';
  view: 'chat' | 'scripts' | 'debug' | 'settings';
}
```

- [ ] **Step 6: 全量编译+测试**

Run: `npm run compile && npm run test`
Expected: 无类型错误，全部 PASS

- [ ] **Step 7: Commit**

```bash
git add background/gm-permissions.ts shared/messages.ts tests/background/gm-permissions.test.ts
git commit -m "feat: permissions 读/撤 API + SCRIPTS_GET/REVOKE_PERMISSION 与 UI_NAV 消息类型"
```

---

### Task 2: 后台 handler 接线（permissions + popup 运行态）

**Files:**
- Modify: `background/scripts.ts`
- Test: `tests/background/scripts.test.ts`（已存在，追加用例）

- [ ] **Step 1: 写失败测试**——`tests/background/scripts.test.ts` 追加 describe（照该文件现有 router/fakeBrowser 模式）：

```typescript
describe('permissions & popup runtime handlers', () => {
  it('SCRIPTS_GET_PERMISSIONS 返回该脚本授权 host；SCRIPTS_REVOKE_PERMISSION 撤销单条', async () => {
    const router = new MessageRouter();
    initScriptsModule(router);
    await setAlwaysAllow('ps1', 'x.com');
    const got = await router.dispatch({ type: 'SCRIPTS_GET_PERMISSIONS', id: 'ps1' });
    expect(got).toEqual({ ok: true, data: { hosts: ['x.com'] } });
    await router.dispatch({ type: 'SCRIPTS_REVOKE_PERMISSION', id: 'ps1', host: 'x.com' });
    const after = await router.dispatch({ type: 'SCRIPTS_GET_PERMISSIONS', id: 'ps1' });
    expect(after).toEqual({ ok: true, data: { hosts: [] } });
  });

  it('SCRIPTS_GET_RUNTIME_FOR_TAB 只返回指定 tab 的运行条目', async () => {
    const router = new MessageRouter();
    initScriptsModule(router);
    // 直接注内存 map 的兄弟路径：经 recomputeTab 太重，用 getRuntimeSnapshot 同源数据
    // recomputeTab 是导出纯逻辑（url 匹配），走真实路径更稳：
    await saveScript(mkScript({ id: 'rt1', enabled: true, matches: ['*://a.com/*'] }));
    await recomputeTab(11, 'https://a.com/page');
    const got = (await router.dispatch({ type: 'SCRIPTS_GET_RUNTIME_FOR_TAB', tabId: 11 })) as {
      ok: boolean; data?: { entry: ScriptsRuntimeEntry | null };
    };
    expect(got.ok).toBe(true);
    expect(got.data?.entry?.scriptIds).toEqual(['rt1']);
    const none = (await router.dispatch({ type: 'SCRIPTS_GET_RUNTIME_FOR_TAB', tabId: 99 })) as {
      ok: boolean; data?: { entry: ScriptsRuntimeEntry | null };
    };
    expect(none.data?.entry).toBeNull();
  });
});
```

注意：测试文件顶部需按需补 import（`setAlwaysAllow` 来自 `../../background/gm-permissions`，`saveScript`/`mkScript`/`recomputeTab` 若该测试文件已有同名工具则复用；`mkScript` 若无则按 `tests/scripts/ScriptDetailView.test.tsx` 的 mkScript 形状造）。`ScriptsRuntimeEntry` 类型从 `../../shared/messages` import。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/background/scripts.test.ts`
Expected: FAIL（`no handler for SCRIPTS_GET_PERMISSIONS`）

- [ ] **Step 3: 实现**——`background/scripts.ts`：

import 区补：

```typescript
import { listAllowedHosts, revokeHost, removeScriptPermissions } from './gm-permissions';
```

（`removeScriptPermissions` 已在 import 里则只补前两个。）

`initScriptsModule` 内（`SCRIPTS_GET_RUNTIME` 注册之后）追加：

```typescript
  router.on('SCRIPTS_GET_RUNTIME_FOR_TAB', async (msg) => {
    const tabId = (msg as unknown as { tabId: number }).tabId;
    const entry = getRuntimeSnapshot().find((e) => e.tabId === tabId) ?? null;
    return { ok: true, data: { entry } };
  });

  router.on('SCRIPTS_GET_PERMISSIONS', async (msg) => {
    const id = (msg as unknown as { id: string }).id;
    return { ok: true, data: { hosts: await listAllowedHosts(id) } };
  });

  router.on('SCRIPTS_REVOKE_PERMISSION', async (msg) => {
    const { id, host } = msg as unknown as { id: string; host: string };
    await revokeHost(id, host);
    return { ok: true };
  });
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/background/scripts.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add background/scripts.ts tests/background/scripts.test.ts
git commit -m "feat: 后台接线 permissions 读写与 per-tab 运行态 handler"
```

---

### Task 3: `.switch` 组件样式 + 侧边栏脚本卡片（ScriptsListView 重构）

**Files:**
- Modify: `entrypoints/sidepanel/styles.css`（`.switch` 新增；`.scripts-row` 系列删除在 Task 4 一并做）
- Modify: `components/scripts/ScriptsListView.tsx`（重构）
- Modify: `stores/ui.ts` + `stores/scripts.ts`（openScript → openScriptTab）
- Test: `tests/ui/scripts-list.test.tsx`（新建）

- [ ] **Step 1: 写失败测试**——新建 `tests/ui/scripts-list.test.tsx`：

```tsx
// tests/ui/scripts-list.test.tsx
// 侧边栏脚本列表：卡片渲染 + switch 启停（冒泡阻断）+ 页眉 icon 按钮。
// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { ScriptsListView } from '../../components/scripts/ScriptsListView';
import { useScripts } from '../../stores/scripts';
import type { ScriptSummary } from '../../shared/types';

afterEach(cleanup);

function mkSummary(over: Partial<ScriptSummary> = {}): ScriptSummary {
  return {
    id: 's1', name: '脚本一', enabled: true, matches: ['*://a.com/*'],
    description: undefined, runAt: 'document_idle', world: 'USER_SCRIPT',
    source: 'user', errorCount: 0, hasGrants: true, hasRequires: false,
    grantSupported: ['GM_getValue'], grantUnsupported: [],
    updatedAt: 1, ...over,
  } as ScriptSummary;
}

describe('ScriptsListView', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
    useScripts.setState({
      summaries: [mkSummary()],
      runtimeEntries: {}, activeTabId: null, query: '',
      engineWarning: null, menus: [], errors: {}, confirms: [],
    });
  });

  it('渲染脚本卡片：名称、匹配规则、switch；无 RUNNING/MENU 区', async () => {
    browser.runtime.onMessage.addListener((msg: { type: string }, _s, sendResponse) => {
      if (msg.type === 'SCRIPTS_LIST') { sendResponse({ ok: true, data: { scripts: [mkSummary()], engineAvailable: true } }); return true; }
      if (msg.type === 'SCRIPTS_GET_RUNTIME') { sendResponse({ ok: true, data: { entries: [] } }); return true; }
      if (msg.type === 'SCRIPTS_GET_GM_STATE') { sendResponse({ ok: true, data: { menus: [], errors: {}, confirms: [] } }); return true; }
      sendResponse({ ok: false, error: 'unexpected' }); return true;
    });
    render(<ScriptsListView />);
    expect(await screen.findByText('脚本一')).toBeTruthy();
    expect(screen.getByRole('switch')).toBeTruthy();
    expect(screen.queryByText(/RUNNING/)).toBeNull();
    expect(screen.queryByText(/MENU ·/)).toBeNull();
    expect(screen.getByRole('button', { name: '新建脚本' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '导入脚本' })).toBeTruthy();
  });

  it('点击 switch 调 SCRIPTS_SET_ENABLED 且不触发卡片导航；tabs.create 未被调', async () => {
    const createSpy = vi.fn();
    (browser.tabs as unknown as { create: typeof createSpy }).create = createSpy;
    browser.runtime.onMessage.addListener((msg: { type: string }, _s, sendResponse) => {
      if (msg.type === 'SCRIPTS_LIST') { sendResponse({ ok: true, data: { scripts: [mkSummary()], engineAvailable: true } }); return true; }
      if (msg.type === 'SCRIPTS_GET_RUNTIME') { sendResponse({ ok: true, data: { entries: [] } }); return true; }
      if (msg.type === 'SCRIPTS_GET_GM_STATE') { sendResponse({ ok: true, data: { menus: [], errors: {}, confirms: [] } }); return true; }
      if (msg.type === 'SCRIPTS_SET_ENABLED') { sendResponse({ ok: true, data: { script: mkSummary({ enabled: false }) } }); return true; }
      sendResponse({ ok: false, error: 'unexpected' }); return true;
    });
    render(<ScriptsListView />);
    const sw = await screen.findByRole('switch');
    fireEvent.click(sw);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('点击卡片主体调 tabs.create 开全屏详情页', async () => {
    const createSpy = vi.fn().mockResolvedValue({});
    (browser.tabs as unknown as { create: typeof createSpy }).create = createSpy;
    browser.runtime.onMessage.addListener((msg: { type: string }, _s, sendResponse) => {
      if (msg.type === 'SCRIPTS_LIST') { sendResponse({ ok: true, data: { scripts: [mkSummary()], engineAvailable: true } }); return true; }
      if (msg.type === 'SCRIPTS_GET_RUNTIME') { sendResponse({ ok: true, data: { entries: [] } }); return true; }
      if (msg.type === 'SCRIPTS_GET_GM_STATE') { sendResponse({ ok: true, data: { menus: [], errors: {}, confirms: [] } }); return true; }
      sendResponse({ ok: false, error: 'unexpected' }); return true;
    });
    render(<ScriptsListView />);
    const card = await screen.findByText('脚本一');
    fireEvent.click(card);
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({ url: expect.stringContaining('script-detail.html?id=s1') }),
    );
  });
});
```

注意：`ScriptSummary` 字段以 `shared/types.ts:60-80` 实际定义为准，写测试前先读该接口，逐字段对齐（上面 `mkSummary` 是骨架，缺的字段补齐）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/ui/scripts-list.test.tsx`
Expected: FAIL（找不到 `switch` role / 新建脚本按钮）

- [ ] **Step 3: stores 改造**——`stores/ui.ts` 删 `scriptId/openScript`（整文件变）：

```typescript
// stores/ui.ts
import { create } from 'zustand';

export type Page = 'chat' | 'scripts' | 'debug' | 'settings';

interface UiState {
  page: Page;
  setPage: (p: Page) => void;
}

export const useUi = create<UiState>((set) => ({
  page: 'chat',
  setPage: (page) => set({ page }),
}));
```

`stores/scripts.ts` 追加（`sendScriptsRequest` 之后）：

```typescript
/** 全屏详情页入口（侧边栏卡片 / popup 编辑按钮共用）：新标签打开扩展自有页面。 */
export function openScriptTab(id: string): void {
  void browser.tabs.create({ url: browser.runtime.getURL(`/script-detail.html?id=${encodeURIComponent(id)}`) });
}
```

- [ ] **Step 4: 重构 ScriptsListView.tsx**——完整新内容：

```tsx
// components/scripts/ScriptsListView.tsx
// 脚本池列表页（2026-09-03 重设计）：纯管理器——警告 + 确认卡 + 搜索 + 脚本卡片（switch 启停）。
// 运行观测/菜单触发归 popup；详情页 = 全屏新标签页（openScriptTab）。
import { useRef, useState } from 'react';
import { CircleAlert, Plus, Search, Upload } from 'lucide-react';
import { PageShell } from '../ui/PageShell';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { filterSummaries, openScriptTab, sendScriptsRequest, useScripts } from '../../stores/scripts';
import { ScriptsConfirmCard } from './ScriptsConfirmCard';
import type { ScriptSummary } from '../../shared/types';

const SOURCE_LABEL: Record<ScriptSummary['source'], string> = {
  user: 'user',
  agent: 'agent',
  import: 'TM',
};

// 新建模板：body 需非空占位（解析后 code 不能为空）
const NEW_SCRIPT_TEMPLATE = [
  '// ==UserScript==',
  '// @name        未命名脚本',
  '// @match       *://*/*',
  '// @run-at      document-idle',
  '// ==/UserScript==',
  '',
  "console.log('新脚本');",
  '',
].join('\n');

export function ScriptsListView() {
  const { summaries, query, engineWarning, confirms, setQuery } = useScripts();
  const [importWarnings, setImportWarnings] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const visible = filterSummaries(summaries, query);

  async function createNew(): Promise<void> {
    const resp = await sendScriptsRequest<{ ok: boolean; data?: { script: { id: string } }; error?: string }>({
      type: 'SCRIPTS_CREATE',
      input: { text: NEW_SCRIPT_TEMPLATE },
    });
    if (resp.ok && resp.data) {
      await useScripts.getState().refresh();
      openScriptTab(resp.data.script.id);
    } else {
      setImportWarnings([resp.error ?? '新建失败']);
    }
  }

  async function importFile(file: File): Promise<void> {
    const text = await file.text();
    const resp = await sendScriptsRequest<{ ok: boolean; data?: { script: { id: string }; warnings: string[] }; error?: string }>({
      type: 'SCRIPTS_IMPORT',
      text,
      filename: file.name,
    });
    if (resp.ok && resp.data) {
      setImportWarnings(resp.data.warnings);
      await useScripts.getState().refresh();
      openScriptTab(resp.data.script.id);
    } else {
      setImportWarnings([resp.error ?? '导入失败']);
    }
  }

  async function setEnabled(id: string, enabled: boolean): Promise<void> {
    await sendScriptsRequest({ type: 'SCRIPTS_SET_ENABLED', id, enabled });
    await useScripts.getState().refresh();
  }

  return (
    <PageShell
      title="脚本"
      eyebrow="SCRIPTS"
      actions={
        <>
          <Button variant="ghost" className="btn--icon" aria-label="新建脚本" onClick={() => void createNew()}>
            <Plus size={16} />
          </Button>
          <Button variant="ghost" className="btn--icon" aria-label="导入脚本" onClick={() => fileRef.current?.click()}>
            <Upload size={16} />
          </Button>
        </>
      }
    >
      {engineWarning && (
        <div className="scripts-notice" role="alert">
          <CircleAlert size={14} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>{engineWarning}</span>
        </div>
      )}

      {confirms.map((c) => <ScriptsConfirmCard key={c.confirmId} confirm={c} />)}

      <div className="scripts-toolbar">
        <div style={{ position: 'relative', flex: 1 }}>
          <Search size={13} style={{ position: 'absolute', left: 8, top: 8, color: 'var(--ink-3)' }} aria-hidden />
          <Input
            aria-label="搜索脚本"
            placeholder="搜索名称 / 匹配规则…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ paddingLeft: 26 }}
          />
        </div>
      </div>

      {importWarnings.length > 0 && (
        <div className="scripts-warnline" role="status">
          {importWarnings.map((w, i) => (
            <div key={i}>{w}</div>
          ))}
        </div>
      )}

      <div className="scripts-list">
        {visible.map((s) => (
          <div
            key={s.id}
            className={`scripts-card${s.enabled ? '' : ' scripts-card--off'}`}
            role="button"
            tabIndex={0}
            onClick={() => openScriptTab(s.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                openScriptTab(s.id);
              }
            }}
          >
            <div className="scripts-card__top">
              <span className="scripts-card__name">{s.name}</span>
              <button
                type="button"
                role="switch"
                aria-checked={s.enabled}
                aria-label={`${s.enabled ? '禁用' : '启用'} ${s.name}`}
                className={`switch${s.enabled ? ' switch--on' : ''}`}
                onClick={(e) => {
                  e.stopPropagation();
                  void setEnabled(s.id, !s.enabled);
                }}
              >
                <span className="switch__thumb" aria-hidden />
              </button>
            </div>
            <div className="scripts-card__meta">
              <span className="scripts-card__match mono">{s.matches.join(' ') || '（无匹配规则）'}</span>
              <span className="scripts-card__badges">
                <span className="scripts-badge scripts-badge--signal">{SOURCE_LABEL[s.source]}</span>
                {(s.grantSupported.length > 0 || s.grantUnsupported.length > 0) && (
                  <span
                    className={`scripts-badge ${s.grantUnsupported.length > 0 ? 'scripts-badge--warn' : 'scripts-badge--signal'}`}
                    title={`可用：${s.grantSupported.join(', ') || '无'}${s.grantUnsupported.length > 0 ? `；不支持：${s.grantUnsupported.join(', ')}` : ''}`}
                  >
                    GM {s.grantSupported.length}{s.grantUnsupported.length > 0 ? `/${s.grantUnsupported.length}!` : ''}
                  </span>
                )}
                {s.errorCount > 0 && (
                  <span className="scripts-badge scripts-badge--warn" title="脚本运行报错（进详情页查看）">{s.errorCount} errors</span>
                )}
              </span>
            </div>
          </div>
        ))}
        {visible.length === 0 && <div className="chat__empty">没有匹配的脚本</div>}
      </div>

      <input
        ref={fileRef}
        type="file"
        accept=".user.js,.js"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void importFile(f);
          e.target.value = '';
        }}
      />
    </PageShell>
  );
}
```

- [ ] **Step 5: 样式**——`entrypoints/sidepanel/styles.css`：`.scripts-row` 系列（`.scripts-row`、`.scripts-row:hover`、`.scripts-row.is-off`、`.scripts-row__name`、`.scripts-row__match`、约 styles.css:771-782）替换为：

```css
/* 脚本卡片（2026-09-03 重设计：switch 启停 + 整卡进全屏详情） */
.scripts-list { display: grid; gap: 8px; }
.scripts-card {
  border: 1px solid var(--line); border-radius: var(--r-md);
  padding: 9px 11px; cursor: pointer; background: var(--surface);
  transition: border-color 120ms ease;
}
.scripts-card:hover { border-color: var(--line-strong); }
.scripts-card--off { opacity: 0.55; }
.scripts-card__top { display: flex; align-items: center; gap: 8px; }
.scripts-card__name { flex: 1; min-width: 0; font-weight: 600; color: var(--ink); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.scripts-card__meta { display: flex; align-items: center; gap: 6px; margin-top: 4px; flex-wrap: wrap; }
.scripts-card__match { flex: 1; min-width: 0; font-size: 10.5px; color: var(--ink-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.scripts-card__badges { display: inline-flex; gap: 4px; flex-shrink: 0; }

/* switch 组件：40×22 轨道滑块，选中 signal 底白滑块 */
.switch {
  position: relative; width: 40px; height: 22px; flex-shrink: 0;
  border: 1px solid var(--line-strong); border-radius: 999px;
  background: var(--sunken); cursor: pointer; padding: 0;
  transition: background 150ms ease, border-color 150ms ease;
}
.switch__thumb {
  position: absolute; top: 2px; left: 2px; width: 16px; height: 16px;
  border-radius: 50%; background: var(--surface); border: 1px solid var(--line-strong);
  transition: transform 150ms ease;
}
.switch--on { background: var(--signal); border-color: var(--signal); }
.switch--on .switch__thumb { transform: translateX(18px); border-color: var(--signal); }
@media (prefers-reduced-motion: reduce) {
  .switch, .switch__thumb { transition: none; }
}
```

- [ ] **Step 6: 同步改 ScriptsView.tsx**——`scriptId` 分支删除：

```tsx
// components/scripts/ScriptsView.tsx
// 脚本池路由壳：纯列表（详情页已迁全屏新标签页）；挂载时拉数据 + 订阅运行态/菜单/错误/确认广播。
import { useEffect } from 'react';
import { ScriptsListView } from './ScriptsListView';
import { useScripts } from '../../stores/scripts';
import type { GmConfirmItem, GmErrorItem, GmMenuEntry } from '../../stores/scripts';
import type { ScriptsRuntimeEvent } from '../../shared/messages';

export function ScriptsView() {
  useEffect(() => {
    void useScripts.getState().refresh();
    const onMessage = (msg: unknown) => {
      const m = msg as { type?: string };
      if (m?.type === 'SCRIPTS_RUNTIME') {
        useScripts.getState().applyRuntimeEvent(msg as ScriptsRuntimeEvent);
      }
      if (m?.type === 'SCRIPTS_MENUS') {
        useScripts.getState().applyMenusEvent(msg as { type: string; entries: GmMenuEntry[] });
      }
      if (m?.type === 'SCRIPTS_ERROR') {
        useScripts.getState().applyErrorEvent(msg as { type: string; scriptId: string; error: GmErrorItem });
      }
      if (m?.type === 'SCRIPTS_ERROR_CLEARED') {
        useScripts.getState().applyErrorCleared((msg as { scriptId: string }).scriptId);
      }
      if (m?.type === 'GM_CONFIRM_PENDING') {
        useScripts.getState().applyConfirmEvent(msg as { type: string; confirm: GmConfirmItem });
      }
      if (m?.type === 'GM_CONFIRM_RESOLVED') {
        useScripts.getState().applyConfirmResolved((msg as { confirmId: string }).confirmId);
      }
    };
    browser.runtime.onMessage.addListener(onMessage);
    const onActivated = ({ tabId }: { tabId: number }) => {
      useScripts.getState().setActiveTab(tabId);
      if (useScripts.getState().runtimeEntries[tabId] == null) void useScripts.getState().refresh();
    };
    browser.tabs.onActivated.addListener(onActivated);
    return () => {
      browser.runtime.onMessage.removeListener(onMessage);
      browser.tabs.onActivated.removeListener(onActivated);
    };
  }, []);

  return <ScriptsListView />;
}
```

- [ ] **Step 7: 跑新测试 + 全量测试**

Run: `npx vitest run tests/ui/scripts-list.test.tsx && npm run compile && npm run test`
Expected: 新测试 PASS；编译无错（ScriptDetailView.test.tsx 此步会 FAIL——其被测组件 Task 4 才删除；若该测试文件此时报错属预期，记录跳过该文件：`npx vitest run --exclude 'tests/scripts/ScriptDetailView.test.tsx'` 可全绿）

- [ ] **Step 8: Commit**

```bash
git add components/scripts stores/ui.ts stores/scripts.ts entrypoints/sidepanel/styles.css tests/ui/scripts-list.test.tsx
git commit -m "feat: 侧边栏脚本页重构——卡片+switch 纯管理器，openScript 改全屏页跳转"
```

---

### Task 4: 删除侧边栏详情页组件与其测试

**Files:**
- Delete: `components/scripts/ScriptDetailView.tsx`
- Delete: `tests/scripts/ScriptDetailView.test.tsx`（被测组件已不存在；全屏页组件在 Task 5 带新测试）

- [ ] **Step 1: 确认无残留引用**

Run: `grep -rn "ScriptDetailView" components/ entrypoints/ stores/ tests/ --include="*.tsx" --include="*.ts"`
Expected: 仅 `components/scripts/ScriptDetailView.tsx` 与 `tests/scripts/ScriptDetailView.test.tsx` 自身（ScriptsView 的 import 已在 Task 3 移除）

- [ ] **Step 2: 删除两文件**

```bash
git rm components/scripts/ScriptDetailView.tsx tests/scripts/ScriptDetailView.test.tsx
```

- [ ] **Step 3: 全量验证**

Run: `npm run compile && npx vitest run --exclude '**/.claude/**'`
Expected: 编译无错、全部 PASS

- [ ] **Step 4: Commit**

```bash
git commit -m "refactor: 删除侧边栏内脚本详情页（迁全屏新标签页）"
```

---

### Task 5: 全屏详情页入口 + 顶栏/左栏骨架 + 四 Tab 导航

**Files:**
- Create: `entrypoints/script-detail/index.html`
- Create: `entrypoints/script-detail/main.tsx`
- Create: `components/detail/DetailApp.tsx`
- Create: `components/detail/useScriptDetail.ts`
- Modify: `entrypoints/sidepanel/styles.css`（`.detail` 骨架类）
- Test: `tests/detail/detail-app.test.tsx`（新建）

- [ ] **Step 1: 写失败测试**——新建 `tests/detail/detail-app.test.tsx`：

```tsx
// tests/detail/detail-app.test.tsx
// 全屏详情页：四 Tab 切换、顶栏 switch 启停、不存在脚本空态。
// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { DetailApp } from '../../components/detail/DetailApp';
import type { UserScript } from '../../shared/types';

afterEach(cleanup);

function mkScript(over: Partial<UserScript> = {}): UserScript {
  return {
    id: 's1',
    text: '// ==UserScript==\n// @name 测试脚本\n// @match *://*/*\n// @grant GM_getValue\n// @grant NO_SUCH_API\n// ==/UserScript==\nconsole.log(1);',
    name: '测试脚本',
    enabled: true,
    matches: ['*://*/*'],
    code: 'console.log(1);',
    runAt: 'document_idle',
    world: 'USER_SCRIPT',
    source: 'user',
    createdAt: 1,
    updatedAt: 1,
    meta: { grants: ['GM_getValue', 'NO_SUCH_API'] },
    ...over,
  } as UserScript;
}

function mockBackend(script: UserScript | null, errors: unknown[] = []): void {
  browser.runtime.onMessage.addListener((msg: { type: string }, _s, sendResponse) => {
    if (msg.type === 'SCRIPTS_GET') {
      script
        ? sendResponse({ ok: true, data: { script, totalLines: script.text.split('\n').length, startLine: 1, endLine: script.text.split('\n').length } })
        : sendResponse({ ok: false, error: '脚本不存在' });
      return true;
    }
    if (msg.type === 'SCRIPTS_GET_PERMISSIONS') { sendResponse({ ok: true, data: { hosts: ['x.com'] } }); return true; }
    if (msg.type === 'SCRIPTS_GET_GM_STATE') { sendResponse({ ok: true, data: { menus: [], errors: {}, confirms: [] } }); return true; }
    if (msg.type === 'SCRIPTS_ERROR') { sendResponse({ ok: true }); return true; }
    sendResponse({ ok: false, error: 'unexpected' }); return true;
  });
  void errors;
}

describe('DetailApp', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
  });

  it('加载后默认展示详情 Tab：元信息 + 操作按钮 + 左栏四导航', async () => {
    mockBackend(mkScript());
    render(<DetailApp id="s1" />);
    expect(await screen.findByText('测试脚本')).toBeTruthy();
    expect(screen.getByText('详情')).toBeTruthy();
    expect(screen.getByText('代码')).toBeTruthy();
    expect(screen.getByText('设置')).toBeTruthy();
    expect(screen.getByText(/日志/)).toBeTruthy();
    expect(screen.getByRole('switch')).toBeTruthy(); // 顶栏启停
    expect(screen.getByRole('button', { name: '重载当前页' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '导出 .user.js' })).toBeTruthy();
  });

  it('Tab 切换：代码 Tab 显示编辑器；设置 Tab 显示 XHR 安全名单；日志 Tab 显示井', async () => {
    mockBackend(mkScript());
    render(<DetailApp id="s1" />);
    await screen.findByText('测试脚本');
    fireEvent.click(screen.getByText('代码'));
    expect(screen.getByRole('textbox')).toBeTruthy();
    fireEvent.click(screen.getByText('设置'));
    expect(await screen.findByText('x.com')).toBeTruthy();
    expect(screen.getByRole('button', { name: /撤销/ })).toBeTruthy();
    fireEvent.click(screen.getByText(/日志/));
    expect(screen.getByText(/暂无错误/)).toBeTruthy();
  });

  it('脚本不存在时空态 + 关闭按钮', async () => {
    mockBackend(null);
    render(<DetailApp id="gone" />);
    expect(await screen.findByText('脚本不存在或已被删除')).toBeTruthy();
  });

  it('顶栏 switch 启停调 SCRIPTS_SET_ENABLED', async () => {
    mockBackend(mkScript());
    const sendSpy = vi.spyOn(browser.runtime, 'sendMessage');
    render(<DetailApp id="s1" />);
    const sw = await screen.findByRole('switch');
    fireEvent.click(sw);
    await vi.waitFor(() => {
      const calls = sendSpy.mock.calls.filter((c) => (c[0] as { type: string }).type === 'SCRIPTS_SET_ENABLED');
      expect(calls.length).toBeGreaterThan(0);
      expect((calls[0][0] as { enabled: boolean }).enabled).toBe(false);
    });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/detail/detail-app.test.tsx`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 建数据 hook**——`components/detail/useScriptDetail.ts`：

```typescript
// components/detail/useScriptDetail.ts
// 详情页数据加载：SCRIPTS_GET 拉脚本 + 错误订阅 + 不存在检测。
import { useEffect, useState } from 'react';
import { sendScriptsRequest, useScripts } from '../../stores/scripts';
import type { GmErrorItem } from '../../stores/scripts';
import type { UserScript } from '../../shared/types';

export interface ScriptDetailData {
  script: UserScript | null;
  errors: GmErrorItem[];
  notFound: boolean;
  loading: boolean;
}

export function useScriptDetail(id: string): ScriptDetailData {
  const [script, setScript] = useState<UserScript | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loading, setLoading] = useState(true);
  // 选择器不新建引用（React #185 教训）：errorsRecord 可能 undefined，`?? []` 在选择器外
  const errorsRecord = useScripts((s) => s.errors[id]);
  const errors = errorsRecord ?? [];

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const resp = await sendScriptsRequest<{ ok: boolean; data?: { script: UserScript }; error?: string }>({
          type: 'SCRIPTS_GET', id,
        });
        if (cancelled) return;
        if (resp.ok && resp.data) { setScript(resp.data.script); setNotFound(false); }
        else setNotFound(true);
      } catch {
        if (!cancelled) setNotFound(true); // SW 死亡等传输异常兜底
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [id]);

  // 订阅脚本错误广播（实时增行）+ GM 状态冷读复水（SW 存活时广播不补量）
  useEffect(() => {
    void useScripts.getState().refresh();
    const onMessage = (msg: unknown) => {
      const m = msg as { type?: string };
      if (m?.type === 'SCRIPTS_ERROR') {
        useScripts.getState().applyErrorEvent(msg as { type: string; scriptId: string; error: GmErrorItem });
      }
      if (m?.type === 'SCRIPTS_ERROR_CLEARED') {
        useScripts.getState().applyErrorCleared((msg as { scriptId: string }).scriptId);
      }
    };
    browser.runtime.onMessage.addListener(onMessage);
    return () => { browser.runtime.onMessage.removeListener(onMessage); };
  }, []);

  return { script, errors, notFound, loading };
}
```

- [ ] **Step 4: 建骨架组件**——`components/detail/DetailApp.tsx`：

```tsx
// components/detail/DetailApp.tsx
// 全屏脚本详情页（spec §2）：顶栏（switch+关闭）+ 左栏导航（详情/代码/设置/日志 N + 删除）+ 四 Tab。
// Tab 式切换（用户选定）：每 Tab 独占内容区。
import { useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '../ui/Button';
import { openScriptTab, sendScriptsRequest, useScripts } from '../../stores/scripts';
import { useScriptDetail } from './useScriptDetail';
import { DetailInfoTab } from './DetailInfoTab';
import { DetailCodeTab } from './DetailCodeTab';
import { DetailSettingsTab } from './DetailSettingsTab';
import { DetailLogsTab } from './DetailLogsTab';

type TabKey = 'info' | 'code' | 'settings' | 'logs';

export function DetailApp({ id }: { id: string }) {
  const { script, errors, notFound, loading } = useScriptDetail(id);
  const [tab, setTab] = useState<TabKey>('info');
  const [message, setMessage] = useState('');

  async function toggleEnabled(): Promise<void> {
    if (!script) return;
    const resp = await sendScriptsRequest<{ ok: boolean; data?: { script: typeof script }; error?: string }>({
      type: 'SCRIPTS_SET_ENABLED', id: script.id, enabled: !script.enabled,
    });
    if (resp.ok && resp.data) setMessage(resp.data.script.enabled ? '已启用，刷新页面生效' : '已禁用，刷新页面生效');
    else setMessage(resp.error ?? '操作失败');
  }

  async function remove(): Promise<void> {
    if (!script || !window.confirm(`删除脚本「${script.name}」？不可恢复。`)) return;
    const resp = await sendScriptsRequest({ type: 'SCRIPTS_DELETE', id: script.id });
    if (resp.ok) window.close();
    else setMessage(resp.error ?? '删除失败');
  }

  if (loading) {
    return <div className="detail detail--empty">加载中…</div>;
  }
  if (notFound || !script) {
    return (
      <div className="detail detail--empty">
        <div className="chat__empty">脚本不存在或已被删除</div>
        <Button variant="ghost" onClick={() => window.close()}><X size={14} /> 关闭</Button>
      </div>
    );
  }

  const TABS: Array<{ key: TabKey; label: string; count?: number }> = [
    { key: 'info', label: '详情' },
    { key: 'code', label: '代码' },
    { key: 'settings', label: '设置' },
    { key: 'logs', label: '日志', count: errors.length },
  ];

  return (
    <div className="detail">
      <header className="detail__topbar">
        <span className="eyebrow">SCRIPT</span>
        <h1 className="detail__title" title={script.name}>{script.name || '未命名脚本'}</h1>
        <button
          type="button" role="switch" aria-checked={script.enabled}
          aria-label={`${script.enabled ? '禁用' : '启用'} 脚本`}
          className={`switch${script.enabled ? ' switch--on' : ''}`}
          onClick={() => void toggleEnabled()}
        >
          <span className="switch__thumb" aria-hidden />
        </button>
        <Button variant="ghost" className="btn--icon" aria-label="关闭" onClick={() => window.close()}>
          <X size={16} />
        </Button>
      </header>
      <div className="detail__main">
        <nav className="detail__side" aria-label="详情页分区">
          {TABS.map((t) => (
            <button
              key={t.key}
              className={`detail__navitem${tab === t.key ? ' is-active' : ''}`}
              aria-current={tab === t.key}
              onClick={() => setTab(t.key)}
            >
              <span>{t.label}</span>
              {t.count != null && <span className="detail__navcount mono">{t.count}</span>}
            </button>
          ))}
          <div className="detail__side-spacer" />
          <button className="detail__navitem detail__navitem--danger" onClick={() => void remove()}>删除</button>
        </nav>
        <div className="detail__content">
          {message && <div className="scripts-warnline" role="status">{message}</div>}
          {tab === 'info' && <DetailInfoTab script={script} />}
          {tab === 'code' && <DetailCodeTab script={script} onSaved={async () => { await useScripts.getState().refresh(); }} />}
          {tab === 'settings' && <DetailSettingsTab id={script.id} />}
          {tab === 'logs' && <DetailLogsTab id={script.id} errors={errors} />}
        </div>
      </div>
    </div>
  );
}
```

注意 `openScriptTab` import 若未用到则移除（顶栏不放编辑按钮；保留 import 清洁）。

- [ ] **Step 5: 建四个 Tab 组件**——`components/detail/DetailInfoTab.tsx`：

```tsx
// components/detail/DetailInfoTab.tsx
// 详情 Tab：元信息（mono 键 + sans 值）+ grant 分色列表 + 脚本级操作（重载/导出）。
import { Check, Download, RotateCw, X } from 'lucide-react';
import { Button } from '../ui/Button';
import { classifyGrants } from '../../shared/gm-apis';
import type { UserScript } from '../../shared/types';

export function DetailInfoTab({ script }: { script: UserScript }) {
  const parsedName = script.name;
  const meta = script.meta ?? {};

  async function reloadActivePage(): Promise<void> {
    let [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab) [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id != null) await browser.tabs.reload(tab.id);
  }

  function exportFile(): void {
    const url = URL.createObjectURL(new Blob([script.text], { type: 'text/javascript' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(script.name || 'script').replace(/[\\/:*?"<>|]/g, '_')}.user.js`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="detail__tabcard">
      <div className="detail__inforow"><span className="mono">name</span><span>{parsedName || '（未设置）'}</span></div>
      {meta.version && <div className="detail__inforow"><span className="mono">version</span><span>{String(meta.version)}</span></div>}
      {meta.author && <div className="detail__inforow"><span className="mono">author</span><span>{String(meta.author)}</span></div>}
      {meta.description && <div className="detail__inforow"><span className="mono">description</span><span>{String(meta.description)}</span></div>}
      <div className="detail__inforow"><span className="mono">match</span><span className="mono">{script.matches.length > 0 ? script.matches.join('  ') : '（无——脚本不会运行）'}</span></div>
      <div className="detail__inforow"><span className="mono">run-at · world</span><span className="mono">{script.runAt} · {script.world}</span></div>
      {meta.grants && meta.grants.length > 0 && (
        <div className="detail__inforow">
          <span className="mono">grant</span>
          <span>
            {meta.grants.map((g) => {
              const ok = classifyGrants([g]).supported.length > 0;
              return (
                <div key={g} className="mono" style={{ display: 'flex', alignItems: 'center', gap: 4, color: ok ? 'var(--ink-2)' : 'var(--warn)' }}>
                  {ok ? <Check size={11} aria-hidden /> : <X size={11} aria-hidden />} {g}
                </div>
              );
            })}
          </span>
        </div>
      )}
      <div className="detail__actions">
        <Button onClick={() => void reloadActivePage()}><RotateCw size={14} /> 重载当前页</Button>
        <Button onClick={exportFile}><Download size={14} /> 导出 .user.js</Button>
      </div>
    </div>
  );
}
```

注意：`meta.version/author/description` 类型均为 `string | undefined`（`shared/types.ts:27-41` UserScriptMeta），`String()` 包裹可去掉，直接 `{meta.version}` 渲染。

- `components/detail/DetailCodeTab.tsx`：

```tsx
// components/detail/DetailCodeTab.tsx
// 代码 Tab：源码编辑器（全宽破格）+ dirty 指示 + 保存（patch {text} 整文替换）。
import { useEffect, useMemo, useState } from 'react';
import { Save } from 'lucide-react';
import { Button } from '../ui/Button';
import { sendScriptsRequest } from '../../stores/scripts';
import { parseUserScript } from '../../shared/userscript-meta';
import type { UserScript } from '../../shared/types';

export function DetailCodeTab({ script, onSaved }: { script: UserScript; onSaved: () => Promise<void> | void }) {
  const [text, setText] = useState(script.text);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState('');
  // 脚本切换/保存后同步基线（对比 parsed 无意义——text 就是基线）
  useEffect(() => { setText(script.text); setDirty(false); }, [script.id, script.updatedAt]);

  // 实时解析预览（头部即配置，所见即所得——保存才落库重注册）
  const parsed = useMemo(() => parseUserScript(text), [text]);

  async function save(): Promise<void> {
    const resp = await sendScriptsRequest<{ ok: boolean; data?: { script: UserScript }; error?: string }>({
      type: 'SCRIPTS_UPDATE', id: script.id, patch: { text },
    });
    if (resp.ok && resp.data) {
      setDirty(false);
      setMessage('已重新注册，刷新页面生效');
      await onSaved();
    } else {
      setMessage(resp.error ?? '保存失败');
    }
  }

  return (
    <div className="detail-code">
      <div className="detail-code__bar">
        <span className="mono detail-code__status">
          {dirty ? '● 未保存' : parsed.warnings.length > 0 ? `⚠ ${parsed.warnings.length} 条解析警告` : '已同步'}
        </span>
        <Button variant="primary" disabled={!dirty} onClick={() => void save()}>
          <Save size={14} /> 保存
        </Button>
      </div>
      {message && <div className="scripts-warnline" role="status">{message}</div>}
      {parsed.warnings.length > 0 && (
        <div className="scripts-warnline">
          {parsed.warnings.map((w, i) => <div key={i}>{w}</div>)}
        </div>
      )}
      <textarea
        aria-label="脚本源码"
        className="detail-code__editor mono"
        spellCheck={false}
        value={text}
        onChange={(e) => { setText(e.target.value); setDirty(true); }}
        onKeyDown={(e) => {
          // Tab 键插入两空格（轻量编辑器约定，不做 CodeMirror）
          if (e.key === 'Tab') {
            e.preventDefault();
            const el = e.currentTarget;
            const { selectionStart, selectionEnd, value } = el;
            el.value = `${value.slice(0, selectionStart)}  ${value.slice(selectionEnd)}`;
            el.selectionStart = el.selectionEnd = selectionStart + 2;
            setText(el.value);
            setDirty(true);
          }
        }}
      />
    </div>
  );
}
```

- `components/detail/DetailSettingsTab.tsx`：

```tsx
// components/detail/DetailSettingsTab.tsx
// 设置 Tab：XHR 安全 = 「总是允许」域名名单查看 + 逐条撤销（校验语义不动）。
import { useEffect, useState } from 'react';
import { Undo2 } from 'lucide-react';
import { Button } from '../ui/Button';
import { sendScriptsRequest } from '../../stores/scripts';

export function DetailSettingsTab({ id }: { id: string }) {
  const [hosts, setHosts] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  async function pull(): Promise<void> {
    setLoading(true);
    try {
      const resp = await sendScriptsRequest<{ ok: boolean; data?: { hosts: string[] }; error?: string }>({
        type: 'SCRIPTS_GET_PERMISSIONS', id,
      });
      setHosts(resp.ok ? resp.data?.hosts ?? [] : []);
    } catch {
      setHosts([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void pull(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [id]);

  async function revoke(host: string): Promise<void> {
    await sendScriptsRequest({ type: 'SCRIPTS_REVOKE_PERMISSION', id, host });
    await pull();
  }

  return (
    <div className="detail__tabcard">
      <div className="detail__sectiontitle mono">XHR 安全 · 总是允许名单</div>
      <p className="detail__hint">
        这些域名已获得该脚本的跨域请求授权（在确认卡点「总是允许」时记录）。撤销后，脚本再请求这些域名会重新弹确认。
      </p>
      {loading ? (
        <div className="chat__empty">加载中…</div>
      ) : hosts.length === 0 ? (
        <div className="chat__empty">无已授权域名——脚本请求跨域时将逐次询问</div>
      ) : (
        <div className="detail__hostlist">
          {hosts.map((h) => (
            <div key={h} className="detail__hostrow">
              <span className="mono">{h}</span>
              <Button variant="ghost" aria-label={`撤销 ${h}`} onClick={() => void revoke(h)}>
                <Undo2 size={13} /> 撤销
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- `components/detail/DetailLogsTab.tsx`：

```tsx
// components/detail/DetailLogsTab.tsx
// 日志 Tab：脚本错误环形缓冲（时间 · line · 消息 + 可展开 stack）+ 清空；.well 井视觉。
import { useState } from 'react';
import { Button } from '../ui/Button';
import { sendScriptsRequest } from '../../stores/scripts';
import type { GmErrorItem } from '../../stores/scripts';

export function DetailLogsTab({ id, errors }: { id: string; errors: GmErrorItem[] }) {
  const [openIdx, setOpenIdx] = useState<number | null>(null);

  return (
    <div className="detail__tabcard">
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
      {errors.length === 0 ? (
        <div className="chat__empty">暂无错误——脚本运行正常</div>
      ) : (
        <div className="well detail__logs">
          {[...errors].reverse().map((e, i) => (
            <div key={i} className="detail__logrow">
              <button
                type="button"
                className="detail__logmain mono"
                onClick={() => setOpenIdx(openIdx === i ? null : i)}
                aria-expanded={openIdx === i}
              >
                {new Date(e.at).toLocaleTimeString()} · line {e.line ?? '?'} · {e.message}
              </button>
              {openIdx === i && e.stack && <pre className="detail__logstack mono">{e.stack}</pre>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 6: 建入口文件**——`entrypoints/script-detail/index.html`：

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>脚本详情</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

`entrypoints/script-detail/main.tsx`：

```typescript
// entrypoints/script-detail/main.tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import { DetailApp } from '../../components/detail/DetailApp';
import '../sidepanel/styles.css';

const params = new URLSearchParams(location.search);
const id = params.get('id') ?? '';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {id ? <DetailApp id={id} /> : <div className="detail detail--empty">缺少脚本 id 参数</div>}
  </React.StrictMode>,
);
```

- [ ] **Step 7: 样式**——`styles.css` 文件末尾追加：

```css
/* ============ 全屏脚本详情页（script-detail.html） ============ */
.detail { display: flex; flex-direction: column; height: 100vh; background: var(--paper); color: var(--ink); font-family: var(--sans); }
.detail--empty { align-items: center; justify-content: center; gap: 10px; display: flex; flex-direction: column; }
.detail__topbar {
  display: flex; align-items: center; gap: 10px; padding: 10px 16px;
  border-bottom: 1px solid var(--line); background: var(--surface);
  position: sticky; top: 0; z-index: 2; flex-shrink: 0;
}
.detail__title { font-size: 15px; font-weight: 600; margin: 0; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.detail__main { display: flex; flex: 1; min-height: 0; }
.detail__side {
  width: 160px; flex-shrink: 0; display: flex; flex-direction: column; gap: 2px;
  padding: 12px 8px; border-right: 1px solid var(--line); background: var(--surface);
}
.detail__navitem {
  display: flex; align-items: center; gap: 6px; padding: 7px 10px;
  border: none; border-left: 2px solid transparent; background: transparent;
  color: var(--ink-2); cursor: pointer; font-family: var(--sans); font-size: 13px; text-align: left;
  border-radius: 0 var(--r-sm) var(--r-sm) 0;
}
.detail__navitem:hover { background: var(--sunken); color: var(--ink); }
.detail__navitem.is-active { border-left-color: var(--signal); color: var(--signal-ink); background: var(--signal-wash); }
.detail__navitem--danger { color: var(--warn); margin-top: auto; }
.detail__navitem--danger:hover { background: var(--warn-wash); color: var(--warn); }
.detail__side-spacer { flex: 1; }
.detail__navcount { margin-left: auto; font-size: 10px; color: var(--ink-3); }
.detail__content { flex: 1; min-width: 0; overflow: auto; padding: 20px 24px; }
.detail__tabcard {
  max-width: 840px; margin: 0 auto; display: grid; gap: 10px;
  background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-lg); padding: 16px;
}
.detail__inforow { display: grid; grid-template-columns: 110px 1fr; gap: 10px; font-size: 12.5px; align-items: baseline; }
.detail__inforow > .mono { color: var(--ink-3); font-size: 11px; }
.detail__actions { display: flex; gap: 6px; margin-top: 6px; }
.detail__sectiontitle { font-size: 11px; color: var(--ink-2); }
.detail__hint { font-size: 12px; color: var(--ink-3); margin: 0; line-height: 1.6; }
.detail__hostlist { display: grid; gap: 6px; }
.detail__hostrow {
  display: flex; align-items: center; justify-content: space-between;
  border: 1px solid var(--line); border-radius: var(--r-md); padding: 7px 10px; font-size: 12px;
}
.detail__logs { padding: 10px 12px; }
.detail__logrow { padding: 2px 0; }
.detail__logmain {
  width: 100%; text-align: left; border: none; background: transparent;
  color: var(--ink); cursor: pointer; font-size: 11.5px; padding: 2px 0; font-family: var(--mono);
}
.detail__logmain:hover { color: var(--signal-ink); }
.detail__logstack { margin: 4px 0 6px; padding: 8px; background: var(--paper); border: 1px solid var(--line); border-radius: var(--r-sm); white-space: pre-wrap; word-break: break-all; max-height: 240px; overflow: auto; font-size: 11px; color: var(--warn); }

/* 代码 Tab：编辑器全宽破格（不受 tabcard 840px 限制） */
.detail-code { display: grid; gap: 8px; max-width: none; width: 100%; }
.detail-code__bar { display: flex; align-items: center; gap: 8px; max-width: 840px; margin: 0 auto; width: 100%; }
.detail-code__status { flex: 1; font-size: 11px; color: var(--ink-3); }
.detail-code__editor {
  width: 100%; min-height: calc(100vh - 200px); resize: vertical;
  font-size: 12.5px; line-height: 1.6; tab-size: 2;
  background: var(--sunken); border: 1px solid var(--line); border-radius: var(--r-md);
  padding: 12px; color: var(--ink); outline: none;
}
.detail-code__editor:focus { border-color: var(--signal); }

@media (max-width: 720px) {
  .detail__main { flex-direction: column; }
  .detail__side { width: 100%; flex-direction: row; border-right: none; border-bottom: 1px solid var(--line); padding: 8px; }
  .detail__side-spacer { display: none; }
  .detail__navitem--danger { margin-top: 0; margin-left: auto; }
  .detail__navitem { border-left: none; border-bottom: 2px solid transparent; border-radius: var(--r-sm) var(--r-sm) 0 0; }
  .detail__navitem.is-active { border-left-color: transparent; border-bottom-color: var(--signal); }
}
```

- [ ] **Step 8: 跑测试 + 编译**

Run: `npx vitest run tests/detail/detail-app.test.tsx && npm run compile`
Expected: PASS、编译无错（WXT 构建入口验证放 Task 8 的 `npm run build`）

- [ ] **Step 9: Commit**

```bash
git add entrypoints/script-detail components/detail entrypoints/sidepanel/styles.css tests/detail/detail-app.test.tsx
git commit -m "feat: 全屏脚本详情页——顶栏/左栏导航/四 Tab（详情·代码·设置·日志）"
```

---

### Task 6: popup 入口（三区布局 + 菜单触发 + UI_NAV 直达）

**Files:**
- Create: `entrypoints/popup/index.html`
- Create: `entrypoints/popup/main.tsx`
- Create: `components/popup/PopupApp.tsx`
- Modify: `wxt.config.ts`（manifest action）
- Modify: `entrypoints/background.ts`（setPanelBehavior 移除）
- Modify: `entrypoints/sidepanel/App.tsx`（UI_NAV 监听 + pendingView 消费）
- Modify: `entrypoints/sidepanel/styles.css`（popup 类）
- Test: `tests/popup/popup-app.test.tsx`（新建）

- [ ] **Step 1: 写失败测试**——新建 `tests/popup/popup-app.test.tsx`：

```tsx
// tests/popup/popup-app.test.tsx
// popup 三区：导航按钮（开侧边栏/脚本管理直达）+ 当前页运行中脚本（菜单触发/编辑跳转）。
// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { PopupApp } from '../../components/popup/PopupApp';

afterEach(cleanup);

function mockBackend(opts: {
  entry?: { tabId: number; url: string; scriptIds: string[] } | null;
  commands?: Array<{ scriptId: string; commands: Array<{ key: string; name: string }> }>;
} = {}): void {
  browser.runtime.onMessage.addListener((msg: { type: string }, _s, sendResponse) => {
    if (msg.type === 'SCRIPTS_GET_RUNTIME_FOR_TAB') {
      sendResponse({ ok: true, data: { entry: opts.entry ?? null } });
      return true;
    }
    if (msg.type === 'SCRIPTS_GET_GM_STATE') {
      sendResponse({ ok: true, data: { menus: opts.commands ?? [], errors: {}, confirms: [] } });
      return true;
    }
    if (msg.type === 'SCRIPTS_LIST') {
      sendResponse({ ok: true, data: { scripts: opts.entry?.scriptIds.map((id) => ({ id, name: `脚本${id}`, enabled: true })) ?? [], engineAvailable: true } });
      return true;
    }
    if (msg.type === 'SCRIPTS_MENU_INVOKE') { sendResponse({ ok: true }); return true; }
    sendResponse({ ok: false, error: 'unexpected' }); return true;
  });
}

describe('PopupApp', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
  });

  it('渲染两导航按钮 + RUNNING 计数头 + 空态', async () => {
    mockBackend({ entry: null });
    render(<PopupApp />);
    expect(screen.getByRole('button', { name: /打开侧边栏/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /脚本管理/ })).toBeTruthy();
    expect(await screen.findByText(/无脚本在此页运行/)).toBeTruthy();
  });

  it('运行中脚本行渲染名称；hover 编辑按钮调 tabs.create 开详情页', async () => {
    mockBackend({ entry: { tabId: 11, url: 'https://a.com/', scriptIds: ['r1'] } });
    const createSpy = vi.fn().mockResolvedValue({});
    (browser.tabs as unknown as { create: typeof createSpy }).create = createSpy;
    render(<PopupApp />);
    expect(await screen.findByText('脚本r1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /编辑 脚本r1/ }));
    expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({ url: expect.stringContaining('script-detail.html?id=r1') }));
  });

  it('单菜单命令：点行直触 MENU_INVOKE 后 window.close', async () => {
    mockBackend({ entry: { tabId: 11, url: 'https://a.com/', scriptIds: ['r1'] }, commands: [{ scriptId: 'r1', commands: [{ key: 'k1', name: '命令一' }] }] });
    const closeSpy = vi.spyOn(window, 'close').mockImplementation(() => {});
    render(<PopupApp />);
    const row = await screen.findByText('脚本r1');
    fireEvent.click(row);
    await vi.waitFor(() => {
      expect(closeSpy).toHaveBeenCalled();
    });
  });

  it('多菜单命令：点行展开命令列表，点命令触发后关闭', async () => {
    mockBackend({ entry: { tabId: 11, url: 'https://a.com/', scriptIds: ['r1'] }, commands: [{ scriptId: 'r1', commands: [{ key: 'k1', name: '命令一' }, { key: 'k2', name: '命令二' }] }] });
    const closeSpy = vi.spyOn(window, 'close').mockImplementation(() => {});
    render(<PopupApp />);
    const row = await screen.findByText('脚本r1');
    fireEvent.click(row);
    const cmd = await screen.findByText('命令二');
    fireEvent.click(cmd);
    await vi.waitFor(() => expect(closeSpy).toHaveBeenCalled());
  });

  it('零菜单命令：行呈禁用观感（aria-disabled），点击不触发不关闭', async () => {
    mockBackend({ entry: { tabId: 11, url: 'https://a.com/', scriptIds: ['r1'] }, commands: [] });
    const closeSpy = vi.spyOn(window, 'close').mockImplementation(() => {});
    render(<PopupApp />);
    const row = await screen.findByText('脚本r1');
    expect(row.closest('[aria-disabled="true"]')).toBeTruthy();
    fireEvent.click(row);
    expect(closeSpy).not.toHaveBeenCalled();
  });

  it('脚本管理按钮：写 pendingView + 发 UI_NAV + 调 sidePanel.open', async () => {
    mockBackend({ entry: null });
    (browser.tabs as unknown as { query: () => Promise<Array<{ id: number }>> }).query = vi.fn().mockResolvedValue([{ id: 7 }]);
    const openSpy = vi.spyOn(browser.sidePanel, 'open').mockResolvedValue(undefined);
    const sessionSet = vi.spyOn(browser.storage.session, 'set');
    render(<PopupApp />);
    fireEvent.click(screen.getByRole('button', { name: /脚本管理/ }));
    await vi.waitFor(() => {
      expect(openSpy).toHaveBeenCalledWith({ tabId: 7 });
      expect(sessionSet).toHaveBeenCalled();
    });
  });
});
```

注意：fakeBrowser **已 mock** `storage.session`（`@webext-core/fake-browser` defineStorageArea("session")）和 `sidePanel.open`（`notMockedFunction`，可被 vi.spyOn 覆写）。测试里直接 `vi.spyOn(browser.sidePanel, 'open')` / `vi.spyOn(browser.storage.session, 'set')` 即可，无需挂 any stub。组件代码走 WXT `storage.setItem('session:ui:pendingView', ...)` 时，底层即调 `browser.storage.session.set`，spy 断言仍成立（WXT storage 薄封装直接透传）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/popup/popup-app.test.tsx`
Expected: FAIL（模块不存在）

- [ ] **Step 3: PopupApp 组件**——`components/popup/PopupApp.tsx`：

```tsx
// components/popup/PopupApp.tsx
// 扩展图标 popup（spec §3）：上区导航（开侧边栏/脚本管理直达）+ 下区当前页运行中脚本。
// 点脚本 = 触发菜单命令（单条直触/多条展开/零条禁用观感），触发后浮窗关闭。
import { useEffect, useState } from 'react';
import { storage } from 'wxt/utils/storage';
import { PanelLeft, ScrollText, SquarePen } from 'lucide-react';
import { openScriptTab, sendScriptsRequest, selectMenuCommands } from '../../stores/scripts';
import type { GmMenuEntry, GmErrorItem, GmConfirmItem } from '../../stores/scripts';
import type { ScriptsRuntimeEntry } from '../../shared/messages';

interface RunRow {
  scriptId: string;
  name: string;
  commands: Array<{ key: string; name: string }>;
}

export function PopupApp() {
  const [rows, setRows] = useState<RunRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null); // 多命令展开中的 scriptId

  // 冷读：当前 tab 运行条目 + 菜单快照（短命页面不订阅广播）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        let [tab] = await browser.tabs.query({ active: true, currentWindow: true });
        if (!tab) [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
        const tabId = tab?.id;
        const rtResp = await sendScriptsRequest<{ ok: boolean; data?: { entry: ScriptsRuntimeEntry | null }; error?: string }>({
          type: 'SCRIPTS_GET_RUNTIME_FOR_TAB', tabId: tabId ?? -1,
        });
        const gmResp = await sendScriptsRequest<{ ok: boolean; data?: { menus: GmMenuEntry[]; errors: Record<string, GmErrorItem[]>; confirms: GmConfirmItem[] }; error?: string }>({
          type: 'SCRIPTS_GET_GM_STATE',
        });
        const listResp = await sendScriptsRequest<{ ok: boolean; data?: { scripts: Array<{ id: string; name: string }> }; error?: string }>({
          type: 'SCRIPTS_LIST',
        });
        if (cancelled) return;
        const entry = rtResp.data?.entry ?? null;
        const names = new Map((listResp.data?.scripts ?? []).map((s) => [s.id, s.name]));
        const menus = gmResp.data?.menus ?? [];
        const runRows: RunRow[] = (entry?.scriptIds ?? []).map((scriptId) => ({
          scriptId,
          name: names.get(scriptId) ?? scriptId,
          commands: menus.find((m) => m.scriptId === scriptId)?.commands ?? [],
        }));
        setRows(runRows);
      } catch {
        if (!cancelled) setRows([]);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function openSidepanel(): Promise<void> {
    let [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab) [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id != null) await browser.sidePanel.open({ tabId: tab.id });
  }

  async function gotoScripts(): Promise<void> {
    // 双通道保时序：storage.session 待航标记（侧边栏挂载消费）+ 实时广播（侧边栏已开时立即切换）
    await storage.setItem('session:ui:pendingView', 'scripts');
    await browser.runtime.sendMessage({ type: 'UI_NAV', view: 'scripts' }).catch(() => {});
    await openSidepanel();
  }

  async function invoke(scriptId: string, key: string): Promise<void> {
    await sendScriptsRequest({ type: 'SCRIPTS_MENU_INVOKE', scriptId, key });
    window.close(); // 触发后浮窗关闭（用户决策 B）
  }

  function onRowClick(row: RunRow): void {
    if (row.commands.length === 0) return;
    if (row.commands.length === 1) void invoke(row.scriptId, row.commands[0].key);
    else setExpanded(expanded === row.scriptId ? null : row.scriptId);
  }

  return (
    <div className="popup">
      <div className="popup__nav">
        <button className="popup__navbtn" onClick={() => void openSidepanel()}>
          <PanelLeft size={15} aria-hidden /> 打开侧边栏
        </button>
        <button className="popup__navbtn" onClick={() => void gotoScripts()}>
          <ScrollText size={15} aria-hidden /> 脚本管理
        </button>
      </div>
      <div className="popup__run">
        <div className="popup__runhead">
          <span className={`scripts-run__dot${rows.length > 0 ? '' : ' scripts-run__dot--off'}`} aria-hidden />
          <span className="mono">RUNNING · {rows.length}</span>
        </div>
        {!loaded ? (
          <div className="popup__empty">加载中…</div>
        ) : rows.length === 0 ? (
          <div className="popup__empty">无脚本在此页运行</div>
        ) : (
          rows.map((row) => (
            <div key={row.scriptId} className="popup__runwrap">
              <div
                className="popup__runrow"
                role="button"
                tabIndex={0}
                aria-disabled={row.commands.length === 0}
                title={row.commands.length === 0 ? '无菜单命令' : row.commands.length === 1 ? `执行：${row.commands[0].name}` : '展开命令列表'}
                onClick={() => onRowClick(row)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onRowClick(row); } }}
              >
                <span className="popup__runname">{row.name}</span>
                <button
                  type="button"
                  className="popup__editbtn"
                  aria-label={`编辑 ${row.name}`}
                  title="编辑脚本"
                  onClick={(e) => { e.stopPropagation(); openScriptTab(row.scriptId); }}
                >
                  <SquarePen size={13} aria-hidden />
                </button>
              </div>
              {expanded === row.scriptId && row.commands.length > 1 && (
                <div className="popup__cmdlist">
                  {row.commands.map((c) => (
                    <button
                      key={c.key}
                      className="popup__cmdbtn"
                      onClick={() => void invoke(row.scriptId, c.key)}
                    >
                      {c.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
```

（`selectMenuCommands` import 若未用则删——popup 直接按 scriptId 过滤菜单。）

- [ ] **Step 4: 入口文件**——`entrypoints/popup/index.html`：

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>AI Browser Extension</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

`entrypoints/popup/main.tsx`：

```typescript
// entrypoints/popup/main.tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import { PopupApp } from '../../components/popup/PopupApp';
import '../sidepanel/styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <PopupApp />
  </React.StrictMode>,
);
```

- [ ] **Step 5: manifest 与 background**——`wxt.config.ts`：

```typescript
    action: {
      default_popup: 'popup.html',
    },
```

`entrypoints/background.ts`：`browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});` 行删除（onInstalled 监听器里保留旧会话清理逻辑）。

- [ ] **Step 6: UI_NAV 接线**——`entrypoints/sidepanel/App.tsx` 整文件替换：

```tsx
// entrypoints/sidepanel/App.tsx
// 侧边栏壳：railnav 导航 + 页面路由；UI_NAV 跨面导航（popup 直达）+ pendingView 挂载消费。
import { useEffect } from 'react';
import { storage } from 'wxt/utils/storage';
import { MessageSquare, Puzzle, SquareTerminal, Settings as SettingsIcon } from 'lucide-react';
import { useUi, type Page } from '../../stores/ui';
import { ChatView } from '../../components/chat/ChatView';
import { ScriptsView } from '../../components/scripts/ScriptsView';
import { DebugView } from '../../components/debug/DebugView';
import { SettingsView } from '../../components/settings/SettingsView';

const NAV: Array<{ page: Page; label: string; Icon: typeof MessageSquare }> = [
  { page: 'chat', label: '会话', Icon: MessageSquare },
  { page: 'scripts', label: '脚本池', Icon: Puzzle },
  { page: 'debug', label: '调试台', Icon: SquareTerminal },
  { page: 'settings', label: '设置', Icon: SettingsIcon },
];

const PITCH = 42; // 每个导航按钮的纵向节距（40 高 + 2 gap）

/** popup 写下的待航标记（侧边栏未开时 UI_NAV 无人接收 → 挂载时消费兜底） */
async function consumePendingView(): Promise<void> {
  const pending = await storage.getItem<'chat' | 'scripts' | 'debug' | 'settings'>('session:ui:pendingView');
  if (pending) {
    await storage.removeItem('session:ui:pendingView');
    useUi.getState().setPage(pending);
  }
}

export default function App() {
  const { page, setPage } = useUi();
  const activeIndex = NAV.findIndex((n) => n.page === page);

  useEffect(() => {
    void consumePendingView();
    const onMessage = (msg: unknown) => {
      const m = msg as { type?: string; view?: Page };
      if (m?.type === 'UI_NAV' && m.view) setPage(m.view);
    };
    browser.runtime.onMessage.addListener(onMessage);
    return () => browser.runtime.onMessage.removeListener(onMessage);
  }, []);

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
        {page === 'debug' && <DebugView />}
        {page === 'settings' && <SettingsView />}
      </main>
    </div>
  );
}
```

注意：popup 写标记用 WXT `storage.setItem('session:ui:pendingView', 'scripts')`，侧边栏用 `storage.getItem('session:ui:pendingView')` 读 + `removeItem` 删——**两边都用 `wxt/utils/storage` 的 `storage`**（WXT 的 `session:` 前缀映射 `browser.storage.session`，与 `storage/conversations.ts:34` 的 `session:currentConvId` 同约定；混用裸 `browser.storage.session.set({key: v})` 对象形式与 WXT storage 的 key 形式会存到不同形状，必须统一走 WXT storage）。popup 组件文件头 `import { storage } from 'wxt/utils/storage';`。

- [ ] **Step 7: popup 样式**——`styles.css` 末尾追加：

```css
/* ============ 扩展图标 popup（popup.html，宽 360px） ============ */
.popup { width: 360px; display: flex; flex-direction: column; background: var(--paper); color: var(--ink); font-family: var(--sans); }
.popup__nav { display: flex; flex-direction: column; padding: 8px; gap: 2px; border-bottom: 1px solid var(--line); background: var(--surface); }
.popup__navbtn {
  display: flex; align-items: center; gap: 8px; padding: 9px 10px;
  border: none; border-radius: var(--r-md); background: transparent;
  color: var(--ink); cursor: pointer; font-family: var(--sans); font-size: 13px; text-align: left;
}
.popup__navbtn:hover { background: var(--sunken); }
.popup__run { padding: 10px 12px 12px; }
.popup__runhead { display: flex; align-items: center; gap: 6px; color: var(--ink-2); margin-bottom: 6px; font-size: 11px; }
.popup__empty { color: var(--ink-3); font-size: 12px; padding: 4px 0 2px; }
.popup__runwrap { border: 1px solid var(--line); border-radius: var(--r-md); margin-bottom: 6px; background: var(--surface); }
.popup__runrow {
  display: flex; align-items: center; gap: 6px; padding: 8px 10px; cursor: pointer;
  border-radius: var(--r-md); font-size: 12.5px;
}
.popup__runrow[aria-disabled="true"] { opacity: 0.55; cursor: default; }
.popup__runrow:hover { background: var(--sunken); }
.popup__runname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.popup__editbtn {
  border: none; background: transparent; color: var(--ink-3); cursor: pointer;
  padding: 4px; border-radius: var(--r-sm); display: inline-flex; flex-shrink: 0;
  opacity: 0; transition: opacity 120ms ease;
}
.popup__runrow:hover .popup__editbtn, .popup__editbtn:focus-visible { opacity: 1; }
.popup__editbtn:hover { background: var(--line-strong); color: var(--ink); }
.popup__cmdlist { display: grid; gap: 2px; padding: 0 6px 6px; }
.popup__cmdbtn {
  text-align: left; padding: 6px 8px; border: none; border-radius: var(--r-sm);
  background: var(--sunken); color: var(--ink); cursor: pointer; font-size: 12px; font-family: var(--sans);
}
.popup__cmdbtn:hover { background: var(--line-strong); }
@media (prefers-reduced-motion: reduce) {
  .popup__editbtn { transition: none; }
}
```

- [ ] **Step 8: 跑测试 + 编译 + 构建**

Run: `npx vitest run tests/popup/popup-app.test.tsx && npm run compile && npm run build`
Expected: 测试 PASS；`npm run build` 产出含 `popup.html` 和 `script-detail.html` 两个入口（构建输出列表可见）

- [ ] **Step 9: Commit**

```bash
git add entrypoints/popup components/popup wxt.config.ts entrypoints/background.ts entrypoints/sidepanel/App.tsx entrypoints/sidepanel/styles.css tests/popup/popup-app.test.tsx
git commit -m "feat: 扩展图标 popup——开侧边栏/脚本管理直达/运行中脚本菜单触发"
```

---

### Task 7: 收尾——scripts-footer/menubtn 死样式清理 + 全量验证

**Files:**
- Modify: `entrypoints/sidepanel/styles.css`（删死类）
- Test: 全量

- [ ] **Step 1: 找死样式并删**

Run: `grep -rn "scripts-footer\|scripts-menubtn\|scripts-run__" components/ entrypoints/ --include="*.tsx" | grep -v styles.css`
Expected: `scripts-run__dot`（popup 用）有引用；`scripts-footer`、`scripts-menubtn`、`scripts-run__head`、`scripts-run__item`、`scripts-run__empty`、`scripts-run` 无引用 → 从 styles.css 删除这些死类（保留 `scripts-run__dot` 两个类，popup 在用）

- [ ] **Step 2: 全量验证**

Run: `npm run compile && npm run test && npm run build`
Expected: 编译零错、全部测试 PASS、构建成功含三入口（sidepanel.html / popup.html / script-detail.html）

- [ ] **Step 3: 手动验收清单**（`npm run dev` 载入扩展逐项过）

- 扩展图标点击 → popup 三区可见；「打开侧边栏」开面板；「脚本管理」开面板且切到脚本页（侧边栏开/未开两种时序都试）
- popup：运行中脚本行点击触发菜单命令且浮窗关闭；hover 出编辑钮跳全屏详情
- 侧边栏脚本页：卡片 + switch 启停（立即生效不跳页）；点卡片开全屏详情；搜索过滤正常
- 全屏详情页：四 Tab 切换；代码编辑保存后「已重新注册，刷新页面生效」；设置 Tab 撤销授权后重新请求该域名会再弹确认卡；日志 Tab 错误展开 stack
- 圆角视觉走查：卡片 `--r-md`、徽标 `--r-sm`、popup 卡片 `--r-md`、全屏页卡片 `--r-lg`

- [ ] **Step 4: Commit（若有样式清理）**

```bash
git add entrypoints/sidepanel/styles.css
git commit -m "chore: 清理脚本页重设计后的死样式类"
```

---

## 任务依赖与顺序

Task 1 → 2（后台 API/消息先行）→ 3（侧边栏重构依赖 openScriptTab 与 .switch）→ 4（删旧详情页，依赖 3 的 ScriptsView 改造）→ 5（全屏详情页，依赖 3 的 .switch 样式与 openScriptTab）→ 6（popup，依赖 2 的 per-tab handler 与 5 的 script-detail 入口）→ 7（收尾验证）。

Task 3 与 Task 5 的组件代码理论上可并行，但都动 styles.css，串行执行避免冲突。

## Spec 覆盖对照

| Spec 节 | 任务 |
|---|---|
| §1 侧边栏纯管理器 | Task 3 |
| §1 路由变更（openScriptTab） | Task 3（Step 3）、Task 4 |
| §2 全屏详情页骨架/四 Tab | Task 5 |
| §2 新消息类型 | Task 1（类型）、Task 2（handler） |
| §3 popup 三区 | Task 6 |
| §3 UI_NAV 联动 | Task 6（Step 3/6） |
| §4 样式规范 | Task 3/5/6（各样式步）+ Task 7（清理） |
| §6 错误处理 | 分散于各组件（notFound/loading/catch/幂等 revoke） |
| §7 测试 | 各任务 TDD 步骤 + Task 7 手动清单 |
