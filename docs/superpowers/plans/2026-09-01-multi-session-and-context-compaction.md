# 多会话管理 + 输入框重构 + 上下文压缩 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把会话从「按标签页绑定」升级为独立持久化实体（列表管理、默认新会话、上下文隔离），重构输入框为环形上下文指示器兼压缩按钮，并接入 LLM 智能摘要压缩。

**Architecture:** 会话以 `convId` 为存储主键（`local:conv:{id}` + `local:conv-index`），标签页只做 agent 运行时操作目标。loop 消费 provider 返回的 `usage.promptTokens` 做上下文计量，达 80% 阈值自动摘要、也可手动点环触发。摘要把旧消息折叠成前情文本塞进上下文顶部，原始消息完整保留供 UI 回看。

**Tech Stack:** WXT + React 19 + TypeScript + Zustand + lucide-react + vitest v4/jsdom。nanoid（已在依赖）。

**参考设计文档：** `docs/superpowers/specs/2026-09-01-multi-session-and-context-compaction-design.md`

---

## 文件结构

**新增：**
- `agent/model-windows.ts` — 模型名→上下文窗口映射表 + 取值优先级（settings 覆盖 > 映射 > 默认 128k）
- `agent/context-meter.ts` — token 占比档位纯函数 + 压缩阈值常量
- `storage/conversations.ts` — 会话 CRUD + conv-index 维护（替代 sessions.ts）
- `agent/compact.ts` — 摘要流程（切段、增量摘要、token 估算、失败不改会话）
- `stores/conversations.ts` — 会话列表状态 + 当前会话切换
- `components/chat/ContextRing.tsx` — 环形上下文指示器（= 压缩按钮）
- `components/chat/ConversationMenu.tsx` — 顶部下拉抽屉（列表/新建/重命名/删除）

**改造：**
- `shared/messages.ts` — 协议：agent:start 带 convId、agent:stop/compact 带 convId、新增 usage/compact-start/compact-done 事件
- `storage/settings.ts` — ProviderConfig 加 contextWindow 字段
- `agent/loop.ts` — sessionId→convId、usage 消费、自动压缩钩子
- `agent/context.ts` — buildContext 的 summary 组装分支
- `background/agent-port.ts` — runningConvs、agent:compact 处理、makeDeps 注入 compact/getContextWindow
- `entrypoints/background.ts` — 旧 session key 清理迁移
- `stores/chat.ts` — ChatItem.usage、applyEvent 的 usage/compact 分支、compacting/promptTokens 状态
- `components/chat/ChatView.tsx` — 默认新会话、页眉入口、输入框重构、每轮 token
- `components/settings/SettingsView.tsx` — 上下文窗口输入框
- `entrypoints/sidepanel/styles.css` — 下拉抽屉、环形指示器、token 标注样式

**弃用：**
- `storage/sessions.ts`、`tests/storage/sessions.test.ts`

---

## Task 1: 模型窗口映射表（`agent/model-windows.ts`）

纯函数模块：给定 model 名 + 可选用户覆盖值，返回上下文窗口 token 数。

**Files:**
- Create: `agent/model-windows.ts`
- Test: `tests/agent/model-windows.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/agent/model-windows.test.ts
import { describe, it, expect } from 'vitest';
import { resolveContextWindow, DEFAULT_CONTEXT_WINDOW } from '../../agent/model-windows';

describe('resolveContextWindow', () => {
  it('用户覆盖值优先级最高', () => {
    expect(resolveContextWindow('gpt-4o', 200000)).toBe(200000);
  });
  it('覆盖值为 0 或负数视为未设置，回落映射', () => {
    expect(resolveContextWindow('gpt-4o', 0)).toBe(128000);
    expect(resolveContextWindow('gpt-4o', -5)).toBe(128000);
  });
  it('按 model 名子串匹配映射（大小写不敏感）', () => {
    expect(resolveContextWindow('gpt-4o-2024-08-06')).toBe(128000);
    expect(resolveContextWindow('DeepSeek-Chat')).toBe(64000);
    expect(resolveContextWindow('claude-3-5-sonnet')).toBe(200000);
  });
  it('匹配不到给默认值', () => {
    expect(resolveContextWindow('some-proxy-model-x')).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(DEFAULT_CONTEXT_WINDOW).toBe(128000);
  });
  it('空 model 名给默认值', () => {
    expect(resolveContextWindow('')).toBe(128000);
    expect(resolveContextWindow(undefined)).toBe(128000);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test -- model-windows`
Expected: FAIL（`resolveContextWindow` 未定义）

- [ ] **Step 3: 实现**

```ts
// agent/model-windows.ts
// 模型名 → 上下文窗口（token）映射 + 取值优先级（设计 §4.5 / D3）。
// 优先级：用户在设置页覆盖值 > 映射表子串匹配 > 默认 128k。

export const DEFAULT_CONTEXT_WINDOW = 128_000;

/** 子串匹配表（大小写不敏感）：命中第一个即返回。顺序上把更具体的放前面。 */
const WINDOW_TABLE: Array<[pattern: string, window: number]> = [
  ['gpt-4o', 128_000],
  ['gpt-4.1', 1_000_000],
  ['gpt-4-turbo', 128_000],
  ['gpt-4', 8_192],
  ['gpt-3.5', 16_385],
  ['o1', 128_000],
  ['o3', 200_000],
  ['deepseek', 64_000],
  ['claude', 200_000],
  ['qwen', 32_768],
  ['gemini', 1_000_000],
  ['llama', 128_000],
  ['moonshot', 128_000],
  ['kimi', 128_000],
];

/** 解析上下文窗口。override 为正数时优先；否则按 model 子串匹配；再否则默认。 */
export function resolveContextWindow(model: string | undefined, override?: number): number {
  if (typeof override === 'number' && override > 0) return override;
  const name = (model ?? '').toLowerCase();
  if (name) {
    for (const [pattern, window] of WINDOW_TABLE) {
      if (name.includes(pattern)) return window;
    }
  }
  return DEFAULT_CONTEXT_WINDOW;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run test -- model-windows`
Expected: PASS（5 个用例）

- [ ] **Step 5: Commit**

```bash
git add agent/model-windows.ts tests/agent/model-windows.test.ts
git commit -m "feat: 模型上下文窗口映射表 + 取值优先级（settings 覆盖 > 映射 > 默认 128k）"
```

---

## Task 2: 上下文占比档位（`agent/context-meter.ts`）

纯函数：给定已用 token + 窗口，返回占比与颜色档位（供环形指示器 + loop 自动压缩共用阈值）。

**Files:**
- Create: `agent/context-meter.ts`
- Test: `tests/agent/context-meter.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/agent/context-meter.test.ts
import { describe, it, expect } from 'vitest';
import { meterRatio, meterZone, COMPACT_THRESHOLD } from '../../agent/context-meter';

describe('context meter', () => {
  it('占比 = used / window，裁剪到 [0,1]', () => {
    expect(meterRatio(64000, 128000)).toBeCloseTo(0.5);
    expect(meterRatio(200000, 128000)).toBe(1);
    expect(meterRatio(0, 128000)).toBe(0);
  });
  it('window 非法（<=0）时占比 0', () => {
    expect(meterRatio(100, 0)).toBe(0);
  });
  it('used 未知（undefined）时占比 0', () => {
    expect(meterRatio(undefined, 128000)).toBe(0);
  });
  it('档位分界：<80% normal / >=80% warn / >=95% danger', () => {
    expect(meterZone(0.5)).toBe('normal');
    expect(meterZone(0.79)).toBe('normal');
    expect(meterZone(0.8)).toBe('warn');
    expect(meterZone(0.94)).toBe('warn');
    expect(meterZone(0.95)).toBe('danger');
    expect(meterZone(1)).toBe('danger');
  });
  it('压缩阈值 = 0.8', () => {
    expect(COMPACT_THRESHOLD).toBe(0.8);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test -- context-meter`
Expected: FAIL（未定义）

- [ ] **Step 3: 实现**

```ts
// agent/context-meter.ts
// 上下文占比与颜色档位（设计 §3.2 / §4.2）。环形指示器与 loop 自动压缩共用阈值。

/** 自动压缩触发阈值：占比达到此值时 loop 在下一轮前触发一次摘要。 */
export const COMPACT_THRESHOLD = 0.8;

export type MeterZone = 'normal' | 'warn' | 'danger';

/** 已用 token 占窗口比例，裁剪到 [0,1]。used 未知或 window 非法时返回 0。 */
export function meterRatio(used: number | undefined, window: number): number {
  if (used == null || window <= 0) return 0;
  const r = used / window;
  if (r < 0) return 0;
  if (r > 1) return 1;
  return r;
}

/** 占比 → 颜色档位：<80% normal / [80%,95%) warn / >=95% danger。 */
export function meterZone(ratio: number): MeterZone {
  if (ratio >= 0.95) return 'danger';
  if (ratio >= COMPACT_THRESHOLD) return 'warn';
  return 'normal';
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run test -- context-meter`
Expected: PASS（5 个用例）

- [ ] **Step 5: Commit**

```bash
git add agent/context-meter.ts tests/agent/context-meter.test.ts
git commit -m "feat: 上下文占比档位纯函数 + 压缩阈值常量（80%/95% 分档）"
```

---

## Task 3: 会话存储层（`storage/conversations.ts`）

会话以 `convId` 为主键，另存一份轻量列表元数据 `conv-index`。CRUD + 首条用户消息自动生成标题。

**Files:**
- Create: `storage/conversations.ts`
- Test: `tests/storage/conversations.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/storage/conversations.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  createConversation, getConversation, saveConversation, appendMessage,
  setStatus, renameConversation, deleteConversation, listConversations,
} from '../../storage/conversations';

describe('conversations storage', () => {
  beforeEach(() => fakeBrowser.reset());

  it('createConversation 生成带 id 的空会话并进 index', async () => {
    const c = await createConversation();
    expect(c.id).toBeTruthy();
    expect(c.messages).toEqual([]);
    expect(c.status).toBe('idle');
    expect(c.title).toBe('新会话');
    const index = await listConversations();
    expect(index.map((m) => m.id)).toContain(c.id);
  });

  it('getConversation 未知 id 返回空 idle（不写 index）', async () => {
    const c = await getConversation('nope');
    expect(c.messages).toEqual([]);
    expect(c.status).toBe('idle');
    expect(await listConversations()).toEqual([]);
  });

  it('首条 user 消息生成标题（前 30 字）并同步 index', async () => {
    const c = await createConversation();
    await appendMessage(c.id, { role: 'user', content: '帮我点掉这个页面上恼人的 cookie 同意弹窗谢谢你了' });
    const got = await getConversation(c.id);
    expect(got.title).toBe('帮我点掉这个页面上恼人的 cookie 同意弹窗谢谢你了'.slice(0, 30));
    const index = await listConversations();
    expect(index.find((m) => m.id === c.id)!.title).toBe(got.title);
  });

  it('已重命名的标题不被后续 user 消息覆盖', async () => {
    const c = await createConversation();
    await renameConversation(c.id, '我的任务');
    await appendMessage(c.id, { role: 'user', content: '别覆盖我' });
    expect((await getConversation(c.id)).title).toBe('我的任务');
  });

  it('appendMessage 超 200 条保留最近 200', async () => {
    const c = await createConversation();
    for (let i = 0; i < 205; i++) await appendMessage(c.id, { role: 'user', content: String(i) });
    const got = await getConversation(c.id);
    expect(got.messages).toHaveLength(200);
    expect(got.messages[0]!.content).toBe('5');
  });

  it('setStatus 只改状态并同步 index', async () => {
    const c = await createConversation();
    await setStatus(c.id, 'running');
    expect((await getConversation(c.id)).status).toBe('running');
    expect((await listConversations()).find((m) => m.id === c.id)!.status).toBe('running');
  });

  it('deleteConversation 移除会话与 index 项', async () => {
    const c = await createConversation();
    await deleteConversation(c.id);
    expect(await listConversations()).toEqual([]);
    expect((await getConversation(c.id)).messages).toEqual([]);
  });

  it('index 按 updatedAt 倒序（最近的在前）', async () => {
    const a = await createConversation();
    await new Promise((r) => setTimeout(r, 2));
    const b = await createConversation();
    await new Promise((r) => setTimeout(r, 2));
    await appendMessage(a.id, { role: 'user', content: 'x' }); // a 更新，应排到最前
    const index = await listConversations();
    expect(index[0]!.id).toBe(a.id);
    expect(index[1]!.id).toBe(b.id);
  });

  it('会话之间上下文隔离', async () => {
    const a = await createConversation();
    const b = await createConversation();
    await appendMessage(a.id, { role: 'user', content: 'A的话' });
    await appendMessage(b.id, { role: 'user', content: 'B的话' });
    expect((await getConversation(a.id)).messages[0]!.content).toBe('A的话');
    expect((await getConversation(b.id)).messages[0]!.content).toBe('B的话');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test -- conversations`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现（第一段：类型 + 基础读写 + index）**

