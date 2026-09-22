# 上下文 token 优化 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把新对话的固定开销（system 提示词 + 工具 schema）降下来，并让 tools+system+history 成为逐字节稳定的缓存前缀。

**Architecture:** 三段改动。① 布局：`buildContext` 把易变内容（页面 URL/标题、记忆条目）从 system 消息挪到消息数组最末的一条 `user` 消息，使前缀稳定。② 收缩：ask 模式工具集 18→10、技能清单封顶 20 + 模糊搜索。③ 瘦身：37 个工具 schema 按中等档规则删重复与论证。

**Tech Stack:** WXT + React 19 + TypeScript 7 + Zustand；vitest v4 + jsdom；OpenAI 兼容 provider。

**Spec:** `docs/superpowers/specs/2026-09-22-context-token-optimization-design.md`

## Global Constraints

- 每个任务结束必须 `npm run compile` 与 `npm run test` 双绿。
- 工具返回值一律 `{ ok: true, data? } | { ok: false; error }` 判别联合。
- 注释风格与既有文件一致：讲「为什么」而非「是什么」，中文。
- 提交信息中文，前缀用 `feat` / `fix` / `docs` / `test` / `refactor`；结尾带 `Co-Authored-By: Claude Code <noreply@anthropic.com>`。
- **任何 schema 体积统计必须基于序列化后的对象**（`JSON.stringify`），不能基于 `agent/tools/schemas.ts` 源码文本——`obj()` 辅助函数在运行时才生成 `type/properties/required/additionalProperties` 那层包装，按源码统计会漏算 57% 的结构开销（spec §0.1）。
- 排序必须**确定性且 locale 无关**：用 `a < b ? -1 : a > b ? 1 : 0`，不要用 `localeCompare`（后者随 locale 变化，会让缓存前缀抖动）。
- 本计划不涉及样式改动，无需动 `entrypoints/sidepanel/styles.css`。

---

### Task 1: `agent/skill-brief.ts` — 技能清单的排序/封顶/截断纯函数

**Files:**
- Create: `agent/skill-brief.ts`
- Test: `tests/agent/skill-brief.test.ts`

**Interfaces:**
- Consumes: 无（全新纯函数模块）
- Produces:
  - `interface SkillBrief { name: string; command: string; description: string; builtin?: boolean; createdAt: number }`
  - `const SKILL_LIST_CAP = 20`
  - `const SKILL_DESC_MAX = 60`
  - `function truncateDescription(desc: string, limit?: number): string`
  - `function selectSkillBriefs(briefs: SkillBrief[], cap?: number): { shown: SkillBrief[]; hidden: number }`

- [ ] **Step 1: 写失败的测试**

创建 `tests/agent/skill-brief.test.ts`：

```ts
// tests/agent/skill-brief.test.ts
import { describe, it, expect } from 'vitest';
import {
  selectSkillBriefs, truncateDescription, SKILL_LIST_CAP, SKILL_DESC_MAX, type SkillBrief,
} from '../../agent/skill-brief';

const b = (over: Partial<SkillBrief> = {}): SkillBrief =>
  ({ name: 'N', command: 'c', description: 'd', createdAt: 1, ...over });

describe('truncateDescription', () => {
  it('未超限原样返回', () => {
    expect(truncateDescription('短描述')).toBe('短描述');
  });

  it('超限在最后一个「；」处截断并加省略号', () => {
    const d = '介绍本扩展的功能与用法；当用户询问扩展能做什么、怎么用时触发；还有后半句没用的补充说明文字';
    const out = truncateDescription(d, 40);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(41);
    expect(out).not.toContain('还有后半句');
  });

  it('超限在最后一个「，」处截断（无「；」时）', () => {
    const d = '第一段说明文字，第二段说明文字，第三段说明文字，第四段很长的补充说明文字啊啊啊';
    const out = truncateDescription(d, 20);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(21);
  });

  it('limit 之前无分隔符则硬切', () => {
    expect(truncateDescription('x'.repeat(100), 10)).toBe(`${'x'.repeat(10)}…`);
  });

  it('默认 limit = SKILL_DESC_MAX', () => {
    expect(truncateDescription('x'.repeat(200)).length).toBe(SKILL_DESC_MAX + 1);
  });
});

describe('selectSkillBriefs', () => {
  it('内置在前（createdAt 升序 = builtin.md 顺序），用户技能在后（createdAt 降序，最新在前）', () => {
    const { shown } = selectSkillBriefs([
      b({ command: 'u-old', createdAt: 10 }),
      b({ command: 'bi-2', builtin: true, createdAt: 2 }),
      b({ command: 'u-new', createdAt: 30 }),
      b({ command: 'bi-1', builtin: true, createdAt: 1 }),
    ]);
    expect(shown.map((s) => s.command)).toEqual(['bi-1', 'bi-2', 'u-new', 'u-old']);
  });

  it('内置不占名额：4 内置 + 20 用户 = 24 条全出，hidden=0', () => {
    const builtins = Array.from({ length: 4 }, (_, i) => b({ command: `bi-${i}`, builtin: true, createdAt: i }));
    const users = Array.from({ length: 20 }, (_, i) => b({ command: `u${i}`, createdAt: i }));
    const { shown, hidden } = selectSkillBriefs([...builtins, ...users]);
    expect(shown).toHaveLength(24);
    expect(hidden).toBe(0);
  });

  it('用户技能超 20 只出 20，hidden 计数正确', () => {
    const users = Array.from({ length: 25 }, (_, i) => b({ command: `u${i}`, createdAt: i }));
    const { shown, hidden } = selectSkillBriefs(users);
    expect(shown).toHaveLength(SKILL_LIST_CAP);
    expect(hidden).toBe(5);
  });

  it('同 createdAt 用 command 字典序兜底（全序，locale 无关）', () => {
    const { shown } = selectSkillBriefs([
      b({ command: 'b', createdAt: 5 }), b({ command: 'a', createdAt: 5 }), b({ command: 'c', createdAt: 5 }),
    ]);
    expect(shown.map((s) => s.command)).toEqual(['a', 'b', 'c']);
  });

  it('空输入 → 空结果', () => {
    expect(selectSkillBriefs([])).toEqual({ shown: [], hidden: 0 });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/agent/skill-brief.test.ts`
Expected: FAIL — `Failed to resolve import "../../agent/skill-brief"`

- [ ] **Step 3: 写实现**

创建 `agent/skill-brief.ts`：

```ts
// agent/skill-brief.ts
// 技能清单的 prompt 整形纯函数（spec §7.1）：排序 → 封顶 → 描述截断。
// 与 memory-prompt.ts 同构：prompt 整形逻辑独立成纯函数模块，便于单测。
//
// 排序必须确定性：清单块在 system 消息里，是缓存前缀的一部分。
// 顺序抖动 = 前缀抖动 = 缓存全废（spec 决策 9）。故一律用 locale 无关的比较，
// 不用 localeCompare——后者随 locale 变化，会让同一份数据在不同环境下排出不同顺序。

export interface SkillBrief {
  name: string;
  command: string;
  description: string;
  /** 内置技能：常驻清单，不占 SKILL_LIST_CAP 名额 */
  builtin?: boolean;
  createdAt: number;
}

/** 用户技能（非内置）进清单的上限。 */
export const SKILL_LIST_CAP = 20;
/** 描述字符上限；超出在最后一个「；」或「，」处截断。 */
export const SKILL_DESC_MAX = 60;

/** 截断到 limit：优先在 limit 之前最后一个「；」「，」处切（技能简述的惯用写法是
 *  「做什么；什么时候触发」，在那里切能保住完整语义单元）；无分隔符则硬切。 */
export function truncateDescription(desc: string, limit = SKILL_DESC_MAX): string {
  if (desc.length <= limit) return desc;
  const head = desc.slice(0, limit);
  const cut = Math.max(head.lastIndexOf('；'), head.lastIndexOf('，'));
  return `${cut > 0 ? head.slice(0, cut) : head}…`;
}

const byCommand = (a: SkillBrief, b: SkillBrief): number =>
  a.command < b.command ? -1 : a.command > b.command ? 1 : 0;

/** 排序 + 封顶。内置在前（createdAt 升序 = builtin.md 投放顺序），用户技能在后
 *  （createdAt 降序，最新在前——新写的技能更可能是当前任务需要的）。
 *  同 createdAt 用 command 字典序兜底，保证全序（确定性是硬要求）。 */
export function selectSkillBriefs(
  briefs: SkillBrief[],
  cap = SKILL_LIST_CAP,
): { shown: SkillBrief[]; hidden: number } {
  const builtins = briefs
    .filter((s) => s.builtin)
    .sort((a, b) => a.createdAt - b.createdAt || byCommand(a, b));
  const users = briefs
    .filter((s) => !s.builtin)
    .sort((a, b) => b.createdAt - a.createdAt || byCommand(a, b));
  const shownUsers = users.slice(0, cap);
  return { shown: [...builtins, ...shownUsers], hidden: users.length - shownUsers.length };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/agent/skill-brief.test.ts`
