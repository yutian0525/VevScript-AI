# 通用确认卡组件 + 跨域确认 hub 页 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 @connect 跨域确认从「侧边栏内联卡」重构为「独立 hub 标签页 + 通用确认卡组件」，确认队列/协议/页面/组件四层全部去 @connect 化。

**Architecture:** 新建 `background/confirm-queue.ts` 通用确认队列（登记/广播/超时/解析，零副作用，返回决策 promise），`gm-api.ts` 的 @connect 作为生产者调用它并自行处理副作用。新建 `entrypoints/confirm/` hub 页（单页排队展示所有待确认项）+ `components/confirm/` 通用 `ConfirmCard`。彻底移除侧边栏内联卡及其 store/订阅。

**Tech Stack:** WXT + React 19 + TypeScript + Zustand（仅存量）+ vitest v4 + jsdom + @testing-library/react。消息走现有 `runtime.sendMessage` 广播 + `MessageRouter`。

**Spec:** `docs/superpowers/specs/2026-09-05-generic-confirm-card-and-hub-page-design.md`

---

## 文件结构

| 文件 | 责任 |
|------|------|
| `shared/confirm.ts` | 新增：`ConfirmRequest`/`ConfirmDetailRow`/`ConfirmAction`/`ConfirmKind` 数据模型 + 广播事件类型 |
| `background/confirm-queue.ts` | 新增：通用队列（`enqueueConfirm`/`resolveConfirm`/`getPending`/`initConfirmQueue`）+ hub 生命周期 |
| `entrypoints/confirm/index.html` | 新增：hub 页壳 |
| `entrypoints/confirm/main.tsx` | 新增：hub 页挂载 |
| `components/confirm/confirm-reducer.ts` | 新增：`applyConfirmEvent` 纯函数 reducer（可测） |
| `components/confirm/ConfirmCard.tsx` | 新增：通用展示卡（props 驱动，倒计时按钮） |
| `components/confirm/ConfirmHubApp.tsx` | 新增：页面容器（复水 + 订阅 + 渲染列表） |
| `shared/messages.ts` | 改：协议泛化（`CONFIRM_RESOLVE`/`CONFIRM_GET_STATE`/`CONFIRM_PENDING`/`CONFIRM_RESOLVED`） |
| `background/gm-api.ts` | 改：删队列五件套 + `doXmlHttpRequest` 改调 `enqueueConfirm` + 搬回副作用 + 去 state.confirms |
| `entrypoints/background.ts` | 改：注册 `initConfirmQueue(router)` |
| `stores/scripts.ts` | 改：删 `GmConfirmItem`/`confirms`/两个 apply/refresh 复水 |
| `components/scripts/ScriptsView.tsx` | 改：删两条 confirm 订阅分支 + import |
| `components/scripts/ScriptsListView.tsx` | 改：删内联卡渲染 + import + 解构 |
| `components/scripts/ScriptsConfirmCard.tsx` | 删除 |
| `components/popup/PopupApp.tsx` | 改：`SCRIPTS_GET_GM_STATE` 泛型去 confirms + import |
| `entrypoints/sidepanel/styles.css` | 改：加 `.confirm-hub`/`.confirm-card` 样式 |
| `tests/background/confirm-queue.test.ts` | 新增 |
| `tests/confirm/confirm-hub.test.tsx` | 新增 |
| `tests/background/gm-connect.test.ts` | 改：import 换源 + 断言泛化 |
| `tests/background/gm-api.test.ts` | 改：import 换源 + 去 confirms 断言 |

**关键工程约定（勿偏离）：**
- 单文件测试跑：`npx vitest run <path>`；全量：`npm run test`；类型检查：`npm run compile`；构建：`npm run build`。
- `MessageRouter.on(type, handler)` 注册；handler 返回值即 `sendResponse` 回给发送方。
- RTL 测试首行必须有 `// @vitest-environment jsdom`；后台/纯逻辑测试不加。
- 后台测试用 `fakeBrowser`（`wxt/testing/fake-browser`），`beforeEach(() => fakeBrowser.reset())`。
- 图标用 `lucide-react`，禁 emoji。样式禁硬编码色值，走 `:root` CSS 变量。

---

## Task 1：通用数据模型 `shared/confirm.ts`

**Files:**
- Create: `shared/confirm.ts`

- [ ] **Step 1: 写数据模型文件**

`shared/confirm.ts`：

```ts
// shared/confirm.ts
// 通用确认抽象（三环境共享）：队列只管登记/广播/超时/解析，不含任何副作用。
// 所有文案/明细/按钮由生产者填 props；kind 仅供生产者区分自己的请求来源，队列/页面对其无特殊逻辑。

export type ConfirmKind = 'connect'; // 将来扩展：| 'script-op' 等

export interface ConfirmDetailRow {
  label: string; // "主机" / "方法" / "URL" / "来源"
  value: string;
  mono?: boolean; // 机器语言（host/url/method）走等宽
}

export interface ConfirmAction {
  decision: string; // 回传给生产者的决策标识
  label: string; // "允许一次" / "总是允许" / "拒绝"
  variant?: 'primary' | 'danger' | 'default'; // 映射 .btn 变体
  countdown?: boolean; // 是否在按钮上跑本地倒计时
}

export interface ConfirmRequest {
  confirmId: string;
  kind: ConfirmKind;
  title: string; // "跨域请求确认"
  message: string; // "脚本「My Script」请求跨域访问"
  rows: ConfirmDetailRow[];
  actions: ConfirmAction[];
  createdAt: number;
  timeoutMs: number; // 60_000
}

/** enqueueConfirm 入参：队列生成 confirmId/createdAt，生产者不传。 */
export type ConfirmSpec = Omit<ConfirmRequest, 'confirmId' | 'createdAt'>;

// ---- bg → 页面广播（fire-and-forget）----
export interface ConfirmPendingEvent {
  type: 'CONFIRM_PENDING';
  confirm: ConfirmRequest;
}
export interface ConfirmResolvedEvent {
  type: 'CONFIRM_RESOLVED';
  confirmId: string;
}
```

