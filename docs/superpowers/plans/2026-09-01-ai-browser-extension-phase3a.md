# AI Browser Extension 实施计划（Phase 3a：感知与外联 · 轻量集）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 agent 补上 tabs 管理、take_screenshot（喂多模态模型）、evaluate_script、http_request 四类工具（9 → 16 个），全部走 background chrome-API 分支，不引入 MAIN world 基础设施。

**Architecture:** 每个工具一个纯执行模块（tabs/screenshot/evaluate/http），registry 扩展 chrome-API 分发并收窄受限页预检适用面；loop 引入可变 `targetTab`（new/select/close 后更新），截图成功后向 messages 注入 `role:user` 图片消息（复用已建好的 provider `image_url` wire 转换）；context 裁剪历史图片防膨胀。

**Tech Stack:** WXT + React 19 + TypeScript（strict + noUncheckedIndexedAccess）、Vitest（jsdom + WxtVitest fakeBrowser）、zustand、lucide-react。

**规格文档：** [docs/superpowers/specs/2026-09-01-ai-browser-extension-phase3a-design.md](../specs/2026-09-01-ai-browser-extension-phase3a-design.md)

**依赖 Phase 2 冻结接口：** `agent/tools/registry.ts`（executeTool/ToolCtx）、`agent/loop.ts`（LoopDeps/runAgentLoop/resumeAgentLoop）、`agent/provider/types.ts`（ContentPart/ChatMessage/ToolSchema）、`shared/types.ts`（ToolResult）、`shared/messages.ts`（PortMsgToPanel）、`storage/settings.ts`（getSettings）、`background/agent-port.ts`（makeDeps/waitForCsReady）。

---

## 关键实现约定（所有 task 遵守）

- **运行时全局用 `browser.*`**（WXT auto-import + polyfill），不用 `chrome.*`。
- **ToolResult 判别联合**：成功 `{ ok:true, data? }`，失败 `{ ok:false, error }`。工具内不抛异常，错误编码进 `error`。
- **测试镜像源码路径**放 `tests/`（如 `agent/tools/tabs.ts` → `tests/agent/tools/tabs.test.ts`）。
- **jsdom 限制**：`OffscreenCanvas`、真实 `captureVisibleTab`/`scripting.executeScript` 不可用 → 单测 mock，真实行为留手测（沿用 Phase 2 惯例）。
- **每个 task 结尾 commit**。

---

## 文件结构（Phase 3a 新建/修改）

```
agent/tools/
├── tabs.ts        # Task 2：list/new/close/select 执行器
├── screenshot.ts  # Task 3：capture + compressDataUrl（抽出便于 mock）
├── http.ts        # Task 4：fetch + 响应头白名单 + body 截断
├── evaluate.ts    # Task 5：executeScript 包裹 + 超时 + 序列化校验
├── schemas.ts     # Task 1：+7 ToolSchema（修改）
└── registry.ts    # Task 6：chrome-API 分发扩展 + 受限页预检收窄（修改）
agent/
├── loop.ts        # Task 7：targetTab 状态机 + 截图注入 + executeTool 签名（修改）
└── context.ts     # Task 8：历史图片裁剪（修改）
shared/
└── messages.ts    # Task 9：PortMsgToPanel.tool-end +image?（修改）
background/
└── agent-port.ts  # Task 9：makeDeps executeTool 签名对齐（修改）
stores/
└── chat.ts        # Task 10：tool-end 读 image（修改）
components/chat/
└── ChatView.tsx   # Task 10：工具卡片缩略图（修改）
```

**任务顺序（依赖驱动）**：1 schemas → 2-5 四执行器 → 6 registry 分发 → 7 loop（targetTab+注入）→ 8 context 裁剪 → 9 协议+接线 → 10 UI → 11 收尾。

---

### Task 1: 工具 schema 扩展（+7 → 16）

**Files:**
- Modify: `agent/tools/schemas.ts`
- Test: `tests/agent/tools/schemas.test.ts`

- [ ] **Step 1: 改失败测试 `tests/agent/tools/schemas.test.ts`**

把「恰好 9 个」的断言改为 16，并补新工具断言：

```ts
  it('恰好 16 个工具（Phase 2 的 9 + Phase 3a 的 7）', () => {
    const names = TOOL_SCHEMAS.map((s) => s.function.name).sort();
    expect(names).toEqual([
      'click', 'close_page', 'evaluate_script', 'fill', 'fill_form', 'hover',
      'http_request', 'list_pages', 'navigate_page', 'new_page', 'press_key',
      'scroll', 'select_page', 'take_screenshot', 'take_snapshot', 'wait_for',
    ]);
  });

  it('http_request 的 url 必填、method 枚举', () => {
    const t = TOOL_SCHEMAS.find((s) => s.function.name === 'http_request')!;
    const p = t.function.parameters as { properties: Record<string, { enum?: string[] }>; required: string[] };
    expect(p.required).toContain('url');
    expect(p.properties.method!.enum).toEqual(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);
  });

  it('evaluate_script 的 function 必填、world 枚举', () => {
    const t = TOOL_SCHEMAS.find((s) => s.function.name === 'evaluate_script')!;
    const p = t.function.parameters as { properties: Record<string, { enum?: string[] }>; required: string[] };
    expect(p.required).toContain('function');
    expect(p.properties.world!.enum).toEqual(['main', 'isolated']);
  });

  it('new_page 的 url 必填', () => {
    const t = TOOL_SCHEMAS.find((s) => s.function.name === 'new_page')!;
    const p = t.function.parameters as { required: string[] };
    expect(p.required).toContain('url');
  });
```

