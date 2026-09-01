# AI Browser Extension 实施计划（Phase 3b：MAIN world hook 基础设施 + 观测三工具）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 agent 补上「看见页面 console 与网络请求」的能力：新建 MAIN world hook 基础设施（document_start 包装 fetch/XHR/console → 中继到 SW 环形缓冲），落地 `list_console_messages` / `list_network_requests` / `get_network_request` 三个观测工具（16 → 19）。

**Architecture:** MAIN world content script（`world:'MAIN'`, `document_start`）包装 `fetch`/`XHR`/`console` + `window.onerror`/`unhandledrejection`，经 `window.postMessage` 桥给同页 ISOLATED `content.ts`，后者 `runtime.sendMessage` 中继到 SW；SW 侧 `observe-store` 维护 per-tab 环形缓冲，webRequest 监听器建全量元数据主干，hook body 按 `(method+url+时间窗)` best-effort 关联富化；三工具直接读 SW 缓冲、零 CS 往返。headers 只从 hook 取，入缓冲只截断、读取时按 settings 脱敏。

**Tech Stack:** WXT 0.21（`defineContentScript({ world:'MAIN' })`）+ React 19 + TypeScript（strict + noUncheckedIndexedAccess）、Vitest（jsdom + WxtVitest fakeBrowser）、zustand、lucide-react。

**规格文档：** [docs/superpowers/specs/2026-09-01-ai-browser-extension-phase3b-design.md](../specs/2026-09-01-ai-browser-extension-phase3b-design.md)

**依赖 Phase 3a 冻结接口：** `agent/tools/registry.ts`（executeTool/ToolCtx/RESTRICTED）、`shared/messages.ts`（CsToBgNotification 家族、BgToCsRequestMap）、`shared/types.ts`（ToolResult）、`storage/settings.ts`（getSettings/AgentConfig）、`entrypoints/content.ts`（route/main 消息监听）、`entrypoints/background.ts`（MessageRouter 接线）、`background/router.ts`（handler 接收 sender）。

---

## 关键实现约定（所有 task 遵守）

- **运行时全局用 `browser.*`**（WXT auto-import + polyfill），不用 `chrome.*`。
- **ToolResult 判别联合**：成功 `{ ok:true, data? }`，失败 `{ ok:false, error }`。工具内不抛异常。
- **测试镜像源码路径**放 `tests/`（如 `observe/serialize.ts` → `tests/observe/serialize.test.ts`）。
- **jsdom 限制**：真实 `webRequest`/MAIN world 注入/跨 world postMessage 不可用 → 单测 mock，真实行为留手测。
- **fakeBrowser import 路径**：`wxt/testing/fake-browser`（不是 `wxt/testing/browser`）。
- **并发注意**：其他会话可能同时改 `content.ts`。每个 task 结尾 `git add <本 task 明确列出的文件>`，**绝不 `git add -A`**；commit 前 `git diff --cached --name-only` 核对暂存区只含本 task 文件。
- **每个 task 结尾 commit**。

---

## 文件结构（Phase 3b 新建/修改）

```
shared/
├── hook-bridge.ts       # Task 2：window 桥协议常量 + 共享数据形状（新建）
└── messages.ts          # Task 6：+HOOK_CONSOLE/HOOK_NETWORK 通知，删 CONSOLE_READ（改）
observe/
├── serialize.ts         # Task 3：console 参数安全序列化（新建，纯函数）
└── redact.ts            # Task 4：headers 脱敏 + 截断（新建，纯函数）
background/
├── observe-store.ts     # Task 5：SW 环形缓冲 + webRequest 接线 + hook 关联（新建）
└── ...
agent/tools/
├── observe.ts           # Task 7：三工具执行器（新建）
├── schemas.ts           # Task 1：+3 schema（16→19，改）
└── registry.ts          # Task 8：+3 分发，豁免受限页预检（改）
storage/
└── settings.ts          # Task 1：AgentConfig + networkCaptureHeaders（改）
entrypoints/
├── hook.content.ts      # Task 9：MAIN world CS 注入（新建）
├── content.ts           # Task 10：中继 HOOK_* + 发 RELAY_READY + 删 EVALUATE 死码（改）
└── background.ts        # Task 11：接 observe-store 真实通道 + webRequest attach（改）
```

**任务顺序（依赖驱动）**：1 settings+schema → 2 hook-bridge 类型 → 3 serialize → 4 redact → 5 observe-store → 6 messages 协议 → 7 observe 工具 → 8 registry 分发 → 9 hook.content 注入 → 10 content 中继 → 11 background 接线 → 12 收尾验证。

---

### Task 1: settings 脱敏开关 + 工具 schema 扩展（16→19）

**Files:**
- Modify: `storage/settings.ts`
- Modify: `agent/tools/schemas.ts`
- Test: `tests/storage/settings.test.ts`（追加）
- Test: `tests/agent/tools/schemas.test.ts`（改计数 + 追加断言）

- [x] **Step 1: 改失败测试 `tests/agent/tools/schemas.test.ts`**

把「恰好 16 个」断言改为 19 并补新工具断言（保留其余原有回归断言不动）：

```ts
  it('恰好 19 个工具（Phase 2 的 9 + Phase 3a 的 7 + Phase 3b 的 3）', () => {
    const names = TOOL_SCHEMAS.map((s) => s.function.name).sort();
    expect(names).toEqual([
      'click', 'close_page', 'evaluate_script', 'fill', 'fill_form',
      'get_network_request', 'hover', 'http_request', 'list_console_messages',
      'list_network_requests', 'list_pages', 'navigate_page', 'new_page',
      'press_key', 'scroll', 'select_page', 'take_screenshot', 'take_snapshot', 'wait_for',
    ]);
  });

  it('list_console_messages 的 level 枚举', () => {
    const t = TOOL_SCHEMAS.find((s) => s.function.name === 'list_console_messages')!;
    const p = t.function.parameters as { properties: Record<string, { enum?: string[] }> };
    expect(p.properties.level!.enum).toEqual(['log', 'info', 'warn', 'error', 'debug']);
  });

  it('get_network_request 的 requestId 必填', () => {
    const t = TOOL_SCHEMAS.find((s) => s.function.name === 'get_network_request')!;
    const p = t.function.parameters as { required: string[] };
    expect(p.required).toContain('requestId');
  });
```

- [x] **Step 2: 运行确认失败**

Run: `npx vitest run tests/agent/tools/schemas.test.ts`
Expected: FAIL —— 数量 16≠19。

- [x] **Step 3: 在 `agent/tools/schemas.ts` 的 `TOOL_SCHEMAS` 数组末尾（`http_request` 之后、`];` 之前）追加 3 个 schema**

```ts
  {
    type: 'function',
    function: {
      name: 'list_console_messages',
      description: '读取当前操作目标页面的 console 日志（含 console.log/info/warn/error/debug 与运行时错误）。用于诊断页面报错、观察脚本输出。返回按时间倒序的最近若干条。',
      parameters: obj({
        level: { type: 'string', enum: ['log', 'info', 'warn', 'error', 'debug'], description: '只看某一级别（默认全部）' },
        limit: { type: 'number', description: '最多返回条数（默认 50，上限 200）' },
      }),
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_network_requests',
      description: '列出当前操作目标页面发生过的网络请求（摘要：方法/URL/状态/类型/耗时/是否有 body）。用于观察页面调了哪些接口。要看某条的请求头/响应体，用 get_network_request。',
      parameters: obj({
        method: { type: 'string', description: '按方法过滤（如 GET/POST，可选）' },
        urlContains: { type: 'string', description: '按 URL 子串过滤（可选）' },
        status: { type: 'number', description: '按状态码过滤（可选）' },
        limit: { type: 'number', description: '最多返回条数（默认 50）' },
      }),
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_network_request',
      description: '按 requestId 取单条网络请求的完整信息（含请求头/响应头/请求体/响应体，若页面 JS 发起时被捕获）。requestId 来自 list_network_requests。敏感头默认脱敏。',
      parameters: obj({
        requestId: { type: 'string', description: '来自 list_network_requests 的 requestId' },
      }, ['requestId']),
    },
  },
```

- [x] **Step 4: 运行确认通过**

Run: `npx vitest run tests/agent/tools/schemas.test.ts`
Expected: 全部 passed。

- [x] **Step 5: 改失败测试 `tests/storage/settings.test.ts`（追加）**

```ts
  it('AgentConfig 默认 networkCaptureHeaders=redacted', async () => {
    const s = await getSettings();
    expect(s.agent.networkCaptureHeaders).toBe('redacted');
  });

  it('可存 networkCaptureHeaders=full', async () => {
    await saveSettings({ agent: { networkCaptureHeaders: 'full' } });
    const s = await getSettings();
    expect(s.agent.networkCaptureHeaders).toBe('full');
  });
```

> 若 `tests/storage/settings.test.ts` 尚不存在，新建并补 import：
> ```ts
> import { describe, it, expect, beforeEach } from 'vitest';
> import { fakeBrowser } from 'wxt/testing/fake-browser';
> import { getSettings, saveSettings } from '../../storage/settings';
> describe('settings', () => { beforeEach(() => fakeBrowser.reset()); /* 上面两个 it */ });
> ```

- [x] **Step 6: 运行确认失败**

Run: `npx vitest run tests/storage/settings.test.ts`
Expected: FAIL —— `networkCaptureHeaders` 不存在。

- [x] **Step 7: 修改 `storage/settings.ts`**

`AgentConfig` 加字段：

```ts
export interface AgentConfig {
  // 注：不设"最大步数上限"——agent loop 靠自然终止 + 熔断阀（见 agent/loop-guards.ts），不数步数。
  screenshotPolicy: 'never' | 'on-demand';
  confirmGate: boolean; // 脚本池确认门控，默认 true
  /** 网络观测头处理：redacted=敏感头脱敏（默认），full=原文返回。见设计 §4.3。 */
  networkCaptureHeaders: 'redacted' | 'full';
}
```