```ts
// storage/conversations.ts
// 会话独立实体存储（设计 §1）。key = local:conv:{id}，另存 local:conv-index 供列表 UI。
import { storage } from 'wxt/utils/storage';
import { nanoid } from 'nanoid';
import type { ChatMessage } from '../agent/provider/types';

export type ConversationStatus = 'idle' | 'running' | 'paused';

export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  status: ConversationStatus;
  createdAt: number;
  updatedAt: number;
  lastPromptTokens?: number;
  summary?: { text: string; coversUpTo: number };
}

export interface ConversationMeta {
  id: string;
  title: string;
  updatedAt: number;
  status: ConversationStatus;
}

const MAX_MESSAGES = 200;
const DEFAULT_TITLE = '新会话';
const key = (id: string) => `local:conv:${id}` as const;
const INDEX_KEY = 'local:conv-index';

async function readIndex(): Promise<ConversationMeta[]> {
  return (await storage.getItem<ConversationMeta[]>(INDEX_KEY)) ?? [];
}

async function writeIndex(index: ConversationMeta[]): Promise<void> {
  await storage.setItem(INDEX_KEY, index);
}

/** 把某会话的元数据写进 index（存在则更新），并按 updatedAt 倒序。 */
async function upsertIndex(conv: Conversation): Promise<void> {
  const index = await readIndex();
  const meta: ConversationMeta = { id: conv.id, title: conv.title, updatedAt: conv.updatedAt, status: conv.status };
  const rest = index.filter((m) => m.id !== conv.id);
  const next = [meta, ...rest].sort((a, b) => b.updatedAt - a.updatedAt);
  await writeIndex(next);
}

export async function listConversations(): Promise<ConversationMeta[]> {
  return readIndex();
}

export async function getConversation(id: string): Promise<Conversation> {
  const raw = await storage.getItem<Conversation>(key(id));
  if (raw) return raw;
  const now = 0;
  return { id, title: DEFAULT_TITLE, messages: [], status: 'idle', createdAt: now, updatedAt: now };
}

export async function saveConversation(conv: Conversation): Promise<void> {
  const next = { ...conv, updatedAt: Date.now() };
  await storage.setItem(key(conv.id), next);
  await upsertIndex(next);
}
```

- [ ] **Step 4: 实现（第二段：create / append / status / rename / delete）**

追加到 `storage/conversations.ts` 末尾：

```ts
export async function createConversation(): Promise<Conversation> {
  const now = Date.now();
  const conv: Conversation = { id: nanoid(), title: DEFAULT_TITLE, messages: [], status: 'idle', createdAt: now, updatedAt: now };
  await saveConversation(conv);
  return conv;
}

/** 追加消息（超 200 条裁剪最近）。若标题仍为默认值且这是首条 user 文本消息，用其前 30 字作标题。 */
export async function appendMessage(id: string, msg: ChatMessage): Promise<void> {
  const conv = await getConversation(id);
  const messages = [...conv.messages, msg];
  const trimmed = messages.length > MAX_MESSAGES ? messages.slice(messages.length - MAX_MESSAGES) : messages;
  let title = conv.title;
  if (title === DEFAULT_TITLE && msg.role === 'user' && typeof msg.content === 'string' && msg.content.trim()) {
    title = msg.content.trim().slice(0, 30);
  }
  await saveConversation({ ...conv, messages: trimmed, title });
}

export async function setStatus(id: string, status: ConversationStatus): Promise<void> {
  const conv = await getConversation(id);
  await saveConversation({ ...conv, status });
}

export async function renameConversation(id: string, title: string): Promise<void> {
  const conv = await getConversation(id);
  await saveConversation({ ...conv, title: title.trim() || DEFAULT_TITLE });
}

export async function deleteConversation(id: string): Promise<void> {
  await storage.removeItem(key(id));
  const index = await readIndex();
  await writeIndex(index.filter((m) => m.id !== id));
}

/** 设置最近一轮真实 prompt token（供上下文计量），同时不动消息。 */
export async function setLastPromptTokens(id: string, tokens: number): Promise<void> {
  const conv = await getConversation(id);
  await saveConversation({ ...conv, lastPromptTokens: tokens });
}

/** 写回摘要（原始 messages 不动）。 */
export async function setSummary(id: string, summary: { text: string; coversUpTo: number }): Promise<void> {
  const conv = await getConversation(id);
  await saveConversation({ ...conv, summary });
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npm run test -- conversations`
Expected: PASS（9 个用例）

- [ ] **Step 6: Commit**

```bash
git add storage/conversations.ts tests/storage/conversations.test.ts
git commit -m "feat: 会话独立实体存储（conv CRUD + conv-index + 首条消息自动标题）"
```

---

## Task 4: 消息协议扩展（`shared/messages.ts`）

Port 协议：面板→后台的 start 带 convId、新增 compact；后台→面板新增 usage / compact-start / compact-done。纯类型改动，靠 `npm run compile` 验证。

**Files:**
- Modify: `shared/messages.ts:89-103`

- [ ] **Step 1: 改 `PortMsgFromPanel`（agent:start 加 convId；stop/resume/attach 加 convId；新增 agent:compact）**