Expected: PASS，10 个用例全绿（truncateDescription 5 + selectSkillBriefs 5）

- [ ] **Step 5: 提交**

```bash
git add agent/skill-brief.ts tests/agent/skill-brief.test.ts
git commit -m "feat(skill-brief): 技能清单排序/封顶/截断纯函数

内置常驻不占名额，用户技能上限 20；描述超 60 字符在最后一个分隔符处截断。
排序用 locale 无关比较保证确定性——清单块在缓存前缀里，顺序抖动即缓存全废。"
```

---

### Task 2: `buildSkillsPrompt` 接入封顶 + `agent-port` 传新字段

**Files:**
- Modify: `agent/context.ts:30-46`（`SkillBrief` 定义与 `buildSkillsPrompt`）
- Modify: `background/agent-port.ts:150-153`（`getSkills`）
- Modify: `tests/agent/skills-context.test.ts`（补 `createdAt`、加封顶用例）
- Modify: `tests/agent/context.test.ts:184`、`:215`（补 `createdAt`）

**Interfaces:**
- Consumes: Task 1 的 `SkillBrief`、`selectSkillBriefs`、`truncateDescription`、`SKILL_LIST_CAP`
- Produces: `agent/context.ts` 转出 `SkillBrief`（`export type { SkillBrief } from './skill-brief'`），使 `agent/loop.ts:7` 与 `agent/trace.ts:5` 的既有 `import type { SkillBrief } from './context'` 无需改动

- [ ] **Step 1: 改 `agent/context.ts`**

删掉现有的 `export interface SkillBrief { name: string; command: string; description: string }`（第 32 行），改为从新模块引入并转出：

```ts
import { selectSkillBriefs, truncateDescription, type SkillBrief } from './skill-brief';

// 类型定义在 skill-brief.ts（封顶逻辑与它同址）；此处转出以保持既有 import 不变。
export type { SkillBrief };
```

把 `buildSkillsPrompt`（第 39-46 行）整体替换为：

```ts
export function buildSkillsPrompt(briefs: SkillBrief[], mode: AgentMode = 'agent'): string {
  if (briefs.length === 0) return '';
  const { shown, hidden } = selectSkillBriefs(briefs);
  const lines = shown.map((s) => `- /${s.command} ${s.name}：${truncateDescription(s.description)}`);
  // 自写技能引导只在 agent 模式追加：create/update/delete_skill 既不在 ask 的工具清单里，
  // 也被 registry 的模式守卫硬拒——在 ask 里宣传它们，等于让模型先答应「我给你存成技能」再撞墙。
  const guide = mode === 'agent' ? SKILL_AUTHORING_GUIDE : '';
  // 封顶后必须显式告知「还有没列出来的」并给出找回手段，否则封顶就是能力阉割
  const overflow = hidden > 0
    ? `\n\n以上只列了前 ${shown.length} 个技能；另有 ${hidden} 个未列出，用 list_skills（可传 query 模糊搜索）查看。`
    : '';
  return `\n\n## 可用技能\n\n下面是可用技能的简述（不含正文）。当用户以 /命令 形式触发某技能，或当前任务与某技能明显匹配时，先调用 load_skill 工具（传该技能的 command，不含 /）取回它的完整指令正文，再遵循正文行事，并向用户说明你正在使用哪个技能。不要凭简述臆测正文内容。\n\n${lines.join('\n')}${overflow}${guide}`;
}
```

`SKILL_AUTHORING_GUIDE` 常量本身不动。

- [ ] **Step 2: 改 `background/agent-port.ts` 的 `getSkills`**

把第 150-153 行替换为（多传 `builtin` / `createdAt`，排序与封顶交给 `selectSkillBriefs`——prompt 整形逻辑不落在 background 层）：

```ts
    getSkills: async () =>
      (await listSkills().catch(() => [] as Skill[]))
        .filter((s) => s.enabled)
        .map((s) => ({
          name: s.name, command: s.command, description: s.description,
          builtin: s.builtin, createdAt: s.createdAt,
        })),
```

- [ ] **Step 3: 跑 compile，按报错补齐测试里的 `createdAt`**

Run: `npm run compile`
Expected: FAIL — 所有传 `SkillBrief` 字面量而缺 `createdAt` 的地方报错

在下列位置给字面量补 `createdAt: 1`（`builtin` 可选，不补）：

- `tests/agent/skills-context.test.ts` 第 17、26、40、53、64、102、124、214 行
- `tests/agent/context.test.ts` 第 184、215 行

Run: `npm run compile`
Expected: PASS（无输出）

- [ ] **Step 4: 在 `tests/agent/skills-context.test.ts` 的 `buildSkillsPrompt / buildContext(skills)` describe 内补封顶用例**

```ts
  it('超过 20 个用户技能 → 只列 20 个 + 溢出行，最新的在前', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      name: `技能${i}`, command: `skill-${String(i).padStart(2, '0')}`, description: 'd', createdAt: i,
    }));
    const s = buildSkillsPrompt(many);
    expect(s).toContain('另有 5 个未列出');
    expect(s).toContain('/skill-24'); // createdAt 最大 → 最新在前
    expect(s).not.toContain('/skill-00'); // 被挤出
  });

  it('内置技能不占名额：4 内置 + 20 用户全部列出，无溢出行', () => {
    const builtins = Array.from({ length: 4 }, (_, i) => ({
      name: `内置${i}`, command: `bi-${i}`, description: 'd', builtin: true, createdAt: i,
    }));
    const users = Array.from({ length: 20 }, (_, i) => ({
      name: `用户${i}`, command: `u-${String(i).padStart(2, '0')}`, description: 'd', createdAt: 100 + i,
    }));
    const s = buildSkillsPrompt([...builtins, ...users]);
    expect(s).toContain('/bi-0');
    expect(s).toContain('/u-19');
    expect(s).not.toContain('未列出');
  });

  it('描述超 60 字符被截断（不硬切，在分隔符处收）', () => {
    const long = '第一件事的说明；第二件事的说明；第三件事的说明；第四件事的补充说明文字还有很多很多';
    const s = buildSkillsPrompt([{ name: 'N', command: 'c', description: long, createdAt: 1 }]);
    expect(s).toContain('…');
    expect(s).not.toContain('第四件事的补充说明');
  });

  it('20 个技能以内不出现溢出行', () => {
    const s = buildSkillsPrompt([{ name: 'N', command: 'c', description: 'd', createdAt: 1 }]);
    expect(s).not.toContain('未列出');
  });
```

- [ ] **Step 5: 跑测试**

Run: `npx vitest run tests/agent/skills-context.test.ts tests/agent/context.test.ts tests/agent/skill-brief.test.ts`
Expected: PASS

- [ ] **Step 6: 全量双绿 + 提交**

Run: `npm run compile && npm run test`
Expected: 全绿

```bash
git add agent/context.ts background/agent-port.ts tests/agent/skills-context.test.ts tests/agent/context.test.ts
git commit -m "feat(skills): 技能清单封顶 20 + 溢出行指引

内置 4 个常驻不占名额；描述超 60 字符在分隔符处截断；超出部分以
「另有 N 个未列出，用 list_skills（可传 query）查看」收口。
agent-port 改传 builtin/createdAt，排序与封顶全在 skill-brief.ts。"
```

---

### Task 3: `agent/memory-prompt.ts` 拆 stable / volatile

**Files:**
- Modify: `agent/memory-prompt.ts:95-138`（`buildMemoryPrompt`）
- Modify: `tests/agent/memory-prompt.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `interface MemoryPromptParts { stable: string; volatile: string }`
  - `function buildMemoryPrompt(state: MemoryState, url: string): MemoryPromptParts`
  - `stable` 含「## 记忆」标题、冷启动/已有文案、`usageBlock`；`volatile` 含条目行、未列出计数、站点清单；未启用时两者皆 `''`

- [ ] **Step 1: 改 `buildMemoryPrompt` 的返回形状**

`agent/memory-prompt.ts` 的装箱/分组逻辑（第 98-116 行）**一行不动**，只改第 118 行之后的输出拼装。把第 118-137 行替换为：