`DEFAULT_SETTINGS.agent` 加默认：

```ts
  agent: { screenshotPolicy: 'on-demand', confirmGate: true, networkCaptureHeaders: 'redacted' },
```

- [x] **Step 8: 运行确认通过**

Run: `npx vitest run tests/storage/settings.test.ts tests/agent/tools/schemas.test.ts`
Expected: 全部 passed。

- [x] **Step 9: Commit**

```bash
git add storage/settings.ts agent/tools/schemas.ts tests/storage/settings.test.ts tests/agent/tools/schemas.test.ts
git diff --cached --name-only   # 核对只含这 4 个文件
git commit -m "feat: Phase 3b settings 脱敏开关 + 观测三工具 schema（16→19）"
```

---

### Task 2: window 桥协议 + 共享数据形状（`shared/hook-bridge.ts`）

MAIN hook 与 ISOLATED content.ts 之间的 window 消息协议常量 + 三方（hook/store/工具）共享的数据形状。纯类型/常量，无运行时逻辑，只做类型回归。

**Files:**
- Create: `shared/hook-bridge.ts`
- Test: `tests/shared/hook-bridge.test.ts`

- [x] **Step 1: 写失败测试 `tests/shared/hook-bridge.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { HOOK_MSG, RELAY_READY, type HookWindowMsg, type ConsoleEntry, type HookNetEntry } from '../../shared/hook-bridge';

describe('hook-bridge 协议', () => {
  it('导出稳定的 window 消息 tag 常量', () => {
    expect(typeof HOOK_MSG).toBe('string');
    expect(typeof RELAY_READY).toBe('string');
    expect(HOOK_MSG).not.toBe(RELAY_READY);
  });

  it('HookWindowMsg 可承载 console / network 两类', () => {
    const c: HookWindowMsg = { source: HOOK_MSG, kind: 'console', entry: { id: '1', level: 'log', text: 'hi', ts: 1 } };
    const n: HookWindowMsg = { source: HOOK_MSG, kind: 'network', entry: { loadNonce: 'ab', seq: 1, method: 'GET', url: 'https://x.com', ts: 1 } };
    expect(c.kind).toBe('console');
    expect(n.kind).toBe('network');
  });

  it('ConsoleEntry / HookNetEntry 字段可赋值', () => {
    const e: ConsoleEntry = { id: 'a', level: 'error', text: 'boom', ts: 2, url: 'https://x.com' };
    const h: HookNetEntry = { loadNonce: 'ab', seq: 2, method: 'POST', url: 'https://x.com/api', ts: 3, endTs: 4, status: 200, requestHeaders: { 'content-type': 'application/json' }, responseHeaders: {}, requestBody: '{}', responseBody: '{"ok":1}', truncated: false };
    expect(e.level).toBe('error');
    expect(h.status).toBe(200);
  });
});
```

- [x] **Step 2: 运行确认失败**

Run: `npx vitest run tests/shared/hook-bridge.test.ts`
Expected: FAIL —— module not found。

- [x] **Step 3: 写 `shared/hook-bridge.ts`**

```ts
// shared/hook-bridge.ts
// MAIN world hook ↔ ISOLATED content.ts 的 window 桥协议 + 三方共享数据形状（设计 §7.1）。
// 注意：这是同页 window.postMessage 协议，不是 cs→bg runtime 通知（那在 shared/messages.ts）。

/** MAIN→ISOLATED：一条 console/network 观测消息的 tag。 */
export const HOOK_MSG = '__ai_ext_hook__';
/** ISOLATED→MAIN：中继监听已就绪，请 flush backlog 的 tag。 */
export const RELAY_READY = '__ai_ext_relay_ready__';

/** 一条 console 观测。 */
export interface ConsoleEntry {
  id: string;      // `${loadNonce}:${seq}` 单调去重键
  level: string;   // log/info/warn/error/debug
  text: string;    // 序列化后的文本（已截断）
  ts: number;      // 采集时间戳
  url?: string;    // 采集时页面 URL
}

/** 一条 hook 捕获的网络观测（fetch/XHR）。 */
export interface HookNetEntry {
  loadNonce: string;       // 每次页面加载随机重置（配合 seq 组成 SW 去重键 + 独立条目 id）
  seq: number;             // 页面内单调序号
  method: string;
  url: string;
  ts: number;              // 发起时间
  endTs?: number;          // 完成时间
  status?: number;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBody?: string;    // 已长度截断（未脱敏）
  responseBody?: string;   // 已长度截断（未脱敏）
  truncated?: boolean;
}

/** MAIN→ISOLATED 的 window 消息信封。 */
export type HookWindowMsg =
  | { source: typeof HOOK_MSG; kind: 'console'; entry: ConsoleEntry }
  | { source: typeof HOOK_MSG; kind: 'network'; entry: HookNetEntry };
```

- [x] **Step 4: 运行确认通过**

Run: `npx vitest run tests/shared/hook-bridge.test.ts`
Expected: 3 passed。

- [x] **Step 5: Commit**

```bash
git add shared/hook-bridge.ts tests/shared/hook-bridge.test.ts
git diff --cached --name-only
git commit -m "feat: hook-bridge window 桥协议常量 + 共享数据形状（ConsoleEntry/HookNetEntry）"
```

---

### Task 3: console 参数安全序列化（`observe/serialize.ts`）

纯函数：把 `console.*` 的任意参数数组序列化成一行安全文本——处理循环引用、DOM 节点、函数、大对象截断。hook 在页面里调它，SW/工具不碰它。

**Files:**
- Create: `observe/serialize.ts`
- Test: `tests/observe/serialize.test.ts`

- [x] **Step 1: 写失败测试 `tests/observe/serialize.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { serializeConsoleArgs } from '../../observe/serialize';

describe('serializeConsoleArgs', () => {
  it('标量拼接', () => {
    expect(serializeConsoleArgs(['hello', 42, true])).toBe('hello 42 true');
  });

  it('null / undefined', () => {
    expect(serializeConsoleArgs([null, undefined])).toBe('null undefined');
  });

  it('纯对象 JSON 化', () => {
    expect(serializeConsoleArgs([{ a: 1 }])).toContain('"a":1');
  });

  it('循环引用不抛，降级标注', () => {
    const o: Record<string, unknown> = {}; o.self = o;
    const out = serializeConsoleArgs([o]);
    expect(typeof out).toBe('string');
    expect(out).toContain('[无法序列化');
  });

  it('函数标注为 [Function]', () => {
    expect(serializeConsoleArgs([function foo() {}])).toContain('[Function');
  });

  it('Error 取 name+message', () => {
    expect(serializeConsoleArgs([new TypeError('bad')])).toContain('TypeError: bad');
  });

  it('超长字符串截断加省略号', () => {
    const out = serializeConsoleArgs(['x'.repeat(5000)]);
    expect(out.length).toBeLessThanOrEqual(2100);
    expect(out.endsWith('…')).toBe(true);
  });
});
```

- [x] **Step 2: 运行确认失败**

Run: `npx vitest run tests/observe/serialize.test.ts`
Expected: FAIL —— module not found。

- [x] **Step 3: 写 `observe/serialize.ts`**

```ts
// observe/serialize.ts
// console 参数安全序列化（设计 §8.1）：任意参数数组 → 一行安全文本。
// 纯函数，无副作用；hook 在页面 MAIN world 调用，故不得引用扩展/模块外符号。

const MAX_LEN = 2000;

function cap(s: string): string {
  return s.length > MAX_LEN ? `${s.slice(0, MAX_LEN)}…` : s;
}

function one(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  const t = typeof v;
  if (t === 'string') return v as string;
  if (t === 'number' || t === 'boolean' || t === 'bigint') return String(v);
  if (t === 'function') return `[Function${(v as { name?: string }).name ? `: ${(v as { name: string }).name}` : ''}]`;
  if (t === 'symbol') return String(v as symbol);
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  // DOM 节点：取标签名概要（typeof Node 守卫，jsdom/页面都可能无 Node）
  if (typeof Node !== 'undefined' && v instanceof Node) {
    const el = v as { nodeName?: string; id?: string };
    return `<${(el.nodeName ?? 'node').toLowerCase()}${el.id ? `#${el.id}` : ''}>`;
  }
  try {
    return JSON.stringify(v);
  } catch {
    return '[无法序列化的对象]';
  }
}

/** 把 console.* 的参数数组序列化为一行文本（各参数以空格连接，整体截断）。 */
export function serializeConsoleArgs(args: unknown[]): string {
  return cap(args.map(one).join(' '));
}
```

- [x] **Step 4: 运行确认通过**

Run: `npx vitest run tests/observe/serialize.test.ts`
Expected: 7 passed。

- [x] **Step 5: Commit**

```bash
git add observe/serialize.ts tests/observe/serialize.test.ts
git diff --cached --name-only
git commit -m "feat: console 参数安全序列化（循环/DOM/函数/Error/截断）"
```

---

### Task 4: headers 脱敏 + 截断（`observe/redact.ts`）

纯函数：把 headers 对象按开关脱敏（敏感头→`[REDACTED]`）+ 头值长度截断 + 条数上限。`get_network_request` 执行器读 settings 后调它。入缓冲**不**调它（store 存原文）。

**Files:**
- Create: `observe/redact.ts`
- Test: `tests/observe/redact.test.ts`

