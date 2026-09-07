# 系统提示词自定义 + Agent 记忆 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户在设置页用 Markdown 编辑器完整覆盖内置系统提示词，并给 agent 一个跨会话的、按站点作用域筛选注入的长期记忆池（AI 经 3 个工具自主增删改，用户可在设置页手工维护）。

**Architecture:** 两块能力共用同一条注入通道——`buildContext` 组装 system 消息处。系统提示词是 `Settings` 新增的 `prompt` 段，经 `resolveSystemPrompt` 决定用自定义还是内置常量；记忆是新的 storage 实体（单键 `local:memory:index`），经纯函数 `buildMemoryPrompt` 做三层注入（全局全文 / 当前页命中全文 / 其余站点清单）。两者都走 `LoopDeps` 的「每轮重读设置」模式，改完下一轮生效。设计文档：`docs/superpowers/specs/2026-09-07-system-prompt-and-agent-memory-design.md`。

**Tech Stack:** WXT + React 19 + TypeScript 7、Zustand、CodeMirror 6（新增 `@codemirror/lang-markdown`）、react-markdown、vitest v4 + jsdom + `wxt/testing/fake-browser`、lucide-react。

---

## 背景：这个仓库的既有约定

实施前必读，否则会写出不符合项目风格的代码：

- **测试**：`vitest`，storage 相关测试用 `import { fakeBrowser } from 'wxt/testing/fake-browser'` 并在 `beforeEach(() => fakeBrowser.reset())`。组件测试首行加 `// @vitest-environment jsdom` 注释，用 `@testing-library/react` 的 `render/screen/fireEvent` + `afterEach(cleanup)`。
- **工具返回值**：统一 `{ ok: true, data? } | { ok: false; error }` 判别联合（`shared/types.ts` 的 `ToolResult`）。
- **错误文案**：全中文、可读、点名具体原因（模型要读它来自我纠正）。
- **样式**：只改 `entrypoints/sidepanel/styles.css`，用 `:root` CSS 变量，禁止硬编码色值。复用既有工具类 `.btn` `.input` `.textarea` `.field` `.field-label` `.hint` `.well` `.token` `.switch` `.setting-card` `.scripts-card` `.scripts-toolbar` `.scripts-list` `.status-text`。
- **图标**：`lucide-react`，禁止用 emoji 代替图标。
- **二级页**：用 `PageShell` 的 `onBack` prop 渲染统一返回钮（**不要**自己在 `actions` 里塞 ChevronLeft——`SkillsPage`/`ModelSettings` 是早期写法，新页面用 `onBack`）。
- **命令**（Windows，bash shell）：
  - 跑单个测试文件：`npx vitest run tests/path/to/file.test.ts`
  - 跑单个用例：`npx vitest run tests/path/to/file.test.ts -t "用例名片段"`
  - 全量测试：`npm run test`
  - 类型检查：`npm run compile`
- **提交**：小步提交，message 用中文，格式 `type(scope): 描述`。

## 文件结构

**新建：**

| 文件 | 职责 |
|---|---|
| `agent/memory-prompt.ts` | 记忆注入的纯函数：`MemoryBrief`/`MemoryState` 类型、三层分组、半预算装箱、站点清单聚合、`memoryStateToCap` |
| `agent/tools/memory.ts` | 三个记忆工具的实现：`doMemoryList`/`doMemoryWrite`/`doMemoryDelete` |
| `storage/memory.ts` | 记忆存储层：CRUD + 上限与 match pattern 校验 |
| `components/settings/SystemPromptPage.tsx` | 系统提示词二级页：md 编辑器 + 预览 + 保存/恢复默认 |
| `components/settings/MemoryPage.tsx` | 记忆二级页：列表 ↔ 详情、两个开关、搜索、CRUD |
| `components/settings/memory-page-utils.ts` | 记忆页的纯逻辑（pattern 文本解析、列表过滤），单独可测 |
| `tests/storage/memory.test.ts` | 记忆存储层测试 |
| `tests/agent/memory-prompt.test.ts` | 三层注入 / 半预算 / 冷启动 / 只读文案 测试 |
| `tests/agent/tools/memory-tool.test.ts` | 三个工具的行为与 cap 守卫测试 |
| `tests/settings/system-prompt-page.test.tsx` | 提示词页组件测试 |
| `tests/settings/memory-page.test.tsx` | 记忆页组件测试 |
| `tests/settings/memory-page-utils.test.ts` | 记忆页纯逻辑测试 |

**修改：**

| 文件 | 改动 |
|---|---|
| `agent/context.ts` | `buildContext` 改 opts 签名；新增 `resolveSystemPrompt`；system 消息插入记忆块 |
| `agent/mode.ts` | 新增 `MemoryCap` 类型、`MEMORY_TOOLS`/`MEMORY_WRITE_TOOLS` 集合、`filterSchemasForMemory`；3 个记忆工具进 `ASK_MODE_TOOLS` |
| `agent/loop.ts` | `LoopDeps` 加 `getSystemPrompt`/`getMemoryState`；每轮读取并传给 `buildContext` 与 `getToolSchemas` |
| `agent/tools/registry.ts` | `getToolSchemas` 加 `memory` 参数；`ToolCtx` 加 `memory` 字段；记忆工具分发 + 硬闸守卫 |
| `agent/tools/schemas.ts` | 新增 3 个记忆工具 schema（27 → 30） |
| `background/agent-port.ts` | `makeDeps` 注入 `getSystemPrompt`/`getMemoryState`；`executeTool` 的 ctx 带 `memory` cap |
| `storage/settings.ts` | 新增 `prompt` 段（`PromptConfig`）；`AgentConfig` 加 `memoryEnabled`/`memoryWritable` |
| `components/detail/CodeEditor.tsx` | 新增 `language?: 'javascript' \| 'markdown'` prop |
| `components/settings/SettingsHome.tsx` | 入口卡 4 → 6（`SettingsSub` 加 `'prompt'`/`'memory'`） |
| `components/settings/SettingsView.tsx` | 二级路由加两个分支 |
| `components/debug/tool-tags.ts` | 新增 `MEMORY` tag + 分组 + chip class |
| `entrypoints/sidepanel/styles.css` | 新增 `.chip--memory`、记忆页与提示词页所需类 |
| `package.json` | 新增依赖 `@codemirror/lang-markdown` |
| `CLAUDE.md` | 记录本次能力 |

**既有断言修正**（改动会打破它们，各任务内含修正步骤）：

- `tests/agent/mode.test.ts:33-34`、`tests/agent/tools/registry.test.ts:15`、`tests/agent/tools/schemas.test.ts:5` — 硬编码工具数 27 → 30
- `tests/debug/tool-tags.test.ts:12-19,26-28` — 分组计数与组序（加 MEMORY）
- `tests/storage/settings.test.ts:44,50-53,70` — 全量对象形状（多出 `prompt` 段与两个 agent 字段）
- `tests/agent/context.test.ts:104,122,133`、`tests/agent/mode.test.ts:86`、`tests/agent/skills-context.test.ts:26-32` — `buildContext` 位置参数 → opts
- `tests/settings/settings-view.test.tsx` — 列表页入口数量

---

## Task 1: `buildContext` 改 opts 签名

纯机械重构，先做掉它，后续两块能力才有地方挂参数。现有 6 个位置参数（`history, page, keepRecent, summary, skills, mode`），再加系统提示词与记忆就是 8 个。

**Files:**
- Modify: `agent/context.ts:65-93`
- Modify: `agent/loop.ts:101`
- Modify: `tests/agent/context.test.ts:104,122,133`
- Modify: `tests/agent/mode.test.ts:86`
- Modify: `tests/agent/skills-context.test.ts:26-32`

- [ ] **Step 1: 写失败测试**

在 `tests/agent/context.test.ts` 末尾（`describe('buildContext summary 分支')` 之后）追加：

```ts
describe('buildContext opts 签名', () => {
  it('opts.summary 生效（等价于旧的第 4 位置参数）', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: 'm0' },
      { role: 'assistant', content: 'm1' },
      { role: 'user', content: 'm2' },
    ];
    const out = buildContext(history, page, { summary: { text: '前情 S', coversUpTo: 1 } });
    expect(out[0]!.role).toBe('system');
    expect(String(out[1]!.content)).toContain('前情 S');
    expect(out.slice(2)).toEqual([{ role: 'user', content: 'm2' }]);
  });

  it('opts.keepRecent 生效', () => {
    const history: ChatMessage[] = Array.from({ length: 10 }, (_, i) => ({
      role: 'user' as const, content: `m${i}`,
    }));
    const out = buildContext(history, page, { keepRecent: 2 });
    // system + 首条 + 最近 2 条
    expect(out).toHaveLength(4);
    expect(out[1]).toEqual({ role: 'user', content: 'm0' });
  });

  it('opts.mode 与 opts.skills 同时生效', () => {
    const out = buildContext([], page, {
      mode: 'ask',
      skills: [{ name: 'N', command: 'c', description: 'd' }],
    });
    const sys = String(out[0]!.content);
    expect(sys).toContain('ask（只读问答）');
    expect(sys).toContain('/c');
  });

  it('不传 opts 时行为不变（默认 keepRecent=60 / mode=agent）', () => {
    const out = buildContext([{ role: 'user', content: 'hi' }], page);
    expect(out[0]!.role).toBe('system');
    expect(String(out[0]!.content)).toContain('agent（完整操控）');
    expect(out[1]).toEqual({ role: 'user', content: 'hi' });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/agent/context.test.ts -t "opts 签名"`
Expected: FAIL — 传对象给第 3 个参数（`keepRecent: number`）会导致 `truncateMessages` 收到对象，断言不符（TS 报参数类型不匹配）。

- [ ] **Step 3: 改 `agent/context.ts` 的签名**

把 `agent/context.ts:65-93` 整段 `buildContext` 替换为：

```ts
export interface BuildContextOptions {
  /** 简单截断时保留的最近条数（无 summary 时生效）。默认 60。 */
  keepRecent?: number;
  summary?: { text: string; coversUpTo: number };
  skills?: SkillBrief[];
  mode?: AgentMode;
}

export function buildContext(
  history: ChatMessage[],
  page: PageInfo,
  opts: BuildContextOptions = {},
): ChatMessage[] {
  const { keepRecent = 60, summary, skills, mode = 'agent' } = opts;
  const pageBlock = page.url
    ? `\n\n当前页面：\n- URL: ${page.url}\n- 标题: ${page.title}`
    : '';
  const skillsBlock = buildSkillsPrompt(skills ?? []);
  const system: ChatMessage = { role: 'system', content: SYSTEM_PROMPT + pageBlock + skillsBlock + modePrompt(mode) };

  if (summary) {
    // coversUpTo 之后的原始消息为保留段；剥掉头部孤立 tool 消息（其 assistant(toolCalls)
    // 已被折进摘要，回放会因 tool_call_id 悬空 400）。摘要作为一条 user 消息置于顶部。
    // 注：summary 分支不使用 keepRecent——保留边界由压缩流程的 coversUpTo 决定。
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

- [ ] **Step 4: 改 5 处调用点**

`agent/loop.ts:101`，把

```ts
    const messages = buildContext(conv.messages, page, 60, conv.summary, skills, mode);
```

改成

```ts
    const messages = buildContext(conv.messages, page, { summary: conv.summary, skills, mode });
```

`tests/agent/context.test.ts:104`：`buildContext(history, page, 60, { text: '前情：做了 m0-m1', coversUpTo: 1 })`
→ `buildContext(history, page, { summary: { text: '前情：做了 m0-m1', coversUpTo: 1 } })`

`tests/agent/context.test.ts:122`：`buildContext(history, page, 60, { text: 's', coversUpTo: 0 })`
→ `buildContext(history, page, { summary: { text: 's', coversUpTo: 0 } })`

`tests/agent/context.test.ts:133`：`buildContext(history, page, 60, { text: 's', coversUpTo: 5 })`
→ `buildContext(history, page, { summary: { text: 's', coversUpTo: 5 } })`

`tests/agent/mode.test.ts:86`：`buildContext([], { url: 'https://x.com', title: 'X' }, 60, undefined, [], 'ask')`
→ `buildContext([], { url: 'https://x.com', title: 'X' }, { mode: 'ask' })`

`tests/agent/skills-context.test.ts:26-32`，把

```ts
    const msgs = buildContext(
      [{ role: 'user', content: 'hi' }],
      { url: 'https://x.com', title: 'X' },
      60,
      undefined,
      [{ name: 'N', command: 'c', description: 'd' }],
    );
```

改成

```ts
    const msgs = buildContext(
      [{ role: 'user', content: 'hi' }],
      { url: 'https://x.com', title: 'X' },
      { skills: [{ name: 'N', command: 'c', description: 'd' }] },
    );
