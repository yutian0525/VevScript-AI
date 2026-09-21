# CDP 深度观测 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 `chrome.debugger`（CDP）取代 MAIN world hook 承担页面网络与控制台观测，默认关闭、由侧边栏圆形开关或模型工具开启。

**Architecture:** CDP 会话按标签页附着（`background/cdp/session.ts`），附着后 enable `Network`/`Runtime`/`Log`/`Page` 四域并用 `Target.setAutoAttach` 的 flatten 模式收跨域 iframe 与 Dedicated Worker（`background/cdp/domains.ts`）；CDP 事件直接摄入现有 `observe-store` 的 per-tab 环形缓冲（该缓冲当初即按「可并入第二数据源」模块化），CDP 附着时抑制同 tab 的 webRequest 摄入以避免 id 命名空间冲突；CDP 关闭时 webRequest 元数据主干照常工作。

**Tech Stack:** WXT 0.21 + TypeScript 7 + React 19 + Zustand + vitest v4（`wxt/testing/fake-browser`）+ jsdom。

**Spec:** `docs/superpowers/specs/2026-09-21-cdp-deep-observe-design.md`

## Global Constraints

- 新增 manifest 权限 `debugger`（`wxt.config.ts` 的 `permissions` 数组）。`scripting` 与 `webRequest` 保留。
- CDP 协议版本字符串固定为 `'1.3'`（`browser.debugger.attach` 第二参数）。
- `Target.setAutoAttach` 的 `waitForDebuggerOnStart` **必须为 `false`**——置 true 会把页面冻在启动断点上。
- 响应体上限 `MAX_BODY = 64 * 1024`；console 单条文本上限 `MAX_CONSOLE_TEXT = 4096`；WS 帧数上限 `MAX_WS_FRAMES = 200`；WS 单帧 payload 上限 `MAX_WS_PAYLOAD = 4096`。
- 观测缓冲每 tab 每通道上限沿用 `MAX_ENTRIES = 200`。
- 网络条目 id 命名空间：webRequest 条目 `wr:` 前缀，CDP 条目 `cdp:` 前缀。
- 样式一律走 `entrypoints/sidepanel/styles.css` 的 CSS 变量，禁硬编码色值；图标用 lucide-react，禁 emoji；动画加 `prefers-reduced-motion` 兜底。
- 工具返回值统一 `{ ok: true, data? } | { ok: false; error }`。
- 每个 task 结束前 `npm run compile` 必须通过。

---

### Task 1: CDP console 参数序列化（`background/cdp/console-text.ts`）

把 CDP `Runtime.consoleAPICalled` 的 `args: RemoteObject[]` 转成可读文本。纯函数、零依赖，先做。

**Files:**
- Create: `background/cdp/console-text.ts`
- Test: `tests/background/cdp-console-text.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `interface RemoteObjectLike`；`const MAX_CONSOLE_TEXT = 4096`；`function serializeRemoteObjects(args: RemoteObjectLike[]): string`

- [ ] **Step 1: Write the failing test**

```ts
// tests/background/cdp-console-text.test.ts
import { describe, it, expect } from 'vitest';
import { serializeRemoteObjects, MAX_CONSOLE_TEXT } from '../../background/cdp/console-text';