- [x] **Step 1: 写失败测试 `tests/observe/redact.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { redactHeaders, SENSITIVE_HEADERS } from '../../observe/redact';

describe('redactHeaders', () => {
  it('redacted 模式：敏感头替换为 [REDACTED]', () => {
    const out = redactHeaders({ Authorization: 'Bearer x', 'Content-Type': 'application/json' }, 'redacted');
    expect(out.authorization).toBe('[REDACTED]');
    expect(out['content-type']).toBe('application/json');
  });

  it('full 模式：原文保留（仅长度截断）', () => {
    const out = redactHeaders({ Authorization: 'Bearer secret' }, 'full');
    expect(out.authorization).toBe('Bearer secret');
  });

  it('key 归一化为小写', () => {
    const out = redactHeaders({ 'X-Custom': 'v' }, 'redacted');
    expect(out['x-custom']).toBe('v');
  });

  it('超长头值截断', () => {
    const out = redactHeaders({ 'x-big': 'v'.repeat(5000) }, 'full');
    expect(out['x-big']!.length).toBeLessThanOrEqual(2050);
    expect(out['x-big']!.endsWith('…')).toBe(true);
  });

  it('条数超上限截断并标注', () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 100; i++) many[`h${i}`] = String(i);
    const out = redactHeaders(many, 'full', 30);
    expect(Object.keys(out).length).toBeLessThanOrEqual(31); // 30 + 一条 __truncated__ 标注
    expect(out.__truncated__).toContain('头过多');
  });

  it('SENSITIVE_HEADERS 覆盖常见凭证头', () => {
    for (const h of ['authorization', 'cookie', 'set-cookie', 'proxy-authorization']) {
      expect(SENSITIVE_HEADERS.has(h)).toBe(true);
    }
  });

  it('undefined 入参返回空对象', () => {
    expect(redactHeaders(undefined, 'redacted')).toEqual({});
  });
});
```

- [x] **Step 2: 运行确认失败**

Run: `npx vitest run tests/observe/redact.test.ts`
Expected: FAIL —— module not found。

- [x] **Step 3: 写 `observe/redact.ts`**

```ts
// observe/redact.ts
// headers 脱敏 + 截断（设计 §4.3）。纯函数：脱敏开关由调用方（get_network_request 执行器读 settings）传入。
// 入缓冲不调此函数（store 存原文），仅读取时按当前设置脱敏，保证 full 档可逆。

/** 敏感头名（小写）：命中即在 redacted 模式替换为 [REDACTED]。 */
export const SENSITIVE_HEADERS = new Set([
  'authorization', 'cookie', 'set-cookie', 'proxy-authorization',
  'x-api-key', 'api-key', 'x-auth-token', 'x-csrf-token',
]);

const REDACTED = '[REDACTED]';
const MAX_VAL = 2048;
const MAX_COUNT = 50;

function capVal(v: string): string {
  return v.length > MAX_VAL ? `${v.slice(0, MAX_VAL)}…` : v;
}

/** 归一化小写 key + 按 mode 脱敏敏感头 + 值截断 + 条数上限。 */
export function redactHeaders(
  headers: Record<string, string> | undefined,
  mode: 'redacted' | 'full',
  maxCount = MAX_COUNT,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  let count = 0;
  let over = 0;
  for (const [rawK, rawV] of Object.entries(headers)) {
    const k = rawK.toLowerCase();
    if (count >= maxCount) { over += 1; continue; }
    if (mode === 'redacted' && SENSITIVE_HEADERS.has(k)) {
      out[k] = REDACTED;
    } else {
      out[k] = capVal(String(rawV));
    }
    count += 1;
  }
  if (over > 0) out.__truncated__ = `头过多，省略 ${over} 条`;
  return out;
}
```

- [x] **Step 4: 运行确认通过**

Run: `npx vitest run tests/observe/redact.test.ts`
Expected: 7 passed。

- [x] **Step 5: Commit**

```bash
git add observe/redact.ts tests/observe/redact.test.ts
git diff --cached --name-only
git commit -m "feat: headers 脱敏 + 值/条数截断（读取时脱敏，full 档可逆）"
```

---

### Task 5: SW 环形缓冲 + webRequest 关联（`background/observe-store.ts`）

SW 侧核心：per-tab console/network 环形缓冲；`ingestConsole`/`ingestHookNet` 收 hook 数据；`recordRequestStart`/`recordRequestEnd`/`recordRequestError` 收 webRequest 元数据；hook body 按 `(method+url+时间窗)` best-effort 关联到 webRequest 条目；`readConsole`/`readNetworkList`/`readNetworkDetail` 供工具读。**本 task 只写纯数据逻辑 + 读写 API，不接 browser.webRequest 事件**（接线在 Task 11）。

**Files:**
- Create: `background/observe-store.ts`
- Test: `tests/background/observe-store.test.ts`

- [x] **Step 1: 写失败测试 `tests/background/observe-store.test.ts`**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import {
  resetStore, ingestConsole, ingestHookNet,
  recordRequestStart, recordRequestEnd, recordRequestError,
  readConsole, readNetworkList, readNetworkDetail, clearTab, clearTabNetwork,
} from '../../background/observe-store';

beforeEach(() => resetStore());

describe('console 缓冲', () => {
  it('ingest + read（倒序、limit）', () => {
    ingestConsole(1, [{ id: '0:1', level: 'log', text: 'a', ts: 1 }, { id: '0:2', level: 'error', text: 'b', ts: 2 }]);
    const r = readConsole(1, {});
    expect(r.map((m) => m.text)).toEqual(['b', 'a']); // 最新在前
  });

  it('level 过滤', () => {
    ingestConsole(1, [{ id: '0:1', level: 'log', text: 'a', ts: 1 }, { id: '0:2', level: 'error', text: 'b', ts: 2 }]);
    expect(readConsole(1, { level: 'error' }).map((m) => m.text)).toEqual(['b']);
  });

  it('按 id 去重（backlog flush 重复不叠加）', () => {
    ingestConsole(1, [{ id: '0:1', level: 'log', text: 'a', ts: 1 }]);
    ingestConsole(1, [{ id: '0:1', level: 'log', text: 'a', ts: 1 }]);
    expect(readConsole(1, {})).toHaveLength(1);
  });

  it('环形上限 200 淘汰最早', () => {
    const entries = Array.from({ length: 250 }, (_, i) => ({ id: `0:${i}`, level: 'log', text: `m${i}`, ts: i }));
    ingestConsole(1, entries);
    const r = readConsole(1, { limit: 1000 });
    expect(r).toHaveLength(200);
    expect(r[r.length - 1]!.text).toBe('m50'); // m0..m49 被淘汰
  });
});

describe('network 缓冲：webRequest 主干', () => {
  it('start→end 建条目并补 status/duration', () => {
    recordRequestStart(1, { requestId: 'r1', method: 'GET', url: 'https://x.com/a', type: 'xmlhttprequest', ts: 100 });
    recordRequestEnd('r1', { status: 200, ts: 150 });
    const list = readNetworkList(1, {});
    expect(list).toHaveLength(1);
    expect(list[0]!).toMatchObject({ requestId: 'r1', status: 200, durationMs: 50, hasBody: false });
  });

  it('onErrorOccurred 记录错误', () => {
    recordRequestStart(1, { requestId: 'r2', method: 'GET', url: 'https://x.com/b', type: 'image', ts: 10 });
    recordRequestError('r2', { error: 'net::ERR_FAILED', ts: 20 });
    const d = readNetworkDetail(1, 'r2');
    expect(d).toBeDefined();
    expect((d as { error?: string }).error).toBe('net::ERR_FAILED');
  });

  it('过滤 method / urlContains / status', () => {
    recordRequestStart(1, { requestId: 'a', method: 'GET', url: 'https://x.com/users', type: 'xmlhttprequest', ts: 1 });
    recordRequestEnd('a', { status: 200, ts: 2 });
    recordRequestStart(1, { requestId: 'b', method: 'POST', url: 'https://x.com/login', type: 'xmlhttprequest', ts: 3 });
    recordRequestEnd('b', { status: 401, ts: 4 });
    expect(readNetworkList(1, { method: 'POST' }).map((r) => r.requestId)).toEqual(['b']);
    expect(readNetworkList(1, { urlContains: 'users' }).map((r) => r.requestId)).toEqual(['a']);
    expect(readNetworkList(1, { status: 401 }).map((r) => r.requestId)).toEqual(['b']);
  });
});

describe('network 缓冲：hook body 关联', () => {
  it('hook body 按 method+url+时间窗关联到 webRequest 条目', () => {
    recordRequestStart(1, { requestId: 'r1', method: 'POST', url: 'https://x.com/api', type: 'xmlhttprequest', ts: 1000 });
    recordRequestEnd('r1', { status: 200, ts: 1100 });
    ingestHookNet(1, [{ loadNonce: 'n1', seq: 1, method: 'POST', url: 'https://x.com/api', ts: 1050, endTs: 1090, status: 200, responseBody: '{"ok":1}', requestBody: '{"q":1}' }]);
    const list = readNetworkList(1, {});
    expect(list).toHaveLength(1);        // 关联进同一条，不新增
    expect(list[0]!.hasBody).toBe(true);
    const d = readNetworkDetail(1, 'r1') as { responseBody?: string; source?: string };
    expect(d.responseBody).toBe('{"ok":1}');
    expect(d.source).toBe('merged');
  });

  it('关联不上（时间窗外）→ 作独立 hook 条目保留', () => {
    recordRequestStart(1, { requestId: 'r1', method: 'GET', url: 'https://x.com/api', type: 'xmlhttprequest', ts: 1000 });
    ingestHookNet(1, [{ loadNonce: 'n1', seq: 5, method: 'GET', url: 'https://x.com/api', ts: 9000, responseBody: 'late' }]);
    const list = readNetworkList(1, {});
    expect(list).toHaveLength(2); // r1 + 独立 hook 条目
    const hook = list.find((r) => r.requestId.startsWith('hook:'));
    expect(hook).toBeDefined();
  });

  it('同一 hook 条目双投递（backlog flush + live）按 loadNonce:seq 去重', () => {
    const e = { loadNonce: 'n1', seq: 3, method: 'GET', url: 'https://x.com/dup', ts: 5000, responseBody: 'x' };
    ingestHookNet(1, [e]);
    ingestHookNet(1, [e]); // 重复投递
    const list = readNetworkList(1, {});
    expect(list.filter((r) => r.url === 'https://x.com/dup')).toHaveLength(1);
  });
});