（保留原有「全部是 function 类型且有描述」「click uid 必填」「navigate_page type 枚举」等回归断言。）

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/agent/tools/schemas.test.ts`
Expected: FAIL —— 数量 9≠16。

- [ ] **Step 3: 在 `agent/tools/schemas.ts` 的 `TOOL_SCHEMAS` 数组末尾追加 7 个 schema**

```ts
  {
    type: 'function',
    function: {
      name: 'list_pages',
      description: '列出当前所有打开的标签页（tabId、URL、标题、是否活动、是否为当前操作目标）。',
      parameters: obj({}),
    },
  },
  {
    type: 'function',
    function: {
      name: 'new_page',
      description: '打开新标签页并把它设为后续操作的目标。',
      parameters: obj({
        url: { type: 'string', description: '要打开的地址' },
        background: { type: 'boolean', description: '是否后台打开（不夺焦，默认 false）' },
      }, ['url']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'close_page',
      description: '关闭指定标签页。若关闭的是当前操作目标，目标回落到启动标签。',
      parameters: obj({ tabId: { type: 'number', description: '要关闭的标签页 id（来自 list_pages）' } }, ['tabId']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'select_page',
      description: '切换到指定标签页并把它设为后续操作的目标。',
      parameters: obj({ tabId: { type: 'number', description: '目标标签页 id（来自 list_pages）' } }, ['tabId']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'take_screenshot',
      description: '截取当前操作目标标签页的可视区域截图，供你用视觉理解页面（布局/图表/验证码等 a11y 快照看不到的内容）。截图会作为图片消息呈现给你。',
      parameters: obj({
        format: { type: 'string', enum: ['jpeg', 'png'], description: '图片格式（默认 jpeg）' },
        quality: { type: 'number', description: 'jpeg 压缩质量 0~1（默认 0.7）' },
      }),
    },
  },
  {
    type: 'function',
    function: {
      name: 'evaluate_script',
      description: '在页面中执行一段 JavaScript 并返回其结果（必须可 JSON 序列化）。用于读取 a11y 快照无法覆盖的深层数据。',
      parameters: obj({
        function: { type: 'string', description: '一个函数表达式字符串，如 "() => document.title" 或 "() => document.querySelectorAll(\'a\').length"' },
        args: { type: 'array', description: '传给该函数的参数（可选）', items: {} },
        world: { type: 'string', enum: ['main', 'isolated'], description: 'main=可访问页面变量（默认），isolated=隔离环境' },
        timeoutMs: { type: 'number', description: '超时毫秒（默认 5000）' },
      }, ['function']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'http_request',
      description: '直接发起 HTTP 请求（带当前浏览器登录态 cookie）。用于调用接口、抓取数据。响应体截断至 64KB。',
      parameters: obj({
        url: { type: 'string', description: '请求地址' },
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'], description: '方法（默认 GET）' },
        headers: { type: 'object', description: '请求头键值对（可选）', additionalProperties: { type: 'string' } },
        body: { type: 'string', description: '请求体（可选，字符串）' },
      }, ['url']),
    },
  },
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/agent/tools/schemas.test.ts`
Expected: 全部 passed。

- [ ] **Step 5: Commit**

```bash
git add agent/tools/schemas.ts tests/agent/tools/schemas.test.ts
git commit -m "feat: Phase 3a 工具 schema（tabs/screenshot/evaluate/http_request，9→16）"
```

---

### Task 2: 标签页工具执行器（`agent/tools/tabs.ts`）

list/new/close/select 四个执行器。执行器只做 chrome.tabs 调用 + 组织 ToolResult；targetTab 语义由 loop 消费（执行器只在 data 里带出新 tabId）。

**Files:**
- Create: `agent/tools/tabs.ts`
- Test: `tests/agent/tools/tabs.test.ts`

- [ ] **Step 1: 写失败测试 `tests/agent/tools/tabs.test.ts`**

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/browser';
import { doListPages, doNewPage, doClosePage, doSelectPage } from '../../../agent/tools/tabs';

describe('标签页工具', () => {
  beforeEach(() => fakeBrowser.reset());

  it('list_pages 返回标签列表并标注 isTarget', async () => {
    fakeBrowser.tabs.query = vi.fn().mockResolvedValue([
      { id: 1, url: 'https://a.com', title: 'A', active: true },
      { id: 2, url: 'https://b.com', title: 'B', active: false },
    ]) as never;
    const r = await doListPages(2);
    expect(r.ok).toBe(true);
    const pages = (r as { data: { pages: Array<{ tabId: number; isTarget: boolean }> } }).data.pages;
    expect(pages).toHaveLength(2);
    expect(pages.find((p) => p.tabId === 2)!.isTarget).toBe(true);
    expect(pages.find((p) => p.tabId === 1)!.isTarget).toBe(false);
  });

  it('new_page 创建标签并返回 targetTab', async () => {
    const create = vi.fn().mockResolvedValue({ id: 99, url: 'https://x.com' });
    fakeBrowser.tabs.create = create as never;
    const waitForReady = vi.fn().mockResolvedValue(undefined);
    const r = await doNewPage({ url: 'https://x.com', background: true }, waitForReady);
    expect(r.ok).toBe(true);
    expect((r as { data: { targetTab: number } }).data.targetTab).toBe(99);
    expect(create).toHaveBeenCalledWith({ url: 'https://x.com', active: false });
    expect(waitForReady).toHaveBeenCalledWith(99);
  });

  it('new_page 缺 url 报错', async () => {
    const r = await doNewPage({ url: '' }, vi.fn());
    expect(r.ok).toBe(false);
  });

  it('close_page 返回 closed', async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    fakeBrowser.tabs.remove = remove as never;
    const r = await doClosePage({ tabId: 5 });
    expect(r.ok).toBe(true);
    expect((r as { data: { closed: number } }).data.closed).toBe(5);
    expect(remove).toHaveBeenCalledWith(5);
  });

  it('select_page 激活并返回 targetTab', async () => {
    const update = vi.fn().mockResolvedValue({ id: 7, url: 'https://c.com' });
    fakeBrowser.tabs.update = update as never;
    const r = await doSelectPage({ tabId: 7 });
    expect(r.ok).toBe(true);
    expect((r as { data: { targetTab: number } }).data.targetTab).toBe(7);
    expect(update).toHaveBeenCalledWith(7, { active: true });
  });

  it('select_page 无效 tabId 报错', async () => {
    fakeBrowser.tabs.update = vi.fn().mockRejectedValue(new Error('No tab with id')) as never;
    const r = await doSelectPage({ tabId: 123 });
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/agent/tools/tabs.test.ts`
Expected: FAIL — module not found。

- [ ] **Step 3: 写 `agent/tools/tabs.ts`**

```ts
// agent/tools/tabs.ts
// 标签页管理工具（设计 §2、§6）。执行器只做 chrome.tabs 调用 + 组织 ToolResult；
// targetTab 的变更由 agent loop 读取 data.targetTab 后维护（设计 §4）。
import type { ToolResult } from '../../shared/types';

export async function doListPages(targetTab: number): Promise<ToolResult> {
  try {
    const tabs = await browser.tabs.query({});
    const pages = tabs
      .filter((t) => t.id != null)
      .map((t) => ({
        tabId: t.id!,
        url: t.url ?? '',
        title: t.title ?? '',
        active: t.active ?? false,
        isTarget: t.id === targetTab,
      }));
    return { ok: true, data: { pages } };
  } catch (err) {
    return { ok: false, error: `list_pages 失败：${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function doNewPage(
  args: { url: string; background?: boolean },
  waitForReady?: (tabId: number) => Promise<void>,
): Promise<ToolResult> {
  if (!args.url) return { ok: false, error: 'new_page 缺少 url 参数' };
  try {
    const tab = await browser.tabs.create({ url: args.url, active: !args.background });
    if (tab.id == null) return { ok: false, error: 'new_page 创建后未返回 tabId' };
    await waitForReady?.(tab.id);
    return { ok: true, data: { targetTab: tab.id, url: tab.url ?? args.url } };
  } catch (err) {
    return { ok: false, error: `new_page 失败：${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function doClosePage(args: { tabId: number }): Promise<ToolResult> {
  if (args.tabId == null) return { ok: false, error: 'close_page 缺少 tabId 参数' };
  try {
    await browser.tabs.remove(args.tabId);
    return { ok: true, data: { closed: args.tabId } };
  } catch (err) {
    return { ok: false, error: `close_page 失败：${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function doSelectPage(args: { tabId: number }): Promise<ToolResult> {
  if (args.tabId == null) return { ok: false, error: 'select_page 缺少 tabId 参数' };
  try {
    const tab = await browser.tabs.update(args.tabId, { active: true });
    return { ok: true, data: { targetTab: args.tabId, url: tab?.url ?? '' } };
  } catch (err) {
    return { ok: false, error: `select_page 失败：${err instanceof Error ? err.message : String(err)}` };
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/agent/tools/tabs.test.ts`
Expected: 6 passed。

- [ ] **Step 5: Commit**

```bash
git add agent/tools/tabs.ts tests/agent/tools/tabs.test.ts
git commit -m "feat: 标签页工具执行器（list/new/close/select + targetTab 带出）"
```

---

### Task 3: 截图工具执行器（`agent/tools/screenshot.ts`）

capture 前先激活目标标签（captureVisibleTab 只截当前窗口可见标签）；压缩函数 `compressDataUrl` 抽出，jsdom 下走 mock。读 `settings.agent.screenshotPolicy`，`never` 时禁用。

**Files:**
- Create: `agent/tools/screenshot.ts`
- Test: `tests/agent/tools/screenshot.test.ts`

- [ ] **Step 1: 写失败测试 `tests/agent/tools/screenshot.test.ts`**

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/browser';
import * as screenshot from '../../../agent/tools/screenshot';
import { saveSettings } from '../../../storage/settings';

describe('截图工具', () => {
  beforeEach(async () => {
    fakeBrowser.reset();
    await saveSettings({ agent: { screenshotPolicy: 'on-demand', confirmGate: true } });
    // 压缩走 mock（jsdom 无 OffscreenCanvas）
    vi.spyOn(screenshot, 'compressDataUrl').mockResolvedValue({ dataUrl: 'data:image/jpeg;base64,ZZZ', width: 800, height: 600 });
  });

  it('捕获成功返回压缩后截图', async () => {
    fakeBrowser.tabs.get = vi.fn().mockResolvedValue({ id: 1, windowId: 10, active: true }) as never;
    fakeBrowser.tabs.captureVisibleTab = vi.fn().mockResolvedValue('data:image/jpeg;base64,RAW') as never;
    const r = await screenshot.doScreenshot(1, {});
    expect(r.ok).toBe(true);
    expect((r as { data: { screenshot: string } }).data.screenshot).toBe('data:image/jpeg;base64,ZZZ');
  });

  it('目标标签非 active 时先激活', async () => {
    fakeBrowser.tabs.get = vi.fn().mockResolvedValue({ id: 2, windowId: 10, active: false }) as never;
    const update = vi.fn().mockResolvedValue({ id: 2 });
    fakeBrowser.tabs.update = update as never;
    fakeBrowser.tabs.captureVisibleTab = vi.fn().mockResolvedValue('data:image/jpeg;base64,RAW') as never;
    await screenshot.doScreenshot(2, {});
    expect(update).toHaveBeenCalledWith(2, { active: true });
  });

  it('screenshotPolicy=never 时禁用', async () => {
    await saveSettings({ agent: { screenshotPolicy: 'never', confirmGate: true } });
    const r = await screenshot.doScreenshot(1, {});
    expect(r.ok).toBe(false);
    expect(r.error).toContain('设置');
  });

  it('captureVisibleTab 抛错时返回失败', async () => {
    fakeBrowser.tabs.get = vi.fn().mockResolvedValue({ id: 1, windowId: 10, active: true }) as never;
    fakeBrowser.tabs.captureVisibleTab = vi.fn().mockRejectedValue(new Error('cannot capture')) as never;
    const r = await screenshot.doScreenshot(1, {});
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/agent/tools/screenshot.test.ts`
Expected: FAIL — module not found。

- [ ] **Step 3: 写 `agent/tools/screenshot.ts`**

```ts
// agent/tools/screenshot.ts
// 截图工具（设计 §5）：激活目标标签 → captureVisibleTab → 降采样压缩。
// compressDataUrl 抽为独立导出以便单测 mock（jsdom 无 OffscreenCanvas）。
import type { ToolResult } from '../../shared/types';
import { getSettings } from '../../storage/settings';

export interface Compressed { dataUrl: string; width: number; height: number }

/** 降采样到长边 <= maxEdge，重编码为 jpeg。真实运行时用 OffscreenCanvas。 */
export async function compressDataUrl(
  dataUrl: string,
  opts: { maxEdge?: number; quality?: number } = {},
): Promise<Compressed> {
  const maxEdge = opts.maxEdge ?? 1024;
  const quality = opts.quality ?? 0.7;
  const resp = await fetch(dataUrl);
  const blob = await resp.blob();
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0, width, height);
  const out = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  const buf = await out.arrayBuffer();
  const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
  return { dataUrl: `data:image/jpeg;base64,${b64}`, width, height };
}

export async function doScreenshot(
  tabId: number,
  args: { format?: 'jpeg' | 'png'; quality?: number },
): Promise<ToolResult> {
  const { agent } = await getSettings();
  if (agent.screenshotPolicy === 'never') {
    return { ok: false, error: '截图已按设置禁用（settings.agent.screenshotPolicy=never）' };
  }
  try {
    const tab = await browser.tabs.get(tabId);
    if (!tab.active) await browser.tabs.update(tabId, { active: true });
    const raw = await browser.tabs.captureVisibleTab(tab.windowId!, { format: 'jpeg', quality: 90 });
    const compressed = await compressDataUrl(raw, { quality: args.quality ?? 0.7 });
    return { ok: true, data: { screenshot: compressed.dataUrl, width: compressed.width, height: compressed.height } };
  } catch (err) {
    return { ok: false, error: `take_screenshot 失败：${err instanceof Error ? err.message : String(err)}` };
  }
}
```

> 注：测试用 `vi.spyOn(screenshot, 'compressDataUrl')`，故 `doScreenshot` 内必须通过模块内引用调用（同模块内直接调用 `compressDataUrl` 在 vitest 下 spy 生效，因 ESM 命名空间引用）。若 spy 不生效，改为 `import * as self from './screenshot'; self.compressDataUrl(...)`。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/agent/tools/screenshot.test.ts`
Expected: 4 passed。

- [ ] **Step 5: Commit**

```bash
git add agent/tools/screenshot.ts tests/agent/tools/screenshot.test.ts
git commit -m "feat: 截图工具（激活目标标签 + captureVisibleTab + 降采样压缩 + policy 门）"
```

---

### Task 4: HTTP 请求工具（`agent/tools/http.ts`）

background `fetch(credentials:'include')`；响应头只回白名单子集；body 按 content-type 判文本，截断 64KB。

**Files:**
- Create: `agent/tools/http.ts`
- Test: `tests/agent/tools/http.test.ts`

- [ ] **Step 1: 写失败测试 `tests/agent/tools/http.test.ts`**

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { doHttpRequest } from '../../../agent/tools/http';

function mockFetch(status: number, headers: Record<string, string>, body: string) {
  return vi.fn().mockResolvedValue({
    status,
    statusText: status === 200 ? 'OK' : 'ERR',
    headers: new Headers(headers),
    text: () => Promise.resolve(body),
  });
}

afterEach(() => vi.restoreAllMocks());

describe('http_request', () => {
  it('GET 成功返回 status/headers 子集/body', async () => {
    vi.stubGlobal('fetch', mockFetch(200, { 'content-type': 'application/json', 'set-cookie': 'x=1' }, '{"a":1}'));
    const r = await doHttpRequest({ url: 'https://api.x.com/d' });
    expect(r.ok).toBe(true);
    const d = (r as { data: { status: number; headers: Record<string, string>; body: string } }).data;
    expect(d.status).toBe(200);
    expect(d.headers['content-type']).toBe('application/json');
    expect(d.headers['set-cookie']).toBeUndefined(); // 非白名单不回
    expect(d.body).toContain('"a":1');
  });

  it('带凭证发送', async () => {
    const f = mockFetch(200, { 'content-type': 'text/plain' }, 'ok');
    vi.stubGlobal('fetch', f);
    await doHttpRequest({ url: 'https://x.com', method: 'POST', body: 'hi', headers: { 'X-T': '1' } });
    const opts = f.mock.calls[0]![1] as { credentials: string; method: string };
    expect(opts.credentials).toBe('include');
    expect(opts.method).toBe('POST');
  });

  it('body 超 64KB 截断标注', async () => {
    const big = 'x'.repeat(70_000);
    vi.stubGlobal('fetch', mockFetch(200, { 'content-type': 'text/plain' }, big));
    const r = await doHttpRequest({ url: 'https://x.com' });
    const d = (r as { data: { body: string; truncated?: boolean } }).data;
    expect(d.body.length).toBeLessThanOrEqual(65_536 + 50);
    expect(d.truncated).toBe(true);
  });

  it('非文本 content-type 省略 body', async () => {
    vi.stubGlobal('fetch', mockFetch(200, { 'content-type': 'image/png' }, 'binarygarbage'));
    const r = await doHttpRequest({ url: 'https://x.com/img.png' });
    const d = (r as { data: { body: string } }).data;
    expect(d.body).toContain('非文本');
  });

  it('url 缺失报错', async () => {
    const r = await doHttpRequest({ url: '' });
    expect(r.ok).toBe(false);
  });

  it('网络错误返回失败', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const r = await doHttpRequest({ url: 'https://x.com' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('ECONNREFUSED');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/agent/tools/http.test.ts`
Expected: FAIL — module not found。

- [ ] **Step 3: 写 `agent/tools/http.ts`**

```ts
// agent/tools/http.ts
// http_request 工具（设计 §6、§7）：background fetch，带 same-origin cookie（credentials:'include'）。
// 响应头只回白名单子集；body 按 content-type 判文本，截断 64KB。
// 已知风险：带凭证 + 无门控（设计 §7），后续 Phase 补门控闭合。
import type { ToolResult } from '../../shared/types';

const MAX_BODY = 64 * 1024;
const HEADER_ALLOW = new Set(['content-type', 'content-length', 'server', 'date', 'cache-control', 'last-modified', 'etag']);
const TEXT_CT = /(text\/|application\/(json|xml|javascript|x-www-form-urlencoded)|\+json|\+xml)/i;

export async function doHttpRequest(args: {
  url: string; method?: string; headers?: Record<string, string>; body?: string;
}): Promise<ToolResult> {
  if (!args.url) return { ok: false, error: 'http_request 缺少 url 参数' };
  try {
    const resp = await fetch(args.url, {
      method: args.method ?? 'GET',
      headers: args.headers,
      body: args.body,
      credentials: 'include',
    });
    const headers: Record<string, string> = {};
    resp.headers.forEach((v, k) => { if (HEADER_ALLOW.has(k.toLowerCase())) headers[k.toLowerCase()] = v; });
    const ct = resp.headers.get('content-type') ?? '';
    let body: string;
    let truncated = false;
    if (TEXT_CT.test(ct) || ct === '') {
      const text = await resp.text();
      if (text.length > MAX_BODY) { body = text.slice(0, MAX_BODY); truncated = true; }
      else body = text;
    } else {
      body = `[非文本响应体已省略，content-type=${ct}]`;
    }
    return { ok: true, data: { status: resp.status, statusText: resp.statusText, headers, body, ...(truncated ? { truncated } : {}) } };
  } catch (err) {
    return { ok: false, error: `http_request 失败：${err instanceof Error ? err.message : String(err)}` };
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/agent/tools/http.test.ts`
Expected: 6 passed。

- [ ] **Step 5: Commit**

```bash
git add agent/tools/http.ts tests/agent/tools/http.test.ts
git commit -m "feat: http_request 工具（带凭证 fetch + 响应头白名单 + body 截断 64KB）"
```

---

### Task 5: 脚本求值工具（`agent/tools/evaluate.ts`）

`scripting.executeScript({ world, func, args })`：`func` 是固定包裹器（在目标页 eval 模型传入的 function 字符串并 await 结果），包裹器返回 `{__ok,__value}` / `{__ok:false,__error}`。我方 `Promise.race` 加超时；对 `__value` 做 JSON 序列化校验。

**Files:**
- Create: `agent/tools/evaluate.ts`
- Test: `tests/agent/tools/evaluate.test.ts`

- [ ] **Step 1: 写失败测试 `tests/agent/tools/evaluate.test.ts`**

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/browser';
import { doEvaluate } from '../../../agent/tools/evaluate';

describe('evaluate_script', () => {
  beforeEach(() => fakeBrowser.reset());

  it('返回包裹器求值结果', async () => {
    fakeBrowser.scripting.executeScript = vi.fn().mockResolvedValue([
      { result: { __ok: true, __value: 42 } },
    ]) as never;
    const r = await doEvaluate(1, { function: '() => 42' });
    expect(r.ok).toBe(true);
    expect((r as { data: { result: unknown } }).data.result).toBe(42);
  });

  it('world 参数映射到 MAIN/ISOLATED', async () => {
    const exec = vi.fn().mockResolvedValue([{ result: { __ok: true, __value: 'x' } }]);
    fakeBrowser.scripting.executeScript = exec as never;
    await doEvaluate(1, { function: '() => "x"', world: 'isolated' });
    expect(exec.mock.calls[0]![0].world).toBe('ISOLATED');
    await doEvaluate(1, { function: '() => "x"' });
    expect(exec.mock.calls[1]![0].world).toBe('MAIN');
  });

  it('页面内抛异常 → 失败', async () => {
    fakeBrowser.scripting.executeScript = vi.fn().mockResolvedValue([
      { result: { __ok: false, __error: 'ReferenceError: foo is not defined' } },
    ]) as never;
    const r = await doEvaluate(1, { function: '() => foo' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('ReferenceError');
  });

  it('结果不可序列化 → 失败并提示', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    fakeBrowser.scripting.executeScript = vi.fn().mockResolvedValue([
      { result: { __ok: true, __value: circular } },
    ]) as never;
    const r = await doEvaluate(1, { function: '() => window' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('序列化');
  });

  it('超时返回失败', async () => {
    fakeBrowser.scripting.executeScript = vi.fn().mockImplementation(
      () => new Promise((res) => setTimeout(() => res([{ result: { __ok: true, __value: 1 } }]), 200)),
    ) as never;
    const r = await doEvaluate(1, { function: '() => 1', timeoutMs: 50 });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('超时');
  });

  it('executeScript 本身抛错（如受限页）→ 失败', async () => {
    fakeBrowser.scripting.executeScript = vi.fn().mockRejectedValue(new Error('Cannot access contents')) as never;
    const r = await doEvaluate(1, { function: '() => 1' });
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/agent/tools/evaluate.test.ts`
Expected: FAIL — module not found。

- [ ] **Step 3: 写 `agent/tools/evaluate.ts`**

```ts
// agent/tools/evaluate.ts
// evaluate_script 工具（设计 §6）：scripting.executeScript 注入固定包裹器，
// 在目标页 eval 模型传入的 function 字符串并 await 结果。结果须可 JSON 序列化。
import type { ToolResult } from '../../shared/types';

/** 在目标页运行的包裹器：eval 模型代码字符串 → 调用 → await → 归一化结果。 */
async function pageRunner(code: string, args: unknown[]): Promise<{ __ok: true; __value: unknown } | { __ok: false; __error: string }> {
  try {
    // eslint-disable-next-line no-eval
    const fn = (0, eval)(`(${code})`);
    const value = typeof fn === 'function' ? await fn(...args) : fn;
    return { __ok: true, __value: value };
  } catch (e) {
    return { __ok: false, __error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
  }
}

export async function doEvaluate(
  tabId: number,
  args: { function: string; args?: unknown[]; world?: 'main' | 'isolated'; timeoutMs?: number },
): Promise<ToolResult> {
  if (!args.function) return { ok: false, error: 'evaluate_script 缺少 function 参数' };
  const world = args.world === 'isolated' ? 'ISOLATED' : 'MAIN';
  const timeoutMs = args.timeoutMs ?? 5000;

  const exec = browser.scripting.executeScript({
    target: { tabId },
    world,
    func: pageRunner,
    args: [args.function, args.args ?? []],
  }) as Promise<Array<{ result?: { __ok: boolean; __value?: unknown; __error?: string } }>>;

  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<'__timeout'>((res) => { timer = setTimeout(() => res('__timeout'), timeoutMs); });

  try {
    const raced = await Promise.race([exec, timeout]);
    if (raced === '__timeout') return { ok: false, error: `evaluate_script 超时（${timeoutMs}ms）` };
    const wrapped = raced[0]?.result;
    if (!wrapped) return { ok: false, error: 'evaluate_script 无返回（页面可能已卸载）' };
    if (!wrapped.__ok) return { ok: false, error: `页面执行出错：${wrapped.__error ?? '未知'}` };
    try {
      JSON.stringify(wrapped.__value);
    } catch {
      return { ok: false, error: '结果无法 JSON 序列化，请让脚本返回标量/纯对象（如取 .textContent 而非 DOM 节点）' };
    }
    return { ok: true, data: { result: wrapped.__value } };
  } catch (err) {
    return { ok: false, error: `evaluate_script 失败：${err instanceof Error ? err.message : String(err)}` };
  } finally {
    clearTimeout(timer!);
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/agent/tools/evaluate.test.ts`
Expected: 6 passed。

- [ ] **Step 5: Commit**

```bash
git add agent/tools/evaluate.ts tests/agent/tools/evaluate.test.ts
git commit -m "feat: evaluate_script 工具（executeScript 包裹器 + 超时 + 序列化校验）"
```

---

### Task 6: registry 分发扩展 + 受限页预检收窄（`agent/tools/registry.ts`）

新增 chrome-API 工具分发。受限页预检**只适用 take_screenshot / evaluate_script + 现有 cs 工具**；tabs 四工具、http_request 豁免（在 tabs.get/预检之前处理）。

**Files:**
- Modify: `agent/tools/registry.ts`
- Test: `tests/agent/tools/registry.test.ts`

- [ ] **Step 1: 追加失败测试到 `tests/agent/tools/registry.test.ts`**

```ts
  it('list_pages 豁免受限页预检（chrome:// 也能列表）', async () => {
    fakeBrowser.tabs.get = vi.fn().mockResolvedValue({ id: 1, url: 'chrome://extensions' }) as never;
    fakeBrowser.tabs.query = vi.fn().mockResolvedValue([{ id: 1, url: 'chrome://x', title: 'x', active: true }]) as never;
    const r = await executeTool('list_pages', {}, { tabId: 1, sessionId: 's', signal: new AbortController().signal });
    expect(r.ok).toBe(true);
  });

  it('http_request 豁免受限页预检', async () => {
    fakeBrowser.tabs.get = vi.fn().mockResolvedValue({ id: 1, url: 'chrome://extensions' }) as never;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200, statusText: 'OK', headers: new Headers({ 'content-type': 'text/plain' }), text: () => Promise.resolve('ok') }));
    const r = await executeTool('http_request', { url: 'https://api.x.com' }, { tabId: 1, sessionId: 's', signal: new AbortController().signal });
    expect(r.ok).toBe(true);
    vi.unstubAllGlobals();
  });

  it('take_screenshot 受限页被阻断', async () => {
    fakeBrowser.tabs.get = vi.fn().mockResolvedValue({ id: 1, url: 'chrome://extensions' }) as never;
    const r = await executeTool('take_screenshot', {}, { tabId: 1, sessionId: 's', signal: new AbortController().signal });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('受限');
  });

  it('evaluate_script 受限页被阻断', async () => {
    fakeBrowser.tabs.get = vi.fn().mockResolvedValue({ id: 1, url: 'chrome://extensions' }) as never;
    const r = await executeTool('evaluate_script', { function: '() => 1' }, { tabId: 1, sessionId: 's', signal: new AbortController().signal });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('受限');
  });

  it('new_page 透传 waitForReady', async () => {
    fakeBrowser.tabs.create = vi.fn().mockResolvedValue({ id: 88, url: 'https://x.com' }) as never;
    const waitForReady = vi.fn().mockResolvedValue(undefined);
    const r = await executeTool('new_page', { url: 'https://x.com' }, { tabId: 1, sessionId: 's', signal: new AbortController().signal, waitForReady });
    expect(r.ok).toBe(true);
    expect(waitForReady).toHaveBeenCalledWith(88);
  });
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/agent/tools/registry.test.ts`
Expected: FAIL — executeTool 尚未分发新工具。

- [ ] **Step 3: 修改 `agent/tools/registry.ts`**

顶部新增 import：

```ts
import { doListPages, doNewPage, doClosePage, doSelectPage } from './tabs';
import { doScreenshot } from './screenshot';
import { doEvaluate } from './evaluate';
import { doHttpRequest } from './http';
```

把 `executeTool` 函数体改为（在 navigate_page 特判之后、tabs.get 之前插入豁免类工具分发；tabs.get/受限预检之后加 screenshot/evaluate 分发）：

```ts
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolCtx,
): Promise<ToolResult> {
  // ---- 豁免受限页预检的工具（不碰当前页内容 / background 独立发起）----
  if (name === 'navigate_page') return navigate(ctx, args as { type: string; url?: string });
  if (name === 'http_request') return doHttpRequest(args as { url: string; method?: string; headers?: Record<string, string>; body?: string });
  if (name === 'list_pages') return doListPages(ctx.tabId);
  if (name === 'new_page') return doNewPage(args as { url: string; background?: boolean }, ctx.waitForReady);
  if (name === 'close_page') return doClosePage(args as { tabId: number });
  if (name === 'select_page') return doSelectPage(args as { tabId: number });

  // ---- 以下工具操作当前目标页，需受限页预检 ----
  const tab = await browser.tabs.get(ctx.tabId).catch(() => undefined);
  const url = tab?.url ?? '';
  if (RESTRICTED.test(url)) {
    return { ok: false, error: `无法操作受限页面（${url}）` };
  }

  if (name === 'take_screenshot') return doScreenshot(ctx.tabId, args as { format?: 'jpeg' | 'png'; quality?: number });
  if (name === 'evaluate_script') return doEvaluate(ctx.tabId, args as { function: string; args?: unknown[]; world?: 'main' | 'isolated'; timeoutMs?: number });

  const csType = CS_TOOL_MAP[name];
  if (!csType) return { ok: false, error: `未知工具：${name}` };
  // ...（下方 sendMessage + 动态注入兜底逻辑原样保留）
}
```

> `navigate`、`injectContentScript`、`CS_TOOL_MAP`、`RESTRICTED` 保持不变。只重排了预检位置并插入新分发分支。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/agent/tools/registry.test.ts`
Expected: 全部 passed（含 Phase 2 原有用例）。

- [ ] **Step 5: 编译**

Run: `npm run compile`
Expected: 退出码 0。

- [ ] **Step 6: Commit**

```bash
git add agent/tools/registry.ts tests/agent/tools/registry.test.ts
git commit -m "feat: registry 分发 7 个 chrome-API 工具 + 受限页预检收窄（tabs/http 豁免）"
```

---

### Task 7: loop targetTab 状态机 + 截图注入（`agent/loop.ts`）

`LoopDeps.executeTool` 加 `tabId` 参数；`drive` 持有 `targetTab`；new/select/close 后更新；take_screenshot 成功后注入 `role:user` 图片消息并 emit 带缩略图的 tool-end。

**Files:**
- Modify: `agent/loop.ts`
- Test: `tests/agent/loop.test.ts`

- [ ] **Step 1: 追加失败测试到 `tests/agent/loop.test.ts`**

先把测试文件里的 `deps` 工厂的 `executeTool` mock 类型自动跟随（`vi.fn<LoopDeps['executeTool']>()` 无需手改）。新增用例：

```ts
  it('new_page 后 targetTab 更新，后续工具作用于新标签', async () => {
    const provider = queuedProvider([
      [{ type: 'tool-call-delta', index: 0, id: 'c1', name: 'new_page', argsDelta: '{"url":"https://n.com"}' }, { type: 'message-done', finishReason: 'tool_calls' }],
      [{ type: 'tool-call-delta', index: 0, id: 'c2', name: 'take_snapshot', argsDelta: '{}' }, { type: 'message-done', finishReason: 'tool_calls' }],
      [{ type: 'text-delta', text: '完成' }, { type: 'message-done', finishReason: 'stop' }],
    ]);
    const calls: number[] = [];
    const exec = vi.fn<LoopDeps['executeTool']>().mockImplementation(async (name, _args, tabId) => {
      calls.push(tabId);
      if (name === 'new_page') return { ok: true, data: { targetTab: 555, url: 'https://n.com' } };
      return { ok: true, data: { text: 'snap' } };
    });
    await runAgentLoop({ tabId: 10, sessionId: 's', userMessage: 'x' }, deps(provider, exec));
    expect(calls[0]).toBe(10);   // new_page 用启动标签
    expect(calls[1]).toBe(555);  // take_snapshot 用新目标
  });

  it('close_page 关掉 targetTab 后回落启动标签', async () => {
    const provider = queuedProvider([
      [{ type: 'tool-call-delta', index: 0, id: 'c1', name: 'select_page', argsDelta: '{"tabId":777}' }, { type: 'message-done', finishReason: 'tool_calls' }],
      [{ type: 'tool-call-delta', index: 0, id: 'c2', name: 'close_page', argsDelta: '{"tabId":777}' }, { type: 'message-done', finishReason: 'tool_calls' }],
      [{ type: 'tool-call-delta', index: 0, id: 'c3', name: 'take_snapshot', argsDelta: '{}' }, { type: 'message-done', finishReason: 'tool_calls' }],
      [{ type: 'text-delta', text: 'ok' }, { type: 'message-done', finishReason: 'stop' }],
    ]);
    const calls: number[] = [];
    const exec = vi.fn<LoopDeps['executeTool']>().mockImplementation(async (name, _args, tabId) => {
      calls.push(tabId);
      if (name === 'select_page') return { ok: true, data: { targetTab: 777, url: 'https://s.com' } };
      if (name === 'close_page') return { ok: true, data: { closed: 777 } };
      return { ok: true, data: { text: 'snap' } };
    });
    await runAgentLoop({ tabId: 20, sessionId: 's', userMessage: 'x' }, deps(provider, exec));
    expect(calls[2]).toBe(20); // close 掉 777 后，take_snapshot 回落启动标签 20
  });

  it('take_screenshot 成功后注入 user 图片消息 + emit 带缩略图', async () => {
    const provider = queuedProvider([
      [{ type: 'tool-call-delta', index: 0, id: 'c1', name: 'take_screenshot', argsDelta: '{}' }, { type: 'message-done', finishReason: 'tool_calls' }],
      [{ type: 'text-delta', text: '看到了' }, { type: 'message-done', finishReason: 'stop' }],
    ]);
    const exec = vi.fn<LoopDeps['executeTool']>().mockResolvedValue({ ok: true, data: { screenshot: 'data:image/jpeg;base64,ZZZ' } });
    const d = deps(provider, exec);
    await runAgentLoop({ tabId: 30, sessionId: 's', userMessage: 'x' }, d);
    const session = await getSession(30);
    const userImg = session.messages.find((m) => m.role === 'user' && Array.isArray(m.content));
    expect(userImg).toBeDefined();
    const parts = userImg!.content as Array<{ type: string; imageUrl?: string }>;
    expect(parts.some((p) => p.type === 'image_url' && p.imageUrl === 'data:image/jpeg;base64,ZZZ')).toBe(true);
    expect(d.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'tool-end', image: 'data:image/jpeg;base64,ZZZ' }));
  });
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/agent/loop.test.ts`
Expected: FAIL — targetTab/注入未实现。

- [ ] **Step 3: 修改 `agent/loop.ts` —— 接口签名**

`LoopDeps.executeTool` 加 `tabId`：

```ts
export interface LoopDeps {
  provider: Provider;
  executeTool: (name: string, args: Record<string, unknown>, tabId: number, signal: AbortSignal) => Promise<ToolResult>;
  getPageInfo: (tabId: number) => Promise<PageInfo>;
  emit: (msg: PortMsgToPanel) => void;
}
```

`ContentPart` 引入（用于图片消息）：

```ts
import type { Provider, ChatMessage, ToolCall, Usage, ContentPart } from './provider/types';
```

- [ ] **Step 4: 修改 `agent/loop.ts` —— drive 持有 targetTab**

`drive` 的首参改名 `startTabId`，内部初始化 `targetTab`；`getPageInfo`、`executeTool`、`appendMessage`（会话仍 keyed startTabId）分别用对应 tab：

```ts
async function drive(startTabId: number, deps: LoopDeps, guardState: GuardState): Promise<void> {
  const ac = new AbortController();
  let guard = guardState;
  let targetTab = startTabId;

  for (;;) {
    if (ac.signal.aborted) { await setStatus(startTabId, 'idle'); return; }

    const session = await getSession(startTabId);
    const page = await deps.getPageInfo(targetTab).catch(() => ({ url: '', title: '' }));
    const messages = buildContext(session.messages, page);
    // ...（runTurn 调用不变；下方 append/emit 里的 tabId 全部用 startTabId 存储、targetTab 执行）
```

> 把原函数体内所有 `tabId`（存储/状态）替换为 `startTabId`；`runAgentLoop`/`resumeAgentLoop` 调用 `drive(args.tabId, ...)` / `drive(tabId, ...)` 不变（形参名变了而已）。

- [ ] **Step 5: 修改 `agent/loop.ts` —— 工具执行循环（targetTab 透传 + 更新 + 截图注入）**

把执行工具的 for 循环体替换为：

```ts
    await appendMessage(startTabId, assistantMsg(result.text, result.toolCalls, result.reasoning));
    const results: ToolResult[] = [];
    for (const tc of result.toolCalls) {
      if (ac.signal.aborted) { await setStatus(startTabId, 'idle'); return; }
      let toolArgs: Record<string, unknown> = {};
      try { toolArgs = tc.arguments ? JSON.parse(tc.arguments) : {}; } catch { /* 保持空对象 */ }
      deps.emit({ type: 'tool-start', name: tc.name, args: tc.arguments, callId: tc.id });
      const r = await deps.executeTool(tc.name, toolArgs, targetTab, ac.signal);
      results.push(r);

      // targetTab 更新（设计 §4）
      if (r.ok && (tc.name === 'new_page' || tc.name === 'select_page')) {
        const d = r.data as { targetTab?: number } | undefined;
        if (typeof d?.targetTab === 'number') targetTab = d.targetTab;
      }
      if (r.ok && tc.name === 'close_page') {
        const d = r.data as { closed?: number } | undefined;
        if (d?.closed === targetTab) targetTab = startTabId;
      }

      // 截图注入（设计 §5.2）：tool 消息占位 + 追加 user 图片消息
      if (tc.name === 'take_screenshot' && r.ok) {
        const shot = (r.data as { screenshot?: string } | undefined)?.screenshot;
        deps.emit({ type: 'tool-end', name: tc.name, callId: tc.id, ok: true, summary: '已截图', image: shot });
        await appendMessage(startTabId, { role: 'tool', toolCallId: tc.id, name: tc.name, content: '截图已捕获，见下一条消息' });
        if (shot) {
          const parts: ContentPart[] = [
            { type: 'text', text: '（take_screenshot 返回的页面截图）' },
            { type: 'image_url', imageUrl: shot },
          ];
          await appendMessage(startTabId, { role: 'user', content: parts });
        }
        continue;
      }

      const summary = r.ok ? '成功' : (r.error ?? '失败');
      const output = toToolContent(r);
      deps.emit({ type: 'tool-end', name: tc.name, callId: tc.id, ok: r.ok, summary, output });
      await appendMessage(startTabId, { role: 'tool', toolCallId: tc.id, name: tc.name, content: output });
    }
```

> length 守卫分支、熔断阀分支里的 `tabId` 同样改 `startTabId`。截图分支 `continue` 前不 append 常规 tool output（占位已写）。

- [ ] **Step 6: 运行确认通过**

Run: `npx vitest run tests/agent/loop.test.ts`
Expected: 全部 passed（含 Phase 2 原有用例）。

- [ ] **Step 7: Commit**

```bash
git add agent/loop.ts tests/agent/loop.test.ts
git commit -m "feat: loop targetTab 状态机（new/select/close 更新）+ 截图注入 user 图片消息"
```

---

### Task 8: 历史图片裁剪（`agent/context.ts`）

`buildContext` 组装后，只保留最近 KEEP_IMAGES=2 条含图片的消息的图片 part，更早的图片 part 替换为文本占位，防会话膨胀。

**Files:**
- Modify: `agent/context.ts`
- Test: `tests/agent/context.test.ts`

- [ ] **Step 1: 追加失败测试到 `tests/agent/context.test.ts`**

```ts
import type { ContentPart } from '../../agent/provider/types';

const img = (tag: string): ChatMessage => ({
  role: 'user',
  content: [{ type: 'text', text: tag }, { type: 'image_url', imageUrl: `data:img,${tag}` }] as ContentPart[],
});

describe('历史图片裁剪', () => {
  it('保留最近 2 条图片，更早的图片替换为文本占位', () => {
    const history = [img('a'), img('b'), img('c'), img('d')];
    const msgs = buildContext(history, { url: '', title: '' });
    const body = msgs.slice(1); // 去掉 system
    const hasImage = (m: ChatMessage) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url');
    const imgCount = body.filter(hasImage).length;
    expect(imgCount).toBe(2); // 只剩 c、d 带图
    // 最早的 a 图片被替换为占位文本
    const a = body[0]!;
    const aParts = a.content as ContentPart[];
    expect(aParts.some((p) => p.type === 'image_url')).toBe(false);
    expect(aParts.some((p) => p.type === 'text' && p.text.includes('历史截图'))).toBe(true);
  });

  it('图片数 <= 2 时不动', () => {
    const history = [img('a'), img('b')];
    const msgs = buildContext(history, { url: '', title: '' });
    const withImg = msgs.filter((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'));
    expect(withImg).toHaveLength(2);
  });
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/agent/context.test.ts`
Expected: FAIL — 图片未被裁剪。

- [ ] **Step 3: 修改 `agent/context.ts`**

新增 `ContentPart` import 与 `trimImageParts`，在 `buildContext` 里应用：

```ts
import type { ChatMessage, ContentPart } from './provider/types';

const KEEP_IMAGES = 2;

/** 只保留最近 keep 条含图片消息的图片 part，更早的原地替换为文本占位（防 base64 撑爆上下文）。 */
export function trimImageParts(messages: ChatMessage[], keep = KEEP_IMAGES): ChatMessage[] {
  const imageMsgIdx = messages
    .map((m, i) => (Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url') ? i : -1))
    .filter((i) => i >= 0);
  if (imageMsgIdx.length <= keep) return messages;
  const stripBefore = new Set(imageMsgIdx.slice(0, imageMsgIdx.length - keep));
  return messages.map((m, i) => {
    if (!stripBefore.has(i) || !Array.isArray(m.content)) return m;
    const parts: ContentPart[] = m.content.map((p) =>
      p.type === 'image_url' ? { type: 'text', text: '[历史截图已省略]' } : p,
    );
    return { ...m, content: parts };
  });
}
```

`buildContext` 末尾改为对 truncate 结果再过一遍 `trimImageParts`：

```ts
export function buildContext(history: ChatMessage[], page: PageInfo, keepRecent = 60): ChatMessage[] {
  const pageBlock = page.url
    ? `\n\n当前页面：\n- URL: ${page.url}\n- 标题: ${page.title}`
    : '';
  const system: ChatMessage = { role: 'system', content: SYSTEM_PROMPT + pageBlock };
  const trimmed = trimImageParts(truncateMessages(history, keepRecent));
  return [system, ...trimmed];
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/agent/context.test.ts`
Expected: 全部 passed（含 Phase 2 原有用例）。

- [ ] **Step 5: Commit**

```bash
git add agent/context.ts tests/agent/context.test.ts
git commit -m "feat: context 历史图片裁剪（保留最近 2 条，更早替换文本占位）"
```

---

### Task 9: 协议扩展 + agent-port 签名对齐（`shared/messages.ts` + `background/agent-port.ts`）

`PortMsgToPanel.tool-end` 加可选 `image?`；`makeDeps` 的 `executeTool` 对齐新的 4 参签名（透传 loop 传入的 targetTab）。

**Files:**
- Modify: `shared/messages.ts`
- Modify: `background/agent-port.ts`
- Test: `tests/shared/messages-phase3a.test.ts`（新建，类型可赋值回归）

- [ ] **Step 1: 写失败测试 `tests/shared/messages-phase3a.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import type { PortMsgToPanel } from '../../shared/messages';

describe('Phase 3a 协议扩展', () => {
  it('tool-end 可带 image 字段', () => {
    const m: PortMsgToPanel = { type: 'tool-end', name: 'take_screenshot', callId: 'c1', ok: true, summary: '已截图', image: 'data:image/jpeg;base64,X' };
    expect(m.type).toBe('tool-end');
    expect((m as { image?: string }).image).toBe('data:image/jpeg;base64,X');
  });

  it('tool-end 不带 image 仍合法', () => {
    const m: PortMsgToPanel = { type: 'tool-end', name: 'click', callId: 'c2', ok: false, summary: '失败' };
    expect(m.ok).toBe(false);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/shared/messages-phase3a.test.ts`
Expected: FAIL — `image` 不在类型上（TS 编译错误）。

- [ ] **Step 3: 修改 `shared/messages.ts`**

`PortMsgToPanel` 里 `tool-end` 分支加 `image?`：

```ts
  | { type: 'tool-end'; name: string; callId: string; ok: boolean; summary: string; output?: string; image?: string }
```

- [ ] **Step 4: 修改 `background/agent-port.ts` 的 `makeDeps`**

`executeTool` 从 3 参改 4 参，透传 loop 传入的 tabId 到 `ctx.tabId`：

```ts
function makeDeps(
  provider: Provider,
  port: Pick<Browser.runtime.Port, 'postMessage'>,
  startTabId: number,
): LoopDeps {
  return {
    provider,
    executeTool: (name, args, tabId, signal) =>
      executeTool(name, args, { tabId, sessionId: 'main', signal, waitForReady: (t) => waitForCsReady(t) }),
    getPageInfo,
    emit: (m: PortMsgToPanel) => {
      try {
        port.postMessage(m);
      } catch {
        /* port 已断开：loop 继续 */
      }
    },
  };
}
```

> `makeDeps` 第三参改名 `startTabId`（仅语义命名，调用处 `makeDeps(provider, port, msg.tabId)` 不变）；`executeTool` 不再闭包固定 tabId，改用 loop 每轮传入的 `tabId`（=targetTab）。`getPageInfo` 保持接收 tabId 参数不变（loop 会传 targetTab）。

- [ ] **Step 5: 运行确认通过 + 编译**

Run: `npx vitest run tests/shared/messages-phase3a.test.ts && npm run compile`
Expected: passed + 退出码 0（编译确认 loop/agent-port/debug-exec 签名全链路一致）。

- [ ] **Step 6: Commit**

```bash
git add shared/messages.ts background/agent-port.ts tests/shared/messages-phase3a.test.ts
git commit -m "feat: 协议 tool-end +image? + agent-port executeTool 4 参签名对齐（透传 targetTab）"
```

---

### Task 10: UI 截图缩略图（`stores/chat.ts` + `components/chat/ChatView.tsx`）

`ChatItem` 加 `image?`；`tool-end` 分支存 `e.image`；工具卡片展开时渲染缩略图。

**Files:**
- Modify: `stores/chat.ts`
- Modify: `components/chat/ChatView.tsx`
- Modify: `entrypoints/sidepanel/styles.css`
- Test: `tests/stores/chat.test.ts`

- [ ] **Step 1: 追加失败测试到 `tests/stores/chat.test.ts`**

```ts
  it('tool-end 带 image 时存进卡片', () => {
    useChat.getState().applyEvent({ type: 'tool-start', name: 'take_screenshot', args: '{}', callId: 'c1' });
    useChat.getState().applyEvent({ type: 'tool-end', name: 'take_screenshot', callId: 'c1', ok: true, summary: '已截图', image: 'data:image/jpeg;base64,ZZZ' });
    const card = useChat.getState().messages.find((m) => m.role === 'tool' && m.callId === 'c1');
    expect(card).toMatchObject({ status: 'done', image: 'data:image/jpeg;base64,ZZZ' });
  });
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/stores/chat.test.ts`
Expected: FAIL — `image` 不在 ChatItem。

- [ ] **Step 3: 修改 `stores/chat.ts`**

`ChatItem` 接口加字段：

```ts
  output?: string;           // 工具完整输出（供展开）
  image?: string;            // 截图缩略图 dataURL（take_screenshot）
```

`tool-end` 分支写入 `image`：

```ts
      case 'tool-end': {
        const idx = messages.findIndex((m) => m.role === 'tool' && m.callId === e.callId);
        if (idx >= 0) messages[idx] = { ...messages[idx]!, status: 'done', ok: e.ok, summary: e.summary, output: e.output, image: e.image };
        return { messages };
      }
```

- [ ] **Step 4: 修改 `components/chat/ChatView.tsx` 的工具卡片展开区**

在 `toolcard__detail` 里、OUTPUT 之后加截图渲染：

```tsx
          {item.image && (
            <>
              <span className="token">SCREENSHOT</span>
              <img className="toolcard__shot" src={item.image} alt="页面截图" />
            </>
          )}
```

- [ ] **Step 5: 在 `entrypoints/sidepanel/styles.css` 末尾加样式**

```css
.toolcard__shot {
  display: block;
  max-width: 100%;
  border: 1px solid var(--border);
  border-radius: 6px;
  margin-top: 4px;
}
```

- [ ] **Step 6: 运行确认通过 + 编译 + 构建**

Run: `npx vitest run tests/stores/chat.test.ts && npm run compile && npm run build`
Expected: passed + 两个退出码 0；`.output/chrome-mv3/` 生成。

- [ ] **Step 7: Commit**

```bash
git add stores/chat.ts components/chat/ChatView.tsx entrypoints/sidepanel/styles.css tests/stores/chat.test.ts
git commit -m "feat: 工具卡片渲染截图缩略图（tool-end.image → ChatItem → 展开区）"
```

---

### Task 11: Phase 3a 收尾验证

**Files:**
- Modify: `docs/superpowers/plans/2026-09-01-ai-browser-extension-phase3a.md`（勾选状态）
- Modify: `CLAUDE.md`（更新当前阶段描述）

- [ ] **Step 1: 全量编译 + 测试 + 构建**

Run: `npm run compile && npm test && npm run build`
Expected: 三项全部成功（tsc EXIT 0；vitest 全绿；build 产出 `.output/chrome-mv3/`）。

- [ ] **Step 2: 手动冒烟（加载扩展，需真实 Chrome + vision 模型）**

在 `chrome://extensions` 重新加载 `.output/chrome-mv3`，然后：

1. 设置页配好 vision 能力的模型（如 gpt-4o / qwen-vl 等）。
2. 普通网页输入「截图看看这个页面长什么样」→ 预期看到 `take_screenshot` 卡片带缩略图，AI 回复能描述视觉内容。
3. 输入「新开一个标签页打开 example.com 然后读取标题」→ 预期 `new_page` 后 `take_snapshot`/`evaluate_script` 作用于新标签，AI 报出 example 的标题。
4. 输入「用 evaluate_script 取页面所有链接数量」→ 预期返回数字。
5. 输入「用 http_request 请求 https://httpbin.org/get」→ 预期返回 status 200 + body 片段。
6. 在 `chrome://extensions` 输入「截图」→ 预期返回「无法操作受限页面」。

- [ ] **Step 3: 记录已知问题到本文件末尾「Phase 3b handoff」小节（若有）**

常见候选：某些站点 CSP 阻断 evaluate MAIN world、captureVisibleTab 在标签切换时序、大截图 token 消耗。

- [ ] **Step 4: 更新 `CLAUDE.md` 的「当前阶段」段**

把 Phase 3a 完成的能力（tabs/screenshot/evaluate/http_request）记入，标注 3b（console + 网络双通道）待做。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: Phase 3a 收尾验证 + 文档更新"
```

---

## Self-Review 记录

- **Spec 覆盖**：设计 §2 工具清单 → Task 1（schema）+ Task 2-5（执行器）+ Task 6（分发）；§3 文件改动 → 全 task 覆盖；§4 targetTab → Task 7 + Task 9（agent-port 签名）；§5 截图流 → Task 3（capture/压缩）+ Task 7（注入）+ Task 8（裁剪）+ Task 10（UI）；§6 返回契约 → Task 2-5 各执行器；§7 安全边界 → Task 6（受限页预检收窄）；§8 测试策略 → 每 task 内嵌；§9 给 3b 契约 → Task 6/7/9 冻结；§10 已知降级 → 实现中接受。全部有对应 task。
- **类型一致性**：`LoopDeps.executeTool` 新签名（+tabId）在 Task 7（定义/调用）、Task 9（agent-port 实现）、loop 测试 mock 三处一致；`ToolResult.data` 的 `targetTab`/`closed`/`screenshot`/`pages` 字段在执行器（Task 2/3）产出与 loop（Task 7）消费处字段名一致；`PortMsgToPanel.tool-end.image`（Task 9）在 loop emit（Task 7）、chat store（Task 10）三处一致；`ContentPart`（provider types 已有）在 loop 注入（Task 7）、context 裁剪（Task 8）用法一致；`registry.executeTool(name,args,ctx)` 签名不变，`debug-exec.ts` 不受影响（Task 9 编译验证兜底）。
- **占位符扫描**：无 TBD/TODO；每个代码步骤含完整代码。

## 给 Phase 3b 的接口契约（本轮冻结）

- `agent/tools/registry.ts`：chrome-API 分发表可继续扩展；受限页预检适用面已明确（操作页面的工具适用，独立发起的豁免）。3b 的 `list_console_messages` 属操作页面类 → 适用预检。
- `agent/loop.ts`：`LoopDeps.executeTool(name, args, tabId, signal)` 签名冻结；`targetTab` 对 3b 工具透明（console/网络工具也接收 targetTab）。
- `shared/messages.ts`：`CONSOLE_READ` 占位、`NETLOG_PUSH` 通知类型保留给 3b hook 通道。
- `entrypoints/content.ts`：`EVALUATE` 占位已废弃（evaluate 走 background scripting）；`CONSOLE_READ` 占位保留。
- 未变更点：provider wire 层（多模态已支持）、`storage/sessions.ts`（会话仍 keyed tabId）。

## Phase 3b handoff（待办，实现完成后填写）

- （手测发现的问题记这里）