describe('serializeRemoteObjects', () => {
  it('字符串不加引号，多参以空格连接', () => {
    expect(serializeRemoteObjects([
      { type: 'string', value: 'hello' },
      { type: 'number', value: 42 },
      { type: 'boolean', value: true },
    ])).toBe('hello 42 true');
  });

  it('null / undefined / bigint', () => {
    expect(serializeRemoteObjects([
      { type: 'object', subtype: 'null', value: null },
      { type: 'undefined' },
      { type: 'bigint', description: '10n' },
    ])).toBe('null undefined 10n');
  });

  it('对象优先用 description', () => {
    expect(serializeRemoteObjects([{ type: 'object', description: 'Object { a: 1 }' }]))
      .toBe('Object { a: 1 }');
  });

  it('无 description 时用 preview 拼浅层摘要，最多 5 项 + 溢出省略号', () => {
    const preview = {
      type: 'object',
      properties: [
        { name: 'a', type: 'number', value: '1' },
        { name: 'b', type: 'string', value: 'x' },
        { name: 'c', type: 'number', value: '3' },
        { name: 'd', type: 'number', value: '4' },
        { name: 'e', type: 'number', value: '5' },
        { name: 'f', type: 'number', value: '6' },
      ],
      overflow: true,
    };
    expect(serializeRemoteObjects([{ type: 'object', preview }])).toBe('{a: 1, b: x, c: 3, d: 4, e: 5, …}');
  });

  it('既无 description 也无 preview 的对象退回占位', () => {
    expect(serializeRemoteObjects([{ type: 'object' }])).toBe('[object]');
  });

  it('Error 用 description（含堆栈首行）', () => {
    expect(serializeRemoteObjects([
      { type: 'object', subtype: 'error', description: 'Error: boom\n    at <anonymous>:1:1' },
    ])).toBe('Error: boom\n    at <anonymous>:1:1');
  });

  it('函数用 description', () => {
    expect(serializeRemoteObjects([{ type: 'function', description: 'ƒ foo()' }])).toBe('ƒ foo()');
  });

  it('超长文本截断到 MAX_CONSOLE_TEXT 并加省略号', () => {
    const long = 'x'.repeat(MAX_CONSOLE_TEXT + 100);
    const out = serializeRemoteObjects([{ type: 'string', value: long }]);
    expect(out).toHaveLength(MAX_CONSOLE_TEXT + 1);
    expect(out.endsWith('…')).toBe(true);
  });

  it('空参数返回空串', () => {
    expect(serializeRemoteObjects([])).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/background/cdp-console-text.test.ts`
Expected: FAIL — `Failed to resolve import "../../background/cdp/console-text"`

- [ ] **Step 3: Write minimal implementation**

```ts
// background/cdp/console-text.ts
// CDP RemoteObject[] → 可读文本（设计 §5.3）。纯函数、零往返：
// 不做 Runtime.getProperties（objectId 会过期，高频 console 下代价不可接受），对象只到 description / preview 浅层。
export const MAX_CONSOLE_TEXT = 4096;
const PREVIEW_MAX_PROPS = 5;

/** CDP Runtime.RemoteObject 的最小可用形状（只取序列化用得到的字段，便于测试构造）。 */
export interface RemoteObjectLike {
  type: string;
  subtype?: string;
  value?: unknown;
  description?: string;
  preview?: {
    properties?: Array<{ name: string; value?: string }>;
    overflow?: boolean;
  };
}

function serializeOne(arg: RemoteObjectLike): string {
  if (arg.subtype === 'null') return 'null';
  switch (arg.type) {
    case 'string': return String(arg.value ?? '');
    case 'number': case 'boolean': return String(arg.value);
    case 'undefined': return 'undefined';
    case 'bigint': case 'symbol': case 'function':
      return arg.description || (arg.type === 'function' ? 'ƒ' : arg.type);
    default: break;
  }
  if (arg.description) return arg.description;
  const props = arg.preview?.properties;
  if (props?.length) {
    const shown = props.slice(0, PREVIEW_MAX_PROPS).map((p) => `${p.name}: ${p.value ?? '…'}`);
    if (props.length > PREVIEW_MAX_PROPS || arg.preview?.overflow) shown.push('…');
    return `{${shown.join(', ')}}`;
  }
  return '[object]';
}

/** 多参以空格连接；总长截断到 MAX_CONSOLE_TEXT（截断时末尾加省略号）。 */
export function serializeRemoteObjects(args: RemoteObjectLike[]): string {
  const text = args.map(serializeOne).join(' ');
  if (text.length <= MAX_CONSOLE_TEXT) return text;
  return `${text.slice(0, MAX_CONSOLE_TEXT)}…`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/background/cdp-console-text.test.ts`
Expected: PASS（9 个用例）

- [ ] **Step 5: Commit**

```bash
git add background/cdp/console-text.ts tests/background/cdp-console-text.test.ts
git commit -m "feat(cdp): console RemoteObject 序列化（纯函数）"
```

---

### Task 2: 响应体抓取策略（`background/cdp/bodies.ts`）

类型白名单 + mimeType 排除 + 截断 + `Network.getResponseBody` 封装。

**Files:**
- Create: `background/cdp/bodies.ts`
- Test: `tests/background/cdp-bodies.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `const MAX_BODY = 64 * 1024`；`function shouldFetchBody(type: string, mimeType?: string): boolean`；`function truncateBody(text: string): { body: string; truncated: boolean }`；`async function fetchBody(tabId: number, sessionId: string | undefined, requestId: string): Promise<{ body: string; truncated: boolean } | null>`

- [ ] **Step 1: Write the failing test**

```ts
// tests/background/cdp-bodies.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { shouldFetchBody, truncateBody, fetchBody, MAX_BODY } from '../../background/cdp/bodies';

function mockDebugger(sendCommand: (m: string, p?: Record<string, unknown>) => unknown) {
  (fakeBrowser as unknown as { debugger: unknown }).debugger = {
    sendCommand: (async (_t: unknown, method: string, params?: Record<string, unknown>) => sendCommand(method, params)) as never,
  };
}

beforeEach(() => { fakeBrowser.reset(); });

describe('shouldFetchBody', () => {
  it('白名单内类型抓取', () => {
    expect(shouldFetchBody('XHR', 'application/json')).toBe(true);
    expect(shouldFetchBody('Fetch', 'application/json')).toBe(true);
    expect(shouldFetchBody('Document', 'text/html')).toBe(true);
  });

  it('白名单外类型跳过', () => {
    expect(shouldFetchBody('Image', 'image/png')).toBe(false);
    expect(shouldFetchBody('Script', 'text/javascript')).toBe(false);
  });

  it('非文本 mimeType 跳过', () => {
    expect(shouldFetchBody('Fetch', 'image/svg+xml')).toBe(false);
    expect(shouldFetchBody('Fetch', 'font/woff2')).toBe(false);
    expect(shouldFetchBody('Fetch', 'audio/mpeg')).toBe(false);
    expect(shouldFetchBody('Fetch', 'video/mp4')).toBe(false);
  });

  it('SSE 跳过（对齐原 hook 对 event-stream 的处理）', () => {
    expect(shouldFetchBody('Fetch', 'text/event-stream')).toBe(false);
  });

  it('mimeType 缺失时按类型放行', () => {
    expect(shouldFetchBody('XHR', undefined)).toBe(true);
  });
});

describe('truncateBody', () => {
  it('未超限原样返回', () => {
    expect(truncateBody('abc')).toEqual({ body: 'abc', truncated: false });
  });

  it('超限截断并标 truncated', () => {
    const r = truncateBody('x'.repeat(MAX_BODY + 10));
    expect(r.body).toHaveLength(MAX_BODY);
    expect(r.truncated).toBe(true);
  });
});

describe('fetchBody', () => {
  it('成功取到文本体', async () => {
    mockDebugger(() => ({ body: '{"ok":1}', base64Encoded: false }));
    await expect(fetchBody(1, undefined, 'r1')).resolves.toEqual({ body: '{"ok":1}', truncated: false });
  });

  it('base64Encoded 为真时不落库（二进制）', async () => {
    mockDebugger(() => ({ body: 'AAAA', base64Encoded: true }));
    await expect(fetchBody(1, undefined, 'r1')).resolves.toBeNull();
  });

  it('CDP 抛错时返回 null（best-effort，不阻断观测）', async () => {
    mockDebugger(() => { throw new Error('No resource with given identifier'); });
    await expect(fetchBody(1, undefined, 'r1')).resolves.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/background/cdp-bodies.test.ts`
Expected: FAIL — 无法解析 `../../background/cdp/bodies`

- [ ] **Step 3: Write minimal implementation**

```ts
// background/cdp/bodies.ts
// 响应体抓取策略（设计 §5.4）：只在 loadingFinished 时按白名单立即取走——
// CDP 的 body 缓冲会被淘汰，等工具调用时再拉不可靠。
export const MAX_BODY = 64 * 1024;

/** 抓体白名单：与旧 hook 的 fetch/XHR 语义对齐，另加 Document（HTML 正文有诊断价值）。 */
const BODY_TYPE_ALLOWLIST = new Set(['XHR', 'Fetch', 'Document']);
/** 非文本 mimeType 前缀/片段，命中即跳过。 */
const NON_TEXT_MIME = ['image/', 'font/', 'audio/', 'video/'];
const SSE_MIME = 'event-stream';

export function shouldFetchBody(type: string, mimeType?: string): boolean {
  if (!BODY_TYPE_ALLOWLIST.has(type)) return false;
  if (!mimeType) return true;
  const mime = mimeType.toLowerCase();
  if (mime.includes(SSE_MIME)) return false;
  return !NON_TEXT_MIME.some((p) => mime.startsWith(p));
}

export function truncateBody(text: string): { body: string; truncated: boolean } {
  if (text.length <= MAX_BODY) return { body: text, truncated: false };
  return { body: text.slice(0, MAX_BODY), truncated: true };
}

/** 取单条响应体。任何失败（已淘汰/重定向/缓存命中/二进制）返回 null，由调用方标 hasBody:false。 */
export async function fetchBody(
  tabId: number,
  sessionId: string | undefined,
  requestId: string,
): Promise<{ body: string; truncated: boolean } | null> {
  try {
    const res = await browser.debugger.sendCommand(
      { tabId, sessionId },
      'Network.getResponseBody',
      { requestId },
    ) as { body?: string; base64Encoded?: boolean } | undefined;
    if (!res?.body || res.base64Encoded) return null;
    return truncateBody(res.body);
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/background/cdp-bodies.test.ts`
Expected: PASS（10 个用例）

- [ ] **Step 5: Commit**

```bash
git add background/cdp/bodies.ts tests/background/cdp-bodies.test.ts
git commit -m "feat(cdp): 响应体抓取策略（类型白名单 + 截断 + best-effort）"
```

---

### Task 3: `observe-store` 接纳 CDP 数据源

加 id 前缀、CDP 摄入 API、WS 帧挂载、webRequest 抑制钩子。**本 task 不动 hook 路径**（删除在 Task 11），保证每步可回滚。

**Files:**
- Create: `shared/observe.ts`
- Modify: `shared/hook-bridge.ts`（`ConsoleEntry` 改为 re-export，保 hook 路径在 Task 11 前仍可用）
- Modify: `background/observe-store.ts`
- Modify: `tests/background/observe-store.test.ts`（既有断言适配 `wr:` 前缀）

**Interfaces:**
- Consumes: Task 1/2 无依赖
- Produces:
  - `shared/observe.ts`：`interface ConsoleEntry`
  - `observe-store`：`type WsFrame`；`function wrId(raw: string): string`；`function cdpId(raw: string): string`；`function setNetworkSuppressor(fn: (tabId: number) => boolean): void`；`function ingestCdpStart(tabId: number, r: { requestId: string; method: string; url: string; type: string; ts: number; requestHeaders?: Record<string, string>; requestBody?: string }): void`；`function ingestCdpResponse(tabId: number, r: { requestId: string; status: number; responseHeaders?: Record<string, string>; mimeType?: string }): void`；`function ingestCdpEnd(tabId: number, r: { requestId: string; ts: number }): void`；`function ingestCdpError(tabId: number, r: { requestId: string; error: string; ts: number }): void`；`function ingestCdpWsFrame(tabId: number, r: { requestId: string; dir: 'sent' | 'received'; opcode: number; payload: string; ts: number }): void`；`function getCdpEntry(tabId: number, requestId: string): NetEntry | undefined`；`function setCdpBody(tabId: number, requestId: string, r: { body: string; truncated: boolean }): void`
  - `NetEntry` 新增字段：`mimeType?: string`、`wsFrames?: WsFrame[]`；`source` 联合加 `'cdp'`

- [ ] **Step 1: Write the failing test**

在 `tests/background/observe-store.test.ts` 末尾追加。既有用例需同步适配 `wr:` 前缀，共 5 处：

- 第 43 行 `toMatchObject({ requestId: 'r1', ... })` → `'wr:r1'`
- 第 50 行 `readNetworkDetail(1, 'r2')` → `'wr:r2'`
- 第 59-61 行三处 `toEqual(['b'])` / `toEqual(['a'])` / `toEqual(['b'])` → `['wr:b']` / `['wr:a']` / `['wr:b']`
- 第 73 行 `readNetworkDetail(1, 'r1')` → `'wr:r1'`
- 第 83 行 `r.requestId.startsWith('hook:')` 不变（hook 独立条目 id 未改）

新增用例：

```ts
describe('network 缓冲：CDP 数据源', () => {
  it('ingest 全链路建条目，id 带 cdp: 前缀', () => {
    ingestCdpStart(1, { requestId: 'c1', method: 'POST', url: 'https://x.com/api', type: 'XHR', ts: 100, requestHeaders: { a: '1' }, requestBody: '{"q":1}' });
    ingestCdpResponse(1, { requestId: 'c1', status: 200, responseHeaders: { 'content-type': 'application/json' }, mimeType: 'application/json' });
    ingestCdpEnd(1, { requestId: 'c1', ts: 160 });
    const list = readNetworkList(1, {});
    expect(list[0]!).toMatchObject({ requestId: 'cdp:c1', status: 200, durationMs: 60, hasBody: true });
  });

  it('setCdpBody 落库并标 truncated', () => {
    ingestCdpStart(1, { requestId: 'c2', method: 'GET', url: 'https://x.com/a', type: 'Fetch', ts: 1 });
    setCdpBody(1, 'c2', { body: '{"ok":1}', truncated: false });
    expect(getCdpEntry(1, 'c2')!.responseBody).toBe('{"ok":1}');
  });

  it('ingestCdpError 记录错误', () => {
    ingestCdpStart(1, { requestId: 'c3', method: 'GET', url: 'https://x.com/b', type: 'XHR', ts: 1 });
    ingestCdpError(1, { requestId: 'c3', error: 'net::ERR_FAILED', ts: 9 });
    expect(getCdpEntry(1, 'c3')!.error).toBe('net::ERR_FAILED');
  });

  it('WS 帧挂到握手条目，超上限淘汰最早', () => {
    ingestCdpStart(1, { requestId: 'w1', method: 'GET', url: 'wss://x.com/s', type: 'WebSocket', ts: 1 });
    for (let i = 0; i < 210; i++) {
      ingestCdpWsFrame(1, { requestId: 'w1', dir: 'sent', opcode: 1, payload: `f${i}`, ts: i });
    }
    const frames = getCdpEntry(1, 'w1')!.wsFrames!;
    expect(frames).toHaveLength(200);
    expect(frames[frames.length - 1]!.payload).toBe('f209');
    expect(frames[0]!.payload).toBe('f10');
  });

  it('WS 单帧 payload 截断', () => {
    ingestCdpStart(1, { requestId: 'w2', method: 'GET', url: 'wss://x.com/s', type: 'WebSocket', ts: 1 });
    ingestCdpWsFrame(1, { requestId: 'w2', dir: 'received', opcode: 1, payload: 'y'.repeat(5000), ts: 1 });
    expect(getCdpEntry(1, 'w2')!.wsFrames![0]!.payload).toHaveLength(4096);
  });

  it('wr: 与 cdp: 前缀不撞号', () => {
    recordRequestStart(1, { requestId: 'same', method: 'GET', url: 'https://x.com/1', type: 'xmlhttprequest', ts: 1 });
    ingestCdpStart(1, { requestId: 'same', method: 'GET', url: 'https://x.com/2', type: 'XHR', ts: 2 });
    const ids = readNetworkList(1, {}).map((r) => r.requestId);
    expect(ids).toContain('wr:same');
    expect(ids).toContain('cdp:same');
  });

  it('抑制开启时 webRequest 三入口全部不落库', () => {
    setNetworkSuppressor((tabId) => tabId === 1);
    recordRequestStart(1, { requestId: 'r9', method: 'GET', url: 'https://x.com/z', type: 'xmlhttprequest', ts: 1 });
    recordRequestEnd('r9', { status: 200, ts: 2 });
    recordRequestError('r9', { error: 'x', ts: 3 });
    expect(readNetworkList(1, {})).toHaveLength(0);
    // 未抑制的 tab 不受影响
    recordRequestStart(2, { requestId: 'r10', method: 'GET', url: 'https://x.com/y', type: 'xmlhttprequest', ts: 1 });
    expect(readNetworkList(2, {})).toHaveLength(1);
    setNetworkSuppressor(() => false);
  });
});
```

同步更新文件头的 import：

```ts
import {
  resetStore, ingestConsole, ingestHookNet,
  recordRequestStart, recordRequestEnd, recordRequestError,
  readConsole, readNetworkList, readNetworkDetail, clearTab, clearTabNetwork,
  setNetworkSuppressor, ingestCdpStart, ingestCdpResponse, ingestCdpEnd,
  ingestCdpError, ingestCdpWsFrame, getCdpEntry, setCdpBody,
} from '../../background/observe-store';
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/background/observe-store.test.ts`
Expected: FAIL — `ingestCdpStart is not a function`（既有用例的 `wr:` 断言也失败）

- [ ] **Step 3: Write minimal implementation**

新建 `shared/observe.ts`：

```ts
// shared/observe.ts
// 观测数据的跨环境共享形状。原在 shared/hook-bridge.ts，hook 退役后独立成文件
// （hook-bridge 里的 window 桥协议与 hook 一同删除，ConsoleEntry 本身仍被 CDP 通道使用）。

/** 一条 console 观测。 */
export interface ConsoleEntry {
  id: string;      // 去重键（hook 时代为 `${loadNonce}:${seq}`，CDP 时代为 `cdp:${seq}`）
  level: string;   // log/info/warn/error/debug
  text: string;    // 序列化后的文本（已截断）
  ts: number;      // 采集时间戳
  url?: string;    // 采集时页面 URL
}
```

`shared/hook-bridge.ts` 顶部改为 re-export（其余内容不动）：

```ts
export type { ConsoleEntry } from './observe';
```
并删掉原地的 `ConsoleEntry` 接口定义。

`background/observe-store.ts` 改动：

```ts
import type { ConsoleEntry } from '../shared/observe';
```

`NetEntry` 与常量：

```ts
export const MAX_WS_FRAMES = 200;
export const MAX_WS_PAYLOAD = 4096;

/** 一条 WebSocket 帧。 */
export interface WsFrame { dir: 'sent' | 'received'; opcode: number; payload: string; ts: number }

export interface NetEntry {
  requestId: string;            // `wr:<webRequest id>` 或 `cdp:<CDP requestId>`
  method: string;
  url: string;
  type: string;
  ts: number;
  endTs?: number;
  status?: number;
  error?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBody?: string;
  responseBody?: string;
  mimeType?: string;
  wsFrames?: WsFrame[];
  truncated?: boolean;
  source: 'webRequest' | 'hook' | 'merged' | 'cdp';
}

/** id 命名空间前缀：webRequest 与 CDP 的 requestId 是两套独立空间，加前缀防撞号。 */
export function wrId(raw: string): string { return `wr:${raw}`; }
export function cdpId(raw: string): string { return `cdp:${raw}`; }
```

抑制钩子（放在 `tabs` 声明之后）：

```ts
// CDP 附着时该 tab 的网络由 CDP 独占，webRequest 主干静默（两套 id 无法对齐，硬合并只产生幽灵重复条目）。
let networkSuppressed: (tabId: number) => boolean = () => false;
export function setNetworkSuppressor(fn: (tabId: number) => boolean): void { networkSuppressed = fn; }
```

webRequest 三入口改造：

```ts
export function recordRequestStart(
  tabId: number,
  r: { requestId: string; method: string; url: string; type: string; ts: number },
): void {
  if (networkSuppressed(tabId)) return;
  const b = buf(tabId);
  b.network.push({ requestId: wrId(r.requestId), method: r.method, url: r.url, type: r.type, ts: r.ts, source: 'webRequest' });
  ring(b.network);
}

export function recordRequestEnd(requestId: string, r: { status: number; ts: number }): void {
  const e = findByRequestId(wrId(requestId));
  if (e) { e.status = r.status; e.endTs = r.ts; }
}

export function recordRequestError(requestId: string, r: { error: string; ts: number }): void {
  const e = findByRequestId(wrId(requestId));
  if (e) { e.error = r.error; e.endTs = r.ts; }
}
```

`ingestHookNet` 的独立条目 id 改为 `hook:${key}`（不变），但 `match` 条件加 `source === 'webRequest'` 已存在——保持原样即可。

新增 CDP 摄入块（放在 `ingestHookNet` 之后）：

```ts
// ---------- network：CDP 数据源 ----------
// CDP 的 requestId 在 session 内唯一，且摄入时已知道 tabId，故按 tab 内查找即可（无需全局扫描）。
function findCdp(tabId: number, requestId: string): NetEntry | undefined {
  const b = tabs.get(tabId);
  const id = cdpId(requestId);
  return b?.network.find((n) => n.requestId === id);
}

export function ingestCdpStart(
  tabId: number,
  r: { requestId: string; method: string; url: string; type: string; ts: number;
       requestHeaders?: Record<string, string>; requestBody?: string },
): void {
  const b = buf(tabId);
  b.network.push({
    requestId: cdpId(r.requestId), method: r.method, url: r.url, type: r.type, ts: r.ts,
    requestHeaders: r.requestHeaders, requestBody: r.requestBody, source: 'cdp',
  });
  ring(b.network);
}

export function ingestCdpResponse(
  tabId: number,
  r: { requestId: string; status: number; responseHeaders?: Record<string, string>; mimeType?: string },
): void {
  const e = findCdp(tabId, r.requestId);
  if (!e) return;
  e.status = r.status;
  if (r.responseHeaders) e.responseHeaders = r.responseHeaders;
  if (r.mimeType) e.mimeType = r.mimeType;
}

export function ingestCdpEnd(tabId: number, r: { requestId: string; ts: number }): void {
  const e = findCdp(tabId, r.requestId);
  if (e) e.endTs = r.ts;
}

export function ingestCdpError(tabId: number, r: { requestId: string; error: string; ts: number }): void {
  const e = findCdp(tabId, r.requestId);
  if (e) { e.error = r.error; e.endTs = r.ts; }
}

export function ingestCdpWsFrame(
  tabId: number,
  r: { requestId: string; dir: 'sent' | 'received'; opcode: number; payload: string; ts: number },
): void {
  const e = findCdp(tabId, r.requestId);
  if (!e) return;
  const frames = e.wsFrames ?? (e.wsFrames = []);
  frames.push({ dir: r.dir, opcode: r.opcode, payload: r.payload.slice(0, MAX_WS_PAYLOAD), ts: r.ts });
  if (frames.length > MAX_WS_FRAMES) frames.splice(0, frames.length - MAX_WS_FRAMES);
}

export function getCdpEntry(tabId: number, requestId: string): NetEntry | undefined {
  return findCdp(tabId, requestId);
}

export function setCdpBody(tabId: number, requestId: string, r: { body: string; truncated: boolean }): void {
  const e = findCdp(tabId, requestId);
  if (e) { e.responseBody = r.body; e.truncated = r.truncated; }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/background/observe-store.test.ts`
Expected: PASS（既有用例全绿 + 新增 7 个）

- [ ] **Step 5: Commit**

```bash
git add shared/observe.ts shared/hook-bridge.ts background/observe-store.ts tests/background/observe-store.test.ts
git commit -m "feat(cdp): observe-store 接纳 CDP 数据源（id 前缀 / WS 帧 / webRequest 抑制）"
```

---

### Task 4: CDP 会话层（`shared/cdp.ts` + `background/cdp/session.ts`）+ debugger 权限

**Files:**
- Create: `shared/cdp.ts`
- Create: `background/cdp/session.ts`
- Modify: `wxt.config.ts:22`
- Test: `tests/background/cdp-session.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `shared/cdp.ts`：`type DeepObserveStatus = 'off' | 'on' | 'error'`；`interface DeepObserveState { tabId: number; status: DeepObserveStatus; reason?: string }`；`interface DeepObserveStateNotification { type: 'DEEP_OBSERVE_STATE'; payload: { state: DeepObserveState } }`；`type DeepObserveRequest = { type: 'DEEP_OBSERVE_GET'; tabId: number } | { type: 'DEEP_OBSERVE_SET'; tabId: number; enabled: boolean }`
  - `session.ts`：`const PROTOCOL_VERSION = '1.3'`；`function initCdpSession(deps: { enableDomains: (tabId: number) => Promise<void>; onStateChange: (state: DeepObserveState) => void }): void`；`function getState(tabId: number): DeepObserveState`；`function isAttached(tabId: number): boolean`；`function rememberSession(tabId: number, sessionId: string): void`；`function forgetSession(tabId: number, sessionId: string): void`；`function tabIdForSession(sessionId: string): number | undefined`；`async function attach(tabId: number): Promise<{ ok: true; state: DeepObserveState } | { ok: false; error: string }>`；`async function detach(tabId: number): Promise<void>`；`function onDetached(tabId: number, reason: string): void`；`function markZombie(tabId: number): void`；`function forget(tabId: number): void`；`async function reconcile(): Promise<void>`；`function __resetCdpSession(): void`

- [ ] **Step 1: Write the failing test**

```ts
// tests/background/cdp-session.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  initCdpSession, attach, detach, getState, isAttached, onDetached, markZombie, forget, reconcile,
  rememberSession, forgetSession, tabIdForSession, __resetCdpSession,
} from '../../background/cdp/session';

let attachImpl: (t: unknown, v: string) => Promise<void>;
let detachImpl: (t: unknown) => Promise<void>;
let targets: Array<{ type: string; tabId?: number; attached: boolean }>;
let enableCalls: number[];
let stateCalls: Array<{ tabId: number; status: string }>;

beforeEach(() => {
  fakeBrowser.reset();
  __resetCdpSession();
  attachImpl = async () => {};
  detachImpl = async () => {};
  targets = [];
  enableCalls = [];
  stateCalls = [];
  (fakeBrowser as unknown as { debugger: unknown }).debugger = {
    attach: ((t: unknown, v: string) => attachImpl(t, v)) as never,
    detach: ((t: unknown) => detachImpl(t)) as never,
    getTargets: (async () => targets) as never,
  };
  initCdpSession({
    enableDomains: async (tabId) => { enableCalls.push(tabId); },
    onStateChange: (s) => { stateCalls.push({ tabId: s.tabId, status: s.status }); },
  });
});

describe('cdp session', () => {
  it('初始为 off', () => {
    expect(getState(1)).toEqual({ tabId: 1, status: 'off' });
    expect(isAttached(1)).toBe(false);
  });

  it('attach 成功 → on 态 + enable 域 + 广播', async () => {
    const r = await attach(1);
    expect(r).toEqual({ ok: true, state: { tabId: 1, status: 'on' } });
    expect(enableCalls).toEqual([1]);
    expect(stateCalls.at(-1)).toEqual({ tabId: 1, status: 'on' });
  });

  it('attach 幂等：已 on 时不重复 attach / enable', async () => {
    await attach(1);
    const spy = vi.fn(async () => {});
    attachImpl = spy;
    await attach(1);
    expect(spy).not.toHaveBeenCalled();
    expect(enableCalls).toEqual([1]);
  });

  it('attach 失败（DevTools 占用）→ error 态且不抛，返回 ok:false', async () => {
    attachImpl = async () => { throw new Error('Another debugger is already attached to the tab with id: 1'); };
    const r = await attach(1);
    expect(r.ok).toBe(false);
    expect(getState(1).status).toBe('error');
    expect(getState(1).reason).toContain('Another debugger');
    expect(stateCalls.at(-1)).toEqual({ tabId: 1, status: 'error' });
  });

  it('域启用失败不脱离会话（部分域可用优于完全不可用）', async () => {
    initCdpSession({
      enableDomains: async () => { throw new Error('boom'); },
      onStateChange: (s) => { stateCalls.push({ tabId: s.tabId, status: s.status }); },
    });
    const r = await attach(2);
    expect(r).toEqual({ ok: true, state: { tabId: 2, status: 'on' } });
  });

  it('detach 对未附着幂等（「not attached」抛错视为成功）', async () => {
    detachImpl = async () => { throw new Error('Debugger is not attached to the tab with id: 3'); };
    await expect(detach(3)).resolves.toBeUndefined();
    expect(getState(3).status).toBe('off');
  });

  it('onDetached(canceled_by_user) → error 态', () => {
    void attach(1);
    onDetached(1, 'canceled_by_user');
    expect(getState(1).status).toBe('error');
    expect(getState(1).reason).toBe('页面 DevTools 占用中');
  });

  it('onDetached(target_closed) → 清记录回 off', async () => {
    await attach(1);
    onDetached(1, 'target_closed');
    expect(getState(1)).toEqual({ tabId: 1, status: 'off' });
  });

  it('sessionId ↔ tabId 映射', () => {
    rememberSession(5, 's-a');
    expect(tabIdForSession('s-a')).toBe(5);
    forgetSession('s-a');
    expect(tabIdForSession('s-a')).toBeUndefined();
  });

  it('forget 清掉该 tab 的 session 映射', () => {
    rememberSession(6, 's-b');
    forget(6);
    expect(tabIdForSession('s-b')).toBeUndefined();
  });

  it('markZombie → error 态且清 session 映射', () => {
    rememberSession(10, 's-z');
    markZombie(10);
    expect(getState(10).status).toBe('error');
    expect(getState(10).reason).toBe('调试会话已失效，请重新开启');
    expect(tabIdForSession('s-z')).toBeUndefined();
  });

  it('reconcile：浏览器侧附着而内存无记录 → 补记录并 enable', async () => {
    targets = [{ type: 'page', tabId: 7, attached: true }];
    await reconcile();
    expect(getState(7).status).toBe('on');
    expect(enableCalls).toEqual([7]);
  });

  it('reconcile：内存有记录而浏览器侧未附着 → 清僵尸态', async () => {
    await attach(8);
    targets = [];
    await reconcile();
    expect(getState(8).status).toBe('off');
  });

  it('reconcile：一致时跳过，不重复 enable', async () => {
    targets = [{ type: 'page', tabId: 9, attached: true }];
    await reconcile();
    enableCalls.length = 0;
    await reconcile();
    expect(enableCalls).toEqual([]);
  });

  it('reconcile：getTargets 抛错时静默返回', async () => {
    (fakeBrowser as unknown as { debugger: { getTargets: unknown } }).debugger.getTargets =
      (async () => { throw new Error('unavailable'); }) as never;
    await expect(reconcile()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/background/cdp-session.test.ts`
Expected: FAIL — 无法解析 `../../background/cdp/session`

- [ ] **Step 3: Write minimal implementation**

`shared/cdp.ts`：

```ts
// shared/cdp.ts
// 深度观测（CDP）的跨环境类型：SW 权威状态 + 消息协议。
export type DeepObserveStatus = 'off' | 'on' | 'error';

export interface DeepObserveState {
  tabId: number;
  status: DeepObserveStatus;
  /** status==='error' 时的原因文案（附着失败 / DevTools 占用）。 */
  reason?: string;
}

/** SW → 面板广播（fire-and-forget，面板按 tabId 过滤）。 */
export interface DeepObserveStateNotification {
  type: 'DEEP_OBSERVE_STATE';
  payload: { state: DeepObserveState };
}

export type DeepObserveRequest =
  | { type: 'DEEP_OBSERVE_GET'; tabId: number }
  | { type: 'DEEP_OBSERVE_SET'; tabId: number; enabled: boolean };
```

`background/cdp/session.ts`：

```ts
// background/cdp/session.ts
// CDP 会话注册表（设计 §5.1）：附着/脱离、per-tab 状态、冷启动对账自愈。
// 依赖注入 enableDomains / onStateChange（domains.ts 反过来要用本模块的 tabIdForSession，
// 直接互相 import 会成环；background.ts 负责把两者接起来）。
import type { DeepObserveState } from '../../shared/cdp';

/** CDP 协议版本：'0.1' 起兼容，取当前稳定档。 */
export const PROTOCOL_VERSION = '1.3';
/** 被 DevTools 抢占时的原因文案。 */
export const DEVTOOLS_REASON = '页面 DevTools 占用中';

interface SessionRecord { status: 'on' | 'error'; reason?: string; sessions: Set<string> }

const records = new Map<number, SessionRecord>();
const sessionOwner = new Map<string, number>();

let enableDomains: ((tabId: number) => Promise<void>) | null = null;
let onStateChange: ((state: DeepObserveState) => void) | null = null;

export function initCdpSession(deps: {
  enableDomains: (tabId: number) => Promise<void>;
  onStateChange: (state: DeepObserveState) => void;
}): void {
  enableDomains = deps.enableDomains;
  onStateChange = deps.onStateChange;
}

export function getState(tabId: number): DeepObserveState {
  const rec = records.get(tabId);
  if (!rec) return { tabId, status: 'off' };
  return rec.status === 'on' ? { tabId, status: 'on' } : { tabId, status: 'error', reason: rec.reason };
}

export function isAttached(tabId: number): boolean {
  return records.get(tabId)?.status === 'on';
}

export function rememberSession(tabId: number, sessionId: string): void {
  sessionOwner.set(sessionId, tabId);
  records.get(tabId)?.sessions.add(sessionId);
}

export function forgetSession(sessionId: string): void {
  const tabId = sessionOwner.get(sessionId);
  sessionOwner.delete(sessionId);
  if (tabId != null) records.get(tabId)?.sessions.delete(sessionId);
}

export function tabIdForSession(sessionId: string): number | undefined {
  return sessionOwner.get(sessionId);
}

/** 清记录（含该 tab 的全部子 session 映射）。 */
export function forget(tabId: number): void {
  const rec = records.get(tabId);
  if (rec) for (const sid of rec.sessions) sessionOwner.delete(sid);
  records.delete(tabId);
}

function emit(tabId: number): void {
  onStateChange?.(getState(tabId));
}

export async function attach(
  tabId: number,
): Promise<{ ok: true; state: DeepObserveState } | { ok: false; error: string }> {
  if (isAttached(tabId)) return { ok: true, state: getState(tabId) };
  try {
    await browser.debugger.attach({ tabId }, PROTOCOL_VERSION);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    records.set(tabId, { status: 'error', reason, sessions: new Set() });
    emit(tabId);
    return { ok: false, error: `附着失败：${reason}（若页面已打开 DevTools，请先关闭再重试）` };
  }
  records.set(tabId, { status: 'on', sessions: new Set() });
  try {
    await enableDomains?.(tabId);
  } catch {
    // 域启用失败不脱离：部分域可用仍优于完全不可用。
  }
  emit(tabId);
  return { ok: true, state: getState(tabId) };
}

export async function detach(tabId: number): Promise<void> {
  try {
    await browser.debugger.detach({ tabId });
  } catch {
    // 未附着时 detach 抛「not attached」，视为成功（幂等）。
  }
  forget(tabId);
  emit(tabId);
}

/** 浏览器侧终止会话时的回调（tab 关闭 / 用户开 DevTools / 点信息条取消）。 */
export function onDetached(tabId: number, reason: string): void {
  if (reason === 'target_closed') { forget(tabId); emit(tabId); return; }
  records.set(tabId, { status: 'error', reason: DEVTOOLS_REASON, sessions: new Set() });
  emit(tabId);
}

/**
 * 僵尸态处理：sendCommand 抛「not attached」说明浏览器侧会话已消失而内存记账还在。
 * 清记录并落 error 态；**不自动重附着**——那会与用户开着的 DevTools 抢占成死循环。
 */
export function markZombie(tabId: number): void {
  forget(tabId);
  records.set(tabId, { status: 'error', reason: '调试会话已失效，请重新开启', sessions: new Set() });
  emit(tabId);
}

/**
 * 冷启动对账。附着是浏览器侧状态、跨 SW 重启存活，但本模块的内存记账会丢——
 * 只信内存标志位会得到「以为附着着、实际已断」的僵尸态，之后 sendCommand 抛 "Debugger is not attached"。
 */
export async function reconcile(): Promise<void> {
  let targets: Array<{ type: string; tabId?: number; attached: boolean }>;
  try {
    targets = await browser.debugger.getTargets();
  } catch {
    return; // 对账失败静默，下次冷启动自愈
  }
  const live = new Set(
    targets.filter((t) => t.type === 'page' && t.attached && t.tabId != null).map((t) => t.tabId!),
  );
  for (const tabId of [...records.keys()]) {
    if (!live.has(tabId)) { forget(tabId); emit(tabId); }
  }
  for (const tabId of live) {
    if (isAttached(tabId)) continue;
    // 子 session 映射无从恢复：重新 setAutoAttach 会让子 target 以新 sessionId 重新报到，
    // 旧映射的残留不影响正确性。
    records.set(tabId, { status: 'on', sessions: new Set() });
    try { await enableDomains?.(tabId); } catch { /* 同上：不脱离 */ }
    emit(tabId);
  }
}

/** 仅测试用：清空注册表与依赖。 */
export function __resetCdpSession(): void {
  records.clear();
  sessionOwner.clear();
  enableDomains = null;
  onStateChange = null;
}
```

`wxt.config.ts:22` 的 `permissions` 数组加 `'debugger'`：

```ts
    permissions: ['tabs', 'scripting', 'storage', 'sidePanel', 'webRequest', 'userScripts', 'notifications', 'clipboardWrite', 'offscreen', 'downloads', 'cookies', 'webNavigation', 'debugger'],
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/background/cdp-session.test.ts`
Expected: PASS（15 个用例）

- [ ] **Step 5: Commit**

```bash
git add shared/cdp.ts background/cdp/session.ts wxt.config.ts tests/background/cdp-session.test.ts
git commit -m "feat(cdp): 会话层（附着/脱离/冷启动对账）+ debugger 权限"
```

---

### Task 5: CDP 事件路由与摄入（`background/cdp/domains.ts`）

**Files:**
- Create: `background/cdp/domains.ts`
- Test: `tests/background/cdp-domains.test.ts`

**Interfaces:**
- Consumes: Task 1 `serializeRemoteObjects`/`RemoteObjectLike`；Task 2 `shouldFetchBody`/`fetchBody`；Task 3 `observe-store` 的 CDP 摄入 API；Task 4 `rememberSession`/`forgetSession`/`tabIdForSession`
- Produces: `async function enableAll(tabId: number): Promise<void>`；`async function handleEvent(tabId: number, sessionId: string | undefined, method: string, params: Record<string, unknown>): Promise<void>`；`function __resetCdpDomains(): void`

- [ ] **Step 1: Write the failing test**

```ts
// tests/background/cdp-domains.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { enableAll, handleEvent, __resetCdpDomains } from '../../background/cdp/domains';
import { initCdpSession, rememberSession, __resetCdpSession } from '../../background/cdp/session';
import { resetStore, readConsole, readNetworkList, getCdpEntry } from '../../background/observe-store';

let commands: Array<{ method: string; params?: Record<string, unknown>; sessionId?: string }>;
let bodyReply: { body: string; base64Encoded: boolean } | null;

beforeEach(() => {
  fakeBrowser.reset();
  resetStore();
  __resetCdpSession();
  __resetCdpDomains();
  commands = [];
  bodyReply = null;
  (fakeBrowser as unknown as { debugger: unknown }).debugger = {
    sendCommand: (async (target: { sessionId?: string }, method: string, params?: Record<string, unknown>) => {
      commands.push({ method, params, sessionId: target.sessionId });
      if (method === 'Network.getResponseBody') return bodyReply ?? (() => { throw new Error('gone'); })();
      return {};
    }) as never,
  };
  initCdpSession({ enableDomains: enableAll, onStateChange: () => {} });
});

describe('enableAll', () => {
  it('启用四域并 setAutoAttach（waitForDebuggerOnStart 必须为 false）', async () => {
    await enableAll(1);
    const methods = commands.map((c) => c.method);
    expect(methods).toEqual([
      'Network.enable', 'Runtime.enable', 'Log.enable', 'Page.enable', 'Target.setAutoAttach',
    ]);
    const auto = commands.find((c) => c.method === 'Target.setAutoAttach')!;
    expect(auto.params).toEqual({ autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  });
});

describe('handleEvent：网络', () => {
  it('requestWillBeSent → responseReceived → loadingFinished 全链路', async () => {
    await handleEvent(1, undefined, 'Network.requestWillBeSent', {
      requestId: 'c1', timestamp: 1, wallTime: 1000,
      request: { url: 'https://x.com/api', method: 'POST', headers: { a: '1' }, postData: '{"q":1}' },
      type: 'XHR',
    });
    await handleEvent(1, undefined, 'Network.responseReceived', {
      requestId: 'c1', response: { status: 200, headers: { 'content-type': 'application/json' }, mimeType: 'application/json' },
    });
    bodyReply = { body: '{"ok":1}', base64Encoded: false };
    await handleEvent(1, undefined, 'Network.loadingFinished', { requestId: 'c1', timestamp: 1.5 });
    const list = readNetworkList(1, {});
    expect(list[0]!).toMatchObject({ requestId: 'cdp:c1', method: 'POST', status: 200, hasBody: true });
    expect(getCdpEntry(1, 'c1')!.responseBody).toBe('{"ok":1}');
  });

  it('白名单外类型不拉响应体', async () => {
    await handleEvent(1, undefined, 'Network.requestWillBeSent', {
      requestId: 'i1', timestamp: 1, request: { url: 'https://x.com/a.png', method: 'GET', headers: {} }, type: 'Image',
    });
    await handleEvent(1, undefined, 'Network.responseReceived', {
      requestId: 'i1', response: { status: 200, headers: {}, mimeType: 'image/png' },
    });
    commands.length = 0;
    await handleEvent(1, undefined, 'Network.loadingFinished', { requestId: 'i1', timestamp: 2 });
    expect(commands.map((c) => c.method)).not.toContain('Network.getResponseBody');
  });

  it('loadingFailed → 错误落库', async () => {
    await handleEvent(1, undefined, 'Network.requestWillBeSent', {
      requestId: 'e1', timestamp: 1, request: { url: 'https://x.com/b', method: 'GET', headers: {} }, type: 'Fetch',
    });
    await handleEvent(1, undefined, 'Network.loadingFailed', { requestId: 'e1', timestamp: 2, errorText: 'net::ERR_FAILED' });
    expect(getCdpEntry(1, 'e1')!.error).toBe('net::ERR_FAILED');
  });

  it('WS 帧挂到握手条目', async () => {
    await handleEvent(1, undefined, 'Network.requestWillBeSent', {
      requestId: 'w1', timestamp: 1, request: { url: 'wss://x.com/s', method: 'GET', headers: {} }, type: 'WebSocket',
    });
    await handleEvent(1, undefined, 'Network.webSocketFrameSent', {
      requestId: 'w1', timestamp: 2, response: { opcode: 1, payloadData: 'ping' },
    });
    await handleEvent(1, undefined, 'Network.webSocketFrameReceived', {
      requestId: 'w1', timestamp: 3, response: { opcode: 1, payloadData: 'pong' },
    });
    expect(getCdpEntry(1, 'w1')!.wsFrames).toEqual([
      { dir: 'sent', opcode: 1, payload: 'ping', ts: expect.any(Number) },
      { dir: 'received', opcode: 1, payload: 'pong', ts: expect.any(Number) },
    ]);
  });
});

describe('handleEvent：console', () => {
  it('consoleAPICalled → 摄入，级别映射 warning→warn', async () => {
    await handleEvent(1, undefined, 'Runtime.consoleAPICalled', {
      type: 'warning', timestamp: 1, args: [{ type: 'string', value: 'careful' }],
    });
    const msgs = readConsole(1, {});
    expect(msgs[0]!).toMatchObject({ level: 'warn', text: 'careful' });
  });

  it('exceptionThrown → error 级 console 条目', async () => {
    await handleEvent(1, undefined, 'Runtime.exceptionThrown', {
      timestamp: 1,
      exceptionDetails: { text: 'Uncaught', exception: { description: 'Error: boom' } },
    });
    expect(readConsole(1, { level: 'error' })[0]!.text).toBe('Uncaught Error: boom');
  });

  it('Log.entryAdded → 摄入（CSP 违规等浏览器级条目）', async () => {
    await handleEvent(1, undefined, 'Log.entryAdded', {
      entry: { source: 'security', level: 'error', text: 'Refused to load the script', url: 'https://x.com/' },
    });
    expect(readConsole(1, { level: 'error' })[0]!.text).toBe('Refused to load the script');
  });
});

describe('handleEvent：子 target 路由', () => {
  it('attachedToTarget → 记映射 + 对子 session 单独 enable（不再 setAutoAttach）', async () => {
    await handleEvent(1, undefined, 'Target.attachedToTarget', { sessionId: 's1', targetInfo: { type: 'iframe' } });
    expect(commands.map((c) => c.method)).toEqual(['Network.enable', 'Runtime.enable', 'Log.enable']);
    expect(commands.every((c) => c.sessionId === 's1')).toBe(true);
  });

  it('子 session 的事件按 sessionId 归到所属 tab', async () => {
    rememberSession(3, 's9');
    await handleEvent(3, 's9', 'Runtime.consoleAPICalled', {
      type: 'log', timestamp: 1, args: [{ type: 'string', value: 'from-iframe' }],
    });
    expect(readConsole(3, {})[0]!.text).toBe('from-iframe');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/background/cdp-domains.test.ts`
Expected: FAIL — 无法解析 `../../background/cdp/domains`

- [ ] **Step 3: Write minimal implementation**

```ts
// background/cdp/domains.ts
// CDP 域启用 + 事件 → observe-store 摄入（设计 §5.2）。
import { serializeRemoteObjects, type RemoteObjectLike } from './console-text';
import { shouldFetchBody, fetchBody } from './bodies';
import { rememberSession, forgetSession } from './session';
import {
  ingestCdpStart, ingestCdpResponse, ingestCdpEnd, ingestCdpError,
  ingestCdpWsFrame, getCdpEntry, setCdpBody, ingestConsole,
} from '../observe-store';
import type { ConsoleEntry } from '../../shared/observe';

const MAX_TOTAL_BUFFER = 10 * 1024 * 1024;
const MAX_RESOURCE_BUFFER = 5 * 1024 * 1024;

let consoleSeq = 0;

/** 仅测试用：重置内部计数器。 */
export function __resetCdpDomains(): void { consoleSeq = 0; }

async function cmd(
  tabId: number, sessionId: string | undefined, method: string, params?: Record<string, unknown>,
): Promise<unknown> {
  return browser.debugger.sendCommand({ tabId, sessionId }, method, params);
}

/** 主 target 的域启用。子 session 只走 enableChild（不再 setAutoAttach，避免无限递归）。 */
export async function enableAll(tabId: number): Promise<void> {
  await cmd(tabId, undefined, 'Network.enable', {
    maxTotalBufferSize: MAX_TOTAL_BUFFER, maxResourceBufferSize: MAX_RESOURCE_BUFFER,
  });
  await cmd(tabId, undefined, 'Runtime.enable');
  await cmd(tabId, undefined, 'Log.enable');
  await cmd(tabId, undefined, 'Page.enable');
  await cmd(tabId, undefined, 'Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: false, // 必须 false：置 true 会把页面冻在启动断点上
    flatten: true,
  });
}

async function enableChild(tabId: number, sessionId: string): Promise<void> {
  await cmd(tabId, sessionId, 'Network.enable', {
    maxTotalBufferSize: MAX_TOTAL_BUFFER, maxResourceBufferSize: MAX_RESOURCE_BUFFER,
  }).catch(() => {});
  await cmd(tabId, sessionId, 'Runtime.enable').catch(() => {});
  await cmd(tabId, sessionId, 'Log.enable').catch(() => {});
}

/** CDP 时间戳：优先 wallTime（epoch 秒），退回本地时钟。 */
function tsOf(params: Record<string, unknown>): number {
  const wall = params.wallTime;
  if (typeof wall === 'number') return Math.round(wall * 1000);
  return Date.now();
}

/** Runtime.consoleAPICalled 的 type → 我们的 level 词表。 */
function consoleLevel(type: string): string {
  if (type === 'error' || type === 'assert') return 'error';
  if (type === 'warning') return 'warn';
  if (type === 'info') return 'info';
  if (type === 'debug' || type === 'verbose') return 'debug';
  return 'log';
}

function pushConsole(tabId: number, level: string, text: string, ts: number, url?: string): void {
  const entry: ConsoleEntry = { id: `cdp:${++consoleSeq}`, level, text, ts, url };
  ingestConsole(tabId, [entry]);
}

export async function handleEvent(
  tabId: number,
  sessionId: string | undefined,
  method: string,
  params: Record<string, unknown>,
): Promise<void> {
  switch (method) {
    case 'Target.attachedToTarget': {
      const sid = params.sessionId as string | undefined;
      if (!sid) return;
      rememberSession(tabId, sid);
      await enableChild(tabId, sid);
      return;
    }
    case 'Target.detachedFromTarget': {
      const sid = params.sessionId as string | undefined;
      if (sid) forgetSession(sid);
      return;
    }
    case 'Network.requestWillBeSent': {
      const req = params.request as { url?: string; method?: string; headers?: Record<string, string>; postData?: string } | undefined;
      if (!req?.url) return;
      ingestCdpStart(tabId, {
        requestId: params.requestId as string,
        method: req.method ?? 'GET',
        url: req.url,
        type: (params.type as string) ?? 'Other',
        ts: tsOf(params),
        requestHeaders: req.headers,
        requestBody: typeof req.postData === 'string' ? req.postData : undefined,
      });
      return;
    }
    case 'Network.responseReceived': {
      const res = params.response as { status?: number; headers?: Record<string, string>; mimeType?: string } | undefined;
      if (!res) return;
      ingestCdpResponse(tabId, {
        requestId: params.requestId as string,
        status: res.status ?? 0,
        responseHeaders: res.headers,
        mimeType: res.mimeType,
      });
      return;
    }
    case 'Network.loadingFinished': {
      const requestId = params.requestId as string;
      ingestCdpEnd(tabId, { requestId, ts: tsOf(params) });
      const entry = getCdpEntry(tabId, requestId);
      if (!entry || !shouldFetchBody(entry.type, entry.mimeType)) return;
      const body = await fetchBody(tabId, sessionId, requestId);
      if (body) setCdpBody(tabId, requestId, body);
      return;
    }
    case 'Network.loadingFailed': {
      ingestCdpError(tabId, {
        requestId: params.requestId as string,
        error: (params.errorText as string) ?? 'unknown',
        ts: tsOf(params),
      });
      return;
    }
    case 'Network.webSocketFrameSent':
    case 'Network.webSocketFrameReceived': {
      const frame = params.response as { opcode?: number; payloadData?: string } | undefined;
      if (!frame) return;
      ingestCdpWsFrame(tabId, {
        requestId: params.requestId as string,
        dir: method.endsWith('Sent') ? 'sent' : 'received',
        opcode: frame.opcode ?? 0,
        payload: frame.payloadData ?? '',
        ts: tsOf(params),
      });
      return;
    }
    case 'Runtime.consoleAPICalled': {
      const args = (params.args ?? []) as RemoteObjectLike[];
      pushConsole(tabId, consoleLevel((params.type as string) ?? 'log'), serializeRemoteObjects(args), tsOf(params));
      return;
    }
    case 'Runtime.exceptionThrown': {
      const d = params.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined;
      if (!d) return;
      const text = [d.text, d.exception?.description].filter(Boolean).join(' ');
      pushConsole(tabId, 'error', text, tsOf(params));
      return;
    }
    case 'Log.entryAdded': {
      const e = params.entry as { level?: string; text?: string; url?: string } | undefined;
      if (!e?.text) return;
      pushConsole(tabId, consoleLevel(e.level ?? 'info'), e.text, tsOf(params), e.url);
      return;
    }
    default:
      return;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/background/cdp-domains.test.ts`
Expected: PASS（10 个用例）

- [ ] **Step 5: Commit**

```bash
git add background/cdp/domains.ts tests/background/cdp-domains.test.ts
git commit -m "feat(cdp): 域启用 + 事件摄入路由（含子 target flatten）"
```

---

### Task 6: background 接线 + 消息 handler

**Files:**
- Modify: `entrypoints/background.ts`
- Modify: `shared/messages.ts`
- Test: `tests/background/cdp-messages.test.ts`

**Interfaces:**
- Consumes: Task 3 `setNetworkSuppressor`；Task 4 `initCdpSession`/`attach`/`detach`/`getState`/`onDetached`/`forget`/`reconcile`/`tabIdForSession`；Task 5 `enableAll`/`handleEvent`
- Produces: router 支持 `DEEP_OBSERVE_GET` / `DEEP_OBSERVE_SET`；`initCdp(router: RouterLike): void`；`attachCdpListeners(): void`

- [ ] **Step 1: Write the failing test**

```ts
// tests/background/cdp-messages.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { initCdp } from '../../background/cdp/init';
import { __resetCdpSession } from '../../background/cdp/session';
import { MessageRouter } from '../../background/router';

let attachFails = false;

function makeRouter(): MessageRouter {
  const router = new MessageRouter();
  initCdp(router);
  return router;
}

beforeEach(() => {
  fakeBrowser.reset();
  __resetCdpSession();
  attachFails = false;
  (fakeBrowser as unknown as { debugger: unknown }).debugger = {
    attach: (async () => { if (attachFails) throw new Error('Another debugger is already attached'); }) as never,
    detach: (async () => {}) as never,
    sendCommand: (async () => ({})) as never,
    getTargets: (async () => []) as never,
  };
});

describe('DEEP_OBSERVE 消息', () => {
  it('GET 未附着返回 off', async () => {
    const r = await makeRouter().dispatch({ type: 'DEEP_OBSERVE_GET', tabId: 1 });
    expect(r).toEqual({ ok: true, data: { tabId: 1, status: 'off' } });
  });

  it('SET enabled=true → on', async () => {
    const router = makeRouter();
    const r = await router.dispatch({ type: 'DEEP_OBSERVE_SET', tabId: 1, enabled: true });
    expect(r).toEqual({ ok: true, data: { tabId: 1, status: 'on' } });
  });

  it('SET enabled=false → off（幂等）', async () => {
    const router = makeRouter();
    await router.dispatch({ type: 'DEEP_OBSERVE_SET', tabId: 1, enabled: true });
    const r = await router.dispatch({ type: 'DEEP_OBSERVE_SET', tabId: 1, enabled: false });
    expect(r).toEqual({ ok: true, data: { tabId: 1, status: 'off' } });
  });

  it('attach 失败返回 ok:false 且状态落 error', async () => {
    attachFails = true;
    const router = makeRouter();
    const r = await router.dispatch({ type: 'DEEP_OBSERVE_SET', tabId: 1, enabled: true });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('附着失败');
    const g = await router.dispatch({ type: 'DEEP_OBSERVE_GET', tabId: 1 });
    expect((g as { data: { status: string } }).data.status).toBe('error');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/background/cdp-messages.test.ts`
Expected: FAIL — 无法解析 `../../background/cdp/init`

- [ ] **Step 3: Write minimal implementation**

新建 `background/cdp/init.ts`（把接线从 `entrypoints/background.ts` 抽出来，便于单测）：

```ts
// background/cdp/init.ts
// 深度观测的 SW 接线（设计 §5.6）：会话 ↔ 域启用互接、状态广播、消息 handler。
// 抽成独立模块是为了能在单测里挂到 MessageRouter 上，不必启动整个 background。
import { enableAll, handleEvent } from './domains';
import {
  initCdpSession, attach, detach, getState, onDetached, markZombie, forget, reconcile, tabIdForSession,
} from './session';
import { setNetworkSuppressor } from '../observe-store';
import type { DeepObserveState } from '../../shared/cdp';

interface RouterLike { on(type: string, handler: (msg: Record<string, unknown>) => unknown): void }

/** 在 SW 顶层同步调用：注册 debugger 事件监听 + 消息 handler + 网络抑制钩子。 */
export function initCdp(router: RouterLike): void {
  initCdpSession({
    enableDomains: enableAll,
    onStateChange: (state: DeepObserveState) => {
      void browser.runtime.sendMessage({ type: 'DEEP_OBSERVE_STATE', payload: { state } }).catch(() => {});
    },
  });

  // CDP 附着时该 tab 的网络由 CDP 独占（observe-store 侧判定）。
  setNetworkSuppressor((tabId) => getState(tabId).status === 'on');

  router.on('DEEP_OBSERVE_GET', async (msg) => {
    const { tabId } = msg as unknown as { tabId: number };
    return { ok: true, data: getState(tabId) };
  });
  router.on('DEEP_OBSERVE_SET', async (msg) => {
    const { tabId, enabled } = msg as unknown as { tabId: number; enabled: boolean };
    if (!enabled) {
      await detach(tabId);
      return { ok: true, data: getState(tabId) };
    }
    const r = await attach(tabId);
    return r.ok ? { ok: true, data: r.state } : { ok: false, error: r.error };
  });

  // 冷启动对账：附着跨 SW 重启存活，但内存记账会丢。
  void reconcile().catch(() => {});
}

/** 在 SW 顶层同步注册 debugger 事件监听。
 *  MV3 下 SW 重启后事件可能早于异步初始化到达，顶层同步注册是唯一能保证收到的写法。 */
export function attachCdpListeners(): void {
  browser.debugger.onEvent.addListener((source, method, params) => {
    const tabId = source.tabId ?? (source.sessionId ? tabIdForSession(source.sessionId) : undefined);
    if (tabId == null) return;
    void handleEvent(tabId, source.sessionId, method, (params ?? {}) as Record<string, unknown>)
      .catch((err: unknown) => {
        // 「not attached」= 浏览器侧会话已消失而内存记账还在的僵尸态（spec §8）。
        if (/not attached/i.test(err instanceof Error ? err.message : String(err))) markZombie(tabId);
      });
  });
  browser.debugger.onDetach.addListener((source, reason) => {
    if (source.tabId == null) return;
    onDetached(source.tabId, reason);
  });
  browser.tabs.onRemoved.addListener((tabId) => forget(tabId));
}
```

`shared/messages.ts` 末尾追加（并更新文件头注释里的「HookConsoleNotification / HookNetworkNotification」指向）：

```ts
// ---------- 深度观测（CDP）（sidepanel → bg request/response，走 MessageRouter）----------
// 类型定义在 shared/cdp.ts（agent 工具与 SW 也消费），此处 re-export 保持消息协议单一入口。
export type { DeepObserveState, DeepObserveStateNotification, DeepObserveRequest } from './cdp';
```

`entrypoints/background.ts`：加 import 与调用。

```ts
import { initCdp, attachCdpListeners } from '../background/cdp/init';
```

在 `attachAgentPort(); attachObservers();` 之后、`initScriptsModule(router);` 之前插入：

```ts
  // 深度观测（CDP）：事件监听与消息 handler 必须在 SW 顶层同步注册。
  attachCdpListeners();
  initCdp(router);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/background/cdp-messages.test.ts`
Expected: PASS（4 个用例）

- [ ] **Step 5: 跑全量测试确认无回归**

Run: `npm run test`
Expected: 全部 PASS（本 task 只加不改，既有用例不受影响）

- [ ] **Step 6: Commit**

```bash
git add background/cdp/init.ts shared/messages.ts entrypoints/background.ts tests/background/cdp-messages.test.ts
git commit -m "feat(cdp): background 接线（事件监听 + DEEP_OBSERVE 消息 + 网络抑制）"
```

---

### Task 7: 两个模型工具（enable / disable deep observe）

**Files:**
- Create: `agent/tools/deep-observe.ts`
- Modify: `agent/tools/schemas.ts`
- Modify: `agent/tools/registry.ts`
- Modify: `agent/mode.ts`
- Test: `tests/agent/deep-observe.test.ts`

**Interfaces:**
- Consumes: Task 4 `attach`/`detach`/`getState`
- Produces: `async function doEnableDeepObserve(tabId: number): Promise<ToolResult>`；`async function doDisableDeepObserve(tabId: number): Promise<ToolResult>`

- [ ] **Step 1: Write the failing test**

```ts
// tests/agent/deep-observe.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { doEnableDeepObserve, doDisableDeepObserve } from '../../agent/tools/deep-observe';
import { executeTool } from '../../agent/tools/registry';
import { __resetCdpSession } from '../../background/cdp/session';

let attachFails = false;

beforeEach(() => {
  fakeBrowser.reset();
  __resetCdpSession();
  attachFails = false;
  (fakeBrowser as unknown as { debugger: unknown }).debugger = {
    attach: (async () => { if (attachFails) throw new Error('Another debugger is already attached'); }) as never,
    detach: (async () => {}) as never,
    sendCommand: (async () => ({})) as never,
    getTargets: (async () => []) as never,
  };
});

describe('deep observe 工具', () => {
  it('enable → ok，data 带 tabId 与 on', async () => {
    await expect(doEnableDeepObserve(1)).resolves.toEqual({ ok: true, data: { tabId: 1, status: 'on' } });
  });

  it('enable 失败 → ok:false 且文案含附着失败', async () => {
    attachFails = true;
    const r = await doEnableDeepObserve(1);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain('附着失败');
  });

  it('disable → off，对未附着幂等', async () => {
    await expect(doDisableDeepObserve(1)).resolves.toEqual({ ok: true, data: { tabId: 1, status: 'off' } });
  });
});

describe('工具分发与模式', () => {
  it('registry 分发两个新工具', async () => {
    const r = await executeTool('enable_deep_observe', {}, { tabId: 1, sessionId: 's', signal: new AbortController().signal });
    expect(r.ok).toBe(true);
  });

  it('ask 模式放行（诊断主场，只读观测工具依赖它）', async () => {
    const r = await executeTool('enable_deep_observe', {}, { tabId: 1, sessionId: 's', signal: new AbortController().signal, mode: 'ask' });
    expect(r.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agent/deep-observe.test.ts`
Expected: FAIL — 无法解析 `../../agent/tools/deep-observe`

- [ ] **Step 3: Write minimal implementation**

`agent/tools/deep-observe.ts`：

```ts
// agent/tools/deep-observe.ts
// 深度观测（CDP）开关工具（设计 §4.1）。无参数，作用于 agent 当前标签页。
// 授权模型：直接附着，Chrome 信息条即提示与撤销入口（spec 决策 2）——不弹确认卡。
import type { ToolResult } from '../../shared/types';
import { attach, detach, getState } from '../../background/cdp/session';

export async function doEnableDeepObserve(tabId: number): Promise<ToolResult> {
  const r = await attach(tabId);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, data: { tabId, status: r.state.status } };
}

export async function doDisableDeepObserve(tabId: number): Promise<ToolResult> {
  await detach(tabId);
  return { ok: true, data: { tabId, status: getState(tabId).status } };
}
```

`agent/tools/schemas.ts`：在 `get_network_request` 之后插入两条。

```ts
  {
    type: 'function',
    function: {
      name: 'enable_deep_observe',
      description:
        '为当前操作目标页面开启「深度观测」（CDP/chrome.debugger 附着）。开启后能拿到完整网络观测（全量响应体、含浏览器自动头的完整请求/响应头、WebSocket 帧、跨域 iframe 与 Web Worker 内的请求）与完整控制台（带调用堆栈、CSP 违规等浏览器级条目）。代价：页面顶部会出现 Chrome 的「正在调试此浏览器」提示条（用户可点取消关闭），且附着期间用户无法为该页打开 DevTools——若用户已打开 DevTools 会附着失败。默认关闭。当 list_console_messages 返回空或 get_network_request 提示缺 body/headers 时，可调用本工具。',
      parameters: obj({}),
    },
  },
  {
    type: 'function',
    function: {
      name: 'disable_deep_observe',
      description: '关闭当前操作目标页面的「深度观测」，解除 CDP 附着（页面顶部的调试提示条随之消失，用户可重新打开 DevTools）。关闭后网络观测退回只有元数据（无响应体与请求头）、控制台观测不可用。未开启时调用是幂等的。',
      parameters: obj({}),
    },
  },
```

`agent/tools/registry.ts`：加 import，并在「观测类工具」那组之前插入分发（这两个工具不碰页面内容，与 `list_pages` 同属受限页预检豁免）。

```ts
import { doEnableDeepObserve, doDisableDeepObserve } from './deep-observe';
```

```ts
  // 深度观测开关：只操作 debugger 附着，不碰页面内容，豁免受限页预检。
  if (name === 'enable_deep_observe') return doEnableDeepObserve(ctx.tabId);
  if (name === 'disable_deep_observe') return doDisableDeepObserve(ctx.tabId);
```

`agent/mode.ts`：`ASK_MODE_TOOLS` 的 `'get_network_request',` 之后加两行。

```ts
  'enable_deep_observe',   // 深度观测开关：ask 的诊断主场，只读观测工具依赖它（spec §4.3）
  'disable_deep_observe',
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/agent/deep-observe.test.ts`
Expected: PASS（5 个用例）

- [ ] **Step 5: 跑 agent 目录全量测试**

Run: `npx vitest run tests/agent`
Expected: 全部 PASS。已核实全仓库**没有**硬编码工具总数的断言，唯一相关的是 `tests/agent/mode.test.ts:58` 的 `expect(ask.length).toBe(ASK_MODE_TOOLS.size)`——它是派生量，本 task 同时加 schema 与白名单条目即自然保持一致。若有其它断言意外失败，同步其期望值。另把 `agent/tools/schemas.ts` 文件头注释里过时的「36 个工具」计数更新为 38。

- [ ] **Step 6: Commit**

```bash
git add agent/tools/deep-observe.ts agent/tools/schemas.ts agent/tools/registry.ts agent/mode.ts tests/agent/deep-observe.test.ts
git commit -m "feat(cdp): enable/disable_deep_observe 工具（ask 模式放行）"
```

---

### Task 8: 观测工具的降级语义

CDP 关闭时三个观测工具不报错，返回 `deepObserve: false` + `hint`。

**Files:**
- Modify: `agent/tools/observe.ts`
- Modify: `agent/tools/schemas.ts`（三条描述补一句）
- Test: `tests/agent/observe-degrade.test.ts`

**Interfaces:**
- Consumes: Task 4 `getState`
- Produces: 三个工具的 `data` 增加 `deepObserve: boolean`，CDP 关闭时附 `hint: string`

- [ ] **Step 1: Write the failing test**

```ts
// tests/agent/observe-degrade.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  doListConsoleMessages, doListNetworkRequests, doGetNetworkRequest,
} from '../../agent/tools/observe';
import { initCdpSession, __resetCdpSession } from '../../background/cdp/session';
import { resetStore, recordRequestStart } from '../../background/observe-store';

beforeEach(() => {
  fakeBrowser.reset();
  resetStore();
  __resetCdpSession();
  (fakeBrowser as unknown as { debugger: unknown }).debugger = {
    attach: (async () => {}) as never, detach: (async () => {}) as never,
    sendCommand: (async () => ({})) as never, getTargets: (async () => []) as never,
  };
});

describe('CDP 关闭时的降级语义', () => {
  it('list_console_messages 返回空 + deepObserve:false + hint', async () => {
    const r = await doListConsoleMessages(1, {});
    expect(r.ok).toBe(true);
    const d = (r as { data: { messages: unknown[]; deepObserve: boolean; hint?: string } }).data;
    expect(d.messages).toEqual([]);
    expect(d.deepObserve).toBe(false);
    expect(d.hint).toContain('enable_deep_observe');
  });

  it('list_network_requests 仍返回 webRequest 元数据 + deepObserve:false', async () => {
    recordRequestStart(1, { requestId: 'r1', method: 'GET', url: 'https://x.com/a', type: 'xmlhttprequest', ts: 1 });
    const r = await doListNetworkRequests(1, {});
    const d = (r as { data: { requests: unknown[]; deepObserve: boolean } }).data;
    expect(d.requests).toHaveLength(1);
    expect(d.deepObserve).toBe(false);
  });

  it('get_network_request 对无 body 条目附 hint', async () => {
    recordRequestStart(1, { requestId: 'r1', method: 'GET', url: 'https://x.com/a', type: 'xmlhttprequest', ts: 1 });
    const r = await doGetNetworkRequest(1, { requestId: 'wr:r1' });
    const d = (r as { data: { deepObserve: boolean; hint?: string } }).data;
    expect(d.deepObserve).toBe(false);
    expect(d.hint).toContain('enable_deep_observe');
  });
});

describe('CDP 开启时不加 hint', () => {
  it('deepObserve:true 且无 hint', async () => {
    initCdpSession({ enableDomains: async () => {}, onStateChange: () => {} });
    (fakeBrowser as unknown as { debugger: { attach: unknown } }).debugger.attach = (async () => {}) as never;
    const { attach } = await import('../../background/cdp/session');
    await attach(1);
    const r = await doListConsoleMessages(1, {});
    const d = (r as { data: { deepObserve: boolean; hint?: string } }).data;
    expect(d.deepObserve).toBe(true);
    expect(d.hint).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agent/observe-degrade.test.ts`
Expected: FAIL — `data.deepObserve` 为 `undefined`

- [ ] **Step 3: Write minimal implementation**

`agent/tools/observe.ts` 改为：

```ts
// agent/tools/observe.ts
// 观测三工具执行器（设计 §6）：读 SW observe-store 缓冲，零 content script 往返。
// get_network_request 读取时按 settings.agent.networkCaptureHeaders 脱敏（设计 §4.3）。
// 降级语义（CDP spec §4.2）：深度观测未开启时不报错，返回 deepObserve:false + hint。
import type { ToolResult } from '../../shared/types';
import { getSettings } from '../../storage/settings';
import { redactHeaders } from '../../observe/redact';
import { readConsole, readNetworkList, readNetworkDetail } from '../../background/observe-store';
import { getState } from '../../background/cdp/session';

const CONSOLE_HINT =
  '控制台观测需要深度观测（CDP），当前未开启；可调用 enable_deep_observe 开启'
  + '（会在页面顶部显示 Chrome 调试提示条，且与页面 DevTools 互斥）';
const NETWORK_HINT =
  '当前只有 webRequest 元数据（无响应体、无请求头）；要看这些内容可调用 enable_deep_observe 开启深度观测';

function isDeepObserve(tabId: number): boolean {
  return getState(tabId).status === 'on';
}

export async function doListConsoleMessages(
  tabId: number,
  args: { level?: string; limit?: number },
): Promise<ToolResult> {
  const deepObserve = isDeepObserve(tabId);
  const messages = readConsole(tabId, { level: args.level, limit: args.limit });
  if (deepObserve) return { ok: true, data: { messages, deepObserve } };
  return { ok: true, data: { messages, deepObserve, hint: CONSOLE_HINT } };
}

export async function doListNetworkRequests(
  tabId: number,
  args: { method?: string; urlContains?: string; status?: number; limit?: number },
): Promise<ToolResult> {
  const deepObserve = isDeepObserve(tabId);
  const requests = readNetworkList(tabId, args);
  if (deepObserve) return { ok: true, data: { requests, deepObserve } };
  return { ok: true, data: { requests, deepObserve, hint: NETWORK_HINT } };
}

export async function doGetNetworkRequest(
  tabId: number,
  args: { requestId: string },
): Promise<ToolResult> {
  if (!args.requestId) return { ok: false, error: 'get_network_request 缺少 requestId 参数' };
  const entry = readNetworkDetail(tabId, args.requestId);
  if (!entry) return { ok: false, error: `未找到请求 ${args.requestId}（可能已被环形缓冲淘汰或不在当前标签）` };
  const { networkCaptureHeaders } = (await getSettings()).agent;
  const deepObserve = isDeepObserve(tabId);
  const data: Record<string, unknown> = {
    requestId: entry.requestId,
    method: entry.method,
    url: entry.url,
    type: entry.type,
    status: entry.status,
    error: entry.error,
    ts: entry.ts,
    durationMs: entry.endTs != null ? entry.endTs - entry.ts : undefined,
    requestHeaders: entry.requestHeaders ? redactHeaders(entry.requestHeaders, networkCaptureHeaders) : undefined,
    responseHeaders: entry.responseHeaders ? redactHeaders(entry.responseHeaders, networkCaptureHeaders) : undefined,
    requestBody: entry.requestBody,
    responseBody: entry.responseBody,
    wsFrames: entry.wsFrames,
    truncated: entry.truncated,
    source: entry.source,
    deepObserve,
  };
  // 无 body 且无 headers 且未开深度观测：说明为什么看不到内容。
  const empty = !entry.requestHeaders && !entry.responseHeaders && !entry.requestBody && !entry.responseBody;
  if (!deepObserve && empty) data.hint = NETWORK_HINT;
  return { ok: true, data };
}
```

`agent/tools/schemas.ts` 三条描述各补一句（`list_console_messages` 描述末尾）：

```
深度观测（CDP）未开启时返回空列表并附 hint，可按提示用 enable_deep_observe 开启。
```

`list_network_requests` 描述末尾：

```
深度观测未开启时只有 webRequest 元数据（无响应体与请求头）。
```

`get_network_request` 描述末尾：

```
深度观测未开启时响应体与请求头可能缺失（附 hint 说明）。
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/agent/observe-degrade.test.ts`
Expected: PASS（4 个用例）

- [ ] **Step 5: Commit**

```bash
git add agent/tools/observe.ts agent/tools/schemas.ts tests/agent/observe-degrade.test.ts
git commit -m "feat(cdp): 观测工具降级语义（deepObserve 标记 + hint）"
```

---

### Task 9: 面板状态 store（`stores/deep-observe.ts`）

**Files:**
- Create: `stores/deep-observe.ts`
- Test: `tests/stores/deep-observe.test.ts`

**Interfaces:**
- Consumes: Task 4 `DeepObserveState`；Task 6 的 `DEEP_OBSERVE_GET` / `DEEP_OBSERVE_SET` handler
- Produces: `useDeepObserve`（zustand store）：`states: Record<number, DeepObserveState>`；`applyState(s)`；`fetchState(tabId): Promise<void>`；`setEnabled(tabId, enabled): Promise<void>`

- [ ] **Step 1: Write the failing test**

```ts
// tests/stores/deep-observe.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { useDeepObserve } from '../../stores/deep-observe';

beforeEach(() => {
  fakeBrowser.reset();
  useDeepObserve.setState({ states: {} });
});

describe('deep-observe store', () => {
  it('applyState 按 tabId 写入', () => {
    useDeepObserve.getState().applyState({ tabId: 1, status: 'on' });
    expect(useDeepObserve.getState().states[1]).toEqual({ tabId: 1, status: 'on' });
  });

  it('fetchState 拉取并落库', async () => {
    fakeBrowser.runtime.sendMessage = (async () => ({ ok: true, data: { tabId: 2, status: 'off' } })) as never;
    await useDeepObserve.getState().fetchState(2);
    expect(useDeepObserve.getState().states[2]).toEqual({ tabId: 2, status: 'off' });
  });

  it('fetchState 后台抛错时静默（保持未知态）', async () => {
    fakeBrowser.runtime.sendMessage = (async () => { throw new Error('no bg'); }) as never;
    await expect(useDeepObserve.getState().fetchState(3)).resolves.toBeUndefined();
    expect(useDeepObserve.getState().states[3]).toBeUndefined();
  });

  it('setEnabled 成功时写入返回态', async () => {
    fakeBrowser.runtime.sendMessage = (async () => ({ ok: true, data: { tabId: 4, status: 'on' } })) as never;
    await useDeepObserve.getState().setEnabled(4, true);
    expect(useDeepObserve.getState().states[4]).toEqual({ tabId: 4, status: 'on' });
  });

  it('setEnabled 失败时写 error 态（开关据此转 warn 色）', async () => {
    fakeBrowser.runtime.sendMessage = (async () => ({ ok: false, error: '附着失败：Another debugger is already attached' })) as never;
    await useDeepObserve.getState().setEnabled(5, true);
    const s = useDeepObserve.getState().states[5]!;
    expect(s.status).toBe('error');
    expect(s.reason).toContain('附着失败');
  });

  it('setEnabled 通道异常时也写 error 态', async () => {
    fakeBrowser.runtime.sendMessage = (async () => { throw new Error('disconnected'); }) as never;
    await useDeepObserve.getState().setEnabled(6, true);
    expect(useDeepObserve.getState().states[6]!.status).toBe('error');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/stores/deep-observe.test.ts`
Expected: FAIL — 无法解析 `../../stores/deep-observe`

- [ ] **Step 3: Write minimal implementation**

```ts
// stores/deep-observe.ts
// 深度观测的前端状态缓存（设计 §5.8）：SW 权威，本 store 只缓存广播与查询结果，不做判定。
import { create } from 'zustand';
import type { DeepObserveRequest, DeepObserveState } from '../shared/cdp';

interface DeepObserveStore {
  states: Record<number, DeepObserveState>;
  applyState: (s: DeepObserveState) => void;
  fetchState: (tabId: number) => Promise<void>;
  setEnabled: (tabId: number, enabled: boolean) => Promise<void>;
}

interface DeepObserveReply { ok: boolean; data?: DeepObserveState; error?: string }

export const useDeepObserve = create<DeepObserveStore>((set) => ({
  states: {},

  applyState: (s) => set((st) => ({ states: { ...st.states, [s.tabId]: s } })),

  fetchState: async (tabId) => {
    try {
      const resp = await browser.runtime.sendMessage(
        { type: 'DEEP_OBSERVE_GET', tabId } as DeepObserveRequest,
      ) as DeepObserveReply | undefined;
      if (resp?.data) set((st) => ({ states: { ...st.states, [resp.data!.tabId]: resp.data! } }));
    } catch {
      // 后台未就绪：保持未知态（开关按 off 渲染），下次广播或切换标签页会补上。
    }
  },

  setEnabled: async (tabId, enabled) => {
    try {
      const resp = await browser.runtime.sendMessage(
        { type: 'DEEP_OBSERVE_SET', tabId, enabled } as DeepObserveRequest,
      ) as DeepObserveReply | undefined;
      if (resp?.data) {
        set((st) => ({ states: { ...st.states, [resp.data!.tabId]: resp.data! } }));
      } else if (resp?.error) {
        set((st) => ({ states: { ...st.states, [tabId]: { tabId, status: 'error', reason: resp.error } } }));
      }
    } catch (e) {
      set((st) => ({
        states: { ...st.states, [tabId]: { tabId, status: 'error', reason: e instanceof Error ? e.message : String(e) } },
      }));
    }
  },
}));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/stores/deep-observe.test.ts`
Expected: PASS（6 个用例）

- [ ] **Step 5: Commit**

```bash
git add stores/deep-observe.ts tests/stores/deep-observe.test.ts
git commit -m "feat(cdp): 面板状态 store（SW 权威 + 广播缓存）"
```

---

### Task 10: 圆形开关 + 输入坞布局调整

**Files:**
- Create: `components/chat/DeepObserveToggle.tsx`
- Modify: `components/chat/ChatView.tsx`（左侧挂开关、`ModeSelect` 移入右簇）
- Modify: `entrypoints/sidepanel/styles.css`
- Test: `tests/ui/deep-observe-toggle.test.tsx`

**Interfaces:**
- Consumes: Task 9 `useDeepObserve`
- Produces: `function DeepObserveToggle({ disabled }: { disabled?: boolean }): JSX.Element`

- [ ] **Step 1: Write the failing test**

```tsx
// tests/ui/deep-observe-toggle.test.tsx
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { DeepObserveToggle } from '../../components/chat/DeepObserveToggle';
import { useDeepObserve } from '../../stores/deep-observe';

afterEach(cleanup);

let sent: unknown[];

beforeEach(() => {
  fakeBrowser.reset();
  useDeepObserve.setState({ states: {} });
  sent = [];
  fakeBrowser.tabs.query = (async () => [{ id: 7 }]) as never;
  fakeBrowser.runtime.sendMessage = (async (msg: unknown) => {
    sent.push(msg);
    const m = msg as { type: string; tabId: number; enabled?: boolean };
    if (m.type === 'DEEP_OBSERVE_GET') return { ok: true, data: { tabId: m.tabId, status: 'off' } };
    return { ok: true, data: { tabId: m.tabId, status: m.enabled ? 'on' : 'off' } };
  }) as never;
});

describe('DeepObserveToggle', () => {
  it('挂载时拉取当前标签页状态', async () => {
    render(<DeepObserveToggle />);
    await waitFor(() => expect(sent.some((m) => (m as { type: string }).type === 'DEEP_OBSERVE_GET')).toBe(true));
  });

  it('默认渲染关态，aria-label 提示点击开启', async () => {
    render(<DeepObserveToggle />);
    const btn = await screen.findByRole('button', { name: /深度观测/ });
    expect(btn.className).toContain('deepobs--off');
    expect(btn.getAttribute('aria-label')).toContain('点击开启');
  });

  it('点击后发出 SET enabled=true 并转开态', async () => {
    render(<DeepObserveToggle />);
    const btn = await screen.findByRole('button', { name: /深度观测/ });
    fireEvent.click(btn);
    await waitFor(() => expect(btn.className).toContain('deepobs--on'));
    expect(sent.some((m) => (m as { type: string; enabled?: boolean }).enabled === true)).toBe(true);
  });

  it('广播到达时更新为 error 态（DevTools 抢占）', async () => {
    render(<DeepObserveToggle />);
    const btn = await screen.findByRole('button', { name: /深度观测/ });
    await waitFor(() => expect(sent.length).toBeGreaterThan(0));
    // 模拟 SW 广播：fakeBrowser.runtime.onMessage 的监听器由组件注册
    await fakeBrowser.runtime.sendMessage({ type: 'DEEP_OBSERVE_STATE', payload: { state: { tabId: 7, status: 'error', reason: '页面 DevTools 占用中' } } });
    await waitFor(() => expect(useDeepObserve.getState().states[7]?.status).toBe('error'));
    expect(btn.className).toContain('deepobs--error');
  });

  it('disabled 时按钮禁用', async () => {
    render(<DeepObserveToggle disabled />);
    const btn = await screen.findByRole('button', { name: /深度观测/ });
    expect(btn).toBeDisabled();
  });
});
```

> 注：第 4 个用例依赖 `fakeBrowser.runtime.sendMessage` 会把消息投递给本页 `onMessage` 监听器。若 fakeBrowser 不转发同页消息，改为直接调用 store：`useDeepObserve.getState().applyState({ tabId: 7, status: 'error', reason: '页面 DevTools 占用中' })`，再断言类名。

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ui/deep-observe-toggle.test.tsx`
Expected: FAIL — 无法解析 `../../components/chat/DeepObserveToggle`

- [ ] **Step 3: Write minimal implementation**

`components/chat/DeepObserveToggle.tsx`：

```tsx
// components/chat/DeepObserveToggle.tsx
// 深度观测（CDP）开关：输入坞左侧的圆形图标钮（设计 §6）。
// 颜色即信息：关=--ink-3 / 开=--signal / 异常=--warn。SW 权威，本组件只发消息与订阅广播。
import { useEffect, useState } from 'react';
import { Activity } from 'lucide-react';
import { Tooltip } from '../ui/Tooltip';
import { useDeepObserve } from '../../stores/deep-observe';
import type { DeepObserveState, DeepObserveStatus } from '../../shared/cdp';

/** 当前活动标签页 id（侧边栏里 currentWindow 有时取不到，退化到 lastFocusedWindow——对齐 ChatView 惯例）。 */
function useActiveTabId(): number | null {
  const [tabId, setTabId] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    const query = async () => {
      let [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tab) [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
      if (alive) setTabId(tab?.id ?? null);
    };
    void query();
    const refresh = () => { void query(); };
    browser.tabs.onActivated.addListener(refresh);
    browser.tabs.onRemoved.addListener(refresh);
    return () => {
      alive = false;
      browser.tabs.onActivated.removeListener(refresh);
      browser.tabs.onRemoved.removeListener(refresh);
    };
  }, []);
  return tabId;
}

function tipFor(status: DeepObserveStatus, reason?: string): string {
  if (status === 'on') return '深度观测：开 · 本页已附着（点击关闭）';
  if (status === 'error') return `深度观测：已断开——${reason ?? '附着失败'}（点击重试）`;
  return '深度观测：关（点击开启）';
}

export function DeepObserveToggle({ disabled }: { disabled?: boolean }) {
  const tabId = useActiveTabId();
  const state = useDeepObserve((s) => (tabId != null ? s.states[tabId] : undefined));
  const applyState = useDeepObserve((s) => s.applyState);
  const fetchState = useDeepObserve((s) => s.fetchState);
  const setEnabled = useDeepObserve((s) => s.setEnabled);

  // 切换标签页时重新取该页状态
  useEffect(() => { if (tabId != null) void fetchState(tabId); }, [tabId, fetchState]);

  // SW 广播（面板按 tabId 过滤，这里落进 store 后由上面的 selector 取用）
  useEffect(() => {
    const onMessage = (msg: unknown) => {
      const m = msg as { type?: string; payload?: { state?: DeepObserveState } };
      if (m?.type === 'DEEP_OBSERVE_STATE' && m.payload?.state) applyState(m.payload.state);
    };
    browser.runtime.onMessage.addListener(onMessage);
    return () => browser.runtime.onMessage.removeListener(onMessage);
  }, [applyState]);

  const status: DeepObserveStatus = state?.status ?? 'off';
  const tip = tipFor(status, state?.reason);
  const isOff = status === 'off';

  return (
    <Tooltip label={tip} placement="top">
      <button
        type="button"
        className={`deepobs deepobs--${status}`}
        aria-label={tip}
        disabled={disabled || tabId == null}
        onClick={() => { if (tabId != null) void setEnabled(tabId, isOff); }}
      >
        <Activity size={14} aria-hidden />
      </button>
    </Tooltip>
  );
}
```

`components/chat/ChatView.tsx`：

1. 顶部加 import：

```tsx
import { DeepObserveToggle } from './DeepObserveToggle';
```

2. 把 `.composer__bar` 内原 `<ModeSelect ... />` 那一行从左侧移除，改在 `.composer__actions` 内、`<ContextRing>` 之前渲染；开关插到 `.composer__attach` 之后：

```tsx
          <button
            type="button"
            className="composer__attach"
            aria-label="添加附件"
            onClick={() => fileRef.current?.click()}
            disabled={status === 'running'}
          >
            <Paperclip size={16} aria-hidden />
          </button>
          <DeepObserveToggle disabled={status === 'running'} />
          <div className="composer__actions">
            <ModeSelect disabled={status === 'running' ? false : compacting} />
            <ContextRing
```

（`ModeSelect` 原来的 `disabled={status === 'running' ? false : compacting}` 表达式原样保留。）

`entrypoints/sidepanel/styles.css`：

1. `.modeselect` 的 `margin-right: 2px` 删除（右簇已有 `gap: 6px`，且间隙方向反转）：

```css
.modeselect { flex-shrink: 0; }
```

2. 更新 `.composer__actions` 上方注释：

```css
/* 右侧操作区（模式选择器 + 上下文环 + 发送）推到最右；附件钮与深度观测开关成组靠左 */
```

3. 在 `.ctxring` 块之前插入新样式：

```css
/* ============ 深度观测（CDP）开关 ============ */
/* 颜色即信息：关=--ink-3 / 开=--signal / 异常（DevTools 抢占、附着失败）=--warn */
.deepobs {
  width: 26px; height: 26px; padding: 0; flex-shrink: 0;
  border: 1px solid transparent; background: transparent; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center;
  color: var(--ink-3); border-radius: 50%;
  transition: color var(--t-fast) var(--ease), background var(--t-fast) var(--ease),
              border-color var(--t-fast) var(--ease);
}
.deepobs:hover:not(:disabled) { background: var(--sunken); color: var(--ink-2); }
.deepobs:focus-visible { outline: 2px solid var(--signal); outline-offset: 1px; }
.deepobs:disabled { cursor: default; opacity: 0.5; }
.deepobs--on { color: var(--signal); background: var(--signal-wash); border-color: var(--signal); }
.deepobs--on:hover:not(:disabled) { background: var(--signal-wash); color: var(--signal); }
.deepobs--error { color: var(--warn); background: var(--warn-wash); border-color: var(--warn); }
.deepobs--error:hover:not(:disabled) { background: var(--warn-wash); color: var(--warn); }
@media (prefers-reduced-motion: reduce) { .deepobs { transition: none; } }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/ui/deep-observe-toggle.test.tsx`
Expected: PASS（5 个用例）

- [ ] **Step 5: 跑输入坞既有测试确认布局改动无回归**

Run: `npx vitest run tests/ui tests/chat`
Expected: 全部 PASS

- [ ] **Step 6: Commit**

```bash
git add components/chat/DeepObserveToggle.tsx components/chat/ChatView.tsx entrypoints/sidepanel/styles.css tests/ui/deep-observe-toggle.test.tsx
git commit -m "feat(cdp): 输入坞圆形开关 + 模式选择器右对齐"
```

---

### Task 11: hook 链路退役 + 文档联动

**Files:**
- Delete: `entrypoints/hook.content.ts`、`background/hook-registration.ts`、`background/hook-exclusions.ts`、`components/settings/HookExclusionsPage.tsx`、`stores/hook-exclusions.ts`、`shared/hook-bridge.ts`
- Delete: `tests/background/hook-exclusions.test.ts`、`tests/background/hook-registration.test.ts`
- Modify: `entrypoints/content.ts`、`entrypoints/background.ts`、`shared/messages.ts`、`components/settings/SettingsHome.tsx`、`components/settings/SettingsView.tsx`、`background/observe-store.ts`
- Modify: `README.md:144`、`docs/使用指南.md:116`、`landing/src/pages/Home.tsx:440`、`docs/history.md`

**Interfaces:**
- Consumes: Task 3（`ingestHookNet` 的消费方就此消失）、Task 6（CDP 已能承担观测）
- Produces: 无新接口；删除 `ingestHookNet`、`MATCH_WINDOW_MS`、`TabBuf.hookKeys`、`HookNetEntry`、`ConsoleEntry` 在 hook-bridge 的旧位置

- [ ] **Step 1: 删除文件**

```bash
git rm entrypoints/hook.content.ts background/hook-registration.ts background/hook-exclusions.ts \
       components/settings/HookExclusionsPage.tsx stores/hook-exclusions.ts shared/hook-bridge.ts \
       tests/background/hook-exclusions.test.ts tests/background/hook-registration.test.ts
```

- [ ] **Step 2: 清理 `entrypoints/content.ts` 的中继块**

删掉：`HOOK_MSG` / `RELAY_READY` 的 import、`window.addEventListener('message', ...)` 那段中继监听、`RELAY_READY` 回发。保留 `CS_READY` 通知与其余全部逻辑。

- [ ] **Step 3: 清理 `entrypoints/background.ts`**

删掉：`HOOK_CONSOLE` / `HOOK_NETWORK` 两个 `router.on(...)`、`syncHookRegistration()` 调用、`initHookRegistration(router)`、`hook-registration` 与 `hook-bridge` 的 import、`ingestHookNet` 的 import。保留 `attachObservers()` 与其余接线。

- [ ] **Step 4: 清理 `shared/messages.ts`**

删掉 `HookConsoleNotification`、`HookNetworkNotification`、`HookExclusionsData`、`HookExclusionsRequest`，以及 `import type { ConsoleEntry, HookNetEntry } from './hook-bridge';`。文件头注释里「见 HookConsoleNotification / HookNetworkNotification」改为「见 DeepObserveStateNotification」。

- [ ] **Step 5: 清理设置页入口**

`components/settings/SettingsHome.tsx`：删「敏感站点排除」入口卡与 `HookExclusionsPage` 相关的 `SettingsSub` 联合成员。
`components/settings/SettingsView.tsx`：删对应路由分支与 import。

- [ ] **Step 6: 清理 `background/observe-store.ts`**

删掉 `ingestHookNet`、`MATCH_WINDOW_MS`、`TabBuf.hookKeys` 字段与其初始化/清理、`clearTabNetwork` 里的 `b.hookKeys.clear()`，以及 `HookNetEntry` 的 import。

- [ ] **Step 7: 跑全量测试与类型检查**

Run: `npm run compile && npm run test`
Expected: 全部 PASS，无未使用 import 报错。若 `tests/background/observe-store.test.ts` 里 `describe('network 缓冲：hook body 关联')` 整块还在，一并删除。

- [ ] **Step 8: 文档联动**

- `README.md:144`：`**页面观测** — MAIN world hook 包装 fetch / XHR / console，webRequest 记录全量网络元数据；强风控站可加入敏感站点排除名单，不注入 hook。` 改为 `**页面观测** — 默认用 webRequest 记录全量网络元数据；在输入坞一键开启「深度观测」（CDP）后可拿到全量响应体、完整请求头、WebSocket 帧与带堆栈的控制台日志，且不再向页面注入任何 MAIN world 脚本。`
- `docs/使用指南.md:116`：`background.ts` 那一行的 `MessageRouter + HOOK_CONSOLE/HOOK_NETWORK` 改为 `MessageRouter + DEEP_OBSERVE_*`，`webRequest 观测接线` 保留。
- `landing/src/pages/Home.tsx:440`：`d` 字段改为 `默认 webRequest 记全量网络元数据；一键开启深度观测（CDP）拿全量响应体、完整请求头、WebSocket 帧与带堆栈的 console，且不向页面注入 MAIN world 脚本。`
- `docs/history.md`：在迭代记录末尾追加一小节「CDP 深度观测」，写清 hook 退役原因（指纹 + 观测残缺）、CDP 的两条硬代价（信息条、DevTools 互斥），以及四条边界：① CDP 非零可检测（`console.log` getter 陷阱、`debugger` 语句计时仍能探测附着，去掉的只是最廉价那类包装指纹）；② Shared Worker / Service Worker 够不到（`chrome.debugger` 的附着单位是标签页，`Target.setAutoAttach` 只收该页子 target）；③ `sessionId` 定位子会话需 Chrome 125+（更低版本只覆盖主帧）；④ WebSocket 帧 payload 不过脱敏（`networkCaptureHeaders` 只作用于 headers，帧体可能夹带凭据）。

- [ ] **Step 9: 构建验证**

Run: `npm run build`
Expected: 构建成功；检查 `.output/chrome-mv3/manifest.json` 的 `permissions` 含 `debugger`，且 `content_scripts` 里**不再有** `world: "MAIN"` 的 hook 条目。

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "refactor(cdp): 退役 MAIN world hook 全链路（注入/注册/排除名单/中继）+ 文档联动"
```

---

### Task 12: 手测验证

单测跑不到真实 `chrome.debugger`，本 task 是唯一能验证真实行为的关口。逐条执行并在 PR 描述里记录结果。

**Files:** 无（纯验证）

- [ ] **Step 1: 启动开发模式**

Run: `npm run dev`，在 chrome://extensions 加载 `.output/chrome-mv3`。

- [ ] **Step 2: 逐条走 spec §9 的手测清单**

1. 开关默认灰，位于附件钮右侧；模式选择器已右对齐到操作簇内、上下文环左侧，点开浮层定位正常（仍左右贴卡片边）。
2. 点开开关 → 页面顶部出现「正在调试此浏览器」信息条 + 开关转 signal 色。
3. 页面 `console.log` / 未捕获异常 → `list_console_messages` 有数据且带堆栈。
4. fetch / XHR / img / 跨域 iframe 内请求 → `list_network_requests` 全都有；`get_network_request` 拿得到 XHR/Fetch 的 body 与完整 headers（含浏览器自动头）。
5. CSP 违规页面 → console 列表出现 `Log.entryAdded` 来源的条目。
6. 打开页面 DevTools → 开关转 warn，工具返回明确文案。
7. 先开 DevTools 再点开关 → 落 warn 态。
8. 切标签页 → 开关显示未开启；切回 → 恢复「开」。
9. 同标签页内导航 → 保持附着。
10. 关闭标签页 → 状态清理，无残留。
11. WebSocket 站 → 帧条目可见。
12. Boss直聘 → 不再有 MAIN world 注入，正常打开（且不需要排除名单）。
13. CDP 关闭状态下 → `list_network_requests` 仍有 webRequest 元数据；`list_console_messages` 返回 hint 而非报错。

- [ ] **Step 3: 记录结果**

任何一条不通过，回到对应 task 修复并补一条回归单测；全部通过则在 PR 描述里勾选清单。

---

## 附：任务依赖图

```
Task 1 (console-text)  ─┐
Task 2 (bodies)        ─┼─→ Task 5 (domains) ─→ Task 6 (接线) ─→ Task 8 (降级语义)
Task 3 (observe-store) ─┤                              │
Task 4 (session)       ─┴──────────────────────────────┼─→ Task 7 (工具)
                                                        └─→ Task 9 (store) ─→ Task 10 (UI)
Task 6 ─→ Task 11 (退役) ─→ Task 12 (手测)
```

Task 1/2/3/4 相互独立，可并行。