describe('清理', () => {
  it('clearTab 清 console+network', () => {
    ingestConsole(1, [{ id: '0:1', level: 'log', text: 'a', ts: 1 }]);
    recordRequestStart(1, { requestId: 'r1', method: 'GET', url: 'https://x.com', type: 'document', ts: 1 });
    clearTab(1);
    expect(readConsole(1, {})).toHaveLength(0);
    expect(readNetworkList(1, {})).toHaveLength(0);
  });

  it('clearTabNetwork 只清 network（main_frame 导航语义）', () => {
    ingestConsole(1, [{ id: '0:1', level: 'log', text: 'a', ts: 1 }]);
    recordRequestStart(1, { requestId: 'r1', method: 'GET', url: 'https://x.com', type: 'document', ts: 1 });
    clearTabNetwork(1);
    expect(readConsole(1, {})).toHaveLength(1);
    expect(readNetworkList(1, {})).toHaveLength(0);
  });
});
```

- [x] **Step 2: 运行确认失败**

Run: `npx vitest run tests/background/observe-store.test.ts`
Expected: FAIL —— module not found。

- [x] **Step 3: 写 `background/observe-store.ts`（数据逻辑部分）**

```ts
// background/observe-store.ts
// SW 侧 per-tab 观测环形缓冲（设计 §4、§8.3）。
// 数据逻辑纯粹、可单测；browser.webRequest 事件接线在 Task 11 的 attachObservers（不在本文件初始化时执行）。
import type { ConsoleEntry, HookNetEntry } from '../shared/hook-bridge';

const MAX_ENTRIES = 200;      // 每 tab 每通道环形上限
const MATCH_WINDOW_MS = 2000; // hook body 关联时间窗

/** 合并后的网络条目（webRequest 主干 + hook 富化）。 */
export interface NetEntry {
  requestId: string;            // webRequest 原生 id，或 hook:<loadNonce>:<seq>
  method: string;
  url: string;
  type: string;                 // resourceType（document/xmlhttprequest/...）
  ts: number;
  endTs?: number;
  status?: number;
  error?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBody?: string;
  responseBody?: string;
  truncated?: boolean;
  source: 'webRequest' | 'hook' | 'merged';
  _hookMerged?: boolean;        // 内部：已被某条 hook 富化（防重复关联）
}

interface TabBuf {
  console: ConsoleEntry[];
  consoleIds: Set<string>;
  network: NetEntry[];
  hookKeys: Set<string>;   // 已消费的 hook 网络条目键（loadNonce:seq），防双投递重复关联/建条
}

const tabs = new Map<number, TabBuf>();

function buf(tabId: number): TabBuf {
  let b = tabs.get(tabId);
  if (!b) { b = { console: [], consoleIds: new Set(), network: [], hookKeys: new Set() }; tabs.set(tabId, b); }
  return b;
}

function ring<T>(arr: T[]): void {
  if (arr.length > MAX_ENTRIES) arr.splice(0, arr.length - MAX_ENTRIES);
}

/** 测试用：清空全部缓冲。 */
export function resetStore(): void { tabs.clear(); }
```

- [x] **Step 4: 追加 console 读写 + 网络写入/关联/读 到 `background/observe-store.ts`**

```ts
// ---------- console ----------
export function ingestConsole(tabId: number, entries: ConsoleEntry[]): void {
  const b = buf(tabId);
  for (const e of entries) {
    if (b.consoleIds.has(e.id)) continue; // backlog flush 去重
    b.consoleIds.add(e.id);
    b.console.push(e);
  }
  ring(b.console);
  // id 是 loadNonce:seq 单调不复用；ring 淘汰后重建去重集，防 consoleIds 随 tab 生命期无限增长。
  if (b.consoleIds.size > b.console.length) b.consoleIds = new Set(b.console.map((e) => e.id));
}

export function readConsole(tabId: number, opts: { level?: string; limit?: number }): ConsoleEntry[] {
  const b = tabs.get(tabId);
  if (!b) return [];
  let list = b.console;
  if (opts.level) list = list.filter((e) => e.level === opts.level);
  const limit = opts.limit ?? 50;
  return list.slice(-limit).reverse(); // 最新在前
}

// ---------- network：webRequest 主干 ----------
export function recordRequestStart(
  tabId: number,
  r: { requestId: string; method: string; url: string; type: string; ts: number },
): void {
  const b = buf(tabId);
  b.network.push({ requestId: r.requestId, method: r.method, url: r.url, type: r.type, ts: r.ts, source: 'webRequest' });
  ring(b.network);
}

function findByRequestId(requestId: string): NetEntry | undefined {
  for (const b of tabs.values()) {
    const hit = b.network.find((n) => n.requestId === requestId);
    if (hit) return hit;
  }
  return undefined;
}

export function recordRequestEnd(requestId: string, r: { status: number; ts: number }): void {
  const e = findByRequestId(requestId);
  if (e) { e.status = r.status; e.endTs = r.ts; }
}

export function recordRequestError(requestId: string, r: { error: string; ts: number }): void {
  const e = findByRequestId(requestId);
  if (e) { e.error = r.error; e.endTs = r.ts; }
}

// ---------- network：hook body 关联富化 ----------
export function ingestHookNet(tabId: number, entries: HookNetEntry[]): void {
  const b = buf(tabId);
  for (const h of entries) {
    const key = `${h.loadNonce}:${h.seq}`;
    if (b.hookKeys.has(key)) continue; // 双投递（backlog flush + live）去重
    b.hookKeys.add(key);
    const match = b.network.find(
      (n) => n.source !== 'hook' && !n._hookMerged &&
        n.method === h.method && n.url === h.url &&
        Math.abs(n.ts - h.ts) <= MATCH_WINDOW_MS,
    );
    if (match) {
      match._hookMerged = true;
      match.source = 'merged';
      if (h.status != null && match.status == null) match.status = h.status;
      if (h.endTs != null && match.endTs == null) match.endTs = h.endTs;
      match.requestHeaders = h.requestHeaders;
      match.responseHeaders = h.responseHeaders;
      match.requestBody = h.requestBody;
      match.responseBody = h.responseBody;
      match.truncated = h.truncated;
    } else {
      b.network.push({
        requestId: `hook:${key}`, method: h.method, url: h.url, type: 'fetch',
        ts: h.ts, endTs: h.endTs, status: h.status,
        requestHeaders: h.requestHeaders, responseHeaders: h.responseHeaders,
        requestBody: h.requestBody, responseBody: h.responseBody, truncated: h.truncated,
        source: 'hook',
      });
    }
  }
  ring(b.network);
}

export interface NetSummary {
  requestId: string; method: string; url: string; status?: number; type: string;
  ts: number; durationMs?: number; hasBody: boolean;
}

export function readNetworkList(
  tabId: number,
  opts: { method?: string; urlContains?: string; status?: number; limit?: number },
): NetSummary[] {
  const b = tabs.get(tabId);
  if (!b) return [];
  let list = b.network;
  if (opts.method) list = list.filter((n) => n.method.toUpperCase() === opts.method!.toUpperCase());
  if (opts.urlContains) list = list.filter((n) => n.url.includes(opts.urlContains!));
  if (opts.status != null) list = list.filter((n) => n.status === opts.status);
  const limit = opts.limit ?? 50;
  return list.slice(-limit).reverse().map((n) => ({
    requestId: n.requestId, method: n.method, url: n.url, status: n.status, type: n.type, ts: n.ts,
    durationMs: n.endTs != null ? n.endTs - n.ts : undefined,
    hasBody: n.requestBody != null || n.responseBody != null,
  }));
}

/** 返回原始 NetEntry（含原文 headers/body，未脱敏）——脱敏由调用方读 settings 后做。 */
export function readNetworkDetail(tabId: number, requestId: string): NetEntry | undefined {
  const b = tabs.get(tabId);
  return b?.network.find((n) => n.requestId === requestId);
}

// ---------- 清理 ----------
export function clearTab(tabId: number): void { tabs.delete(tabId); }

export function clearTabNetwork(tabId: number): void {
  const b = tabs.get(tabId);
  if (b) { b.network = []; b.hookKeys.clear(); }
}
```

- [x] **Step 5: 运行确认通过**

Run: `npx vitest run tests/background/observe-store.test.ts`
Expected: 全部 passed。

- [x] **Step 6: 编译**

Run: `npm run compile`
Expected: 退出码 0。

- [x] **Step 7: Commit**

```bash
git add background/observe-store.ts tests/background/observe-store.test.ts
git diff --cached --name-only
git commit -m "feat: SW 观测环形缓冲（console 去重/network webRequest 主干 + hook body 关联富化）"
```

---

### Task 6: cs→bg 通知协议扩展（`shared/messages.ts` + `entrypoints/background.ts` 删桩）

加 `HOOK_CONSOLE`/`HOOK_NETWORK` 通知类型，删掉 Phase 3 占位的 `NETLOG_PUSH`（其 stub handler 一并删）。**本 task 不碰 `CONSOLE_READ`**（它与 content.ts 的 exhaustive switch 耦合，留 Task 10 一起删以保证每步编译绿）。

**Files:**
- Modify: `shared/messages.ts`
- Modify: `entrypoints/background.ts`
- Test: `tests/shared/messages-phase3b.test.ts`（新建）

- [x] **Step 1: 写失败测试 `tests/shared/messages-phase3b.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import type { HookConsoleNotification, HookNetworkNotification } from '../../shared/messages';