```ts
  const stable: string[] = ['\n\n## 记忆\n'];
  if (state.entries.length === 0) {
    stable.push('你具备跨会话的长期记忆，当前为空。\n');
  } else {
    stable.push('下面是你在之前的会话中记录的、以及用户手工维护的长期记忆，它们跨会话持久存在。\n');
  }
  stable.push(usageBlock(state.writable));

  // 易变部分：条目依赖 page.url，站点清单依赖「哪些站点没命中」——两者都随页面变化，
  // 必须与稳定部分分开承载，否则每轮前缀都变（spec §4）。
  const vol: string[] = [];
  if (shownGlobals.length > 0 || shownHits.length > 0) {
    vol.push('记忆条目（当前生效）：');
    for (const m of shownGlobals) vol.push(renderEntry(m));
    for (const m of shownHits) vol.push(renderEntry(m));
  }
  if (droppedCount > 0) {
    vol.push('', `另有 ${droppedCount} 条记忆因长度限制未列出，可用 memory_list 查看。`);
  }
  if (misses.length > 0) {
    vol.push('', `其他站点已有记忆（需要时用 memory_list 取全文）：\n${siteList(misses)}`);
  }
  return { stable: stable.join('\n'), volatile: vol.join('\n') };
```

并把函数签名与开头的提前返回改为：

```ts
export interface MemoryPromptParts {
  /** 稳定部分：说明与用法。进 system 消息，是缓存前缀的一部分。 */
  stable: string;
  /** 易变部分：条目与站点清单（依赖 page.url）。进尾部易变块，无内容时为 ''。 */
  volatile: string;
}

export function buildMemoryPrompt(state: MemoryState, url: string): MemoryPromptParts {
  if (!state.enabled) return { stable: '', volatile: '' };
```

同时更新文件头的注释，把「三层分组 + 半预算装箱 + 站点清单聚合」补上「拆 stable/volatile」的说明。

- [ ] **Step 2: 给 `tests/agent/memory-prompt.test.ts` 加拼合辅助并替换断言主体**

在文件顶部（`const BILI = ...` 之后）加：

```ts
/** 两段拼合：多数断言关心「记忆块整体」，不关心它落在哪一段。 */
const full = (s: MemoryState, url: string): string => {
  const { stable, volatile } = buildMemoryPrompt(s, url);
  return stable + volatile;
};
```

然后把文件里**所有** `buildMemoryPrompt(` 的断言调用改成 `full(`（第 19、20、24、30、39、45、54、64、80、85、94、105、122、131、141 行）。`memoryStateToCap` 的用例不动。

- [ ] **Step 3: 加拆分本身的用例**

在 `tests/agent/memory-prompt.test.ts` 末尾加：

```ts
describe('buildMemoryPrompt 拆 stable / volatile', () => {
  it('说明与用法在 stable，条目在 volatile', () => {
    const { stable, volatile } = buildMemoryPrompt(state([brief({ content: '偏好中文' })]), '');
    expect(stable).toContain('## 记忆');
    expect(stable).toContain('memory_write');
    expect(stable).not.toContain('偏好中文');
    expect(volatile).toContain('偏好中文');
  });

  it('站点清单在 volatile，不在 stable（它是易变的）', () => {
    const { stable, volatile } = buildMemoryPrompt(
      state([brief({ matches: ['*://github.com/*'] })]), BILI);
    expect(stable).not.toContain('*://github.com/*');
    expect(volatile).toContain('*://github.com/*');
  });

  it('空库 → volatile 为空串（尾部块不产生内容）', () => {
    expect(buildMemoryPrompt(state([]), BILI).volatile).toBe('');
  });

  it('未启用 → 两段皆空串', () => {
    expect(buildMemoryPrompt(state([brief()], { enabled: false }), BILI))
      .toEqual({ stable: '', volatile: '' });
  });

  it('只读档的说明在 stable 里就不提写工具', () => {
    const { stable } = buildMemoryPrompt(state([], { writable: false }), BILI);
    expect(stable).not.toContain('memory_write');
    expect(stable).toContain('memory_list');
  });
});
```

- [ ] **Step 4: 跑测试**

Run: `npx vitest run tests/agent/memory-prompt.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add agent/memory-prompt.ts tests/agent/memory-prompt.test.ts
git commit -m "refactor(memory-prompt): 拆出 stable/volatile 两段

说明与用法稳定，条目与站点清单随 page.url 变。拆开后易变部分可以挪出
system 消息，不再打断缓存前缀。装箱/分组逻辑一行未动。"
```

---

### Task 4: `buildContext` 布局重排 —— 易变块移到消息末尾

**Files:**
- Modify: `agent/context.ts:84-127`（`BuildContextOptions` 与 `buildContext`）
- Create: `tests/agent/context-prefix-stability.test.ts`
- Modify: `tests/agent/context.test.ts`（大量断言要跟着挪）
- Modify: `tests/agent/skills-context.test.ts:60-69`

**Interfaces:**
- Consumes: Task 3 的 `buildMemoryPrompt` 返回 `{ stable, volatile }`
- Produces:
  - `function buildVolatileBlock(page: PageInfo, memoryVolatile: string): ChatMessage | undefined`
  - `buildContext` 输出形状变为 `[system, ...history, volatile?]`

- [ ] **Step 1: 写失败的前缀稳定性测试**

创建 `tests/agent/context-prefix-stability.test.ts`：

```ts
// tests/agent/context-prefix-stability.test.ts
// 核心不变量（spec §10）：tools+system+history 是逐字节稳定的缓存前缀，
// 页面/记忆的变化只允许出现在末条易变块里。这条测试是整次优化的验收标准——
// 它挂了就说明前缀缓存白做。
import { describe, it, expect } from 'vitest';
import { buildContext } from '../../agent/context';
import type { ChatMessage } from '../../agent/provider/types';

const u = (c: string): ChatMessage => ({ role: 'user', content: c });
const page = { url: 'https://a.com/x', title: 'A' };
const mem = (content: string) => ({
  enabled: true, writable: true,
  entries: [{ id: 'g1', content, matches: [], updatedAt: 1 }],
});

/** 去掉末条易变块（【环境】…）后的消息数组。 */
const stablePart = (msgs: ChatMessage[]): ChatMessage[] => {
  const last = msgs[msgs.length - 1]!;
  const isVolatile = last.role === 'user'
    && typeof last.content === 'string' && last.content.startsWith('【环境】');
  return isVolatile ? msgs.slice(0, -1) : msgs;
};

describe('前缀稳定性', () => {
  it('连续两轮：第二轮的稳定前缀以第一轮的稳定前缀开头（逐字节）', () => {
    const t1 = buildContext([u('第一句')], page, { memory: mem('偏好中文') });
    const t2 = buildContext([u('第一句'), u('第二句')], page, { memory: mem('偏好中文') });
    const p1 = stablePart(t1), p2 = stablePart(t2);
    expect(JSON.stringify(p2.slice(0, p1.length))).toBe(JSON.stringify(p1));
  });

  it('页面 URL/标题变了，稳定前缀仍逐字节相同', () => {
    const a = buildContext([u('x')], { url: 'https://a.com/1', title: '标题1' }, { memory: mem('m') });
    const b = buildContext([u('x')], { url: 'https://a.com/2', title: '标题2' }, { memory: mem('m') });
    expect(JSON.stringify(stablePart(a))).toBe(JSON.stringify(stablePart(b)));
    // 差异确实存在，只是被关在尾部块里
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it('记忆条目变了，稳定前缀仍逐字节相同', () => {
    const a = buildContext([u('x')], page, { memory: mem('旧记忆') });
    const b = buildContext([u('x')], page, { memory: mem('新记忆') });
    expect(JSON.stringify(stablePart(a))).toBe(JSON.stringify(stablePart(b)));
  });

  it('技能清单变了，稳定前缀跟着变（技能块留在前缀里是刻意的）', () => {
    const a = buildContext([u('x')], page, { skills: [{ name: 'N', command: 'c', description: 'd', createdAt: 1 }] });
    const b = buildContext([u('x')], page, { skills: [] });
    expect(JSON.stringify(stablePart(a))).not.toBe(JSON.stringify(stablePart(b)));
  });
});

describe('易变块内容与位置', () => {
  it('页面信息与记忆条目都进末条易变块，system 里不再有它们', () => {
    const msgs = buildContext([u('x')], page, { memory: mem('偏好中文') });
    const last = msgs[msgs.length - 1]!;
    expect(last.role).toBe('user');
    const text = String(last.content);
    expect(text).toContain('【环境】');
    expect(text).toContain('非用户发言');
    expect(text).toContain('https://a.com/x');
    expect(text).toContain('偏好中文');

    const sys = String(msgs[0]!.content);
    expect(sys).not.toContain('https://a.com/x');
    expect(sys).not.toContain('偏好中文');
    expect(sys).toContain('## 记忆'); // 说明与用法仍在 system
  });

  it('页面为空且记忆易变为空 → 不追加易变块', () => {
    const msgs = buildContext([u('x')], { url: '', title: '' });
    expect(msgs).toHaveLength(2);
    expect(msgs[msgs.length - 1]!.content).toBe('x');
  });

  it('只有记忆易变内容、页面为空 → 仍追加，只带记忆段', () => {
    const msgs = buildContext([u('x')], { url: '', title: '' }, { memory: mem('偏好中文') });
    const text = String(msgs[msgs.length - 1]!.content);
    expect(text).toContain('偏好中文');
    expect(text).not.toContain('当前页面');
  });

  it('summary 分支：易变块仍在最末，摘要位置不变', () => {
    const msgs = buildContext([u('m0'), u('m1')], page, { summary: { text: 'S', coversUpTo: 0 } });
    expect(String(msgs[1]!.content)).toContain('S');
    expect(String(msgs[msgs.length - 1]!.content)).toContain('【环境】');
  });

  it('首轮是两条连续 user（system + 用户话 + 易变块）', () => {
    const msgs = buildContext([u('你好')], page);
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'user']);
  });

  it('ask 模式：记忆按只读渲染，不宣传 memory_write', () => {
    const msgs = buildContext([u('x')], page, { mode: 'ask', memory: mem('m') });
    const sys = String(msgs[0]!.content);
    expect(sys).not.toContain('memory_write');
    expect(sys).not.toContain('memory_delete');
    expect(sys).toContain('memory_list');
  });

  it('agent 模式：记忆仍按可写渲染', () => {
    const sys = String(buildContext([u('x')], page, { mode: 'agent', memory: mem('m') })[0]!.content);
    expect(sys).toContain('memory_write');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/agent/context-prefix-stability.test.ts`