- [ ] **Step 2: 类型检查**

Run: `npm run compile`
Expected: PASS（无 TS 错误；文件仅导出类型，无运行时依赖）

- [ ] **Step 3: Commit**

```bash
git add shared/confirm.ts
git commit -m "feat(confirm): 通用确认数据模型 shared/confirm.ts"
```

---

## Task 2：通用队列模块 `background/confirm-queue.ts`（TDD）

**Files:**
- Create: `background/confirm-queue.ts`
- Test: `tests/background/confirm-queue.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/background/confirm-queue.test.ts`：

```ts
// tests/background/confirm-queue.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { enqueueConfirm, resolveConfirm, getPending, initConfirmQueue, __resetConfirmQueue } from '../../background/confirm-queue';
import type { ConfirmSpec } from '../../shared/confirm';

function spec(over: Partial<ConfirmSpec> = {}): ConfirmSpec {
  return {
    kind: 'connect', title: 't', message: 'm', rows: [], timeoutMs: 60_000,
    actions: [{ decision: 'allow-once', label: 'A' }, { decision: 'deny', label: 'D' }],
    ...over,
  };
}

describe('confirm-queue', () => {
  beforeEach(() => { fakeBrowser.reset(); vi.restoreAllMocks(); __resetConfirmQueue(); vi.useRealTimers(); });

  it('enqueue：广播 CONFIRM_PENDING + getPending 出现 + 首个 pending 开 hub', async () => {
    const send = vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue(undefined as never);
    const create = vi.spyOn(browser.tabs, 'create').mockResolvedValue({ id: 100 } as never);
    void enqueueConfirm(spec());
    await new Promise((r) => setTimeout(r, 0));
    expect(getPending()).toHaveLength(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'CONFIRM_PENDING' }));
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ url: expect.stringContaining('confirm.html'), active: true }));
  });

  it('第二条 pending：不再 create，改 tabs.update 聚焦已开 hub', async () => {
    vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue(undefined as never);
    vi.spyOn(browser.tabs, 'create').mockResolvedValue({ id: 100 } as never);
    vi.spyOn(browser.tabs, 'get').mockResolvedValue({ id: 100 } as never);
    const update = vi.spyOn(browser.tabs, 'update').mockResolvedValue({} as never);
    void enqueueConfirm(spec());
    await new Promise((r) => setTimeout(r, 0));
    void enqueueConfirm(spec());
    await new Promise((r) => setTimeout(r, 0));
    expect(getPending()).toHaveLength(2);
    expect(update).toHaveBeenCalledWith(100, { active: true });
  });

  it('resolveConfirm：解析 promise 为该 decision + 广播 CONFIRM_RESOLVED + 出队', async () => {
    const send = vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue(undefined as never);
    vi.spyOn(browser.tabs, 'create').mockResolvedValue({ id: 100 } as never);
    const p = enqueueConfirm(spec());
    await new Promise((r) => setTimeout(r, 0));
    const id = getPending()[0]!.confirmId;
    resolveConfirm(id, 'allow-once');
    expect(await p).toBe('allow-once');
    expect(getPending()).toHaveLength(0);
    expect(send).toHaveBeenCalledWith({ type: 'CONFIRM_RESOLVED', confirmId: id });
  });

  it('超时：timeoutMs 到点 → 决策 __timeout__ + 出队', async () => {
    vi.useFakeTimers();
    vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue(undefined as never);
    vi.spyOn(browser.tabs, 'create').mockResolvedValue({ id: 100 } as never);
    const p = enqueueConfirm(spec({ timeoutMs: 1000 }));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await p).toBe('__timeout__');
    expect(getPending()).toHaveLength(0);
  });

  it('resolve 后清 timer：不会二次 resolve', async () => {
    vi.useFakeTimers();
    vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue(undefined as never);
    vi.spyOn(browser.tabs, 'create').mockResolvedValue({ id: 100 } as never);
    const p = enqueueConfirm(spec({ timeoutMs: 1000 }));
    await vi.advanceTimersByTimeAsync(0);
    const id = getPending()[0]!.confirmId;
    resolveConfirm(id, 'deny');
    await vi.advanceTimersByTimeAsync(2000);
    expect(await p).toBe('deny'); // 不被超时覆盖
  });

  it('关 hub tab：剩余全部 __closed__', async () => {
    vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue(undefined as never);
    vi.spyOn(browser.tabs, 'create').mockResolvedValue({ id: 100 } as never);
    vi.spyOn(browser.tabs, 'get').mockResolvedValue({ id: 100 } as never);
    vi.spyOn(browser.tabs, 'update').mockResolvedValue({} as never);
    initConfirmQueue({ on: () => {} });
    const p1 = enqueueConfirm(spec());
    await new Promise((r) => setTimeout(r, 0));
    const p2 = enqueueConfirm(spec());
    await new Promise((r) => setTimeout(r, 0));
    fakeBrowser.tabs.onRemoved.trigger(100, { windowId: 1, isWindowClosing: false });
    expect(await p1).toBe('__closed__');
    expect(await p2).toBe('__closed__');
    expect(getPending()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/background/confirm-queue.test.ts`
Expected: FAIL（`background/confirm-queue` 模块不存在）

- [ ] **Step 3: 写队列实现**

`background/confirm-queue.ts`：