describe('Phase 3b 通知协议', () => {
  it('HOOK_CONSOLE 承载 console 条目', () => {
    const m: HookConsoleNotification = { type: 'HOOK_CONSOLE', payload: { entries: [{ id: '0:1', level: 'log', text: 'a', ts: 1 }] } };
    expect(m.type).toBe('HOOK_CONSOLE');
    expect(m.payload.entries[0]!.level).toBe('log');
  });

  it('HOOK_NETWORK 承载 hook 网络条目', () => {
    const m: HookNetworkNotification = { type: 'HOOK_NETWORK', payload: { entries: [{ seq: 1, method: 'GET', url: 'https://x.com', ts: 1 }] } };
    expect(m.type).toBe('HOOK_NETWORK');
    expect(m.payload.entries[0]!.method).toBe('GET');
  });
});
```

- [x] **Step 2: 运行确认失败**

Run: `npx vitest run tests/shared/messages-phase3b.test.ts`
Expected: FAIL —— 类型不存在（TS 编译错误）。

- [x] **Step 3: 修改 `shared/messages.ts`**

顶部 import 加 hook-bridge 数据形状：

```ts
import type { ConsoleEntry, HookNetEntry } from './hook-bridge';
```

把现有的 `CsToBgNotification`（NETLOG_PUSH）整块替换为两个新通知接口：

```ts
/** cs→bg 的 fire-and-forget 通知：MAIN hook 经 ISOLATED content.ts 中继来的 console 观测。
 *  tabId 由 background 从 sender.tab.id 取，此处不带。 */
export interface HookConsoleNotification {
  type: 'HOOK_CONSOLE';
  payload: { entries: ConsoleEntry[] };
}

/** cs→bg 的 fire-and-forget 通知：中继来的 hook 网络观测（fetch/XHR body/headers）。 */
export interface HookNetworkNotification {
  type: 'HOOK_NETWORK';
  payload: { entries: HookNetEntry[] };
}
```

> 若代码库别处（除 background.ts 外）import 了 `CsToBgNotification`，用 `grep -rn "CsToBgNotification" --include=*.ts` 确认；本计划已知仅 background.ts 引用，Step 4 处理。

- [x] **Step 4: 修改 `entrypoints/background.ts`**

import 去掉 `CsToBgNotification`：

```ts
import type { CsReadyNotification, DebugExecRequest } from '../shared/messages';
```

删掉 `NETLOG_PUSH` 的 stub handler 整块（`router.on('NETLOG_PUSH', ...)` 那段，Task 11 会加真实 HOOK_* handler）。

- [x] **Step 5: 同步现有 `tests/shared/messages.test.ts`**

该文件 import 了将被删的 `CsToBgNotification` 并断言 `NETLOG_PUSH`。改 import（去掉 `type CsToBgNotification,`，加 `type HookNetworkNotification,`），并把「CsToBgNotification 类型可赋值」那条 `it` 整体替换为：

```ts
  it('HookNetworkNotification 类型可赋值（编译期契约）', () => {
    const msg: HookNetworkNotification = { type: 'HOOK_NETWORK', payload: { entries: [] } };
    expect(msg.type).toBe('HOOK_NETWORK');
  });
```

- [x] **Step 6: 运行确认通过 + 编译**

Run: `npx vitest run tests/shared/messages-phase3b.test.ts tests/shared/messages.test.ts && npm run compile`
Expected: passed + 退出码 0。

- [x] **Step 7: Commit**

```bash
git add shared/messages.ts entrypoints/background.ts tests/shared/messages.test.ts tests/shared/messages-phase3b.test.ts
git diff --cached --name-only
git commit -m "feat: cs→bg 通知加 HOOK_CONSOLE/HOOK_NETWORK，删 NETLOG_PUSH 占位桩"
```

---

### Task 7: 观测三工具执行器（`agent/tools/observe.ts`）

三个执行器读 SW `observe-store` 缓冲组织 ToolResult；`doGetNetworkRequest` 读 `settings.agent.networkCaptureHeaders` 后调 `redactHeaders` 脱敏（读取时脱敏，见设计 §4.3）。

**Files:**
- Create: `agent/tools/observe.ts`
- Test: `tests/agent/tools/observe.test.ts`

- [x] **Step 1: 写失败测试 `tests/agent/tools/observe.test.ts`**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { doListConsoleMessages, doListNetworkRequests, doGetNetworkRequest } from '../../../agent/tools/observe';
import { resetStore, ingestConsole, recordRequestStart, recordRequestEnd, ingestHookNet } from '../../../background/observe-store';
import { saveSettings } from '../../../storage/settings';

describe('观测三工具', () => {
  beforeEach(async () => { fakeBrowser.reset(); resetStore(); await saveSettings({ agent: { networkCaptureHeaders: 'redacted' } }); });

  it('list_console_messages 返回倒序 + level 过滤', async () => {
    ingestConsole(1, [{ id: '0:1', level: 'log', text: 'a', ts: 1 }, { id: '0:2', level: 'error', text: 'b', ts: 2 }]);
    const r = await doListConsoleMessages(1, { level: 'error' });
    expect(r.ok).toBe(true);
    const msgs = (r as { data: { messages: Array<{ text: string }> } }).data.messages;
    expect(msgs.map((m) => m.text)).toEqual(['b']);
  });

  it('list_console_messages 空缓冲返回空数组（不报错）', async () => {
    const r = await doListConsoleMessages(999, {});
    expect(r.ok).toBe(true);
    expect((r as { data: { messages: unknown[] } }).data.messages).toEqual([]);
  });

  it('list_network_requests 返回摘要（含 hasBody）', async () => {
    recordRequestStart(1, { requestId: 'r1', method: 'GET', url: 'https://x.com/a', type: 'xmlhttprequest', ts: 100 });
    recordRequestEnd('r1', { status: 200, ts: 150 });
    const r = await doListNetworkRequests(1, {});
    const list = (r as { data: { requests: Array<{ requestId: string; hasBody: boolean; durationMs?: number }> } }).data.requests;
    expect(list[0]!).toMatchObject({ requestId: 'r1', hasBody: false, durationMs: 50 });
  });

  it('get_network_request 默认脱敏敏感头', async () => {
    recordRequestStart(1, { requestId: 'r1', method: 'POST', url: 'https://x.com/api', type: 'xmlhttprequest', ts: 100 });
    ingestHookNet(1, [{ loadNonce: 'n1', seq: 1, method: 'POST', url: 'https://x.com/api', ts: 120, requestHeaders: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' }, responseBody: '{"ok":1}' }]);
    const r = await doGetNetworkRequest(1, { requestId: 'r1' });
    const d = (r as { data: { requestHeaders?: Record<string, string>; responseBody?: string } }).data;
    expect(d.requestHeaders!.authorization).toBe('[REDACTED]');
    expect(d.requestHeaders!['content-type']).toBe('application/json');
    expect(d.responseBody).toBe('{"ok":1}');
  });

  it('get_network_request full 模式原样返回敏感头', async () => {
    await saveSettings({ agent: { networkCaptureHeaders: 'full' } });
    recordRequestStart(1, { requestId: 'r1', method: 'GET', url: 'https://x.com/api', type: 'xmlhttprequest', ts: 100 });
    ingestHookNet(1, [{ loadNonce: 'n1', seq: 1, method: 'GET', url: 'https://x.com/api', ts: 120, requestHeaders: { Authorization: 'Bearer secret' } }]);
    const r = await doGetNetworkRequest(1, { requestId: 'r1' });
    const d = (r as { data: { requestHeaders?: Record<string, string> } }).data;
    expect(d.requestHeaders!.authorization).toBe('Bearer secret');
  });

  it('get_network_request 未知 id 报错', async () => {
    const r = await doGetNetworkRequest(1, { requestId: 'nope' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('未找到');
  });

  it('get_network_request 缺 requestId 报错', async () => {
    const r = await doGetNetworkRequest(1, { requestId: '' });
    expect(r.ok).toBe(false);
  });
});
```

- [x] **Step 2: 运行确认失败**

Run: `npx vitest run tests/agent/tools/observe.test.ts`
Expected: FAIL —— module not found。

- [x] **Step 3: 写 `agent/tools/observe.ts`**

```ts
// agent/tools/observe.ts
// 观测三工具执行器（设计 §6）：读 SW observe-store 缓冲，零 content script 往返。
// get_network_request 读取时按 settings.agent.networkCaptureHeaders 脱敏（设计 §4.3）。
import type { ToolResult } from '../../shared/types';
import { getSettings } from '../../storage/settings';
import { redactHeaders } from '../../observe/redact';
import { readConsole, readNetworkList, readNetworkDetail } from '../../background/observe-store';

export async function doListConsoleMessages(
  tabId: number,
  args: { level?: string; limit?: number },
): Promise<ToolResult> {
  const messages = readConsole(tabId, { level: args.level, limit: args.limit });
  return { ok: true, data: { messages } };
}

export async function doListNetworkRequests(
  tabId: number,
  args: { method?: string; urlContains?: string; status?: number; limit?: number },
): Promise<ToolResult> {
  const requests = readNetworkList(tabId, args);
  return { ok: true, data: { requests } };
}

export async function doGetNetworkRequest(
  tabId: number,
  args: { requestId: string },
): Promise<ToolResult> {
  if (!args.requestId) return { ok: false, error: 'get_network_request 缺少 requestId 参数' };
  const entry = readNetworkDetail(tabId, args.requestId);
  if (!entry) return { ok: false, error: `未找到请求 ${args.requestId}（可能已被环形缓冲淘汰或不在当前标签）` };
  const { networkCaptureHeaders } = (await getSettings()).agent;
  return {
    ok: true,
    data: {
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
      truncated: entry.truncated,
      source: entry.source,
    },
  };
}
```

- [x] **Step 4: 运行确认通过**

Run: `npx vitest run tests/agent/tools/observe.test.ts`
Expected: 7 passed。

- [x] **Step 5: 编译**

Run: `npm run compile`
Expected: 退出码 0。

- [x] **Step 6: Commit**

```bash
git add agent/tools/observe.ts tests/agent/tools/observe.test.ts
git diff --cached --name-only
git commit -m "feat: 观测三工具执行器（读 SW 缓冲，get 读取时按 settings 脱敏）"
```

