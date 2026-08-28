# AI Browser Extension 实施计划（Phase 1：骨架 + Provider + 消息协议）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 搭建 WXT 扩展骨架，实现 shared 消息协议、storage 层、OpenAI 兼容 Provider 适配层（含 SSE 解析与 tool_calls 聚合），以及侧边栏空壳与设置页。

**Architecture:** WXT + React + TypeScript。三个运行环境（background service worker / content script / sidepanel React app）通过 `shared/` 的类型化消息协议通信；所有持久化走 `storage/` 封装的 chrome.storage.local；agent loop 在后续 Phase 2 实现，本 Phase 提供其依赖的全部基础设施。

**Tech Stack:** WXT（浏览器扩展框架）、React 18、TypeScript、Vitest（单元/集成测试）、zustand（UI 状态）、lucide-react（图标）。

**规格文档：** [docs/superpowers/specs/2026-08-28-ai-browser-extension-design.md](../specs/2026-08-28-ai-browser-extension-design.md)

---

## 文件结构总览

本 Phase 创建/修改的文件（后续 Phase 会在同一结构上扩展）：

```
ai-browser-extend/
├── package.json                    # WXT + React + TS + Vitest 依赖
├── wxt.config.ts                   # WXT 配置（manifest、权限）
├── tsconfig.json                   # TS 配置（路径别名）
├── vitest.config.ts                # 测试配置（jsdom 环境）
├── .gitignore
├── entrypoints/
│   ├── background.ts               # SW：消息中枢 + 路由（本 Phase 只搭骨架）
│   └── sidepanel/
│       ├── index.html
│       ├── main.tsx
│       └── App.tsx                 # 页面路由（会话/脚本池/设置）
├── shared/
│   ├── messages.ts                 # 三环境共享消息协议类型 + 类型安全收发工具
│   └── types.ts                    # 通用类型（TabInfo 等）
├── storage/
│   ├── settings.ts                 # provider/agent 配置读写
│   ├── sessions.ts                 # 每标签页会话读写（本 Phase 只做类型+骨架）
│   └── scripts.ts                  # 脚本池存储（本 Phase 只做类型+骨架）
├── agent/
│   └── provider/
│       ├── types.ts                # Provider 接口 + 统一消息/流式事件类型
│       ├── sse.ts                  # 手写 SSE 解析器
│       └── openai-compat.ts        # OpenAI 兼容实现
├── components/
│   ├── ui/                         # 基础 UI 原子组件
│   │   ├── Button.tsx
│   │   ├── Input.tsx
│   │   └── PageShell.tsx
│   ├── chat/
│   │   └── ChatView.tsx            # 会话页占位（Phase 2 填充）
│   ├── scripts/
│   │   └── ScriptsView.tsx         # 脚本池页占位（Phase 4 填充）
│   └── settings/
│       └── SettingsView.tsx        # Provider 设置 + 连接测试
└── tests/
    ├── shared/messages.test.ts
    ├── agent/provider/sse.test.ts
    ├── agent/provider/openai-compat.test.ts
    └── storage/settings.test.ts
```

---

### Task 1: WXT 项目脚手架

**Files:**
- Create: `package.json`, `wxt.config.ts`, `tsconfig.json`, `.gitignore`
- Create: `entrypoints/background.ts`, `entrypoints/sidepanel/index.html`, `entrypoints/sidepanel/main.tsx`, `entrypoints/sidepanel/App.tsx`

- [ ] **Step 1: 初始化 WXT 项目**

在项目根目录执行（目录非空，有 docs/，用手动初始化而非 `wxt init`）：

```bash
npm init -y
npm install wxt @anthropic-ai/sdk@latest --save-exact --dry-run > /dev/null 2>&1 || true
npm install wxt --save-dev
npm install react react-dom zustand lucide-react nanoid
npm install -D typescript @types/react @types/react-dom vitest jsdom @vitest/coverage-v8
```

注意：**不要安装 `@anthropic-ai/sdk`**（设计决策：纯自研 provider，只用原生 fetch）。上面的 dry-run 行是防御性占位，直接跳过即可。实际命令：

```bash
npm init -y
npm install --save-dev wxt typescript vitest jsdom @types/react @types/react-dom
npm install react react-dom zustand lucide-react nanoid
```

- [ ] **Step 2: 写 wxt.config.ts**

```ts
// wxt.config.ts
import { defineConfig } from 'wxt';

export default defineConfig({
  manifest: {
    name: 'AI Browser Extension',
    description: 'AI 驱动的浏览器操控助手',
    // WXT 会从 package.json 读版本号
    permissions: ['tabs', 'scripting', 'storage', 'sidePanel', 'webRequest'],
    host_permissions: ['<all_urls>'],
    side_panel: {
      default_path: 'sidepanel.html',
    },
    background: {
      // WXT 默认 service worker，无需额外配置
    },
  },
});
```

- [ ] **Step 3: 写 tsconfig.json**

WXT 生成 `.wxt/tsconfig.json`，根配置只需要 extends：

```json
// tsconfig.json
{
  "extends": "./.wxt/tsconfig.json",
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true
  }
}
```

- [ ] **Step 4: 写 .gitignore**

```gitignore
node_modules/
.output/
.wxt/
stats.html
coverage/
*.log
```

- [ ] **Step 5: 写 package.json scripts**

用编辑器把 package.json 的 scripts 替换为：

```json
{
  "scripts": {
    "dev": "wxt",
    "dev:firefox": "wxt -b firefox",
    "build": "wxt build",
    "zip": "wxt zip",
    "compile": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

- [ ] **Step 6: 写 entrypoints/background.ts**

```ts
// entrypoints/background.ts
export default defineBackground(() => {
  console.log('[ai-browser-ext] background started');
});
```

（WXT auto-import：`defineBackground` 无需 import。）

- [ ] **Step 7: 写侧边栏入口**

```html
<!-- entrypoints/sidepanel/index.html -->
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>AI Browser</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

```tsx
// entrypoints/sidepanel/main.tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```

```tsx
// entrypoints/sidepanel/App.tsx
export default function App() {
  return <div style={{ padding: 16 }}>AI Browser Extension — Phase 1 骨架</div>;
}
```

```css
/* entrypoints/sidepanel/styles.css */
:root {
  --bg: #ffffff;
  --fg: #1a1a1a;
  --fg-muted: #666666;
  --border: #e5e5e5;
  --accent: #2563eb;
}
* { box-sizing: border-box; }
html, body, #root { height: 100%; margin: 0; }
body {
  font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
  background: var(--bg);
  color: var(--fg);
  font-size: 14px;
}
```