```ts
// background/confirm-queue.ts
// 通用确认队列（spec §5）：登记/广播/超时/解析，零副作用。enqueueConfirm 返回决策 promise，
// 生产者拿到 decision 后自行处理副作用。单 hub 页排队展示所有待确认项。
import type { ConfirmRequest, ConfirmSpec } from '../shared/confirm';

interface Entry {
  req: ConfirmRequest;
  resolve: (decision: string) => void;
  timer: ReturnType<typeof setTimeout>;
}

// 内部哨兵 decision：生产者把「非自己认识的 decision」一律当 deny 处理。
const TIMEOUT = '__timeout__';
const CLOSED = '__closed__';

const pending = new Map<string, Entry>();
let hubTabId: number | null = null;

const HUB_URL = '/confirm.html';

function broadcast(msg: Record<string, unknown>): void {
  void browser.runtime.sendMessage(msg).catch(() => {});
}

/** hub 页复水快照。 */
export function getPending(): ConfirmRequest[] {
  return [...pending.values()].map((e) => e.req);
}

async function ensureHub(): Promise<void> {
  // 已记录 hubTabId：校验仍存活（用户可能已关但未触发监听）
  if (hubTabId != null) {
    const alive = await browser.tabs.get(hubTabId).then((t) => t?.id != null).catch(() => false);
    if (alive) {
      await browser.tabs.update(hubTabId, { active: true }).catch(() => {});
      return;
    }
    hubTabId = null;
  }
  const tab = await browser.tabs.create({ url: browser.runtime.getURL(HUB_URL), active: true }).catch(() => null);
  hubTabId = tab?.id ?? null;
}

/** 登记 + 广播 CONFIRM_PENDING + 开/聚焦 hub + 起超时。返回决策 promise。 */
export function enqueueConfirm(spec: ConfirmSpec): Promise<string> {
  return new Promise<string>((resolve) => {
    const confirmId = crypto.randomUUID();
    const req: ConfirmRequest = { ...spec, confirmId, createdAt: Date.now() };
    const timer = setTimeout(() => resolveConfirm(confirmId, TIMEOUT), spec.timeoutMs);
    pending.set(confirmId, { req, resolve, timer });
    broadcast({ type: 'CONFIRM_PENDING', confirm: req });
    void ensureHub();
  });
}

/** 解析 promise + 删表 + 清 timer + 广播 CONFIRM_RESOLVED。confirmId 不存在时空操作（幂等）。 */
export function resolveConfirm(confirmId: string, decision: string): void {
  const entry = pending.get(confirmId);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(confirmId);
  entry.resolve(decision);
  broadcast({ type: 'CONFIRM_RESOLVED', confirmId });
}

function onHubClosed(tabId: number): void {
  if (tabId !== hubTabId) return;
  hubTabId = null;
  for (const id of [...pending.keys()]) resolveConfirm(id, CLOSED);
}

interface RouterLike {
  on(type: string, handler: (msg: Record<string, unknown>) => unknown): void;
}

export function initConfirmQueue(router: RouterLike): void {
  router.on('CONFIRM_RESOLVE', async (msg) => {
    const { confirmId, decision } = msg as unknown as { confirmId: string; decision: string };
    resolveConfirm(confirmId, decision);
    return { ok: true };
  });
  router.on('CONFIRM_GET_STATE', async () => ({ ok: true, data: { confirms: getPending() } }));
  browser.tabs.onRemoved.addListener(onHubClosed);
}

/** 仅测试用：清空队列与 hub 记录（各用例互不污染）。 */
export function __resetConfirmQueue(): void {
  for (const e of pending.values()) clearTimeout(e.timer);
  pending.clear();
  hubTabId = null;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/background/confirm-queue.test.ts`
Expected: PASS（6 用例全绿）

- [ ] **Step 5: Commit**

```bash
git add background/confirm-queue.ts tests/background/confirm-queue.test.ts
git commit -m "feat(confirm): 通用确认队列 background/confirm-queue.ts + 单测"
```

---

## Task 3：消息协议泛化 `shared/messages.ts`

**Files:**
- Modify: `shared/messages.ts`

- [ ] **Step 1: 改 ScriptsRequest 联合**

在 `shared/messages.ts` 找到这一行并替换：

旧：
```ts
  | { type: 'GM_CONFIRM_RESOLVE'; confirmId: string; decision: 'allow-once' | 'always' | 'deny' }
```

新：
```ts
  | { type: 'CONFIRM_RESOLVE'; confirmId: string; decision: string }
  | { type: 'CONFIRM_GET_STATE' }
```

- [ ] **Step 2: 类型检查（预期报错，定位待改点）**

Run: `npm run compile`
Expected: FAIL —— `gm-api.ts`（`GM_CONFIRM_RESOLVE` handler）、`ScriptsConfirmCard.tsx`、`stores/scripts.ts`、`ScriptsView.tsx` 引用旧类型报错。这是预期的，后续任务逐个修掉。

> 注：`ConfirmPendingEvent`/`ConfirmResolvedEvent` 已在 `shared/confirm.ts` 定义，广播端直接从那里 import，不在 messages.ts 重复。

- [ ] **Step 3: Commit**

```bash
git add shared/messages.ts
git commit -m "refactor(confirm): 消息协议泛化 CONFIRM_RESOLVE/CONFIRM_GET_STATE"
```

---

## Task 4：`gm-api.ts` 生产者改造 + 队列收口

**Files:**
- Modify: `background/gm-api.ts`
- Modify: `tests/background/gm-connect.test.ts`
- Modify: `tests/background/gm-api.test.ts`

- [ ] **Step 1: 改 gm-connect.test.ts（import 换源 + 断言泛化）**

`tests/background/gm-connect.test.ts` 顶部 import 改为：

```ts
import { matchConnect, ConnectDecision, matchConnectWithPermissions, handleGmCall } from '../../background/gm-api';
import { resolveConfirm, getPending, __resetConfirmQueue } from '../../background/confirm-queue';
```