---

### Task 8: registry 分发三工具（豁免受限页预检）

三工具读 SW 缓冲、不碰活页面，与 `list_pages` 同属豁免类——放在受限页预检**之前**分发，受限页也能返回（空列表比报错更有用，见设计 §6）。

**Files:**
- Modify: `agent/tools/registry.ts`
- Test: `tests/agent/tools/registry.test.ts`（追加）

- [x] **Step 1: 追加失败测试到 `tests/agent/tools/registry.test.ts`**

```ts
  it('list_console_messages 豁免受限页预检（chrome:// 也返回）', async () => {
    fakeBrowser.tabs.get = vi.fn().mockResolvedValue({ id: 1, url: 'chrome://extensions' }) as never;
    const r = await executeTool('list_console_messages', {}, { tabId: 1, sessionId: 's', signal: new AbortController().signal });
    expect(r.ok).toBe(true);
  });

  it('list_network_requests 豁免受限页预检', async () => {
    fakeBrowser.tabs.get = vi.fn().mockResolvedValue({ id: 1, url: 'chrome://extensions' }) as never;
    const r = await executeTool('list_network_requests', {}, { tabId: 1, sessionId: 's', signal: new AbortController().signal });
    expect(r.ok).toBe(true);
  });

  it('get_network_request 豁免受限页预检（未知 id 走工具自身错误而非受限页错误）', async () => {
    fakeBrowser.tabs.get = vi.fn().mockResolvedValue({ id: 1, url: 'chrome://extensions' }) as never;
    const r = await executeTool('get_network_request', { requestId: 'x' }, { tabId: 1, sessionId: 's', signal: new AbortController().signal });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('未找到'); // 不是"受限"
  });
```

> `registry.test.ts` 顶部若无 `import { fakeBrowser } from 'wxt/testing/fake-browser'` 与 `vi`，按现有文件已有的 import 复用（Phase 3a 已引入）。

- [x] **Step 2: 运行确认失败**

Run: `npx vitest run tests/agent/tools/registry.test.ts`
Expected: FAIL —— executeTool 未分发这三个工具（走到 `未知工具`）。

- [x] **Step 3: 修改 `agent/tools/registry.ts`**

顶部 import 加：

```ts
import { doListConsoleMessages, doListNetworkRequests, doGetNetworkRequest } from './observe';
```

在豁免类工具分发区（`select_page` 之后、`// ---- 以下工具操作当前目标页，需受限页预检 ----` 之前）追加：

```ts
  // 观测类工具读 SW 缓冲、不碰活页面，与 list_pages 同属豁免（受限页返回空比报错更有用）。
  if (name === 'list_console_messages') return doListConsoleMessages(ctx.tabId, args as { level?: string; limit?: number });
  if (name === 'list_network_requests') return doListNetworkRequests(ctx.tabId, args as { method?: string; urlContains?: string; status?: number; limit?: number });
  if (name === 'get_network_request') return doGetNetworkRequest(ctx.tabId, args as { requestId: string });
```

- [x] **Step 4: 运行确认通过**

Run: `npx vitest run tests/agent/tools/registry.test.ts`
Expected: 全部 passed（含 Phase 2/3a 原有用例）。

- [x] **Step 5: 编译**

Run: `npm run compile`
Expected: 退出码 0。

- [x] **Step 6: Commit**

```bash
git add agent/tools/registry.ts tests/agent/tools/registry.test.ts
git diff --cached --name-only
git commit -m "feat: registry 分发观测三工具（豁免受限页预检，读 SW 缓冲）"
```

---

### Task 9: MAIN world hook 注入（`entrypoints/hook.content.ts`）

manifest 注册的第二个 content script，`world:'MAIN'` + `document_start`：包装 `fetch`/`XHR`/`console` + `window.onerror`/`unhandledrejection`，`window.postMessage` 发观测 + 页面侧 backlog；收 `RELAY_READY` 后 flush。**注入胶水层，jsdom 测不了真实包装/跨 world 消息**——验证靠 `npm run compile` + 收尾手测；纯逻辑（console 序列化）已在 Task 3 覆盖。

**Files:**
- Create: `entrypoints/hook.content.ts`

- [x] **Step 1: 写 `entrypoints/hook.content.ts`（第一段：骨架 + post/backlog + console 包装）**

```ts
// entrypoints/hook.content.ts
// MAIN world hook（设计 §4、§8.1）：document_start 包装 fetch/XHR/console + 运行时错误，
// window.postMessage 桥给同页 ISOLATED content.ts。透明性第一：任何采集异常都吞掉，绝不破坏页面。
// 本文件被 WXT 打包，可 import（区别于 scripting.executeScript 的自包含函数）。
import { HOOK_MSG, RELAY_READY, type HookWindowMsg, type ConsoleEntry, type HookNetEntry } from '../shared/hook-bridge';
import { serializeConsoleArgs } from '../observe/serialize';

export default defineContentScript({
  matches: ['<all_urls>'],
  world: 'MAIN',
  runAt: 'document_start',
  allFrames: true,
  main() {
    const MAX_BODY = 64 * 1024;
    const TEXT_CT = /(text\/|application\/(json|xml|javascript|x-www-form-urlencoded)|\+json|\+xml)/i;
    const loadNonce = Math.random().toString(36).slice(2, 10);
    let seq = 0;
    let relayReady = false;
    const backlog: HookWindowMsg[] = [];
    const BACKLOG_MAX = 400;

    const post = (msg: HookWindowMsg): void => {
      try { window.postMessage(msg, '*'); } catch { /* ignore */ }
      if (!relayReady) { backlog.push(msg); if (backlog.length > BACKLOG_MAX) backlog.shift(); }
    };

    // ISOLATED 中继就绪 → flush backlog（补 document_idle 前的早期观测）
    window.addEventListener('message', (ev) => {
      if (ev.source !== window) return;
      const d = ev.data as { source?: string } | undefined;
      if (d?.source === RELAY_READY) {
        relayReady = true;
        for (const m of backlog) { try { window.postMessage(m, '*'); } catch { /* ignore */ } }
        backlog.length = 0;
      }
    });

    // ---- console 包装（永远先调原始方法）----
    const levels: Array<'log' | 'info' | 'warn' | 'error' | 'debug'> = ['log', 'info', 'warn', 'error', 'debug'];
    for (const level of levels) {
      const orig = console[level].bind(console);
      console[level] = (...args: unknown[]) => {
        orig(...args);
        try {
          const entry: ConsoleEntry = { id: `${loadNonce}:${++seq}`, level, text: serializeConsoleArgs(args), ts: Date.now(), url: location.href };
          post({ source: HOOK_MSG, kind: 'console', entry });
        } catch { /* 采集失败不影响页面 */ }
      };
    }

    // ---- 运行时错误 ----
    window.addEventListener('error', (ev) => {
      try {
        const entry: ConsoleEntry = { id: `${loadNonce}:${++seq}`, level: 'error', text: `[uncaught] ${ev.message}${ev.filename ? ` @ ${ev.filename}:${ev.lineno}` : ''}`, ts: Date.now(), url: location.href };
        post({ source: HOOK_MSG, kind: 'console', entry });
      } catch { /* ignore */ }
    });
    window.addEventListener('unhandledrejection', (ev) => {
      try {
        const reason = (ev as PromiseRejectionEvent).reason;
        const text = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
        const entry: ConsoleEntry = { id: `${loadNonce}:${++seq}`, level: 'error', text: `[unhandledrejection] ${text}`, ts: Date.now(), url: location.href };
        post({ source: HOOK_MSG, kind: 'console', entry });
      } catch { /* ignore */ }
    });

    // <PLACEHOLDER_NET_HOOK>
  },
});
```

- [x] **Step 2: 把 `// <PLACEHOLDER_NET_HOOK>` 替换为 fetch/XHR 包装（第二段）**

