# Skill 系统 + 斜杠指令 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 系统级 skill 管理（设置页二级页，.md 导入/导出/列表/详情/启停/删除）+ 启用 skill 简述常驻注入会话 system prompt + 输入框 `/` 斜杠浮层触发 skill 正文单轮注入。

**Architecture:** 与脚本池同构的四层链路：`shared/skill-md.ts`（md 解析/序列化纯函数）→ `storage/skills.ts`（单键存储）→ `background/skills.ts`（编排 handler 注册进 MessageRouter）→ 面板 `stores/skills.ts` + `components/skills/SkillsPage.tsx`（管理页）与 `components/chat/SlashMenu.tsx`（斜杠浮层）。上下文注入点：`agent/context.ts` 加 skills 参数 + `agent/loop.ts` 的 drive 读 deps.getSkills；斜杠触发解析在 `runAgentLoop`（原文落库、正文仅触发轮注入）。

**Tech Stack:** WXT + React 19 + TypeScript + Zustand + lucide-react + vitest v4 + jsdom（fakeBrowser）。

**规格：** `docs/superpowers/specs/2026-09-04-skills-and-slash-commands-design.md`（所有需求点以规格为准）

**工作区：** `d:\workspace-mou8\ai-browser-extend\.claude\worktrees\feat+script-optimize`（分支 `feat/better-script`）

**常用命令：**

```bash
npm run test              # 全量测试
npx vitest run tests/shared/skill-md.test.ts   # 单文件
npm run compile           # TypeScript 检查
```

**测试基建约定（零上下文必读）：**

- 测试里用 `import { fakeBrowser } from 'wxt/testing/fake-browser'`，每个 `beforeEach(() => fakeBrowser.reset())`。
- `wxt/utils/storage` 的 `storage.getItem/setItem` 在 fakeBrowser 下直接可用，不需要 mock。
- 本计划 UI 层只测纯函数，不写组件渲染测试。

---

## File Structure（文件结构总览）

```text
shared/
  types.ts              [改] +Skill, SkillSummary
  messages.ts           [改] +SkillsRequest
  skill-md.ts           [新] frontmatter 解析/序列化（纯函数）
storage/
  skills.ts             [新] local:skills:index 单键 CRUD
background/
  skills.ts             [新] 编排层：6 个 SKILLS_* handler + 导入/导出聚合
entrypoints/
  background.ts         [改] +initSkillsModule(router)
agent/
  context.ts            [改] buildContext +skills 参数，buildSkillsPrompt 导出
  loop.ts               [改] LoopDeps +getSkills；runAgentLoop 解析斜杠，drive 注入正文
background/
  agent-port.ts         [改] makeDeps 加 getSkills
stores/
  skills.ts             [新] zustand store（list/refresh）+ filterSkills 纯函数
components/
  skills/SkillsPage.tsx [新] 列表+详情二级路由页
  settings/SettingsHome.tsx [改] +skills 入口卡
  settings/SettingsView.tsx [改] +skills 路由分支
  chat/slash.ts         [新] 浮层纯逻辑（shouldOpenSlash/handleSlashKey/completeSlash）
  chat/SlashMenu.tsx    [新] 浮层展示组件（候选列表+高亮+点击）
  chat/ChatView.tsx     [改] 接入 SlashMenu + 键盘处理 + 斜杠徽标
entrypoints/sidepanel/styles.css [改] +slash-menu/composer__wrap/slash-chip
tests/
  shared/skill-md.test.ts
  storage/skills.test.ts
  background/skills.test.ts
  agent/skills-context.test.ts
  stores/skills.test.ts
  chat/slash.test.ts
```

---

### Task 1: `shared/skill-md.ts` — .md 解析与序列化

**Files:**
- Create: `shared/skill-md.ts`
- Test: `tests/shared/skill-md.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/shared/skill-md.test.ts
import { describe, it, expect } from 'vitest';
import { parseSkillMd, parseSkillMdDocument, serializeSkillMd, serializeSkillsMd } from '../../shared/skill-md';

describe('parseSkillMd', () => {
  it('正常解析：frontmatter 三字段 + 正文', () => {
    const md = [
      '---',
      'name: 网页翻译',
      'description: 把当前页翻译成中文',
      'command: translate',
      '---',
      '第1行指令',
      '第2行指令',
    ].join('\n');
    const r = parseSkillMd(md, 'a.md');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.skill.name).toBe('网页翻译');
      expect(r.skill.description).toBe('把当前页翻译成中文');
      expect(r.skill.command).toBe('translate');
      expect(r.skill.content).toBe('第1行指令\n第2行指令');
      expect(r.warnings).toEqual([]);
    }
  });

  it('frontmatter 前允许空行；正文首尾空行裁剪', () => {
    const md = '\n---\nname: A\ndescription: d\ncommand: a\n---\n\n正文\n\n';
    const r = parseSkillMd(md, 'a.md');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.skill.content).toBe('正文');
  });

  it('缺 command → 拒绝', () => {
    const r = parseSkillMd('---\nname: A\n---\n正文', 'a.md');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('command');
  });

  it('command 格式非法 → 拒绝（kebab-case）', () => {
    const r = parseSkillMd('---\nname: A\ncommand: Bad_Name!\n---\n正文', 'a.md');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('command');
  });

  it('缺 name → 文件名兜底 + warning；缺 description → 空串 + warning', () => {
    const r = parseSkillMd('---\ncommand: a\n---\n正文', 'hello.md');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.skill.name).toBe('hello');
      expect(r.skill.description).toBe('');
      expect(r.warnings).toHaveLength(2);
    }
  });

  it('无 frontmatter → 拒绝', () => {
    const r = parseSkillMd('只有正文没有头', 'a.md');
    expect(r.ok).toBe(false);
  });

  it('frontmatter 未闭合 → 拒绝', () => {
    const r = parseSkillMd('---\nname: A\ncommand: a\n正文没有闭合', 'a.md');
    expect(r.ok).toBe(false);
  });

  it('多余键忽略（license 等）', () => {
    const r = parseSkillMd('---\nname: A\ndescription: d\ncommand: a\nlicense: MIT\n---\n正文', 'a.md');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warnings).toEqual([]);
  });
});

describe('serializeSkillMd / serializeSkillsMd / parseSkillMdDocument', () => {
  it('序列化含三字段 + 正文', () => {
    const out = serializeSkillMd({ name: '网页翻译', description: '简述', command: 'translate', content: '指令' });
    expect(out).toBe('---\nname: 网页翻译\ndescription: 简述\ncommand: translate\n---\n指令');
  });

  it('parse(serialize(x)) 幂等', () => {
    const src = serializeSkillMd({ name: 'N', description: 'D', command: 'x', content: 'C\nC2' });
    const r = parseSkillMd(src, 'x.md');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.skill.name).toBe('N');
      expect(r.skill.content).toBe('C\nC2');
      expect(r.warnings).toHaveLength(0);
    }
  });

  it('serializeSkillsMd 串联 → parseSkillMdDocument 逐个解析', () => {
    const docs = serializeSkillsMd([
      { name: 'A', description: '', command: 'a', content: 'CA' },
      { name: 'B', description: '', command: 'b', content: 'CB' },
    ]);
    const parsed = parseSkillMdDocument(docs);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]!.ok && parsed[0]!.skill.command).toBe('a');
    expect(parsed[1]!.ok && parsed[1]!.skill.command).toBe('b');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/shared/skill-md.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `shared/skill-md.ts`**

```ts
// shared/skill-md.ts
// Skill .md 文件解析/序列化（纯函数，spec §1.3）。
// frontmatter 手写最小解析：首行 --- 到下一行 --- 之间逐行 key: value，多余键忽略。

export interface SkillMdFields {
  name: string;
  description: string;
  command: string;
  content: string;
}

export type ParseSkillResult =
  | { ok: true; skill: SkillMdFields; warnings: string[] }
  | { ok: false; error: string };

/** command 格式（storage/skills.ts 共用） */
export const SKILL_COMMAND_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** 单文档解析。filename 用于缺 name 时的兜底（去 .md 后缀）。 */
export function parseSkillMd(text: string, filename?: string): ParseSkillResult {
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && lines[i]!.trim() === '') i += 1;
  if (lines[i]?.trim() !== '---') {
    return { ok: false, error: '缺少 YAML frontmatter 头（应以 --- 开头）' };
  }
  i += 1;
  const meta: Record<string, string> = {};
  let closed = false;
  for (; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.trim() === '---') { closed = true; i += 1; break; }
    const m = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (m) meta[m[1]!] = m[2]!.trim();
  }
  if (!closed) return { ok: false, error: 'frontmatter 未闭合' };
  const content = lines.slice(i).join('\n').trim();

  const warnings: string[] = [];
  const command = meta.command ?? '';
  if (!command || !SKILL_COMMAND_RE.test(command)) {
    return { ok: false, error: `command 缺失或非法（需 kebab-case 小写字母/数字/连字符，1-32 字符）：${command || '（空）'}` };
  }
  let name = meta.name ?? '';
  if (!name) {
    name = (filename ?? '').replace(/\.md$/i, '').trim() || '未命名技能';
    warnings.push(`缺少 name，使用文件名「${name}」`);
  }
  const description = meta.description ?? '';
  if (!meta.description) warnings.push('缺少 description');

  return { ok: true, skill: { name, description, command, content }, warnings };
}