`beforeEach`（`GM_xmlhttpRequest 确认流` describe 内）改为同时重置队列：

```ts
  beforeEach(() => { fakeBrowser.reset(); vi.restoreAllMocks(); __resetConfirmQueue(); vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({} as never); vi.spyOn(browser.tabs, 'create').mockResolvedValue({ id: 100 } as never); });
```

三处 `getPendingConfirms()` 改成 `getPending()`；`confirms[0]` 的断言改为泛化形状（首个用例）：

旧：
```ts
    const confirms = getPendingConfirms();
    expect(confirms).toHaveLength(1);
    expect(confirms[0]).toMatchObject({ scriptId: 's1', host: 'c.com' });
    await resolveConfirm(confirms[0]!.confirmId, 'allow-once');
```
新：
```ts
    const confirms = getPending();
    expect(confirms).toHaveLength(1);
    expect(confirms[0]).toMatchObject({ kind: 'connect' });
    expect(confirms[0]!.rows).toEqual(expect.arrayContaining([
      { label: '主机', value: 'c.com', mono: true },
    ]));
    resolveConfirm(confirms[0]!.confirmId, 'allow-once');
```

第二个用例（always）：`getPendingConfirms()[0]` → `getPending()[0]`，`await resolveConfirm(...)` → `resolveConfirm(...)`。
第三个用例（deny）：同样两处替换。
第四个用例（列了不中直 DENY）：`getPendingConfirms()` → `getPending()`。

> `resolveConfirm` 现在是同步函数（不再 async），去掉 `await`；测试里保留 `await` 也无害（await 非 promise 立即 resolve），但按上文改掉更干净。

- [ ] **Step 2: 改 gm-api.ts（删队列五件套 + 生产者改造）**

在 `background/gm-api.ts`：

(a) 顶部 import 加：
```ts
import { enqueueConfirm } from './confirm-queue';
```

(b) 删除整段「确认队列」区块（`GmConfirm` 接口、`pendingConfirms`、`CONFIRM_TIMEOUT_MS`、`getPendingConfirms`、`queueConfirm`、`resolveConfirm`）。保留 `matchConnect`/`matchConnectWithPermissions`/`ConnectDecision`/`hostOf`。

(c) `doXmlHttpRequest` 的 CONFIRM 分支替换：

旧：
```ts
  if (decision === ConnectDecision.CONFIRM) {
    const choice = await queueConfirm(scriptId, details.url);
    if (choice === 'deny') return { ok: false, error: 'permission denied（用户拒绝或确认超时；可加 @connect 或在侧边栏批准）' };
  } else if (decision === ConnectDecision.DENY) {
```
新：
```ts
  if (decision === ConnectDecision.CONFIRM) {
    const host = hostOf(details.url);
    const choice = await enqueueConfirm({
      kind: 'connect',
      title: '跨域请求确认',
      message: `脚本「${script.name}」请求跨域访问`,
      rows: [
        { label: '主机', value: host, mono: true },
        { label: '方法', value: (details.method ?? 'GET').toUpperCase(), mono: true },
        { label: 'URL', value: details.url, mono: true },
        { label: '来源', value: pageUrl || '（未知）', mono: true },
      ],
      actions: [
        { decision: 'allow-once', label: '允许一次', variant: 'primary' },
        { decision: 'always', label: '总是允许' },
        { decision: 'deny', label: '拒绝', variant: 'danger', countdown: true },
      ],
      timeoutMs: 60_000,
    });
    if (choice === 'always') {
      const { setAlwaysAllow } = await import('./gm-permissions');
      await setAlwaysAllow(scriptId, host);
    } else if (choice !== 'allow-once') {
      return { ok: false, error: 'permission denied（用户拒绝或确认超时/关闭；可加 @connect 或在确认页批准）' };
    }
  } else if (decision === ConnectDecision.DENY) {
```

> `script` 已在 `doXmlHttpRequest` 上文 `const script = await getScript(scriptId)` 取得（用于 `script.meta?.connects`），此处直接复用 `script.name`。

(d) `initGmApi` 里删掉 `GM_CONFIRM_RESOLVE` handler 整段：
```ts
  router.on('GM_CONFIRM_RESOLVE', async (msg) => {
    const { confirmId, decision } = msg as unknown as { confirmId: string; decision: 'allow-once' | 'always' | 'deny' };
    await resolveConfirm(confirmId, decision);
    return { ok: true };
  });
```

(e) `SCRIPTS_GET_GM_STATE` handler 去掉 confirms：

旧：
```ts
  router.on('SCRIPTS_GET_GM_STATE', async () => ({
    ok: true,
    data: { menus: getMenuSnapshot(), errors: getAllErrors(), confirms: getPendingConfirms() },
  }));
```
新：
```ts
  router.on('SCRIPTS_GET_GM_STATE', async () => ({
    ok: true,
    data: { menus: getMenuSnapshot(), errors: getAllErrors() },
  }));
```

- [ ] **Step 3: 改 gm-api.test.ts（import 换源 + 去 confirms 断言）**

`tests/background/gm-api.test.ts`：

(a) 顶部 import 从 `../../background/gm-api` 移除 `resolveConfirm`：
```ts
import {
  gmErrorCounts, getErrorBuffer, clearErrors, getMenuSnapshot, handleGmCall,
  initGmApi, cleanupScriptState,
} from '../../background/gm-api';
import { resolveConfirm, getPending, __resetConfirmQueue } from '../../background/confirm-queue';
```

(b) 该文件 `SCRIPTS_GET_GM_STATE` 用例（`返回 menus/errors/confirms 三者非空且形状对`）改名并去掉 confirms 部分。整个用例替换为：