```ts
    // ---- 公共小工具 ----
    const capBody = (s: string | undefined): { body?: string; truncated?: boolean } => {
      if (s == null) return {};
      if (s.length > MAX_BODY) return { body: s.slice(0, MAX_BODY), truncated: true };
      return { body: s };
    };
    const headersToObj = (h: HeadersInit | Headers | undefined): Record<string, string> | undefined => {
      if (!h) return undefined;
      const out: Record<string, string> = {};
      try {
        if (h instanceof Headers) h.forEach((v, k) => { out[k] = v; });
        else if (Array.isArray(h)) for (const [k, v] of h) out[String(k)] = String(v);
        else for (const [k, v] of Object.entries(h)) out[k] = String(v);
      } catch { return undefined; }
      return out;
    };
    const isSelf = (url: string): boolean => url.startsWith('chrome-extension://') || url.startsWith('moz-extension://');

    // ---- fetch 包装（clone 读 body，原 response 原样返回）----
    const origFetch = window.fetch;
    window.fetch = async function patchedFetch(this: unknown, ...args: Parameters<typeof fetch>): Promise<Response> {
      const [input, init] = args;
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      const ts = Date.now();
      const seqN = ++seq;
      const reqHeaders = headersToObj(init?.headers ?? (input instanceof Request ? (input as Request).headers : undefined));
      const reqBody = typeof init?.body === 'string' ? init.body : undefined;
      if (isSelf(url)) return origFetch.apply(this as never, args);
      try {
        const resp = await origFetch.apply(this as never, args);
        let respBody: string | undefined; let truncated: boolean | undefined;
        try {
          const ct = resp.headers.get('content-type') ?? '';
          if (TEXT_CT.test(ct) || ct === '') {
            const c = capBody(await resp.clone().text()); respBody = c.body; truncated = c.truncated;
          }
        } catch { /* body 读取失败忽略 */ }
        const rq = capBody(reqBody);
        const entry: HookNetEntry = { loadNonce, seq: seqN, method, url, ts, endTs: Date.now(), status: resp.status, requestHeaders: reqHeaders, responseHeaders: headersToObj(resp.headers), requestBody: rq.body, responseBody: respBody, truncated: truncated || rq.truncated };
        post({ source: HOOK_MSG, kind: 'network', entry });
        return resp;
      } catch (err) {
        const rq = capBody(reqBody);
        post({ source: HOOK_MSG, kind: 'network', entry: { loadNonce, seq: seqN, method, url, ts, endTs: Date.now(), requestHeaders: reqHeaders, requestBody: rq.body, truncated: rq.truncated } });
        throw err;
      }
    } as typeof fetch;

    // ---- XHR 包装 ----
    const XHR = XMLHttpRequest.prototype;
    const origOpen = XHR.open;
    const origSend = XHR.send;
    interface Tracked { _m?: string; _u?: string; _ts?: number; _seq?: number; _reqBody?: string }
    origOpen && (XHR.open = function (this: XMLHttpRequest & Tracked, method: string, url: string, ...rest: unknown[]) {
      this._m = String(method).toUpperCase(); this._u = String(url);
      // @ts-expect-error 透传原始可变参数
      return origOpen.call(this, method, url, ...rest);
    } as typeof XHR.open);
    origSend && (XHR.send = function (this: XMLHttpRequest & Tracked, body?: Document | XMLHttpRequestBodyInit | null) {
      this._ts = Date.now(); this._seq = ++seq;
      this._reqBody = typeof body === 'string' ? body : undefined;
      const url = this._u ?? '';
      if (!isSelf(url)) {
        this.addEventListener('loadend', () => {
          try {
            let respBody: string | undefined; let truncated: boolean | undefined;
            const ct = this.getResponseHeader('content-type') ?? '';
            if ((this.responseType === '' || this.responseType === 'text') && (TEXT_CT.test(ct) || ct === '')) {
              const c = capBody(this.responseText); respBody = c.body; truncated = c.truncated;
            }
            const rq = capBody(this._reqBody);
            const respHeaders: Record<string, string> = {};
            for (const line of (this.getAllResponseHeaders() || '').trim().split(/\r?\n/)) {
              const i = line.indexOf(':'); if (i > 0) respHeaders[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
            }
            const entry: HookNetEntry = { loadNonce, seq: this._seq!, method: this._m ?? 'GET', url, ts: this._ts!, endTs: Date.now(), status: this.status, responseHeaders: respHeaders, requestBody: rq.body, responseBody: respBody, truncated: truncated || rq.truncated };
            post({ source: HOOK_MSG, kind: 'network', entry });
          } catch { /* ignore */ }
        });
      }
      return origSend.call(this, body ?? null);
    } as typeof XHR.send);
```

- [x] **Step 3: 编译**

Run: `npm run compile`
Expected: 退出码 0。

- [x] **Step 4: 构建确认第二个 content script 产出**

Run: `npm run build`
Expected: 退出码 0；`.output/chrome-mv3/manifest.json` 的 `content_scripts` 出现 `world:"MAIN"` + `run_at:"document_start"` 的一项（WXT 由 `hook.content.ts` 的 `defineContentScript` 自动生成，无需改 wxt.config.ts）。可 `cat .output/chrome-mv3/manifest.json` 目视确认。

- [x] **Step 5: Commit**

```bash
git add entrypoints/hook.content.ts
git diff --cached --name-only
git commit -m "feat: MAIN world hook 注入（包装 fetch/XHR/console + 运行时错误 + backlog/flush）"
```

---

### Task 10: content.ts 中继 HOOK_* + 发 RELAY_READY + 清死码（`entrypoints/content.ts` + `shared/messages.ts`）

ISOLATED content.ts 监听 MAIN hook 的 window 消息 → `runtime.sendMessage` 中继到 SW；attach 时发 `RELAY_READY` 触发 hook flush backlog；同时删掉 `route()` 里已成死代码的 `EVALUATE`（走 background scripting）与 `CONSOLE_READ`（改读 SW 缓冲）两个 case，并从 `BgToCsRequestMap` 删这两项（与 exhaustive `never` 检查耦合，必须同 commit）。

> **并发热点**：`content.ts` 可能被其他会话同时改。开工前先 `git status --short entrypoints/content.ts` 看是否有未提交改动；若有，等其落定或与其协调，避免覆盖。本 task 只加 relay 段 + 删两个 case。

**Files:**
- Modify: `entrypoints/content.ts`
- Modify: `shared/messages.ts`

> 无 content.ts 专属单测（本仓 content.ts 逻辑由 registry/shared 测试间接覆盖）；本 task 验证靠 `npm run compile`（exhaustive `never` 检查兜底）+ 既有测试全绿。

- [x] **Step 1: 从 `shared/messages.ts` 的 `BgToCsRequestMap` 删除两行**

删掉这两项（其余保留）：

```ts
  EVALUATE: { function: string; args?: unknown[]; world?: 'main' | 'isolated'; timeoutMs?: number };
  CONSOLE_READ: { types?: string[]; limit?: number };
```

- [x] **Step 2: 修改 `entrypoints/content.ts` 的 `route()`：删两个死 case**

删掉：

```ts
    case 'EVALUATE': return { ok: false, error: 'evaluate_script 未在 Phase 2 实现' };
    case 'CONSOLE_READ': return { ok: false, error: 'console 读取未在 Phase 2 实现' };
```

（`default` 的 `_exhaustive: never` 分支保留——删掉 map 项后它仍成立。）

- [x] **Step 3: 修改 `entrypoints/content.ts`：顶部 import + main() 内加 hook 中继**

顶部 import 追加：

```ts
import { HOOK_MSG, RELAY_READY, type HookWindowMsg } from '../shared/hook-bridge';
```

在 `main()` 内、现有 `browser.runtime.onMessage.addListener(...)` 之后、`CS_READY` 发送之前，插入 hook 中继段：

```ts
    // MAIN world hook（hook.content.ts）经 window.postMessage 送来的 console/network 观测：
    // ISOLATED 侧在此中继到 background（runtime.sendMessage），SW 写入 observe-store。
    window.addEventListener('message', (ev) => {
      if (ev.source !== window) return;
      const d = ev.data as HookWindowMsg | undefined;
      if (!d || d.source !== HOOK_MSG) return;
      const type = d.kind === 'console' ? 'HOOK_CONSOLE' : 'HOOK_NETWORK';
      browser.runtime.sendMessage({ type, payload: { entries: [d.entry] } }).catch(() => {});
    });
    // 告诉 hook「中继已就绪」→ hook flush 掉 document_idle 之前缓冲的早期观测。
    // 先加上面的 listener 再发，保证 flush 出来的消息被接住。
    window.postMessage({ source: RELAY_READY }, '*');
```

- [x] **Step 4: 编译**

Run: `npm run compile`
Expected: 退出码 0（确认 BgToCsRequestMap 删项后 content.ts switch、registry、createRequest 全链路仍一致）。

- [x] **Step 5: 跑受影响测试**

Run: `npx vitest run tests/shared tests/agent/tools/registry.test.ts`
Expected: 全部 passed。

- [x] **Step 6: Commit**

```bash
git add entrypoints/content.ts shared/messages.ts
git diff --cached --name-only   # 应只含这 2 个（若 content.test.ts 改了则 3 个）
git commit -m "feat: content.ts 中继 HOOK_* 到 SW + 发 RELAY_READY；删 EVALUATE/CONSOLE_READ 死码"
```

---

### Task 11: background 接线（HOOK_* handler + webRequest 监听）

`entrypoints/background.ts` 加 `HOOK_CONSOLE`/`HOOK_NETWORK` router handler（从 `sender.tab.id` 取 tabId → 写 observe-store）+ `attachObservers()`（webRequest 三事件 → 记 network 主干；main_frame 清网络缓冲；tab 关闭清全缓冲）。webRequest 接线放本文件（background 统管 browser 事件接线，observe-store 保持纯数据可测）。

**Files:**
- Modify: `entrypoints/background.ts`

- [x] **Step 1: 修改 `entrypoints/background.ts` —— import**

顶部追加：

```ts
import {
  ingestConsole, ingestHookNet,
  recordRequestStart, recordRequestEnd, recordRequestError,
  clearTab, clearTabNetwork,
} from '../background/observe-store';
import type { ConsoleEntry, HookNetEntry } from '../shared/hook-bridge';
```

- [x] **Step 2: 在 `defineBackground(() => {...})` 内，`CS_READY` handler 之后加 HOOK_* handler**

```ts
  // MAIN hook 经 content.ts 中继来的观测：tabId 以 sender.tab.id 为准（payload 内不带）。
  router.on('HOOK_CONSOLE', async (msg, sender) => {
    const tabId = sender?.tab?.id;
    const entries = (msg as { payload?: { entries?: ConsoleEntry[] } }).payload?.entries ?? [];
    if (tabId != null) ingestConsole(tabId, entries);
    return { ok: true };
  });
  router.on('HOOK_NETWORK', async (msg, sender) => {
    const tabId = sender?.tab?.id;
    const entries = (msg as { payload?: { entries?: HookNetEntry[] } }).payload?.entries ?? [];
    if (tabId != null) ingestHookNet(tabId, entries);
    return { ok: true };
  });
```

- [x] **Step 3: 在 `defineBackground` 内加 `attachObservers()` 定义与调用**

在 `attachAgentPort(); router.attach();` 附近加调用 `attachObservers();`，并在文件内定义：