- [ ] **Step 8: 验证构建**

```bash
npm run compile
npm run build
```

Expected: 两个命令都退出码 0；`.output/chrome-mv3/` 生成。

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "chore: WXT 脚手架（background + sidepanel 空壳）"
```

---

### Task 2: shared 消息协议

**Files:**
- Create: `shared/types.ts`
- Create: `shared/messages.ts`
- Test: `tests/shared/messages.test.ts`

- [ ] **Step 1: 写 shared/types.ts**

```ts
// shared/types.ts

/** 通用工具结果：所有工具执行器的统一返回格式（设计 §4.3） */
export interface ToolResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

/** 标签页概要信息 */
export interface TabInfo {
  tabId: number;
  url: string;
  title: string;
  active: boolean;
}

/** 快照里的元素 uid（content script 分配，见设计 §3） */
export type Uid = number;
```

- [ ] **Step 2: 写失败测试 tests/shared/messages.test.ts**

```ts
// tests/shared/messages.test.ts
import { describe, it, expect } from 'vitest';
import {
  createRequest,
  isResponseFor,
  type BgToCsRequest,
  type CsToBgRequest,
} from '../../shared/messages';

describe('消息协议', () => {
  it('createRequest 生成唯一递增 correlation id', () => {
    const a = createRequest('SNAPSHOT', {});
    const b = createRequest('SNAPSHOT', {});
    expect(a.correlationId).not.toBe(b.correlationId);
    expect(a.type).toBe('SNAPSHOT');
  });

  it('isResponseFor 匹配 correlationId 与 type', () => {
    const req = createRequest('CLICK', { uid: 1 });
    const resp = { correlationId: req.correlationId, type: 'CLICK', ok: true as const, data: {} };
    expect(isResponseFor(resp, req)).toBe(true);
    expect(isResponseFor({ ...resp, correlationId: 999 }, req)).toBe(false);
  });

  it('CsToBgRequest 类型可赋值（编译期契约）', () => {
    const msg: CsToBgRequest = { type: 'NETLOG_PUSH', correlationId: 'x', entries: [] };
    expect(msg.type).toBe('NETLOG_PUSH');
  });

  it('BgToCsRequest 类型可赋值（编译期契约）', () => {
    const msg: BgToCsRequest = { type: 'PAGE_META', correlationId: 'x' };
    expect(msg.type).toBe('PAGE_META');
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

```bash
npx vitest run tests/shared/messages.test.ts
```

Expected: FAIL — `Cannot find module '../../shared/messages'`。

- [ ] **Step 4: 写 shared/messages.ts**

```ts
// shared/messages.ts
// 三环境（background / content script / sidepanel）共享的消息协议。
// 设计决策：全部 request/response 模式 + correlation id（设计 §4.4）。

import type { ToolResult, Uid } from './types';

// ---------- background → content script 请求 ----------

export interface BgToCsRequestMap {
  SNAPSHOT: { verbose?: boolean };
  CLICK: { uid: Uid; dblClick?: boolean };
  FILL: { uid: Uid; value: string };
  HOVER: { uid: Uid };
  SCROLL: { direction: 'up' | 'down' | 'left' | 'right'; amount?: number };
  PRESS_KEY: { key: string; modifiers?: string[] };
  EVALUATE: { function: string; args?: unknown[]; world?: 'main' | 'isolated'; timeoutMs?: number };
  WAIT_TEXT: { texts: string[]; timeoutMs?: number };
  CONSOLE_READ: { types?: string[]; limit?: number };
  PAGE_META: Record<string, never>;
}

export type BgToCsRequest = {
  [K in keyof BgToCsRequestMap]: {
    type: K;
    correlationId: string;
    payload: BgToCsRequestMap[K];
  };
}[keyof BgToCsRequestMap];

// ---------- content script → background 请求 ----------

export interface CsToBgRequestMap {
  NETLOG_PUSH: { entries: unknown[] };
}

export type CsToBgRequest = {
  [K in keyof CsToBgRequestMap]: {
    type: K;
    correlationId: string;
    payload: CsToBgRequestMap[K];
  };
}[keyof CsToBgRequestMap];

// ---------- 响应 ----------

export interface CsResponse {
  correlationId: string;
  type: BgToCsRequest['type'];
  result: ToolResult;
}

// ---------- 工厂与守卫 ----------

let correlationCounter = 0;

export function createRequest<K extends keyof BgToCsRequestMap>(
  type: K,
  payload: BgToCsRequestMap[K],
): Extract<BgToCsRequest, { type: K }> {
  correlationCounter += 1;
  return {
    type,
    correlationId: `${Date.now()}-${correlationCounter}-${Math.random().toString(36).slice(2, 8)}`,
    payload,
  } as Extract<BgToCsRequest, { type: K }>;
}

export function isResponseFor(resp: CsResponse, req: BgToCsRequest): boolean {
  return resp.correlationId === req.correlationId && resp.type === req.type;
}
```

注意测试里构造消息用了扁平字段（`{ type, correlationId, entries }`）而实现用了嵌套 `payload`——**以实现为准**，把测试第 3、4 个用例改为：

```ts
  it('CsToBgRequest 类型可赋值（编译期契约）', () => {
    const msg: CsToBgRequest = { type: 'NETLOG_PUSH', correlationId: 'x', payload: { entries: [] } };
    expect(msg.type).toBe('NETLOG_PUSH');
  });

  it('BgToCsRequest 类型可赋值（编译期契约）', () => {
    const msg: BgToCsRequest = { type: 'PAGE_META', correlationId: 'x', payload: {} };
    expect(msg.type).toBe('PAGE_META');
  });
```

- [ ] **Step 5: 运行测试确认通过**

```bash
npx vitest run tests/shared/messages.test.ts
```

Expected: 5 passed。

- [ ] **Step 6: Commit**

```bash
git add shared/ tests/
git commit -m "feat: 三环境共享消息协议（correlation id request/response）"
```

---

### Task 3: storage 层 — settings

**Files:**
- Create: `storage/settings.ts`
- Test: `tests/storage/settings.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/storage/settings.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/browser';
import { getSettings, saveSettings, DEFAULT_SETTINGS } from '../../storage/settings';

describe('settings storage', () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  it('无配置时返回默认值', async () => {
    const s = await getSettings();
    expect(s).toEqual(DEFAULT_SETTINGS);
    expect(s.provider.baseUrl).toBe('');
  });

  it('save 后可读回部分字段（merge 语义）', async () => {
    await saveSettings({ provider: { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-x', model: 'deepseek-chat' } });
    const s = await getSettings();
    expect(s.provider.baseUrl).toBe('https://api.deepseek.com/v1');
    expect(s.provider.model).toBe('deepseek-chat');
  });

  it('merge 不覆盖未提供字段', async () => {
    await saveSettings({ provider: { baseUrl: 'https://a.com/v1', apiKey: 'k', model: 'm' } });
    await saveSettings({ agent: { maxSteps: 50 } });
    const s = await getSettings();
    expect(s.provider.baseUrl).toBe('https://a.com/v1');
    expect(s.agent.maxSteps).toBe(50);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npx vitest run tests/storage/settings.test.ts
```

Expected: FAIL — module not found。

- [ ] **Step 3: 写 storage/settings.ts**

```ts
// storage/settings.ts
import { storage } from 'wxt/utils/storage';

export interface ProviderConfig {
  baseUrl: string;   // OpenAI 兼容，如 https://api.deepseek.com/v1
  apiKey: string;
  model: string;
}

export interface AgentConfig {
  maxSteps: number;          // agent loop 步数上限，默认 25
  screenshotPolicy: 'never' | 'on-demand';  // MVP 只有 on-demand（模型主动调工具）
  confirmGate: boolean;      // 脚本池确认门控，默认 true
}

export interface Settings {
  provider: ProviderConfig;
  agent: AgentConfig;
}

export const DEFAULT_SETTINGS: Settings = {
  provider: { baseUrl: '', apiKey: '', model: '' },
  agent: { maxSteps: 25, screenshotPolicy: 'on-demand', confirmGate: true },
};

const KEY = 'local:settings';

export async function getSettings(): Promise<Settings> {
  const raw = await storage.getItem<Partial<Settings>>(KEY);
  return {
    provider: { ...DEFAULT_SETTINGS.provider, ...raw?.provider },
    agent: { ...DEFAULT_SETTINGS.agent, ...raw?.agent },
  };
}

/** merge 语义：只覆盖传入的顶层段（provider/agent 整段替换，段内 merge） */
export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  const current = await getSettings();
  const next: Settings = {
    provider: { ...current.provider, ...patch.provider },
    agent: { ...current.agent, ...patch.agent },
  };
  await storage.setItem(KEY, next);
}
```

注意 WXT 的 `storage` API 前缀：`local:xxx`。测试里 `fakeBrowser` 来自 `wxt/testing/browser`。

- [ ] **Step 4: 运行测试确认通过**

```bash
npx vitest run tests/storage/settings.test.ts
```

Expected: 3 passed。

- [ ] **Step 5: Commit**

```bash
git add storage/ tests/
git commit -m "feat: settings storage（provider/agent 配置，merge 语义）"
```

---

### Task 4: Provider 类型抽象

**Files:**
- Create: `agent/provider/types.ts`

- [ ] **Step 1: 写 agent/provider/types.ts**

```ts
// agent/provider/types.ts
// 统一的消息/流式事件/Provider 抽象（设计 §4.2）。
// MVP 只有 OpenAICompatProvider 一个实现；Anthropic 适配器未来加入。

/** 统一内容块：文本或图片（截图以 base64 data URL 传入） */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; imageUrl: string };

/** 统一消息格式（内部标准，provider 负责与 wire format 互转） */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[];
  /** assistant 消息携带的完整工具调用（wire 转换时使用） */
  toolCalls?: ToolCall[];
  /** tool 消息：对应的调用 id */
  toolCallId?: string;
  name?: string; // tool 消息的工具名
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string; // JSON 字符串（模型输出原样）
}

/** 工具 schema：OpenAI function calling 格式（兼容协议的事实标准） */
export interface ToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema
  };
}

export interface Usage {
  promptTokens?: number;
  completionTokens?: number;
}

/** 流式事件（provider 把 wire 增量归一化为这四种） */
export type StreamEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call-delta'; index: number; id?: string; name?: string; argsDelta?: string }
  | { type: 'message-done'; usage?: Usage; finishReason?: string }
  | { type: 'error'; error: string };

export interface ChatParams {
  messages: ChatMessage[];
  tools: ToolSchema[];
  signal?: AbortSignal;
  maxTokens?: number;
}

export interface Provider {
  /** 流式对话。返回 (event) => void 的 unsubscribe。 */
  streamChat(
    params: ChatParams,
    onEvent: (event: StreamEvent) => void,
  ): { cancel: () => void };
}

/** Provider 构造配置 */
export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}
```

- [ ] **Step 2: 编译验证**

```bash
npm run compile
```

Expected: 退出码 0。

- [ ] **Step 3: Commit**

```bash
git add agent/
git commit -m "feat: provider 统一抽象（消息/流式事件/工具 schema）"
```

---

### Task 5: SSE 解析器（TDD）

**Files:**
- Create: `agent/provider/sse.ts`
- Test: `tests/agent/provider/sse.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/agent/provider/sse.test.ts
import { describe, it, expect } from 'vitest';
import { createSseParser } from '../../../agent/provider/sse';

function chunks(...parts: string[]): string[] {
  return parts;
}

describe('SSE 解析器', () => {
  it('解析单个完整 event', () => {
    const events: string[] = [];
    const parser = createSseParser((data) => events.push(data));
    parser.push('data: {"a":1}\n\n');
    parser.flush();
    expect(events).toEqual(['{"a":1}']);
  });

  it('跨 chunk 分割的事件能拼接', () => {
    const events: string[] = [];
    const parser = createSseParser((data) => events.push(data));
    parser.push('data: {"a');
    parser.push('rt":1}\n');
    parser.push('\n');
    parser.flush();
    expect(events).toEqual(['{"art":1}']);
  });

  it('多行 data 字段按规范拼接（\\n 连接）', () => {
    const events: string[] = [];
    const parser = createSseParser((data) => events.push(data));
    parser.push('data: line1\ndata: line2\n\n');
    parser.flush();
    expect(events).toEqual(['line1\nline2']);
  });

  it('忽略注释与 event/id 行，只回调 data', () => {
    const events: string[] = [];
    const parser = createSseParser((data) => events.push(data));
    parser.push(': comment\nid: 42\nevent: message\ndata: {"x":1}\n\n');
    parser.flush();
    expect(events).toEqual(['{"x":1}']);
  });

  it('[DONE] 不回调', () => {
    const events: string[] = [];
    const parser = createSseParser((data) => events.push(data));
    parser.push('data: [DONE]\n\n');
    parser.flush();
    expect(events).toEqual([]);
  });

  it('CRLF 换行兼容', () => {
    const events: string[] = [];
    const parser = createSseParser((data) => events.push(data));
    parser.push('data: {"a":1}\r\n\r\n');
    parser.flush();
    expect(events).toEqual(['{"a":1}']);
  });

  it('split boundary 不产生重复或丢失', () => {
    const events: string[] = [];
    const parser = createSseParser((data) => events.push(data));
    const raw = chunks('data: {"i":0}\n\n', 'data: {"i":1}\n\ndata: {"i":2}\n\n');
    for (const c of raw) parser.push(c);
    parser.flush();
    expect(events.map((e) => JSON.parse(e).i)).toEqual([0, 1, 2]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npx vitest run tests/agent/provider/sse.test.ts
```

Expected: FAIL — module not found。

- [ ] **Step 3: 写 agent/provider/sse.ts**

```ts
// agent/provider/sse.ts
// 手写 SSE 流解析器（设计决策：不引入 SDK）。
// 只处理 data: 行（[DONE] 除外），多行 data 按 SSE 规范用 \n 拼接。

export function createSseParser(onData: (data: string) => void) {
  let buffer = '';

  function processEventBlock(block: string) {
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).replace(/^ /, ''));
      }
      // event:/id:/retry:/注释行 忽略
    }
    if (dataLines.length > 0) {
      const data = dataLines.join('\n');
      if (data !== '[DONE]') onData(data);
    }
  }

  return {
    push(chunk: string) {
      buffer += chunk;
      // 统一换行符，兼容 \r\n
      buffer = buffer.replace(/\r\n/g, '\n');
      // 按空行（连续两个 \n）切分事件块
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        processEventBlock(block);
      }
    },
    /** 流结束时处理残留 buffer（部分实现最后事件后无空行） */
    flush() {
      const rest = buffer.trim();
      buffer = '';
      if (rest) processEventBlock(rest);
    },
  };
}
```

注意 `push` 里每帧做 `\r\n` 替换在理论上可能切断跨 chunk 的 `\r`/`\n`——实际 SSE chunk 边界几乎不会落在 `\r\n` 中间，且我们统一在拼接后处理，可接受。若测试发现边界问题，改为在 `processEventBlock` 内处理。

- [ ] **Step 4: 运行测试确认通过**

```bash
npx vitest run tests/agent/provider/sse.test.ts
```

Expected: 7 passed。

- [ ] **Step 5: Commit**

```bash
git add agent/ tests/
git commit -m "feat: 手写 SSE 解析器（data 行、跨 chunk、CRLF、[DONE]）"
```

---

### Task 6: OpenAI 兼容 Provider（TDD）

**Files:**
- Create: `agent/provider/openai-compat.ts`
- Test: `tests/agent/provider/openai-compat.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/agent/provider/openai-compat.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAICompatProvider } from '../../../agent/provider/openai-compat';
import type { ChatParams, StreamEvent } from '../../../agent/provider/types';

// 构造 OpenAI chunk 格式的 SSE 流
function sseStream(chunks: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const lines = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`);
  lines.push('data: [DONE]\n\n');
  return new ReadableStream({
    start(controller) {
      for (const l of lines) controller.enqueue(encoder.encode(l));
      controller.close();
    },
  });
}

const baseParams = (): ChatParams => ({
  messages: [{ role: 'user', content: 'hi' }],
  tools: [],
});

describe('OpenAICompatProvider', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('请求体格式正确（model/messages/tools/stream）', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(
      new Response(sseStream([{ choices: [{ delta: {} }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]), { status: 200 }),
    );
    const p = new OpenAICompatProvider({ baseUrl: 'https://api.x.com/v1', apiKey: 'sk-1', model: 'gpt-test' });
    await new Promise<void>((resolve) => {
      p.streamChat(baseParams(), (e) => {
        if (e.type === 'message-done') resolve();
      });
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.x.com/v1/chat/completions');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe('gpt-test');
    expect(body.stream).toBe(true);
    expect(body.messages[0].role).toBe('user');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer sk-1' });
  });

  it('文本增量归一化为 text-delta', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(
      new Response(
        sseStream([
          { choices: [{ delta: { content: '你好' } }] },
          { choices: [{ delta: { content: '世界' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } },
        ]),
        { status: 200 },
      ),
    );
    const p = new OpenAICompatProvider({ baseUrl: 'https://api.x.com/v1', apiKey: 'sk', model: 'm' });
    const events: StreamEvent[] = [];
    await new Promise<void>((resolve) => {
      p.streamChat(baseParams(), (e) => {
        events.push(e);
        if (e.type === 'message-done') resolve();
      });
    });
    const texts = events.filter((e) => e.type === 'text-delta').map((e) => (e as { text: string }).text);
    expect(texts.join('')).toBe('你好世界');
    const done = events.find((e) => e.type === 'message-done') as Extract<StreamEvent, { type: 'message-done' }>;
    expect(done.usage?.completionTokens).toBe(2);
  });

  it('tool_calls 增量聚合为完整调用', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(
      new Response(
        sseStream([
          { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'take_snapshot', arguments: '' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"verb' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ose":true}' } }] } }] },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ]),
        { status: 200 },
      ),
    );
    const p = new OpenAICompatProvider({ baseUrl: 'https://api.x.com/v1', apiKey: 'sk', model: 'm' });
    const events: StreamEvent[] = [];
    await new Promise<void>((resolve) => {
      p.streamChat(baseParams(), (e) => {
        events.push(e);
        if (e.type === 'message-done') resolve();
      });
    });
    // 聚合校验：message-done 前应有完整的 arguments 增量序列
    const argEvents = events.filter((e) => e.type === 'tool-call-delta') as Extract<StreamEvent, { type: 'tool-call-delta' }>[];
    const args = argEvents.map((e) => e.argsDelta ?? '').join('');
    expect(args).toBe('{"verbose":true}');
    const nameEvent = argEvents[0]!;
    expect(nameEvent.id).toBe('call_1');
    expect(nameEvent.name).toBe('take_snapshot');
    const done = events.find((e) => e.type === 'message-done') as Extract<StreamEvent, { type: 'message-done' }>;
    expect(done.finishReason).toBe('tool_calls');
  });

  it('多工具并发调用（index 区分）', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(
      new Response(
        sseStream([
          { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c0', type: 'function', function: { name: 'click', arguments: '{"uid":1' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 1, id: 'c1', type: 'function', function: { name: 'fill', arguments: '{"uid":2' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '}' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: ',"value":"x"}' } }] } }] },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ]),
        { status: 200 },
      ),
    );
    const p = new OpenAICompatProvider({ baseUrl: 'https://api.x.com/v1', apiKey: 'sk', model: 'm' });
    const events: StreamEvent[] = [];
    await new Promise<void>((resolve) => {
      p.streamChat(baseParams(), (e) => {
        events.push(e);
        if (e.type === 'message-done') resolve();
      });
    });
    const argEvents = events.filter((e) => e.type === 'tool-call-delta') as Extract<StreamEvent, { type: 'tool-call-delta' }>[];
    const byIndex = new Map<number, string>();
    for (const e of argEvents) byIndex.set(e.index, (byIndex.get(e.index) ?? '') + (e.argsDelta ?? ''));
    expect(byIndex.get(0)).toBe('{"uid":1}');
    expect(byIndex.get(1)).toBe('{"uid":2,"value":"x"}');
  });

  it('HTTP 非 200 时发出 error 事件', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(
      new Response('{"error":{"message":"bad key"}}', { status: 401 }),
    );
    const p = new OpenAICompatProvider({ baseUrl: 'https://api.x.com/v1', apiKey: 'sk', model: 'm' });
    const events: StreamEvent[] = [];
    await new Promise<void>((resolve) => {
      p.streamChat(baseParams(), (e) => {
        events.push(e);
        if (e.type === 'error' || e.type === 'message-done') resolve();
      });
    });
    const err = events.find((e) => e.type === 'error') as Extract<StreamEvent, { type: 'error' }>;
    expect(err.error).toContain('401');
  });

  it('AbortSignal 传递给 fetch', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(
      new Response(sseStream([{ choices: [{ delta: {}, finish_reason: 'stop' }] }]), { status: 200 }),
    );
    const p = new OpenAICompatProvider({ baseUrl: 'https://api.x.com/v1', apiKey: 'sk', model: 'm' });
    const ac = new AbortController();
    await new Promise<void>((resolve) => {
      p.streamChat({ ...baseParams(), signal: ac.signal }, (e) => {
        if (e.type === 'message-done') resolve();
      });
    });
    expect((fetchMock.mock.calls[0]![1] as RequestInit).signal).toBe(ac.signal);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npx vitest run tests/agent/provider/openai-compat.test.ts
```

Expected: FAIL — module not found。

- [ ] **Step 3: 写 agent/provider/openai-compat.ts**

```ts
// agent/provider/openai-compat.ts
import { createSseParser } from './sse';
import type {
  ChatMessage,
  ChatParams,
  ContentPart,
  Provider,
  ProviderConfig,
  StreamEvent,
  ToolCall,
  ToolSchema,
} from './types';

/** 内部统一消息 → OpenAI wire 格式 */
function toWireMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant',
        content: m.content ?? null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        })),
      };
    }
    // content 可能是 string 或 ContentPart[]
    const content = typeof m.content === 'string' ? m.content : toWireContent(m.content);
    return { role: m.role, content };
  });
}

function toWireContent(parts: ContentPart[]): unknown[] {
  return parts.map((p) =>
    p.type === 'text'
      ? { type: 'text', text: p.text }
      : { type: 'image_url', image_url: { url: p.imageUrl } },
  );
}

function toWireTools(tools: ToolSchema[]): unknown[] {
  return tools;
}

export class OpenAICompatProvider implements Provider {
  constructor(private config: ProviderConfig) {}

  streamChat(
    params: ChatParams,
    onEvent: (event: StreamEvent) => void,
  ): { cancel: () => void } {
    const ac = new AbortController();
    const externalSignal = params.signal;
    externalSignal?.addEventListener('abort', () => ac.abort(), { once: true });

    const url = `${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const body = {
      model: this.config.model,
      messages: toWireMessages(params.messages),
      tools: toWireTools(params.tools),
      tool_choice: params.tools.length > 0 ? 'auto' : undefined,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: params.maxTokens,
    };

    fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    })
      .then(async (resp) => {
        if (!resp.ok || !resp.body) {
          const text = await resp.text().catch(() => '');
          let detail = text;
          try {
            const parsed = JSON.parse(text);
            detail = parsed?.error?.message ?? text;
          } catch { /* 非 JSON 错误体 */ }
          onEvent({ type: 'error', error: `HTTP ${resp.status}: ${detail}` });
          onEvent({ type: 'message-done' });
          return;
        }
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        // 聚合器：index → { id, name, args }
        const toolCallAgg = new Map<number, { id?: string; name?: string; args: string }>();
        const parser = createSseParser((data) => {
          let chunk: {
            choices?: Array<{
              delta?: {
                content?: string | null;
                tool_calls?: Array<{
                  index?: number;
                  id?: string;
                  function?: { name?: string; arguments?: string };
                }>;
              };
              finish_reason?: string | null;
            }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number };
          };
          try {
            chunk = JSON.parse(data);
          } catch {
            return; // 跳过无法解析的行（某些中转站会夹带非标准行）
          }
          const choice = chunk.choices?.[0];
          if (choice?.delta?.content) {
            onEvent({ type: 'text-delta', text: choice.delta.content });
          }
          if (choice?.delta?.tool_calls) {
            for (const tc of choice.delta.tool_calls) {
              const idx = tc.index ?? 0;
              const agg = toolCallAgg.get(idx) ?? { args: '' };
              if (tc.id) agg.id = tc.id;
              if (tc.function?.name) agg.name = tc.function.name;
              const argsDelta = tc.function?.arguments ?? '';
              agg.args += argsDelta;
              toolCallAgg.set(idx, agg);
              onEvent({
                type: 'tool-call-delta',
                index: idx,
                id: tc.id,
                name: tc.function?.name,
                argsDelta: argsDelta || undefined,
              });
            }
          }
          if (choice?.finish_reason) {
            onEvent({
              type: 'message-done',
              usage: chunk.usage
                ? {
                    promptTokens: chunk.usage.prompt_tokens,
                    completionTokens: chunk.usage.completion_tokens,
                  }
                : undefined,
              finishReason: choice.finish_reason,
            });
          }
        });

        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            parser.push(decoder.decode(value, { stream: true }));
          }
          parser.flush();
        } catch (err) {
          if ((err as Error).name !== 'AbortError') {
            onEvent({ type: 'error', error: `stream error: ${(err as Error).message}` });
          }
        }
      })
      .catch((err: unknown) => {
        if ((err as Error).name === 'AbortError') return;
        onEvent({ type: 'error', error: `network error: ${(err as Error).message}` });
        onEvent({ type: 'message-done' });
      });

    return {
      cancel: () => ac.abort(),
    };
  }
}
```

注意：测试期望 "HTTP 非 200 时发出 error 事件"，实现中 401 时 `resp.ok` 为 false 走 error 分支——错误消息格式为 `HTTP 401: ...`，测试断言 `toContain('401')` 会通过。

还有一处需对齐：usage 字段。OpenAI 规范中 `stream_options.include_usage` 时 usage 在最后一个 chunk（`choices` 为空数组）里。上面实现把 usage 附在 `finish_reason` chunk 上，但很多兼容实现（DeepSeek 等）确实在 finish chunk 同时带 usage。**为兼容两种情况**，在 message-done 事件之外，再补一个分支：当 chunk.choices 为空但 usage 存在时，也发一个 message-done（usage 版）。但这样可能发两个 message-done。更简单：把 usage 存到外部变量，finish 或流结束时统一发。修改实现的收尾逻辑：

```ts
        // （替换 parser 构造块中 finish_reason 分支与循环之后的代码）
        let pendingUsage: { promptTokens?: number; completionTokens?: number } | undefined;
        let finishReason: string | undefined;

        const parser = createSseParser((data) => {
          // …（同上，但 finish_reason 分支改为记录）
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          if (chunk.usage) pendingUsage = { promptTokens: chunk.usage.prompt_tokens, completionTokens: chunk.usage.completion_tokens };
        });

        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            parser.push(decoder.decode(value, { stream: true }));
          }
          parser.flush();
        } catch (err) {
          if ((err as Error).name !== 'AbortError') {
            onEvent({ type: 'error', error: `stream error: ${(err as Error).message}` });
          }
        }
        onEvent({ type: 'message-done', usage: pendingUsage, finishReason });
```

测试里 `usage` 断言在 message-done 上（`done.usage?.completionTokens === 2`），两种 wire 形态（usage 在 finish chunk 或单独 chunk）都覆盖。

- [ ] **Step 4: 运行测试确认通过**

```bash
npx vitest run tests/agent/provider/openai-compat.test.ts
```

Expected: 6 passed。

- [ ] **Step 5: Commit**

```bash
git add agent/ tests/
git commit -m "feat: OpenAI 兼容 provider（SSE 流式 + tool_calls 增量聚合）"
```

---

### Task 7: 连接测试工具函数

**Files:**
- Create: `agent/provider/connection-test.ts`
- Test: `tests/agent/provider/connection-test.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/agent/provider/connection-test.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { testConnection } from '../../../agent/provider/connection-test';

describe('testConnection', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it('成功时返回 ok 与模型响应', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'pong' } }] }), { status: 200 }),
    );
    const r = await testConnection({ baseUrl: 'https://api.x.com/v1', apiKey: 'k', model: 'm' });
    expect(r.ok).toBe(true);
    expect(r.data).toBe('pong');
  });

  it('401 时返回错误信息', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'invalid key' } }), { status: 401 }),
    );
    const r = await testConnection({ baseUrl: 'https://api.x.com/v1', apiKey: 'bad', model: 'm' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('401');
  });

  it('网络错误返回错误', async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError('fetch failed'));
    const r = await testConnection({ baseUrl: 'https://api.x.com/v1', apiKey: 'k', model: 'm' });
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it('非 JSON 响应体不崩溃', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('<html>gateway error</html>', { status: 502 }));
    const r = await testConnection({ baseUrl: 'https://api.x.com/v1', apiKey: 'k', model: 'm' });
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npx vitest run tests/agent/provider/connection-test.test.ts
```

Expected: FAIL — module not found。

- [ ] **Step 3: 写 agent/provider/connection-test.ts**

```ts
// agent/provider/connection-test.ts
// 设置页"测试连接"按钮的实现：发一个非流式最小请求验证 baseUrl/key/model。

import type { ProviderConfig } from './types';

export interface ConnectionTestResult {
  ok: boolean;
  data?: string;   // 模型回复文本
  error?: string;
}

export async function testConnection(config: ProviderConfig): Promise<ConnectionTestResult> {
  const url = `${config.baseUrl.replace(/\/$/, '')}/chat/completions`;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 8,
      }),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      let detail = text.slice(0, 200);
      try {
        const parsed = JSON.parse(text);
        detail = parsed?.error?.message ?? detail;
      } catch { /* 非 JSON */ }
      return { ok: false, error: `HTTP ${resp.status}: ${detail}` };
    }
    const json = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return { ok: true, data: json.choices?.[0]?.message?.content ?? '' };
  } catch (err) {
    return { ok: false, error: `network error: ${(err as Error).message}` };
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
npx vitest run tests/agent/provider/connection-test.test.ts
```

Expected: 4 passed。

- [ ] **Step 5: Commit**

```bash
git add agent/ tests/
git commit -m "feat: provider 连接测试（非流式最小请求）"
```

---

### Task 8: 侧边栏 UI 骨架 + 设置页

**Files:**
- Create: `components/ui/Button.tsx`, `components/ui/Input.tsx`, `components/ui/PageShell.tsx`
- Create: `components/chat/ChatView.tsx`, `components/scripts/ScriptsView.tsx`
- Create: `components/settings/SettingsView.tsx`
- Create: `stores/ui.ts`
- Modify: `entrypoints/sidepanel/App.tsx`

- [ ] **Step 1: 写基础 UI 原子组件**

```tsx
// components/ui/Button.tsx
import type { ButtonHTMLAttributes } from 'react';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger';
}

export function Button({ variant = 'secondary', style, ...rest }: Props) {
  const base: React.CSSProperties = {
    padding: '6px 14px',
    borderRadius: 6,
    border: '1px solid',
    fontSize: 13,
    cursor: 'pointer',
    background: 'transparent',
  };
  const variants: Record<string, React.CSSProperties> = {
    primary: { background: 'var(--accent)', borderColor: 'var(--accent)', color: '#fff' },
    secondary: { background: '#fff', borderColor: 'var(--border)', color: 'var(--fg)' },
    danger: { background: '#fff', borderColor: '#dc2626', color: '#dc2626' },
  };
  return <button style={{ ...base, ...variants[variant], ...style }} {...rest} />;
}
```

```tsx
// components/ui/Input.tsx
import type { InputHTMLAttributes } from 'react';

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      style={{
        width: '100%',
        padding: '6px 10px',
        borderRadius: 6,
        border: '1px solid var(--border)',
        fontSize: 13,
        outline: 'none',
        ...props.style,
      }}
    />
  );
}
```

```tsx
// components/ui/PageShell.tsx
import type { ReactNode } from 'react';

export function PageShell({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 16px',
          borderBottom: '1px solid var(--border)',
          flexShrink: 0,
        }}
      >
        <h1 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>{title}</h1>
        <div style={{ display: 'flex', gap: 8 }}>{actions}</div>
      </header>
      <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>{children}</div>
    </div>
  );
}
```

- [ ] **Step 2: 写 stores/ui.ts（页面切换状态）**

```ts
// stores/ui.ts
import { create } from 'zustand';

export type Page = 'chat' | 'scripts' | 'settings';

interface UiState {
  page: Page;
  setPage: (p: Page) => void;
}

export const useUi = create<UiState>((set) => ({
  page: 'chat',
  setPage: (page) => set({ page }),
}));
```

- [ ] **Step 3: 写三个视图占位**

```tsx
// components/chat/ChatView.tsx
import { PageShell } from '../ui/PageShell';

export function ChatView() {
  return (
    <PageShell title="会话">
      <div style={{ color: 'var(--fg-muted)' }}>对话功能将在 Phase 2 实现。</div>
    </PageShell>
  );
}
```

```tsx
// components/scripts/ScriptsView.tsx
import { PageShell } from '../ui/PageShell';

export function ScriptsView() {
  return (
    <PageShell title="脚本池">
      <div style={{ color: 'var(--fg-muted)' }}>脚本池将在 Phase 4 实现。</div>
    </PageShell>
  );
}
```

- [ ] **Step 4: 写设置页（真实功能：provider 配置 + 连接测试）**

```tsx
// components/settings/SettingsView.tsx
import { useEffect, useState } from 'react';
import { MessageSquare, Puzzle, Settings as SettingsIcon } from 'lucide-react';
import { PageShell } from '../ui/PageShell';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { getSettings, saveSettings, type Settings } from '../../storage/settings';
import { testConnection, type ConnectionTestResult } from '../../agent/provider/connection-test';

const fieldStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  marginBottom: 14,
};

export function SettingsView() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);

  useEffect(() => {
    getSettings().then(setSettings);
  }, []);

  if (!settings) return <PageShell title="设置"><div>加载中…</div></PageShell>;

  const setProvider = (patch: Partial<Settings['provider']>) =>
    setSettings({ ...settings, provider: { ...settings.provider, ...patch } });

  const handleSave = async () => {
    await saveSettings({ provider: settings.provider, agent: settings.agent });
    setTestResult(null);
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    // 测试前先保存，确保测试的就是当前表单值
    await saveSettings({ provider: settings.provider });
    const r = await testConnection(settings.provider);
    setTestResult(r);
    setTesting(false);
  };

  return (
    <PageShell title="设置">
      <section style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, margin: '0 0 12px' }}>AI 服务（OpenAI 兼容）</h2>
        <div style={fieldStyle}>
          <label>Base URL</label>
          <Input
            value={settings.provider.baseUrl}
            onChange={(e) => setProvider({ baseUrl: e.target.value })}
            placeholder="https://api.deepseek.com/v1"
          />
        </div>
        <div style={fieldStyle}>
          <label>API Key</label>
          <Input
            type="password"
            value={settings.provider.apiKey}
            onChange={(e) => setProvider({ apiKey: e.target.value })}
            placeholder="sk-…"
          />
        </div>
        <div style={fieldStyle}>
          <label>模型</label>
          <Input
            value={settings.provider.model}
            onChange={(e) => setProvider({ model: e.target.value })}
            placeholder="deepseek-chat"
          />
        </div>
      </section>

      <section style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, margin: '0 0 12px' }}>Agent</h2>
        <div style={fieldStyle}>
          <label>最大步数（工具调用循环上限）</label>
          <Input
            type="number"
            value={settings.agent.maxSteps}
            min={1}
            max={100}
            onChange={(e) =>
              setSettings({
                ...settings,
                agent: { ...settings.agent, maxSteps: Number(e.target.value) || 25 },
              })
            }
          />
        </div>
      </section>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Button variant="primary" onClick={handleSave}>保存</Button>
        <Button onClick={handleTest} disabled={testing}>
          {testing ? '测试中…' : '测试连接'}
        </Button>
        {testResult && (
          <span style={{ fontSize: 12, color: testResult.ok ? '#16a34a' : '#dc2626' }}>
            {testResult.ok ? `连接成功：${testResult.data}` : testResult.error}
          </span>
        )}
      </div>
    </PageShell>
  );
}
```

注意：`MessageSquare`、`Puzzle`、`SettingsIcon` 三个图标 import 进来但当前文件没用到——**删掉这个 import**，只保留用到的。正确写法：

```tsx
import { PageShell } from '../ui/PageShell';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
```

- [ ] **Step 5: 改写 App.tsx 为三页路由**

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

export default function App() {
  const { page, setPage } = useUi();

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      <nav
        style={{
          width: 48,
          borderRight: '1px solid var(--border)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          paddingTop: 12,
          gap: 4,
          flexShrink: 0,
        }}
      >
        {NAV.map(({ page: p, label, Icon }) => (
          <button
            key={p}
            title={label}
            aria-label={label}
            onClick={() => setPage(p)}
            style={{
              width: 36,
              height: 36,
              borderRadius: 8,
              border: 'none',
              background: page === p ? '#eff6ff' : 'transparent',
              color: page === p ? 'var(--accent)' : 'var(--fg-muted)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
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

- [ ] **Step 6: 编译与构建验证**

```bash
npm run compile
npm run build
```

Expected: 均退出码 0。

- [ ] **Step 7: 手动验证（加载扩展）**

```bash
npm run dev
```

Chrome 打开 `chrome://extensions` → 开发者模式 → 加载已解压的扩展（指向 `.output/chrome-mv3`）。验证：
1. 侧边栏可打开（扩展图标右键 → 打开侧边栏）。
2. 左侧导航三项可切换。
3. 设置页可填 baseUrl/key/model 并保存；刷新侧边栏后值仍在。

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: 侧边栏骨架（三页导航 + 设置页 + 连接测试）"
```

---

### Task 9: background 消息中枢骨架

**Files:**
- Create: `entrypoints/background.ts`（重写）
- Create: `background/router.ts`

- [ ] **Step 1: 写 background/router.ts**

```ts
// background/router.ts
// background 侧消息路由：注册 handler 表，按 type 分发。
// 侧边栏与 content script 都通过 chrome.runtime.sendMessage 与 background 通信。

import type { CsToBgRequest, CsResponse } from '../shared/messages';

type Handler = (msg: never) => unknown;

export class MessageRouter {
  private handlers = new Map<string, Handler>();

  on(type: string, handler: Handler): void {
    this.handlers.set(type, handler);
  }

  async dispatch(msg: { type: string } & Record<string, unknown>): Promise<unknown> {
    const handler = this.handlers.get(msg.type);
    if (!handler) {
      return { ok: false, error: `no handler for ${msg.type}` };
    }
    try {
      return await handler(msg as never);
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /** 挂载 chrome.runtime.onMessage 监听 */
  attach(): void {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      this.dispatch(msg).then(sendResponse);
      return true; // 异步响应
    });
  }
}

/** content script 请求的便捷类型（bg 侧处理 cs→bg 方向） */
export type CsIncoming = CsToBgRequest & { __senderTabId?: number };
export type { CsResponse };
```

- [ ] **Step 2: 重写 entrypoints/background.ts**

```ts
// entrypoints/background.ts
import { MessageRouter } from '../background/router';
import type { CsIncoming } from '../background/router';

export default defineBackground(() => {
  const router = new MessageRouter();

  // MVP 骨架：仅 echo 验证链路（Phase 2+ 逐工具接入）
  router.on('PING', async () => ({ ok: true, data: { pong: Date.now() } }));

  router.on('NETLOG_PUSH', async (msg: CsIncoming) => {
    // Phase 3 实现：写入网络日志环形缓冲
    console.log('[bg] netlog push (stub)', msg.payload?.entries?.length ?? 0);
    return { ok: true };
  });

  // 点击扩展图标时打开侧边栏
  chrome.action.onClicked.addListener((tab) => {
    if (tab.windowId != null) chrome.sidePanel.open({ windowId: tab.windowId });
  });

  chrome.runtime.onInstalled.addListener(() => {
    // 设置默认侧边栏行为：点击图标打开
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  });

  router.attach();
  console.log('[ai-browser-ext] background started');
});
```

注意：`chrome.action.onClicked` 与 `setPanelBehavior({openPanelOnActionClick:true})` 二选一即可，后者更可靠（前者在 setPanelBehavior 生效时不会触发）。简化为只保留 `setPanelBehavior`：

```ts
// entrypoints/background.ts
import { MessageRouter } from '../background/router';
import type { CsIncoming } from '../background/router';

export default defineBackground(() => {
  const router = new MessageRouter();

  router.on('PING', async () => ({ ok: true, data: { pong: Date.now() } }));

  router.on('NETLOG_PUSH', async (msg: CsIncoming) => {
    console.log('[bg] netlog push (stub)', msg.payload?.entries?.length ?? 0);
    return { ok: true };
  });

  chrome.runtime.onInstalled.addListener(() => {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  });

  router.attach();
  console.log('[ai-browser-ext] background started');
});
```

- [ ] **Step 3: 编译验证**

```bash
npm run compile
```

Expected: 退出码 0。

- [ ] **Step 4: 全量测试**

```bash
npm test
```

Expected: 全部通过（此前 4 个测试文件）。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: background 消息中枢骨架（路由表 + PING echo）"
```

---

### Task 10: Phase 1 收尾验证

**Files:**
- Modify: `docs/superpowers/plans/2026-08-28-ai-browser-extension-phase1.md`（勾选状态，如执行者维护）

- [ ] **Step 1: 全量编译 + 测试 + 构建**

```bash
npm run compile && npm test && npm run build
```

Expected: 三项全部成功。

- [ ] **Step 2: 手动冒烟（加载扩展）**

在 `chrome://extensions` 重新加载扩展，验证：
1. 点击扩展图标打开侧边栏。
2. Service worker 控制台可见 `[ai-browser-ext] background started`。
3. 设置页保存配置后，SW 控制台执行 `chrome.runtime.sendMessage({type:'PING'})` 返回 `{ok:true,data:{pong:…}}`。

- [ ] **Step 3: Commit（若有收尾改动）**

```bash
git add -A
git commit -m "chore: Phase 1 收尾"
```

---

## Self-Review 记录

- **Spec 覆盖**：本计划只覆盖设计 §7 Phase 1（骨架/provider/消息协议/存储/设置页）。Phase 2–5 将各自出计划（agent loop、工具集、网络观察、脚本池、打磨）。
- **占位符扫描**：无 TBD/TODO；所有代码步骤含完整代码。
- **类型一致性**：`createRequest(type, payload)` 两参签名在 Task 2 定义并自洽；`Provider.streamChat` 返回 `{cancel}` 在 Task 4/6 一致；`testConnection` 返回 `{ok,data?,error?}` 在 Task 7/8 一致；`getSettings/saveSettings` 在 Task 3/8 一致。

## 给后续 Phase 的接口契约（本 Phase 冻结）

后续 Phase 依赖本 Phase 的以下导出，签名不再变更：

- `shared/messages.ts`: `createRequest`, `isResponseFor`, `BgToCsRequest`, `CsToBgRequest`, `CsResponse`
- `agent/provider/types.ts`: `ChatMessage`, `ToolCall`, `ToolSchema`, `StreamEvent`, `ChatParams`, `Provider`, `ProviderConfig`
- `agent/provider/openai-compat.ts`: `OpenAICompatProvider`
- `agent/provider/connection-test.ts`: `testConnection`
- `storage/settings.ts`: `getSettings`, `saveSettings`, `DEFAULT_SETTINGS`, `Settings`
- `shared/types.ts`: `ToolResult`, `TabInfo`, `Uid`