/** 序列化单文档。 */
export function serializeSkillMd(s: SkillMdFields): string {
  return `---\nname: ${s.name}\ndescription: ${s.description}\ncommand: ${s.command}\n---\n${s.content}`;
}

/** 多文档串联（导出用）：文档间以空行分隔的独立 --- 块。 */
export function serializeSkillsMd(list: SkillMdFields[]): string {
  return list.map(serializeSkillMd).join('\n---\n\n');
}

/** 多文档解析（导入用）：按分隔符拆开逐个 parseSkillMd。
 *  注：文档内 frontmatter 的闭合 --- 后跟 \n\n 会被 split 命中——所以拆分前先按
 *  「\n---\n（紧跟 name: 等键行）」启发式拆，避免把正文里以 --- 开头的行误拆。
 *  本项目正文为 Markdown 指令，水平线极少见；采用简单 split，风险可接受（spec 取舍）。 */
export function parseSkillMdDocument(text: string, filename?: string): ParseSkillResult[] {
  return text.split(/\n---\n\n/).map((d) => parseSkillMd(d, filename));
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/shared/skill-md.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add shared/skill-md.ts tests/shared/skill-md.test.ts
git commit -m "feat(skills): shared/skill-md.ts frontmatter 解析/序列化（TDD）"
```

---

### Task 2: 类型 + 消息 + `storage/skills.ts`

**Files:**
- Modify: `shared/types.ts`（文件末尾追加）
- Modify: `shared/messages.ts`（`ScriptsRequest` 定义之后追加）
- Create: `storage/skills.ts`
- Test: `tests/storage/skills.test.ts`

- [ ] **Step 1: 类型与消息（无逻辑，直接写）**

`shared/types.ts` 末尾追加：

```ts
// ---------- Skill 系统（spec：skills-and-slash-commands）----------

export interface Skill {
  id: string;
  /** 显示名（可中文） */
  name: string;
  /** 斜杠调用名（唯一键，kebab-case ASCII） */
  command: string;
  /** 简述（注入上下文 + 浮层副标题，≤200 字符） */
  description: string;
  /** Markdown 指令正文（≤64KB） */
  content: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

/** 列表/摘要形状（无 content） */
export interface SkillSummary {
  id: string;
  name: string;
  command: string;
  description: string;
  enabled: boolean;
  updatedAt: number;
}
```

`shared/messages.ts` 的 `ScriptsRequest` 类型定义之后追加：

```ts
// ---------- Skill 管理（sidepanel → bg request/response，走 MessageRouter）----------

export type SkillsRequest =
  | { type: 'SKILLS_LIST' }
  | { type: 'SKILLS_GET'; id: string }
  | { type: 'SKILLS_DELETE'; id: string }
  | { type: 'SKILLS_SET_ENABLED'; id: string; enabled: boolean }
  | { type: 'SKILLS_IMPORT'; text: string; filename?: string }
  | { type: 'SKILLS_EXPORT'; ids?: string[] };   // 缺省 = 全部
```

- [ ] **Step 2: 写失败测试**

```ts
// tests/storage/skills.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { storage } from 'wxt/utils/storage';
import {
  listSkills, getSkill, saveSkill, deleteSkill, setSkillEnabled, newSkill,
  MAX_SKILLS, MAX_CONTENT_LENGTH, MAX_DESCRIPTION_LENGTH, toSkillSummary,
} from '../../storage/skills';
import type { Skill } from '../../shared/types';

function mkSkill(over: Partial<Skill> = {}): Skill {
  return {
    id: 'sk1', name: '翻译', command: 'translate', description: '简述',
    content: '指令正文', enabled: true, createdAt: 1, updatedAt: 1, ...over,
  };
}

describe('storage/skills', () => {
  beforeEach(() => fakeBrowser.reset());

  it('空库返回 []', async () => {
    expect(await listSkills()).toEqual([]);
    expect(await getSkill('sk1')).toBeUndefined();
  });

  it('save 新增 + get + list', async () => {
    await saveSkill(mkSkill());
    await saveSkill(mkSkill({ id: 'sk2', command: 'summarize' }));
    expect(await getSkill('sk1')).toMatchObject({ command: 'translate' });
    expect(await listSkills()).toHaveLength(2);
  });

  it('command 撞名（不同 id）→ throw', async () => {
    await saveSkill(mkSkill());
    await expect(saveSkill(mkSkill({ id: 'sk2' }))).rejects.toThrow('command');
  });

  it('save 同 id 覆盖（upsert）不触发 command 撞名校验', async () => {
    await saveSkill(mkSkill());
    await saveSkill(mkSkill({ name: '改名' }));
    const all = await listSkills();
    expect(all).toHaveLength(1);
    expect(all[0]!.name).toBe('改名');
  });

  it('command 格式非法 → throw', async () => {
    await expect(saveSkill(mkSkill({ command: 'Bad_Name' }))).rejects.toThrow('command');
  });

  it('落到 local:skills:index 键', async () => {
    await saveSkill(mkSkill());
    const raw = await storage.getItem<Skill[]>('local:skills:index');
    expect(raw).toHaveLength(1);
  });

  it('数量上限 MAX_SKILLS', async () => {
    for (let i = 0; i < MAX_SKILLS; i += 1) {
      await saveSkill(mkSkill({ id: `k${i}`, command: `c-${i}` }));
    }
    await expect(saveSkill(mkSkill({ id: 'extra', command: 'extra' }))).rejects.toThrow('上限');
  });

  it('正文超限 throw', async () => {
    await expect(saveSkill(mkSkill({ content: 'x'.repeat(MAX_CONTENT_LENGTH + 1) }))).rejects.toThrow('正文');
  });

  it('description 超限 throw', async () => {
    await expect(saveSkill(mkSkill({ description: 'x'.repeat(MAX_DESCRIPTION_LENGTH + 1) }))).rejects.toThrow('description');
  });

  it('delete 幂等（不存在也成功）', async () => {
    await saveSkill(mkSkill());
    await deleteSkill('sk1');
    await deleteSkill('sk1');
    expect(await listSkills()).toHaveLength(0);
  });

  it('setSkillEnabled 翻转', async () => {
    await saveSkill(mkSkill());
    await setSkillEnabled('sk1', false);
    expect((await getSkill('sk1'))!.enabled).toBe(false);
    await setSkillEnabled('sk1', true);
    expect((await getSkill('sk1'))!.enabled).toBe(true);
  });

  it('toSkillSummary 投影（无 content）', () => {
    const s = toSkillSummary(mkSkill());
    expect(s).toEqual({
      id: 'sk1', name: '翻译', command: 'translate',
      description: '简述', enabled: true, updatedAt: 1,
    });
  });

  it('newSkill 工厂：默认 enabled + 时间戳', () => {
    const s = newSkill({ name: 'N', command: 'c', description: 'd', content: 'C' });
    expect(s.enabled).toBe(true);
    expect(s.createdAt).toBeGreaterThan(0);
    expect(s.id).toBeTruthy();
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run tests/storage/skills.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 4: 实现 `storage/skills.ts`**

```ts
// storage/skills.ts
// 技能池存储（spec §1.2）。单键 local:skills:index（Skill[]），与 storage/scripts.ts 同构。
import { storage } from 'wxt/utils/storage';
import { nanoid } from 'nanoid';
import type { Skill, SkillSummary } from '../shared/types';
import { SKILL_COMMAND_RE } from '../shared/skill-md';

const KEY = 'local:skills:index' as const;

export const MAX_SKILLS = 100;
export const MAX_CONTENT_LENGTH = 64 * 1024;
export const MAX_DESCRIPTION_LENGTH = 200;

export async function listSkills(): Promise<Skill[]> {
  return (await storage.getItem<Skill[]>(KEY)) ?? [];
}

export async function getSkill(id: string): Promise<Skill | undefined> {
  return (await listSkills()).find((s) => s.id === id);
}

/** upsert。数量上限 / command 唯一与格式 / 长度上限超限 throw（中文可读文案）。 */
export async function saveSkill(skill: Skill): Promise<void> {
  const all = await listSkills();
  const exists = all.some((s) => s.id === skill.id);
  if (!exists && all.length >= MAX_SKILLS) {
    throw new Error(`技能数量已达上限（${MAX_SKILLS} 条），请先删除部分技能`);
  }
  if (!SKILL_COMMAND_RE.test(skill.command)) {
    throw new Error(`command 格式非法（需 kebab-case）：${skill.command}`);
  }
  if (!exists && all.some((s) => s.command === skill.command)) {
    throw new Error(`command「${skill.command}」已被其他技能使用`);
  }
  if (skill.content.length > MAX_CONTENT_LENGTH) {
    throw new Error(`技能正文超过上限（${MAX_CONTENT_LENGTH} 字符）`);
  }
  if (skill.description.length > MAX_DESCRIPTION_LENGTH) {
    throw new Error(`简述超过上限（${MAX_DESCRIPTION_LENGTH} 字符）`);
  }
  const next = exists ? all.map((s) => (s.id === skill.id ? skill : s)) : [...all, skill];
  await storage.setItem(KEY, next);
}

/** 幂等：不存在也成功。 */
export async function deleteSkill(id: string): Promise<void> {
  const all = await listSkills();
  await storage.setItem(KEY, all.filter((s) => s.id !== id));
}

export async function setSkillEnabled(id: string, enabled: boolean): Promise<void> {
  const all = await listSkills();
  const next = all.map((s) => (s.id === id ? { ...s, enabled, updatedAt: Date.now() } : s));
  await storage.setItem(KEY, next);
}

export function toSkillSummary(s: Skill): SkillSummary {
  return {
    id: s.id, name: s.name, command: s.command,
    description: s.description, enabled: s.enabled, updatedAt: s.updatedAt,
  };
}

/** 新 skill 工厂：导入通道用。 */
export function newSkill(fields: { name: string; command: string; description: string; content: string }): Skill {
  const now = Date.now();
  return { id: nanoid(), enabled: true, createdAt: now, updatedAt: now, ...fields };
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run tests/storage/skills.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add shared/types.ts shared/messages.ts storage/skills.ts tests/storage/skills.test.ts
git commit -m "feat(skills): Skill 类型 + SkillsRequest 消息 + storage/skills.ts（TDD）"
```

---

### Task 3: `background/skills.ts` 编排层

**Files:**
- Create: `background/skills.ts`
- Modify: `entrypoints/background.ts`
- Test: `tests/background/skills.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/background/skills.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { MessageRouter } from '../../background/router';
import { initSkillsModule } from '../../background/skills';
import { listSkills } from '../../storage/skills';

function dispatch(type: string, extra: Record<string, unknown> = {}): Promise<any> {
  const router = new MessageRouter();
  initSkillsModule(router);
  return router.dispatch({ type, ...extra } as { type: string } & Record<string, unknown>);
}

describe('background/skills handlers', () => {
  beforeEach(() => fakeBrowser.reset());

  it('SKILLS_LIST 空库', async () => {
    const resp = await dispatch('SKILLS_LIST');
    expect(resp).toEqual({ ok: true, data: { skills: [] } });
  });

  it('SKILLS_IMPORT 单文档 → imported 1', async () => {
    const md = '---\nname: A\ndescription: d\ncommand: a\n---\nCA';
    const resp = await dispatch('SKILLS_IMPORT', { text: md, filename: 'a.md' });
    expect(resp.ok).toBe(true);
    expect(resp.data).toMatchObject({ imported: 1, overwritten: 0 });
    expect(resp.data.warnings).toEqual([]);
    expect(await listSkills()).toHaveLength(1);
  });

  it('SKILLS_IMPORT 同 command 再导入 → overwritten 1，保留原 enabled/id', async () => {
    const md = '---\nname: A\ndescription: d\ncommand: a\n---\nCA';
    await dispatch('SKILLS_IMPORT', { text: md });
    await dispatch('SKILLS_SET_ENABLED', { id: (await listSkills())[0]!.id, enabled: false });
    const md2 = '---\nname: A2\ndescription: d2\ncommand: a\n---\nCA2';
    const resp = await dispatch('SKILLS_IMPORT', { text: md2 });
    expect(resp.data).toMatchObject({ imported: 0, overwritten: 1 });
    const all = await listSkills();
    expect(all).toHaveLength(1);
    expect(all[0]!.name).toBe('A2');
    expect(all[0]!.enabled).toBe(false);
  });

  it('SKILLS_IMPORT 多文档串联 → 好文档照常、坏文档跳过 + warning', async () => {
    const md = [
      '---\nname: A\ndescription: d\ncommand: a\n---\nCA',
      '---\nname: B\ndescription: d\ncommand: b\n---\nCB',
      '没有 frontmatter 的坏文档',
    ].join('\n---\n\n');
    const resp = await dispatch('SKILLS_IMPORT', { text: md });
    expect(resp.data.imported).toBe(2);
    expect(resp.data.warnings.length).toBeGreaterThanOrEqual(1);
    expect(await listSkills()).toHaveLength(2);
  });

  it('导入正文超限 → 跳过 + warning，其余照常', async () => {
    const md = [
      '---\nname: A\ndescription: d\ncommand: a\n---\n' + 'x'.repeat(64 * 1024 + 1),
      '---\nname: B\ndescription: d\ncommand: b\n---\nCB',
    ].join('\n---\n\n');
    const resp = await dispatch('SKILLS_IMPORT', { text: md });
    expect(resp.data.imported).toBe(1);
    expect(resp.data.warnings.length).toBeGreaterThanOrEqual(1);
  });

  it('SKILLS_GET 不存在 → ok:false', async () => {
    const resp = await dispatch('SKILLS_GET', { id: 'nope' });
    expect(resp.ok).toBe(false);
  });

  it('SKILLS_GET 存在 → 返回完整 Skill（含 content）', async () => {
    await dispatch('SKILLS_IMPORT', { text: '---\nname: A\ndescription: d\ncommand: a\n---\nC' });
    const id = (await listSkills())[0]!.id;
    const resp = await dispatch('SKILLS_GET', { id });
    expect(resp.ok).toBe(true);
    expect(resp.data.skill.content).toBe('C');
  });

  it('SKILLS_SET_ENABLED + SKILLS_DELETE', async () => {
    await dispatch('SKILLS_IMPORT', { text: '---\nname: A\ndescription: d\ncommand: a\n---\nC' });
    const id = (await listSkills())[0]!.id;
    await dispatch('SKILLS_SET_ENABLED', { id, enabled: false });
    expect((await listSkills())[0]!.enabled).toBe(false);
    await dispatch('SKILLS_DELETE', { id });
    expect(await listSkills()).toHaveLength(0);
  });

  it('SKILLS_EXPORT 缺省导全部，ids 过滤', async () => {
    await dispatch('SKILLS_IMPORT', { text: '---\nname: A\ndescription: d\ncommand: a\n---\nCA' });
    await dispatch('SKILLS_IMPORT', { text: '---\nname: B\ndescription: d\ncommand: b\n---\nCB' });
    const all = await dispatch('SKILLS_EXPORT');
    expect(all.data.count).toBe(2);
    expect(all.data.text).toContain('command: a');
    expect(all.data.text).toContain('command: b');
    const one = await dispatch('SKILLS_EXPORT', { ids: [(await listSkills())[0]!.id] });
    expect(one.data.count).toBe(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/background/skills.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `background/skills.ts`**

```ts
// background/skills.ts
// 技能池编排层（spec §2.1）：6 个 SKILLS_* handler，内部调 storage/skills.ts + shared/skill-md.ts。
// skill 是纯存储实体：无注入引擎、无 tabs 监听、无 Port 事件。
import type { MessageRouter } from './router';
import {
  listSkills, getSkill, saveSkill, deleteSkill, setSkillEnabled, toSkillSummary, newSkill,
} from '../storage/skills';
import { parseSkillMdDocument, serializeSkillMd } from '../shared/skill-md';

/** 单次导入的聚合结果 */
export interface SkillsImportResult {
  imported: number;
  overwritten: number;
  warnings: string[];
}

/** 导入一份 .md 文本（可能含多文档）。逐文档解析：坏文档跳过 + warning；
 *  command 撞车 → 覆盖更新（保留原 id/enabled/createdAt）；超限等 saveSkill 抛错 → 跳过该条 + warning。 */
export async function importSkillsText(text: string, filename?: string): Promise<SkillsImportResult> {
  const docs = parseSkillMdDocument(text, filename);
  const warnings: string[] = [];
  let imported = 0;
  let overwritten = 0;
  for (let i = 0; i < docs.length; i += 1) {
    const r = docs[i]!;
    if (!r.ok) {
      warnings.push(r.error);
      continue;
    }
    for (const w of r.warnings) warnings.push(`文档${i + 1}：${w}`);
    try {
      const existing = (await listSkills()).find((s) => s.command === r.skill.command);
      if (existing) {
        await saveSkill({
          ...existing,
          name: r.skill.name,
          description: r.skill.description,
          content: r.skill.content,
          updatedAt: Date.now(),
        });
        overwritten += 1;
        warnings.push(`「${r.skill.name}」已存在同 command「${r.skill.command}」，已覆盖更新`);
      } else {
        await saveSkill(newSkill(r.skill));
        imported += 1;
      }
    } catch (e) {
      warnings.push(`文档${i + 1}（${r.skill.command}）：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { imported, overwritten, warnings };
}

/** SKILLS_EXPORT 数据函数：返回序列化好的 .md 文本 + 条数（面板拿去 Blob 下载）。
 *  ids 缺省 = 全部（按 storage 顺序）。 */
export async function exportSkillsMd(ids?: string[]): Promise<{ text: string; count: number }> {
  const all = await listSkills();
  const picked = ids ? all.filter((s) => ids.includes(s.id)) : all;
  const text = picked
    .map((s) => serializeSkillMd({ name: s.name, description: s.description, command: s.command, content: s.content }))
    .join('\n---\n\n');
  return { text, count: picked.length };
}

/** handler 注册（entrypoints/background.ts 调用）。 */
export function initSkillsModule(router: MessageRouter): void {
  router.on('SKILLS_LIST', async () => ({
    ok: true,
    data: { skills: (await listSkills()).map(toSkillSummary) },
  }));

  router.on('SKILLS_GET', async (msg) => {
    const { id } = msg as unknown as { id: string };
    const skill = await getSkill(id);
    if (!skill) return { ok: false, error: '技能不存在' };
    return { ok: true, data: { skill } };
  });

  router.on('SKILLS_DELETE', async (msg) => {
    const { id } = msg as unknown as { id: string };
    await deleteSkill(id);
    return { ok: true };
  });

  router.on('SKILLS_SET_ENABLED', async (msg) => {
    const { id, enabled } = msg as unknown as { id: string; enabled: boolean };
    await setSkillEnabled(id, enabled);
    return { ok: true };
  });

  router.on('SKILLS_IMPORT', async (msg) => {
    const { text, filename } = msg as unknown as { text: string; filename?: string };
    return { ok: true, data: await importSkillsText(text, filename) };
  });

  router.on('SKILLS_EXPORT', async (msg) => {
    const { ids } = (msg ?? {}) as { ids?: string[] };
    return { ok: true, data: await exportSkillsMd(ids) };
  });
}
```

- [ ] **Step 4: 修改 `entrypoints/background.ts`**

import 区（`import { initGmApi } from '../background/gm-api';` 之后）加：

```ts
import { initSkillsModule } from '../background/skills';
```

`defineBackground(() => {` 体内、现有 `initGmApi` 调用（若无则紧跟 `initScriptsModule`）之后加：

```ts
  initSkillsModule(router);
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run tests/background/skills.test.ts`
Expected: PASS

- [ ] **Step 6: 全量测试 + 编译检查**

Run: `npm run test && npm run compile`
Expected: 全绿

- [ ] **Step 7: Commit**

```bash
git add background/skills.ts entrypoints/background.ts tests/background/skills.test.ts
git commit -m "feat(skills): background/skills.ts 编排层（导入覆盖/多文档容错/导出）"
```

---

### Task 4: `agent/context.ts` + `agent/loop.ts` — 简述注入与斜杠正文单轮注入

**Files:**
- Modify: `agent/context.ts`
- Modify: `agent/loop.ts`
- Modify: `background/agent-port.ts`（`makeDeps` 加 getSkills）
- Test: `tests/agent/skills-context.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/agent/skills-context.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { buildContext, buildSkillsPrompt } from '../../agent/context';
import { runAgentLoop, type LoopDeps } from '../../agent/loop';
import { getConversation } from '../../storage/conversations';
import { saveSkill } from '../../storage/skills';
import type { Provider, StreamEvent, ChatParams } from '../../agent/provider/types';

describe('buildSkillsPrompt / buildContext(skills)', () => {
  it('空数组 → 空串', () => {
    expect(buildSkillsPrompt([])).toBe('');
  });

  it('非空 → 清单格式（含 /command、name、description、遵循提示）', () => {
    const s = buildSkillsPrompt([
      { name: '网页翻译', command: 'translate', description: '把当前页翻译成中文' },
    ]);
    expect(s).toContain('/translate');
    expect(s).toContain('网页翻译');
    expect(s).toContain('把当前页翻译成中文');
    expect(s).toContain('遵循');
  });

  it('buildContext 带 skills → 追加到 system prompt 末尾（页面信息仍在）', () => {
    const msgs = buildContext(
      [{ role: 'user', content: 'hi' }],
      { url: 'https://x.com', title: 'X' },
      60,
      undefined,
      [{ name: 'N', command: 'c', description: 'd' }],
    );
    const sys = msgs[0]!.content as string;
    expect(sys).toContain('/c');
    expect(sys).toContain('当前页面');
  });

  it('buildContext 不带 skills → 不含技能块', () => {
    const msgs = buildContext([{ role: 'user', content: 'hi' }], { url: '', title: '' });
    expect(msgs[0]!.content as string).not.toContain('可用技能');
  });
});

describe('loop 斜杠触发与常驻注入', () => {
  beforeEach(() => fakeBrowser.reset());

  const captureProvider = (captured: ChatParams[]): Provider => ({
    streamChat(p: ChatParams, onEvent: (e: StreamEvent) => void) {
      captured.push(p);
      queueMicrotask(() => onEvent({ type: 'text-delta', text: 'ok' }));
      queueMicrotask(() => onEvent({ type: 'message-done', finishReason: 'stop' }));
      return { cancel: vi.fn() };
    },
  });

  const minimalDeps = (provider: Provider): LoopDeps => ({
    provider,
    executeTool: vi.fn<LoopDeps['executeTool']>(),
    getPageInfo: async () => ({ url: '', title: '' }),
    emit: vi.fn(),
  });

  it('常驻简述注入：getSkills 返回的简述进每轮 system prompt', async () => {
    const captured: ChatParams[] = [];
    await runAgentLoop(
      { convId: 'c6', tabId: 1, userMessage: '普通' },
      {
        ...minimalDeps(captureProvider(captured)),
        getSkills: async () => [{ name: '翻译', command: 'translate', description: '简述标记ABC' }],
      },
    );
    expect(String(captured[0]!.messages[0]!.content)).toContain('简述标记ABC');
  });

  it('getSkills 缺省 → system prompt 不含技能块', async () => {
    const captured: ChatParams[] = [];
    await runAgentLoop({ convId: 'c0', tabId: 1, userMessage: '普通' }, minimalDeps(captureProvider(captured)));
    expect(String(captured[0]!.messages[0]!.content)).not.toContain('可用技能');
  });

  it('/command 触发轮：技能正文作为 system 消息注入（位于 user 原文之前）；历史只存原文', async () => {
    await saveSkill({
      id: 'k1', name: '翻译', command: 'translate', description: 'd',
      content: '技能正文标记XYZ', enabled: true, createdAt: 1, updatedAt: 1,
    });
    const captured: ChatParams[] = [];
    await runAgentLoop(
      { convId: 'c1', tabId: 1, userMessage: '/translate 把这段翻成中文' },
      {
        ...minimalDeps(captureProvider(captured)),
        getSkills: async () => [{ name: '翻译', command: 'translate', description: 'd' }],
      },
    );
    // 历史只存原文，不落库正文
    const conv = await getConversation('c1');
    expect(conv.messages.some((m) => String(m.content).includes('/translate'))).toBe(true);
    expect(conv.messages.some((m) => String(m.content).includes('技能正文标记XYZ'))).toBe(false);

    // 本轮注入：主 system 之后、user 原文之前，有一条含正文的 system 消息
    const msgs = captured[0]!.messages;
    const skillMsg = msgs.find((m) => m.role === 'system' && String(m.content).includes('技能正文标记XYZ'));
    expect(skillMsg).toBeTruthy();
    const userIdx = msgs.findIndex((m) => m.role === 'user' && String(m.content).includes('/translate'));
    expect(msgs.indexOf(skillMsg!)).toBeGreaterThan(0);
    expect(msgs.indexOf(skillMsg!)).toBeLessThan(userIdx);
    expect(String(skillMsg!.content)).toContain('用户附加输入：把这段翻成中文');
  });

  it('/command 未命中 → 原样普通文本（无额外 system 消息）', async () => {
    const captured: ChatParams[] = [];
    await runAgentLoop({ convId: 'c2', tabId: 1, userMessage: '/nope 内容' }, minimalDeps(captureProvider(captured)));
    expect(captured[0]!.messages.filter((m) => m.role === 'system')).toHaveLength(1);
    expect((await getConversation('c2')).messages[0]!.content).toBe('/nope 内容');
  });

  it('disabled 的 skill 不注入正文', async () => {
    await saveSkill({
      id: 'k2', name: '停用', command: 'off', description: 'd',
      content: 'X', enabled: false, createdAt: 1, updatedAt: 1,
    });
    const captured: ChatParams[] = [];
    await runAgentLoop({ convId: 'c5', tabId: 1, userMessage: '/off x' }, minimalDeps(captureProvider(captured)));
    expect(captured[0]!.messages.filter((m) => m.role === 'system')).toHaveLength(1);
  });

  it('非斜杠消息不注入正文', async () => {
    await saveSkill({
      id: 'k1', name: '翻译', command: 'translate', description: 'd',
      content: '技能正文标记XYZ', enabled: true, createdAt: 1, updatedAt: 1,
    });
    const captured: ChatParams[] = [];
    await runAgentLoop({ convId: 'c3', tabId: 1, userMessage: '普通消息' }, {
      ...minimalDeps(captureProvider(captured)),
      getSkills: async () => [{ name: '翻译', command: 'translate', description: 'd' }],
    });
    // 只有主 system（常驻简述并入主 system，不另起一条）
    expect(captured[0]!.messages.filter((m) => m.role === 'system')).toHaveLength(1);
  });

  it('第二轮不再注入正文（仅触发轮）', async () => {
    await saveSkill({
      id: 'k1', name: '翻译', command: 'translate', description: 'd',
      content: '技能正文标记XYZ', enabled: true, createdAt: 1, updatedAt: 1,
    });
    const captured: ChatParams[] = [];
    const scripts: StreamEvent[][] = [
      [
        { type: 'tool-call-delta', index: 0, id: 't1', name: 'take_snapshot', argsDelta: '{}' },
        { type: 'message-done', finishReason: 'tool_calls' },
      ],
      [
        { type: 'text-delta', text: '完成' },
        { type: 'message-done', finishReason: 'stop' },
      ],
    ];
    let turn = 0;
    const provider: Provider = {
      streamChat(p, onEvent) {
        captured.push(p);
        const cur = scripts[turn] ?? [];
        turn += 1;
        queueMicrotask(() => { for (const e of cur) onEvent(e); });
        return { cancel: vi.fn() };
      },
    };
    await runAgentLoop(
      { convId: 'c4', tabId: 1, userMessage: '/translate 去做' },
      {
        ...minimalDeps(provider),
        executeTool: async () => ({ ok: true, data: { result: 'snapshot' } }),
      },
    );
    expect(captured.length).toBe(2);
    expect(captured[0]!.messages.some((m) => m.role === 'system' && String(m.content).includes('技能正文标记XYZ'))).toBe(true);
    expect(captured[1]!.messages.some((m) => m.role === 'system' && String(m.content).includes('技能正文标记XYZ'))).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/agent/skills-context.test.ts`
Expected: FAIL（buildSkillsPrompt 不存在等）

- [ ] **Step 3: 修改 `agent/context.ts`**

在 `SYSTEM_PROMPT` 常量之后追加：

```ts
// ---------- Skill 简述注入（spec §2.2）----------

export interface SkillBrief { name: string; command: string; description: string }

export function buildSkillsPrompt(briefs: SkillBrief[]): string {
  if (briefs.length === 0) return '';
  const lines = briefs.map((s) => `- /${s.command} ${s.name}：${s.description}`);
  return `\n\n## 可用技能\n\n用户可以用 /命令 触发技能（触发轮会注入技能正文）。如果任务与某技能明显匹配，也可以主动遵循该技能行事（此时请向用户说明你正在使用哪个技能）。技能正文在触发时提供，此处仅简述：\n\n${lines.join('\n')}`;
}
```

`buildContext` 整体替换为（只有签名和 system 组装两处变化，其余逻辑不动）：

```ts
export function buildContext(
  history: ChatMessage[],
  page: PageInfo,
  keepRecent = 60,
  summary?: { text: string; coversUpTo: number },
  skills?: SkillBrief[],
): ChatMessage[] {
  const pageBlock = page.url
    ? `\n\n当前页面：\n- URL: ${page.url}\n- 标题: ${page.title}`
    : '';
  const skillsBlock = buildSkillsPrompt(skills ?? []);
  const system: ChatMessage = { role: 'system', content: SYSTEM_PROMPT + pageBlock + skillsBlock };

  if (summary) {
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

- [ ] **Step 4: 修改 `agent/loop.ts`**

import 调整（首部）：

```ts
import { buildContext, type PageInfo, type SkillBrief } from './context';
import { listSkills } from '../storage/skills';
```

`LoopDeps` 接口加可选字段（`compact` 之后）：

```ts
  /** 启用技能简述（每轮 buildContext 注入）。缺省不注入（便于测试）。 */
  getSkills?: () => Promise<SkillBrief[]>;
```

`runAgentLoop` 替换为（解析斜杠并传给 drive）：

```ts
export async function runAgentLoop(args: LoopArgs, deps: LoopDeps, signal?: AbortSignal): Promise<void> {
  await appendMessage(args.convId, { role: 'user', content: args.userMessage });
  await setStatus(args.convId, 'running');
  const m = /^\/([a-z0-9-]+)(?:\s+([\s\S]*))?$/.exec(args.userMessage.trim());
  const slash = m ? { command: m[1]!, rest: m[2] ?? '' } : undefined;
  await drive(args.convId, args.tabId, deps, initGuardState(), signal ?? new AbortController().signal, slash);
}
```

`drive` 签名加尾参（`resumeAgentLoop` 内的 drive 调用不传 slash——恢复轮不重新注入）：

```ts
async function drive(
  convId: string,
  startTabId: number,
  deps: LoopDeps,
  guardState: GuardState,
  signal: AbortSignal,
  slash?: { command: string; rest: string },
): Promise<void> {
```

`drive` 循环体内 buildContext 调用处（当前 `const messages = buildContext(conv.messages, page, 60, conv.summary);`）替换为：

```ts
    const skills = (await deps.getSkills?.()) ?? [];
    const messages = buildContext(conv.messages, page, 60, conv.summary, skills);
    // 斜杠触发：查 command 对应 enabled skill，其正文作为隐藏 system 消息仅注入本轮
    // （位于主 system 之后、user 原文之前；不落库——messages 是本轮临时数组）
    if (slash) {
      const hit = (await listSkills()).find((s) => s.command === slash.command && s.enabled);
      if (hit) {
        messages.splice(1, 0, {
          role: 'system',
          content: `【技能指令 /${hit.command}】\n${hit.content}\n\n用户附加输入：${slash.rest || '（无）'}`,
        });
      }
    }
```

- [ ] **Step 5: `background/agent-port.ts` 的 `makeDeps` 加 getSkills**

import 区加：

```ts
import { listSkills } from '../storage/skills';
```

`makeDeps` 返回对象内（`compact:` 行之后、`emit:` 之前）加：

```ts
    getSkills: async () =>
      (await listSkills()).filter((s) => s.enabled).map((s) => ({ name: s.name, command: s.command, description: s.description })),
```

- [ ] **Step 6: 跑测试确认通过**

Run: `npx vitest run tests/agent/skills-context.test.ts && npx vitest run tests/agent/loop.test.ts`
Expected: PASS（含既有 loop.test.ts 回归）

- [ ] **Step 7: 全量测试 + 编译检查 + Commit**

Run: `npm run test && npm run compile`
Expected: 全绿

```bash
git add agent/context.ts agent/loop.ts background/agent-port.ts tests/agent/skills-context.test.ts
git commit -m "feat(agent): skill 简述常驻注入 + 斜杠正文单轮注入（原文入历史）"
```

---

### Task 5: `stores/skills.ts` + 斜杠纯逻辑 `components/chat/slash.ts`

**Files:**
- Create: `stores/skills.ts`
- Create: `components/chat/slash.ts`
- Test: `tests/stores/skills.test.ts`
- Test: `tests/chat/slash.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/stores/skills.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { useSkills, filterSkills } from '../../stores/skills';
import type { SkillSummary } from '../../shared/types';

const LIST: SkillSummary[] = [
  { id: '1', name: '网页翻译', command: 'translate', description: '翻译页面', enabled: true, updatedAt: 1 },
  { id: '2', name: '总结', command: 'summarize', description: '总结页面内容', enabled: true, updatedAt: 2 },
  { id: '3', name: '停用项', command: 'off', description: '已停用', enabled: false, updatedAt: 3 },
];

describe('filterSkills（纯函数）', () => {
  it('空查询返回全部启用项（不含停用）', () => {
    expect(filterSkills(LIST, '')).toHaveLength(2);
  });

  it('command 前缀匹配优先排序', () => {
    const r = filterSkills([...LIST, { id: '4', name: '说明', command: 'explain', description: '', enabled: true, updatedAt: 4 }], 's');
    expect(r[0]!.command).toBe('summarize');
  });

  it('name/description 子串也命中', () => {
    expect(filterSkills(LIST, '翻译').map((s) => s.command)).toEqual(['translate']);
    expect(filterSkills(LIST, '页面内容').map((s) => s.command)).toEqual(['summarize']);
  });

  it('无命中返回 []', () => {
    expect(filterSkills(LIST, 'zzz')).toEqual([]);
  });
});

describe('useSkills store', () => {
  beforeEach(() => fakeBrowser.reset());

  it('refresh 拉列表；失败静默置 loading:false', async () => {
    vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({
      ok: true,
      data: { skills: LIST },
    });
    await useSkills.getState().refresh();
    expect(useSkills.getState().list).toHaveLength(3);
    expect(useSkills.getState().loading).toBe(false);

    vi.spyOn(browser.runtime, 'sendMessage').mockRejectedValue(new Error('port gone'));
    await useSkills.getState().refresh();
    expect(useSkills.getState().loading).toBe(false);
  });
});
```

```ts
// tests/chat/slash.test.ts
import { describe, it, expect } from 'vitest';
import { shouldOpenSlash, handleSlashKey, completeSlash } from '../../components/chat/slash';

describe('shouldOpenSlash', () => {
  it('/ 开头且无空格 → 开', () => {
    expect(shouldOpenSlash('/')).toBe(true);
    expect(shouldOpenSlash('/tr')).toBe(true);
  });
  it('/ 后有空格 → 关（附加文本阶段）', () => {
    expect(shouldOpenSlash('/tr ')).toBe(false);
  });
  it('非 / 开头 / 空串 → 关', () => {
    expect(shouldOpenSlash('hello')).toBe(false);
    expect(shouldOpenSlash('')).toBe(false);
  });
});

describe('handleSlashKey', () => {
  const st = (hi: number, count: number) => ({ open: true, hi, count });
  it('ArrowDown/ArrowUp 循环移动高亮', () => {
    expect(handleSlashKey('ArrowDown', st(0, 3))).toEqual({ open: true, hi: 1 });
    expect(handleSlashKey('ArrowDown', st(2, 3))).toEqual({ open: true, hi: 0 });
    expect(handleSlashKey('ArrowUp', st(0, 3))).toEqual({ open: true, hi: 2 });
  });
  it('Enter/Tab → 选中', () => {
    expect(handleSlashKey('Enter', st(1, 3))).toEqual({ open: false, selected: true });
    expect(handleSlashKey('Tab', st(0, 3))).toEqual({ open: false, selected: true });
  });
  it('Escape → 关闭不选中', () => {
    expect(handleSlashKey('Escape', st(1, 3))).toEqual({ open: false, selected: false });
  });
  it('关闭态 / 空候选 → 不处理（null，透传 textarea）', () => {
    expect(handleSlashKey('ArrowDown', { open: false, hi: 0, count: 3 })).toBeNull();
    expect(handleSlashKey('ArrowDown', { open: true, hi: 0, count: 0 })).toBeNull();
  });
  it('其他按键 → null', () => {
    expect(handleSlashKey('a', st(0, 3))).toBeNull();
  });
});

describe('completeSlash', () => {
  it('补全为 /command + 尾随空格', () => {
    expect(completeSlash('translate')).toBe('/translate ');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/stores/skills.test.ts tests/chat/slash.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `stores/skills.ts`**

```ts
// stores/skills.ts
// 技能池前端状态：与 stores/scripts.ts 同构但极简（无运行态/广播）。
import { create } from 'zustand';
import type { SkillSummary } from '../shared/types';

export async function sendSkillsRequest<T = unknown>(req: unknown): Promise<T> {
  return (await browser.runtime.sendMessage(req)) as T;
}

/** 浮层搜索：仅启用项；command 前缀优先、其余子串（大小写不敏感，纯函数 spec §3.1） */
export function filterSkills(list: SkillSummary[], query: string): SkillSummary[] {
  const q = query.trim().toLowerCase();
  const enabled = list.filter((s) => s.enabled);
  if (!q) return enabled;
  const prefix = enabled.filter((s) => s.command.toLowerCase().startsWith(q));
  const rest = enabled.filter(
    (s) => !s.command.toLowerCase().startsWith(q) &&
      (s.command.toLowerCase().includes(q) ||
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q)),
  );
  return [...prefix, ...rest];
}

interface SkillsState {
  list: SkillSummary[];
  loading: boolean;
  refresh: () => Promise<void>;
}

export const useSkills = create<SkillsState>((set) => ({
  list: [],
  loading: false,
  refresh: async () => {
    set({ loading: true });
    try {
      const resp = await sendSkillsRequest<{ ok: boolean; data?: { skills: SkillSummary[] } }>({ type: 'SKILLS_LIST' });
      set({ list: resp.data?.skills ?? [], loading: false });
    } catch {
      set({ loading: false });
    }
  },
}));
```

- [ ] **Step 4: 实现 `components/chat/slash.ts`**

```ts
// components/chat/slash.ts
// 斜杠浮层纯逻辑（spec §3）：触发判定 / 键盘导航 / 补全文本，无 React 依赖（可测）。

/** 输入框当前文本是否应打开浮层：/ 开头且尚无空白（附加文本阶段浮层关闭）。 */
export function shouldOpenSlash(input: string): boolean {
  return /^\/\S*$/.test(input);
}

/** 键盘导航：返回新状态；null = 该键不归浮层管（透传 textarea 默认处理）。 */
export function handleSlashKey(
  key: string,
  state: { open: boolean; hi: number; count: number },
): { open: boolean; hi?: number; selected?: boolean } | null {
  if (!state.open || state.count === 0) return null;
  switch (key) {
    case 'ArrowDown':
      return { open: true, hi: (state.hi + 1) % state.count };
    case 'ArrowUp':
      return { open: true, hi: (state.hi - 1 + state.count) % state.count };
    case 'Enter':
    case 'Tab':
      return { open: false, selected: true };
    case 'Escape':
      return { open: false, selected: false };
    default:
      return null;
  }
}

/** 选中候选后的补全文本：/command + 尾随空格（用户继续打附加文本）。 */
export function completeSlash(command: string): string {
  return `/${command} `;
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run tests/stores/skills.test.ts tests/chat/slash.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add stores/skills.ts components/chat/slash.ts tests/stores/skills.test.ts tests/chat/slash.test.ts
git commit -m "feat(skills): 前端 store + 斜杠浮层纯逻辑（TDD）"
```

---

### Task 6: `SlashMenu.tsx` + ChatView 接入 + 样式

**Files:**
- Create: `components/chat/SlashMenu.tsx`
- Modify: `components/chat/ChatView.tsx`
- Modify: `entrypoints/sidepanel/styles.css`（文件末尾追加）

- [ ] **Step 1: 实现 `SlashMenu.tsx`（纯展示：候选列表 + 高亮 + 点击补全；键盘导航在 ChatView）**

```tsx
// components/chat/SlashMenu.tsx
// 斜杠浮层展示组件（spec §3）：候选列表 + 高亮 + 点击补全。键盘导航在 ChatView（slash.ts 纯函数）。
import { useEffect, useRef } from 'react';
import type { SkillSummary } from '../../shared/types';

export function SlashMenu({ candidates, hi, onSelect }: {
  candidates: SkillSummary[];
  hi: number;
  onSelect: (command: string) => void;
}) {
  const hiRef = useRef<HTMLButtonElement | null>(null);

  // 高亮项滚入视野
  useEffect(() => {
    hiRef.current?.scrollIntoView({ block: 'nearest' });
  }, [hi]);

  return (
    <div className="slash-menu" role="listbox" aria-label="技能候选">
      {candidates.map((s, i) => (
        <button
          key={s.id}
          ref={i === hi ? hiRef : undefined}
          type="button"
          role="option"
          aria-selected={i === hi}
          className={`slash-menu__item${i === hi ? ' slash-menu__item--hi' : ''}`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onSelect(s.command)}
        >
          <span className="slash-menu__cmd mono">/{s.command}</span>
          <span className="slash-menu__name">{s.name}</span>
          {s.description && <span className="slash-menu__desc">{s.description}</span>}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: 修改 `components/chat/ChatView.tsx`**

2.1 import 区追加（React hooks 已有 import，不重复引）：

```tsx
import { SlashMenu } from './SlashMenu';
import { shouldOpenSlash, handleSlashKey, completeSlash } from './slash';
import { filterSkills, useSkills } from '../../stores/skills';
```

2.2 组件内新增 state/ref（`logRef` 声明旁）：

```tsx
const textareaRef = useRef<HTMLTextAreaElement>(null);
const [slashHi, setSlashHi] = useState(0);
const [slashDismissed, setSlashDismissed] = useState(false);
const skillList = useSkills((s) => s.list);
const refreshSkills = useSkills((s) => s.refresh);
```

2.3 挂载 effect（现有 init effect 内追加一行，或单独 effect）：

```tsx
useEffect(() => { void refreshSkills(); }, [refreshSkills]);
```

2.4 候选与可见性计算（`const hasInput = ...` 旁）：

```tsx
const slashCandidates = slashDismissed
  ? []
  : filterSkills(skillList, input.startsWith('/') ? input.slice(1) : '');
const slashVisible = !slashDismissed && shouldOpenSlash(input) && slashCandidates.length > 0;
const slashHiSafe = Math.min(slashHi, Math.max(0, slashCandidates.length - 1));
const selectSlash = (cmd: string) => {
  setInput(completeSlash(cmd));
  void textareaRef.current?.focus();
};
```

2.5 textarea 属性改造（完整替换现有 textarea 的 onChange/onKeyDown/ref，其余属性保留）：

```tsx
<textarea
  ref={textareaRef}
  className="composer__input"
  value={input}
  onChange={(e) => { setInput(e.target.value); setSlashDismissed(false); setSlashHi(0); }}
  onKeyDown={(e) => {
    if (slashVisible) {
      const next = handleSlashKey(e.key, { open: true, hi: slashHiSafe, count: slashCandidates.length });
      if (next) {
        e.preventDefault();
        if (next.selected) {
          selectSlash(slashCandidates[next.hi ?? slashHiSafe]!.command);
        } else if (typeof next.hi === 'number') {
          setSlashHi(next.hi);
        } else {
          setSlashDismissed(true);
        }
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); }
  }}
  placeholder={compacting ? '压缩中…' : status === 'running' ? 'AI 执行中…' : '输入指令，让 AI 操作页面…'}
  disabled={status === 'running' || compacting}
  rows={2}
/>
```

2.6 composer JSX 改造：textarea 外包一层 `.composer__wrap`，SlashMenu 放 wrap 内、textarea 之前：

```tsx
<div className="composer">
  <div className="composer__wrap">
    {slashVisible && (
      <SlashMenu
        candidates={slashCandidates.slice(0, 8)}
        hi={slashHiSafe}
        onSelect={selectSlash}
      />
    )}
    <textarea ... /* 2.5 的完整属性 */ />
  </div>
  <div className="composer__bar">
    ...原有内容不变...
  </div>
</div>
```

2.7 user 消息斜杠徽标（`MessageRow` 的 user 分支替换为）：

```tsx
if (item.role === 'user') {
  const slash = /^\/([a-z0-9-]+)(?:\s|$)/.exec(item.text);
  return (
    <div className="msg-user rise">
      {slash && <span className="mono slash-chip">/{slash[1]}</span>}
      {item.text}
    </div>
  );
}
```

- [ ] **Step 3: `entrypoints/sidepanel/styles.css` 末尾追加**

先核对 token 名（Run: `grep -n "\-\-paper\|\-\-line\|\-\-ink" entrypoints/sidepanel/styles.css | head`），若与下列用的 token 不符，以实际存在的为准替换。追加：

```css
/* ---------- 斜杠浮层（spec §3）---------- */
.composer__wrap { position: relative; }
.slash-menu {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 0;
  right: 0;
  max-height: 240px;
  overflow-y: auto;
  background: var(--paper-raised, var(--paper));
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, .18);
  z-index: 30;
  padding: 4px;
}
.slash-menu__item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  text-align: left;
  padding: 7px 10px;
  border: 0;
  background: transparent;
  border-radius: 6px;
  cursor: pointer;
  color: var(--ink-1, var(--ink));
  font: inherit;
  font-size: 12px;
}
.slash-menu__item--hi { background: color-mix(in srgb, var(--signal) 12%, transparent); }
.slash-menu__cmd { color: var(--signal); flex-shrink: 0; }
.slash-menu__name { color: var(--ink-1, var(--ink)); flex-shrink: 0; }
.slash-menu__desc {
  color: var(--ink-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-left: auto;
  min-width: 0;
}
.slash-chip {
  display: inline-block;
  padding: 1px 6px;
  border: 1px solid color-mix(in srgb, var(--signal) 45%, transparent);
  border-radius: 999px;
  color: var(--signal);
  font-size: 10px;
  margin-right: 6px;
  vertical-align: 1px;
}
```

- [ ] **Step 4: 编译 + 全量测试**

Run: `npm run compile && npm run test`
Expected: 全绿

- [ ] **Step 5: 手动验证（npm run dev）**

加载扩展 → 聊天输入 `/` 弹浮层 → ↑↓ 选择、Enter 补全 `/translate `、Esc 关闭、Tab 补全、点击候选补全 → 继续输入附加文本回车发送 → 消息带 `/translate` 徽标 → 浮层输入 `/zzz` 显示空（不弹）。

- [ ] **Step 6: Commit**

```bash
git add components/chat/SlashMenu.tsx components/chat/ChatView.tsx entrypoints/sidepanel/styles.css
git commit -m "feat(chat): 斜杠浮层 SlashMenu + ChatView 键盘导航接入"
```

---

### Task 7: `SkillsPage.tsx` + 设置页入口

**Files:**
- Create: `components/skills/SkillsPage.tsx`
- Modify: `components/settings/SettingsHome.tsx`
- Modify: `components/settings/SettingsView.tsx`
- Modify: `entrypoints/sidepanel/styles.css`（如需 `.skills-list`；可复用 `.scripts-list`/`.scripts-card` 则不加）

**前置阅读：** 实施前先 Read `components/settings/ModelSettings.tsx` 确认二级页返回按钮的现有模式（PageShell 无 onBack prop），SkillsPage 照搬该模式。

- [ ] **Step 1: 实现 `components/skills/SkillsPage.tsx`**

```tsx
// components/skills/SkillsPage.tsx
// 技能管理二级页（spec §4）：列表（搜索/导入/导出/启停/删除）↔ 详情（仅查看）。无新建无编辑。
import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, Download, Search, Trash2, Upload } from 'lucide-react';
import { PageShell } from '../ui/PageShell';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { useSkills, sendSkillsRequest } from '../../stores/skills';
import type { Skill, SkillSummary } from '../../shared/types';

/** 列表搜索（含停用全量）：name/command/description 子串，大小写不敏感 */
function filterAll(list: SkillSummary[], q: string): SkillSummary[] {
  const s = q.trim().toLowerCase();
  if (!s) return list;
  return list.filter(
    (x) =>
      x.name.toLowerCase().includes(s) ||
      x.command.toLowerCase().includes(s) ||
      x.description.toLowerCase().includes(s),
  );
}

interface ImportAggregate {
  imported: number;
  overwritten: number;
  warnings: string[];
}

export function SkillsPage({ onBack }: { onBack: () => void }) {
  const { list, refresh } = useSkills();
  const [detailId, setDetailId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<ImportAggregate | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [detail, setDetail] = useState<Skill | null>(null);

  useEffect(() => { void refresh(); }, [refresh]);

  // 详情：SkillSummary 无 content，命中详情时单独拉全量
  useEffect(() => {
    setDetail(null);
    if (detailId == null) return;
    void (async () => {
      const resp = await sendSkillsRequest<{ ok: boolean; data?: { skill: Skill }; error?: string }>({ type: 'SKILLS_GET', id: detailId });
      if (resp.ok && resp.data) setDetail(resp.data.skill);
      else setDetailId(null); // 已被删等情况 → 回列表
    })();
  }, [detailId]);

  async function importFiles(files: FileList): Promise<void> {
    const agg: ImportAggregate = { imported: 0, overwritten: 0, warnings: [] };
    for (const f of Array.from(files)) {
      const text = await f.text();
      const resp = await sendSkillsRequest<{ ok: boolean; data?: ImportAggregate; error?: string }>({
        type: 'SKILLS_IMPORT', text, filename: f.name,
      });
      if (resp.ok && resp.data) {
        agg.imported += resp.data.imported;
        agg.overwritten += resp.data.overwritten;
        agg.warnings.push(...resp.data.warnings);
      } else {
        agg.warnings.push(`${f.name}：${resp.error ?? '导入失败'}`);
      }
    }
    setResult(agg);
    await refresh();
  }

  async function exportMd(ids?: string[]): Promise<void> {
    const resp = await sendSkillsRequest<{ ok: boolean; data?: { text: string; count: number }; error?: string }>({ type: 'SKILLS_EXPORT', ids });
    if (!resp.ok || !resp.data) {
      setResult({ imported: 0, overwritten: 0, warnings: [resp.error ?? '导出失败'] });
      return;
    }
    // 单条文件名用其 command；多条用日期
    const single = resp.data.count === 1 ? /^command: ([a-z0-9-]+)$/m.exec(resp.data.text)?.[1] : undefined;
    const name = single ? `${single}.md` : `skills-${new Date().toISOString().slice(0, 10)}.md`;
    const url = URL.createObjectURL(new Blob([resp.data.text], { type: 'text/markdown' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function setEnabled(id: string, enabled: boolean): Promise<void> {
    await sendSkillsRequest({ type: 'SKILLS_SET_ENABLED', id, enabled });
    await refresh();
  }

  async function remove(id: string, name: string): Promise<void> {
    if (!window.confirm(`删除技能「${name}」？不可恢复。`)) return;
    await sendSkillsRequest({ type: 'SKILLS_DELETE', id });
    await refresh();
  }

  // ---------- 详情页（仅查看）----------
  if (detailId != null) {
    return (
      <PageShell
        title={detail?.name ?? '技能详情'}
        eyebrow="SKILL"
        actions={
          <Button variant="ghost" className="btn--icon" aria-label="返回列表" onClick={() => setDetailId(null)}>
            <ChevronLeft size={16} />
          </Button>
        }
      >
        {detail && (
          <div className="skills-detail">
            <div className="skills-detail__head">
              <span className="mono slash-chip">/{detail.command}</span>
              <button
                type="button"
                role="switch"
                aria-checked={detail.enabled}
                aria-label={`${detail.enabled ? '禁用' : '启用'} ${detail.name}`}
                className={`switch${detail.enabled ? ' switch--on' : ''}`}
                onClick={() => { void setEnabled(detail.id, !detail.enabled); setDetail({ ...detail, enabled: !detail.enabled }); }}
              >
                <span className="switch__thumb" aria-hidden />
              </button>
            </div>
            {detail.description && <div className="skills-detail__desc">{detail.description}</div>}
            <span className="token">CONTENT</span>
            <div className="well" style={{ whiteSpace: 'pre-wrap' }}>{detail.content}</div>
            <div className="skills-detail__meta">更新于 {new Date(detail.updatedAt).toLocaleString()}</div>
          </div>
        )}
      </PageShell>
    );
  }

  // ---------- 列表页 ----------
  const visible = filterAll(list, query);

  return (
    <PageShell
      title="技能管理"
      eyebrow="SKILLS"
      actions={
        <>
          <Button variant="ghost" className="btn--icon" aria-label="导入技能" onClick={() => fileRef.current?.click()}>
            <Upload size={16} />
          </Button>
          <Button variant="ghost" className="btn--icon" aria-label="导出全部技能" onClick={() => void exportMd()}>
            <Download size={16} />
          </Button>
          <Button variant="ghost" className="btn--icon" aria-label="返回设置" onClick={onBack}>
            <ChevronLeft size={16} />
          </Button>
        </>
      }
    >
      {result && result.warnings.length > 0 && (
        <div className="scripts-warnline" role="status">
          {result.warnings.map((w, i) => (<div key={i}>{w}</div>))}
        </div>
      )}
      {result && (
        <div className="scripts-warnline" role="status">
          导入 {result.imported} 个，覆盖 {result.overwritten} 个
        </div>
      )}

      <div className="scripts-toolbar">
        <div style={{ position: 'relative', flex: 1 }}>
          <Search size={13} style={{ position: 'absolute', left: 8, top: 8, color: 'var(--ink-3)' }} aria-hidden />
          <Input
            aria-label="搜索技能"
            placeholder="搜索名称 / 命令 / 简述…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ paddingLeft: 26 }}
          />
        </div>
      </div>

      <div className="scripts-list">
        {visible.map((s) => (
          <div
            key={s.id}
            className={`scripts-card${s.enabled ? '' : ' scripts-card--off'}`}
            role="button"
            tabIndex={0}
            onClick={() => setDetailId(s.id)}
            onKeyDown={(e) => {
              if (e.currentTarget !== e.target) return;
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setDetailId(s.id);
              }
            }}
          >
            <div className="scripts-card__top">
              <span className="scripts-card__name">{s.name}</span>
              <button
                type="button"
                className="scripts-card__delbtn"
                aria-label={`删除 ${s.name}`}
                title="删除技能"
                onClick={(e) => {
                  e.stopPropagation();
                  void remove(s.id, s.name);
                }}
                onKeyDown={(e) => e.stopPropagation()}
              >
                <Trash2 size={14} aria-hidden />
              </button>
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
              <span className="mono slash-chip">/{s.command}</span>
              <span className="scripts-card__match">{s.description}</span>
            </div>
          </div>
        ))}
        {visible.length === 0 && <div className="chat__empty">没有匹配的技能</div>}
      </div>

      <input
        ref={fileRef}
        type="file"
        accept=".md,text/markdown"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          if (e.target.files?.length) void importFiles(e.target.files);
          e.target.value = '';
        }}
      />
    </PageShell>
  );
}
```

- [ ] **Step 2: 设置页入口**

`components/settings/SettingsHome.tsx`：

import 行改为：

```tsx
import { SlidersHorizontal, SquareTerminal, FlaskConical, ChevronRight, Sparkles } from 'lucide-react';
```

类型与 ENTRIES：

```tsx
export type SettingsSub = 'model' | 'toolbench' | 'scriptdebug' | 'skills';
```

ENTRIES 数组末尾追加：

```tsx
  { key: 'skills', title: '技能管理', desc: '导入 .md 技能，注入会话上下文，斜杠指令调用', Icon: Sparkles },
```

`components/settings/SettingsView.tsx`：

```tsx
import { SkillsPage } from '../skills/SkillsPage';
```

函数体内加分支（`scriptdebug` 分支后）：

```tsx
  if (sub === 'skills') return <SkillsPage onBack={back} />;
```

- [ ] **Step 3: 编译 + 全量测试**

Run: `npm run compile && npm run test`
Expected: 全绿

- [ ] **Step 4: 手动验证（npm run dev）**

设置页出现「技能管理」卡 → 列表空态 → 导入单文件 → 导入多选（含一个坏文件，其余照常）→ 覆盖提示（同 command 再导）→ 启停 → 详情（仅查看 + switch 启停）→ 删除确认 → 导出全部（skills-日期.md）/重新导入覆盖 → 返回设置。

- [ ] **Step 5: Commit**

```bash
git add components/skills/SkillsPage.tsx components/settings/SettingsHome.tsx components/settings/SettingsView.tsx entrypoints/sidepanel/styles.css
git commit -m "feat(skills): 技能管理二级页（列表/详情/导入导出/启停/删除）+ 设置页入口"
```

---

### Task 8: 收尾——CLAUDE.md 回填 + 全量验证

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: CLAUDE.md 追加阶段记录**

在「设置页枢纽 + 脚本运行时调试台（2026-09-03）已完成」段落之后追加：

```markdown
技能系统 + 斜杠指令（2026-09-04）已完成：`Skill` 实体（`local:skills:index`，command 唯一键 kebab-case，上限 100 条/正文 64KB）仅经 `.md` 导入产生（YAML frontmatter name/description/command + 正文，`shared/skill-md.ts` 手写最小解析，多文档 `\n---\n\n` 串联；同 command 覆盖更新保留 id/enabled，坏文档跳过+warning）；管理页 = 设置页二级页 `SkillsPage`（列表搜索/多选导入聚合/导出 Blob 下载/启停/删除/详情只读，无新建无编辑）；启用技能简述经 `LoopDeps.getSkills` 每轮 `buildContext` 注入 system prompt（`buildSkillsPrompt`）；斜杠指令 = 输入框 `/` 浮层（`components/chat/slash.ts` 纯函数 shouldOpenSlash/handleSlashKey/completeSlash + `SlashMenu` 展示组件，Enter/Tab/点击 = 补全 `/cmd ` 非发送，Esc 关闭由 slashDismissed 状态实现）+ loop 侧 `/^\/([a-z0-9-]+)(?:\s+([\s\S]*))?$/` 解析（原文落库，命中 enabled 技能把正文作为隐藏 system 消息仅注入触发轮 splice 在主 system 之后，未命中原样普通文本；resumeAgentLoop 恢复轮不重新注入）；AI 自主调用为遵循式（无新工具位，工具数 25 不变）。
```

- [ ] **Step 2: 全量验证**

Run: `npm run compile && npm run test`
Expected: 全绿

- [ ] **Step 3: 手动冒烟（npm run dev）**

- 导入示例 skill → 设置页/浮层可见
- `/translate xxx` 触发 → AI 遵循技能正文回复
- `/nope xxx` → 普通对话
- 导出 → 重新导入 → 「已覆盖更新」提示

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: CLAUDE.md 回填技能系统+斜杠指令阶段记录"
```

---

## Self-Review 记录（已执行）

1. **Spec 覆盖**：§1 数据模型 → Task 1/2；§2 消息与注入 → Task 2/3/4；§3 浮层 → Task 5/6；§4 管理页 → Task 7；§5 错误处理 → Task 3（导入容错/GET 报错/删除幂等）+ Task 4（未命中/停用不注入）+ Task 5（filterSkills 空返回）；§6 测试 → 各 Task 的 TDD 步骤；§7 划界 → 无工具位/无编辑（全计划未触及 registry.ts 工具注册）。
2. **占位符扫描**：全部代码块为完整实现，无 TBD/伪代码。
3. **类型一致性**：`SkillMdFields`（Task 1）↔ `newSkill(r.skill)`（Task 3）↔ `SkillBrief`（Task 4 定义、Task 5/6 消费）；`SkillsImportResult`（Task 3 导出、Task 7 复用作响应形状）；`handleSlashKey` 返回形状（Task 5 定义、Task 6 消费 `next.hi ?? slashHiSafe`）一致。