```ts
  function attachObservers(): void {
    const FILTER = { urls: ['<all_urls>'] as string[] };
    browser.webRequest.onBeforeRequest.addListener((d) => {
      if (d.tabId < 0 || d.url.startsWith('chrome-extension://')) return;
      if (d.type === 'main_frame') clearTabNetwork(d.tabId); // 翻页语义：清旧网络缓冲
      recordRequestStart(d.tabId, { requestId: d.requestId, method: d.method, url: d.url, type: d.type, ts: d.timeStamp });
    }, FILTER);
    browser.webRequest.onCompleted.addListener((d) => {
      if (d.tabId < 0) return;
      recordRequestEnd(d.requestId, { status: d.statusCode, ts: d.timeStamp });
    }, FILTER);
    browser.webRequest.onErrorOccurred.addListener((d) => {
      if (d.tabId < 0) return;
      recordRequestError(d.requestId, { error: d.error, ts: d.timeStamp });
    }, FILTER);
    browser.tabs.onRemoved.addListener((tabId) => clearTab(tabId));
  }
```

- [x] **Step 4: 编译 + 构建**

Run: `npm run compile && npm run build`
Expected: 两个退出码 0；`.output/chrome-mv3/manifest.json` 含 `webRequest` 权限（wxt.config.ts 已声明）。

- [x] **Step 5: 全量测试（确认接线未破坏既有）**

Run: `npm test`
Expected: 全绿（新增 observe-store/serialize/redact/observe/hook-bridge/messages-phase3b 各测试文件 + 原有全部）。

- [x] **Step 6: Commit**

```bash
git add entrypoints/background.ts
git diff --cached --name-only
git commit -m "feat: background 接 HOOK_* 中继写缓冲 + webRequest 监听建网络主干（main_frame 清缓冲）"
```

---

### Task 12: 收尾验证 + 文档更新

**Files:**
- Modify: `docs/superpowers/plans/2026-09-01-ai-browser-extension-phase3b.md`（勾选状态）
- Modify: `CLAUDE.md`（当前阶段：Phase 3b 完成）

- [x] **Step 1: 全量编译 + 测试 + 构建**

Run: `npm run compile && npm test && npm run build`
Expected: 三项全成功（tsc EXIT 0；vitest 全绿；build 产出 `.output/chrome-mv3/`，含 MAIN world `hook.content.js` + `content.js` 两个 content script）。

- [x] **Step 2: 手动冒烟（需真实 Chrome）**

在 `chrome://extensions` 重新加载 `.output/chrome-mv3`，然后：

1. 打开一个会报 console 且发 fetch 的普通页面（如任意带前端接口的站点）。
2. 侧边栏输入「看看这个页面的 console 有没有报错」→ 预期 `list_console_messages` 卡片返回日志文本，含 error 级别（若有）。
3. 输入「列出这个页面发了哪些网络请求」→ 预期 `list_network_requests` 返回摘要列表（method/url/status）。
4. 对某条 `hasBody:true` 的输入「看看那条 /api 请求的响应体」→ 预期 `get_network_request` 返回 responseBody，敏感头显示 `[REDACTED]`。
5. 设置页把 `networkCaptureHeaders` 切 `full`（若设置页未暴露该项，手动改 storage 或留待 UI 后续）→ 再取同请求，Authorization 显示原文。
6. 点一个 `target="_blank"` 链接后再「看新页面的网络请求」→ 验证 targetTab 已跟随（Phase 3a bug 修复的联动）+ 新页面观测正常。
7. 在 `chrome://extensions` 输入「列出 console」→ 预期返回空列表（豁免受限页、不报错）。

- [x] **Step 3: 勾选本计划所有 checkbox；在文件末尾「Phase 3c handoff」小节记已知项**

- [x] **Step 4: 更新 `CLAUDE.md` 的「当前阶段」段**

把 Phase 3b 完成的能力（MAIN world hook 基础设施 + list_console_messages + 网络双通道 list/get_network_requests，16→19）记入，`webRequest` 通道 + hook 通道说明。

- [x] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-09-01-ai-browser-extension-phase3b.md CLAUDE.md
git diff --cached --name-only
git commit -m "chore: Phase 3b 收尾验证 + 文档更新（观测三工具落地，16→19）"
```

---

## Self-Review 记录

- **Spec 覆盖**：设计 §1 三工具 → Task 1（schema）+ Task 7（执行器）+ Task 8（分发）；§3 架构 → Task 9（MAIN hook）+ Task 10（中继）+ Task 11（SW 接线）；§4.1 console 流 → Task 3（序列化）+ Task 9（hook）+ Task 5（缓冲）+ Task 10/11（中继/写入）；§4.2 network 双通道 → Task 5（关联）+ Task 9（hook body）+ Task 11（webRequest 主干）；§4.3 headers/脱敏时机 → Task 4（redact）+ Task 7（读取时脱敏）+ Task 1（settings 开关）；§7.1 window 桥 → Task 2（hook-bridge）；§7.2 runtime 通知 → Task 6；§8 边界 → Task 9（透明性/backlog）+ Task 5（环形/清理）；§9 测试 → 各 task 内嵌；§10 冻结接口 → Task 5（store）+ Task 2（数据形状）。全部有对应 task。
- **类型一致性**：`ConsoleEntry`/`HookNetEntry`（Task 2 定义）在 hook（Task 9）、messages（Task 6）、store（Task 5）、工具（Task 7）一致引用；`NetEntry.source: 'webRequest'|'hook'|'merged'`（Task 5）在 get 执行器（Task 7）透传；`redactHeaders(headers, mode, maxCount?)` 签名（Task 4）在 Task 7 调用一致；`recordRequestStart/End/Error`、`ingestConsole/ingestHookNet`、`readConsole/readNetworkList/readNetworkDetail`、`clearTab/clearTabNetwork`（Task 5 定义）在 Task 7（读）、Task 11（写/清）调用一致；`HOOK_MSG`/`RELAY_READY`（Task 2）在 hook（Task 9）、content（Task 10）一致；`settings.agent.networkCaptureHeaders`（Task 1）在 Task 7 读取一致。
- **占位符扫描**：无 TBD/TODO；每个代码步骤含完整代码（hook.content.ts 的 `<PLACEHOLDER_NET_HOOK>` 是 Step 1→Step 2 的接续锚点，Step 2 明确替换，非遗留占位）。
- **编译连锁**：删 `CONSOLE_READ`/`EVALUATE`（BgToCsRequestMap ↔ content.ts switch exhaustive）集中在 Task 10 同 commit；删 `NETLOG_PUSH`（messages ↔ background handler）集中在 Task 6 同 commit——每个 task 独立编译绿。

## 给 Phase 3c 的接口契约 + handoff（实现后填写）

> **实现完成**：12 task 全绿（compile exit 0 / vitest 334 passed / build 产出 content.js + MAIN world hook.js）。以下为实施 + 两阶段评审中确认接受的降级与后续项。

- **手动冒烟待做**（需真实 Chrome，尚未执行）：加载 `.output/chrome-mv3` → ①「看这个页面 console 有没有报错」得 list_console_messages 卡片含 error；②「列出这个页面发了哪些网络请求」得 list_network_requests 摘要；③对某 hasBody 条目「看那条 /api 的响应体」得 get_network_request，默认敏感头 `[REDACTED]`；④设置 `networkCaptureHeaders=full`（手改 storage）后再取，Authorization 原文；⑤点 target=_blank 链接后「看新页面网络请求」验 targetTab 跟随 + 新页观测；⑥在 `chrome://extensions`「列出 console」得空列表（豁免受限页、不报错）。
- **已知降级 / 安全权衡**（评审确认接受，转后续）：
  - **postMessage `'*'` 同源页内可被监听**（评审 I1）：hook 经 `window.postMessage(msg,'*')` 桥接，同页任意第三方脚本可 `addEventListener('message')` 读到 body/headers。这是 MAIN↔ISOLATED 双 world 桥的固有面（DOM CustomEvent/属性同样可被拦），非本实现疏漏；改 `location.origin` 对 null-origin 沙箱帧有破坏风险且挡不住同源页内监听，故未改。后续如需闭合需换页面脚本无法监听的通道（不存在于双 world 模型）。
  - **console.toString 反爬指纹**（评审 I3）：monkeypatch 后 `console.log.toString()` 非 `[native code]`，可能被 Cloudflare/DataDome 类反爬脚本判为异常。绕过（Proxy / 改 Function.prototype.toString）自身脆弱，未做，显式接受。
  - **hookKeys 长命 SPA 无界增长**（评审 Task 5 Important）：`consoleIds` 有淘汰后重建、`hookKeys` 无（merged 条目不留 hook key，无法从环形数组重建）。按 tab 生命期有界、导航即清；如需封死，后续可在 NetEntry 存 hookKey 后重建，或给 hookKeys 加上限。
  - **翻页迟到 flush 陈旧条目**（评审 Task 11 前瞻）：main_frame `clearTabNetwork` 后，旧页 hook 的在途 flush 可能把旧 loadNonce/时间戳条目落进新页网络缓冲。flush-before-clear 不可实现（SW 无法感知垂死页在途 flush），接受为 best-effort。
  - headers 只覆盖 JS 发起请求（webRequest 无 `extraHeaders`）；文档/img/script 等只有元数据。
  - 请求 body 仅抓 string 型（Blob/FormData/URLSearchParams/ReadableStream 及 `fetch(new Request(...))` 的 body 不抓）。
  - body 关联 best-effort（同 url+method 短时多次请求可能错配，±2s 窗口兜底）。
  - SW 重启丢缓冲（不持久化）；大流量页环形缓冲 200 条上限淘汰早期条目。
  - `rel="noopener"` 打开的新标签无 `openerTabId` → Phase 3a 的 targetTab 跟随探测不到（如需覆盖，后续加「交互前后 tab 差集」兜底）。
  - `networkCaptureHeaders` 全量开关暂无设置页 UI（走 storage，留 UI 后续）。
  - 敏感头脱敏集（`observe/redact.ts` SENSITIVE_HEADERS）可补 `x-amz-security-token`/`x-goog-api-key` 等云厂商凭证头（评审 Task 4 建议）。
- **深度诊断模式**（方案 B / debugger+CDP）留作后续可选增强：observe-store 的 per-tab 缓冲 + 关联逻辑已模块化，可作为第二数据源并入同一缓冲。