```ts
  it('返回 menus/errors 两者非空且形状对', async () => {
    await saveScript(mkScript({ meta: { grants: ['GM_registerMenuCommand', 'GM_xmlhttpRequest'] } }));
    await call('RegisterMenu', ['m1', '抓取']);
    await call('ReportError', ['boom', 'stack', 3]);
    const getState = handlers.get('SCRIPTS_GET_GM_STATE')!;
    const resp = await getState({}) as {
      ok: boolean;
      data: { menus: Array<{ scriptId: string; commands: unknown[] }>; errors: Record<string, unknown[]> };
    };
    expect(resp.ok).toBe(true);
    expect(resp.data.menus).toEqual([{ scriptId: 's1', commands: [{ key: 'm1', name: '抓取' }] }]);
    expect(resp.data.errors['s1']).toHaveLength(1);
    expect(resp.data.errors['s1']![0]).toMatchObject({ message: 'boom', line: 3 });
  });
```

> 确认队列相关的验证已迁到 `confirm-queue.test.ts`；此处不再触发 XHR 确认，故 `resolveConfirm`/`getPending`/`__resetConfirmQueue` import 若在本文件其它用例未用到则删掉——若删后有 unused import 报错，直接移除这行 import。跑一次即知。

- [ ] **Step 4: 类型检查**

Run: `npm run compile`
Expected: 仍 FAIL（`ScriptsConfirmCard.tsx`/`stores/scripts.ts`/`ScriptsView.tsx`/`PopupApp.tsx` 未改）——但 `gm-api.ts` 自身应无错。目视确认报错只剩这四个文件。

- [ ] **Step 5: 跑后台测试**

Run: `npx vitest run tests/background/gm-connect.test.ts tests/background/gm-api.test.ts`
Expected: PASS（两文件全绿）

- [ ] **Step 6: Commit**

```bash
git add background/gm-api.ts tests/background/gm-connect.test.ts tests/background/gm-api.test.ts
git commit -m "refactor(confirm): gm-api @connect 改用通用队列 + 副作用搬回生产者"
```

---

## Task 5：注册队列入口 `entrypoints/background.ts`

**Files:**
- Modify: `entrypoints/background.ts`

- [ ] **Step 1: 加 import + 注册调用**

(a) 顶部 import 区加：
```ts
import { initConfirmQueue } from '../background/confirm-queue';
```

(b) 找到 `initGmApi(router);` 那行，其后加一行：
```ts
  initGmApi(router);
  initConfirmQueue(router);
```

- [ ] **Step 2: 类型检查**

Run: `npm run compile`
Expected: 仍 FAIL（前端四文件未改），但 background.ts 无新错。

- [ ] **Step 3: Commit**

```bash
git add entrypoints/background.ts
git commit -m "feat(confirm): background 注册 initConfirmQueue"
```

---

## Task 6：hub 页 reducer + ConfirmCard 组件（TDD）

**Files:**
- Create: `components/confirm/confirm-reducer.ts`
- Create: `components/confirm/ConfirmCard.tsx`
- Test: `tests/confirm/confirm-hub.test.tsx`

- [ ] **Step 1: 写失败测试**

`tests/confirm/confirm-hub.test.tsx`：

```tsx
// tests/confirm/confirm-hub.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { applyConfirmEvent } from '../../components/confirm/confirm-reducer';
import { ConfirmCard } from '../../components/confirm/ConfirmCard';
import type { ConfirmRequest } from '../../shared/confirm';

afterEach(cleanup);

function mk(over: Partial<ConfirmRequest> = {}): ConfirmRequest {
  return {
    confirmId: 'c1', kind: 'connect', title: '跨域请求确认', message: '脚本「S」请求跨域访问',
    rows: [{ label: '主机', value: 'api.example.com', mono: true }],
    actions: [
      { decision: 'allow-once', label: '允许一次', variant: 'primary' },
      { decision: 'deny', label: '拒绝', variant: 'danger', countdown: true },
    ],
    createdAt: Date.now(), timeoutMs: 60_000, ...over,
  };
}

describe('applyConfirmEvent reducer', () => {
  it('CONFIRM_PENDING 追加', () => {
    const next = applyConfirmEvent([], { type: 'CONFIRM_PENDING', confirm: mk() });
    expect(next).toHaveLength(1);
  });
  it('CONFIRM_PENDING 幂等（同 confirmId 不重复追加）', () => {
    const s1 = applyConfirmEvent([], { type: 'CONFIRM_PENDING', confirm: mk() });
    const s2 = applyConfirmEvent(s1, { type: 'CONFIRM_PENDING', confirm: mk() });
    expect(s2).toHaveLength(1);
  });
  it('CONFIRM_RESOLVED 移除', () => {
    const s1 = applyConfirmEvent([], { type: 'CONFIRM_PENDING', confirm: mk() });
    const s2 = applyConfirmEvent(s1, { type: 'CONFIRM_RESOLVED', confirmId: 'c1' });
    expect(s2).toHaveLength(0);
  });
  it('未知 type 原样返回', () => {
    const s1 = applyConfirmEvent([], { type: 'CONFIRM_PENDING', confirm: mk() });
    const s2 = applyConfirmEvent(s1, { type: 'OTHER' } as never);
    expect(s2).toBe(s1);
  });
});

describe('ConfirmCard', () => {
  it('渲染 title/message/rows + 点按钮回传 decision', () => {
    const onDecide = vi.fn();
    render(<ConfirmCard confirm={mk()} onDecide={onDecide} />);
    expect(screen.getByText('跨域请求确认')).toBeTruthy();
    expect(screen.getByText('api.example.com')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /允许一次/ }));
    expect(onDecide).toHaveBeenCalledWith('allow-once');
  });
  it('countdown 按钮显示剩余秒数', () => {
    const onDecide = vi.fn();
    render(<ConfirmCard confirm={mk({ createdAt: Date.now(), timeoutMs: 60_000 })} onDecide={onDecide} />);
    // "拒绝" 按钮文本含秒数（近似 60s，允许 55~60）
    const btn = screen.getByRole('button', { name: /拒绝/ });
    expect(/拒绝（\d+s）/.test(btn.textContent ?? '')).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/confirm/confirm-hub.test.tsx`