把 [shared/messages.ts:89-93](shared/messages.ts#L89-L93) 的 `PortMsgFromPanel` 整段替换为：

```ts
export type PortMsgFromPanel =
  | { type: 'agent:start'; convId: string; tabId: number; userMessage: string }
  | { type: 'agent:stop'; convId: string }
  | { type: 'agent:attach'; convId: string }
  | { type: 'agent:resume'; convId: string; tabId: number }
  | { type: 'agent:compact'; convId: string };
```

- [ ] **Step 2: 改 `PortMsgToPanel`（新增 usage / compact-start / compact-done）**

把 [shared/messages.ts:95-103](shared/messages.ts#L95-L103) 的 `PortMsgToPanel` 整段替换为：

```ts
export type PortMsgToPanel =
  | { type: 'reasoning-delta'; text: string }
  | { type: 'text-delta'; text: string }
  | { type: 'tool-start'; name: string; args: string; callId: string }
  | { type: 'tool-end'; name: string; callId: string; ok: boolean; summary: string; output?: string; image?: string }
  | { type: 'usage'; promptTokens?: number; completionTokens?: number }
  | { type: 'compact-start' }
  | { type: 'compact-done'; newPromptTokens?: number }
  | { type: 'paused'; reason: string }
  | { type: 'done'; finalText: string }
  | { type: 'error'; message: string }
  | { type: 'state'; status: 'idle' | 'running' | 'paused'; messageCount: number };
```

- [ ] **Step 3: 编译确认（会暴露 loop/agent-port/chat store 的旧签名，属预期，后续任务修复）**

Run: `npm run compile`
Expected: 报错集中在 `agent/loop.ts`、`background/agent-port.ts`、`components/chat/ChatView.tsx`、`stores/chat.ts`——这些是后续任务要改的调用点。**本步不 commit**，与 Task 5 合并提交前先让协议就位。

- [ ] **Step 4: Commit（仅协议文件，容许下游暂时飘红）**

```bash
git add shared/messages.ts
git commit -m "feat: Port 协议扩展（start/stop/compact 带 convId + usage/compact 事件）"
```

---

## Task 5: 设置页上下文窗口字段（`storage/settings.ts` + `SettingsView.tsx`）

ProviderConfig 加可选 `contextWindow`；设置页加输入框（占位显示按 model 匹配到的值）。

**Files:**
- Modify: `storage/settings.ts:4-11`
- Modify: `components/settings/SettingsView.tsx:104-110`
- Test: 复用编译 + 手测（settings 无独立单测文件）

- [ ] **Step 1: `ProviderConfig` 加 contextWindow**

在 [storage/settings.ts:4-11](storage/settings.ts#L4-L11) 的 `ProviderConfig` 接口里，`model: string;` 之后加一行：

```ts
  /** 上下文窗口（token）。留空则按 model 名映射；见 agent/model-windows.ts。 */
  contextWindow?: number;
```

- [ ] **Step 2: 设置页加输入框**

在 [components/settings/SettingsView.tsx:110](components/settings/SettingsView.tsx#L110) 的「模型」`<div className="field">…</div>` 之后、「额外请求参数」field 之前，插入：

```tsx
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
```

- [ ] **Step 3: 顶部 import resolveContextWindow**

在 [components/settings/SettingsView.tsx:7](components/settings/SettingsView.tsx#L7) 的 import 区加：

```ts
import { resolveContextWindow } from '../../agent/model-windows';
```

同时确认 `resolveProvider()`（[SettingsView.tsx:51-60](components/settings/SettingsView.tsx#L51-L60)）返回的 `{ ...settings.provider, extraBody }` 会自动带上 contextWindow（因 spread settings.provider），无需额外改动。

- [ ] **Step 4: 编译确认**

Run: `npm run compile`
Expected: settings/SettingsView 相关报错消失（loop 等其他文件仍飘红，属后续任务）。

- [ ] **Step 5: Commit**

```bash
git add storage/settings.ts components/settings/SettingsView.tsx
git commit -m "feat: 设置页上下文窗口字段（选填，占位显示模型推断值）"
```

---

## Task 6: 上下文组装的 summary 分支（`agent/context.ts`）

`buildContext` 有 summary 时：system + 前情摘要（user 消息）+ coversUpTo 之后的原始消息；无 summary 走旧 truncate 路径。

**Files:**
- Modify: `agent/context.ts:53-60`
- Test: `tests/agent/context.test.ts`（若已存在则追加用例；否则新建）

- [ ] **Step 1: 写失败测试**

```ts
// tests/agent/context.test.ts
import { describe, it, expect } from 'vitest';
import { buildContext } from '../../agent/context';
import type { ChatMessage } from '../../agent/provider/types';

const page = { url: 'https://x.com', title: 'X' };

describe('buildContext summary 分支', () => {
  it('无 summary 时首条为 system，其后是历史', () => {
    const history: ChatMessage[] = [{ role: 'user', content: 'hi' }];
    const out = buildContext(history, page);
    expect(out[0]!.role).toBe('system');
    expect(out[1]).toEqual({ role: 'user', content: 'hi' });
  });

  it('有 summary 时：system + 前情摘要(user) + coversUpTo 之后的原始消息', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: 'm0' },
      { role: 'assistant', content: 'm1' },
      { role: 'user', content: 'm2' },
      { role: 'assistant', content: 'm3' },
    ];
    const out = buildContext(history, page, 60, { text: '前情：做了 m0-m1', coversUpTo: 1 });
    expect(out[0]!.role).toBe('system');
    expect(out[1]!.role).toBe('user');
    expect(String(out[1]!.content)).toContain('前情：做了 m0-m1');
    // coversUpTo=1 → 保留 index 2,3
    expect(out.slice(2)).toEqual([
      { role: 'user', content: 'm2' },
      { role: 'assistant', content: 'm3' },
    ]);
  });

  it('summary 保留段头部若为孤立 tool 消息则剥离（避免 tool_call_id 悬空）', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: 'm0' },
      { role: 'tool', toolCallId: 't1', name: 'click', content: 'ok' },
      { role: 'assistant', content: 'm2' },
    ];
    // coversUpTo=0 → 保留段从 index1 起是 tool（悬空），应被剥掉，留 assistant
    const out = buildContext(history, page, 60, { text: 's', coversUpTo: 0 });
    const afterSummary = out.slice(2);
    expect(afterSummary[0]!.role).not.toBe('tool');
    expect(afterSummary).toEqual([{ role: 'assistant', content: 'm2' }]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test -- context`
Expected: FAIL（`buildContext` 第 4 参数不接受 summary）

- [ ] **Step 3: 改 `buildContext`**

把 [agent/context.ts:53-60](agent/context.ts#L53-L60) 的 `buildContext` 整个函数替换为：

```ts
export function buildContext(
  history: ChatMessage[],
  page: PageInfo,
  keepRecent = 60,
  summary?: { text: string; coversUpTo: number },
): ChatMessage[] {
  const pageBlock = page.url
    ? `\n\n当前页面：\n- URL: ${page.url}\n- 标题: ${page.title}`
    : '';
  const system: ChatMessage = { role: 'system', content: SYSTEM_PROMPT + pageBlock };

  if (summary) {
    // coversUpTo 之后的原始消息为保留段；剥掉头部孤立 tool 消息（其 assistant(toolCalls)
    // 已被折进摘要，回放会因 tool_call_id 悬空 400）。摘要作为一条 user 消息置于顶部。
    let recent = history.slice(summary.coversUpTo + 1);
    let start = 0;
    while (start < recent.length && recent[start]!.role === 'tool') start += 1;
    recent = recent.slice(start);
    const summaryMsg: ChatMessage = { role: 'user', content: `【前情摘要】\n${summary.text}` };
    return [system, summaryMsg, ...trimImageParts(recent)];
  }

  const trimmed = trimImageParts(truncateMessages(history, keepRecent));
  return [system, ...trimmed];
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run test -- context`
Expected: PASS（3 个新用例 + 原有用例不回归）

- [ ] **Step 5: Commit**

```bash
git add agent/context.ts tests/agent/context.test.ts
git commit -m "feat: buildContext summary 分支（摘要置顶 + 剥离悬空 tool 消息）"
```

---

## Task 7a: 压缩纯函数（`agent/compact.ts` 切段 + token 估算）

先落无副作用的核心：切段（哪些旧消息进本轮摘要）与压缩后 token 估算。

**Files:**
- Create: `agent/compact.ts`
- Test: `tests/agent/compact.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/agent/compact.test.ts
import { describe, it, expect } from 'vitest';
import { splitForCompaction, estimateContextTokens, KEEP_RECENT_ORIGINALS } from '../../agent/compact';
import type { ChatMessage } from '../../agent/provider/types';

const mk = (n: number): ChatMessage[] =>
  Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }) as ChatMessage);

describe('splitForCompaction', () => {
  it('保留边界常量 = 20', () => {
    expect(KEEP_RECENT_ORIGINALS).toBe(20);
  });
  it('首次压缩：N=30 无 coversUpTo → 摘要前 10 条，边界 9', () => {
    const r = splitForCompaction(mk(30), undefined, 20)!;
    expect(r.segment).toHaveLength(10);
    expect(r.newCoversUpTo).toBe(9);
  });
  it('消息不够老（N=15 < keep+1）→ null', () => {
    expect(splitForCompaction(mk(15), undefined, 20)).toBeNull();
  });
  it('已摘要覆盖足够（N=25, coversUpTo=9）→ null（不重复摘要，边界不倒退）', () => {
    expect(splitForCompaction(mk(25), 9, 20)).toBeNull();
  });
  it('增量压缩：N=50, coversUpTo=9 → 摘要 idx10-29，边界 29', () => {
    const r = splitForCompaction(mk(50), 9, 20)!;
    expect(r.segment).toHaveLength(20);
    expect(r.newCoversUpTo).toBe(29);
  });
});

describe('estimateContextTokens', () => {
  it('按字符数 / 2 估算（摘要 + 保留消息文本）', () => {
    const kept: ChatMessage[] = [{ role: 'user', content: 'abcd' }];
    // summary 'xy'(2) + 'abcd'(4) = 6 → ceil(6/2)=3
    expect(estimateContextTokens(kept, 'xy')).toBe(3);
  });
  it('content 为 parts 数组时只计文本 part', () => {
    const kept: ChatMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', imageUrl: 'x' }] }];
    // 'hi'(2) + summary ''(0) = 2 → 1
    expect(estimateContextTokens(kept, '')).toBe(1);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test -- compact`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现（第一段：常量 + 纯函数）**

```ts
// agent/compact.ts
// 上下文压缩：切段 + 增量摘要 + token 估算（设计 §4）。原始消息永不删除。
import type { ChatMessage, ContentPart, Provider } from './provider/types';
import { runTurn } from './run-turn';
import { getConversation, setSummary } from '../storage/conversations';

/** 保留最近 N 条原始消息不进摘要（近期上下文对连续操作最关键）。 */
export const KEEP_RECENT_ORIGINALS = 20;

export interface CompactSplit { segment: ChatMessage[]; newCoversUpTo: number }

/** 计算本轮要摘要的旧段与新边界。边界单调不倒退；无新可摘内容返回 null。 */
export function splitForCompaction(
  messages: ChatMessage[],
  coversUpTo: number | undefined,
  keepRecent: number,
): CompactSplit | null {
  const covered = coversUpTo ?? -1;
  const newCoversUpTo = Math.max(covered, messages.length - keepRecent - 1);
  if (newCoversUpTo <= covered) return null;
  const segment = messages.slice(covered + 1, newCoversUpTo + 1);
  if (segment.length === 0) return null;
  return { segment, newCoversUpTo };
}

/** 取消息文本（parts 数组只计 text part）。 */
function msgText(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  return (content as ContentPart[]).filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('');
}

/** 压缩后主上下文的 token 粗估：（摘要 + 保留消息文本）字符数 / 2（中英混合保守系数）。 */
export function estimateContextTokens(keptMessages: ChatMessage[], summaryText: string): number {
  const chars = summaryText.length + keptMessages.reduce((a, m) => a + msgText(m.content).length, 0);
  return Math.ceil(chars / 2);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run test -- compact`
Expected: PASS（切段 5 用例 + 估算 2 用例）

- [ ] **Step 5: Commit**

```bash
git add agent/compact.ts tests/agent/compact.test.ts
git commit -m "feat: 压缩切段与 token 估算纯函数（边界单调、保留近 20 条）"
```

---

## Task 7b: 压缩主流程（`agent/compact.ts` compactConversation）

串起存储读写 + LLM 摘要：读会话 → 切段 → （含旧摘要）调 LLM → 写回 summary → 估算新 token。失败不改会话。

**Files:**
- Modify: `agent/compact.ts`（追加）
- Test: `tests/agent/compact.test.ts`（追加）

- [ ] **Step 1: 追加失败测试**

在 `tests/agent/compact.test.ts` 末尾追加：

```ts
import { beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { compactConversation } from '../../agent/compact';
import { createConversation, getConversation, appendMessage } from '../../storage/conversations';
import type { Provider, StreamEvent, ChatParams } from '../../agent/provider/types';

function textProvider(events: StreamEvent[]): Provider {
  return {
    streamChat(_p: ChatParams, onEvent: (e: StreamEvent) => void) {
      queueMicrotask(() => { for (const e of events) onEvent(e); });
      return { cancel: vi.fn() };
    },
  };
}

describe('compactConversation', () => {
  beforeEach(() => fakeBrowser.reset());

  it('消息够多 → 调 LLM 写回摘要，原始消息不变', async () => {
    const c = await createConversation();
    for (let i = 0; i < 30; i++) await appendMessage(c.id, { role: i % 2 ? 'assistant' : 'user', content: `m${i}` });
    const provider = textProvider([{ type: 'text-delta', text: '前情摘要内容' }, { type: 'message-done', finishReason: 'stop' }]);
    const r = await compactConversation(c.id, { provider });
    expect(r.ok).toBe(true);
    const got = await getConversation(c.id);
    expect(got.summary!.text).toBe('前情摘要内容');
    expect(got.summary!.coversUpTo).toBe(9);
    expect(got.messages).toHaveLength(30); // 原始不删
    expect(r.newPromptTokens).toBeGreaterThan(0);
  });

  it('消息太少（不足触发）→ ok 但不调 provider、不写摘要', async () => {
    const c = await createConversation();
    for (let i = 0; i < 5; i++) await appendMessage(c.id, { role: 'user', content: `m${i}` });
    const stream = vi.fn();
    const provider: Provider = { streamChat: stream };
    const r = await compactConversation(c.id, { provider });
    expect(r.ok).toBe(true);
    expect(stream).not.toHaveBeenCalled();
    expect((await getConversation(c.id)).summary).toBeUndefined();
  });

  it('LLM 出错 → ok=false，不改会话摘要', async () => {
    const c = await createConversation();
    for (let i = 0; i < 30; i++) await appendMessage(c.id, { role: 'user', content: `m${i}` });
    const provider = textProvider([{ type: 'error', error: '429' }, { type: 'message-done' }]);
    const r = await compactConversation(c.id, { provider });
    expect(r.ok).toBe(false);
    expect((await getConversation(c.id)).summary).toBeUndefined();
  });

  it('增量摘要：已有 summary 时把旧摘要一并喂给 LLM', async () => {
    const c = await createConversation();
    for (let i = 0; i < 30; i++) await appendMessage(c.id, { role: 'user', content: `m${i}` });
    await compactConversation(c.id, { provider: textProvider([{ type: 'text-delta', text: '第一次摘要' }, { type: 'message-done', finishReason: 'stop' }]) });
    for (let i = 30; i < 60; i++) await appendMessage(c.id, { role: 'user', content: `m${i}` });
    let sentMessages = '';
    const spyProvider: Provider = {
      streamChat(p, onEvent) {
        sentMessages = JSON.stringify(p.messages);
        queueMicrotask(() => { onEvent({ type: 'text-delta', text: '第二次摘要' }); onEvent({ type: 'message-done', finishReason: 'stop' }); });
        return { cancel: vi.fn() };
      },
    };
    const r = await compactConversation(c.id, { provider: spyProvider });
    expect(r.ok).toBe(true);
    expect(sentMessages).toContain('第一次摘要'); // 旧摘要参与增量
    expect((await getConversation(c.id)).summary!.text).toBe('第二次摘要');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test -- compact`
Expected: FAIL（`compactConversation` 未导出）

- [ ] **Step 3: 实现（追加到 `agent/compact.ts` 末尾）**

```ts
export interface CompactDeps { provider: Provider }
export interface CompactResult { ok: boolean; newPromptTokens?: number; error?: string }

const COMPACT_SYSTEM = `你是一个上下文压缩器。把给定的对话历史浓缩成简洁的中文「前情摘要」，供后续对话延续使用。
保留：任务目标、已完成的关键操作及其结果、重要发现/数据/URL、待办事项。
丢弃：冗余的工具原始输出、寒暄、重复内容。
直接输出摘要正文，不要加「以下是摘要」之类的前言。`;

/** 把一段消息序列化成可读文本（供摘要 LLM 阅读）。 */
function serializeSegment(messages: ChatMessage[]): string {
  return messages.map((m) => {
    const text = msgText(m.content);
    if (m.role === 'assistant' && m.toolCalls?.length) {
      const calls = m.toolCalls.map((tc) => `${tc.name}(${tc.arguments})`).join(', ');
      return `assistant: ${text}${text ? ' ' : ''}[调用工具: ${calls}]`;
    }
    if (m.role === 'tool') return `tool[${m.name ?? ''}]: ${text}`;
    return `${m.role}: ${text}`;
  }).join('\n');
}

/** 压缩会话：读→切段→（含旧摘要）调 LLM→写回摘要→估算新 token。失败不改会话。 */
export async function compactConversation(convId: string, deps: CompactDeps): Promise<CompactResult> {
  const conv = await getConversation(convId);
  const split = splitForCompaction(conv.messages, conv.summary?.coversUpTo, KEEP_RECENT_ORIGINALS);
  if (!split) return { ok: true }; // 无新可摘内容

  const priorBlock = conv.summary ? `已有前情摘要（请在此基础上增量合并）：\n${conv.summary.text}\n\n新增对话：\n` : '';
  const userContent = `${priorBlock}${serializeSegment(split.segment)}`;
  const messages: ChatMessage[] = [
    { role: 'system', content: COMPACT_SYSTEM },
    { role: 'user', content: userContent },
  ];

  const result = await runTurn(deps.provider, { messages, tools: [] }, {});
  if (result.error) return { ok: false, error: result.error };
  const text = result.text.trim();
  if (!text) return { ok: false, error: '摘要为空' };

  await setSummary(convId, { text, coversUpTo: split.newCoversUpTo });
  const kept = conv.messages.slice(split.newCoversUpTo + 1);
  return { ok: true, newPromptTokens: estimateContextTokens(kept, text) };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run test -- compact`
Expected: PASS（新增 4 用例 + 7a 的 7 用例）

- [ ] **Step 5: 编译确认**

Run: `npm run compile`
Expected: compact.ts 无报错（loop/agent-port 仍飘红，属后续任务）。

- [ ] **Step 6: Commit**

```bash
git add agent/compact.ts tests/agent/compact.test.ts
git commit -m "feat: compactConversation 主流程（增量摘要 + 失败不改会话 + token 估算）"
```

---

## Task 8a: agent loop 改写（`agent/loop.ts`）

sessionId→convId（存储 key）与 tabId（操作目标）彻底拆开；消费 usage；达阈值自动压缩。改动贯穿全文，给出整份新文件。

**Files:**
- Modify: `agent/loop.ts`（整份替换）

- [ ] **Step 1: 用下面内容整份替换 `agent/loop.ts`（第一段：import + 类型 + 入口）**

替换文件顶部到 `resumeAgentLoop` 结束（原 [agent/loop.ts:1-42](agent/loop.ts#L1-L42)）：

```ts
// agent/loop.ts
// Agent 主循环状态机（设计 §2）：convId 存储 + tabId 操作目标 + usage 计量 + 自动压缩 + 熔断阀。
import type { Provider, ChatMessage, ToolCall, ContentPart } from './provider/types';
import type { ToolResult } from '../shared/types';
import type { PortMsgToPanel } from '../shared/messages';
import { runTurn } from './run-turn';
import { buildContext, type PageInfo } from './context';
import { getToolSchemas } from './tools/registry';
import { initGuardState, recordTurn, checkGuards, DEFAULT_GUARD_CONFIG, type GuardState } from './loop-guards';
import { getConversation, appendMessage, setStatus, setLastPromptTokens } from '../storage/conversations';
import { meterRatio, COMPACT_THRESHOLD } from './context-meter';

export interface LoopDeps {
  provider: Provider;
  executeTool: (name: string, args: Record<string, unknown>, tabId: number, signal: AbortSignal) => Promise<ToolResult>;
  getPageInfo: (tabId: number) => Promise<PageInfo>;
  emit: (msg: PortMsgToPanel) => void;
  resolveOpenedTab?: (toolName: string, openerTabId: number, signal: AbortSignal) => Promise<number | undefined>;
  /** 上下文窗口（token）。缺省则不做自动压缩（便于测试）。 */
  getContextWindow?: () => Promise<number>;
  /** 压缩当前会话。缺省则不做自动压缩（便于测试）。 */
  compact?: (convId: string) => Promise<{ ok: boolean; newPromptTokens?: number; error?: string }>;
}

const TAB_OPENING_TOOLS = new Set(['click', 'press_key']);

export interface LoopArgs {
  convId: string;
  tabId: number;
  userMessage: string;
}

export async function runAgentLoop(args: LoopArgs, deps: LoopDeps, signal?: AbortSignal): Promise<void> {
  await appendMessage(args.convId, { role: 'user', content: args.userMessage });
  await setStatus(args.convId, 'running');
  await drive(args.convId, args.tabId, deps, initGuardState(), signal ?? new AbortController().signal);
}

/** 从暂停状态恢复（不追加新 user 消息）。 */
export async function resumeAgentLoop(convId: string, tabId: number, deps: LoopDeps, signal?: AbortSignal): Promise<void> {
  await setStatus(convId, 'running');
  await drive(convId, tabId, deps, initGuardState(), signal ?? new AbortController().signal);
}
```

- [ ] **Step 2: 替换 `drive` 函数（原 [agent/loop.ts:44-167](agent/loop.ts#L44-L167)）为**

```ts
async function drive(convId: string, startTabId: number, deps: LoopDeps, guardState: GuardState, signal: AbortSignal): Promise<void> {
  let guard = guardState;
  let targetTab = startTabId;
  let lastPromptTokens: number | undefined;

  for (;;) {
    if (signal.aborted) return void (await finishAborted(convId, deps));

    // 自动压缩：上一轮 usage 达阈值 → 进下一轮前先摘要一次（不打断已完成的工具链）
    if (deps.compact && deps.getContextWindow && lastPromptTokens != null) {
      const window = await deps.getContextWindow();
      if (meterRatio(lastPromptTokens, window) >= COMPACT_THRESHOLD) {
        deps.emit({ type: 'compact-start' });
        const r = await deps.compact(convId).catch(() => ({ ok: false as const }));
        if (r.ok && r.newPromptTokens != null) {
          lastPromptTokens = r.newPromptTokens;
          await setLastPromptTokens(convId, r.newPromptTokens);
          deps.emit({ type: 'usage', promptTokens: r.newPromptTokens });
        }
        deps.emit({ type: 'compact-done', newPromptTokens: r.ok ? r.newPromptTokens : undefined });
      }
    }

    const conv = await getConversation(convId);
    const page = await deps.getPageInfo(targetTab).catch(() => ({ url: '', title: '' }));
    const messages = buildContext(conv.messages, page, 60, conv.summary);

    const result = await runTurn(deps.provider, { messages, tools: getToolSchemas(), signal }, {
      onTextDelta: (t) => deps.emit({ type: 'text-delta', text: t }),
      onReasoningDelta: (t) => deps.emit({ type: 'reasoning-delta', text: t }),
    });

    if (signal.aborted) {
      if (result.text || result.reasoning) {
        await appendMessage(convId, { role: 'assistant', content: result.text, reasoning: result.reasoning });
      }
      await finishAborted(convId, deps);
      return;
    }

    // usage 计量：无论 finishReason 都消费（供上下文标识 + 下一轮自动压缩判定）
    if (result.usage?.promptTokens != null) {
      lastPromptTokens = result.usage.promptTokens;
      await setLastPromptTokens(convId, result.usage.promptTokens);
      deps.emit({ type: 'usage', promptTokens: result.usage.promptTokens, completionTokens: result.usage.completionTokens });
    }

    if (result.error) {
      deps.emit({ type: 'error', message: result.error });
      await setStatus(convId, 'idle');
      return;
    }

    if (result.finishReason === 'length' && result.toolCalls.length > 0) {
      await appendMessage(convId, assistantMsg(result.text, result.toolCalls, result.reasoning));
      const truncFailed: ToolResult[] = [];
      for (const tc of result.toolCalls) {
        await appendMessage(convId, { role: 'tool', toolCallId: tc.id, name: tc.name, content: '错误：模型输出被截断，该工具调用参数不完整，请重新发起' });
        truncFailed.push({ ok: false, error: '模型输出被截断' });
      }
      guard = recordTurn(guard, result.toolCalls, truncFailed);
      const verdict = checkGuards(guard, DEFAULT_GUARD_CONFIG);
      if (verdict.stop) {
        await setStatus(convId, 'paused');
        deps.emit({ type: 'paused', reason: verdict.reason ?? '' });
        return;
      }
      continue;
    }

    if (result.toolCalls.length === 0) {
      const truncated = result.finishReason === 'length';
      const finalText = truncated
        ? `${result.text}\n\n[注意：回复因达到长度上限被截断，可能不完整]`
        : result.text;
      await appendMessage(convId, { role: 'assistant', content: finalText, reasoning: result.reasoning });
      deps.emit({ type: 'done', finalText });
      await setStatus(convId, 'idle');
      return;
    }

    await appendMessage(convId, assistantMsg(result.text, result.toolCalls, result.reasoning));
    const results: ToolResult[] = [];
    for (const tc of result.toolCalls) {
      if (signal.aborted) { await finishAborted(convId, deps); return; }
      let toolArgs: Record<string, unknown> = {};
      try { toolArgs = tc.arguments ? JSON.parse(tc.arguments) : {}; } catch { /* 保持空对象 */ }
      deps.emit({ type: 'tool-start', name: tc.name, args: tc.arguments, callId: tc.id });
      const r = await deps.executeTool(tc.name, toolArgs, targetTab, signal);
      results.push(r);

      if (r.ok && (tc.name === 'new_page' || tc.name === 'select_page')) {
        const d = r.data as { targetTab?: number } | undefined;
        if (typeof d?.targetTab === 'number') targetTab = d.targetTab;
      }
      if (r.ok && tc.name === 'close_page') {
        const d = r.data as { closed?: number } | undefined;
        if (d?.closed === targetTab) targetTab = startTabId;
      }
      if (r.ok && deps.resolveOpenedTab && TAB_OPENING_TOOLS.has(tc.name)) {
        const opened = await deps.resolveOpenedTab(tc.name, targetTab, signal);
        if (typeof opened === 'number') targetTab = opened;
      }

      if (tc.name === 'take_screenshot' && r.ok) {
        const shot = (r.data as { screenshot?: string } | undefined)?.screenshot;
        deps.emit({ type: 'tool-end', name: tc.name, callId: tc.id, ok: true, summary: '已截图', image: shot });
        await appendMessage(convId, { role: 'tool', toolCallId: tc.id, name: tc.name, content: '截图已捕获，见下一条消息' });
        if (shot) {
          const parts: ContentPart[] = [
            { type: 'text', text: '（take_screenshot 返回的页面截图）' },
            { type: 'image_url', imageUrl: shot },
          ];
          await appendMessage(convId, { role: 'user', content: parts });
        }
        continue;
      }

      const summary = r.ok ? '成功' : (r.error ?? '失败');
      const output = toToolContent(r);
      deps.emit({ type: 'tool-end', name: tc.name, callId: tc.id, ok: r.ok, summary, output });
      await appendMessage(convId, { role: 'tool', toolCallId: tc.id, name: tc.name, content: output });
    }

    guard = recordTurn(guard, result.toolCalls, results);
    const verdict = checkGuards(guard, DEFAULT_GUARD_CONFIG);
    if (verdict.stop) {
      await setStatus(convId, 'paused');
      deps.emit({ type: 'paused', reason: verdict.reason ?? '' });
      return;
    }
  }
}
```

- [ ] **Step 3: 替换 `finishAborted`（原 [agent/loop.ts:174-177](agent/loop.ts#L174-L177)）的参数名**

```ts
async function finishAborted(convId: string, deps: LoopDeps): Promise<void> {
  await setStatus(convId, 'idle');
  deps.emit({ type: 'done', finalText: '已停止' });
}
```

（`assistantMsg` 与 `toToolContent` 两个辅助函数保持不变。）

- [ ] **Step 4: 编译确认**

Run: `npm run compile`
Expected: loop.ts 自身无报错；agent-port.ts、loop.test.ts 仍飘红（后续任务修）。

- [ ] **Step 5: Commit（loop.ts 单独提交，测试下一任务同步）**

```bash
git add agent/loop.ts
git commit -m "feat: loop 改用 convId 存储 + tabId 操作目标 + usage 计量 + 自动压缩钩子"
```

---

## Task 8b: loop 测试迁移 + usage/自动压缩用例（`tests/agent/loop.test.ts`）

现有测试用 `sessionId` + `getSession(tabId)`，全部迁到 `convId` + `getConversation(convId)`（tabId 保留为操作目标）；新增 usage 发射与自动压缩两个用例。整份替换。

**Files:**
- Modify: `tests/agent/loop.test.ts`（整份替换）

- [ ] **Step 1: 用下面内容整份替换 `tests/agent/loop.test.ts`（头部 + 前 6 个用例）**

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { runAgentLoop, type LoopDeps } from '../../agent/loop';
import { getConversation, appendMessage } from '../../storage/conversations';
import type { Provider, StreamEvent, ChatParams } from '../../agent/provider/types';
import type { ToolResult } from '../../shared/types';

function queuedProvider(scripts: StreamEvent[][]): Provider {
  let i = 0;
  return {
    streamChat(_p: ChatParams, onEvent: (e: StreamEvent) => void) {
      const script = scripts[i++] ?? [{ type: 'message-done', finishReason: 'stop' }];
      queueMicrotask(() => { for (const e of script) onEvent(e); });
      return { cancel: vi.fn() };
    },
  };
}

const deps = (provider: Provider, exec: LoopDeps['executeTool'], extra?: Partial<LoopDeps>): LoopDeps => ({
  provider,
  executeTool: exec,
  getPageInfo: async () => ({ url: 'https://x.com', title: 'X' }),
  emit: vi.fn(),
  ...extra,
});

describe('agent loop', () => {
  beforeEach(() => fakeBrowser.reset());

  it('无 tool_calls 时一轮即自然终止，保存最终回复', async () => {
    const provider = queuedProvider([[{ type: 'text-delta', text: '完成了' }, { type: 'message-done', finishReason: 'stop' }]]);
    const exec = vi.fn<LoopDeps['executeTool']>();
    await runAgentLoop({ convId: 'c1', tabId: 1, userMessage: '你好' }, deps(provider, exec));
    const conv = await getConversation('c1');
    expect(exec).not.toHaveBeenCalled();
    const last = conv.messages[conv.messages.length - 1]!;
    expect(last.role).toBe('assistant');
    expect(last.content).toBe('完成了');
    expect(conv.status).toBe('idle');
  });

  it('外部 signal 已 abort → 不调 provider，立即 idle + emit done', async () => {
    const stream = vi.fn();
    const provider: Provider = { streamChat: stream };
    const exec = vi.fn<LoopDeps['executeTool']>();
    const d = deps(provider, exec);
    const ac = new AbortController();
    ac.abort();
    await runAgentLoop({ convId: 'c40', tabId: 40, userMessage: 'x' }, d, ac.signal);
    expect(stream).not.toHaveBeenCalled();
    expect((await getConversation('c40')).status).toBe('idle');
    expect(d.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'done' }));
  });

  it('运行中 abort（流式输出后）→ 保留已输出助手文本，不进工具执行，emit done', async () => {
    const ac = new AbortController();
    const provider: Provider = {
      streamChat(_p, onEvent) {
        queueMicrotask(() => {
          onEvent({ type: 'text-delta', text: '我正在处理' });
          ac.abort();
          onEvent({ type: 'tool-call-delta', index: 0, id: 'c1', name: 'click', argsDelta: '{"uid":1}' });
          onEvent({ type: 'message-done', finishReason: 'tool_calls' });
        });
        return { cancel: vi.fn() };
      },
    };
    const exec = vi.fn<LoopDeps['executeTool']>();
    const d = deps(provider, exec);
    await runAgentLoop({ convId: 'c41', tabId: 41, userMessage: 'x' }, d, ac.signal);
    const conv = await getConversation('c41');
    expect(exec).not.toHaveBeenCalled();
    const asst = conv.messages.find((m) => m.role === 'assistant');
    expect(asst?.content).toBe('我正在处理');
    expect(conv.status).toBe('idle');
    expect(d.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'done' }));
  });

  it('纯文本被 length 截断时回复带截断提示', async () => {
    const provider = queuedProvider([[{ type: 'text-delta', text: '半截回复' }, { type: 'message-done', finishReason: 'length' }]]);
    const exec = vi.fn<LoopDeps['executeTool']>();
    await runAgentLoop({ convId: 'c8', tabId: 8, userMessage: 'x' }, deps(provider, exec));
    const conv = await getConversation('c8');
    const last = conv.messages[conv.messages.length - 1]!;
    expect(String(last.content)).toContain('半截回复');
    expect(String(last.content)).toContain('截断');
    expect(conv.status).toBe('idle');
  });

  it('一轮工具调用后再自然终止', async () => {
    const provider = queuedProvider([
      [{ type: 'tool-call-delta', index: 0, id: 'c1', name: 'take_snapshot', argsDelta: '{}' }, { type: 'message-done', finishReason: 'tool_calls' }],
      [{ type: 'text-delta', text: '看到了' }, { type: 'message-done', finishReason: 'stop' }],
    ]);
    const exec = vi.fn<LoopDeps['executeTool']>().mockResolvedValue({ ok: true, data: { text: '[1] button' } } as ToolResult);
    await runAgentLoop({ convId: 'c2', tabId: 2, userMessage: '看页面' }, deps(provider, exec));
    expect(exec).toHaveBeenCalledOnce();
    const conv = await getConversation('c2');
    expect(conv.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
  });

  it('工具错误作为 tool result 喂回，不中断', async () => {
    const provider = queuedProvider([
      [{ type: 'tool-call-delta', index: 0, id: 'c1', name: 'click', argsDelta: '{"uid":9}' }, { type: 'message-done', finishReason: 'tool_calls' }],
      [{ type: 'text-delta', text: '换个方法' }, { type: 'message-done', finishReason: 'stop' }],
    ]);
    const exec = vi.fn<LoopDeps['executeTool']>().mockResolvedValue({ ok: false, error: 'stale' });
    await runAgentLoop({ convId: 'c3', tabId: 3, userMessage: 'x' }, deps(provider, exec));
    const conv = await getConversation('c3');
    const toolMsg = conv.messages.find((m) => m.role === 'tool')!;
    expect(String(toolMsg.content)).toContain('stale');
  });
```

（下一步续写剩余用例，勿在此步 commit。）

- [ ] **Step 2: 续写 `tests/agent/loop.test.ts`（中段：截断熔断 / error / 打转 / reasoning / 工具分支）**

接在 Step 1 内容之后：

```ts
  it('length 截断时该轮 tool_calls 判失败喂回', async () => {
    const provider = queuedProvider([
      [{ type: 'tool-call-delta', index: 0, id: 'c1', name: 'click', argsDelta: '{"uid":' }, { type: 'message-done', finishReason: 'length' }],
      [{ type: 'text-delta', text: '重试' }, { type: 'message-done', finishReason: 'stop' }],
    ]);
    const exec = vi.fn<LoopDeps['executeTool']>();
    await runAgentLoop({ convId: 'c4', tabId: 4, userMessage: 'x' }, deps(provider, exec));
    expect(exec).not.toHaveBeenCalled();
    const conv = await getConversation('c4');
    expect(conv.messages.some((m) => m.role === 'tool' && String(m.content).includes('截断'))).toBe(true);
  });

  it('provider error 事件终止并保存错误', async () => {
    const provider = queuedProvider([[{ type: 'error', error: 'HTTP 401' }, { type: 'message-done' }]]);
    const exec = vi.fn<LoopDeps['executeTool']>();
    const d = deps(provider, exec);
    await runAgentLoop({ convId: 'c5', tabId: 5, userMessage: 'x' }, d);
    expect(d.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });

  it('连续 length 截断触发熔断暂停（不无限循环）', async () => {
    const lengthTurn = (): StreamEvent[] => [
      { type: 'tool-call-delta', index: 0, id: `c${Math.random()}`, name: 'click', argsDelta: '{"uid":' },
      { type: 'message-done', finishReason: 'length' },
    ];
    const provider = queuedProvider(Array.from({ length: 60 }, () => lengthTurn()));
    const exec = vi.fn<LoopDeps['executeTool']>();
    const d = deps(provider, exec);
    await runAgentLoop({ convId: 'c7', tabId: 7, userMessage: 'x' }, d);
    const conv = await getConversation('c7');
    expect(conv.status).toBe('paused');
    expect(exec).not.toHaveBeenCalled();
    expect(d.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'paused' }));
  });

  it('打转触发暂停（status=paused）', async () => {
    const turn = (): StreamEvent[] => [
      { type: 'tool-call-delta', index: 0, id: `c${Math.random()}`, name: 'scroll', argsDelta: '{"direction":"down"}' },
      { type: 'message-done', finishReason: 'tool_calls' },
    ];
    const provider = queuedProvider([turn(), turn(), turn(), turn(), turn()]);
    const exec = vi.fn<LoopDeps['executeTool']>().mockResolvedValue({ ok: true });
    const d = deps(provider, exec);
    await runAgentLoop({ convId: 'c6', tabId: 6, userMessage: 'x' }, d);
    expect((await getConversation('c6')).status).toBe('paused');
    expect(d.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'paused' }));
  });

  it('reasoning-delta 转发到 Port，且 reasoning 存进 assistant 消息', async () => {
    const provider = queuedProvider([[
      { type: 'reasoning-delta', text: '先想想' },
      { type: 'text-delta', text: '好的' },
      { type: 'message-done', finishReason: 'stop' },
    ]]);
    const exec = vi.fn<LoopDeps['executeTool']>();
    const d = deps(provider, exec);
    await runAgentLoop({ convId: 'c10', tabId: 10, userMessage: 'x' }, d);
    expect(d.emit).toHaveBeenCalledWith({ type: 'reasoning-delta', text: '先想想' });
    const conv = await getConversation('c10');
    const last = conv.messages[conv.messages.length - 1]!;
    expect(last.reasoning).toBe('先想想');
    expect(last.content).toBe('好的');
  });

  it('工具分支 assistant 消息也带 reasoning；tool-end 带完整 output', async () => {
    const provider = queuedProvider([
      [{ type: 'reasoning-delta', text: '需要看页面' }, { type: 'tool-call-delta', index: 0, id: 'c1', name: 'take_snapshot', argsDelta: '{}' }, { type: 'message-done', finishReason: 'tool_calls' }],
      [{ type: 'text-delta', text: '看到了' }, { type: 'message-done', finishReason: 'stop' }],
    ]);
    const exec = vi.fn<LoopDeps['executeTool']>().mockResolvedValue({ ok: true, data: '[1] button 完整快照文本' } as ToolResult);
    const d = deps(provider, exec);
    await runAgentLoop({ convId: 'c11', tabId: 11, userMessage: 'x' }, d);
    const conv = await getConversation('c11');
    const asst = conv.messages.find((m) => m.role === 'assistant' && m.toolCalls?.length)!;
    expect(asst.reasoning).toBe('需要看页面');
    expect(d.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'tool-end', callId: 'c1', ok: true, output: '[1] button 完整快照文本' }));
  });
```

- [ ] **Step 3: 续写 `tests/agent/loop.test.ts`（targetTab 三个用例 + 截图，convId 化）**

接在 Step 2 之后：

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
    await runAgentLoop({ convId: 'c-np', tabId: 10, userMessage: 'x' }, deps(provider, exec));
    expect(calls[0]).toBe(10);
    expect(calls[1]).toBe(555);
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
    await runAgentLoop({ convId: 'c-cp', tabId: 20, userMessage: 'x' }, deps(provider, exec));
    expect(calls[2]).toBe(20);
  });

  it('click 打开新标签后 targetTab 跟随', async () => {
    const provider = queuedProvider([
      [{ type: 'tool-call-delta', index: 0, id: 'c1', name: 'click', argsDelta: '{"uid":3}' }, { type: 'message-done', finishReason: 'tool_calls' }],
      [{ type: 'tool-call-delta', index: 0, id: 'c2', name: 'take_snapshot', argsDelta: '{}' }, { type: 'message-done', finishReason: 'tool_calls' }],
      [{ type: 'text-delta', text: '完成' }, { type: 'message-done', finishReason: 'stop' }],
    ]);
    const calls: number[] = [];
    const exec = vi.fn<LoopDeps['executeTool']>().mockImplementation(async (_n, _a, tabId) => { calls.push(tabId); return { ok: true, data: { text: 'snap' } }; });
    const resolveOpenedTab = vi.fn<NonNullable<LoopDeps['resolveOpenedTab']>>().mockImplementation(async (name) => (name === 'click' ? 888 : undefined));
    await runAgentLoop({ convId: 'c-ck', tabId: 50, userMessage: 'x' }, deps(provider, exec, { resolveOpenedTab }));
    expect(calls[0]).toBe(50);
    expect(calls[1]).toBe(888);
    expect(resolveOpenedTab).toHaveBeenCalledWith('click', 50, expect.any(AbortSignal));
  });

  it('take_screenshot 成功后注入 user 图片消息 + emit 带缩略图', async () => {
    const provider = queuedProvider([
      [{ type: 'tool-call-delta', index: 0, id: 'c1', name: 'take_screenshot', argsDelta: '{}' }, { type: 'message-done', finishReason: 'tool_calls' }],
      [{ type: 'text-delta', text: '看到了' }, { type: 'message-done', finishReason: 'stop' }],
    ]);
    const exec = vi.fn<LoopDeps['executeTool']>().mockResolvedValue({ ok: true, data: { screenshot: 'data:image/jpeg;base64,ZZZ' } });
    const d = deps(provider, exec);
    await runAgentLoop({ convId: 'c30', tabId: 30, userMessage: 'x' }, d);
    const conv = await getConversation('c30');
    const userImg = conv.messages.find((m) => m.role === 'user' && Array.isArray(m.content));
    const parts = userImg!.content as Array<{ type: string; imageUrl?: string }>;
    expect(parts.some((p) => p.type === 'image_url' && p.imageUrl === 'data:image/jpeg;base64,ZZZ')).toBe(true);
    expect(d.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'tool-end', image: 'data:image/jpeg;base64,ZZZ' }));
  });
```

- [ ] **Step 4: 续写新用例（usage 发射 + 自动压缩），并闭合 `describe`**

接在 Step 3 之后（注意最后的 `});` 闭合整个 describe）：

```ts
  it('usage：provider 返回 promptTokens → emit usage 且存入 lastPromptTokens', async () => {
    const provider = queuedProvider([[
      { type: 'text-delta', text: 'ok' },
      { type: 'message-done', finishReason: 'stop', usage: { promptTokens: 12345, completionTokens: 67 } },
    ]]);
    const exec = vi.fn<LoopDeps['executeTool']>();
    const d = deps(provider, exec);
    await runAgentLoop({ convId: 'c-usage', tabId: 1, userMessage: 'x' }, d);
    expect(d.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'usage', promptTokens: 12345, completionTokens: 67 }));
    expect((await getConversation('c-usage')).lastPromptTokens).toBe(12345);
  });

  it('自动压缩：上一轮 promptTokens 超 80% 窗口 → 下一轮前调 compact', async () => {
    // 第一轮请求工具（带高 usage），第二轮自然终止
    const provider = queuedProvider([
      [{ type: 'tool-call-delta', index: 0, id: 'c1', name: 'take_snapshot', argsDelta: '{}' }, { type: 'message-done', finishReason: 'tool_calls', usage: { promptTokens: 120000 } }],
      [{ type: 'text-delta', text: '完成' }, { type: 'message-done', finishReason: 'stop' }],
    ]);
    const exec = vi.fn<LoopDeps['executeTool']>().mockResolvedValue({ ok: true, data: { text: 'snap' } } as ToolResult);
    const compact = vi.fn<NonNullable<LoopDeps['compact']>>().mockResolvedValue({ ok: true, newPromptTokens: 3000 });
    const getContextWindow = vi.fn<NonNullable<LoopDeps['getContextWindow']>>().mockResolvedValue(128000);
    const d = deps(provider, exec, { compact, getContextWindow });
    await runAgentLoop({ convId: 'c-auto', tabId: 1, userMessage: 'x' }, d);
    expect(compact).toHaveBeenCalledWith('c-auto');
    expect(d.emit).toHaveBeenCalledWith({ type: 'compact-start' });
    expect(d.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'compact-done', newPromptTokens: 3000 }));
  });

  it('未超阈值时不自动压缩', async () => {
    const provider = queuedProvider([
      [{ type: 'tool-call-delta', index: 0, id: 'c1', name: 'take_snapshot', argsDelta: '{}' }, { type: 'message-done', finishReason: 'tool_calls', usage: { promptTokens: 1000 } }],
      [{ type: 'text-delta', text: '完成' }, { type: 'message-done', finishReason: 'stop' }],
    ]);
    const exec = vi.fn<LoopDeps['executeTool']>().mockResolvedValue({ ok: true, data: { text: 'snap' } } as ToolResult);
    const compact = vi.fn<NonNullable<LoopDeps['compact']>>().mockResolvedValue({ ok: true, newPromptTokens: 1 });
    const getContextWindow = vi.fn<NonNullable<LoopDeps['getContextWindow']>>().mockResolvedValue(128000);
    await runAgentLoop({ convId: 'c-noauto', tabId: 1, userMessage: 'x' }, deps(provider, exec, { compact, getContextWindow }));
    expect(compact).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 5: 运行全部 loop 测试确认通过**

Run: `npm run test -- loop`
Expected: PASS（原有用例迁移后全绿 + 3 个新用例）

- [ ] **Step 6: Commit**

```bash
git add tests/agent/loop.test.ts
git commit -m "test: loop 测试迁移到 convId + usage 发射/自动压缩用例"
```

---

## Task 9a: 后台 Port 改造（`background/agent-port.ts`）

`runningTabs`→`runningConvs`（按 convId 闸门）；makeDeps 注入 `getContextWindow`/`compact`、executeTool 用 convId；新增 `agent:compact` 处理（与运行中 loop 互斥）。

**Files:**
- Modify: `background/agent-port.ts`

- [ ] **Step 1: 顶部 import 增补**

把 [background/agent-port.ts:1-8](background/agent-port.ts#L1-L8) 的 import 区替换为：

```ts
// background/agent-port.ts
// sidepanel ↔ background Port 管理 + agent loop 生命周期挂载（设计 §7 / §1.4）。
import type { PortMsgFromPanel, PortMsgToPanel } from '../shared/messages';
import type { Provider } from '../agent/provider/types';
import { OpenAICompatProvider } from '../agent/provider/openai-compat';
import { getSettings } from '../storage/settings';
import { runAgentLoop, resumeAgentLoop, type LoopDeps } from '../agent/loop';
import { executeTool } from '../agent/tools/registry';
import { compactConversation } from '../agent/compact';
import { resolveContextWindow } from '../agent/model-windows';
```

- [ ] **Step 2: 改 `makeDeps`（executeTool 用 convId + 注入 getContextWindow/compact）**

把 [background/agent-port.ts:64-82](background/agent-port.ts#L64-L82) 的 `makeDeps` 整个函数替换为：

```ts
function makeDeps(
  provider: Provider,
  convId: string,
  port: Pick<Browser.runtime.Port, 'postMessage'>,
): LoopDeps {
  return {
    provider,
    executeTool: (name, args, tabId, signal) =>
      executeTool(name, args, { tabId, sessionId: convId, signal, waitForReady: (t) => waitForCsReady(t) }),
    getPageInfo,
    resolveOpenedTab: (_name, openerTabId) => resolveOpenedTab(openerTabId, (t) => waitForCsReady(t)),
    getContextWindow: async () => {
      const { provider: p } = await getSettings();
      return resolveContextWindow(p.model, p.contextWindow);
    },
    compact: (id) => compactConversation(id, { provider }),
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

- [ ] **Step 3: `runningTabs`→`runningConvs` + `stopTab`→`stopConv`**

把 [background/agent-port.ts:84-91](background/agent-port.ts#L84-L91) 替换为：

```ts
// 同 conv 单 loop 闸门 + 中断句柄：每个运行中的会话挂一个 AbortController。
const runningConvs = new Map<string, AbortController>();

/** 中断指定会话的运行中 loop（agent:stop）。loop 在下个检查点干净退出。 */
export function stopConv(convId: string): void {
  runningConvs.get(convId)?.abort();
}
```

- [ ] **Step 4: 改 `onMessage` 处理块**

把 [background/agent-port.ts:100-141](background/agent-port.ts#L100-L141) 的 `port.onMessage.addListener(async (raw) => { ... });` 整块替换为：

```ts
    port.onMessage.addListener(async (raw) => {
      const msg = raw as PortMsgFromPanel;
      console.log('[agent-port] 收到消息', msg.type, (msg as { convId?: string }).convId);

      if (msg.type === 'agent:stop') {
        stopConv(msg.convId);
        return;
      }

      // 手动压缩：与运行中 loop 互斥（避免并发改会话）
      if (msg.type === 'agent:compact') {
        if (runningConvs.has(msg.convId)) {
          safePost({ type: 'error', message: '任务运行中，无法压缩，请等待完成后再试' });
          return;
        }
        const provider = await buildProviderFromSettings().catch(() => null);
        if (!provider) {
          safePost({ type: 'error', message: '请先在设置页配置 AI 服务（Base URL + 模型）' });
          return;
        }
        safePost({ type: 'compact-start' });
        const r = await compactConversation(msg.convId, { provider }).catch((e) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }));
        if (r.ok && r.newPromptTokens != null) safePost({ type: 'usage', promptTokens: r.newPromptTokens });
        if (!r.ok) safePost({ type: 'error', message: `压缩失败：${r.error ?? '未知错误'}` });
        safePost({ type: 'compact-done', newPromptTokens: r.ok ? r.newPromptTokens : undefined });
        return;
      }

      if (msg.type !== 'agent:start' && msg.type !== 'agent:resume') return;
      if (runningConvs.has(msg.convId)) {
        safePost({ type: 'error', message: '该会话已有任务在运行，请等待完成或停止后再试' });
        return;
      }
      const provider = await buildProviderFromSettings().catch((e) => {
        console.warn('[agent-port] buildProvider 失败', e);
        return null;
      });
      if (!provider) {
        safePost({ type: 'error', message: '请先在设置页配置 AI 服务（Base URL + 模型）' });
        return;
      }
      const deps = makeDeps(provider, msg.convId, port);
      const ac = new AbortController();
      runningConvs.set(msg.convId, ac);
      try {
        if (msg.type === 'agent:start') {
          await runAgentLoop({ convId: msg.convId, tabId: msg.tabId, userMessage: msg.userMessage }, deps, ac.signal);
        } else {
          await resumeAgentLoop(msg.convId, msg.tabId, deps, ac.signal);
        }
      } catch (err) {
        console.error('[agent-port] loop 抛错', err);
        safePost({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      } finally {
        runningConvs.delete(msg.convId);
      }
    });
```

- [ ] **Step 5: 编译确认**

Run: `npm run compile`
Expected: agent-port.ts 无报错。若 `entrypoints/background.ts` 仍引用 `stopTab` 等旧符号则报错 → Task 9b 修。

- [ ] **Step 6: Commit**

```bash
git add background/agent-port.ts
git commit -m "feat: 后台按 convId 闸门 + 注入 getContextWindow/compact + agent:compact 处理"
```

---

## Task 9b: 旧会话 key 清理（`entrypoints/background.ts`）

Phase 1 骨架期旧 `session:{tabId}` 数据直接弃用：安装/更新时一次性清除。

**Files:**
- Modify: `entrypoints/background.ts:32-34`

- [ ] **Step 1: 加清理函数并在 onInstalled 调用**

把 [entrypoints/background.ts:32-34](entrypoints/background.ts#L32-L34) 的 `onInstalled` 块替换为：

```ts
  browser.runtime.onInstalled.addListener(async () => {
    browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
    // 弃用旧的按标签页会话（local:session:{tabId}）——WXT 存储裸 key 为 'session:{tabId}'
    try {
      const all = await browser.storage.local.get(null);
      const stale = Object.keys(all).filter((k) => k.startsWith('session:'));
      if (stale.length) await browser.storage.local.remove(stale);
    } catch { /* 清理失败不阻断启动 */ }
  });
```

- [ ] **Step 2: 编译 + 全量测试确认无回归**

Run: `npm run compile && npm run test`
Expected: compile 退出码 0；测试全绿（此时 sessions.test.ts 尚在——下一步删）。

- [ ] **Step 3: 删除弃用的 sessions 存储与测试**

```bash
git rm storage/sessions.ts tests/storage/sessions.test.ts
```

若 `npm run compile` 报有文件仍 import `storage/sessions`，改指 `storage/conversations` 的对应函数（当前仅 loop.ts 与 ChatView.ts 引用，均已在其他任务改造）。

- [ ] **Step 4: 再次编译 + 测试**

Run: `npm run compile && npm run test`
Expected: 均通过。

- [ ] **Step 5: Commit**

```bash
git add entrypoints/background.ts storage/sessions.ts tests/storage/sessions.test.ts
git commit -m "chore: 弃用按标签页会话存储 + 安装时清理旧 session key"
```

---

## Task 10: chat store 扩展（`stores/chat.ts`）

`ChatItem` 加 `usage`；state 加 `promptTokens`/`compacting`；`applyEvent` 处理 `usage`/`compact-start`/`compact-done`；`reset` 清理新字段。

**Files:**
- Modify: `stores/chat.ts`
- Test: `tests/stores/chat.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/stores/chat.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useChat } from '../../stores/chat';

describe('chat store 新分支', () => {
  beforeEach(() => useChat.getState().reset());

  it('usage 事件：更新 promptTokens 且挂到最后一条 assistant 项', () => {
    const s = useChat.getState();
    s.applyEvent({ type: 'text-delta', text: '回答' });
    s.applyEvent({ type: 'usage', promptTokens: 8000, completionTokens: 120 });
    const st = useChat.getState();
    expect(st.promptTokens).toBe(8000);
    const last = st.messages[st.messages.length - 1]!;
    expect(last.role).toBe('assistant');
    expect(last.usage).toEqual({ prompt: 8000, completion: 120 });
  });

  it('compact-start / compact-done 切换 compacting 并回落 promptTokens', () => {
    const s = useChat.getState();
    s.applyEvent({ type: 'usage', promptTokens: 100000 });
    s.applyEvent({ type: 'compact-start' });
    expect(useChat.getState().compacting).toBe(true);
    s.applyEvent({ type: 'compact-done', newPromptTokens: 3000 });
    const st = useChat.getState();
    expect(st.compacting).toBe(false);
    expect(st.promptTokens).toBe(3000);
  });

  it('compact-done 无 newPromptTokens 时只关 compacting，不动 promptTokens', () => {
    const s = useChat.getState();
    s.applyEvent({ type: 'usage', promptTokens: 100000 });
    s.applyEvent({ type: 'compact-start' });
    s.applyEvent({ type: 'compact-done' });
    const st = useChat.getState();
    expect(st.compacting).toBe(false);
    expect(st.promptTokens).toBe(100000);
  });

  it('reset 清空 promptTokens/compacting', () => {
    const s = useChat.getState();
    s.applyEvent({ type: 'usage', promptTokens: 5000 });
    s.applyEvent({ type: 'compact-start' });
    s.reset();
    const st = useChat.getState();
    expect(st.promptTokens).toBeUndefined();
    expect(st.compacting).toBe(false);
    expect(st.messages).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test -- stores/chat`
Expected: FAIL（promptTokens/compacting 未定义）

- [ ] **Step 3: 改 `ChatItem`（加 usage）**

在 [stores/chat.ts:17](stores/chat.ts#L17) 的 `image?: string;` 之后加：

```ts
  usage?: { prompt?: number; completion?: number }; // 该轮 token 用量（消息下方标注）
```

- [ ] **Step 4: 改 `ChatState` 接口 + 初始值 + reset**

在 [stores/chat.ts:20-30](stores/chat.ts#L20-L30) 的 `ChatState` 接口里，`pauseReason?: string;` 之后加两行：

```ts
  promptTokens?: number;   // 当前会话最近一轮真实发出的 token（环形指示器分子）
  compacting: boolean;     // 是否正在压缩
```

把 [stores/chat.ts:46-48](stores/chat.ts#L46-L48) 的 store 初始字段（`messages: [], status: 'idle',`）改为：

```ts
  messages: [],
  status: 'idle',
  compacting: false,
```

把 `reset` 的实现（[stores/chat.ts:104](stores/chat.ts#L104)）改为：

```ts
  reset: () => set({ messages: [], status: 'idle', pauseReason: undefined, promptTokens: undefined, compacting: false }),
```

- [ ] **Step 5: 在 `applyEvent` 的 switch 里加三个 case**

在 [stores/chat.ts:141](stores/chat.ts#L141) 的 `case 'state': return { status: e.status };` 之后插入：

```ts
      case 'usage': {
        // 挂到最后一条 assistant 项（供消息下方标注）；同时更新环的分子
        const idx = [...messages].reverse().findIndex((m) => m.role === 'assistant');
        if (idx >= 0) {
          const real = messages.length - 1 - idx;
          messages[real] = { ...messages[real]!, usage: { prompt: e.promptTokens, completion: e.completionTokens } };
        }
        return { messages, promptTokens: e.promptTokens ?? s.promptTokens };
      }
      case 'compact-start':
        return { compacting: true };
      case 'compact-done':
        return { compacting: false, promptTokens: e.newPromptTokens ?? s.promptTokens };
```

- [ ] **Step 6: 运行测试确认通过**

Run: `npm run test -- stores/chat`
Expected: PASS（4 用例）

- [ ] **Step 7: Commit**

```bash
git add stores/chat.ts tests/stores/chat.test.ts
git commit -m "feat: chat store 支持 usage/compact 事件 + 每轮 token + promptTokens/compacting 状态"
```

---

## Task 11: 会话列表 store（`stores/conversations.ts`）

管理当前会话 id、列表、下拉开合。默认新会话用「客户端草稿 id」——不落库，首条消息发出时 loop 的 appendMessage 才建档（避免空会话污染列表）。

**Files:**
- Create: `stores/conversations.ts`
- Test: `tests/stores/conversations.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/stores/conversations.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { useConversations } from '../../stores/conversations';
import { useChat } from '../../stores/chat';
import { createConversation, appendMessage, setLastPromptTokens } from '../../storage/conversations';

describe('conversations store', () => {
  beforeEach(async () => { fakeBrowser.reset(); useChat.getState().reset(); });

  it('newConversation 设新草稿 id、清空 chat、不写 index', async () => {
    await useConversations.getState().newConversation();
    const st = useConversations.getState();
    expect(st.currentId).toBeTruthy();
    expect(useChat.getState().messages).toEqual([]);
    expect(st.list).toEqual([]); // 草稿未落库
  });

  it('switchTo 载入目标会话消息 + promptTokens', async () => {
    const c = await createConversation();
    await appendMessage(c.id, { role: 'user', content: '历史消息' });
    await setLastPromptTokens(c.id, 4321);
    await useConversations.getState().refreshList();
    await useConversations.getState().switchTo(c.id);
    expect(useConversations.getState().currentId).toBe(c.id);
    expect(useChat.getState().messages.some((m) => m.text === '历史消息')).toBe(true);
    expect(useChat.getState().promptTokens).toBe(4321);
  });

  it('remove 当前会话且尚有其他 → 切到最近一条', async () => {
    const a = await createConversation();
    await appendMessage(a.id, { role: 'user', content: 'A' });
    const b = await createConversation();
    await appendMessage(b.id, { role: 'user', content: 'B' });
    await useConversations.getState().switchTo(a.id);
    await useConversations.getState().remove(a.id);
    // b 更近（后建/后更新）→ 成为当前
    expect(useConversations.getState().currentId).toBe(b.id);
  });

  it('remove 当前会话且无其他 → 开新草稿', async () => {
    const a = await createConversation();
    await appendMessage(a.id, { role: 'user', content: 'A' });
    await useConversations.getState().switchTo(a.id);
    await useConversations.getState().remove(a.id);
    const st = useConversations.getState();
    expect(st.currentId).toBeTruthy();
    expect(st.currentId).not.toBe(a.id);
    expect(st.list).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test -- stores/conversations`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// stores/conversations.ts
// 会话列表 UI 状态（设计 §2.4）。当前会话切换协调 chat store（storage 是历史的权威源）。
import { create } from 'zustand';
import { nanoid } from 'nanoid';
import {
  listConversations, getConversation, renameConversation, deleteConversation,
  type ConversationMeta,
} from '../storage/conversations';
import { useChat } from './chat';

interface ConvState {
  currentId: string | null;
  list: ConversationMeta[];
  menuOpen: boolean;
  refreshList: () => Promise<void>;
  newConversation: () => Promise<void>;
  switchTo: (id: string) => Promise<void>;
  rename: (id: string, title: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  setMenuOpen: (open: boolean) => void;
}

export const useConversations = create<ConvState>((set, get) => ({
  currentId: null,
  list: [],
  menuOpen: false,

  refreshList: async () => set({ list: await listConversations() }),

  // 新会话 = 客户端草稿 id（不落库）。首条消息发出后由 loop 的 appendMessage 建档。
  newConversation: async () => {
    useChat.getState().reset();
    set({ currentId: nanoid(), menuOpen: false });
  },

  switchTo: async (id) => {
    const conv = await getConversation(id);
    useChat.getState().loadFromStorage(conv.messages);
    useChat.setState({ promptTokens: conv.lastPromptTokens, status: conv.status });
    set({ currentId: id, menuOpen: false });
  },

  rename: async (id, title) => {
    await renameConversation(id, title);
    await get().refreshList();
  },

  remove: async (id) => {
    await deleteConversation(id);
    await get().refreshList();
    if (get().currentId === id) {
      const list = get().list;
      if (list.length > 0) await get().switchTo(list[0]!.id);
      else await get().newConversation();
    }
  },

  setMenuOpen: (menuOpen) => set({ menuOpen }),
}));
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run test -- stores/conversations`
Expected: PASS（4 用例）

- [ ] **Step 5: Commit**

```bash
git add stores/conversations.ts tests/stores/conversations.test.ts
git commit -m "feat: 会话列表 store（草稿新会话不落库 + 切换/重命名/删除协调 chat store）"
```

---

## Task 12: 环形上下文指示器（`components/chat/ContextRing.tsx`）

SVG 环 + hover tooltip + 点击压缩。展示态由 props 决定，颜色档位复用 `meterZone`。dashOffset 计算抽成纯函数以便测试。

**Files:**
- Create: `components/chat/ContextRing.tsx`
- Test: `tests/chat/context-ring.test.ts`

- [ ] **Step 1: 写失败测试（纯计算）**

```ts
// tests/chat/context-ring.test.ts
import { describe, it, expect } from 'vitest';
import { dashOffset, RING_CIRCUMFERENCE } from '../../components/chat/ContextRing';

describe('ContextRing dashOffset', () => {
  it('ratio 0 → 全空（offset = 周长）', () => {
    expect(dashOffset(0)).toBeCloseTo(RING_CIRCUMFERENCE);
  });
  it('ratio 1 → 全满（offset = 0）', () => {
    expect(dashOffset(1)).toBeCloseTo(0);
  });
  it('ratio 0.5 → 半满', () => {
    expect(dashOffset(0.5)).toBeCloseTo(RING_CIRCUMFERENCE / 2);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test -- context-ring`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```tsx
// components/chat/ContextRing.tsx
// 环形上下文指示器 = 压缩按钮（设计 §3.2）。颜色即信息：normal/warn/danger 分档。
import { Loader2 } from 'lucide-react';
import { meterRatio, meterZone } from '../../agent/context-meter';

const R = 11;                       // 半径（配 28px 外框）
export const RING_CIRCUMFERENCE = 2 * Math.PI * R;

/** 已填充比例 → stroke-dashoffset（0=满，周长=空）。 */
export function dashOffset(ratio: number): number {
  return RING_CIRCUMFERENCE * (1 - ratio);
}

export function ContextRing({
  used, window, compacting, disabled, onCompact,
}: {
  used?: number;
  window: number;
  compacting: boolean;
  disabled: boolean;
  onCompact: () => void;
}) {
  const ratio = meterRatio(used, window);
  const zone = meterZone(ratio);
  const pct = Math.round(ratio * 100);
  const usedText = used != null ? `${(used / 1000).toFixed(0)}k` : '—';
  const winText = `${(window / 1000).toFixed(0)}k`;
  const tip = used != null
    ? `上下文 ${pct}% · ${usedText}/${winText} tokens · 点击压缩历史`
    : `上限 ${winText} · 点击压缩`;

  return (
    <button
      type="button"
      className={`ctxring ctxring--${zone}${disabled ? ' ctxring--disabled' : ''}`}
      title={tip}
      aria-label={tip}
      disabled={disabled || compacting}
      onClick={onCompact}
    >
      {compacting ? (
        <Loader2 size={16} className="spin" />
      ) : (
        <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden>
          <circle className="ctxring__track" cx="14" cy="14" r={R} fill="none" strokeWidth="2.5" />
          <circle
            className="ctxring__fill"
            cx="14" cy="14" r={R} fill="none" strokeWidth="2.5"
            strokeLinecap="round"
            strokeDasharray={RING_CIRCUMFERENCE}
            strokeDashoffset={dashOffset(ratio)}
            transform="rotate(-90 14 14)"
          />
        </svg>
      )}
    </button>
  );
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run test -- context-ring`
Expected: PASS（3 用例）

- [ ] **Step 5: 编译确认**

Run: `npm run compile`
Expected: 0（样式类 .ctxring 在 Task 15 补，不影响编译）。

- [ ] **Step 6: Commit**

```bash
git add components/chat/ContextRing.tsx tests/chat/context-ring.test.ts
git commit -m "feat: 环形上下文指示器组件（SVG 环 + 档位色 + hover 详情 + 点击压缩）"
```

---

## Task 13: 会话下拉抽屉（`components/chat/ConversationMenu.tsx`）

顶部下拉浮层：新建 + 列表（标题/相对时间/运行点）+ 行内重命名 + 删除。相对时间抽纯函数测试。

**Files:**
- Create: `components/chat/ConversationMenu.tsx`
- Test: `tests/chat/relative-time.test.ts`

- [ ] **Step 1: 写失败测试（相对时间纯函数）**

```ts
// tests/chat/relative-time.test.ts
import { describe, it, expect } from 'vitest';
import { relativeTime } from '../../components/chat/ConversationMenu';

describe('relativeTime', () => {
  const now = 1_000_000_000_000;
  it('刚刚（<60s）', () => { expect(relativeTime(now - 5_000, now)).toBe('刚刚'); });
  it('分钟', () => { expect(relativeTime(now - 5 * 60_000, now)).toBe('5 分钟前'); });
  it('小时', () => { expect(relativeTime(now - 3 * 3600_000, now)).toBe('3 小时前'); });
  it('天', () => { expect(relativeTime(now - 2 * 86400_000, now)).toBe('2 天前'); });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test -- relative-time`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现（第一段：相对时间 + 组件骨架）**

```tsx
// components/chat/ConversationMenu.tsx
// 会话下拉抽屉（设计 §2.2）：新建 + 列表 + 行内重命名 + 删除。
import { useState } from 'react';
import { SquarePen, Trash2, Check, X } from 'lucide-react';
import { useConversations } from '../../stores/conversations';

/** 相对时间（中文）。now 可注入便于测试。 */
export function relativeTime(ts: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return '刚刚';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

export function ConversationMenu() {
  const { list, currentId, menuOpen, setMenuOpen, newConversation, switchTo, rename, remove } = useConversations();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  if (!menuOpen) return null;

  const startRename = (id: string, title: string) => { setEditingId(id); setDraft(title); };
  const commitRename = async (id: string) => { await rename(id, draft); setEditingId(null); };

  return (
    <>
      <div className="convmenu__scrim" onClick={() => setMenuOpen(false)} aria-hidden />
      <div className="convmenu rise" role="menu" aria-label="会话列表">
        <button className="convmenu__new" onClick={() => void newConversation()}>
          <SquarePen size={14} />
          <span>新建会话</span>
        </button>
        <div className="convmenu__list">
          {list.length === 0 && <div className="convmenu__empty">还没有历史会话</div>}
          {list.map((c) => (
            <div key={c.id} className={`convrow${c.id === currentId ? ' convrow--active' : ''}`}>
              {editingId === c.id ? (
                <div className="convrow__edit">
                  <input
                    className="input"
                    value={draft}
                    autoFocus
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void commitRename(c.id); if (e.key === 'Escape') setEditingId(null); }}
                  />
                  <button className="convrow__iconbtn" aria-label="确定" onClick={() => void commitRename(c.id)}><Check size={13} /></button>
                  <button className="convrow__iconbtn" aria-label="取消" onClick={() => setEditingId(null)}><X size={13} /></button>
                </div>
              ) : (
                <>
                  <button className="convrow__main" onClick={() => void switchTo(c.id)}>
                    {c.status === 'running' && <span className="dot dot--running" />}
                    <span className="convrow__title">{c.title}</span>
                    <span className="convrow__time mono">{relativeTime(c.updatedAt)}</span>
                  </button>
                  <div className="convrow__actions">
                    <button className="convrow__iconbtn" aria-label="重命名" onClick={() => startRename(c.id, c.title)}><SquarePen size={13} /></button>
                    <button className="convrow__iconbtn" aria-label="删除" onClick={() => void remove(c.id)}><Trash2 size={13} /></button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
```

- [ ] **Step 4: 运行测试 + 编译确认**

Run: `npm run test -- relative-time && npm run compile`
Expected: 测试 4 用例 PASS；compile 0（.convmenu 样式 Task 15 补）。

- [ ] **Step 5: Commit**

```bash
git add components/chat/ConversationMenu.tsx tests/chat/relative-time.test.ts
git commit -m "feat: 会话下拉抽屉（新建/列表/行内重命名/删除 + 相对时间）"
```

---

## Task 14: ChatView 整合（`components/chat/ChatView.tsx`）

默认新会话、页眉会话切换入口、输入框接环、按 convId 发消息、每轮 token 标注。整份替换（分 4 步拼接）。

**Files:**
- Modify: `components/chat/ChatView.tsx`（整份替换）

- [ ] **Step 1: 替换 import + 组件顶部到 `ensurePort`（文件第 1 段）**

用下面内容替换 [components/chat/ChatView.tsx:1-38](components/chat/ChatView.tsx#L1-L38)：

```tsx
// components/chat/ChatView.tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { Send, Wrench, CircleAlert, Loader2, Check, X, ChevronRight, ChevronDown, Brain, Square, SquarePen, ArrowUp, ArrowDown } from 'lucide-react';
import { PageShell } from '../ui/PageShell';
import { Button } from '../ui/Button';
import { Gauge } from '../ui/Gauge';
import { ContextRing } from './ContextRing';
import { ConversationMenu } from './ConversationMenu';
import { useChat, type ChatItem } from '../../stores/chat';
import { useConversations } from '../../stores/conversations';
import { getSettings } from '../../storage/settings';
import { resolveContextWindow, DEFAULT_CONTEXT_WINDOW } from '../../agent/model-windows';
import type { PortMsgFromPanel, PortMsgToPanel } from '../../shared/messages';

export function ChatView() {
  const { messages, status, pauseReason, applyEvent, promptTokens, compacting } = useChat();
  const { currentId, list, menuOpen, setMenuOpen } = useConversations();
  const [input, setInput] = useState('');
  const [contextWindow, setContextWindow] = useState(DEFAULT_CONTEXT_WINDOW);
  const portRef = useRef<ReturnType<typeof browser.runtime.connect> | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const ensurePort = useCallback(() => {
    if (portRef.current) return portRef.current;
    const port = browser.runtime.connect({ name: 'agent' });
    port.onMessage.addListener((m) => applyEvent(m as PortMsgToPanel));
    port.onDisconnect.addListener(() => {
      void browser.runtime.lastError;
      portRef.current = null;
    });
    portRef.current = port;
    return port;
  }, [applyEvent]);
```

- [ ] **Step 2: 替换「滚动 effect + 挂载恢复 effect + activeTabId + postToPort」（文件第 2 段）**

用下面内容替换原 [components/chat/ChatView.tsx:40-85](components/chat/ChatView.tsx#L40-L85)：

```tsx
  useEffect(() => {
    ensurePort();
    return () => { portRef.current?.disconnect(); portRef.current = null; };
  }, [ensurePort]);

  const last = messages[messages.length - 1];
  const scrollKey = `${messages.length}:${last?.text?.length ?? 0}:${last?.reasoning?.length ?? 0}:${last?.status ?? ''}`;
  const firstScroll = useRef(true);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: firstScroll.current ? 'auto' : 'smooth' });
    firstScroll.current = false;
  }, [scrollKey]);

  // 挂载：默认开一个新会话（草稿，不落库）+ 载入会话列表 + 读上下文窗口。
  useEffect(() => {
    void useConversations.getState().refreshList();
    void useConversations.getState().newConversation();
    void getSettings().then((s) => setContextWindow(resolveContextWindow(s.provider.model, s.provider.contextWindow)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function activeTabId(): Promise<number | undefined> {
    let [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab) [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    return tab?.id;
  }

  const postToPort = (msg: PortMsgFromPanel): boolean => {
    try { ensurePort().postMessage(msg); return true; }
    catch {
      portRef.current = null;
      applyEvent({ type: 'error', message: '与后台的连接已断开，请重试（若持续，请重新加载扩展）' });
      return false;
    }
  };
```

- [ ] **Step 3: 替换「send/resume/stop + 新增 compact」+ 页眉 return 开头（文件第 3 段）**

用下面内容替换从 `const send = async () => {`（原 [components/chat/ChatView.tsx:87](components/chat/ChatView.tsx#L87)）起、到 `<div className="chat__log">`（原第 124 行，**含此行**）为止的连续区块。**边界务必止于 `<div className="chat__log">` 这一行**——其后的空态块、`{messages.map(...)}`、pausebar、`endRef` 保持不动：

```tsx
  const send = async () => {
    const text = input.trim();
    if (!text || status === 'running' || compacting) return;
    const convId = currentId;
    if (!convId) return;
    useChat.getState().setStatus('running');
    const tabId = await activeTabId();
    if (tabId == null) {
      useChat.getState().setStatus('idle');
      applyEvent({ type: 'error', message: '无法获取当前标签页，请先切到一个普通网页标签再试' });
      return;
    }
    useChat.getState().addUserMessage(text);
    setInput('');
    postToPort({ type: 'agent:start', convId, tabId, userMessage: text });
    // 首条消息发出后会话落库 → 刷新列表让其出现在下拉里
    void useConversations.getState().refreshList();
  };

  const resume = async () => {
    if (!currentId) return;
    const tabId = await activeTabId();
    if (tabId == null) return;
    useChat.getState().setStatus('running');
    postToPort({ type: 'agent:resume', convId: currentId, tabId });
  };

  const stop = async () => {
    if (!currentId) return;
    useChat.getState().setStatus('idle');
    postToPort({ type: 'agent:stop', convId: currentId });
  };

  const compact = () => {
    if (!currentId || compacting || status === 'running') return;
    postToPort({ type: 'agent:compact', convId: currentId });
  };

  const title = list.find((c) => c.id === currentId)?.title ?? '新会话';
  const lastIdx = messages.length - 1;

  return (
    <PageShell
      title={title}
      eyebrow="AGENT"
      right={<Gauge state={status} />}
      actions={
        <>
          <Button variant="ghost" aria-label="新建会话" onClick={() => void useConversations.getState().newConversation()}>
            <SquarePen size={16} />
          </Button>
          <Button variant="ghost" aria-label="会话列表" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>
            <ChevronDown size={16} />
          </Button>
        </>
      }
    >
      <div className="chat">
        <ConversationMenu />
        <div className="chat__log">
```

- [ ] **Step 4: 替换「输入 dock」（文件第 4 段：原 `.dock` 块 [components/chat/ChatView.tsx:145-164](components/chat/ChatView.tsx#L145-L164)）**

用下面内容替换原 `<div className="dock"> … </div>`：

```tsx
        <div className="dock">
          <textarea
            className="textarea"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
            placeholder={compacting ? '压缩中…' : status === 'running' ? 'AI 执行中…' : '输入指令…'}
            disabled={status === 'running' || compacting}
            rows={2}
          />
          <div className="dock__controls">
            <ContextRing
              used={promptTokens}
              window={contextWindow}
              compacting={compacting}
              disabled={messages.length === 0 || status === 'running'}
              onCompact={compact}
            />
            {status === 'running' ? (
              <Button variant="signal" className="dock__send" onClick={stop} aria-label="停止">
                <Square size={15} fill="currentColor" />
              </Button>
            ) : (
              <Button variant="signal" className="dock__send" onClick={send} aria-label="发送">
                <Send size={16} />
              </Button>
            )}
          </div>
        </div>
```

（`MessageRow`/`ReasoningBlock`/`formatArgs` 暂不动，下一步单独给 MessageRow 加 token 标注。）

- [ ] **Step 5: 编译确认**

Run: `npm run compile`
Expected: 0（.dock__controls 样式 Task 15 补）。

- [ ] **Step 6: Commit**

```bash
git add components/chat/ChatView.tsx
git commit -m "feat: ChatView 默认新会话 + 页眉会话入口 + 按 convId 发消息 + 输入框接环"
```

---

## Task 15: 每轮 token 标注（`ChatView.tsx` MessageRow）

assistant 消息下方渲染 `↑输入 ↓输出` 极小标注。

**Files:**
- Modify: `components/chat/ChatView.tsx`（MessageRow assistant 分支）

- [ ] **Step 1: 在 assistant 分支加 token 标注**

在 MessageRow 的 assistant 分支（原 [components/chat/ChatView.tsx:184-194](components/chat/ChatView.tsx#L184-L194)），把 `item.text != null && (...)` 之后、外层 `</div>` 之前插入 token 标注。整段 assistant 分支替换为：

```tsx
  if (item.role === 'assistant') {
    return (
      <div className="rise">
        {item.reasoning != null && (
          <ReasoningBlock item={item} onToggle={() => toggleExpand(index)} />
        )}
        {item.text != null && (
          <div className={`msg-assistant${streaming && !item.thinking ? ' caret' : ''}`}>{item.text}</div>
        )}
        {item.usage && (item.usage.prompt != null || item.usage.completion != null) && (
          <div className="msg-usage mono">
            {item.usage.prompt != null && (<><ArrowUp size={10} />{formatTokens(item.usage.prompt)}</>)}
            {item.usage.completion != null && (<><ArrowDown size={10} />{formatTokens(item.usage.completion)}</>)}
          </div>
        )}
      </div>
    );
  }
```

- [ ] **Step 2: 在文件底部加 `formatTokens` 辅助函数**

在 `formatArgs` 函数（文件末尾）之后追加：

```tsx
/** token 数格式化：>=1000 显示 xk，否则原样。 */
function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
```

- [ ] **Step 3: 编译确认**

Run: `npm run compile`
Expected: 0。

- [ ] **Step 4: Commit**

```bash
git add components/chat/ChatView.tsx
git commit -m "feat: assistant 消息下方每轮 token 标注（↑输入 ↓输出）"
```

---

## Task 16: 样式（`entrypoints/sidepanel/styles.css`）

补 `.ctxring`、`.convmenu`/`.convrow`、`.dock__controls`、`.msg-usage` 样式，走 CSS 变量，动效带 reduced-motion 兜底。

**Files:**
- Modify: `entrypoints/sidepanel/styles.css`（追加到「会话」段落之后）

- [ ] **Step 1: 追加环形指示器样式**

在 styles.css 末尾追加：

```css
/* ============ 环形上下文指示器 ============ */
.dock__controls { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.ctxring {
  width: 28px; height: 28px; padding: 0;
  border: none; background: transparent; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center;
  color: var(--ink-3); border-radius: 50%;
  transition: color var(--t-fast) var(--ease), background var(--t-fast) var(--ease);
}
.ctxring:hover:not(:disabled) { background: var(--sunken); }
.ctxring:focus-visible { outline: 2px solid var(--signal); outline-offset: 1px; }
.ctxring:disabled { cursor: default; opacity: 0.55; }
.ctxring__track { stroke: var(--line-strong); }
.ctxring__fill { stroke: var(--ink-3); transition: stroke-dashoffset var(--t-mid) var(--ease), stroke var(--t-fast) var(--ease); }
.ctxring--warn .ctxring__fill { stroke: var(--warn); }
.ctxring--warn:not(.ctxring--disabled) { animation: pulse 1.6s var(--ease) infinite; }
.ctxring--danger .ctxring__fill { stroke: var(--err); }

/* ============ 每轮 token 标注 ============ */
.msg-usage {
  display: inline-flex; align-items: center; gap: 2px;
  margin-top: 3px; font-size: 10px; color: var(--ink-3);
}
.msg-usage > svg { margin-left: 6px; }
.msg-usage > svg:first-child { margin-left: 0; }
```

- [ ] **Step 2: 追加下拉抽屉样式**

在 styles.css 末尾追加：

```css
/* ============ 会话下拉抽屉 ============ */
.chat { position: relative; }
.convmenu__scrim { position: absolute; inset: 0; z-index: 10; }
.convmenu {
  position: absolute; z-index: 11; top: 0; left: 0; right: 0;
  max-height: 60%; overflow: auto;
  background: var(--surface); border: 1px solid var(--line-strong);
  border-radius: var(--r-md); box-shadow: 0 8px 24px rgba(0,0,0,0.12);
}
.convmenu__new {
  width: 100%; display: flex; align-items: center; gap: 8px;
  padding: 10px 12px; border: none; border-bottom: 1px solid var(--line);
  background: transparent; color: var(--ink); cursor: pointer; font-family: var(--sans); font-size: 13px;
}
.convmenu__new:hover { background: var(--sunken); }
.convmenu__empty { padding: 14px 12px; color: var(--ink-3); font-size: 12px; }
.convrow { display: flex; align-items: center; }
.convrow--active { background: var(--signal-wash); }
.convrow__main {
  flex: 1; min-width: 0; display: flex; align-items: center; gap: 7px;
  padding: 9px 12px; border: none; background: transparent; cursor: pointer;
  font-family: var(--sans); font-size: 13px; color: var(--ink); text-align: left;
}
.convrow__main:hover { background: var(--sunken); }
.convrow__title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.convrow__time { font-size: 10px; color: var(--ink-3); flex-shrink: 0; }
.convrow__actions { display: none; gap: 2px; padding-right: 8px; }
.convrow:hover .convrow__actions { display: flex; }
.convrow__edit { flex: 1; display: flex; align-items: center; gap: 4px; padding: 5px 8px; }
.convrow__iconbtn {
  border: none; background: transparent; color: var(--ink-3); cursor: pointer;
  padding: 4px; border-radius: var(--r-sm); display: inline-flex;
}
.convrow__iconbtn:hover { background: var(--line-strong); color: var(--ink); }
```

- [ ] **Step 2b: reduced-motion 兜底补充**

确认 [styles.css:261-264](entrypoints/sidepanel/styles.css#L261-L264) 的 `@media (prefers-reduced-motion: reduce)` 块已用 `*` 通配覆盖 animation/transition——`.ctxring--warn` 的 pulse 与 `.ctxring__fill` 过渡自动被兜底，无需额外规则。

- [ ] **Step 3: 构建确认样式无语法错**

Run: `npm run build`
Expected: 退出码 0（lightningcss 解析全部 CSS 通过）。

- [ ] **Step 4: Commit**

```bash
git add entrypoints/sidepanel/styles.css
git commit -m "style: 环形指示器 + 会话下拉抽屉 + 每轮 token 标注样式"
```

---

## Task 17: 全量验证 + 手测清单

**Files:** 无改动（验证任务）

- [ ] **Step 1: 全量编译 + 单测**

Run: `npm run compile && npm run test`
Expected: compile 退出码 0；测试全绿（model-windows / context-meter / conversations / context / compact / loop / stores/chat / stores/conversations / context-ring / relative-time）。

- [ ] **Step 2: 生产构建**

Run: `npm run build`
Expected: 退出码 0；`.output/chrome-mv3/manifest.json` 生成正常。

- [ ] **Step 3: 手测清单（加载扩展后逐项验证）**

在 Chrome 加载 `.output/chrome-mv3`，打开侧边栏逐项验证：

- [ ] 打开侧边栏默认是空的新会话（非上次历史）。
- [ ] 点页眉 `▾` 展开下拉：显示历史会话；点条目切换；切换后消息与占比正确载入。
- [ ] 点 `新建` 图标：清空回到新会话。
- [ ] 行内重命名生效；删除当前会话后自动切到最近一条（无则新草稿）。
- [ ] 发消息后该会话出现在下拉列表，标题取首条消息前 30 字。
- [ ] 会话隔离：A 会话历史在 B 会话不可见。
- [ ] 环形指示器：随 usage 更新占比；hover 显示 `上下文 x% · used/win tokens · 点击压缩历史`。
- [ ] 占比 ≥80% 环变警示色 + 脉冲；≥95% 变红。
- [ ] 点环触发压缩：环转 loading → 完成后占比明显回落。
- [ ] 达 80% 阈值时自动压缩（长对话跑到阈值观察）。
- [ ] 运行中环禁用、无法手动压缩；压缩中输入框禁用。
- [ ] 每条 assistant 消息下方显示 `↑输入 ↓输出` token 标注。
- [ ] 设置页「上下文窗口」留空时占位显示模型推断值；手填后环分母随之变化。
- [ ] `prefers-reduced-motion` 开启时环脉冲静止（系统偏好模拟）。

- [ ] **Step 4: 更新 CLAUDE.md 阶段说明 + Commit**

在 `CLAUDE.md` 的「当前阶段」补一条本次交付摘要（多会话管理 + 输入框重构 + 上下文压缩），然后：

```bash
git add CLAUDE.md
git commit -m "docs: CLAUDE.md 记录多会话 + 上下文压缩阶段交付"
```

---

## 自审记录（写作者已核对）

- **Spec 覆盖**：§1 会话模型/存储/运行时→Task 1/3/8/9；§2 会话管理 UI→Task 11/13/14；§3 输入框重构→Task 12/14/15/16；§4 压缩→Task 2/6/7/8/9；§4.5 窗口来源→Task 1/5；§5 测试→散落各任务 + Task 17。全部有对应任务。
- **类型一致性**：`Conversation`/`ConversationMeta`（Task 3）贯穿 8/9/11；`LoopDeps.compact`/`getContextWindow`（Task 8a）与 agent-port 注入（Task 9a）签名一致；`PortMsgToPanel` 的 `usage`/`compact-start`/`compact-done`（Task 4）与 loop emit（8a）、chat store applyEvent（10）、ChatView 消费（14）一致；`compactConversation` 返回 `{ ok, newPromptTokens?, error? }`（7b）与 loop/agent-port 调用点一致。
- **占位符扫描**：无 TBD/TODO；每个代码步给出完整代码。