Expected: FAIL —— 页面信息仍在 system 里、没有 `【环境】` 块、`buildContext` 返回 2 条而非 3 条

- [ ] **Step 3: 改 `agent/context.ts`**

把 `buildContext`（第 96-127 行）整体替换为：

```ts
export function buildContext(
  history: ChatMessage[],
  page: PageInfo,
  opts: BuildContextOptions = {},
): ChatMessage[] {
  const { keepRecent = 60, summary, skills, mode = 'agent', systemPrompt, memory } = opts;
  const skillsBlock = buildSkillsPrompt(skills ?? [], mode);
  // ask 模式下记忆按只读渲染：写工具不在 ASK_MODE_TOOLS 里（被 registry 硬拒），
  // 文案不能宣传一个没下发的工具（spec §6.3）。
  const memState = memory ? { ...memory, writable: memory.writable && mode === 'agent' } : undefined;
  const memParts = memState ? buildMemoryPrompt(memState, page.url) : { stable: '', volatile: '' };
  const base = resolveSystemPrompt(systemPrompt);
  // system 只放稳定内容：提示词 + 技能块 + 记忆说明 + 模式段。页面与记忆条目进末尾易变块，
  // 否则导航/写记忆/标题抖动都会打断 tools+system+history 的缓存前缀（spec §3.1）。
  const system: ChatMessage = {
    role: 'system',
    content: base + skillsBlock + memParts.stable + modePrompt(mode),
  };

  let body: ChatMessage[];
  if (summary) {
    // coversUpTo 之后的原始消息为保留段；剥掉头部孤立 tool 消息（其 assistant(toolCalls)
    // 已被折进摘要，回放会因 tool_call_id 悬空 400）。摘要作为一条 user 消息置于顶部。
    // 注：summary 分支不使用 keepRecent——保留边界由压缩流程的 coversUpTo 决定。
    let recent = history.slice(summary.coversUpTo + 1);
    let start = 0;
    while (start < recent.length && recent[start]!.role === 'tool') start += 1;
    recent = recent.slice(start);
    const summaryMsg: ChatMessage = { role: 'user', content: `【前情摘要】\n${summary.text}` };
    body = [summaryMsg, ...trimImageParts(recent)];
  } else {
    body = trimImageParts(truncateMessages(history, keepRecent));
  }

  const volatile = buildVolatileBlock(page, memParts.volatile);
  return volatile ? [system, ...body, volatile] : [system, ...body];
}

/** 易变块：当前页面 + 记忆条目，置于消息数组最末（spec §3.2）。
 *  位置是刻意的——放最末才能让 tools+system+history 成为稳定前缀；
 *  首行显式声明「系统注入、非用户发言」，避免模型把它当成用户的最新指令。
 *  两段都空则不产生该消息。 */
export function buildVolatileBlock(page: PageInfo, memoryVolatile: string): ChatMessage | undefined {
  const parts: string[] = [];
  if (page.url) parts.push(`当前页面：\n- URL: ${page.url}\n- 标题: ${page.title}`);
  if (memoryVolatile) parts.push(memoryVolatile);
  if (parts.length === 0) return undefined;
  return {
    role: 'user',
    content: `【环境】以下为当前页面与记忆的即时状态（由系统注入，非用户发言）：\n\n${parts.join('\n\n')}`,
  };
}
```

删掉原来的 `pageBlock` 局部常量（第 102-104 行）。

- [ ] **Step 4: 跑新测试确认通过**

Run: `npx vitest run tests/agent/context-prefix-stability.test.ts`
Expected: PASS

- [ ] **Step 5: 修 `tests/agent/context.test.ts` 里被布局变化打断的断言**

在文件顶部（`const u = ...` 之后）加两个辅助：

```ts
/** 去掉末条易变块（【环境】…）。多数断言只关心「system + 历史」，不关心尾部块。 */
const body = (msgs: ChatMessage[]): ChatMessage[] => {
  const last = msgs[msgs.length - 1]!;
  return typeof last.content === 'string' && last.content.startsWith('【环境】') ? msgs.slice(0, -1) : msgs;
};
/** 末条易变块的文本；没有则空串。 */
const volatileOf = (msgs: ChatMessage[]): string => {
  const last = msgs[msgs.length - 1]!;
  return typeof last.content === 'string' && last.content.startsWith('【环境】') ? last.content : '';
};
```

逐条改（行号为改动前的）：

| 行 | 现在 | 改成 |
|---|---|---|
| 37-42 | `sys).toContain('https://x.com')` / `'标题'` | `expect(volatileOf(msgs)).toContain('https://x.com')` / `'标题'`；并加 `expect(msgs[0]!.content as string).not.toContain('https://x.com')` |
| 44-47 | `msgs.slice(1)` | `body(msgs).slice(1)`（url 为空时本就不追加易变块，此条改不改都过——为一致性仍改） |
| 85-93 | `msgs.slice(1)` | `body(msgs).slice(1)` |
| 98-100 | `msgs.filter(...)` | `body(msgs).filter(...)` |
| 110-111 | `out[1]` | `body(out)[1]` |
| 121-129 | `out.slice(2)` | `body(out).slice(2)` |
| 139-142 | `out.slice(2)` | `body(out).slice(2)` |
| 150-155 | `out).toHaveLength(2)` | `body(out)).toHaveLength(2)`；并加 `expect(out).toHaveLength(3)` |
| 165-168 | `out.slice(2)` | `body(out).slice(2)` |
| 175-178 | `out).toHaveLength(4)` | `body(out)).toHaveLength(4)` |
| 213-224 | `sys).toContain('当前页面')` | `expect(volatileOf(msgs)).toContain('当前页面')` |
| 239-248 | `sys).toContain('偏好中文回复')` + 顺序断言 | 条目断言改 `volatileOf(msgs)`；顺序断言（`可用技能` < `## 记忆` < `当前模式`）保留在 `sys` 上——这三块都还在 system 里 |
| 254-267 | `sys).toContain('B 站专属经验')` / `not.toContain('GitHub 专属经验')` / `toContain('*://github.com/*')` | 前两条改 `volatileOf(msgs)`；第三条（站点清单）也改 `volatileOf(msgs)` |
| 269-276 | `sys).toContain('偏好中文回复')` | `volatileOf(msgs)).toContain('偏好中文回复')` |

- [ ] **Step 6: 修 `tests/agent/skills-context.test.ts:60-69`**

「buildContext 带 skills → 追加到 system prompt 末尾（页面信息仍在）」这条的 `expect(sys).toContain('当前页面')` 改为断言页面信息落在易变块。把该用例改名并改为：

```ts
  it('buildContext 带 skills → 技能块进 system；页面信息进末尾易变块', () => {
    const msgs = buildContext(
      [{ role: 'user', content: 'hi' }],
      { url: 'https://x.com', title: 'X' },
      { skills: [{ name: 'N', command: 'c', description: 'd', createdAt: 1 }] },
    );
    const sys = msgs[0]!.content as string;
    const last = msgs[msgs.length - 1]!;
    expect(sys).toContain('/c');
    expect(sys).not.toContain('当前页面');
    expect(String(last.content)).toContain('当前页面');
    expect(String(last.content)).toContain('https://x.com');
  });
```

- [ ] **Step 7: 修 `tests/agent/loop.test.ts` 里两条会挂的记忆断言**

`describe('loop 注入记忆')` 里有两条断言记忆条目在 system 里，布局改动后条目搬到了末条易变块：