```

- [ ] **Step 5: 运行测试与类型检查**

Run: `npx vitest run tests/agent/context.test.ts tests/agent/mode.test.ts tests/agent/skills-context.test.ts tests/agent/loop.test.ts`
Expected: PASS（全部）

Run: `npm run compile`
Expected: 无输出（无类型错误）

- [ ] **Step 6: 提交**

```bash
git add agent/context.ts agent/loop.ts tests/agent/context.test.ts tests/agent/mode.test.ts tests/agent/skills-context.test.ts
git commit -m "refactor(agent): buildContext 位置参数改具名 opts（为提示词与记忆腾出参数位）"
```

---

## Task 2: `Settings` 新增 `prompt` 段

**Files:**
- Modify: `storage/settings.ts:30-71`
- Modify: `tests/storage/settings.test.ts:44,50-53,70`
- Test: `tests/storage/settings.test.ts`

- [ ] **Step 1: 写失败测试**

在 `tests/storage/settings.test.ts` 末尾追加：

```ts
describe('prompt 段（系统提示词自定义）', () => {
  beforeEach(() => fakeBrowser.reset());

  it('默认 custom 为空串、无 baseSnapshot', async () => {
    const s = await getSettings();
    expect(s.prompt.custom).toBe('');
    expect(s.prompt.baseSnapshot).toBeUndefined();
  });

  it('可存可读回 custom 与 baseSnapshot', async () => {
    await saveSettings({ prompt: { custom: '我的提示词', baseSnapshot: '内置全文' } });
    const s = await getSettings();
    expect(s.prompt.custom).toBe('我的提示词');
    expect(s.prompt.baseSnapshot).toBe('内置全文');
  });

  it('段内 merge：只改 custom 不丢 baseSnapshot', async () => {
    await saveSettings({ prompt: { custom: 'A', baseSnapshot: 'S' } });
    await saveSettings({ prompt: { custom: 'B' } });
    const s = await getSettings();
    expect(s.prompt.custom).toBe('B');
    expect(s.prompt.baseSnapshot).toBe('S');
  });

  it('存量数据无 prompt 段时补默认值（前向兼容）', async () => {
    await storage.setItem('local:settings', { provider: { baseUrl: 'https://old.com/v1' } });
    const s = await getSettings();
    expect(s.prompt).toEqual({ custom: '' });
  });

  it('保存 provider 段不会清掉 prompt 段', async () => {
    await saveSettings({ prompt: { custom: '保留我' } });
    await saveSettings({ provider: { model: 'm' } });
    expect((await getSettings()).prompt.custom).toBe('保留我');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/storage/settings.test.ts -t "prompt 段"`
Expected: FAIL — `Settings` 上不存在 `prompt` 属性（TS 报错 + 运行时 `s.prompt` 为 undefined）

- [ ] **Step 3: 改 `storage/settings.ts`**

在 `AgentConfig` 定义之后（第 28 行 `}` 之后）插入：

```ts
/** 系统提示词自定义（覆盖式）。见 spec §2。 */
export interface PromptConfig {
  /** 自定义系统提示词全文。空串 = 使用内置 SYSTEM_PROMPT。 */
  custom: string;
  /** 保存自定义时的内置全文快照，用于「内置已更新」提示。 */
  baseSnapshot?: string;
}

/** 自定义提示词长度上限（字符）。页面侧拦截，不进 storage。 */
export const MAX_CUSTOM_PROMPT = 16 * 1024;
```

把 `Settings` 接口改为：

```ts
export interface Settings {
  provider: ProviderConfig;
  agent: AgentConfig;
  prompt: PromptConfig;
}
```

`DEFAULT_SETTINGS` 加一段（在 `agent: {...}` 之后）：

```ts
  prompt: { custom: '' },
```

`SettingsPatch` 改为：

```ts
export type SettingsPatch = {
  provider?: Partial<ProviderConfig>;
  agent?: Partial<AgentConfig>;
  prompt?: Partial<PromptConfig>;
};
```

`getSettings` 的返回对象加一行：

```ts
    prompt: { ...DEFAULT_SETTINGS.prompt, ...raw?.prompt },
```

`saveSettings` 的 `next` 对象加一行：

```ts
    prompt: { ...current.prompt, ...patch.prompt },
```

- [ ] **Step 4: 修正被打破的既有断言**

`tests/storage/settings.test.ts:50-53`，把

```ts
    expect(raw).toEqual({
      provider: { baseUrl: 'https://b.com/v1', apiKey: '', model: '' },
      agent: DEFAULT_SETTINGS.agent,
    });
```

改成

```ts
    expect(raw).toEqual({
      provider: { baseUrl: 'https://b.com/v1', apiKey: '', model: '' },
      agent: DEFAULT_SETTINGS.agent,
      prompt: DEFAULT_SETTINGS.prompt,
    });
```

- [ ] **Step 5: 运行测试与类型检查**

Run: `npx vitest run tests/storage/settings.test.ts`
Expected: PASS（全部，含既有用例）

Run: `npm run compile`
Expected: 无输出

- [ ] **Step 6: 提交**

```bash
git add storage/settings.ts tests/storage/settings.test.ts
git commit -m "feat(settings): 新增 prompt 段（自定义系统提示词全文 + 内置快照）"
```

---

## Task 3: `resolveSystemPrompt` + loop 每轮注入

**Files:**
- Modify: `agent/context.ts`（新增 `resolveSystemPrompt`、`BuildContextOptions.systemPrompt`）
- Modify: `agent/loop.ts`（`LoopDeps.getSystemPrompt` + drive 内读取）
- Modify: `background/agent-port.ts:96-118`（makeDeps 注入）
- Test: `tests/agent/context.test.ts`、`tests/agent/loop.test.ts`

- [ ] **Step 1: 写失败测试**

在 `tests/agent/context.test.ts` 末尾追加（顶部 import 需加 `resolveSystemPrompt`：把第 2 行改为 `import { buildContext, truncateMessages, SYSTEM_PROMPT, resolveSystemPrompt } from '../../agent/context';`）：

```ts
describe('resolveSystemPrompt', () => {
  it('空串 / undefined / 纯空白 → 内置全文', () => {
    expect(resolveSystemPrompt('')).toBe(SYSTEM_PROMPT);
    expect(resolveSystemPrompt(undefined)).toBe(SYSTEM_PROMPT);
    expect(resolveSystemPrompt('   \n  ')).toBe(SYSTEM_PROMPT);
  });

  it('有内容 → 原样返回（不 trim 正文，只用 trim 判空）', () => {
    expect(resolveSystemPrompt('  我的提示词  ')).toBe('  我的提示词  ');
  });
});

describe('buildContext opts.systemPrompt', () => {
  it('传自定义 → system 消息用它，且动态块仍在（页面/技能/模式）', () => {
    const msgs = buildContext([], page, {
      systemPrompt: '【自定义】只听我的',
      skills: [{ name: 'N', command: 'c', description: 'd' }],
      mode: 'ask',
    });
    const sys = String(msgs[0]!.content);
    expect(sys).toContain('【自定义】只听我的');
    expect(sys).not.toContain('你是一个能操控浏览器的 AI 助手');
    // 动态块不受覆盖影响
    expect(sys).toContain('当前页面');
    expect(sys).toContain('/c');
    expect(sys).toContain('ask（只读问答）');
  });

  it('不传 → 用内置全文', () => {
    const sys = String(buildContext([], page)[0]!.content);
    expect(sys).toContain('你是一个能操控浏览器的 AI 助手');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/agent/context.test.ts -t "resolveSystemPrompt"`
Expected: FAIL — `resolveSystemPrompt` 未导出

- [ ] **Step 3: 实现 `agent/context.ts`**

在 `SYSTEM_PROMPT` 常量之后插入：

```ts
/** 决定本轮使用的系统提示词：自定义非空则用它，否则回落内置全文。
 *  只用 trim 判空——正文本身不 trim，用户刻意留的首尾空行保持原样。 */
export function resolveSystemPrompt(custom?: string): string {
  return custom?.trim() ? custom : SYSTEM_PROMPT;
}
```

`BuildContextOptions` 加字段：

```ts
  /** 系统提示词全文（缺省用内置 SYSTEM_PROMPT）。覆盖只替换该常量，动态块照旧追加。 */
  systemPrompt?: string;
```

`buildContext` 内解构与 system 组装改为：

```ts
  const { keepRecent = 60, summary, skills, mode = 'agent', systemPrompt } = opts;
```

```ts
  const base = resolveSystemPrompt(systemPrompt);
  const system: ChatMessage = { role: 'system', content: base + pageBlock + skillsBlock + modePrompt(mode) };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/agent/context.test.ts`
Expected: PASS

- [ ] **Step 5: 写 loop 接线的失败测试**

在 `tests/agent/loop.test.ts` 末尾追加（该文件已有 `captureProvider` 之类的辅助，若命名不同则照本用例自带的写法）：

```ts
describe('loop 注入自定义系统提示词', () => {
  beforeEach(() => fakeBrowser.reset());

  it('deps.getSystemPrompt 的返回值进 system 消息，每轮重读', async () => {
    const captured: ChatParams[] = [];
    const provider: Provider = {
      streamChat(p: ChatParams, onEvent: (e: StreamEvent) => void) {
        captured.push(p);
        queueMicrotask(() => onEvent({ type: 'text-delta', text: 'ok' }));
        queueMicrotask(() => onEvent({ type: 'message-done', finishReason: 'stop' }));
        return { cancel: vi.fn() };
      },
    };
    await runAgentLoop(
      { convId: 'c1', tabId: 1, userMessage: 'hi' },
      {
        provider,
        executeTool: vi.fn<LoopDeps['executeTool']>(),
        getPageInfo: async () => ({ url: '', title: '' }),
        emit: vi.fn(),
        getSystemPrompt: async () => '【自定义】听我的',
      },
    );
    const sys = String(captured[0]!.messages[0]!.content);
    expect(sys).toContain('【自定义】听我的');
    expect(sys).not.toContain('你是一个能操控浏览器的 AI 助手');
  });

  it('不提供 getSystemPrompt → 用内置全文', async () => {
    const captured: ChatParams[] = [];
    const provider: Provider = {
      streamChat(p: ChatParams, onEvent: (e: StreamEvent) => void) {
        captured.push(p);
        queueMicrotask(() => onEvent({ type: 'text-delta', text: 'ok' }));
        queueMicrotask(() => onEvent({ type: 'message-done', finishReason: 'stop' }));
        return { cancel: vi.fn() };
      },
    };
    await runAgentLoop(
      { convId: 'c2', tabId: 1, userMessage: 'hi' },
      {
        provider,
        executeTool: vi.fn<LoopDeps['executeTool']>(),
        getPageInfo: async () => ({ url: '', title: '' }),
        emit: vi.fn(),
      },
    );
    expect(String(captured[0]!.messages[0]!.content)).toContain('你是一个能操控浏览器的 AI 助手');
  });
});
```

若 `tests/agent/loop.test.ts` 顶部未 import 这些符号，补上：

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { runAgentLoop, type LoopDeps } from '../../agent/loop';
import type { Provider, StreamEvent, ChatParams } from '../../agent/provider/types';
```

- [ ] **Step 6: 运行测试确认失败**

Run: `npx vitest run tests/agent/loop.test.ts -t "自定义系统提示词"`
Expected: FAIL — `LoopDeps` 上不存在 `getSystemPrompt`（TS 报错）

- [ ] **Step 7: 改 `agent/loop.ts`**

`LoopDeps` 接口内（`getMaxTokens` 之后）加：

```ts
  /** 系统提示词全文（缺省用内置 SYSTEM_PROMPT）。每轮重读，设置页改完下一轮生效。 */
  getSystemPrompt?: () => Promise<string>;
```

`drive` 内 `const mode = ...` 之后加一行、并把 `buildContext` 调用改掉：

```ts
    const systemPrompt = await deps.getSystemPrompt?.();
    const messages = buildContext(conv.messages, page, { summary: conv.summary, skills, mode, systemPrompt });
```

- [ ] **Step 8: 改 `background/agent-port.ts` 的 makeDeps**

在 `getMaxTokens` 那一行之后插入：

```ts
    getSystemPrompt: async () => {
      const { prompt } = await getSettings().catch(() => ({ prompt: { custom: '' } }));
      return resolveSystemPrompt(prompt.custom);
    },
```

并把文件顶部 import 补上（第 10 行附近，与 `resolveContextWindow` 同组）：

```ts
import { resolveSystemPrompt } from '../agent/context';
```

- [ ] **Step 9: 运行测试与类型检查**

Run: `npx vitest run tests/agent/loop.test.ts tests/agent/context.test.ts`
Expected: PASS

Run: `npm run compile`
Expected: 无输出

- [ ] **Step 10: 提交**

```bash
git add agent/context.ts agent/loop.ts background/agent-port.ts tests/agent/context.test.ts tests/agent/loop.test.ts
git commit -m "feat(agent): 自定义系统提示词每轮注入（覆盖内置常量，动态块不受影响）"
```

---

## Task 4: `CodeEditor` 支持 markdown

**Files:**
- Modify: `package.json`
- Modify: `components/detail/CodeEditor.tsx:1-17,57-90`

- [ ] **Step 1: 装依赖**

```bash
npm install --save-exact @codemirror/lang-markdown@6.3.4
```

Expected: `package.json` 的 `dependencies` 出现 `"@codemirror/lang-markdown": "6.3.4"`。

若该版本不可用，用 `npm view @codemirror/lang-markdown version` 取当前 6.x 最新版并钉住它。

- [ ] **Step 2: 改 `components/detail/CodeEditor.tsx`**

顶部 import 加一行（第 8 行 `javascript` 那行之后）：

```ts
import { markdown } from '@codemirror/lang-markdown';
```

`Props` 接口加字段：

```ts
interface Props {
  value: string;
  onChange: (next: string) => void;
  onSave: () => void;
  ariaLabel: string;
  /** 语法高亮语言。挂载时决定，不支持运行时切换（extensions 只构建一次）。默认 javascript。 */
  language?: 'javascript' | 'markdown';
}
```

函数签名与 extensions 改为：

```ts
export function CodeEditor({ value, onChange, onSave, ariaLabel, language = 'javascript' }: Props) {
```

extensions 数组里把 `javascript(),` 那一行替换为：

```ts
        language === 'markdown' ? markdown() : javascript(),
```

- [ ] **Step 3: 类型检查 + 既有测试回归**

Run: `npm run compile`
Expected: 无输出

Run: `npm run test`
Expected: PASS（`DetailCodeTab` 未传 `language`，走默认 javascript，行为不变）

- [ ] **Step 4: 提交**

```bash
git add package.json package-lock.json components/detail/CodeEditor.tsx
git commit -m "feat(ui): CodeEditor 支持 markdown 语言（默认 javascript，既有调用点不变）"
```

---

## Task 5: 系统提示词页 + 设置入口

**Files:**
- Create: `components/settings/SystemPromptPage.tsx`
- Modify: `components/settings/SettingsHome.tsx`
- Modify: `components/settings/SettingsView.tsx`
- Modify: `entrypoints/sidepanel/styles.css`
- Create: `tests/settings/system-prompt-page.test.tsx`
- Modify: `tests/settings/settings-view.test.tsx`

- [ ] **Step 1: 写失败测试**

创建 `tests/settings/system-prompt-page.test.tsx`：

```tsx
// tests/settings/system-prompt-page.test.tsx
// 系统提示词页：未自定义时预填内置全文 + 提示条；保存写入 custom 与 baseSnapshot；恢复默认清空。
// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SystemPromptPage } from '../../components/settings/SystemPromptPage';
import { getSettings, saveSettings } from '../../storage/settings';
import { SYSTEM_PROMPT } from '../../agent/context';

// CodeMirror 在 jsdom 下不便断言内容，替换为受控 textarea（只测页面逻辑，不测编辑器本体）
vi.mock('../../components/detail/CodeEditor', () => ({
  CodeEditor: ({ value, onChange, ariaLabel }: {
    value: string; onChange: (v: string) => void; ariaLabel: string;
  }) => (
    <textarea aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

beforeEach(() => {
  fakeBrowser.reset();
  vi.restoreAllMocks();
});
afterEach(cleanup);

describe('SystemPromptPage', () => {
  it('未自定义时：预填内置全文 + 出「当前使用内置提示词」提示条', async () => {
    render(<SystemPromptPage onBack={() => {}} />);
    const box = await screen.findByLabelText<HTMLTextAreaElement>('系统提示词编辑器');
    expect(box.value).toBe(SYSTEM_PROMPT);
    expect(screen.getByText(/当前使用内置提示词/)).toBeTruthy();
  });

  it('改内容后保存 → custom 与 baseSnapshot 落库，提示条消失', async () => {
    render(<SystemPromptPage onBack={() => {}} />);
    const box = await screen.findByLabelText<HTMLTextAreaElement>('系统提示词编辑器');
    fireEvent.change(box, { target: { value: '我的提示词' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(async () => {
      const s = await getSettings();
      expect(s.prompt.custom).toBe('我的提示词');
      expect(s.prompt.baseSnapshot).toBe(SYSTEM_PROMPT);
    });
    expect(screen.queryByText(/当前使用内置提示词/)).toBeNull();
  });

  it('已自定义时载入 custom，恢复默认后清空并回内置全文', async () => {
    await saveSettings({ prompt: { custom: '旧的自定义', baseSnapshot: SYSTEM_PROMPT } });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<SystemPromptPage onBack={() => {}} />);
    const box = await screen.findByLabelText<HTMLTextAreaElement>('系统提示词编辑器');
    await waitFor(() => expect(box.value).toBe('旧的自定义'));
    fireEvent.click(screen.getByRole('button', { name: '恢复默认' }));
    await waitFor(async () => expect((await getSettings()).prompt.custom).toBe(''));
    expect(box.value).toBe(SYSTEM_PROMPT);
  });

  it('baseSnapshot 与当前内置不同 → 出「基于旧版」提示条', async () => {
    await saveSettings({ prompt: { custom: '自定义', baseSnapshot: '很久以前的内置全文' } });
    render(<SystemPromptPage onBack={() => {}} />);
    expect(await screen.findByText(/基于旧版内置提示词/)).toBeTruthy();
  });

  it('超长（>16KB）禁用保存并出错误文案', async () => {
    render(<SystemPromptPage onBack={() => {}} />);
    const box = await screen.findByLabelText<HTMLTextAreaElement>('系统提示词编辑器');
    fireEvent.change(box, { target: { value: 'x'.repeat(16 * 1024 + 1) } });
    expect(screen.getByRole('button', { name: '保存' })).toHaveProperty('disabled', true);
    expect(screen.getByText(/超过上限/)).toBeTruthy();
  });

  it('切到预览渲染 Markdown（标题变成 heading 元素）', async () => {
    render(<SystemPromptPage onBack={() => {}} />);
    const box = await screen.findByLabelText<HTMLTextAreaElement>('系统提示词编辑器');
    fireEvent.change(box, { target: { value: '# 标题一' } });
    fireEvent.click(screen.getByRole('button', { name: '预览' }));
    expect(await screen.findByRole('heading', { name: '标题一' })).toBeTruthy();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/settings/system-prompt-page.test.tsx`
Expected: FAIL — 无法解析 `components/settings/SystemPromptPage`

- [ ] **Step 3: 创建 `components/settings/SystemPromptPage.tsx`**

```tsx
// components/settings/SystemPromptPage.tsx
// 系统提示词二级页（spec §2.5）：覆盖式编辑内置 SYSTEM_PROMPT。
// 未自定义时预填内置全文——一改一存即固化为自定义，这就是覆盖式的含义。
import { useEffect, useState } from 'react';
import { Eye, Pencil, RotateCcw } from 'lucide-react';
import { PageShell } from '../ui/PageShell';
import { Button } from '../ui/Button';
import { Markdown } from '../chat/Markdown';
import { SYSTEM_PROMPT } from '../../agent/context';
import { getSettings, saveSettings, MAX_CUSTOM_PROMPT } from '../../storage/settings';

export function SystemPromptPage({ onBack }: { onBack: () => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  /** 已落库的自定义（空串 = 未自定义）。保存/恢复后同步。 */
  const [saved, setSaved] = useState('');
  const [baseSnapshot, setBaseSnapshot] = useState<string | undefined>(undefined);
  const [preview, setPreview] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const s = await getSettings().catch(() => null);
      const custom = s?.prompt.custom ?? '';
      setSaved(custom);
      setBaseSnapshot(s?.prompt.baseSnapshot);
      setDraft(custom || SYSTEM_PROMPT);
    })();
  }, []);

  if (draft === null) {
    return (
      <PageShell title="系统提示词" eyebrow="PROMPT" onBack={onBack} backLabel="返回设置">
        <div className="hint">加载中…</div>
      </PageShell>
    );
  }

  const tooLong = draft.length > MAX_CUSTOM_PROMPT;
  const isBuiltin = saved.trim() === '';
  const staleBase = baseSnapshot != null && baseSnapshot !== SYSTEM_PROMPT;

  const handleSave = async (): Promise<void> => {
    if (tooLong) return;
    await saveSettings({ prompt: { custom: draft, baseSnapshot: SYSTEM_PROMPT } });
    setSaved(draft);
    setBaseSnapshot(SYSTEM_PROMPT);
    setStatus('已保存，下一轮对话生效');
  };

  const handleReset = async (): Promise<void> => {
    if (!window.confirm('恢复默认会丢弃你的自定义提示词，不可撤销。继续？')) return;
    await saveSettings({ prompt: { custom: '', baseSnapshot: undefined } });
    setSaved('');
    setBaseSnapshot(undefined);
    setDraft(SYSTEM_PROMPT);
    setStatus('已恢复内置提示词');
  };

  return (
    <PageShell
      title="系统提示词"
      eyebrow="PROMPT"
      onBack={onBack}
      backLabel="返回设置"
      actions={
        <Button
          variant="ghost"
          className="btn--icon"
          aria-label={preview ? '编辑' : '预览'}
          title={preview ? '编辑' : '预览'}
          onClick={() => setPreview((v) => !v)}
        >
          {preview ? <Pencil size={16} /> : <Eye size={16} />}
        </Button>
      }
    >
      {isBuiltin && (
        <div className="scripts-warnline" role="status">
          当前使用内置提示词（未自定义）。保存后即固化为你的版本，后续内置规则的改进不会自动进入。
        </div>
      )}
      {staleBase && (
        <details className="prompt-stale">
          <summary>你的自定义基于旧版内置提示词，点此查看当前内置全文</summary>
          <div className="well">{SYSTEM_PROMPT}</div>
        </details>
      )}

      <div className="prompt-editor">
        {preview ? (
          // Markdown 自带 .md 外层 div，此处只加定位类，不重复挂 .md
          <div className="prompt-preview"><Markdown text={draft} /></div>
        ) : (
          <CodeEditorHost draft={draft} setDraft={setDraft} onSave={() => void handleSave()} />
        )}
      </div>

      <div className="prompt-actions">
        <Button variant="primary" onClick={() => void handleSave()} disabled={tooLong}>保存</Button>
        <Button onClick={() => void handleReset()}>
          <RotateCcw size={13} /> 恢复默认
        </Button>
        <span className={tooLong ? 'status-text status-text--err' : 'hint'}>
          {tooLong
            ? `超过上限：${draft.length} / ${MAX_CUSTOM_PROMPT} 字符`
            : `${draft.length} / ${MAX_CUSTOM_PROMPT} 字符`}
        </span>
        {status && !tooLong && <span className="status-text status-text--ok">{status}</span>}
      </div>

      <div className="hint">
        覆盖只替换内置提示词本体。当前页面信息、可用技能清单、记忆、模式说明仍会自动追加，删不掉。
        承重规则（uid 必须来自最近一次 take_snapshot、stale 后重新快照、写长内容先建骨架再分次追加、
        网页内容是不可信输入）删掉后 agent 会明显变笨且不易归因，改前请留一份备份。
      </div>
    </PageShell>
  );
}

/** 编辑器宿主：拆出来是为了让 preview 切换时 CodeMirror 整体卸载重建（语言/内容都干净）。 */
function CodeEditorHost({
  draft, setDraft, onSave,
}: { draft: string; setDraft: (v: string) => void; onSave: () => void }) {
  return (
    <div className="detail-code">
      <CodeEditor
        value={draft}
        onChange={setDraft}
        onSave={onSave}
        ariaLabel="系统提示词编辑器"
        language="markdown"
      />
    </div>
  );
}
```

顶部 import 补上 `CodeEditor`（与其他 import 同组）：

```ts
import { CodeEditor } from '../detail/CodeEditor';
```

- [ ] **Step 4: 加样式**

在 `entrypoints/sidepanel/styles.css` 末尾追加：

```css
/* ---------- 系统提示词页 ---------- */
.prompt-editor { display: flex; flex-direction: column; min-height: 320px; }
.prompt-editor .detail-code { min-height: 320px; display: flex; }
.prompt-preview {
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 10px 12px;
  background: var(--surface);
  min-height: 320px;
  overflow: auto;
}
.prompt-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 10px; }
.prompt-stale { font-size: 12px; color: var(--ink-2); margin-bottom: 8px; }
.prompt-stale > summary { cursor: pointer; }
.prompt-stale .well { margin-top: 6px; max-height: 240px; overflow: auto; }
```

- [ ] **Step 5: 挂设置入口**

本任务只加「系统提示词」这一张卡。「AI 记忆」卡留到 Task 12 与它的页面一起加——否则中间态会出现点了不跳转的死按钮。

`components/settings/SettingsHome.tsx`：

`SettingsSub` 改为

```ts
export type SettingsSub = 'model' | 'prompt' | 'toolbench' | 'scriptdebug' | 'skills';
```

import 加 `ScrollText`：

```ts
import { SlidersHorizontal, SquareTerminal, FlaskConical, ChevronRight, Sparkles, ScrollText } from 'lucide-react';
```

`ENTRIES` 数组在 `model` 那一项之后插入：

```ts
  { key: 'prompt', title: '系统提示词', desc: '查看并改写内置系统提示词（Markdown）', Icon: ScrollText },
```

`components/settings/SettingsView.tsx`：加 import 与分支

```tsx
import { SystemPromptPage } from './SystemPromptPage';
```

```tsx
  if (sub === 'prompt') return <SystemPromptPage onBack={back} />;
```

- [ ] **Step 6: 修正 settings-view 既有测试**

`tests/settings/settings-view.test.tsx` 第一个用例改名并补断言：

```tsx
  it('默认渲染列表页各入口', async () => {
    render(<SettingsView />);
    expect(await screen.findByText('模型设置')).toBeTruthy();
    expect(screen.getByText('系统提示词')).toBeTruthy();
    expect(screen.getByText('工具调试台')).toBeTruthy();
    expect(screen.getByText('脚本运行时调试台')).toBeTruthy();
  });
```

- [ ] **Step 7: 运行测试与类型检查**

Run: `npx vitest run tests/settings/`
Expected: PASS

Run: `npm run compile`
Expected: 无输出

- [ ] **Step 8: 提交**

```bash
git add components/settings/SystemPromptPage.tsx components/settings/SettingsHome.tsx components/settings/SettingsView.tsx entrypoints/sidepanel/styles.css tests/settings/
git commit -m "feat(settings): 系统提示词页（md 编辑器 + 预览 + 恢复默认 + 旧版快照提示）"
```

---

## Task 6: 记忆实体与存储层

**Files:**
- Modify: `shared/types.ts`（在 `SkillSummary` 之后插入 `MemoryEntry`）
- Create: `storage/memory.ts`
- Create: `tests/storage/memory.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `tests/storage/memory.test.ts`：

```ts
// tests/storage/memory.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { storage } from 'wxt/utils/storage';
import {
  listMemories, getMemoryEntry, saveMemory, deleteMemory, newMemory,
  MAX_ENTRIES, MAX_CONTENT_LENGTH,
} from '../../storage/memory';
import type { MemoryEntry } from '../../shared/types';

function mk(over: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: 'm1', content: '用户偏好中文回复', matches: [],
    source: 'ai', createdAt: 1, updatedAt: 1, ...over,
  };
}

describe('storage/memory', () => {
  beforeEach(() => fakeBrowser.reset());

  it('空库返回 []，getMemoryEntry 返回 undefined', async () => {
    expect(await listMemories()).toEqual([]);
    expect(await getMemoryEntry('m1')).toBeUndefined();
  });

  it('save 新增 + 读回 + list 全量', async () => {
    await saveMemory(mk());
    await saveMemory(mk({ id: 'm2', content: 'B 站登录按钮在头像悬浮层', matches: ['*://*.bilibili.com/*'] }));
    expect(await getMemoryEntry('m2')).toMatchObject({ id: 'm2', matches: ['*://*.bilibili.com/*'] });
    expect(await listMemories()).toHaveLength(2);
  });

  it('同 id 覆盖（upsert）不新增', async () => {
    await saveMemory(mk());
    await saveMemory(mk({ content: '改过的正文' }));
    const all = await listMemories();
    expect(all).toHaveLength(1);
    expect(all[0]!.content).toBe('改过的正文');
  });

  it('落到 local:memory:index 键', async () => {
    await saveMemory(mk());
    expect(await storage.getItem<MemoryEntry[]>('local:memory:index')).toHaveLength(1);
  });

  it('数量上限：超过 MAX_ENTRIES 抛错', async () => {
    for (let i = 0; i < MAX_ENTRIES; i++) await saveMemory(mk({ id: `k${i}` }));
    await expect(saveMemory(mk({ id: 'extra' }))).rejects.toThrow('上限');
  });

  it('满员时更新既有条目仍成功', async () => {
    for (let i = 0; i < MAX_ENTRIES; i++) await saveMemory(mk({ id: `k${i}` }));
    await saveMemory(mk({ id: 'k0', content: '改名' }));
    expect(await listMemories()).toHaveLength(MAX_ENTRIES);
    expect((await getMemoryEntry('k0'))!.content).toBe('改名');
  });

  it('content 为空或纯空白抛错', async () => {
    await expect(saveMemory(mk({ content: '' }))).rejects.toThrow('正文');
    await expect(saveMemory(mk({ content: '   ' }))).rejects.toThrow('正文');
  });

  it('content 超长抛错', async () => {
    await expect(saveMemory(mk({ content: 'x'.repeat(MAX_CONTENT_LENGTH + 1) }))).rejects.toThrow('上限');
  });

  it('非法 match pattern 整条拒存，错误文案点名那条', async () => {
    await expect(
      saveMemory(mk({ matches: ['*://*.bilibili.com/*', '不是 pattern'] })),
    ).rejects.toThrow('不是 pattern');
    expect(await listMemories()).toEqual([]);
  });

  it('<all_urls> 视为合法 pattern', async () => {
    await saveMemory(mk({ matches: ['<all_urls>'] }));
    expect(await listMemories()).toHaveLength(1);
  });

  it('delete 幂等（不存在也成功）', async () => {
    await saveMemory(mk());
    await deleteMemory('m1');
    await deleteMemory('m1');
    expect(await listMemories()).toEqual([]);
  });

  it('newMemory 工厂：8 位 id + 时间戳 + 字段透传', () => {
    const m = newMemory({ content: 'C', matches: ['<all_urls>'], source: 'user' });
    expect(m.id).toHaveLength(8);
    expect(m.createdAt).toBeGreaterThan(0);
    expect(m.updatedAt).toBe(m.createdAt);
    expect(m).toMatchObject({ content: 'C', matches: ['<all_urls>'], source: 'user' });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/storage/memory.test.ts`
Expected: FAIL — 无法解析 `storage/memory`

- [ ] **Step 3: 在 `shared/types.ts` 加实体**

在 `SkillSummary` 接口之后（约第 137 行，`// ---------- 输入框附件` 注释之前）插入：

```ts
// ---------- Agent 记忆（跨会话长期记忆，spec §3）----------

export interface MemoryEntry {
  /** nanoid(8)：短 id 省注入 token，且足够唯一（本地 ≤100 条） */
  id: string;
  /** 记忆正文，≤500 字符 */
  content: string;
  /** 站点作用域（Chrome match pattern）。空数组 = 全局记忆，始终注入 */
  matches: string[];
  /** 来源：AI 自主记录 / 用户手工添加。事实记录，不因后续编辑而改写 */
  source: 'ai' | 'user';
  createdAt: number;
  updatedAt: number;
}
```

- [ ] **Step 4: 创建 `storage/memory.ts`**

```ts
// storage/memory.ts
// Agent 记忆存储（spec §3.2）。单键 local:memory:index（MemoryEntry[]），与 storage/skills.ts 同构。
// 面板（设置页）与 AI 工具层共用本模块——记忆不走 background 编排层（无解析、无注入引擎）。
import { storage } from 'wxt/utils/storage';
import { nanoid } from 'nanoid';
import type { MemoryEntry } from '../shared/types';
import { isValidMatchPattern } from '../shared/match-pattern';

const KEY = 'local:memory:index' as const;

export const MAX_ENTRIES = 100;
export const MAX_CONTENT_LENGTH = 500;

export async function listMemories(): Promise<MemoryEntry[]> {
  return (await storage.getItem<MemoryEntry[]>(KEY)) ?? [];
}

export async function getMemoryEntry(id: string): Promise<MemoryEntry | undefined> {
  return (await listMemories()).find((m) => m.id === id);
}

/**
 * upsert。数量上限 / 正文空与超长 / 非法 pattern 超限 throw（中文可读文案）。
 *
 * 非法 pattern 整条拒存（不同于脚本池的「跳过坏规则 + 警告」）：记忆只有一个 matches
 * 字段，静默跳过会让 AI 以为写成功了、而实际作用域是错的——这种失败必须显式。
 */
export async function saveMemory(entry: MemoryEntry): Promise<void> {
  const all = await listMemories();
  const exists = all.some((m) => m.id === entry.id);
  if (!exists && all.length >= MAX_ENTRIES) {
    throw new Error(`记忆数量已达上限（${MAX_ENTRIES} 条），请先删除部分记忆`);
  }
  if (!entry.content.trim()) {
    throw new Error('记忆正文不能为空');
  }
  if (entry.content.length > MAX_CONTENT_LENGTH) {
    throw new Error(`记忆正文超过上限（${MAX_CONTENT_LENGTH} 字符），请精简或拆成两条`);
  }
  const bad = entry.matches.find((p) => !isValidMatchPattern(p));
  if (bad != null) {
    throw new Error(`非法 match pattern：${bad}（形如 *://*.example.com/* 或 <all_urls>）`);
  }
  const next = exists ? all.map((m) => (m.id === entry.id ? entry : m)) : [...all, entry];
  await storage.setItem(KEY, next);
}

/** 幂等：不存在也成功。 */
export async function deleteMemory(id: string): Promise<void> {
  const all = await listMemories();
  await storage.setItem(KEY, all.filter((m) => m.id !== id));
}

/** 新条目工厂（AI 工具与设置页共用）。 */
export function newMemory(
  fields: { content: string; matches: string[]; source: 'ai' | 'user' },
): MemoryEntry {
  const now = Date.now();
  return { id: nanoid(8), createdAt: now, updatedAt: now, ...fields };
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run tests/storage/memory.test.ts`
Expected: PASS（15 个用例）

Run: `npm run compile`
Expected: 无输出

- [ ] **Step 6: 提交**

```bash
git add shared/types.ts storage/memory.ts tests/storage/memory.test.ts
git commit -m "feat(storage): 记忆存储层（条目式 + 站点作用域 + 上限与 pattern 校验）"
```

---

## Task 7: 记忆注入纯函数（三层 + 半预算）

本任务是记忆功能的核心逻辑，全部是纯函数，不碰 storage 也不碰 UI。

**三层的动因**：记忆过滤依赖 `page.url`，而 `page.url` 每轮循环顶部才重读。模型在导航**前**规划路线时看不到目标站的记忆——第 3 层（站点清单）让它知道「那个站有 3 条记忆」，可主动用 `memory_list` 取。

**半预算的动因**：全局记忆（如「用中文回复」）被挤掉会立刻被用户察觉，站点记忆被挤掉会让 agent 在当前页重复踩坑，两者都不能牺牲。故两层各分半预算，某层未用满的额度让给另一层。

**Files:**
- Create: `agent/memory-prompt.ts`
- Create: `tests/agent/memory-prompt.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `tests/agent/memory-prompt.test.ts`：

```ts
// tests/agent/memory-prompt.test.ts
import { describe, it, expect } from 'vitest';
import {
  buildMemoryPrompt, memoryStateToCap, INJECT_BUDGET_CHARS,
  type MemoryBrief, type MemoryState,
} from '../../agent/memory-prompt';

function brief(over: Partial<MemoryBrief> = {}): MemoryBrief {
  return { id: 'm1', content: '正文', matches: [], updatedAt: 1, ...over };
}

const state = (entries: MemoryBrief[], over: Partial<MemoryState> = {}): MemoryState =>
  ({ enabled: true, writable: true, entries, ...over });

const BILI = 'https://www.bilibili.com/video/BV1';

describe('buildMemoryPrompt 总开关与冷启动', () => {
  it('enabled:false → 空串（连冷启动文案都不注入）', () => {
    expect(buildMemoryPrompt(state([], { enabled: false }), BILI)).toBe('');
    // 有条目也一样静默
    expect(buildMemoryPrompt(state([brief()], { enabled: false }), BILI)).toBe('');
  });

  it('空库 + 可写 → 冷启动文案，提 memory_write', () => {
    const s = buildMemoryPrompt(state([]), BILI);
    expect(s).toContain('记忆');
    expect(s).toContain('memory_write');
  });

  it('空库 + 只读 → 冷启动文案但不提写工具', () => {
    const s = buildMemoryPrompt(state([], { writable: false }), BILI);
    expect(s).not.toContain('memory_write');
    expect(s).not.toContain('memory_delete');
    expect(s).toContain('memory_list');
  });
});

describe('buildMemoryPrompt 三层分组', () => {
  it('全局记忆（matches 空）始终注入，与 URL 无关', () => {
    const s = buildMemoryPrompt(state([brief({ id: 'g1', content: '偏好中文' })]), '');
    expect(s).toContain('偏好中文');
    expect(s).toContain('全局');
  });

  it('命中当前页的站点记忆出全文', () => {
    const s = buildMemoryPrompt(
      state([brief({ id: 's1', content: '登录在悬浮层', matches: ['*://*.bilibili.com/*'] })]),
      BILI,
    );
    expect(s).toContain('登录在悬浮层');
    expect(s).toContain('*://*.bilibili.com/*');
  });

  it('未命中的记忆只出站点清单，不出正文', () => {
    const s = buildMemoryPrompt(
      state([brief({ id: 'o1', content: '这段正文不该出现', matches: ['*://github.com/*'] })]),
      BILI,
    );
    expect(s).not.toContain('这段正文不该出现');
    expect(s).toContain('*://github.com/*');
    expect(s).toContain('memory_list');
  });

  it('站点清单按 pattern 聚合计数并按条数倒序', () => {
    const s = buildMemoryPrompt(
      state([
        brief({ id: 'a', matches: ['*://github.com/*'] }),
        brief({ id: 'b', matches: ['*://github.com/*'] }),
        brief({ id: 'c', matches: ['*://*.zhihu.com/*'] }),
      ]),
      BILI,
    );
    expect(s).toContain('*://github.com/* (2)');
    expect(s).toContain('*://*.zhihu.com/* (1)');
    expect(s.indexOf('*://github.com/*')).toBeLessThan(s.indexOf('*://*.zhihu.com/*'));
  });

  it('站点清单最多 30 个 pattern，超出附「另有 N 个站点」', () => {
    const entries = Array.from({ length: 35 }, (_, i) =>
      brief({ id: `x${i}`, matches: [`*://site${i}.com/*`] }));
    const s = buildMemoryPrompt(state(entries), BILI);
    expect(s).toContain('另有 5 个站点');
  });

  it('条目格式：[id 作用域] 正文；多 pattern 附「等 N 条」', () => {
    const s = buildMemoryPrompt(
      state([brief({ id: 'ab12cd34', content: 'X', matches: ['*://a.com/*', '*://b.com/*'] })]),
      'https://a.com/x',
    );
    expect(s).toContain('[ab12cd34');
    expect(s).toContain('等 2 条');
  });

  it('全局排在站点记忆之前（阅读顺序）', () => {
    const s = buildMemoryPrompt(
      state([
        brief({ id: 's1', content: '站点条目', matches: ['*://*.bilibili.com/*'] }),
        brief({ id: 'g1', content: '全局条目' }),
      ]),
      BILI,
    );
    expect(s.indexOf('全局条目')).toBeLessThan(s.indexOf('站点条目'));
  });

  it('同层内按 updatedAt 倒序（新的在前）', () => {
    const s = buildMemoryPrompt(
      state([
        brief({ id: 'old', content: '旧条目', updatedAt: 1 }),
        brief({ id: 'new', content: '新条目', updatedAt: 999 }),
      ]),
      '',
    );
    expect(s.indexOf('新条目')).toBeLessThan(s.indexOf('旧条目'));
  });
});

describe('buildMemoryPrompt 预算', () => {
  const long = (n: number) => 'x'.repeat(n);

  it('超预算的条目不注入，附「另有 N 条」提示', () => {
    // 每条 500 字，全局 20 条 = 10000 字，远超 6000 预算
    const entries = Array.from({ length: 20 }, (_, i) =>
      brief({ id: `g${i}`, content: long(500), updatedAt: i }));
    const s = buildMemoryPrompt(state(entries), '');
    expect(s).toContain('另有');
    expect(s).toContain('因长度限制未列出');
    expect(s.length).toBeLessThan(INJECT_BUDGET_CHARS * 2);
  });

  it('半预算让渡：只有全局记忆时，可用满整个预算（超过半额）', () => {
    // 10 条 × 500 = 5000 字 > 半预算 3000，无站点记忆时应全部装进去
    const entries = Array.from({ length: 10 }, (_, i) =>
      brief({ id: `g${i}`, content: `全局${i}${long(490)}`, updatedAt: i }));
    const s = buildMemoryPrompt(state(entries), '');
    for (let i = 0; i < 10; i++) expect(s).toContain(`全局${i}`);
    expect(s).not.toContain('因长度限制未列出');
  });

  it('全局记忆不会被站点记忆挤掉（各有半额保底）', () => {
    const globals = Array.from({ length: 10 }, (_, i) =>
      brief({ id: `g${i}`, content: `全局${i}${long(490)}`, updatedAt: 100 + i }));
    const sites = Array.from({ length: 10 }, (_, i) =>
      brief({ id: `s${i}`, content: `站点${i}${long(490)}`, matches: ['*://*.bilibili.com/*'], updatedAt: 200 + i }));
    const s = buildMemoryPrompt(state([...globals, ...sites]), BILI);
    // 两层都至少装进了最新的几条
    expect(s).toContain('全局9');
    expect(s).toContain('站点9');
  });
});

describe('memoryStateToCap', () => {
  it('enabled:false → off；只读 → read；可写 → full', () => {
    expect(memoryStateToCap(state([], { enabled: false }))).toBe('off');
    expect(memoryStateToCap(state([], { writable: false }))).toBe('read');
    expect(memoryStateToCap(state([]))).toBe('full');
  });

  it('enabled:false 优先于 writable', () => {
    expect(memoryStateToCap(state([], { enabled: false, writable: true }))).toBe('off');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/agent/memory-prompt.test.ts`
Expected: FAIL — 无法解析 `agent/memory-prompt`

- [ ] **Step 3: 创建 `agent/memory-prompt.ts`**

```ts
// agent/memory-prompt.ts
// 记忆注入的纯函数（spec §3.3）：三层分组 + 半预算装箱 + 站点清单聚合。
//
// 三层的动因：记忆过滤依赖 page.url，而 page.url 每轮循环顶部才重读（loop 的 getPageInfo）。
// 模型在导航【前】规划路线时看不到目标站的记忆，第 3 层（站点清单）让它知道「那站有 N 条」，
// 可主动用 memory_list 取；不取也没事，导航后下一轮自动注入全文。
import { matchUrl } from '../shared/match-pattern';
import type { MemoryCap } from './mode';

export interface MemoryBrief {
  id: string;
  content: string;
  matches: string[];
  updatedAt: number;
}

export interface MemoryState {
  /** 总开关。false → buildMemoryPrompt 返回空串（连冷启动文案都不注入） */
  enabled: boolean;
  /** false 时说明文案不提写工具（工具没下发，避免幻觉调用） */
  writable: boolean;
  entries: MemoryBrief[];
}

/** 注入预算（字符）。最坏情况约 3K token，站点作用域下日常远小于此。 */
export const INJECT_BUDGET_CHARS = 6000;
/** 站点清单最多列多少个 pattern。 */
export const MAX_SITE_LIST = 30;

export function memoryStateToCap(s: MemoryState): MemoryCap {
  if (!s.enabled) return 'off';
  return s.writable ? 'full' : 'read';
}

/** 作用域标签：全局 / 单 pattern / 首个 pattern + 「等 N 条」。 */
function scopeLabel(matches: string[]): string {
  if (matches.length === 0) return '全局';
  if (matches.length === 1) return matches[0]!;
  return `${matches[0]!} 等 ${matches.length} 条`;
}

function renderEntry(m: MemoryBrief): string {
  return `[${m.id} ${scopeLabel(m.matches)}] ${m.content}`;
}

const byRecent = (a: MemoryBrief, b: MemoryBrief): number => b.updatedAt - a.updatedAt;

/** 按预算装箱：返回装进去的条目与消耗的字符数（未装进的留给调用方统计）。 */
function pack(entries: MemoryBrief[], budget: number): { taken: MemoryBrief[]; used: number } {
  const taken: MemoryBrief[] = [];
  let used = 0;
  for (const m of entries) {
    const cost = renderEntry(m).length + 1; // +1 换行
    if (used + cost > budget) continue;
    taken.push(m);
    used += cost;
  }
  return { taken, used };
}

/** 站点清单：pattern → 条数，按条数倒序，最多 MAX_SITE_LIST 个。 */
function siteList(entries: MemoryBrief[]): string {
  const counts = new Map<string, number>();
  for (const m of entries) {
    for (const p of m.matches) counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const shown = sorted.slice(0, MAX_SITE_LIST);
  const line = shown.map(([p, n]) => `${p} (${n})`).join(' · ');
  const rest = sorted.length - shown.length;
  return rest > 0 ? `${line}，另有 ${rest} 个站点` : line;
}

function usageBlock(writable: boolean): string {
  if (!writable) {
    return [
      '- 这些记忆由用户手工维护，你只能读、不能改（本轮未提供写入工具）。',
      '- 想查看未列在上面的站点记忆，用 memory_list（传 scope 可按站点关键词或完整 URL 过滤）。',
    ].join('\n');
  }
  return [
    '- 发现值得长期保留的信息时调用 memory_write 记下：用户的偏好与习惯、某站点的固定操作路径、踩过的坑与解法、账号/环境的稳定事实。写入无需征求用户同意，但要在回复里简短告知你记了什么。',
    '- 不要记一次性的临时信息：本轮的中间结果、页面上随时会变的数字、马上就用完的数据。',
    '- 记忆过时或错误时，用 memory_write（带 id）改写、或 memory_delete 删除，不要留下互相矛盾的两条。',
    '- 只在当前页面命中作用域时，该站的记忆才会出现在上面。**导航到新站点后，该站记忆会在下一步出现在这里**；需要提前知道就用 memory_list（传 scope 可按站点关键词或完整 URL 过滤）。',
  ].join('\n');
}

/**
 * 组装记忆块。三层：全局全文 → 当前页命中全文 → 其余站点清单（无正文）。
 *
 * 预算 INJECT_BUDGET_CHARS 由全局与站点两层【各分半】，某层未用满的额度让给另一层——
 * 全局记忆被挤掉会立刻被用户察觉，站点记忆被挤掉会让 agent 在当前页重复踩坑，都不能牺牲。
 */
export function buildMemoryPrompt(state: MemoryState, url: string): string {
  if (!state.enabled) return '';

  const globals = state.entries.filter((m) => m.matches.length === 0).sort(byRecent);
  const others = state.entries.filter((m) => m.matches.length > 0);
  const hits = others.filter((m) => matchUrl(m.matches, url)).sort(byRecent);
  const misses = others.filter((m) => !matchUrl(m.matches, url));

  // 第一趟：各装半额
  const half = Math.floor(INJECT_BUDGET_CHARS / 2);
  const g1 = pack(globals, half);
  const h1 = pack(hits, half);
  // 第二趟：把两层剩下的额度合并，按同样顺序再补装未进去的条目
  let spare = INJECT_BUDGET_CHARS - g1.used - h1.used;
  const g2 = pack(globals.filter((m) => !g1.taken.includes(m)), spare);
  spare -= g2.used;
  const h2 = pack(hits.filter((m) => !h1.taken.includes(m)), spare);

  const shownGlobals = globals.filter((m) => g1.taken.includes(m) || g2.taken.includes(m));
  const shownHits = hits.filter((m) => h1.taken.includes(m) || h2.taken.includes(m));
  const droppedCount =
    globals.length - shownGlobals.length + (hits.length - shownHits.length);

  const lines: string[] = ['\n\n## 记忆\n'];
  if (state.entries.length === 0) {
    lines.push('你具备跨会话的长期记忆，当前为空。\n');
  } else {
    lines.push('下面是你在之前的会话中记录的、以及用户手工维护的长期记忆，它们跨会话持久存在。\n');
  }
  lines.push(usageBlock(state.writable));

  if (shownGlobals.length > 0 || shownHits.length > 0) {
    lines.push('');
    for (const m of shownGlobals) lines.push(renderEntry(m));
    for (const m of shownHits) lines.push(renderEntry(m));
  }
  if (droppedCount > 0) {
    lines.push(`\n另有 ${droppedCount} 条记忆因长度限制未列出，可用 memory_list 查看。`);
  }
  if (misses.length > 0) {
    lines.push(`\n已有其他站点的记忆（需要时用 memory_list 取全文）：\n${siteList(misses)}`);
  }
  return lines.join('\n');
}
```

- [ ] **Step 4: 在 `agent/mode.ts` 加 `MemoryCap` 类型**

`memory-prompt.ts` 从 `./mode` 导入了 `MemoryCap`，先把它加上（本任务只加类型，工具过滤逻辑在 Task 10）。在 `agent/mode.ts` 的 `export type AgentMode` 之后插入：

```ts
/** 记忆工具的可用档位：off = 不下发、read = 只给 memory_list、full = 三个都给。 */
export type MemoryCap = 'off' | 'read' | 'full';
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run tests/agent/memory-prompt.test.ts`
Expected: PASS（16 个用例）

Run: `npm run compile`
Expected: 无输出

- [ ] **Step 6: 提交**

```bash
git add agent/memory-prompt.ts agent/mode.ts tests/agent/memory-prompt.test.ts
git commit -m "feat(agent): 记忆注入纯函数（三层分组 + 半预算装箱 + 站点清单聚合）"
```

---

## Task 8: 记忆块接入 `buildContext`

**Files:**
- Modify: `agent/context.ts`
- Test: `tests/agent/context.test.ts`

- [ ] **Step 1: 写失败测试**

在 `tests/agent/context.test.ts` 末尾追加：

```ts
describe('buildContext opts.memory', () => {
  const memState = {
    enabled: true,
    writable: true,
    entries: [{ id: 'g1', content: '偏好中文回复', matches: [], updatedAt: 1 }],
  };

  it('记忆块进 system 消息，位置在技能块之后、模式块之前', () => {
    const sys = String(buildContext([], page, {
      skills: [{ name: 'N', command: 'c', description: 'd' }],
      memory: memState,
      mode: 'agent',
    })[0]!.content);
    expect(sys).toContain('偏好中文回复');
    expect(sys.indexOf('可用技能')).toBeLessThan(sys.indexOf('## 记忆'));
    expect(sys.indexOf('## 记忆')).toBeLessThan(sys.indexOf('当前模式'));
  });

  it('不传 memory → 无记忆块', () => {
    expect(String(buildContext([], page)[0]!.content)).not.toContain('## 记忆');
  });

  it('记忆块按当前页 URL 过滤（命中出全文，未命中只出站点清单）', () => {
    const sys = String(buildContext([], { url: 'https://www.bilibili.com/x', title: 'B' }, {
      memory: {
        enabled: true, writable: true,
        entries: [
          { id: 's1', content: 'B 站专属经验', matches: ['*://*.bilibili.com/*'], updatedAt: 1 },
          { id: 'o1', content: 'GitHub 专属经验', matches: ['*://github.com/*'], updatedAt: 1 },
        ],
      },
    })[0]!.content);
    expect(sys).toContain('B 站专属经验');
    expect(sys).not.toContain('GitHub 专属经验');
    expect(sys).toContain('*://github.com/*');
  });

  it('自定义提示词 + 记忆并存（覆盖提示词不影响记忆块）', () => {
    const sys = String(buildContext([], page, {
      systemPrompt: '【自定义】',
      memory: memState,
    })[0]!.content);
    expect(sys).toContain('【自定义】');
    expect(sys).toContain('偏好中文回复');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/agent/context.test.ts -t "opts.memory"`
Expected: FAIL — `BuildContextOptions` 上不存在 `memory`（TS 报错）

- [ ] **Step 3: 改 `agent/context.ts`**

顶部 import 加：

```ts
import { buildMemoryPrompt, type MemoryState } from './memory-prompt';
```

`BuildContextOptions` 加字段：

```ts
  /** 记忆状态（全量条目 + 两个开关）。按 page.url 在 buildMemoryPrompt 内做三层过滤。 */
  memory?: MemoryState;
```

解构与 system 组装改为：

```ts
  const { keepRecent = 60, summary, skills, mode = 'agent', systemPrompt, memory } = opts;
```

```ts
  const memoryBlock = memory ? buildMemoryPrompt(memory, page.url) : '';
  const base = resolveSystemPrompt(systemPrompt);
  const system: ChatMessage = {
    role: 'system',
    content: base + pageBlock + skillsBlock + memoryBlock + modePrompt(mode),
  };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/agent/context.test.ts tests/agent/skills-context.test.ts tests/agent/mode.test.ts`
Expected: PASS

Run: `npm run compile`
Expected: 无输出

- [ ] **Step 5: 提交**

```bash
git add agent/context.ts tests/agent/context.test.ts
git commit -m "feat(agent): 记忆块接入 buildContext（技能块之后、模式块之前）"
```

---

## Task 9: 三个记忆工具的实现

**Files:**
- Create: `agent/tools/memory.ts`
- Create: `tests/agent/tools/memory-tool.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `tests/agent/tools/memory-tool.test.ts`：

```ts
// tests/agent/tools/memory-tool.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { doMemoryList, doMemoryWrite, doMemoryDelete } from '../../../agent/tools/memory';
import { listMemories, saveMemory, newMemory, MAX_CONTENT_LENGTH } from '../../../storage/memory';

describe('doMemoryWrite', () => {
  beforeEach(() => fakeBrowser.reset());

  it('无 id → 新增，source 恒为 ai，返回 created:true', async () => {
    const r = await doMemoryWrite({ content: '偏好中文' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toMatchObject({ created: true, total: 1, matches: [] });
    const all = await listMemories();
    expect(all[0]).toMatchObject({ content: '偏好中文', source: 'ai' });
  });

  it('带 matches 新增', async () => {
    const r = await doMemoryWrite({ content: 'B 站经验', matches: ['*://*.bilibili.com/*'] });
    expect(r.ok).toBe(true);
    expect((await listMemories())[0]!.matches).toEqual(['*://*.bilibili.com/*']);
  });

  it('带 id → 改写正文，created:false，保留 createdAt 与 source', async () => {
    await saveMemory({ ...newMemory({ content: '旧', matches: [], source: 'user' }), id: 'm1', createdAt: 111 });
    const r = await doMemoryWrite({ id: 'm1', content: '新' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toMatchObject({ created: false, id: 'm1' });
    const hit = (await listMemories())[0]!;
    expect(hit).toMatchObject({ content: '新', createdAt: 111, source: 'user' });
    expect(hit.updatedAt).toBeGreaterThanOrEqual(111);
  });

  it('带 id 不传 matches → 保持原 matches', async () => {
    await saveMemory({ ...newMemory({ content: 'A', matches: ['*://a.com/*'], source: 'ai' }), id: 'm1' });
    await doMemoryWrite({ id: 'm1', content: 'B' });
    expect((await listMemories())[0]!.matches).toEqual(['*://a.com/*']);
  });

  it('带 id 传 matches → 全量替换', async () => {
    await saveMemory({ ...newMemory({ content: 'A', matches: ['*://a.com/*'], source: 'ai' }), id: 'm1' });
    await doMemoryWrite({ id: 'm1', content: 'A', matches: ['*://b.com/*'] });
    expect((await listMemories())[0]!.matches).toEqual(['*://b.com/*']);
  });

  it('id 不存在 → 报错，不静默新增', async () => {
    const r = await doMemoryWrite({ id: 'nope', content: 'X' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('nope');
    expect(await listMemories()).toEqual([]);
  });

  it('缺 content → 报错', async () => {
    const r = await doMemoryWrite({});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('content');
  });

  it('非法 pattern → 报错（storage 层校验冒泡成 ok:false）', async () => {
    const r = await doMemoryWrite({ content: 'X', matches: ['乱写'] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('乱写');
  });

  it('超长正文 → 报错', async () => {
    const r = await doMemoryWrite({ content: 'x'.repeat(MAX_CONTENT_LENGTH + 1) });
    expect(r.ok).toBe(false);
  });

  it('返回的 content 截断到 120 字（不回灌全文）', async () => {
    const r = await doMemoryWrite({ content: 'y'.repeat(400) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data!.content.length).toBeLessThanOrEqual(121); // 120 + 省略号
  });
});

describe('doMemoryDelete', () => {
  beforeEach(() => fakeBrowser.reset());

  it('删存在的 → deleted:true，total 减一', async () => {
    await saveMemory({ ...newMemory({ content: 'A', matches: [], source: 'ai' }), id: 'm1' });
    const r = await doMemoryDelete({ id: 'm1' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toMatchObject({ id: 'm1', deleted: true, total: 0 });
  });

  it('删不存在的 → 幂等成功，deleted:false', async () => {
    const r = await doMemoryDelete({ id: 'nope' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toMatchObject({ deleted: false, total: 0 });
  });

  it('缺 id → 报错', async () => {
    const r = await doMemoryDelete({} as { id: string });
    expect(r.ok).toBe(false);
  });
});

describe('doMemoryList', () => {
  beforeEach(async () => {
    fakeBrowser.reset();
    await saveMemory({ ...newMemory({ content: '全局偏好', matches: [], source: 'user' }), id: 'g1', updatedAt: 300 });
    await saveMemory({ ...newMemory({ content: 'B 站经验', matches: ['*://*.bilibili.com/*'], source: 'ai' }), id: 's1', updatedAt: 200 });
    await saveMemory({ ...newMemory({ content: 'GH 经验', matches: ['*://github.com/*'], source: 'ai' }), id: 's2', updatedAt: 100 });
  });

  it('无参 → 全库，按 updatedAt 倒序', async () => {
    const r = await doMemoryList({});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data!.total).toBe(3);
    expect(r.data!.entries.map((e) => e.id)).toEqual(['g1', 's1', 's2']);
  });

  it('scope 传完整 URL → 走 matchUrl 精确命中', async () => {
    const r = await doMemoryList({ scope: 'https://www.bilibili.com/video/BV1' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data!.entries.map((e) => e.id)).toEqual(['s1']);
  });

  it('scope 传关键词 → 走 pattern 子串匹配，大小写不敏感', async () => {
    const r = await doMemoryList({ scope: 'BiliBili' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data!.entries.map((e) => e.id)).toEqual(['s1']);
  });

  it('带 scope 时排除全局记忆（它们已常驻注入）', async () => {
    const r = await doMemoryList({ scope: 'github' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data!.entries.map((e) => e.id)).toEqual(['s2']);
    expect(r.data!.entries.some((e) => e.id === 'g1')).toBe(false);
  });

  it('scope 无命中 → 空列表但 ok:true', async () => {
    const r = await doMemoryList({ scope: 'zhihu' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data!.entries).toEqual([]);
    expect(r.data!.returned).toBe(0);
  });

  it('limit 截断，total 仍报全量', async () => {
    const r = await doMemoryList({ limit: 2 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data!.returned).toBe(2);
    expect(r.data!.total).toBe(3);
  });

  it('limit 超上限收窄到 100，非正数回落默认', async () => {
    const a = await doMemoryList({ limit: 9999 });
    expect(a.ok).toBe(true);
    const b = await doMemoryList({ limit: 0 });
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(b.data!.returned).toBe(3); // 回落默认 30，全库 3 条都在
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/agent/tools/memory-tool.test.ts`
Expected: FAIL — 无法解析 `agent/tools/memory`

- [ ] **Step 3: 创建 `agent/tools/memory.ts`**

```ts
// agent/tools/memory.ts
// 三个记忆工具（spec §3.4）：list / write / delete。纯 storage 操作，不碰页面。
// 返回值刻意瘦身（照 toWriteResult 的教训）：不回灌全库、正文截断 120 字——
// 同一份内容在上下文里存两遍纯属浪费。
import type { ToolResult } from '../../shared/types';
import { matchUrl } from '../../shared/match-pattern';
import {
  listMemories, getMemoryEntry, saveMemory, deleteMemory, newMemory,
} from '../../storage/memory';
import type { MemoryEntry } from '../../shared/types';

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;
const SUMMARY_CHARS = 120;

export interface MemoryListEntry {
  id: string;
  content: string;
  matches: string[];
  source: 'ai' | 'user';
  updatedAt: number;
}

export interface MemoryListData {
  total: number;
  returned: number;
  entries: MemoryListEntry[];
}

export interface MemoryWriteData {
  id: string;
  /** 截断到 120 字的正文回显（确认写对了，不回灌全文） */
  content: string;
  matches: string[];
  created: boolean;
  total: number;
}

export interface MemoryDeleteData {
  id: string;
  deleted: boolean;
  total: number;
}

function truncate(s: string): string {
  return s.length <= SUMMARY_CHARS ? s : `${s.slice(0, SUMMARY_CHARS)}…`;
}

const byRecent = (a: MemoryEntry, b: MemoryEntry): number => b.updatedAt - a.updatedAt;

/**
 * scope 两趟匹配：先当完整 URL 走 matchUrl（精确），未命中再对 pattern 做大小写不敏感子串匹配
 * （关键词，如 'bilibili'）。全局记忆不参与——它们已常驻注入，混进来只挤占返回额度。
 */
function scopeMatch(entry: MemoryEntry, scope: string): boolean {
  if (entry.matches.length === 0) return false;
  if (matchUrl(entry.matches, scope)) return true;
  const kw = scope.toLowerCase();
  return entry.matches.some((p) => p.toLowerCase().includes(kw));
}

export async function doMemoryList(
  args: { scope?: string; limit?: number },
): Promise<ToolResult<MemoryListData>> {
  const all = await listMemories().catch(() => [] as MemoryEntry[]);
  const scope = args.scope?.trim();
  const filtered = scope ? all.filter((m) => scopeMatch(m, scope)) : all;
  const raw = Number(args.limit);
  const limit = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), MAX_LIMIT) : DEFAULT_LIMIT;
  const entries = [...filtered].sort(byRecent).slice(0, limit).map((m) => ({
    id: m.id, content: m.content, matches: m.matches, source: m.source, updatedAt: m.updatedAt,
  }));
  return { ok: true, data: { total: filtered.length, returned: entries.length, entries } };
}

export async function doMemoryWrite(
  args: { content?: string; matches?: string[]; id?: string },
): Promise<ToolResult<MemoryWriteData>> {
  const content = (args.content ?? '').trim();
  if (!content) return { ok: false, error: 'memory_write 缺少 content 参数（记忆正文）' };

  try {
    let entry: MemoryEntry;
    let created: boolean;
    if (args.id) {
      const old = await getMemoryEntry(args.id);
      if (!old) {
        return { ok: false, error: `没有 id 为「${args.id}」的记忆；不传 id 即新增一条，或先用 memory_list 查现有 id` };
      }
      // 保留 createdAt 与 source（来源是事实记录，不因 AI 改写而变）；matches 传了才改
      entry = { ...old, content, matches: args.matches ?? old.matches, updatedAt: Date.now() };
      created = false;
    } else {
      entry = newMemory({ content, matches: args.matches ?? [], source: 'ai' });
      created = true;
    }
    await saveMemory(entry);
    const total = (await listMemories()).length;
    return {
      ok: true,
      data: { id: entry.id, content: truncate(entry.content), matches: entry.matches, created, total },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function doMemoryDelete(
  args: { id: string },
): Promise<ToolResult<MemoryDeleteData>> {
  const id = (args.id ?? '').trim();
  if (!id) return { ok: false, error: 'memory_delete 缺少 id 参数' };
  try {
    const existed = (await getMemoryEntry(id)) != null;
    await deleteMemory(id);
    const total = (await listMemories()).length;
    return { ok: true, data: { id, deleted: existed, total } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/agent/tools/memory-tool.test.ts`
Expected: PASS（21 个用例）

Run: `npm run compile`
Expected: 无输出

- [ ] **Step 5: 提交**

```bash
git add agent/tools/memory.ts tests/agent/tools/memory-tool.test.ts
git commit -m "feat(agent): 三个记忆工具实现（list 两趟 scope 匹配 / write 新增改写 / delete 幂等）"
```

---

## Task 10: 工具 schema 注册与分发（27 → 30）

**Files:**
- Modify: `agent/tools/schemas.ts:2`（头注释）与数组末尾
- Modify: `agent/tools/registry.ts`
- Modify: `components/debug/tool-tags.ts`
- Modify: `entrypoints/sidepanel/styles.css`
- Modify: `tests/agent/tools/schemas.test.ts:5`
- Modify: `tests/agent/tools/registry.test.ts:15`
- Modify: `tests/agent/mode.test.ts:32-34`
- Modify: `tests/debug/tool-tags.test.ts:12-28`

- [ ] **Step 1: 写失败测试**

在 `tests/agent/tools/registry.test.ts` 末尾追加：

```ts
describe('记忆工具分发', () => {
  beforeEach(() => fakeBrowser.reset());

  it('memory_write → 落库；memory_list → 读回；memory_delete → 删除', async () => {
    const ctx = { tabId: 1, sessionId: 'c1', signal: new AbortController().signal };
    const w = await executeTool('memory_write', { content: '偏好中文' }, ctx);
    expect(w.ok).toBe(true);
    const id = (w as { data: { id: string } }).data.id;

    const l = await executeTool('memory_list', {}, ctx);
    expect(l.ok).toBe(true);
    expect((l as { data: { total: number } }).data.total).toBe(1);

    const d = await executeTool('memory_delete', { id }, ctx);
    expect(d.ok).toBe(true);
    expect((await executeTool('memory_list', {}, ctx) as { data: { total: number } }).data.total).toBe(0);
  });

  it('记忆工具豁免受限页预检（chrome:// 上也能用）', async () => {
    // 不 mock tabs.get：记忆工具在 RESTRICTED 检查之前分发，拿不到 tab 也不影响
    const ctx = { tabId: 999, sessionId: 'c1', signal: new AbortController().signal };
    const r = await executeTool('memory_list', {}, ctx);
    expect(r.ok).toBe(true);
  });
});
```

该文件顶部已有全部所需 import（`describe/it/expect/beforeEach/vi`、`fakeBrowser`、`executeTool`、`getToolSchemas`），无需改动。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/agent/tools/registry.test.ts -t "记忆工具分发"`
Expected: FAIL — `未知工具：memory_write`

- [ ] **Step 3: 加三个 schema**

`agent/tools/schemas.ts` 的 `TOOL_SCHEMAS` 数组末尾（`load_skill` 那一项之后、右方括号之前）插入：

```ts
  // ---- Memory（跨会话长期记忆，spec §3.4）----
  {
    type: 'function',
    function: {
      name: 'memory_list',
      description:
        '列出长期记忆（含未在系统提示里出现的其他站点记忆）。用途：① 写入前查重，避免记两条矛盾的；② 导航到某站点【之前】提前取该站经验——系统提示只会列出当前页命中的记忆全文，其他站点只给站点清单。scope 可传完整 URL（精确匹配作用域）或站点关键词如 bilibili（对作用域做子串匹配）；不传 scope 则返回全库。注意：带 scope 时不返回全局记忆，因为全局记忆已常驻在系统提示里。',
      parameters: obj({
        scope: { type: 'string', description: '完整 URL 或站点关键词；缺省返回全库' },
        limit: { type: 'number', description: `返回条数上限，默认 ${30}，最大 100` },
      }),
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_write',
      description:
        '记录或改写一条长期记忆（跨会话持久保留）。不传 id = 新增；传 id = 改写那一条（content 必传；matches 传了才改、不传保持原作用域）。该记：用户的偏好与习惯、某站点的固定操作路径、踩过的坑与解法、账号与环境的稳定事实。不该记：本轮的中间结果、页面上随时会变的数字、马上就用完的临时数据。matches 是站点作用域（Chrome match pattern，如 *://*.bilibili.com/*），留空则为全局记忆、任何页面都会注入——只在某站适用的经验务必填 matches，否则会在别的站误导你自己。正文上限 500 字符，写不下就拆成两条。',
      parameters: obj(
        {
          content: { type: 'string', description: '记忆正文，≤500 字符，一条只说一件事' },
          matches: {
            type: 'array',
            items: { type: 'string' },
            description: '站点作用域（Chrome match pattern）。留空 = 全局记忆',
          },
          id: { type: 'string', description: '要改写的记忆 id（来自系统提示的 [id …] 或 memory_list）；不传则新增' },
        },
        ['content'],
      ),
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_delete',
      description: '删除一条长期记忆。记忆过时或与新发现矛盾时，改写（memory_write 带 id）优先于删除；确认无用再删。幂等：id 不存在也返回成功。',
      parameters: obj(
        { id: { type: 'string', description: '记忆 id（来自系统提示的 [id …] 或 memory_list）' } },
        ['id'],
      ),
    },
  },
```

把 `agent/tools/schemas.ts:2` 的头注释改为：

```ts
// 30 个工具的 OpenAI function calling schema：Phase 2 的 9 个 + Phase 3a 的 7 个（tabs/screenshot/evaluate/http_request）+ Phase 3b 的 3 个（console/network 观测）+ Phase 4 的 6 个（脚本池）+ Skill 的 1 个 + 脚本检索的 1 个 + 记忆的 3 个。描述对齐 chrome-devtools-mcp。
```

- [ ] **Step 4: 加 registry 分发**

`agent/tools/registry.ts` 顶部 import 加：

```ts
import { doMemoryList, doMemoryWrite, doMemoryDelete } from './memory';
```

在 `load_skill` 分发那一行之后（`// ---- 以下工具操作当前目标页` 注释之前）插入：

```ts
  // 记忆三工具：纯 storage 读写，不碰页面，豁免受限页预检（spec §3.4）。
  if (name === 'memory_list') return doMemoryList(args as { scope?: string; limit?: number });
  if (name === 'memory_write') {
    return doMemoryWrite(args as { content?: string; matches?: string[]; id?: string });
  }
  if (name === 'memory_delete') return doMemoryDelete(args as { id: string });
```

- [ ] **Step 5: 三个记忆工具进 ask 白名单**

`agent/mode.ts` 的 `ASK_MODE_TOOLS` 集合内，`'load_skill',` 之后插入：

```ts
  // 记忆三工具：ask 的语义是「不改网页/浏览器状态」，记忆只改扩展自己的本地笔记；
  // 且「以后都这样」这类交代大多发生在问答里，收走写权限会很别扭（spec §3.4）。
  'memory_list',
  'memory_write',
  'memory_delete',
```

- [ ] **Step 6: 加 MEMORY tag**

`components/debug/tool-tags.ts` 全文替换为：

```ts
// components/debug/tool-tags.ts
// 工具能力域分组（spec §2）：调试台分组 + tag chip 的唯一数据源。
// 缺省兜底 'PAGE'：未来新工具忘登记时按「碰当前页」保守归类（getTag 用）。

export type ToolTag = 'PAGE' | 'TABS' | 'NET' | 'SCRIPTS' | 'SKILLS' | 'MEMORY';

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
  // SCRIPTS(7)：userScripts CRUD 与启停 + 检索
  list_scripts: 'SCRIPTS', get_script: 'SCRIPTS', grep_script: 'SCRIPTS', create_script: 'SCRIPTS',
  update_script: 'SCRIPTS', delete_script: 'SCRIPTS', toggle_script: 'SCRIPTS',
  // SKILLS(1)：技能正文加载
  load_skill: 'SKILLS',
  // MEMORY(3)：跨会话长期记忆
  memory_list: 'MEMORY', memory_write: 'MEMORY', memory_delete: 'MEMORY',
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
  { key: 'SKILLS', label: '技能', hint: '按 command 加载技能指令正文' },
  { key: 'MEMORY', label: '记忆', hint: '跨会话长期记忆的读写' },
];

/** tag → chip 修饰类（styles.css 六档）。 */
export const CHIP_CLASS: Record<ToolTag, string> = {
  PAGE: 'chip--page', TABS: 'chip--tabs', NET: 'chip--net',
  SCRIPTS: 'chip--script', SKILLS: 'chip--skill', MEMORY: 'chip--memory',
};
```

`entrypoints/sidepanel/styles.css` 第 912 行（`.chip--skill` 那行）之后插入：

```css
.chip--memory { color: var(--signal-ink); border-color: var(--signal); background: var(--signal-wash); }
```

- [ ] **Step 7: 修正被打破的既有断言**

`tests/agent/tools/schemas.test.ts:5`：

```ts
  it('恰好 30 个工具（Phase 2 的 9 + Phase 3a 的 7 + Phase 3b 的 3 + Phase 4 的 6 + Skill 的 1 + 脚本检索的 1 + 记忆的 3）', () => {
```
并把该用例内的 `toHaveLength(27)` / `toBe(27)` 改为 30。

`tests/agent/tools/registry.test.ts:15`：`expect(getToolSchemas().length).toBe(27);` → `toBe(30);`

`tests/agent/mode.test.ts:32-34`：

```ts
  it('agent 模式返回全量 30 个（schemas.ts 当前 30 工具）', () => {
    expect(getToolSchemas('agent')).toHaveLength(30);
    expect(getToolSchemas()).toHaveLength(30); // 缺省 = agent
```

`tests/debug/tool-tags.test.ts:12-19,26-28`：

```ts
  it('六类计数 PAGE 10 / TABS 5 / NET 4 / SCRIPTS 7 / SKILLS 1 / MEMORY 3', () => {
    const count = (tag: string) => Object.values(TOOL_TAGS).filter((v) => v === tag).length;
    expect(count('PAGE')).toBe(10);
    expect(count('TABS')).toBe(5);
    expect(count('NET')).toBe(4);
    expect(count('SCRIPTS')).toBe(7);
    expect(count('SKILLS')).toBe(1);
    expect(count('MEMORY')).toBe(3);
  });
```

```ts
  it('GROUPS 按组序 PAGE/TABS/NET/SCRIPTS/SKILLS/MEMORY', () => {
    expect(GROUPS.map((g) => g.key)).toEqual(['PAGE', 'TABS', 'NET', 'SCRIPTS', 'SKILLS', 'MEMORY']);
  });
```

`tests/agent/mode.test.ts` 的「ask 模式只返回白名单内的 schema」用例断言的是 `ASK_MODE_TOOLS.size`（动态取值），**不需要改**。

但要给同文件「只含只读工具：不含任何写操作」那条用例（第 9-16 行）加一句注释，挡住后人把记忆写工具塞进 `writeTools` 列表：

```ts
  it('只含只读工具：不含任何写操作', () => {
    // 注意：memory_write / memory_delete 虽名为「写」，但刻意在白名单内——
    // ask 的语义是「不改网页/浏览器状态」，记忆只改扩展自己的本地笔记（spec §3.4）。
    // 不要把它们加进下面这个列表。
    const writeTools = ['click', 'fill', 'fill_form', 'hover', 'scroll', 'press_key', 'navigate_page',
```

再补一条正向断言（加在「grep_script 属只读」用例之后）：

```ts
  it('记忆三工具在 ask 白名单内（本地笔记不算改浏览器状态）', () => {
    for (const t of ['memory_list', 'memory_write', 'memory_delete']) {
      expect(ASK_MODE_TOOLS.has(t)).toBe(true);
    }
  });
```

`components/debug/ToolBenchPage.tsx:2` 的注释里「27 个」改为「30 个」。

- [ ] **Step 8: 运行全量测试与类型检查**

Run: `npm run test`
Expected: PASS（全部）

Run: `npm run compile`
Expected: 无输出

- [ ] **Step 9: 提交**

```bash
git add agent/tools/schemas.ts agent/tools/registry.ts agent/mode.ts components/debug/tool-tags.ts components/debug/ToolBenchPage.tsx entrypoints/sidepanel/styles.css tests/
git commit -m "feat(agent): 记忆三工具注册与分发（27→30，新增 MEMORY 能力域）"
```

---

## Task 11: 两个开关 + cap 守卫 + loop 接线

到这里记忆已经能被工具读写，但还没接进 loop（模型看不到记忆块），也还没有开关。本任务收口。

**Files:**
- Modify: `storage/settings.ts`（`AgentConfig` 加两个布尔）
- Modify: `agent/mode.ts`（`filterSchemasForMemory` + 两个集合）
- Modify: `agent/tools/registry.ts`（`getToolSchemas` 第二参 + `ToolCtx.memory` + 硬闸）
- Modify: `agent/loop.ts`（`LoopDeps.getMemoryState` + 每轮读取）
- Modify: `background/agent-port.ts`（makeDeps 注入 + ctx 带 cap）
- Test: `tests/storage/settings.test.ts`、`tests/agent/mode.test.ts`、`tests/agent/loop.test.ts`

- [ ] **Step 1: 写失败测试（settings 两个开关）**

在 `tests/storage/settings.test.ts` 的 `describe('prompt 段…')` 之后追加：

```ts
describe('记忆开关', () => {
  beforeEach(() => fakeBrowser.reset());

  it('默认 memoryEnabled / memoryWritable 均为 true', async () => {
    const s = await getSettings();
    expect(s.agent.memoryEnabled).toBe(true);
    expect(s.agent.memoryWritable).toBe(true);
  });

  it('可分别关闭', async () => {
    await saveSettings({ agent: { memoryWritable: false } });
    let s = await getSettings();
    expect(s.agent.memoryEnabled).toBe(true);
    expect(s.agent.memoryWritable).toBe(false);
    await saveSettings({ agent: { memoryEnabled: false } });
    s = await getSettings();
    expect(s.agent.memoryEnabled).toBe(false);
    expect(s.agent.memoryWritable).toBe(false);
  });

  it('存量数据缺这两个字段时补 true（前向兼容）', async () => {
    await storage.setItem('local:settings', { agent: { confirmGate: false } });
    const s = await getSettings();
    expect(s.agent.memoryEnabled).toBe(true);
    expect(s.agent.memoryWritable).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/storage/settings.test.ts -t "记忆开关"`
Expected: FAIL — `AgentConfig` 上不存在 `memoryEnabled`

- [ ] **Step 3: 改 `storage/settings.ts`**

`AgentConfig` 接口末尾（`maxTokens` 之后）加：

```ts
  /** 记忆总开关。false = 不注入记忆块、不下发三个记忆工具。 */
  memoryEnabled: boolean;
  /** AI 是否可写记忆。false = 只注入 + 只下发 memory_list，记忆改由人工维护。 */
  memoryWritable: boolean;
```

`DEFAULT_SETTINGS.agent` 内加：

```ts
    memoryEnabled: true,
    memoryWritable: true,
```

- [ ] **Step 4: 修正被打破的既有断言**

`tests/storage/settings.test.ts` 有两处硬编码了 `agent` 段的完整形状，各加两个字段：

第 44 行：

```ts
    expect(s.agent).toEqual({ screenshotPolicy: 'on-demand', confirmGate: false, networkCaptureHeaders: 'redacted', llmTimeoutSec: 60, llmMaxRetries: 2, maxTokens: 8192, memoryEnabled: true, memoryWritable: true });
```

第 70 行：

```ts
    expect(s.agent).toEqual({ screenshotPolicy: 'on-demand', confirmGate: false, networkCaptureHeaders: 'redacted', llmTimeoutSec: 60, llmMaxRetries: 2, maxTokens: 8192, memoryEnabled: true, memoryWritable: true });
```

Run: `npx vitest run tests/storage/settings.test.ts`
Expected: PASS

- [ ] **Step 5: 写失败测试（cap 过滤与守卫）**

在 `tests/agent/mode.test.ts` 末尾追加：

```ts
describe('记忆 cap 过滤与守卫', () => {
  it("cap='full' → 三个记忆工具都在", () => {
    const names = getToolSchemas('agent', 'full').map((s) => s.function.name);
    expect(names).toContain('memory_list');
    expect(names).toContain('memory_write');
    expect(names).toContain('memory_delete');
  });

  it("cap='read' → 只留 memory_list", () => {
    const names = getToolSchemas('agent', 'read').map((s) => s.function.name);
    expect(names).toContain('memory_list');
    expect(names).not.toContain('memory_write');
    expect(names).not.toContain('memory_delete');
  });

  it("cap='off' → 三个都不下发，其余工具不受影响", () => {
    const names = getToolSchemas('agent', 'off').map((s) => s.function.name);
    expect(names).not.toContain('memory_list');
    expect(names).not.toContain('memory_write');
    expect(names).not.toContain('memory_delete');
    expect(names).toContain('take_snapshot');
    expect(names).toHaveLength(27);
  });

  it('缺省 cap = full（调试台等既有调用点不受影响）', () => {
    expect(getToolSchemas('agent')).toHaveLength(30);
  });

  it('cap 与 mode 二维叠加：ask + read', () => {
    const names = getToolSchemas('ask', 'read').map((s) => s.function.name);
    expect(names).toContain('memory_list');
    expect(names).not.toContain('memory_write');
    expect(names).not.toContain('click');
  });

  it("executeTool 硬闸：cap='off' 拒全部记忆工具", async () => {
    const ctx: ToolCtx = { tabId: 1, sessionId: 's', signal: new AbortController().signal, memory: 'off' };
    for (const t of ['memory_list', 'memory_write', 'memory_delete']) {
      const r = await executeTool(t, { content: 'x', id: 'y' }, ctx);
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.error).toContain('记忆');
    }
  });

  it("executeTool 硬闸：cap='read' 拒写、放读", async () => {
    const ctx: ToolCtx = { tabId: 1, sessionId: 's', signal: new AbortController().signal, memory: 'read' };
    const w = await executeTool('memory_write', { content: 'x' }, ctx);
    expect(w.ok).toBe(false);
    const d = await executeTool('memory_delete', { id: 'y' }, ctx);
    expect(d.ok).toBe(false);
    const l = await executeTool('memory_list', {}, ctx);
    expect(l.ok).toBe(true);
  });

  it('不传 memory cap → 不设限（默认 full）', async () => {
    const ctx: ToolCtx = { tabId: 1, sessionId: 's', signal: new AbortController().signal };
    expect((await executeTool('memory_list', {}, ctx)).ok).toBe(true);
  });
});
```

该文件顶部需要 `fakeBrowser`（新用例会真读 storage）。把首行 import 区补成：

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
```

并在新 describe 内加 `beforeEach(() => fakeBrowser.reset());`。

- [ ] **Step 6: 运行测试确认失败**

Run: `npx vitest run tests/agent/mode.test.ts -t "记忆 cap"`
Expected: FAIL — `getToolSchemas` 只接受一个参数（TS 报错）

- [ ] **Step 7: 改 `agent/mode.ts`**

在 `MemoryCap` 类型定义之后插入：

```ts
/** 三个记忆工具。 */
export const MEMORY_TOOLS = new Set(['memory_list', 'memory_write', 'memory_delete']);
/** 其中的写操作。 */
export const MEMORY_WRITE_TOOLS = new Set(['memory_write', 'memory_delete']);

/** 按记忆档位过滤工具 schema。 */
export function filterSchemasForMemory<T extends ToolSchemaLike>(schemas: T[], cap: MemoryCap): T[] {
  if (cap === 'full') return schemas;
  if (cap === 'off') return schemas.filter((s) => !MEMORY_TOOLS.has(s.function.name));
  return schemas.filter((s) => !MEMORY_WRITE_TOOLS.has(s.function.name));
}

/** 记忆工具的硬闸判定：返回拒绝文案，或 null 表示放行。
 *  工具清单已按档位下发，这里是防幻觉调用的兜底（与 ask 模式守卫同一形状）。 */
export function memoryToolDenial(name: string, cap: MemoryCap): string | null {
  if (!MEMORY_TOOLS.has(name)) return null;
  if (cap === 'off') {
    return `记忆功能已在设置中关闭，工具 ${name} 不可用；如需使用请到设置页「AI 记忆」打开总开关`;
  }
  if (cap === 'read' && MEMORY_WRITE_TOOLS.has(name)) {
    return `记忆当前为只读（设置中已关闭「允许 AI 写入」），工具 ${name} 不可用；可以用 memory_list 查看已有记忆`;
  }
  return null;
}
```

注意 `filterSchemasForMode` 现有签名是 `(schemas: ToolSchemaLike[], mode)`，返回 `ToolSchemaLike[]`；新函数用泛型 `<T extends ToolSchemaLike>` 才能在 registry 里保住 `ToolSchema` 类型不被擦成 `ToolSchemaLike`。

- [ ] **Step 8: 改 `agent/tools/registry.ts`**

顶部 import 改为（加三个符号）：

```ts
import { ASK_MODE_TOOLS, filterSchemasForMemory, memoryToolDenial, type AgentMode, type MemoryCap } from '../mode';
```

`ToolCtx` 加字段：

```ts
  /** 记忆档位守卫：off 拒全部记忆工具、read 拒写（默认 'full' 不设限）。 */
  memory?: MemoryCap;
```

`getToolSchemas` 改为：

```ts
/** 全量 schema（调试台/默认用）。ask 模式清单见 agent/mode.ts。
 *  memory 缺省 'full'：调试台等既有调用点不受记忆开关影响。 */
export function getToolSchemas(mode: AgentMode = 'agent', memory: MemoryCap = 'full'): ToolSchema[] {
  const byMode = mode === 'agent' ? TOOL_SCHEMAS : TOOL_SCHEMAS.filter((s) => ASK_MODE_TOOLS.has(s.function.name));
  return filterSchemasForMemory(byMode, memory);
}
```

在 `executeTool` 内的 ask 守卫之后（`// ---- 豁免受限页预检的工具` 注释之前）插入：

```ts
  // ---- 记忆档位守卫：工具清单已按档位下发，这里兜底拦幻觉调用 ----
  const memDenial = memoryToolDenial(name, ctx.memory ?? 'full');
  if (memDenial) return { ok: false, error: memDenial };
```

- [ ] **Step 9: 运行测试确认通过**

Run: `npx vitest run tests/agent/mode.test.ts tests/agent/tools/registry.test.ts`
Expected: PASS

- [ ] **Step 10: 写失败测试（loop 接线）**

在 `tests/agent/loop.test.ts` 末尾追加：

```ts
describe('loop 注入记忆', () => {
  beforeEach(() => fakeBrowser.reset());

  const capture = (captured: ChatParams[]): Provider => ({
    streamChat(p: ChatParams, onEvent: (e: StreamEvent) => void) {
      captured.push(p);
      queueMicrotask(() => onEvent({ type: 'text-delta', text: 'ok' }));
      queueMicrotask(() => onEvent({ type: 'message-done', finishReason: 'stop' }));
      return { cancel: vi.fn() };
    },
  });

  it('getMemoryState 的条目进 system 消息，且三个记忆工具在工具清单里', async () => {
    const captured: ChatParams[] = [];
    await runAgentLoop(
      { convId: 'cm1', tabId: 1, userMessage: 'hi' },
      {
        provider: capture(captured),
        executeTool: vi.fn<LoopDeps['executeTool']>(),
        getPageInfo: async () => ({ url: '', title: '' }),
        emit: vi.fn(),
        getMemoryState: async () => ({
          enabled: true, writable: true,
          entries: [{ id: 'g1', content: '偏好中文回复', matches: [], updatedAt: 1 }],
        }),
      },
    );
    const sys = String(captured[0]!.messages[0]!.content);
    expect(sys).toContain('偏好中文回复');
    const names = (captured[0]!.tools ?? []).map((t) => t.function.name);
    expect(names).toContain('memory_write');
  });

  it('enabled:false → 无记忆块且不下发记忆工具', async () => {
    const captured: ChatParams[] = [];
    await runAgentLoop(
      { convId: 'cm2', tabId: 1, userMessage: 'hi' },
      {
        provider: capture(captured),
        executeTool: vi.fn<LoopDeps['executeTool']>(),
        getPageInfo: async () => ({ url: '', title: '' }),
        emit: vi.fn(),
        getMemoryState: async () => ({ enabled: false, writable: false, entries: [] }),
      },
    );
    expect(String(captured[0]!.messages[0]!.content)).not.toContain('## 记忆');
    const names = (captured[0]!.tools ?? []).map((t) => t.function.name);
    expect(names).not.toContain('memory_list');
  });

  it('writable:false → 有记忆块但只下发 memory_list', async () => {
    const captured: ChatParams[] = [];
    await runAgentLoop(
      { convId: 'cm3', tabId: 1, userMessage: 'hi' },
      {
        provider: capture(captured),
        executeTool: vi.fn<LoopDeps['executeTool']>(),
        getPageInfo: async () => ({ url: '', title: '' }),
        emit: vi.fn(),
        getMemoryState: async () => ({
          enabled: true, writable: false,
          entries: [{ id: 'g1', content: '人工维护的记忆', matches: [], updatedAt: 1 }],
        }),
      },
    );
    expect(String(captured[0]!.messages[0]!.content)).toContain('人工维护的记忆');
    const names = (captured[0]!.tools ?? []).map((t) => t.function.name);
    expect(names).toContain('memory_list');
    expect(names).not.toContain('memory_write');
  });

  it('不提供 getMemoryState → 无记忆块，工具清单仍含记忆工具（默认 full）', async () => {
    const captured: ChatParams[] = [];
    await runAgentLoop(
      { convId: 'cm4', tabId: 1, userMessage: 'hi' },
      {
        provider: capture(captured),
        executeTool: vi.fn<LoopDeps['executeTool']>(),
        getPageInfo: async () => ({ url: '', title: '' }),
        emit: vi.fn(),
      },
    );
    expect(String(captured[0]!.messages[0]!.content)).not.toContain('## 记忆');
    expect((captured[0]!.tools ?? []).map((t) => t.function.name)).toContain('memory_list');
  });
});
```

- [ ] **Step 11: 运行测试确认失败**

Run: `npx vitest run tests/agent/loop.test.ts -t "注入记忆"`
Expected: FAIL — `LoopDeps` 上不存在 `getMemoryState`

- [ ] **Step 12: 改 `agent/loop.ts`**

顶部 import 加：

```ts
import { memoryStateToCap, type MemoryState } from './memory-prompt';
```

`LoopDeps` 内（`getSystemPrompt` 之后）加：

```ts
  /** 记忆状态（全量条目 + 两个开关）。缺省不注入记忆块，工具清单按默认 full 下发。 */
  getMemoryState?: () => Promise<MemoryState>;
```

`drive` 内把 `const systemPrompt = ...` 之后到 `runTurn` 之间改为：

```ts
    const systemPrompt = await deps.getSystemPrompt?.();
    const memory = await deps.getMemoryState?.();
    const messages = buildContext(conv.messages, page, { summary: conv.summary, skills, mode, systemPrompt, memory });
    const memoryCap = memory ? memoryStateToCap(memory) : 'full';

    const maxTokens = (await deps.getMaxTokens?.()) ?? 0;
    // 参数生成进度节流器：每轮新建，状态不跨轮（下一轮从 0 重新计）
    const onArgs = makeArgsThrottle((name, bytes) => deps.emit({ type: 'tool-args-delta', name, bytes }));
    const result = await runTurn(deps.provider, {
      messages, tools: getToolSchemas(mode, memoryCap), signal,
      ...(maxTokens > 0 ? { maxTokens } : {}),
    }, {
```

- [ ] **Step 13: 改 `background/agent-port.ts`**

顶部 import 加两行：

```ts
import { listMemories } from '../storage/memory';
import { memoryStateToCap, type MemoryState } from '../agent/memory-prompt';
```

在 `makeDeps` 之前加一个共用读取函数（loop 与 executeTool 都要，避免逻辑分叉）：

```ts
/** 读记忆状态：总开关关闭时直接返回空且不可写；storage 故障同样降级为 off
 *  （任务不因记忆读不出来而中断，代价是该轮拿不到记忆也不能写——瞬时故障可接受）。 */
async function readMemoryState(): Promise<MemoryState> {
  const off: MemoryState = { enabled: false, writable: false, entries: [] };
  try {
    const { agent } = await getSettings();
    if (!agent.memoryEnabled) return off;
    const all = await listMemories();
    return {
      enabled: true,
      writable: agent.memoryWritable,
      entries: all.map((m) => ({
        id: m.id, content: m.content, matches: m.matches, updatedAt: m.updatedAt,
      })),
    };
  } catch {
    return off;
  }
}
```

`makeDeps` 内的 `executeTool` 那一行改为异步读 cap（记忆档位与 mode 一样每次调用时取最新值）：

```ts
    executeTool: async (name, args, tabId, signal) =>
      executeTool(name, args, {
        tabId, sessionId: convId, signal,
        waitForReady: (t) => waitForCsReady(t),
        mode: convModeRef.mode,
        memory: memoryStateToCap(await readMemoryState()),
      }),
```

并在 `getSystemPrompt` 之后加：

```ts
    getMemoryState: readMemoryState,
```

> **为什么 cap 被读两次**：loop 用 `getMemoryState` 的结果过滤 schema（决定这一轮给模型哪些工具），`executeTool` 又独立读一次做硬闸。两者读的是同一份设置，只是时机差一点——用户在一轮进行中拨开关，最坏情况是这一轮的清单与守卫松紧不一致（工具下发了但被守卫拒、或反之），下一轮即对齐。刻意不把 cap 从 loop 传进 ctx：那样要么给 `LoopDeps.executeTool` 加一个参数（污染签名，测试里全部要改），要么在 `agent-port` 里维护一个像 `convModeRef` 那样的可变引用（多一处状态要清理）。守卫本来就是防幻觉的兜底，不追求与清单严格同帧。

- [ ] **Step 14: 运行全量测试与类型检查**

Run: `npm run test`
Expected: PASS（全部）

Run: `npm run compile`
Expected: 无输出

- [ ] **Step 15: 提交**

```bash
git add storage/settings.ts agent/mode.ts agent/tools/registry.ts agent/loop.ts background/agent-port.ts tests/
git commit -m "feat(agent): 记忆两个开关 + cap 三档守卫 + loop 每轮注入接线"
```

---

## Task 12: 记忆管理页 + 设置入口

**Files:**
- Create: `components/settings/memory-page-utils.ts`
- Create: `components/settings/MemoryPage.tsx`
- Modify: `components/settings/SettingsHome.tsx`
- Modify: `components/settings/SettingsView.tsx`
- Modify: `entrypoints/sidepanel/styles.css`
- Create: `tests/settings/memory-page-utils.test.ts`
- Create: `tests/settings/memory-page.test.tsx`
- Modify: `tests/settings/settings-view.test.tsx`

- [ ] **Step 1: 写纯逻辑的失败测试**

创建 `tests/settings/memory-page-utils.test.ts`：

```ts
// tests/settings/memory-page-utils.test.ts
import { describe, it, expect } from 'vitest';
import { parsePatternLines, invalidPatterns, filterMemories } from '../../components/settings/memory-page-utils';
import type { MemoryEntry } from '../../shared/types';

function mk(over: Partial<MemoryEntry> = {}): MemoryEntry {
  return { id: 'm1', content: '正文', matches: [], source: 'ai', createdAt: 1, updatedAt: 1, ...over };
}

describe('parsePatternLines', () => {
  it('按行拆分并去掉空行与首尾空白', () => {
    expect(parsePatternLines(' *://a.com/* \n\n  *://b.com/*  \n')).toEqual(['*://a.com/*', '*://b.com/*']);
  });

  it('全空 → 空数组（= 全局记忆）', () => {
    expect(parsePatternLines('')).toEqual([]);
    expect(parsePatternLines('  \n \n ')).toEqual([]);
  });

  it('CRLF 也能拆', () => {
    expect(parsePatternLines('*://a.com/*\r\n*://b.com/*')).toEqual(['*://a.com/*', '*://b.com/*']);
  });
});

describe('invalidPatterns', () => {
  it('返回非法行，合法的不返回', () => {
    expect(invalidPatterns(['*://a.com/*', '乱写', '<all_urls>'])).toEqual(['乱写']);
  });

  it('全合法 → 空数组', () => {
    expect(invalidPatterns(['*://a.com/*'])).toEqual([]);
  });
});

describe('filterMemories', () => {
  const list = [
    mk({ id: 'a', content: '偏好中文回复' }),
    mk({ id: 'b', content: 'B 站登录', matches: ['*://*.bilibili.com/*'] }),
  ];

  it('空查询 → 原样返回', () => {
    expect(filterMemories(list, '')).toHaveLength(2);
    expect(filterMemories(list, '   ')).toHaveLength(2);
  });

  it('匹配正文子串', () => {
    expect(filterMemories(list, '中文').map((m) => m.id)).toEqual(['a']);
  });

  it('匹配作用域子串，大小写不敏感', () => {
    expect(filterMemories(list, 'BILIBILI').map((m) => m.id)).toEqual(['b']);
  });

  it('无命中 → 空数组', () => {
    expect(filterMemories(list, 'zzz')).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/settings/memory-page-utils.test.ts`
Expected: FAIL — 无法解析 `components/settings/memory-page-utils`

- [ ] **Step 3: 创建 `components/settings/memory-page-utils.ts`**

```ts
// components/settings/memory-page-utils.ts
// 记忆页的纯逻辑：作用域文本 ↔ pattern 数组、非法行检出、列表过滤。
// 抽出来是为了不必渲染组件就能测这几条规则。
import type { MemoryEntry } from '../../shared/types';
import { isValidMatchPattern } from '../../shared/match-pattern';

/** 作用域输入框（每行一条）→ pattern 数组。空行忽略，全空 = 全局记忆。 */
export function parsePatternLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** 挑出非法 pattern（用于实时标红与保存前拦截）。 */
export function invalidPatterns(patterns: string[]): string[] {
  return patterns.filter((p) => !isValidMatchPattern(p));
}

/** 列表搜索：正文或作用域子串，大小写不敏感。 */
export function filterMemories(list: MemoryEntry[], query: string): MemoryEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter(
    (m) =>
      m.content.toLowerCase().includes(q) ||
      m.matches.some((p) => p.toLowerCase().includes(q)),
  );
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/settings/memory-page-utils.test.ts`
Expected: PASS（10 个用例）

- [ ] **Step 5: 写组件的失败测试**

创建 `tests/settings/memory-page.test.tsx`：

```tsx
// tests/settings/memory-page.test.tsx
// 记忆管理页：列表渲染、两个开关、新建/编辑/删除、非法 pattern 拦截。
// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryPage } from '../../components/settings/MemoryPage';
import { listMemories, saveMemory, newMemory } from '../../storage/memory';
import { getSettings } from '../../storage/settings';

beforeEach(() => {
  fakeBrowser.reset();
  vi.restoreAllMocks();
});
afterEach(cleanup);

async function seed(): Promise<void> {
  await saveMemory({ ...newMemory({ content: '偏好中文回复', matches: [], source: 'user' }), id: 'g1' });
  await saveMemory({
    ...newMemory({ content: 'B 站登录在悬浮层', matches: ['*://*.bilibili.com/*'], source: 'ai' }),
    id: 's1',
  });
}

describe('MemoryPage 列表', () => {
  it('渲染条目、作用域 chip 与来源 chip', async () => {
    await seed();
    render(<MemoryPage onBack={() => {}} />);
    expect(await screen.findByText('偏好中文回复')).toBeTruthy();
    expect(screen.getByText('B 站登录在悬浮层')).toBeTruthy();
    expect(screen.getByText('全局')).toBeTruthy();
    expect(screen.getByText('*://*.bilibili.com/*')).toBeTruthy();
    expect(screen.getByText('手工')).toBeTruthy();
    expect(screen.getByText('AI')).toBeTruthy();
  });

  it('搜索过滤', async () => {
    await seed();
    render(<MemoryPage onBack={() => {}} />);
    await screen.findByText('偏好中文回复');
    fireEvent.change(screen.getByLabelText('搜索记忆'), { target: { value: 'bilibili' } });
    expect(screen.queryByText('偏好中文回复')).toBeNull();
    expect(screen.getByText('B 站登录在悬浮层')).toBeTruthy();
  });

  it('空库出占位文案', async () => {
    render(<MemoryPage onBack={() => {}} />);
    expect(await screen.findByText(/还没有记忆/)).toBeTruthy();
  });

  it('删除按钮（确认后）真删', async () => {
    await seed();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<MemoryPage onBack={() => {}} />);
    await screen.findByText('偏好中文回复');
    fireEvent.click(screen.getByRole('button', { name: '删除这条记忆：偏好中文回复' }));
    await waitFor(async () => expect(await listMemories()).toHaveLength(1));
  });
});

describe('MemoryPage 开关', () => {
  it('两个开关反映 settings 并可切换落库', async () => {
    render(<MemoryPage onBack={() => {}} />);
    const master = await screen.findByRole('switch', { name: '启用记忆' });
    expect(master.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(master);
    await waitFor(async () => expect((await getSettings()).agent.memoryEnabled).toBe(false));

    const writable = screen.getByRole('switch', { name: '允许 AI 写入' });
    fireEvent.click(writable);
    await waitFor(async () => expect((await getSettings()).agent.memoryWritable).toBe(false));
  });
});

describe('MemoryPage 详情', () => {
  it('新建：填正文与作用域后保存，落库 source=user', async () => {
    render(<MemoryPage onBack={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: '新建记忆' }));
    fireEvent.change(screen.getByLabelText('记忆正文'), { target: { value: '新记的东西' } });
    fireEvent.change(screen.getByLabelText('站点作用域'), { target: { value: '*://a.com/*' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(async () => {
      const all = await listMemories();
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({ content: '新记的东西', matches: ['*://a.com/*'], source: 'user' });
    });
  });

  it('非法 pattern → 出错误提示且不落库', async () => {
    render(<MemoryPage onBack={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: '新建记忆' }));
    fireEvent.change(screen.getByLabelText('记忆正文'), { target: { value: 'X' } });
    fireEvent.change(screen.getByLabelText('站点作用域'), { target: { value: '乱写的东西' } });
    expect(screen.getByText(/乱写的东西/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(async () => expect(await listMemories()).toEqual([]));
  });

  it('编辑 AI 记录的条目 → 保留 source=ai', async () => {
    await seed();
    render(<MemoryPage onBack={() => {}} />);
    fireEvent.click(await screen.findByText('B 站登录在悬浮层'));
    const box = await screen.findByLabelText<HTMLTextAreaElement>('记忆正文');
    fireEvent.change(box, { target: { value: '改过的经验' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(async () => {
      const hit = (await listMemories()).find((m) => m.id === 's1')!;
      expect(hit).toMatchObject({ content: '改过的经验', source: 'ai' });
    });
  });

  it('正文超 500 字 → 禁用保存并出计数错误', async () => {
    render(<MemoryPage onBack={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: '新建记忆' }));
    fireEvent.change(screen.getByLabelText('记忆正文'), { target: { value: 'x'.repeat(501) } });
    expect(screen.getByRole('button', { name: '保存' })).toHaveProperty('disabled', true);
    expect(screen.getByText(/501 \/ 500/)).toBeTruthy();
  });

  it('保存失败（撞条数上限）→ 错误横幅出在详情页而非被吞掉', async () => {
    // 塞满 100 条，再新建第 101 条必然被 storage 层拒绝
    for (let i = 0; i < 100; i++) {
      await saveMemory({ ...newMemory({ content: `第 ${i} 条`, matches: [], source: 'ai' }), id: `k${i}` });
    }
    render(<MemoryPage onBack={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: '新建记忆' }));
    fireEvent.change(screen.getByLabelText('记忆正文'), { target: { value: '第 101 条' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    // 仍停在详情页（标题还是「新建记忆」），且错误可见
    expect(await screen.findByText(/上限/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: '新建记忆' })).toBeTruthy();
  });
});
```

- [ ] **Step 6: 运行测试确认失败**

Run: `npx vitest run tests/settings/memory-page.test.tsx`
Expected: FAIL — 无法解析 `components/settings/MemoryPage`

- [ ] **Step 7: 创建 `components/settings/MemoryPage.tsx`**

```tsx
// components/settings/MemoryPage.tsx
// AI 记忆二级页（spec §3.6）：列表 ↔ 详情。面板直接读写 storage/memory.ts，
// 不走 background 编排层——记忆无 md 解析、无注入引擎、无 tabs 监听，那层间接没有收益。
import { useCallback, useEffect, useState } from 'react';
import { Plus, Search, Trash2 } from 'lucide-react';
import { storage } from 'wxt/utils/storage';
import { PageShell } from '../ui/PageShell';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import {
  listMemories, saveMemory, deleteMemory, newMemory, MAX_CONTENT_LENGTH,
} from '../../storage/memory';
import { getSettings, saveSettings } from '../../storage/settings';
import type { MemoryEntry } from '../../shared/types';
import { parsePatternLines, invalidPatterns, filterMemories } from './memory-page-utils';

/** 详情态：'new' = 新建，字符串 id = 编辑那一条。 */
type Editing = { kind: 'new' } | { kind: 'edit'; entry: MemoryEntry };

export function MemoryPage({ onBack }: { onBack: () => void }) {
  const [list, setList] = useState<MemoryEntry[]>([]);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<Editing | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [writable, setWritable] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setList(await listMemories().catch(() => []));
  }, []);

  useEffect(() => {
    void refresh();
    void (async () => {
      const s = await getSettings().catch(() => null);
      if (!s) return;
      setEnabled(s.agent.memoryEnabled);
      setWritable(s.agent.memoryWritable);
    })();
    // AI 在任务中写记忆时，正开着这一页也能看到列表刷新
    const unwatch = storage.watch<MemoryEntry[]>('local:memory:index', (next) => {
      setList(next ?? []);
    });
    return () => unwatch();
  }, [refresh]);

  const toggleEnabled = async (): Promise<void> => {
    const next = !enabled;
    setEnabled(next);
    await saveSettings({ agent: { memoryEnabled: next } });
  };

  const toggleWritable = async (): Promise<void> => {
    const next = !writable;
    setWritable(next);
    await saveSettings({ agent: { memoryWritable: next } });
  };

  const remove = async (m: MemoryEntry): Promise<void> => {
    if (!window.confirm(`删除这条记忆？不可恢复。\n\n${m.content.slice(0, 80)}`)) return;
    try {
      await deleteMemory(m.id);
      setError(null);
    } catch (e) {
      // storage 故障等：显式提示而非未处理 rejection
      setError(`删除失败：${e instanceof Error ? e.message : String(e)}`);
    }
    await refresh();
  };

  if (editing) {
    return (
      <MemoryDetail
        editing={editing}
        onCancel={() => { setEditing(null); setError(null); }}
        onSaved={async () => { setEditing(null); setError(null); await refresh(); }}
      />
    );
  }

  const visible = filterMemories(list, query);

  return (
    <PageShell
      title="AI 记忆"
      eyebrow="MEMORY"
      onBack={onBack}
      backLabel="返回设置"
      actions={
        <Button
          variant="ghost"
          className="btn--icon"
          aria-label="新建记忆"
          title="新建记忆"
          onClick={() => setEditing({ kind: 'new' })}
        >
          <Plus size={16} />
        </Button>
      }
    >
      {error && <div className="scripts-warnline" role="status">{error}</div>}

      <div className="field">
        <div className="mem-switch">
          <span className="field-label">启用记忆</span>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label="启用记忆"
            className={`switch${enabled ? ' switch--on' : ''}`}
            onClick={() => void toggleEnabled()}
          >
            <span className="switch__thumb" aria-hidden />
          </button>
        </div>
        <span className="hint">关闭后不再把记忆注入对话，也不给 AI 记忆工具。</span>
      </div>
      <div className="field">
        <div className="mem-switch">
          <span className="field-label">允许 AI 写入</span>
          <button
            type="button"
            role="switch"
            aria-checked={writable}
            aria-label="允许 AI 写入"
            className={`switch${writable ? ' switch--on' : ''}`}
            onClick={() => void toggleWritable()}
          >
            <span className="switch__thumb" aria-hidden />
          </button>
        </div>
        <span className="hint">关闭后 AI 只能读已有记忆，增删改全部由你在这一页维护。</span>
      </div>

      <div className="scripts-toolbar">
        <div style={{ position: 'relative', flex: 1 }}>
          <Search size={13} style={{ position: 'absolute', left: 8, top: 8, color: 'var(--ink-3)' }} aria-hidden />
          <Input
            aria-label="搜索记忆"
            placeholder="搜索正文 / 作用域…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ paddingLeft: 26 }}
          />
        </div>
      </div>

      <div className="scripts-list">
        {visible.map((m) => (
          <div
            key={m.id}
            className="scripts-card"
            role="button"
            tabIndex={0}
            onClick={() => setEditing({ kind: 'edit', entry: m })}
            onKeyDown={(e) => {
              if (e.currentTarget !== e.target) return;
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setEditing({ kind: 'edit', entry: m });
              }
            }}
          >
            <div className="scripts-card__top">
              <span className="mem-card__content">{m.content}</span>
              <button
                type="button"
                className="scripts-card__delbtn"
                aria-label={`删除这条记忆：${m.content}`}
                title="删除记忆"
                onClick={(e) => { e.stopPropagation(); void remove(m); }}
                onKeyDown={(e) => e.stopPropagation()}
              >
                <Trash2 size={14} aria-hidden />
              </button>
            </div>
            <div className="scripts-card__meta">
              {m.matches.length === 0
                ? <span className="token">全局</span>
                : m.matches.map((p) => <span key={p} className="mono slash-chip">{p}</span>)}
              <span className="token">{m.source === 'ai' ? 'AI' : '手工'}</span>
              <span className="scripts-card__match">{new Date(m.updatedAt).toLocaleString()}</span>
            </div>
          </div>
        ))}
        {visible.length === 0 && (
          <div className="chat__empty">
            {list.length === 0
              ? '还没有记忆。AI 在对话中发现值得长期保留的信息时会自己记下，你也可以点右上角手工添加。'
              : '没有匹配的记忆'}
          </div>
        )}
      </div>
    </PageShell>
  );
}

function MemoryDetail({
  editing, onCancel, onSaved,
}: {
  editing: Editing;
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const existing = editing.kind === 'edit' ? editing.entry : null;
  const [content, setContent] = useState(existing?.content ?? '');
  const [scopeText, setScopeText] = useState((existing?.matches ?? []).join('\n'));
  // 保存错误必须由详情页自己持有并渲染：父组件渲染详情时已提前 return，
  // 交给父组件的 setError 只会显示在列表页——撞上限之类的失败会被静默吞掉。
  const [saveError, setSaveError] = useState<string | null>(null);

  const patterns = parsePatternLines(scopeText);
  const bad = invalidPatterns(patterns);
  const tooLong = content.length > MAX_CONTENT_LENGTH;
  const canSave = content.trim().length > 0 && !tooLong && bad.length === 0;

  const handleSave = async (): Promise<void> => {
    if (!canSave) return;
    try {
      // source 保留原值——来源是事实记录，不因编辑而改写（spec §3.6）
      const entry: MemoryEntry = existing
        ? { ...existing, content, matches: patterns, updatedAt: Date.now() }
        : newMemory({ content, matches: patterns, source: 'user' });
      await saveMemory(entry);
      await onSaved();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <PageShell
      title={existing ? '编辑记忆' : '新建记忆'}
      eyebrow="MEMORY"
      onBack={onCancel}
      backLabel="返回列表"
    >
      {saveError && <div className="scripts-warnline" role="status">{saveError}</div>}

      <div className="field">
        <label className="field-label" htmlFor="mem-content">记忆正文</label>
        <textarea
          id="mem-content"
          aria-label="记忆正文"
          className="textarea"
          rows={5}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="一条只说一件事，如：这个站的登录按钮在右上角头像的悬浮层里，需先 hover 再 click"
        />
        <span className={tooLong ? 'status-text status-text--err' : 'hint'}>
          {content.length} / {MAX_CONTENT_LENGTH} 字符
        </span>
      </div>

      <div className="field">
        <label className="field-label" htmlFor="mem-scope">站点作用域</label>
        <textarea
          id="mem-scope"
          aria-label="站点作用域"
          className="textarea mono-input"
          rows={3}
          value={scopeText}
          onChange={(e) => setScopeText(e.target.value)}
          placeholder={'*://*.bilibili.com/*\n每行一条，留空 = 全局记忆'}
          spellCheck={false}
        />
        {bad.length > 0 ? (
          <span className="status-text status-text--err">
            非法 match pattern：{bad.join('、')}（形如 *://*.example.com/* 或 &lt;all_urls&gt;）
          </span>
        ) : (
          <span className="hint">
            留空 = 全局记忆，任何页面都注入。只在某站适用的经验务必填，否则会在别的站误导 AI。
          </span>
        )}
      </div>

      <div className="prompt-actions">
        <Button variant="primary" onClick={() => void handleSave()} disabled={!canSave}>保存</Button>
        <Button onClick={onCancel}>取消</Button>
      </div>
    </PageShell>
  );
}
```

- [ ] **Step 8: 加样式**

`entrypoints/sidepanel/styles.css` 末尾追加：

```css
/* ---------- AI 记忆页 ---------- */
.mem-switch { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.mem-card__content {
  flex: 1;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--ink-1);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
```

- [ ] **Step 9: 挂设置入口**

`components/settings/SettingsHome.tsx`：

`SettingsSub` 改为

```ts
export type SettingsSub = 'model' | 'prompt' | 'memory' | 'toolbench' | 'scriptdebug' | 'skills';
```

import 加 `Brain`：

```ts
import { SlidersHorizontal, SquareTerminal, FlaskConical, ChevronRight, Sparkles, ScrollText, Brain } from 'lucide-react';
```

`ENTRIES` 在 `prompt` 那一项之后插入：

```ts
  { key: 'memory', title: 'AI 记忆', desc: '跨会话长期记忆，AI 自主记录，可人工编辑', Icon: Brain },
```

`components/settings/SettingsView.tsx` 加 import 与分支：

```tsx
import { MemoryPage } from './MemoryPage';
```

```tsx
  if (sub === 'memory') return <MemoryPage onBack={back} />;
```

- [ ] **Step 10: 补 settings-view 的入口断言**

`tests/settings/settings-view.test.tsx` 第一个用例加一行：

```tsx
    expect(screen.getByText('AI 记忆')).toBeTruthy();
```

再加一条新用例：

```tsx
  it('点「AI 记忆」入口进二级页（MEMORY），返回回列表', async () => {
    render(<SettingsView />);
    fireEvent.click(await screen.findByText('AI 记忆'));
    expect(await screen.findByText('MEMORY')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('返回设置'));
    expect(await screen.findByText('模型设置')).toBeTruthy();
  });
```

- [ ] **Step 11: 运行测试与类型检查**

Run: `npx vitest run tests/settings/`
Expected: PASS

Run: `npm run test`
Expected: PASS（全量）

Run: `npm run compile`
Expected: 无输出

- [ ] **Step 12: 提交**

```bash
git add components/settings/ entrypoints/sidepanel/styles.css tests/settings/
git commit -m "feat(settings): AI 记忆管理页（列表/详情、两个开关、pattern 实时校验、storage.watch 刷新）"
```

---

## Task 13: 文档收口

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: 更新 `CLAUDE.md`**

在文件末尾（「AI 写脚本流程优化」那段之后）追加：

```markdown
系统提示词自定义 + Agent 记忆（2026-09-07，`docs/superpowers/specs/2026-09-07-system-prompt-and-agent-memory-design.md`）已完成：

1. **系统提示词覆盖式自定义**：`Settings` 新增第三个顶层段 `prompt`（`{ custom, baseSnapshot? }`，上限 16KB），`resolveSystemPrompt(custom)` 决定用自定义还是内置 `SYSTEM_PROMPT`，经 `LoopDeps.getSystemPrompt` 每轮重读。**覆盖只替换 `SYSTEM_PROMPT` 常量，动态块照旧追加**（页面信息 + 技能清单 + 记忆 + 模式说明）——故记忆的用法指令必须放在记忆块而非 `SYSTEM_PROMPT` 里，否则覆盖提示词的用户会连带丢掉记忆能力说明。设置页第 2 张卡 `SystemPromptPage`（CodeMirror md 编辑器 + 预览切换 + 恢复默认 + 「你的自定义基于旧版内置提示词」提示条，靠保存时留的 `baseSnapshot` 快照比对）。`CodeEditor` 泛化出 `language?: 'javascript' | 'markdown'`（新依赖 `@codemirror/lang-markdown`）。已知取舍：编辑后固化在当时版本，后续内置规则改进不自动进入；误删承重规则（uid/stale、分步写入、不可信输入）会让 agent 明显变笨且不易归因，页面上只做文案提示不做技术阻拦。
2. **Agent 记忆（条目式 + 站点作用域）**：`MemoryEntry`（`id` = nanoid(8) 省注入 token、`content` ≤500 字、`matches` 空数组 = 全局、`source: 'ai' | 'user'`）存单键 `local:memory:index`，上限 100 条；非法 match pattern **整条拒存**（不同于脚本池的「跳过坏规则 + 警告」——记忆只有一个 matches 字段，静默跳过会让 AI 以为写成功了而作用域是错的）。
3. **三层注入**（`agent/memory-prompt.ts` 纯函数）：全局记忆全文 → 当前页 `matchUrl` 命中的记忆全文 → 其余记忆只出**站点清单**（pattern + 条数，最多 30 个）。第三层是为了补「模型在导航**前**看不到目标站记忆」这个洞——记忆过滤依赖 `page.url`，而它每轮循环顶部才重读，导航后的新站记忆本来要等下一轮。预算 6000 字符由全局与站点两层**各分半、未用满的额度让给另一层**（全局被挤掉用户立刻察觉，站点被挤掉 agent 在当前页重复踩坑，都不能牺牲）。空库仍注入冷启动文案，否则模型永远不知道自己有这个能力。
4. **三个工具（27 → 30）**：`memory_list`（`scope` 两趟匹配——先当完整 URL 走 `matchUrl`，未命中再对 pattern 做子串匹配；带 `scope` 时排除全局记忆，因其已常驻注入）、`memory_write`（无 id 新增 / 带 id 改写，`matches` 传了才改，保留 `createdAt` 与 `source`）、`memory_delete`（幂等）。返回值瘦身（正文截 120 字、不回灌全库）。三个都进 `ASK_MODE_TOOLS`——ask 的语义是「不改网页/浏览器状态」，记忆只改扩展自己的本地笔记。新增 `MEMORY` 能力域（调试台第六组）。
5. **两个开关 + 三档守卫**：`AgentConfig.memoryEnabled`（关 = 不注入不下发）与 `memoryWritable`（关 = 只注入 + 只给 `memory_list`）→ `MemoryCap = 'off' | 'read' | 'full'`，`getToolSchemas(mode, cap)` 二维过滤 + `executeTool` 硬闸兜底拦幻觉调用（与既有 ask 守卫同一位置同一形状）。`MemoryState` 必须同时带 `enabled` 与 `writable`：仅有 `writable` 无法区分「总开关关闭」（完全静默）与「只读模式下记忆池为空」（注入只读版冷启动文案），两者 `entries` 都是空数组。
6. **设置页不走 background 路由**：`MemoryPage` 直接读写 `storage/memory.ts`（同 `ModelSettings` 直接读写 `storage/settings.ts`），刻意不照技能池的 `SKILLS_*` 消息链——记忆无 md 解析、无注入引擎、无 tabs 监听，那层间接省掉一个编排层、一组消息类型、一个 zustand store。加 `storage.watch` 让 AI 任务中写入时列表自动刷新。
7. **`buildContext` 签名重构**：6 个位置参数改 `(history, page, opts)`，`page` 仍是必需主参数，其余进具名 `opts`（原先再加两项就是 8 个位置参数）。

**已知限制**：(1) 覆盖提示词后固化在当时版本；(2) 同一轮内导航后的后续工具仍看不到新站记忆——三层注入让模型有能力主动规避（先 `memory_list` 再动手）但不强制，最坏延迟一轮；(3) click 触发的同标签跳转 URL 更新时序无保证（`navigate_page` 内部 `await waitForCsReady` 能保证，页内跳转不能——这是 `getPageInfo` 既有特性，非记忆新引入）；(4) 站点清单按 pattern 字面聚合，`*://bilibili.com/*` 与 `*://*.bilibili.com/*` 显示为两项；(5) `memory_list` 的 `scope` 第二趟是子串匹配，`scope: 'com'` 会命中大量条目；(6) AI 与用户并发写同一条时后写覆盖（wxt storage 无事务，`storage.watch` 会让面板刷新到最新值）。
```

- [ ] **Step 2: 全量验证**

Run: `npm run test`
Expected: PASS（全部）

Run: `npm run compile`
Expected: 无输出

Run: `npm run build`
Expected: 构建成功（确认新依赖 `@codemirror/lang-markdown` 能被打包）

- [ ] **Step 3: 提交**

```bash
git add CLAUDE.md
git commit -m "docs(claude): 记录系统提示词自定义与 Agent 记忆（2026-09-07）"
```

---

## 手工验收清单

自动化测试覆盖不到的部分，实施完成后在浏览器里跑一遍：

- [ ] `npm run dev` 载入扩展，打开侧边栏 → 设置 → 「系统提示词」，编辑器显示内置全文且有语法高亮。
- [ ] 改一句话保存，开新会话问 AI 一个问题，确认它的行为反映了改动（如加一句「每次回复都以「收到：」开头」）。
- [ ] 点「恢复默认」，确认编辑器回到内置全文，且提示条回到「当前使用内置提示词」。
- [ ] 设置 → 「AI 记忆」，手工新建一条全局记忆（如「用户偏好简短回复」），开新会话确认 AI 行为受影响。
- [ ] 新建一条带作用域的记忆（`*://*.bilibili.com/*`），在非 B 站页面开会话问 AI「你记得关于 bilibili 的什么」，确认它会调 `memory_list` 而不是凭空回答。
- [ ] 让 AI 记一条东西（「记住我用的是 Windows」），确认聊天流里出现 `memory_write` 工具卡，且记忆页列表**自动刷新**出现新条目（验证 `storage.watch`）。
- [ ] 关闭「允许 AI 写入」，让 AI 再记一条，确认它说自己没有写入工具（而不是报错幻觉调用）。
- [ ] 关闭「启用记忆」总开关，确认新会话里 AI 完全不提记忆。
- [ ] 导航到 B 站，确认下一轮 AI 能看到该站记忆（可让它复述系统提示里的记忆条目验证）。