Expected: FAIL（`confirm-reducer`/`ConfirmCard` 模块不存在）

- [ ] **Step 3: 写 reducer**

`components/confirm/confirm-reducer.ts`：

```ts
// components/confirm/confirm-reducer.ts
// hub 页「事件 → 状态」纯函数（可测）：CONFIRM_PENDING 幂等追加，CONFIRM_RESOLVED 移除。
import type { ConfirmRequest, ConfirmPendingEvent, ConfirmResolvedEvent } from '../../shared/confirm';

type ConfirmEvent = ConfirmPendingEvent | ConfirmResolvedEvent;

export function applyConfirmEvent(state: ConfirmRequest[], event: ConfirmEvent): ConfirmRequest[] {
  if (event.type === 'CONFIRM_PENDING') {
    if (state.some((c) => c.confirmId === event.confirm.confirmId)) return state;
    return [...state, event.confirm];
  }
  if (event.type === 'CONFIRM_RESOLVED') {
    return state.filter((c) => c.confirmId !== event.confirmId);
  }
  return state;
}
```

- [ ] **Step 4: 写 ConfirmCard**

`components/confirm/ConfirmCard.tsx`：

```tsx
// components/confirm/ConfirmCard.tsx
// 通用确认卡（纯展示，spec §8）：title/message/rows/actions 全部来自 props，零 @connect 语义。
// countdown 按钮跑本地倒计时（起点 createdAt + timeoutMs）；归零后由 SW 广播 CONFIRM_RESOLVED 移除。
import { useEffect, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { Button } from '../ui/Button';
import type { ConfirmRequest, ConfirmAction } from '../../shared/confirm';

function secondsLeft(confirm: ConfirmRequest): number {
  return Math.max(0, Math.ceil((confirm.createdAt + confirm.timeoutMs - Date.now()) / 1000));
}

const VARIANT: Record<NonNullable<ConfirmAction['variant']>, 'primary' | 'danger' | undefined> = {
  primary: 'primary', danger: 'danger', default: undefined,
};

export function ConfirmCard({ confirm, onDecide }: { confirm: ConfirmRequest; onDecide: (decision: string) => void }) {
  const [left, setLeft] = useState(() => secondsLeft(confirm));
  useEffect(() => {
    const t = setInterval(() => setLeft(secondsLeft(confirm)), 1000);
    return () => clearInterval(t);
  }, [confirm]);

  return (
    <div className="confirm-card" role="alertdialog" aria-label={confirm.title}>
      <div className="confirm-card__head">
        <ShieldAlert size={16} aria-hidden />
        <span className="confirm-card__msg">{confirm.message}</span>
      </div>
      <dl className="confirm-card__rows">
        {confirm.rows.map((r, i) => (
          <div className="confirm-card__row" key={i}>
            <dt>{r.label}</dt>
            <dd className={r.mono ? 'mono' : undefined}>{r.value}</dd>
          </div>
        ))}
      </dl>
      <div className="confirm-card__actions">
        {confirm.actions.map((a) => (
          <Button
            key={a.decision}
            variant={a.variant ? VARIANT[a.variant] : undefined}
            onClick={() => onDecide(a.decision)}
          >
            {a.countdown ? `${a.label}（${left}s）` : a.label}
          </Button>
        ))}
      </div>
    </div>
  );
}
```