- 「getMemoryState 的条目进 system 消息…」（约 640-660 行）：`expect(sys).toContain('偏好中文回复')` → 改为对末条消息断言：

```ts
    const last = String(captured[0]!.messages[captured[0]!.messages.length - 1]!.content);
    expect(last).toContain('偏好中文回复');
```

- 「writable:false → 有记忆块但只下发 memory_list」（约 680-700 行）：`expect(...messages[0]!.content)).toContain('人工维护的记忆')` → 同样改对末条消息断言。

**注意**：这两条的 `getPageInfo` 都返回 `{ url: '', title: '' }`，但易变块因记忆条目非空仍会被追加——所以末条消息确实是易变块，不是用户原话。

同 describe 内的另外两条（`enabled:false` 与「不提供 getMemoryState」断言 `not.toContain('## 记忆')`）**不会挂**：前者 volatile 为空、后者根本没有记忆块。`tests/agent/loop-trace.test.ts` 与 `tests/agent/tools/skill-pool.test.ts` 不受影响。

- [ ] **Step 8: 全量双绿**

Run: `npm run compile && npm run test`
Expected: 全绿。若仍有失败，用「去掉末条易变块」的思路修断言，**不要改实现去迁就测试**。

- [ ] **Step 9: 提交**

```bash
git add agent/context.ts tests/agent/context.test.ts tests/agent/context-prefix-stability.test.ts tests/agent/skills-context.test.ts
git commit -m "feat(context): 易变块移到消息末尾，tools+system+history 成为稳定前缀

页面 URL/标题与记忆条目从 system 消息挪到末条 user 易变块，使前缀在
导航、写记忆、标题抖动时都不再失效——保护的是整段历史正文的缓存。
ask 模式下记忆同步按只读渲染（写工具没下发，文案不能宣传它）。"
```

---

### Task 5: ask 工具集 18 → 10

**Files:**
- Modify: `agent/mode.ts:6-28`（`ASK_MODE_TOOLS`）、`agent/mode.ts:72-77`（`modePrompt('ask')`）
- Modify: `tests/agent/mode.test.ts:9-48`、`:142-147`

**Interfaces:**
- Consumes: 无
- Produces: `ASK_MODE_TOOLS` 恰为 10 个工具名（见下）

- [ ] **Step 1: 改 `ASK_MODE_TOOLS`**

把 `agent/mode.ts` 第 6-28 行整体替换为：

```ts
/** ask 模式可用的只读工具：ask = 「看页面 + 答问 + 加载技能」。
 *  收走的三类（spec §6.1）：深度观测与依赖它的 get_network_request、wait_for（没有操作可做，
 *  无等待对象）、脚本池读三件（属「写脚本」链路，agent 主场）。
 *  记忆只留 memory_list——写工具随其余写能力一并收走，使 ask 的边界整齐：
 *  完全不产生任何持久化副作用（spec 决策 7，修订 2026-09-07 spec §3.4 的「三工具全留」）。 */
export const ASK_MODE_TOOLS: ReadonlySet<string> = new Set([
  'take_snapshot',          // 读页面结构
  'query_page',             // 定向查询（纯读，与 take_snapshot 同性质）
  'take_screenshot',        // 截图（喂多模态）
  'list_pages',             // 列标签页
  'list_console_messages',
  'list_network_requests',
  'load_skill',             // 取技能正文
  'list_skills',
  'get_skill',
  'memory_list',            // 记忆只读
]);
```

- [ ] **Step 2: 改 `modePrompt('ask')` 文案**

把 `agent/mode.ts` 第 74 行的 ask 分支返回值替换为：

```ts
    return `\n\n## 当前模式：ask（只读问答）\n\n你现在处于 ask 模式：只有【只读】工具（看页面结构、截图、读控制台/网络、加载技能、读记忆）。你【不能】点击、填写、导航、开关标签页、执行脚本、发 HTTP 请求、增删改脚本或技能、写入记忆。\n- 回答「这是什么/为什么/怎么样」类问题，解读页面内容、截图、报错与网络请求。\n- 用户要你执行会改动页面或浏览器状态的操作时，说明当前是只读模式，请他切换到 agent 模式（输入框旁的模式下拉框）。\n- 你依然可以用 load_skill 取技能正文来遵循其问答/分析类流程。\n- 本模式不产生任何持久化副作用：不改网页、不改脚本与技能、不写记忆。`;
```

- [ ] **Step 3: 改 `tests/agent/mode.test.ts` 的白名单断言**

- 第 23-29 行「包含读页面/观测/脚本读/技能读工具」的列表改为 `['take_snapshot', 'take_screenshot', 'list_pages', 'list_console_messages', 'list_network_requests', 'load_skill', 'list_skills', 'get_skill']`。
- 第 31-33 行「grep_script 属只读，ask 模式可用」改为断言**不在**白名单：

```ts
  it('grep_script 虽只读，但属「写脚本」链路，ask 已收走', () => {
    expect(ASK_MODE_TOOLS.has('grep_script')).toBe(false);
  });
```

- 第 39-43 行「记忆三工具在 ask 白名单内」改为：

```ts
  it('ask 只留 memory_list：写工具随其余写能力一并收走', () => {
    expect(ASK_MODE_TOOLS.has('memory_list')).toBe(true);
    expect(ASK_MODE_TOOLS.has('memory_write')).toBe(false);
    expect(ASK_MODE_TOOLS.has('memory_delete')).toBe(false);
  });
```

- 第 10-21 行的「不含任何写操作」用例：把顶部那段说明 `memory_write / memory_delete 虽名为「写」，但刻意在白名单内` 的注释删掉（已过时），并把这两个名字加入 `writeTools` 列表。

- [ ] **Step 4: 加集合相等断言**

在 `ASK_MODE_TOOLS 白名单` describe 内加：

```ts
  it('ask 工具集恰为 10 个（集合相等，防止悄悄加回）', () => {
    expect([...ASK_MODE_TOOLS].sort()).toEqual([
      'get_skill', 'list_console_messages', 'list_network_requests', 'list_pages',
      'list_skills', 'load_skill', 'memory_list', 'query_page', 'take_screenshot', 'take_snapshot',
    ]);
  });
```

- [ ] **Step 5: 跑测试**

Run: `npx vitest run tests/agent/mode.test.ts`
Expected: PASS

- [ ] **Step 6: 全量双绿 + 提交**

Run: `npm run compile && npm run test`
Expected: 全绿

```bash
git add agent/mode.ts tests/agent/mode.test.ts
git commit -m "feat(mode): ask 工具集 18 → 10，边界收为「看页面 + 答问 + 加载技能」

收走 toggle_deep_observe / get_network_request / wait_for / 脚本池读三件 /
记忆写两件（约 -4.7K 字符）。记忆只留 memory_list，使 ask 的边界整齐：
完全不产生任何持久化副作用。修订 2026-09-07 spec §3.4 的记忆决定。"
```

---

### Task 6: 工具 schema 中等档瘦身

**Files:**
- Create: `tests/agent/schema-budget.test.ts`
- Modify: `agent/tools/schemas.ts`（37 个工具的 description）
- Modify: `tests/agent/tools/schemas.test.ts`（跟随断言）

**Interfaces:**
- Consumes: 无
- Produces: 无新接口——只改文案。`getToolSchemas` 的签名与工具名集合不变

**注意**：这是本计划唯一一个「按规则批量改写文案」的任务。硬指标是 Step 3 的预算测试，**不要为了凑某个逐工具数字而删操作要点**。

- [ ] **Step 1: 写预算测试（先失败）**

创建 `tests/agent/schema-budget.test.ts`：

```ts
// tests/agent/schema-budget.test.ts
// schema 体积预算（spec §5.3）：把「描述又写长了」变成 CI 可见的回归。
//
// 必须基于序列化后的 schema，不能基于 schemas.ts 源码文本——obj() 辅助函数在运行时
// 才生成 type/properties/required/additionalProperties 那层包装，按源码统计会漏算
// 57% 的结构开销（spec §0.1）。
import { describe, it, expect } from 'vitest';
import { getToolSchemas } from '../../agent/tools/registry';

const BUDGET_TOTAL = 15_800;
const BUDGET_PER_TOOL = 1_400;