> 核对 `components/ui/Button.tsx` 的 `variant` prop 取值：若不接受 `undefined`，改成条件展开 `{...(a.variant && a.variant !== 'default' ? { variant: VARIANT[a.variant] } : {})}`。实现时先读 Button 签名对齐。

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run tests/confirm/confirm-hub.test.tsx`
Expected: PASS（6 用例全绿）

- [ ] **Step 6: Commit**

```bash
git add components/confirm/confirm-reducer.ts components/confirm/ConfirmCard.tsx tests/confirm/confirm-hub.test.tsx
git commit -m "feat(confirm): 通用 ConfirmCard 组件 + hub reducer + 单测"
```

---

## Task 7：hub 页容器 `ConfirmHubApp` + 入口

**Files:**
- Create: `components/confirm/ConfirmHubApp.tsx`
- Create: `entrypoints/confirm/index.html`
- Create: `entrypoints/confirm/main.tsx`

- [ ] **Step 1: 写 ConfirmHubApp**

`components/confirm/ConfirmHubApp.tsx`：

```tsx
// components/confirm/ConfirmHubApp.tsx
// 跨域确认 hub 页容器（spec §8）：挂载复水 CONFIRM_GET_STATE + 订阅 CONFIRM_PENDING/RESOLVED 广播，
// 排队渲染 ConfirmCard。决策经 CONFIRM_RESOLVE 回 SW，本地乐观移除（广播回来的 RESOLVED 幂等收口）。
import { useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { ConfirmCard } from './ConfirmCard';
import { applyConfirmEvent } from './confirm-reducer';
import type { ConfirmRequest, ConfirmPendingEvent, ConfirmResolvedEvent } from '../../shared/confirm';

export function ConfirmHubApp() {
  const [confirms, setConfirms] = useState<ConfirmRequest[]>([]);

  useEffect(() => {
    void (async () => {
      const resp = (await browser.runtime.sendMessage({ type: 'CONFIRM_GET_STATE' })) as
        { ok: boolean; data?: { confirms: ConfirmRequest[] } } | undefined;
      if (resp?.data?.confirms) setConfirms(resp.data.confirms);
    })();
    const onMessage = (msg: unknown) => {
      const m = msg as { type?: string };
      if (m?.type === 'CONFIRM_PENDING') setConfirms((s) => applyConfirmEvent(s, msg as ConfirmPendingEvent));
      if (m?.type === 'CONFIRM_RESOLVED') setConfirms((s) => applyConfirmEvent(s, msg as ConfirmResolvedEvent));
    };
    browser.runtime.onMessage.addListener(onMessage);
    return () => browser.runtime.onMessage.removeListener(onMessage);
  }, []);

  function decide(confirmId: string, decision: string): void {
    void browser.runtime.sendMessage({ type: 'CONFIRM_RESOLVE', confirmId, decision }).catch(() => {});
    setConfirms((s) => s.filter((c) => c.confirmId !== confirmId)); // 乐观移除
  }

  return (
    <div className="confirm-hub">
      <header className="confirm-hub__head">
        <span className="confirm-hub__title">跨域请求确认</span>
        <span className="confirm-hub__count mono">{confirms.length} 个待确认</span>
      </header>
      {confirms.length === 0 ? (
        <div className="confirm-hub__empty">
          <ShieldCheck size={20} aria-hidden />
          <span>暂无待确认请求</span>
        </div>
      ) : (
        <div className="confirm-hub__list">
          {confirms.map((c) => (
            <ConfirmCard key={c.confirmId} confirm={c} onDecide={(d) => decide(c.confirmId, d)} />
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: 写入口 index.html**

`entrypoints/confirm/index.html`（对齐 `entrypoints/script-detail/index.html`）：

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>跨域请求确认</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 3: 写入口 main.tsx**

`entrypoints/confirm/main.tsx`：

```tsx
// entrypoints/confirm/main.tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConfirmHubApp } from '../../components/confirm/ConfirmHubApp';
import '../sidepanel/styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfirmHubApp />
  </React.StrictMode>,
);
```

- [ ] **Step 4: 类型检查**

Run: `npm run compile`
Expected: 仍 FAIL（Task 8 前端清理未做），但 confirm 目录相关文件应无错。

- [ ] **Step 5: Commit**

```bash
git add components/confirm/ConfirmHubApp.tsx entrypoints/confirm/index.html entrypoints/confirm/main.tsx
git commit -m "feat(confirm): 跨域确认 hub 页容器 + 入口"
```

---

## Task 8：清理侧边栏内联卡（全链路去 confirms）

**Files:**
- Delete: `components/scripts/ScriptsConfirmCard.tsx`
- Modify: `stores/scripts.ts`
- Modify: `components/scripts/ScriptsView.tsx`
- Modify: `components/scripts/ScriptsListView.tsx`
- Modify: `components/popup/PopupApp.tsx`

- [ ] **Step 1: 删 ScriptsConfirmCard.tsx**

```bash
git rm components/scripts/ScriptsConfirmCard.tsx
```

- [ ] **Step 2: 改 stores/scripts.ts**

(a) 删接口定义：
```ts
export interface GmConfirmItem { confirmId: string; scriptId: string; host: string; url: string; createdAt: number }
```

(b) `ScriptsState` 接口内删这三行：
```ts
  confirms: GmConfirmItem[];
  applyConfirmEvent: (e: { confirm: GmConfirmItem }) => void;
  applyConfirmResolved: (confirmId: string) => void;
```

(c) store 实现内删初值 `confirms: [],` 和两个方法：
```ts
  applyConfirmEvent: (e) => set((s) => ({ confirms: [...s.confirms, e.confirm] })),
  applyConfirmResolved: (confirmId) => set((s) => ({ confirms: s.confirms.filter((c) => c.confirmId !== confirmId) })),
```

(d) `refresh` 内：`gmResp` 的泛型去掉 `confirms` 字段，`set({...})` 内删 `confirms: gmResp.data?.confirms ?? [],`：
```ts
      const gmResp = await sendScriptsRequest<{ ok: boolean; data?: { menus: GmMenuEntry[]; errors: Record<string, GmErrorItem[]> } }>({ type: 'SCRIPTS_GET_GM_STATE' });
```

- [ ] **Step 3: 改 ScriptsView.tsx**

(a) import 去掉 `GmConfirmItem`：
```ts
import type { GmErrorItem, GmMenuEntry } from '../../stores/scripts';
```

(b) 删两条订阅分支：
```ts
      if (m?.type === 'GM_CONFIRM_PENDING') {
        useScripts.getState().applyConfirmEvent(msg as { type: string; confirm: GmConfirmItem });
      }
      if (m?.type === 'GM_CONFIRM_RESOLVED') {
        useScripts.getState().applyConfirmResolved((msg as { confirmId: string }).confirmId);
      }
```

- [ ] **Step 4: 改 ScriptsListView.tsx**

(a) 删 import：
```ts
import { ScriptsConfirmCard } from './ScriptsConfirmCard';
```

(b) 解构去掉 `confirms`：
```ts
  const { summaries, query, engineWarning, setQuery } = useScripts();
```

(c) 删渲染行：
```ts
      {confirms.map((c) => <ScriptsConfirmCard key={c.confirmId} confirm={c} />)}
```

- [ ] **Step 5: 改 PopupApp.tsx**

(a) import 去掉 `GmConfirmItem`：
```ts
import type { GmMenuEntry, GmErrorItem } from '../../stores/scripts';
```

(b) `gmResp` 泛型去掉 `confirms`：
```ts
        const gmResp = await sendScriptsRequest<{ ok: boolean; data?: { menus: GmMenuEntry[]; errors: Record<string, GmErrorItem[]> }; error?: string }>({
          type: 'SCRIPTS_GET_GM_STATE',
        });
```

- [ ] **Step 6: 类型检查（应全绿）**

Run: `npm run compile`
Expected: PASS（所有旧 confirms 引用已清除）

- [ ] **Step 7: 跑受影响的前端测试**

Run: `npx vitest run tests/popup/popup-app.test.tsx tests/stores/scripts.test.ts tests/ui/scripts-list.test.tsx`
Expected: PASS。若 `popup-app.test.tsx` 的 mock 里 `SCRIPTS_GET_GM_STATE` 仍返回 `confirms: []`——无害（多余字段，PopupApp 不读），可保留；若某断言显式检查 confirms 则删该断言。若 `scripts.test.ts` 断言了 `confirms` 初值/方法，删掉对应断言。

- [ ] **Step 8: Commit**

```bash
git add stores/scripts.ts components/scripts/ScriptsView.tsx components/scripts/ScriptsListView.tsx components/popup/PopupApp.tsx components/scripts/ScriptsConfirmCard.tsx
git commit -m "refactor(confirm): 移除侧边栏内联确认卡及 store/订阅"
```

---

## Task 9：hub 页样式

**Files:**
- Modify: `entrypoints/sidepanel/styles.css`

- [ ] **Step 1: 追加样式（文件末尾）**

`entrypoints/sidepanel/styles.css` 末尾追加：

```css
/* 跨域确认 hub 页（独立标签页，居中单列卡栈） */
.confirm-hub {
  max-width: 560px; margin: 0 auto; padding: 24px 20px;
  display: flex; flex-direction: column; gap: 14px;
  font-family: var(--sans); color: var(--ink);
}
.confirm-hub__head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.confirm-hub__title { font-size: 15px; font-weight: 600; }
.confirm-hub__count { font-size: 12px; color: var(--ink-3); }
.confirm-hub__empty {
  display: flex; flex-direction: column; align-items: center; gap: 8px;
  padding: 48px 0; color: var(--ink-3); font-size: 13px;
}
.confirm-hub__list { display: flex; flex-direction: column; gap: 12px; }

.confirm-card {
  border: 1px solid var(--warn); background: var(--warn-wash);
  border-radius: var(--r-lg); padding: 14px 16px;
  display: flex; flex-direction: column; gap: 10px;
}
.confirm-card__head { display: flex; align-items: center; gap: 8px; color: var(--warn); font-weight: 600; font-size: 13px; }
.confirm-card__msg { color: var(--ink); }
.confirm-card__rows { display: grid; gap: 5px; margin: 0; }
.confirm-card__row { display: grid; grid-template-columns: 48px minmax(0, 1fr); gap: 8px; font-size: 12px; }
.confirm-card__row dt { color: var(--ink-3); }
.confirm-card__row dd { margin: 0; color: var(--ink); word-break: break-all; }
.confirm-card__actions { display: flex; gap: 8px; flex-wrap: wrap; }
```

> 色值全部走 `:root` 变量（`--warn`/`--warn-wash`/`--ink*`/`--r-lg` 等），无硬编码。无动画，无需 reduced-motion 兜底。

- [ ] **Step 2: 构建验证入口产出**

Run: `npm run build`
Expected: PASS，且产物含 `confirm.html`（WXT 自动从 `entrypoints/confirm/` 注册）。用以下命令确认：

```bash
ls .output/chrome-mv3/confirm.html
```
Expected: 文件存在。

- [ ] **Step 3: Commit**

```bash
git add entrypoints/sidepanel/styles.css
git commit -m "feat(confirm): hub 页与确认卡样式"
```

---

## Task 10：全量验证与收尾

**Files:** 无新增，仅验证。

- [ ] **Step 1: 类型检查全绿**

Run: `npm run compile`
Expected: PASS（0 error）

- [ ] **Step 2: 全量测试**

Run: `npm run test`
Expected: PASS（含新增 `confirm-queue.test.ts` 6 用例、`confirm-hub.test.tsx` 6 用例；改造后的 `gm-connect`/`gm-api` 全绿；前端测试无回归）

- [ ] **Step 3: 生产构建**

Run: `npm run build`
Expected: PASS，产物含 `confirm.html`/`sidepanel.html`/`popup.html`/`script-detail.html` 四页入口。

- [ ] **Step 4: 人工冒烟清单（记录到 PR 描述，非自动化）**

在真实 Chrome 加载 `.output/chrome-mv3`，验证：
1. 装一个带 `@grant GM_xmlhttpRequest`、`@match` 命中当前页、无 `@connect` 的脚本，触发对未列域的跨域请求 → 自动打开 `confirm.html` 新标签页并置前，展示丰富卡（脚本名/主机/方法/URL/来源）。
2. 点「允许一次」→ 请求放行；再次触发同域 → 仍弹卡（未落库）。
3. 点「总是允许」→ 请求放行；再次触发同域 → 直通不弹卡（已落库 `gm-permissions`）。
4. 点「拒绝」或等 60s → 请求 `onerror`（ok:false）。
5. 同时触发两个不同域请求 → hub 页排两张卡；关掉 hub tab → 两个请求都被拒（`__closed__`）。
6. 侧边栏「脚本池」页不再出现任何内联确认卡。

- [ ] **Step 5: 最终 Commit（若冒烟发现小修）**

```bash
git add -A
git commit -m "chore(confirm): 冒烟修正与收尾"
```

---

## 完成标准

- [ ] `npm run compile` 0 error
- [ ] `npm run test` 全绿（新增 12 用例 + 改造用例 + 无回归）
- [ ] `npm run build` 产出 `confirm.html`
- [ ] 侧边栏无内联确认卡；跨域确认在新标签页 hub 呈现
- [ ] @connect 判定（`matchConnect` 系列）与授权存储（`gm-permissions`）行为不变
- [ ] 确认队列零副作用（`always` 落库、`deny` 回错误均在生产者侧）