describe('工具 schema 体积预算', () => {
  const schemas = getToolSchemas('agent', 'full');

  it(`总量不超过 ${BUDGET_TOTAL} 字符`, () => {
    const total = schemas.reduce((a, s) => a + JSON.stringify(s).length, 0);
    expect(total).toBeLessThanOrEqual(BUDGET_TOTAL);
  });

  it(`单个工具不超过 ${BUDGET_PER_TOOL} 字符`, () => {
    const over = schemas
      .map((s) => ({ name: s.function.name, len: JSON.stringify(s).length }))
      .filter((r) => r.len > BUDGET_PER_TOOL);
    expect(over).toEqual([]);
  });

  it('工具数不变（37 个）', () => {
    expect(schemas).toHaveLength(37);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/agent/schema-budget.test.ts`
Expected: FAIL —— 总量 19,745 > 15,800；`update_script` 1,745 > 1,400

- [ ] **Step 3: 按规则逐工具改写 `agent/tools/schemas.ts`**

**规则**（spec §5.1）：

| 动作 | 判据 |
|---|---|
| **删** | 与 `SYSTEM_PROMPT`「工具使用要点」重复的跨工具引导 |
| **删** | 设计论证（实现理由、为什么这么设计、与其他方案比便宜多少） |
| **删** | 工具级 `description` 里逐分支复述、而参数级 `description` 已完整承载的内容 |
| **合并** | 同一参数在多处重复的描述 |
| **压** | 冗长边界说明与长枚举/示例压成短句缩写 |
| **留** | 工具特有操作要点（uid 失效、`detail` 档位、`region` 用法、分步写入、`balance` 配平含义） |
| **留** | 用户可感知的后果（深度观测的提示条、附着期间开不了 DevTools） |
| **留** | 参数级 `description`（模型填参的唯一依据，只删与工具级重复的部分） |
| **不动** | 结构管道：`obj()` 生成的包装、`anyOf` 结构、enum 取值、协议字段 |

**可削空间**（序列化字符，spec §5.2；`散文` = 可削，`地板` = 结构管道不可削）：

| 工具 | 现在 | 散文 | | 工具 | 现在 | 散文 |
|---|---|---|---|---|---|---|
| `update_script` | 1745 | 850 | | `get_network_request` | 505 | 280 |
| `query_page` | 1314 | 645 | | `list_console_messages` | 484 | 184 |
| `update_skill` | 1197 | 586 | | `memory_list` | 483 | 238 |
| `create_script` | 886 | 594 | | `get_skill` | 411 | 210 |
| `evaluate_script` | 785 | 393 | | `load_skill` | 389 | 177 |
| `create_skill` | 729 | 471 | | `take_screenshot` | 377 | 103 |
| `list_scripts` | 716 | 461 | | `list_skills` | 326 | 121 |
| `memory_write` | 715 | 391 | | `memory_delete` | 311 | 106 |
| `take_snapshot` | 712 | 445 | | `click` | 331 | 85 |
| `grep_script` | 660 | 265 | | `delete_skill` | 291 | 87 |
| `toggle_deep_observe` | 633 | 411 | | `press_key` | 345 | 68 |
| `get_script` | 619 | 330 | | `fill` | 306 | 57 |
| `wait_for` | 580 | 211 | | `close_page` | 263 | 55 |
| `list_network_requests` | 563 | 214 | | `toggle_script` | 313 | 52 |
| `http_request` | 520 | 90 | | `new_page` | 296 | 45 |

**散文极少的工具不要动**：`fill_form`(19)、`delete_script`(18)、`scroll`(21)、`hover`(39)、`list_pages`(42)、`navigate_page`(43)、`select_page`(44)、`new_page`(45)、`toggle_script`(52)、`close_page`(55)、`fill`(57)、`press_key`(68)、`click`(85)、`http_request`(90)。它们已贴着地板，动它们只有风险没有收益。

**三个worked example：**

**例 1 — `take_snapshot`（删重复 + 删论证 + 压边界）**

改前：
```
'获取页面内容树，每行带 [uid]，用 uid 做 click/fill/hover。默认 detail="interactive"：只出可交互元素、标题与视口内文本，容器折叠为「… [N 个未展开节点]」计数行（体量约为全量的一半）。需要完整文本时用 detail="full"；只关心某个区域时用 region 限定（比 full 便宜得多）。已知目标是什么时，优先用 query_page 定向查询而非倒整棵树。注意 uid 定位到元素，同一元素下多行文本共享同一 uid（非逐行唯一）；隐藏子菜单聚合在父节点 description 里，要操作需先 hover 展开再重新快照。穿透同源 iframe；跨域 iframe 内容无法读取，返回值的 skippedFrames 会计数。页面变化后 uid 失效，需重新调用。'
```
改后（删「已知目标…」（`SYSTEM_PROMPT` 已有）、删「体量约为全量的一半」与「比 full 便宜得多」（论证）、压 iframe 句）：
```
'获取页面内容树，每行带 [uid]，用 uid 做 click/fill/hover。默认 detail="interactive"：只出可交互元素、标题与视口内文本，容器折叠为「… [N 个未展开节点]」计数行。需要完整文本时用 detail="full"；只关心某个区域时用 region 限定。注意 uid 定位到元素，同一元素下多行文本共享同一 uid（非逐行唯一）；隐藏子菜单聚合在父节点 description 里，要操作需先 hover 展开再重新快照。穿透同源 iframe，跨域 iframe 读不到，skippedFrames 计数。页面变化后 uid 失效，需重新调用。'
```

**例 2 — `update_script`（工具级删分支复述，语义归参数级）**

改前（工具级 570 字符，六个分支各讲一遍，而每个分支在 `patch.properties` 里又讲了一遍）：
```
'更新用户脚本。patch 至少一项：applyUpdate 从脚本更新源（@updateURL/@downloadURL）拉取远端最新文本并覆盖本地（含代码与头部设置，会覆盖本地修改；脚本无更新源则报错——常用于 list_scripts 显示 update.hasUpdate 后应用更新，也可不经检查直接拉最新）；text 整文替换（完整 .user.js 原文，重新解析头部）；edit 行区间替换（1-based 含端点，越界报错，替换后整体重解析）；enabled 启停。applyUpdate 与各文本分支互斥且优先。改头部字段（名称/匹配/时机等）就是改原文，没有独立字段可改。规则/代码更新在下次页面导航后生效。append 追加到原文末尾（不需要行号，分步写脚本的主力）；replace 按字面量精确替换 {old,new,all?}（不依赖行号，old 必须在原文中唯一，命中多处会报错并列出行号，可加上下文让它唯一或传 all:true）。text/edit/append/replace 四支互斥，一次只能传一支。返回里的 balance 是括号配平状态：分步过程中骨架未闭合时为 unclosed（正常），最后一段写完应为 ok；若不为 ok 就用 grep_script 定位漏掉的括号再 replace 修正。'
```
改后（只留调度约束与「模型不知道就做错」的要点，分支语义交给参数级）：
```
'更新用户脚本。patch 至少一项，六个分支互斥、一次只能传一支（applyUpdate 优先于各文本分支）。改头部字段（名称/匹配/时机等）就是改原文，没有独立字段可改。规则/代码更新在下次页面导航后生效。返回的 balance 是括号配平状态：分步过程中骨架未闭合时为 unclosed（正常），最后一段写完应为 ok；不为 ok 就用 grep_script 定位漏掉的括号再 replace 修正。'
```
`patch.properties` 里各分支的 description **全部保留**（含 `applyUpdate` 的「会覆盖本地修改」「无更新源则报错」、`replace` 的「old 需唯一」「命中多处报错」等）。

**例 3 — `query_page`（合并四处重复的 locator 描述）**

`locator` 现在写了四遍：`anyOf[0..2]` 三个分支各一份，顶层 `locator.description` 又完整复述一遍（含 `role`/`text`/`near`/`nth`/`exact` 的说明，而它们在 `anyOf[2].properties` 里已有）。

改法：三个分支的 `description` **保留**（模型按形状读，这是有效信息）；顶层 `locator.description` 压成一句指针：
```
'三形状之一：CSS 选择器字符串、元素 uid 数字，或语义对象（各形状的字段说明见对应分支）'
```
并删掉 `anyOf[2].properties` 里与顶层重复的字段说明——只保留一处。**注意**：`anyOf` 结构本身与 `additionalProperties: false` 一律不动，它们是防「模型把语义对象序列化成 JSON 字符串」的实际约束（源码注释已说明）。

**改写的顺序**：先改「可削空间」表里散文 ≥ 200 的 17 个工具（收益集中在这里），再扫一遍散文 100–200 的（`list_console_messages`/`get_skill`/`load_skill`/`take_screenshot`/`list_skills`/`memory_delete`/`toggle_script` 等），最后不动散文 < 100 的。

- [ ] **Step 4: 反复跑预算测试直到通过**

Run: `npx vitest run tests/agent/schema-budget.test.ts`
Expected: PASS（总量 ≤ 15,800，单工具 ≤ 1,400）

- [ ] **Step 5: 修 `tests/agent/tools/schemas.test.ts` 的跟随断言**

Run: `npx vitest run tests/agent/tools/schemas.test.ts`
Expected: FAIL —— 断言了具体描述文案的用例会挂

逐条改：断言应改为**语义要点**而非整句文案。例如断言 `toContain('跨域 iframe 内容无法读取')` 改成 `toContain('跨域 iframe')`；断言整句设计论证的用例直接删掉（那些句子本来就是要删的）。**不要为了让旧断言过而把删掉的句子加回来。**

- [ ] **Step 6: 全量双绿 + 提交**

Run: `npm run compile && npm run test`
Expected: 全绿

```bash
git add agent/tools/schemas.ts tests/agent/schema-budget.test.ts tests/agent/tools/schemas.test.ts
git commit -m "refactor(schemas): 工具描述中等档瘦身，加体积预算测试

删与 SYSTEM_PROMPT 重复的跨工具引导、删设计论证、合并工具级与参数级重复的
分支复述。结构管道（占 57%）与全部操作要点、参数说明一律保留。
新增预算测试：总量 ≤15.8K、单工具 ≤1.4K，防止描述回涨。"
```

---

### Task 7: `list_skills` 加模糊搜索

**Files:**
- Create: `shared/skill-search.ts`
- Test: `tests/shared/skill-search.test.ts`
- Modify: `agent/tools/skill-pool.ts:48-60`（`doListSkills`）
- Modify: `agent/tools/schemas.ts`（`list_skills` 的 schema，加 `query` 参数）
- Modify: `tests/agent/tools/skill-pool.test.ts`

**Interfaces:**
- Consumes: `SkillListEntry`（`agent/tools/skill-pool.ts:46`，= `SkillSummary & { contentChars: number }`）
- Produces:
  - `interface SkillSearchHit { skill: SkillListEntry; score: number }`
  - `function searchSkills(skills: SkillListEntry[], query: string): SkillSearchHit[]`（空 query 返回原序全量；命中 0 个返回空数组）

- [ ] **Step 1: 写失败的测试**

创建 `tests/shared/skill-search.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { searchSkills } from '../../shared/skill-search';

const s = (command: string, name = 'N', description = 'd') =>
  ({ id: command, command, name, description, enabled: true, updatedAt: 1, contentChars: 10 });

const cmds = (r: { skill: { command: string } }[]) => r.map((h) => h.skill.command);

describe('searchSkills', () => {
  it('空 query → 原序全量', () => {
    const all = [s('b'), s('a'), s('c')];
    expect(cmds(searchSkills(all, ''))).toEqual(['b', 'a', 'c']);
    expect(cmds(searchSkills(all, '   '))).toEqual(['b', 'a', 'c']);
  });

  it('command 精确命中置顶', () => {
    const all = [s('write-script'), s('script-helper'), s('script')];
    expect(cmds(searchSkills(all, 'script'))[0]).toBe('script');
  });

  it('command 子串命中排在 name 子串之前', () => {
    const all = [s('zzz', '脚本工具'), s('script-x', '别的')];
    expect(cmds(searchSkills(all, 'script'))).toEqual(['script-x']);
  });

  it('中文按子串命中 name 与 description', () => {
    const all = [s('a', '网页翻译', '把当前页翻成中文'), s('b', '别的', '无关')];
    expect(cmds(searchSkills(all, '翻译'))).toEqual(['a']);
    expect(cmds(searchSkills(all, '翻成中文'))).toEqual(['a']);
  });

  it('字符子序列兜底：wscr → write-script', () => {
    const all = [s('write-script', '写脚本'), s('unrelated', '无关')];
    expect(cmds(searchSkills(all, 'wscr'))).toEqual(['write-script']);
  });

  it('大小写不敏感', () => {
    const all = [s('Write-Script', 'X')];
    expect(cmds(searchSkills(all, 'WRITE'))).toEqual(['Write-Script']);
  });

  it('命中 0 个 → 空数组', () => {
    expect(searchSkills([s('a')], 'zzzzz')).toEqual([]);
  });

  it('同分按 command 字典序兜底（确定性）', () => {
    const all = [s('zz', '同名', '同描述'), s('aa', '同名', '同描述')];
    expect(cmds(searchSkills(all, '同名'))).toEqual(['aa', 'zz']);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/shared/skill-search.test.ts`
Expected: FAIL — `Failed to resolve import "../../shared/skill-search"`

- [ ] **Step 3: 写实现**

创建 `shared/skill-search.ts`：

```ts
// shared/skill-search.ts
// 技能模糊检索（spec §7.4）。纯函数，无 storage / React 依赖。
//
// 存在的理由：系统提示词里的技能清单封顶 20 个，未列出的技能必须能被找回，
// 否则封顶就是能力阉割。打分五档，同分按 command 字典序兜底（确定性）。
import type { SkillSummary } from './types';

export interface SkillSearchHit {
  skill: SkillSummary & { contentChars: number };
  score: number;
}

const SCORE_EXACT_COMMAND = 100;
const SCORE_COMMAND_SUBSTR = 80;
const SCORE_NAME_SUBSTR = 60;
const SCORE_DESC_SUBSTR = 40;
const SCORE_SUBSEQUENCE = 20;

/** needle 的字符是否按序出现在 hay 中（不要求连续）。用于缩写检索（wscr → write-script）。 */
function isSubsequence(needle: string, hay: string): boolean {
  let i = 0;
  for (const ch of hay) {
    if (ch === needle[i]) i += 1;
    if (i === needle.length) return true;
  }
  return i === needle.length;
}

function scoreOne(
  skill: SkillSearchHit['skill'],
  q: string,
): number {
  const command = skill.command.toLowerCase();
  if (command === q) return SCORE_EXACT_COMMAND;
  if (command.includes(q)) return SCORE_COMMAND_SUBSTR;
  if (skill.name.toLowerCase().includes(q)) return SCORE_NAME_SUBSTR;
  if (skill.description.toLowerCase().includes(q)) return SCORE_DESC_SUBSTR;
  if (isSubsequence(q, command)) return SCORE_SUBSEQUENCE;
  return 0;
}

/** 按 query 检索技能。空 query（含纯空白）返回原序全量——保持 list_skills 的既有行为；
 *  命中 0 个返回空数组，诊断文案由工具层组装。 */
export function searchSkills(skills: SkillSearchHit['skill'][], query: string): SkillSearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return skills.map((skill) => ({ skill, score: 0 }));
  return skills
    .map((skill) => ({ skill, score: scoreOne(skill, q) }))
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score
      || (a.skill.command < b.skill.command ? -1 : a.skill.command > b.skill.command ? 1 : 0));
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/shared/skill-search.test.ts`
Expected: PASS

- [ ] **Step 5: 接进 `doListSkills`**

把 `agent/tools/skill-pool.ts` 第 48-60 行替换为：

```ts
export async function doListSkills(args: { enabled?: boolean; query?: string }): Promise<ToolResult> {
  try {
    let skills: SkillListEntry[] = (await listSkills()).map((s) => ({
      ...toSkillSummary(s), contentChars: s.content.length,
    }));
    // != null 而非 !== undefined：模型 JSON 透传的 null 会被后者当成「要过滤」，于是静默返回空列表——
    // 读起来就是「技能库是空的」，而查重恰恰是写技能前的第一步。写路径用的是同一个判据。
    if (args.enabled != null) skills = skills.filter((s) => s.enabled === args.enabled);

    const q = typeof args.query === 'string' ? args.query.trim() : '';
    if (!q) return { ok: true, data: { skills } };

    const hits = searchSkills(skills, q);
    // 命中 0 个时不返回空列表——模型读到空数组会以为技能库是空的。给诊断（同 query_page 命中 0 个的思路）
    if (hits.length === 0) {
      return {
        ok: true,
        data: {
          skills: [],
          hint: `无匹配「${q}」；技能库共 ${skills.length} 个，前 10 个是：`
            + skills.slice(0, 10).map((s) => `/${s.command} ${s.name}`).join('、'),
        },
      };
    }
    return { ok: true, data: { skills: hits.map((h) => h.skill) } };
  } catch (e) {
    return { ok: false, error: `list_skills 失败：${err(e)}` };
  }
}
```

并在文件顶部 import 区加：

```ts
import { searchSkills } from '../../shared/skill-search';
```

- [ ] **Step 6: 改 `list_skills` 的 schema**

在 `agent/tools/schemas.ts` 里把 `list_skills` 的 description 与 parameters 替换为：

```ts
      name: 'list_skills',
      description:
        '列出技能库中的技能摘要（不含正文）。系统提示里只列前 20 个技能，找未列出的用 query 模糊搜索（子串匹配 command/名字/简述，也支持缩写如 wscr）。写技能之前先调用它查重——已有同 command 或功能相近的技能时，先问用户「改写它还是另建一个」，不要默默建重叠的。contentChars 是正文字符数：超过 8000 说明改写要分步。',
      parameters: obj({
        enabled: { type: 'boolean', description: '按启用状态过滤' },
        query: { type: 'string', description: '模糊搜索关键词；缺省列出全部' },
      }),
```

- [ ] **Step 7: 补 `tests/agent/tools/skill-pool.test.ts` 的用例**

该文件已 import `{ listSkills, newSkill, saveSkill }`（来自 `'../../../storage/skills'`）并有 `beforeEach(() => fakeBrowser.reset())`。在 `describe('skill-pool 工具执行器')` 内加：

```ts
  it('query 命中时只返回命中项', async () => {
    await saveSkill(newSkill({ name: '网页翻译', command: 'translate', description: '把当前页翻成中文', content: 'x' }));
    await saveSkill(newSkill({ name: '别的', command: 'other', description: '无关', content: 'x' }));
    const r = await doListSkills({ query: '翻译' });
    expect(r.ok).toBe(true);
    expect((data(r).skills as Array<{ command: string }>).map((s) => s.command)).toEqual(['translate']);
  });

  it('query 命中 0 个 → 空列表 + 诊断提示（不返回裸空数组）', async () => {
    await saveSkill(newSkill({ name: '网页翻译', command: 'translate', description: 'd', content: 'x' }));
    const r = await doListSkills({ query: 'zzzzz' });
    expect(r.ok).toBe(true);
    expect(data(r).skills).toEqual([]);
    expect(String(data(r).hint)).toContain('无匹配');
    expect(String(data(r).hint)).toContain('/translate');
  });

  it('不传 query → 全量原序（行为不变）', async () => {
    await saveSkill(newSkill({ name: 'A', command: 'aaa', description: 'd', content: 'x' }));
    const r = await doListSkills({});
    expect(r.ok).toBe(true);
    expect(data(r).skills).toHaveLength(1);
  });
```

（`data` 是该文件已有的取 data 辅助：`const data = (r) => (r.data ?? {}) as Record<string, unknown>`。）

- [ ] **Step 8: 全量双绿 + 提交**

Run: `npm run compile && npm run test`
Expected: 全绿

```bash
git add shared/skill-search.ts tests/shared/skill-search.test.ts agent/tools/skill-pool.ts agent/tools/schemas.ts tests/agent/tools/skill-pool.test.ts
git commit -m "feat(skills): list_skills 加 query 模糊搜索

五档打分（command 精确 > command 子串 > name 子串 > 简述子串 > 字符子序列），
同分按 command 字典序兜底。命中 0 个返回诊断而非裸空数组。
技能清单封顶后，这是模型找回未列出技能的唯一通道。"
```

---

### Task 8: 易变块字符数进 conv-debug

**Files:**
- Modify: `storage/traces.ts:9-18`（`TurnContextSummary`）
- Modify: `agent/trace.ts:30-47`（`summarizeContext`）
- Modify: `components/convdebug/TurnTimeline.tsx:49-54`
- Modify: `tests/agent/trace.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `buildContext` 输出形状（末条可能是 `【环境】…` 的 user 消息）
- Produces: `TurnContextSummary.volatileChars: number`

- [ ] **Step 1: 加字段**

`storage/traces.ts` 的 `TurnContextSummary` 里加：

```ts
  /** 尾部易变块（【环境】…）的字符数。布局改动后「system 变小了但总量没变」是常见误判，
   *  单独计一列才能看清构成。注意这只是字符计量，不是缓存命中计量。 */
  volatileChars: number;
```

**这个字段是必填的，会让 4 个以对象字面量构造 `TurnContextSummary` 的测试文件编译失败**，逐个补 `volatileChars: 0`（或按用例给具体值）：

- `tests/convdebug/conv-debug-app.test.tsx:12`
- `tests/convdebug/turn-timeline.test.tsx:10`
- `tests/convdebug/utils.test.ts:12`
- `tests/storage/traces.test.ts:16`

（`tests/agent/trace.test.ts` 与 `tests/agent/loop-trace.test.ts` 用的是 `summarizeContext` 与 recorder，不需要改字面量。）

- [ ] **Step 2: 在 `summarizeContext` 里统计**

`agent/trace.ts` 的 `summarizeContext` 中，在 `return` 前加：

```ts
  const last = messages[messages.length - 1];
  const volatileChars = last
    && last.role === 'user'
    && typeof last.content === 'string'
    && last.content.startsWith('【环境】')
    ? last.content.length
    : 0;
```

并在返回对象里加 `volatileChars,`。

同时更新 `createTurnRecorder` 里 `rec.context` 的初始值（`agent/trace.ts:74-77`），补 `volatileChars: 0`。

- [ ] **Step 3: 在 conv-debug 展示**

`components/convdebug/TurnTimeline.tsx` 第 51-53 行的「上下文」`<dd>` 里，在「系统提示词 {formatChars(...)}」之后追加：

```tsx
                    {' '}· 易变块 {formatChars(t.context.volatileChars)}
```

- [ ] **Step 4: 补测试**

在 `tests/agent/trace.test.ts` 里加：

```ts
  it('summarizeContext 统计尾部易变块字符数', () => {
    const msgs = [
      { role: 'system' as const, content: 'S' },
      { role: 'user' as const, content: 'hi' },
      { role: 'user' as const, content: '【环境】以下为…\n\n当前页面：\n- URL: https://a.com' },
    ];
    const s = summarizeContext(msgs, { pageUrl: 'https://a.com' });
    expect(s.volatileChars).toBe(msgs[2]!.content.length);
  });

  it('没有易变块时 volatileChars = 0', () => {
    const s = summarizeContext([{ role: 'system' as const, content: 'S' }], { pageUrl: '' });
    expect(s.volatileChars).toBe(0);
  });
```

- [ ] **Step 5: 全量双绿 + 提交**

Run: `npm run compile && npm run test`
Expected: 全绿

```bash
git add storage/traces.ts agent/trace.ts components/convdebug/TurnTimeline.tsx tests/agent/trace.test.ts
git commit -m "feat(convdebug): 轮次时间线展示易变块字符数

布局改动后「system 变小了但总量没变」是常见误判来源，单独计一列看清构成。
这只是字符计量，不是缓存命中计量（spec §9 已记为已知盲区）。"
```

---

## 收尾核对

全部任务完成后：

- [ ] `npm run compile && npm run test` 双绿。
- [ ] 手动量一次收益，与 spec §2 的目标对账：

```bash
cat > tests/_tmp-final.test.ts <<'EOF'
import { describe, it } from 'vitest';
import { writeFileSync } from 'fs';
import { buildContext } from '../agent/context';
import { getToolSchemas } from '../agent/tools/registry';
describe('final', () => { it('x', () => {
  const briefs = [
    { name: '帮助', command: 'help', description: '介绍本扩展的功能与用法；当用户询问扩展能做什么、怎么用时触发', builtin: true, createdAt: 1 },
    { name: '发现脚本', command: 'find-scripts', description: '从 Greasy Fork / OpenUserJS 搜索、推荐并安装用户脚本；用户想找现成脚本时触发', builtin: true, createdAt: 2 },
    { name: '编写脚本', command: 'write-script', description: '先查脚本池查重、与用户确认需求与方案，再分步编写安装用户脚本；用户想定制脚本时触发', builtin: true, createdAt: 3 },
    { name: '写技能', command: 'write-skill', description: '把一套反复用到的流程沉淀成技能（/命令）；用户要求把流程固定下来、或同类需求反复出现时触发', builtin: true, createdAt: 4 },
  ];
  const mem = { enabled: true, writable: true, entries: [] as unknown[] };
  const out: string[] = [];
  for (const mode of ['agent', 'ask'] as const) {
    const msgs = buildContext([{ role: 'user', content: '你好' }], { url: 'https://a.com', title: 'A' },
      { skills: briefs, mode, memory: mem as never });
    const tools = getToolSchemas(mode, 'full');
    const sys = (msgs[0]!.content as string).length;
    const vol = (msgs[msgs.length - 1]!.content as string).length;
    const t = tools.reduce((a, s) => a + JSON.stringify(s).length, 0);
    out.push(`${mode}: system=${sys} volatile=${vol} tools=${t}(${tools.length}个) 合计=${sys + vol + t}`);
  }
  writeFileSync('final.txt', out.join('\n'), 'utf8');
}); });
EOF
npx vitest run tests/_tmp-final.test.ts >/dev/null 2>&1; cat final.txt; rm -f tests/_tmp-final.test.ts final.txt
```

对账基线（spec §0）：agent 21,708 → 目标 ~17,400；ask 11,861 → 目标 ~6,400。若差距超过 10%，先查是不是有工具描述没改到，别急着改测试阈值。

- [ ] 实机验证一次（**必须**，布局改动是行为改动）：加载扩展 → 侧栏跑一次 agent 会话（含一次导航）→ 打开 AI 会话调试页确认：易变块字符数正常、system 里不再有 URL、模型仍知道当前页面（问它「现在这页是什么」）。再跑一次 ask 会话确认只读边界与记忆只读文案。
- [ ] 把实测数字与结论补进 `docs/history.md`。
