# Phase 4 脚本池 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地类 Tampermonkey 脚本管理器：`chrome.userScripts` 注入引擎 + 脚本 CRUD/搜索/导入导出/启停 UI（列表+详情）+ per-tab 运行态展示 + AI 脚本六工具（工具 16→22）。

**Architecture:** UI 与 AI 工具共用 background 单一编排层（落库 + userScripts 注册同步原子完成）；运行态 = SW 内存 per-tab 匹配计算（「预期注入」语义）+ runtime 广播；TM 兼容 = 元数据解析 + 代码体原样执行（无 GM_*）。

**Tech Stack:** WXT + React 19 + TS + Zustand + vitest v4（WxtVitest 插件：jsdom + fakeBrowser）。

**Spec:** `docs/superpowers/specs/2026-09-01-ai-browser-extension-phase4-script-pool-design.md`

## Global Constraints

- 分支：`feature/phase4-script-pool`（已切出）。每个 commit 精确 `git add <具体文件>`，**绝不 `git add -A`**。
- 测试：`npx vitest run <测试文件>`（单文件）；`npm test`（全量）；`npm run compile`（TS 检查）。测试文件放 `tests/` 镜像源码结构；storage/后台/store 测试用 `fakeBrowser`（`import { fakeBrowser } from 'wxt/testing/fake-browser'`，`beforeEach(() => fakeBrowser.reset())`）。
- 代码风格：中文注释；错误中文文案；工具返回 `{ ok: true, data? } | { ok: false, error }`；工具执行器命名 `doXxx`。
- 样式只用 `entrypoints/sidepanel/styles.css` 的 tokens（`--paper/--surface/--sunken/--ink/--ink-2/--ink-3/--line/--line-strong/--signal/--signal-ink/--signal-wash/--ok/--ok-wash/--err/--err-wash/--warn/--warn-wash/--mono/--sans`）；新增类一律 `scripts-` 前缀防撞名；图标用 lucide-react，禁 emoji；动画带 `prefers-reduced-motion` 兜底。
- **对 spec 的一处已确认偏离**：spec §10「UI（jsdom）组件测试」→ 以 store 级纯函数测试（列表过滤/运行区更新）+ Task 11 手测清单替代（仓库无组件测试基建，UI 逻辑全部下沉 store）。其余 spec 条款逐条落实。
- 工具计数基线：当前 16（Phase 3b 未实现），本阶段 +6 → **22**。
- `confirmGate`：本阶段不实现门控，只在 `background/scripts.ts` 写 handler 前留注释拦截位。

---

### Task 1: 共享类型 + match pattern 纯函数

**Files:**
- Modify: `shared/types.ts`（文件末尾追加）
- Create: `shared/match-pattern.ts`
- Test: `tests/shared/match-pattern.test.ts`

**Interfaces:**
- Consumes: 无（纯函数 + 纯类型）。
- Produces（后续任务依赖的精确形状）：
  - `type ScriptRunAt = 'document_start' | 'document_end' | 'document_idle'`、`type ScriptWorld = 'USER_SCRIPT' | 'MAIN'`、`type ScriptSource = 'user' | 'agent' | 'import'`（`shared/types.ts`）
  - `interface UserScript { id; name; enabled; matches: string[]; code; runAt: ScriptRunAt; world: ScriptWorld; source: ScriptSource; meta?: UserScriptMeta; createdAt; updatedAt }`
  - `interface ScriptSummary { id; name; matches; enabled; source; runAt; world; updatedAt; description?; hasGrants }`
  - `isValidMatchPattern(pattern: string): boolean`、`matchPatternToRegExp(pattern: string): RegExp`（非法时 throw）、`matchUrl(patterns: string[], url: string): boolean`

- [ ] **Step 1: 写失败测试**

创建 `tests/shared/match-pattern.test.ts`：

```ts
// tests/shared/match-pattern.test.ts
import { describe, it, expect } from 'vitest';
import { isValidMatchPattern, matchPatternToRegExp, matchUrl } from '../../shared/match-pattern';

describe('isValidMatchPattern', () => {
  it('接受合法 pattern 与 <all_urls>', () => {
    expect(isValidMatchPattern('<all_urls>')).toBe(true);
    expect(isValidMatchPattern('https://example.com/*')).toBe(true);
    expect(isValidMatchPattern('*://example.com/*')).toBe(true);
    expect(isValidMatchPattern('http://*.example.com/foo/*bar')).toBe(true);
    expect(isValidMatchPattern('file:///foo/*')).toBe(true);
  });
  it('拒绝非法 pattern', () => {
    expect(isValidMatchPattern('https://example.com')).toBe(false);      // 缺路径
    expect(isValidMatchPattern('http://*foo.com/*')).toBe(false);        // 宿主 * 后跟字符
    expect(isValidMatchPattern('https://example.com:8080/*')).toBe(false); // 不允许端口
    expect(isValidMatchPattern('chrome://*')).toBe(false);               // 非法 scheme
    expect(isValidMatchPattern('')).toBe(false);
  });
});

describe('matchUrl', () => {
  it('路径通配匹配', () => {
    expect(matchUrl(['https://example.com/*'], 'https://example.com/a/b?c=1')).toBe(true);
    expect(matchUrl(['https://example.com/*'], 'https://other.com/')).toBe(false);
    expect(matchUrl(['https://example.com/a/*'], 'https://example.com/b/')).toBe(false);
  });
  it('scheme * 匹配 http/https', () => {
    expect(matchUrl(['*://example.com/*'], 'http://example.com/')).toBe(true);
    expect(matchUrl(['*://example.com/*'], 'https://example.com/')).toBe(true);
    expect(matchUrl(['*://example.com/*'], 'ftp://example.com/')).toBe(false);
  });
  it('*.example.com 含裸域（可选子域）', () => {
    expect(matchUrl(['*://*.example.com/*'], 'https://sub.example.com/x')).toBe(true);
    expect(matchUrl(['*://*.example.com/*'], 'https://example.com/x')).toBe(true);
    expect(matchUrl(['*://*.example.com/*'], 'https://notexample.com/')).toBe(false);
  });
  it('<all_urls> 匹配普通页但不匹配受限页', () => {
    expect(matchUrl(['<all_urls>'], 'https://a.com/')).toBe(true);
    expect(matchUrl(['<all_urls>'], 'chrome://extensions/')).toBe(false);
    expect(matchUrl(['<all_urls>'], 'about:blank')).toBe(false);
  });
  it('非法 pattern 不抛出、不匹配', () => {
    expect(matchUrl(['https://bad'], 'https://bad')).toBe(false);
  });
  it('空 matches 恒不匹配', () => {
    expect(matchUrl([], 'https://example.com/')).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/shared/match-pattern.test.ts`
Expected: FAIL（`Cannot find module '../../shared/match-pattern'`）

- [ ] **Step 3: 实现 `shared/match-pattern.ts`**

```ts
// shared/match-pattern.ts
// Chrome match pattern 校验与匹配（纯函数，spec §6.2）。运行态跟踪与 pattern 校验共用。

const MATCH_RE = /^(\*|https?|file|ftp|ws|wss):\/\/(\*|(?:\*\.)?[^/*:'"()]*)\/(.*)$/;

const ALL_URL_SCHEMES = 'https?|file|ftp|wss?';

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function isValidMatchPattern(pattern: string): boolean {
  if (pattern === '<all_urls>') return true;
  return MATCH_RE.test(pattern);
}

/** 非法 pattern 抛 Error；调用方可用 isValidMatchPattern 预检或 catch。 */
export function matchPatternToRegExp(pattern: string): RegExp {
  if (pattern === '<all_urls>') return new RegExp(`^(${ALL_URL_SCHEMES}):\\/\\/`);
  const m = MATCH_RE.exec(pattern);
  if (!m) throw new Error(`非法 match pattern：${pattern}`);
  const [, scheme, host, path] = m;
  const schemeRe = scheme === '*' ? 'https?' : scheme;
  let hostRe: string;
  if (host === '*') hostRe = '[^/]+';
  else if (host.startsWith('*.')) hostRe = `([^/]+\\.)?${escapeRe(host.slice(2))}`;
  else hostRe = escapeRe(host);
  const pathRe = escapeRe(path).replace(/\\\*/g, '.*');
  return new RegExp(`^${schemeRe}://${hostRe}${pathRe}$`);
}

export function matchUrl(patterns: string[], url: string): boolean {
  if (!url) return false;
  return patterns.some((p) => {
    try {
      return matchPatternToRegExp(p).test(url);
    } catch {
      return false;
    }
  });
}
```

`shared/types.ts` 末尾追加：

```ts
// ---- Phase 4：脚本池（spec §4）----

export type ScriptRunAt = 'document_start' | 'document_end' | 'document_idle';
export type ScriptWorld = 'USER_SCRIPT' | 'MAIN';
export type ScriptSource = 'user' | 'agent' | 'import';

/** TM 导入保留的展示性元数据（不参与注入） */
export interface UserScriptMeta {
  namespace?: string;
  version?: string;
  author?: string;
  description?: string;
  /** @grant 记录；仅用于「需要 GM_*（本扩展不支持）」警告徽标 */
  grants?: string[];
  noframes?: boolean;
}

export interface UserScript {
  id: string;
  name: string;
  enabled: boolean;
  matches: string[];
  code: string;
  runAt: ScriptRunAt;
  world: ScriptWorld;
  source: ScriptSource;
  meta?: UserScriptMeta;
  createdAt: number;
  updatedAt: number;
}

/** 列表/摘要形状（无 code） */
export interface ScriptSummary {
  id: string;
  name: string;
  matches: string[];
  enabled: boolean;
  source: ScriptSource;
  runAt: ScriptRunAt;
  world: ScriptWorld;
  updatedAt: number;
  description?: string;
  hasGrants: boolean;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/shared/match-pattern.test.ts`
Expected: PASS（全部用例）

- [ ] **Step 5: 类型检查 + 提交**

Run: `npm run compile`
Expected: 无错误

```bash
git add shared/types.ts shared/match-pattern.ts tests/shared/match-pattern.test.ts
git commit -m "feat(scripts): UserScript 类型 + match pattern 纯函数"
```

---

### Task 2: TM 元数据解析/序列化

**Files:**
- Create: `shared/userscript-meta.ts`
- Test: `tests/shared/userscript-meta.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `ScriptRunAt`/`UserScript`/`UserScriptMeta`。
- Produces:
  - `interface ParsedUserScript { fields: { name: string; matches: string[]; runAt: ScriptRunAt; code: string; meta: UserScriptMeta }; warnings: string[] }`
  - `parseUserScript(source: string, fallbackName?: string): ParsedUserScript`
  - `stringifyUserScript(script: UserScript): string`

- [ ] **Step 1: 写失败测试**

创建 `tests/shared/userscript-meta.test.ts`：

```ts
// tests/shared/userscript-meta.test.ts
import { describe, it, expect } from 'vitest';
import { parseUserScript, stringifyUserScript } from '../../shared/userscript-meta';
import type { UserScript } from '../../shared/types';

const fixture = `// ==UserScript==
// @name         去广告助手
// @namespace    https://example.org/
// @version      1.2.0
// @author       someone
// @description  移除页面广告
// @match        https://example.com/*
// @match        https://www.example.com/*
// @run-at       document-end
// @grant        GM_setValue
// ==/UserScript==

document.querySelector('.ad')?.remove();`;

describe('parseUserScript', () => {
  it('解析标准头：name/matches/run-at/grants/代码体', () => {
    const { fields, warnings } = parseUserScript(fixture);
    expect(fields.name).toBe('去广告助手');
    expect(fields.matches).toEqual(['https://example.com/*', 'https://www.example.com/*']);
    expect(fields.runAt).toBe('document_end');
    expect(fields.code).toBe('\ndocument.querySelector(\'.ad\')?.remove();');
    expect(fields.meta).toMatchObject({ namespace: 'https://example.org/', version: '1.2.0', author: 'someone', description: '移除页面广告', grants: ['GM_setValue'] });
    expect(warnings.some((w) => w.includes('GM_*'))).toBe(true);
  });

  it('无元数据头：整段作为 code + 警告', () => {
    const { fields, warnings } = parseUserScript('console.log(1)', 'my.user.js');
    expect(fields.code).toBe('console.log(1)');
    expect(fields.name).toBe('my');
    expect(fields.matches).toEqual([]);
    expect(warnings.some((w) => w.includes('元数据头'))).toBe(true);
  });

  it('无 @name 时用 fallbackName，再退「未命名脚本」', () => {
    const src = '// ==UserScript==\n// @match https://a.com/*\n// ==/UserScript==\n';
    expect(parseUserScript(src, 'x.user.js').fields.name).toBe('x');
    expect(parseUserScript(src).fields.name).toBe('未命名脚本');
  });

  it('@run-at 三种值映射 + 非法值警告并回退 document_idle', () => {
    const mk = (v: string) => `// ==UserScript==\n// @run-at ${v}\n// ==/UserScript==\n`;
    expect(parseUserScript(mk('document-start')).fields.runAt).toBe('document_start');
    expect(parseUserScript(mk('document-idle')).fields.runAt).toBe('document_idle');
    const bad = parseUserScript(mk('whenever'));
    expect(bad.fields.runAt).toBe('document_idle');
    expect(bad.warnings.some((w) => w.includes('@run-at'))).toBe(true);
  });

  it('@include 警告并忽略；无 @match 警告', () => {
    const src = '// ==UserScript==\n// @include https://a.com/*\n// ==/UserScript==\ncode();';
    const r = parseUserScript(src);
    expect(r.fields.matches).toEqual([]);
    expect(r.warnings.some((w) => w.includes('@include'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('@match'))).toBe(true);
  });

  it('其它不支持的键汇总为一条 ignored 警告', () => {
    const src = '// ==UserScript==\n// @icon a.png\n// @updateURL https://u\n// @downloadURL https://d\n// ==/UserScript==\n';
    const { warnings } = parseUserScript(src);
    expect(warnings.filter((w) => w.includes('已忽略')).toHaveLength(1));
    expect(warnings.join('\n')).toContain('@icon');
  });

  it('@grant none 不产生警告', () => {
    const src = '// ==UserScript==\n// @match https://a.com/*\n// @grant none\n// ==/UserScript==\n';
    const r = parseUserScript(src);
    expect(r.warnings.some((w) => w.includes('GM_*'))).toBe(false);
    expect(r.fields.meta.grants).toBeUndefined();
  });
});

describe('stringifyUserScript / parse 往返', () => {
  it('stringify → parse 元数据无损', () => {
    const s: UserScript = {
      id: 's1', name: '测试', enabled: true, matches: ['https://a.com/*'],
      code: 'console.log("x");', runAt: 'document_start', world: 'USER_SCRIPT', source: 'import',
      meta: { namespace: 'ns', version: '0.1', author: 'me', description: '描述', grants: ['GM_getValue'] },
      createdAt: 0, updatedAt: 0,
    };
    const text = stringifyUserScript(s);
    expect(text).toContain('@name');
    const back = parseUserScript(text);
    expect(back.fields.name).toBe('测试');
    expect(back.fields.matches).toEqual(['https://a.com/*']);
    expect(back.fields.runAt).toBe('document_start');
    expect(back.fields.code).toBe('\nconsole.log("x");');
    expect(back.fields.meta).toEqual(s.meta);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/shared/userscript-meta.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `shared/userscript-meta.ts`**

```ts
// shared/userscript-meta.ts
// Tampermonkey ==UserScript== 元数据解析/序列化（纯函数，spec §5）。
// 兼容策略：解析头 + 代码体原样执行；GM_* 不实现（grants 仅作警告徽标）；@include 等 glob 匹配键警告并忽略。

import type { ScriptRunAt, UserScript, UserScriptMeta } from './types';

const RUN_AT_IN: Record<string, ScriptRunAt> = {
  'document-start': 'document_start',
  'document-end': 'document_end',
  'document-idle': 'document_idle',
};

const RUN_AT_OUT: Record<ScriptRunAt, string> = {
  document_start: 'document-start',
  document_end: 'document-end',
  document_idle: 'document-idle',
};

/** glob 语义的匹配键：与 @match 有损，宁缺毋滥（spec §2 非目标） */
const UNSUPPORTED_MATCH_KEYS = new Set(['include', 'exclude', 'ant-match']);

export interface ParsedUserScript {
  fields: { name: string; matches: string[]; runAt: ScriptRunAt; code: string; meta: UserScriptMeta };
  warnings: string[];
}

export function parseUserScript(source: string, fallbackName?: string): ParsedUserScript {
  const lines = source.split(/\r?\n/);
  const startIdx = lines.findIndex((l) => l.trim() === '// ==UserScript==');
  const endIdx = lines.findIndex((l) => l.trim() === '// ==/UserScript==');
  const defaultName = fallbackName?.replace(/\.user\.js$|\.js$/i, '').trim() || '未命名脚本';
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    return {
      fields: { name: defaultName, matches: [], runAt: 'document_idle', code: source, meta: {} },
      warnings: ['未找到 ==UserScript== 元数据头，将使用默认设置'],
    };
  }

  const matches: string[] = [];
  const grants: string[] = [];
  const meta: UserScriptMeta = {};
  const ignoredKeys = new Set<string>();
  let name = '';
  let runAt: ScriptRunAt = 'document_idle';
  let badRunAt = '';
  let unsupportedMatch = false;

  for (const line of lines.slice(startIdx + 1, endIdx)) {
    const m = /^\s*\/\/\s*@(\S+)\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    const value = m[2].trim();
    switch (key) {
      case 'name': name = value; break;
      case 'namespace': meta.namespace = value; break;
      case 'version': meta.version = value; break;
      case 'author': meta.author = value; break;
      case 'description': meta.description = value; break;
      case 'match': matches.push(value); break;
      case 'run-at': {
        const mapped = RUN_AT_IN[value];
        if (mapped) runAt = mapped;
        else badRunAt = value;
        break;
      }
      case 'grant': grants.push(value); break;
      case 'noframes': meta.noframes = true; break;
      default:
        if (UNSUPPORTED_MATCH_KEYS.has(key)) unsupportedMatch = true;
        else ignoredKeys.add(key);
    }
  }

  // 警告按固定顺序组装（测试依赖此顺序的稳定性）
  const warnings: string[] = [];
  if (badRunAt) warnings.push(`@run-at 值「${badRunAt}」不支持，已用 document-idle`);
  const realGrants = grants.filter((g) => g !== 'none');
  if (realGrants.length > 0) {
    meta.grants = grants;
    warnings.push(`@grant 非 none：本扩展不支持 GM_* API（${realGrants.join(', ')}），脚本调用会报错`);
  }
  if (unsupportedMatch) warnings.push('不支持的匹配键 @include/@exclude 已忽略，请改用 @match');
  if (ignoredKeys.size > 0) {
    warnings.push(`已忽略 ${ignoredKeys.size} 个不支持的元数据键：${[...ignoredKeys].map((k) => `@${k}`).join(' ')}`);
  }
  if (matches.length === 0) warnings.push('未找到 @match：脚本不会在任何页面运行，请在详情页补匹配规则');

  return {
    fields: { name: name || defaultName, matches, runAt, code: lines.slice(endIdx + 1).join('\n'), meta },
    warnings,
  };
}

/** 反向生成带元数据头的 .user.js 文本（导出下载用）。 */
export function stringifyUserScript(script: UserScript): string {
  const meta = script.meta ?? {};
  const lines = ['// ==UserScript==', `// @name        ${script.name}`];
  if (meta.namespace) lines.push(`// @namespace   ${meta.namespace}`);
  if (meta.version) lines.push(`// @version     ${meta.version}`);
  if (meta.author) lines.push(`// @author      ${meta.author}`);
  if (meta.description) lines.push(`// @description ${meta.description}`);
  for (const m of script.matches) lines.push(`// @match       ${m}`);
  lines.push(`// @run-at      ${RUN_AT_OUT[script.runAt]}`);
  if (meta.grants) for (const g of meta.grants) lines.push(`// @grant       ${g}`);
  if (meta.noframes) lines.push('// @noframes');
  lines.push('// ==/UserScript==', '');
  return [...lines, script.code].join('\n');
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/shared/userscript-meta.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add shared/userscript-meta.ts tests/shared/userscript-meta.test.ts
git commit -m "feat(scripts): TM ==UserScript== 元数据解析/序列化（纯函数）"
```

---

### Task 3: 脚本存储层

**Files:**
- Create: `storage/scripts.ts`
- Test: `tests/storage/scripts.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `UserScript`/`ScriptSummary`。
- Produces:
  - `MAX_SCRIPTS = 200`、`MAX_CODE_LENGTH = 256 * 1024`
  - `listScripts(): Promise<UserScript[]>`、`getScript(id): Promise<UserScript | undefined>`
  - `saveScript(script: UserScript): Promise<void>`（upsert；超上限 throw Error 中文文案）
  - `deleteScript(id): Promise<void>`
  - `toSummary(s: UserScript): ScriptSummary`
  - 存储键：`local:scripts:index`（`UserScript[]` 单键，spec §4）

- [ ] **Step 1: 写失败测试**

创建 `tests/storage/scripts.test.ts`：

```ts
// tests/storage/scripts.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { storage } from 'wxt/utils/storage';
import { listScripts, getScript, saveScript, deleteScript, toSummary, MAX_SCRIPTS } from '../../storage/scripts';
import type { UserScript } from '../../shared/types';

function mkScript(over: Partial<UserScript> = {}): UserScript {
  return {
    id: 's1', name: '测试', enabled: true, matches: ['https://a.com/*'],
    code: 'console.log(1);', runAt: 'document_idle', world: 'USER_SCRIPT',
    source: 'user', createdAt: 1, updatedAt: 1, ...over,
  };
}

describe('storage/scripts', () => {
  beforeEach(() => fakeBrowser.reset());

  it('空库返回 []', async () => {
    expect(await listScripts()).toEqual([]);
    expect(await getScript('s1')).toBeUndefined();
  });

  it('save 新增 + get 读回 + list 全量', async () => {
    await saveScript(mkScript());
    await saveScript(mkScript({ id: 's2', name: '第二个' }));
    expect(await getScript('s1')).toMatchObject({ id: 's1', name: '测试' });
    expect(await listScripts()).toHaveLength(2);
  });

  it('save 同 id 覆盖（upsert）', async () => {
    await saveScript(mkScript());
    await saveScript(mkScript({ name: '改名', updatedAt: 9 }));
    const all = await listScripts();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ name: '改名', updatedAt: 9 });
  });

  it('落到 local:scripts:index 键', async () => {
    await saveScript(mkScript());
    const raw = await storage.getItem<UserScript[]>('local:scripts:index');
    expect(raw).toHaveLength(1);
  });

  it('delete 移除', async () => {
    await saveScript(mkScript());
    await deleteScript('s1');
    expect(await listScripts()).toEqual([]);
  });

  it('数量上限：超过 MAX_SCRIPTS 抛错', async () => {
    for (let i = 0; i < MAX_SCRIPTS; i++) await saveScript(mkScript({ id: `s${i}` }));
    await expect(saveScript(mkScript({ id: 'extra' }))).rejects.toThrow('上限');
  });

  it('code 超长抛错', async () => {
    await expect(saveScript(mkScript({ code: 'x'.repeat(256 * 1024 + 1) }))).rejects.toThrow('上限');
  });
});

describe('toSummary', () => {
  it('裁掉 code，带 hasGrants/description', () => {
    const s = mkScript({ meta: { description: '描述', grants: ['GM_getValue'] } });
    const sum = toSummary(s);
    expect(sum).not.toHaveProperty('code');
    expect(sum).toMatchObject({ id: 's1', description: '描述', hasGrants: true });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/storage/scripts.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `storage/scripts.ts`**

```ts
// storage/scripts.ts
// 脚本池存储（spec §4）。单键 local:scripts:index（UserScript[]），沿用原总体设计 §8 键名。
// 个人量级（<100 条）全量读写无压力，YAGNI 分键。

import { storage } from 'wxt/utils/storage';
import type { ScriptSummary, UserScript } from '../shared/types';

const KEY = 'local:scripts:index' as const;

export const MAX_SCRIPTS = 200;
export const MAX_CODE_LENGTH = 256 * 1024;

export async function listScripts(): Promise<UserScript[]> {
  return (await storage.getItem<UserScript[]>(KEY)) ?? [];
}

export async function getScript(id: string): Promise<UserScript | undefined> {
  return (await listScripts()).find((s) => s.id === id);
}

/** upsert；数量/code 上限超限 throw（文案给用户/模型可读的中文原因）。 */
export async function saveScript(script: UserScript): Promise<void> {
  const all = await listScripts();
  const exists = all.some((s) => s.id === script.id);
  if (!exists && all.length >= MAX_SCRIPTS) {
    throw new Error(`脚本数量已达上限（${MAX_SCRIPTS} 条），请先删除部分脚本`);
  }
  if (script.code.length > MAX_CODE_LENGTH) {
    throw new Error(`脚本代码超过上限（${MAX_CODE_LENGTH} 字符）`);
  }
  const next = exists ? all.map((s) => (s.id === script.id ? script : s)) : [...all, script];
  await storage.setItem(KEY, next);
}

export async function deleteScript(id: string): Promise<void> {
  const all = await listScripts();
  await storage.setItem(KEY, all.filter((s) => s.id !== id));
}

export function toSummary(s: UserScript): ScriptSummary {
  return {
    id: s.id,
    name: s.name,
    matches: s.matches,
    enabled: s.enabled,
    source: s.source,
    runAt: s.runAt,
    world: s.world,
    updatedAt: s.updatedAt,
    description: s.meta?.description,
    hasGrants: (s.meta?.grants?.length ?? 0) > 0,
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/storage/scripts.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add storage/scripts.ts tests/storage/scripts.test.ts
git commit -m "feat(scripts): 脚本池存储层（local:scripts:index + 上限）"
```

---

### Task 4: 消息协议扩展

**Files:**
- Modify: `shared/messages.ts`（文件末尾追加；顶部 import 补类型）
- Test: `tests/shared/messages-phase4.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `ScriptRunAt`/`ScriptWorld`/`ScriptSource`/`ScriptSummary`。
- Produces:
  - `interface ScriptInput { name; code; matches: string[]; runAt?; world?; enabled?; source? }`
  - `interface ScriptPatch { name?; code?; matches?; runAt?; world?; enabled? }`
  - `interface ScriptsRuntimeEntry { tabId: number; url: string; scriptIds: string[] }`
  - `type ScriptsRequest`（8 个 request 的判别联合）
  - `interface ScriptsRuntimeEvent { type: 'SCRIPTS_RUNTIME'; payload: ScriptsRuntimeEntry }`
  - `interface ScriptsListData { scripts: ScriptSummary[]; engineAvailable: boolean }`

- [ ] **Step 1: 写失败测试**

创建 `tests/shared/messages-phase4.test.ts`：

```ts
// tests/shared/messages-phase4.test.ts
// 协议类型回归：8 个脚本 request 可构造 + 广播事件形状（spec §7）。
import { describe, it, expect, expectTypeOf } from 'vitest';
import type { ScriptsRequest, ScriptsRuntimeEvent, ScriptsListData, ScriptInput } from '../../shared/messages';

describe('Phase 4 脚本消息协议', () => {
  it('8 个 request 类型可构造且可赋值给 ScriptsRequest', () => {
    const reqs: ScriptsRequest[] = [
      { type: 'SCRIPTS_LIST' },
      { type: 'SCRIPTS_GET', id: 's1' },
      { type: 'SCRIPTS_CREATE', input: { name: 'n', code: 'c', matches: ['https://a.com/*'] } },
      { type: 'SCRIPTS_UPDATE', id: 's1', patch: { enabled: false } },
      { type: 'SCRIPTS_DELETE', id: 's1' },
      { type: 'SCRIPTS_SET_ENABLED', id: 's1', enabled: true },
      { type: 'SCRIPTS_IMPORT', source: '// ==UserScript==\n', filename: 'a.user.js' },
      { type: 'SCRIPTS_GET_RUNTIME' },
    ];
    expect(reqs).toHaveLength(8);
  });

  it('ScriptInput 可选字段缺省合法', () => {
    const input: ScriptInput = { name: 'n', code: 'c', matches: [] };
    expectTypeOf(input).toMatchTypeOf<ScriptInput>();
  });

  it('广播事件形状', () => {
    const e: ScriptsRuntimeEvent = { type: 'SCRIPTS_RUNTIME', payload: { tabId: 1, url: 'https://a.com/', scriptIds: ['s1'] } };
    expect(e.payload.scriptIds).toEqual(['s1']);
  });

  it('LIST 响应 data 含 engineAvailable', () => {
    const d: ScriptsListData = { scripts: [], engineAvailable: true };
    expect(d.engineAvailable).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/shared/messages-phase4.test.ts`
Expected: FAIL（类型不存在）

- [ ] **Step 3: 实现**

`shared/messages.ts` 顶部 import 行改为：

```ts
import type { ScriptRunAt, ScriptSource, ScriptSummary, ScriptWorld, ToolResult, Uid } from './types';
```

文件末尾追加：

```ts
// ---------- Phase 4：脚本池（sidepanel → bg request/response，走 MessageRouter；spec §7）----------

export interface ScriptInput {
  name: string;
  code: string;
  matches: string[];
  runAt?: ScriptRunAt;
  world?: ScriptWorld;
  enabled?: boolean;
  /** 创建来源：UI 默认 user；AI 工具传 agent；导入走 SCRIPTS_IMPORT（固定 import） */
  source?: ScriptSource;
}

export interface ScriptPatch {
  name?: string;
  code?: string;
  matches?: string[];
  runAt?: ScriptRunAt;
  world?: ScriptWorld;
  enabled?: boolean;
}

export interface ScriptsRuntimeEntry {
  tabId: number;
  url: string;
  scriptIds: string[];
}

export type ScriptsRequest =
  | { type: 'SCRIPTS_LIST' }
  | { type: 'SCRIPTS_GET'; id: string }
  | { type: 'SCRIPTS_CREATE'; input: ScriptInput }
  | { type: 'SCRIPTS_UPDATE'; id: string; patch: ScriptPatch }
  | { type: 'SCRIPTS_DELETE'; id: string }
  | { type: 'SCRIPTS_SET_ENABLED'; id: string; enabled: boolean }
  | { type: 'SCRIPTS_IMPORT'; source: string; filename?: string }
  | { type: 'SCRIPTS_GET_RUNTIME' };

/** bg → 扩展页面广播（fire-and-forget）：某 tab 运行集变化（spec §6.2「预期注入」语义） */
export interface ScriptsRuntimeEvent {
  type: 'SCRIPTS_RUNTIME';
  payload: ScriptsRuntimeEntry;
}

/** SCRIPTS_LIST 响应 data 形状 */
export interface ScriptsListData {
  scripts: ScriptSummary[];
  /** chrome.userScripts 可用性（false → UI 顶部警示条） */
  engineAvailable: boolean;
}
```

- [ ] **Step 4: 跑测试 + 全量消息回归确认通过**

Run: `npx vitest run tests/shared/`
Expected: PASS（含既有 messages 系列测试，确认无回归）

- [ ] **Step 5: 提交**

```bash
git add shared/messages.ts tests/shared/messages-phase4.test.ts
git commit -m "feat(scripts): 脚本池消息协议（8 request + RUNTIME 广播）"
```

### Task 5: 运行态跟踪原语（匹配计算 + 广播）

**Files:**
- Create: `background/scripts.ts`（本任务只写运行态部分；CRUD 编排在 Task 6 追加进同一文件）
- Test: `tests/background/scripts.test.ts`（本任务先建运行态用例）

**Interfaces:**
- Consumes: Task 1 `matchUrl`、Task 3 `listScripts`、Task 4 `ScriptsRuntimeEntry`。
- Produces（Task 6/8 依赖）：
  - `computeRuntimeScriptIds(url: string, scripts: UserScript[]): string[]`
  - `recomputeTab(tabId: number, url: string): Promise<void>`（变化才广播）
  - `recomputeAllTabs(): Promise<void>`（tabs.query 全量重算）
  - `dropTab(tabId: number): void`、`getRuntimeSnapshot(): ScriptsRuntimeEntry[]`
  - `ENGINE_UNAVAILABLE_MSG`（Task 6 用）

- [ ] **Step 1: 写失败测试**

创建 `tests/background/scripts.test.ts`：

```ts
// tests/background/scripts.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  computeRuntimeScriptIds, recomputeTab, recomputeAllTabs, dropTab, getRuntimeSnapshot,
} from '../../background/scripts';
import { saveScript } from '../../storage/scripts';
import type { UserScript } from '../../shared/types';

function mkScript(over: Partial<UserScript> = {}): UserScript {
  return {
    id: 's1', name: '测试', enabled: true, matches: ['https://a.com/*'],
    code: 'x();', runAt: 'document_idle', world: 'USER_SCRIPT',
    source: 'user', createdAt: 1, updatedAt: 1, ...over,
  };
}

describe('运行态跟踪（预期注入语义）', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
  });

  it('computeRuntimeScriptIds：enabled + matchUrl 联合过滤', () => {
    const scripts = [
      mkScript({ id: 'a', matches: ['https://a.com/*'] }),
      mkScript({ id: 'b', enabled: false, matches: ['https://a.com/*'] }),
      mkScript({ id: 'c', matches: ['https://b.com/*'] }),
    ];
    expect(computeRuntimeScriptIds('https://a.com/x', scripts)).toEqual(['a']);
    expect(computeRuntimeScriptIds('chrome://extensions/', scripts)).toEqual([]);
    expect(computeRuntimeScriptIds('', scripts)).toEqual([]);
  });

  it('recomputeTab：运行集变化时广播 SCRIPTS_RUNTIME；不变不广播', async () => {
    await saveScript(mkScript());
    const spy = vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({});

    await recomputeTab(1, 'https://a.com/');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatchObject({
      type: 'SCRIPTS_RUNTIME',
      payload: { tabId: 1, url: 'https://a.com/', scriptIds: ['s1'] },
    });

    spy.mockClear();
    await recomputeTab(1, 'https://a.com/'); // 同 url 同集合 → 不广播
    expect(spy).not.toHaveBeenCalled();
    expect(getRuntimeSnapshot()).toEqual([{ tabId: 1, url: 'https://a.com/', scriptIds: ['s1'] }]);
  });

  it('recomputeAllTabs：按 tabs.query 全量重算', async () => {
    await saveScript(mkScript({ id: 's1', matches: ['https://a.com/*'] }));
    await saveScript(mkScript({ id: 's2', matches: ['https://b.com/*'] }));
    vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({});
    await fakeBrowser.tabs.create({ url: 'https://a.com/' });
    await fakeBrowser.tabs.create({ url: 'https://b.com/' });

    await recomputeAllTabs();
    const snap = getRuntimeSnapshot();
    expect(snap).toHaveLength(2);
    const urls = snap.map((e) => e.url).sort();
    expect(urls).toEqual(['https://a.com/', 'https://b.com/']);
  });

  it('dropTab 移除条目', async () => {
    vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({});
    await recomputeTab(7, 'https://a.com/');
    dropTab(7);
    expect(getRuntimeSnapshot()).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/background/scripts.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `background/scripts.ts`（运行态部分）**

```ts
// background/scripts.ts
// 脚本池编排层（spec §6）：CRUD（落库 + userScripts 注册同步原子完成）+ 运行态跟踪与广播。
// UI（sidepanel）与 AI 工具（agent/tools/script-pool.ts）都走本模块导出的 handler——单一数据源。
// confirmGate 拦截位：下阶段确认门控在本文件各写 handler 入口处统一拦截（pendingOps + 批准卡）。

import type { ScriptsRuntimeEntry } from '../shared/messages';
import type { UserScript } from '../shared/types';
import { listScripts } from '../storage/scripts';
import { matchUrl } from '../shared/match-pattern';

export const ENGINE_UNAVAILABLE_MSG = '脚本注入引擎不可用：请在 chrome://extensions 开启开发者模式或升级 Chrome 120+';

// ---------- 运行态跟踪（spec §6.2）----------
// 「运行中」= URL 匹配且启用的脚本（预期注入），非「实际执行成功」回执——脚本抛错仍显示运行中。
// SW 内存 map，重启丢失、下次导航/查询自重建（best-effort，与 observe-store 同哲学）。

const runtimeMap = new Map<number, ScriptsRuntimeEntry>();

export function computeRuntimeScriptIds(url: string, scripts: UserScript[]): string[] {
  if (!url) return [];
  return scripts.filter((s) => s.enabled && matchUrl(s.matches, url)).map((s) => s.id);
}

function sameEntry(a: ScriptsRuntimeEntry | undefined, b: ScriptsRuntimeEntry): boolean {
  return a != null && a.url === b.url && a.scriptIds.length === b.scriptIds.length
    && a.scriptIds.every((id, i) => id === b.scriptIds[i]);
}

function broadcastRuntime(entry: ScriptsRuntimeEntry): void {
  // 无接收方（sidepanel 未开）时 sendMessage 会 reject——fire-and-forget，吞掉即可
  void browser.runtime.sendMessage({ type: 'SCRIPTS_RUNTIME', payload: entry }).catch(() => {});
}

export async function recomputeTab(tabId: number, url: string): Promise<void> {
  const all = await listScripts();
  const entry: ScriptsRuntimeEntry = { tabId, url, scriptIds: computeRuntimeScriptIds(url, all) };
  if (sameEntry(runtimeMap.get(tabId), entry)) return;
  runtimeMap.set(tabId, entry);
  broadcastRuntime(entry);
}

export async function recomputeAllTabs(): Promise<void> {
  const tabs = await browser.tabs.query({});
  await Promise.all(
    tabs
      .filter((t) => t.id != null && t.url)
      .map((t) => recomputeTab(t.id!, t.url!)),
  );
}

export function dropTab(tabId: number): void {
  runtimeMap.delete(tabId);
}

export function getRuntimeSnapshot(): ScriptsRuntimeEntry[] {
  return [...runtimeMap.values()];
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/background/scripts.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add background/scripts.ts tests/background/scripts.test.ts
git commit -m "feat(scripts): 运行态跟踪（匹配计算 + 变化广播）"
```

---

### Task 6: CRUD 编排 + userScripts 注册同步 + 后台接线

**Files:**
- Modify: `background/scripts.ts`（追加编排部分）
- Modify: `entrypoints/background.ts`
- Modify: `wxt.config.ts`（permissions + `userScripts`）
- Test: `tests/background/scripts.test.ts`（追加）

**Interfaces:**
- Consumes: Task 3 storage、Task 2 `parseUserScript`、Task 1 `isValidMatchPattern`、Task 5 运行态原语。
- Produces（Task 7/9/10 依赖的精确形状）：
  - `engineAvailable(): boolean`
  - `validateScriptFields(fields): string[]`（返回中文错误列表，空数组 = 合法）
  - `handleCreate(input: ScriptInput): Promise<{ script: UserScript; warnings: string[] }>`
  - `handleUpdate(id, patch): Promise<UserScript>` / `handleDelete(id): Promise<void>` / `handleSetEnabled(id, enabled): Promise<UserScript>`
  - `handleImport(source, filename?): Promise<{ script: UserScript; warnings: string[] }>`
  - `syncRegistrations(): Promise<void>`
  - `initScriptsModule(router: MessageRouter): void`（挂 8 个消息 handler + tabs 监听 + 启动自愈）
  - 降级语义：`update/delete/setEnabled` 引擎不可用 → throw `ENGINE_UNAVAILABLE_MSG`；`create/import` 照常落库、warnings 带不可用说明（spec §6.1）

- [ ] **Step 1: 追加失败测试**

在 `tests/background/scripts.test.ts` 追加（文件顶部补 import）：

```ts
// 顶部补：
import {
  handleCreate, handleUpdate, handleDelete, handleSetEnabled, handleImport,
  syncRegistrations, initScriptsModule, ENGINE_UNAVAILABLE_MSG,
} from '../../background/scripts';
import { listScripts } from '../../storage/scripts';
import type { MessageRouter } from '../../background/router';

interface FakeUserScriptsApi {
  register: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  unregister: ReturnType<typeof vi.fn>;
  getScripts: ReturnType<typeof vi.fn>;
}

/** 往 fakeBrowser 挂 userScripts stub（WXT fakeBrowser 未内置该 API）。 */
function installFakeUserScripts(over: Partial<FakeUserScriptsApi> = {}): FakeUserScriptsApi {
  const api: FakeUserScriptsApi = {
    register: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
    unregister: vi.fn(async () => {}),
    getScripts: vi.fn(async () => [] as Array<Record<string, unknown>>),
    ...over,
  };
  (browser as unknown as Record<string, unknown>).userScripts = api;
  return api;
}

/** fakeBrowser.reset() 不一定清掉自定义属性——引擎不可用用例前显式移除，保证确定性。 */
function uninstallFakeUserScripts(): void {
  delete (browser as unknown as Record<string, unknown>).userScripts;
}

describe('CRUD 编排 + 注册同步', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    uninstallFakeUserScripts();
    vi.restoreAllMocks();
    vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({});
  });

  it('handleCreate：落库 + register（code/matches/runAt/world/persistAcrossSessions）', async () => {
    const api = installFakeUserScripts();
    const { script, warnings } = await handleCreate({ name: 'n', code: 'c();', matches: ['https://a.com/*'] });
    expect(warnings).toEqual([]);
    expect((await listScripts()).map((s) => s.id)).toEqual([script.id]);
    expect(api.register).toHaveBeenCalledTimes(1);
    expect(api.register.mock.calls[0][0]).toEqual([
      expect.objectContaining({
        id: script.id, matches: ['https://a.com/*'],
        js: [{ code: 'c();' }], runAt: 'document_idle', world: 'USER_SCRIPT', persistAcrossSessions: true,
      }),
    ]);
  });

  it('handleCreate：非法 pattern 拒绝并列出条目；空 matches 允许（导入场景）', async () => {
    installFakeUserScripts();
    await expect(handleCreate({ name: 'n', code: 'c', matches: ['https://bad'] })).rejects.toThrow('非法 match pattern');
    const { script } = await handleCreate({ name: 'n', code: 'c', matches: [] });
    expect(script.matches).toEqual([]);
  });

  it('handleCreate：引擎不可用 → 照常落库 + warnings 带固定文案', async () => {
    // beforeEach 已卸载 userScripts 属性 → 引擎不可用路径
    const { warnings } = await handleCreate({ name: 'n', code: 'c', matches: [] });
    expect(await listScripts()).toHaveLength(1);
    expect(warnings[0]).toContain(ENGINE_UNAVAILABLE_MSG);
  });

  it('handleUpdate：code 变更 → update 同步；disable → unregister', async () => {
    const api = installFakeUserScripts();
    const { script } = await handleCreate({ name: 'n', code: 'v1', matches: ['https://a.com/*'] });
    // 模拟「已按 v1 注册」状态（mock 不记录先前 register，需显式喂 getScripts）
    api.getScripts.mockResolvedValue([
      { id: script.id, matches: ['https://a.com/*'], js: [{ code: 'v1' }], runAt: 'document_idle', world: 'USER_SCRIPT' },
    ]);
    api.update.mockClear();
    await handleUpdate(script.id, { code: 'v2' });
    expect(api.update).toHaveBeenCalledTimes(1);
    expect(api.update.mock.calls[0][0]).toEqual([
      expect.objectContaining({ id: script.id, js: [{ code: 'v2' }] }),
    ]);
    await handleSetEnabled(script.id, false);
    expect(api.unregister).toHaveBeenCalledWith([script.id]);
  });

  it('handleDelete：删库 + unregister', async () => {
    const api = installFakeUserScripts();
    const { script } = await handleCreate({ name: 'n', code: 'c', matches: [] });
    await handleDelete(script.id);
    expect(await listScripts()).toEqual([]);
    expect(api.unregister).toHaveBeenCalledWith([script.id]);
  });

  it('update/delete/setEnabled 引擎不可用 → throw 固定文案', async () => {
    const { script } = await handleCreate({ name: 'n', code: 'c', matches: [] });
    await expect(handleUpdate(script.id, { name: 'x' })).rejects.toThrow(ENGINE_UNAVAILABLE_MSG);
    await expect(handleDelete(script.id)).rejects.toThrow(ENGINE_UNAVAILABLE_MSG);
    await expect(handleSetEnabled(script.id, false)).rejects.toThrow(ENGINE_UNAVAILABLE_MSG);
  });

  it('syncRegistrations：漂移自愈（库里已删的注销、code 漂移的更新）', async () => {
    const api = installFakeUserScripts();
    await handleCreate({ name: 'keep', code: 'c1', matches: ['https://a.com/*'], enabled: true });
    const all = await listScripts();
    // mock 不反映先前 register——直接喂「已注册」状态：keep（code 陈旧）+ ghost（库里已不存在）
    api.getScripts.mockResolvedValue([
      { id: all[0].id, matches: ['https://a.com/*'], js: [{ code: 'stale' }], runAt: 'document_idle', world: 'USER_SCRIPT' },
      { id: 'ghost', matches: ['<all_urls>'], js: [{ code: 'g' }], runAt: 'document_idle', world: 'USER_SCRIPT' },
    ]);
    api.update.mockClear();
    api.unregister.mockClear();
    await syncRegistrations();
    expect(api.update).toHaveBeenCalledTimes(1); // keep: code 漂移 → update
    expect(api.update.mock.calls[0][0]).toEqual([expect.objectContaining({ id: all[0].id, js: [{ code: 'c1' }] })]);
    expect(api.unregister).toHaveBeenCalledWith(['ghost']); // 库里已无 → 注销
  });

  it('handleImport：解析 TM 元数据 + enabled 默认 true + warnings 透传', async () => {
    installFakeUserScripts();
    const src = '// ==UserScript==\n// @name imp\n// @match https://i.com/*\n// @grant GM_log\n// ==/UserScript==\nlog();';
    const { script, warnings } = await handleImport(src, 'imp.user.js');
    expect(script).toMatchObject({ name: 'imp', enabled: true, source: 'import', matches: ['https://i.com/*'] });
    expect(warnings.some((w) => w.includes('GM_*'))).toBe(true);
  });

  it('initScriptsModule：挂 8 个 handler + tabs 监听 + 启动 sync', async () => {
    const api = installFakeUserScripts();
    const router = new MessageRouter();
    vi.spyOn(browser.tabs.onUpdated, 'addListener').mockImplementation(() => {});
    vi.spyOn(browser.tabs.onRemoved, 'addListener').mockImplementation(() => {});

    initScriptsModule(router);
    await vi.waitFor(() => expect(api.register).toHaveBeenCalled()); // 启动自愈 sync（异步链）

    // 8 个 handler 全部有注册（未注册类型才会报 no handler）
    for (const type of ['SCRIPTS_LIST', 'SCRIPTS_GET', 'SCRIPTS_CREATE', 'SCRIPTS_UPDATE', 'SCRIPTS_DELETE', 'SCRIPTS_SET_ENABLED', 'SCRIPTS_IMPORT', 'SCRIPTS_GET_RUNTIME']) {
      const r = await router.dispatch({ type } as { type: string });
      expect(r).not.toMatchObject({ error: expect.stringContaining('no handler') });
    }
  });

  it('initScriptsModule：SCRIPTS_LIST 返回 engineAvailable + 摘要；GET 未知 id 报错', async () => {
    installFakeUserScripts();
    await handleCreate({ name: 'n', code: 'c', matches: ['https://a.com/*'] });
    const router = new MessageRouter();
    vi.spyOn(browser.tabs.onUpdated, 'addListener').mockImplementation(() => {});
    vi.spyOn(browser.tabs.onRemoved, 'addListener').mockImplementation(() => {});
    initScriptsModule(router);

    const list = (await router.dispatch({ type: 'SCRIPTS_LIST' })) as { ok: boolean; data: { scripts: unknown[]; engineAvailable: boolean } };
    expect(list.ok).toBe(true);
    expect(list.data.scripts).toHaveLength(1);
    expect(list.data.scripts[0]).not.toHaveProperty('code');
    expect(list.data.engineAvailable).toBe(true);

    const get = await router.dispatch({ type: 'SCRIPTS_GET', id: 'nope' });
    expect(get).toMatchObject({ ok: false });
  });
});
```

> 注：`installFakeUserScripts` 直接往 `browser` 对象挂属性。若 `fakeBrowser.reset()` 会抹掉该属性（每次 beforeEach 重新 install 即可），测试间互不影响。若 WXT 版本的 fakeBrowser 对象不可扩展（极少数情况），改用 `Object.defineProperty(browser, 'userScripts', { value: api, configurable: true })`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/background/scripts.test.ts`
Expected: FAIL（`handleCreate` 等导出不存在）

- [ ] **Step 3: 实现（`background/scripts.ts` 追加 + 接线）**

`background/scripts.ts` 顶部 import 补齐：

```ts
import type { MessageRouter } from './router';
import type { ScriptInput, ScriptPatch, ScriptsRuntimeEntry } from '../shared/messages';
import type { ScriptRunAt, ScriptWorld, UserScript } from '../shared/types';
import { deleteScript, getScript, listScripts, saveScript, toSummary, MAX_CODE_LENGTH } from '../storage/scripts';
import { isValidMatchPattern } from '../shared/match-pattern';
import { parseUserScript } from '../shared/userscript-meta';
```

文件末尾追加（`// ---------- 运行态跟踪` 段之后；`runtimeMap` 定义保持在本文件）：

```ts
// ---------- userScripts API 薄封装（Chrome 120+；Firefox 形状不同，本阶段 Chrome-only）----------

interface RegisterUserScript {
  id: string;
  matches: string[];
  js: Array<{ code: string }>;
  runAt: ScriptRunAt;
  world: ScriptWorld;
  persistAcrossSessions?: boolean;
}

interface UserScriptsApi {
  register(scripts: RegisterUserScript[]): Promise<void>;
  update(scripts: RegisterUserScript[]): Promise<void>;
  unregister(ids?: string[]): Promise<void>;
  getScripts(): Promise<RegisterUserScript[]>;
}

function userScripts(): UserScriptsApi | undefined {
  return (browser as unknown as { userScripts?: UserScriptsApi }).userScripts;
}

export function engineAvailable(): boolean {
  return userScripts() != null;
}

async function requireEngine(): Promise<UserScriptsApi> {
  const api = userScripts();
  if (!api) throw new Error(ENGINE_UNAVAILABLE_MSG);
  return api;
}

// ---------- 校验（spec §6.1：非法 pattern 拒绝并列出条目；编排层允许空 matches）----------

const RUN_ATS: ScriptRunAt[] = ['document_start', 'document_end', 'document_idle'];
const WORLDS: ScriptWorld[] = ['USER_SCRIPT', 'MAIN'];

export function validateScriptFields(fields: {
  name?: string; code?: string; matches?: string[]; runAt?: unknown; world?: unknown;
}): string[] {
  const errors: string[] = [];
  if (fields.name !== undefined && !fields.name.trim()) errors.push('name 不能为空');
  if (fields.code !== undefined) {
    if (!fields.code.trim()) errors.push('code 不能为空');
    else if (fields.code.length > MAX_CODE_LENGTH) errors.push(`code 超过上限（${MAX_CODE_LENGTH} 字符）`);
  }
  if (fields.matches !== undefined) {
    const bad = fields.matches.filter((p) => !isValidMatchPattern(p));
    if (bad.length > 0) errors.push(`非法 match pattern：${bad.join('、')}`);
  }
  if (fields.runAt !== undefined && !RUN_ATS.includes(fields.runAt as ScriptRunAt)) {
    errors.push(`非法 runAt：${String(fields.runAt)}`);
  }
  if (fields.world !== undefined && !WORLDS.includes(fields.world as ScriptWorld)) {
    errors.push(`非法 world：${String(fields.world)}`);
  }
  return errors;
}

// ---------- 注册同步（spec §6.1：期望注册集 vs getScripts diff）----------

function toRegisterDetails(s: UserScript): RegisterUserScript {
  return {
    id: s.id,
    matches: s.matches,
    js: [{ code: s.code }],
    runAt: s.runAt,
    world: s.world,
    persistAcrossSessions: true,
  };
}

function sameRegistration(r: RegisterUserScript, s: UserScript): boolean {
  return r.runAt === s.runAt && r.world === s.world
    && JSON.stringify(r.matches) === JSON.stringify(s.matches)
    && r.js?.[0]?.code === s.code;
}

export async function syncRegistrations(): Promise<void> {
  const api = await requireEngine();
  const all = await listScripts();
  // 空 matches 的脚本永不注册（无匹配规则 = 不运行，spec §5.1）
  const desired = all.filter((s) => s.enabled && s.matches.length > 0);
  const desiredIds = new Set(desired.map((s) => s.id));

  let registered: RegisterUserScript[] = [];
  try {
    registered = await api.getScripts();
  } catch {
    registered = []; // getScripts 漂移异常时按空处理 → 全量重注册自愈
  }
  const registeredMap = new Map(registered.map((r) => [r.id, r]));

  const missing = desired.filter((s) => !registeredMap.has(s.id));
  if (missing.length > 0) await api.register(missing.map(toRegisterDetails));

  const stale = registered.filter((r) => !desiredIds.has(r.id)).map((r) => r.id);
  if (stale.length > 0) await api.unregister(stale);

  const drifted = desired.filter((s) => {
    const r = registeredMap.get(s.id);
    return r != null && !sameRegistration(r, s);
  });
  for (const s of drifted) {
    try {
      await api.update([toRegisterDetails(s)]);
    } catch {
      // update 打在未注册 id 上（极端漂移）→ 降级为先注销再注册
      await api.unregister([s.id]);
      await api.register([toRegisterDetails(s)]);
    }
  }
}

/** 写库后的注册同步：引擎可用 → sync；不可用/失败 → 不抛错，返回给调用方展示的 warnings。 */
async function syncBestEffort(): Promise<string[]> {
  if (!engineAvailable()) return [`${ENGINE_UNAVAILABLE_MSG}（脚本已保存，但未注册运行）`];
  try {
    await syncRegistrations();
    return [];
  } catch (e) {
    return [`已保存但注册失败：${e instanceof Error ? e.message : String(e)}`];
  }
}

function newId(): string {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `s-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// ---------- CRUD 编排（UI 与 AI 工具共用；confirmGate 拦截位见文件头注释）----------

export async function handleCreate(input: ScriptInput): Promise<{ script: UserScript; warnings: string[] }> {
  const errors = validateScriptFields(input);
  if (errors.length > 0) throw new Error(errors.join('；'));
  const ts = Date.now();
  const script: UserScript = {
    id: newId(),
    name: input.name.trim(),
    enabled: input.enabled ?? true,
    matches: input.matches,
    code: input.code,
    runAt: input.runAt ?? 'document_idle',
    world: input.world ?? 'USER_SCRIPT',
    source: input.source ?? 'user',
    createdAt: ts,
    updatedAt: ts,
  };
  await saveScript(script);
  const warnings = await syncBestEffort();
  await recomputeAllTabs().catch(() => {});
  return { script, warnings };
}

export async function handleUpdate(id: string, patch: ScriptPatch): Promise<UserScript> {
  await requireEngine(); // spec §6.1：改注册类操作引擎不可用直接报固定文案
  const existing = await getScript(id);
  if (!existing) throw new Error(`脚本不存在：${id}`);
  const errors = validateScriptFields(patch);
  if (errors.length > 0) throw new Error(errors.join('；'));
  const next: UserScript = { ...existing, ...patch, updatedAt: Date.now() };
  await saveScript(next);
  await syncRegistrations();
  await recomputeAllTabs().catch(() => {});
  return next;
}

export async function handleDelete(id: string): Promise<void> {
  await requireEngine();
  await deleteScript(id);
  await syncRegistrations();
  await recomputeAllTabs().catch(() => {});
}

export async function handleSetEnabled(id: string, enabled: boolean): Promise<UserScript> {
  await requireEngine();
  const existing = await getScript(id);
  if (!existing) throw new Error(`脚本不存在：${id}`);
  const next: UserScript = { ...existing, enabled, updatedAt: Date.now() };
  await saveScript(next);
  await syncRegistrations();
  await recomputeAllTabs().catch(() => {});
  return next;
}

export async function handleImport(source: string, filename?: string): Promise<{ script: UserScript; warnings: string[] }> {
  const parsed = parseUserScript(source, filename);
  const errors = validateScriptFields({ name: parsed.fields.name, code: parsed.fields.code, matches: parsed.fields.matches });
  if (errors.length > 0) throw new Error(errors.join('；'));
  const ts = Date.now();
  const script: UserScript = {
    id: newId(),
    name: parsed.fields.name,
    enabled: true,
    matches: parsed.fields.matches,
    code: parsed.fields.code,
    runAt: parsed.fields.runAt,
    world: 'USER_SCRIPT',
    source: 'import',
    meta: Object.keys(parsed.fields.meta).length > 0 ? parsed.fields.meta : undefined,
    createdAt: ts,
    updatedAt: ts,
  };
  await saveScript(script);
  const warnings = [...parsed.warnings, ...(await syncBestEffort())];
  await recomputeAllTabs().catch(() => {});
  return { script, warnings };
}

// ---------- 消息接线（spec §7）：8 个 handler + tabs 监听 + 启动自愈 ----------

export function initScriptsModule(router: MessageRouter): void {
  router.on('SCRIPTS_LIST', async () => ({
    ok: true,
    data: { scripts: (await listScripts()).map(toSummary), engineAvailable: engineAvailable() },
  }));

  router.on('SCRIPTS_GET', async (msg) => {
    const id = (msg as { id: string }).id;
    const script = await getScript(id);
    if (!script) return { ok: false, error: `脚本不存在：${id}` };
    return { ok: true, data: { script } };
  });

  router.on('SCRIPTS_CREATE', async (msg) => {
    const { script, warnings } = await handleCreate((msg as { input: ScriptInput }).input);
    return { ok: true, data: { script, warnings } };
  });

  router.on('SCRIPTS_UPDATE', async (msg) => {
    const { id, patch } = msg as unknown as { id: string; patch: ScriptPatch };
    return { ok: true, data: { script: await handleUpdate(id, patch) } };
  });

  router.on('SCRIPTS_DELETE', async (msg) => {
    await handleDelete((msg as { id: string }).id);
    return { ok: true };
  });

  router.on('SCRIPTS_SET_ENABLED', async (msg) => {
    const { id, enabled } = msg as unknown as { id: string; enabled: boolean };
    return { ok: true, data: { script: await handleSetEnabled(id, enabled) } };
  });

  router.on('SCRIPTS_IMPORT', async (msg) => {
    const { source, filename } = msg as unknown as { source: string; filename?: string };
    const { script, warnings } = await handleImport(source, filename);
    return { ok: true, data: { script, warnings } };
  });

  router.on('SCRIPTS_GET_RUNTIME', async () => ({ ok: true, data: { entries: getRuntimeSnapshot() } }));

  // 运行态跟踪：url 变化或加载完成时重算该 tab；关闭时清理
  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url || changeInfo.status === 'complete') {
      void recomputeTab(tabId, tab.url ?? '');
    }
  });
  browser.tabs.onRemoved.addListener((tabId) => dropTab(tabId));

  // 启动自愈：persistAcrossSessions 理论自持久，扩展更新/注册漂移时对齐；
  // 引擎不可用时静默（UI 靠 SCRIPTS_LIST.engineAvailable 显示警示条）。
  void syncRegistrations().catch(() => {});
  void recomputeAllTabs().catch(() => {});
}
```

`entrypoints/background.ts` 修改（import 区加一行；`router.attach()` 前挂模块）：

```ts
import { initScriptsModule } from '../background/scripts';
```

```ts
  attachAgentPort();
  initScriptsModule(router);
  router.attach();
```

`wxt.config.ts` 的 permissions 改为：

```ts
    permissions: ['tabs', 'scripting', 'storage', 'sidePanel', 'webRequest', 'userScripts'],
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/background/scripts.test.ts`
Expected: PASS（含 Task 5 的运行态用例）

- [ ] **Step 5: 类型检查 + 提交**

Run: `npm run compile`
Expected: 无错误

```bash
git add background/scripts.ts entrypoints/background.ts wxt.config.ts tests/background/scripts.test.ts
git commit -m "feat(scripts): CRUD 编排 + userScripts 注册同步 + 后台接线（+userScripts 权限）"
```

---

### Task 7: AI 六工具（schemas + 执行器 + registry 分发）

**Files:**
- Modify: `agent/tools/schemas.ts`（追加 6 个 schema）
- Create: `agent/tools/script-pool.ts`
- Modify: `agent/tools/registry.ts`（+6 分发，豁免受限页预检）
- Test: `tests/agent/tools/script-pool.test.ts`、Modify: `tests/agent/tools/schemas.test.ts`

**Interfaces:**
- Consumes: Task 6 的 `handleCreate/handleUpdate/handleDelete/handleSetEnabled`、Task 3 的 `listScripts/toSummary`。
- Produces:
  - `doListScripts(args: { enabled?: boolean; urlContains?: string }): Promise<ToolResult>`
  - `doGetScript(args: { id: string }): Promise<ToolResult>`
  - `doCreateScript(args: ScriptInput): Promise<ToolResult>`（强制 `source: 'agent'`；matches 必须非空——工具层约束，spec §8）
  - `doUpdateScript(args: { id: string; patch: ScriptPatch }): Promise<ToolResult>`
  - `doDeleteScript(args: { id: string }): Promise<ToolResult>`
  - `doToggleScript(args: { id: string; enabled: boolean }): Promise<ToolResult>`

- [ ] **Step 1: 更新 schema 测试（16 → 22）**

`tests/agent/tools/schemas.test.ts` 第一个用例替换为：

```ts
  it('恰好 22 个工具（Phase 2 的 9 + Phase 3a 的 7 + Phase 4 的 6）', () => {
    const names = TOOL_SCHEMAS.map((s) => s.function.name).sort();
    expect(names).toEqual([
      'click', 'close_page', 'create_script', 'delete_script', 'evaluate_script', 'fill',
      'fill_form', 'get_script', 'hover', 'http_request', 'list_pages', 'list_scripts',
      'navigate_page', 'new_page', 'press_key', 'scroll', 'select_page',
      'take_screenshot', 'take_snapshot', 'toggle_script', 'update_script', 'wait_for',
    ]);
    // Phase 3b 落地后此处 +3（list_console_messages / list_network_requests / get_network_request → 25）
  });

  it('create_script：name/code/matches 必填，runAt/world 枚举', () => {
    const t = TOOL_SCHEMAS.find((s) => s.function.name === 'create_script')!;
    const p = t.function.parameters as { properties: Record<string, { enum?: string[] }>; required: string[] };
    expect(p.required).toEqual(expect.arrayContaining(['name', 'code', 'matches']));
    expect(p.properties.runAt!.enum).toEqual(['document_start', 'document_end', 'document_idle']);
    expect(p.properties.world!.enum).toEqual(['USER_SCRIPT', 'MAIN']);
  });

  it('toggle_script：id/enabled 必填', () => {
    const t = TOOL_SCHEMAS.find((s) => s.function.name === 'toggle_script')!;
    const p = t.function.parameters as { required: string[] };
    expect(p.required).toEqual(['id', 'enabled']);
  });
```

- [ ] **Step 2: 写执行器失败测试**

创建 `tests/agent/tools/script-pool.test.ts`：

```ts
// tests/agent/tools/script-pool.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  doListScripts, doGetScript, doCreateScript, doUpdateScript, doDeleteScript, doToggleScript,
} from '../../../agent/tools/script-pool';
import { listScripts } from '../../../storage/scripts';

function installFakeUserScripts(): void {
  (browser as unknown as Record<string, unknown>).userScripts = {
    register: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
    unregister: vi.fn(async () => {}),
    getScripts: vi.fn(async () => []),
  };
}

describe('script-pool 工具执行器', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
    vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({});
  });

  it('create_script：成功注册 + source 强制 agent；matches 为空报错', async () => {
    installFakeUserScripts();
    const ok = await doCreateScript({ name: 'n', code: 'c;', matches: ['https://a.com/*'] });
    expect(ok.ok).toBe(true);
    const saved = (await listScripts())[0];
    expect(saved.source).toBe('agent');

    const empty = await doCreateScript({ name: 'n', code: 'c;', matches: [] });
    expect(empty).toMatchObject({ ok: false });
    expect((empty as { error: string }).error).toContain('matches');
  });

  it('list_scripts：摘要无 code；enabled/urlContains 过滤', async () => {
    installFakeUserScripts();
    await doCreateScript({ name: 'alpha', code: 'c;', matches: ['https://a.com/*'] });
    await doCreateScript({ name: 'beta', code: 'c;', matches: ['https://b.com/*'], enabled: false });

    const all = await doListScripts({});
    expect(all.ok).toBe(true);
    const scripts = (all as { data: { scripts: Array<Record<string, unknown>> } }).data.scripts;
    expect(scripts).toHaveLength(2);
    for (const s of scripts) expect(s).not.toHaveProperty('code');

    expect(((await doListScripts({ enabled: true })) as { data: { scripts: unknown[] } }).data.scripts).toHaveLength(1);
    const filtered = (await doListScripts({ urlContains: 'b.com' })) as { data: { scripts: Array<{ name: string }> } };
    expect(filtered.data.scripts.map((s) => s.name)).toEqual(['beta']);
  });

  it('get_script：全文含 code；未知 id 报错', async () => {
    installFakeUserScripts();
    const { data } = (await doCreateScript({ name: 'n', code: 'CODE;', matches: ['https://a.com/*'] })) as { data: { script: { id: string } } };
    const got = await doGetScript({ id: data.script.id });
    expect((got as { data: { script: { code: string } } }).data.script.code).toBe('CODE;');
    expect(await doGetScript({ id: 'nope' })).toMatchObject({ ok: false });
  });

  it('update/toggle/delete 全链路', async () => {
    installFakeUserScripts();
    const { data } = (await doCreateScript({ name: 'n', code: 'c;', matches: ['https://a.com/*'] })) as { data: { script: { id: string } } };
    expect((await doUpdateScript({ id: data.script.id, patch: { code: 'v2' } })).ok).toBe(true);
    expect((await doToggleScript({ id: data.script.id, enabled: false })).ok).toBe(true);
    expect((await listScripts())[0].enabled).toBe(false);
    expect((await doDeleteScript({ id: data.script.id })).ok).toBe(true);
    expect(await listScripts()).toEqual([]);
  });

  it('registry 分发：脚本工具豁免受限页预检（chrome:// 页上照常可用）', async () => {
    installFakeUserScripts();
    const tab = await fakeBrowser.tabs.create({ url: 'chrome://extensions/' });
    const { executeTool } = await import('../../../agent/tools/registry');
    const r = await executeTool('list_scripts', {}, { tabId: tab.id!, sessionId: 'test', signal: new AbortController().signal });
    expect(r.ok).toBe(true);
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run tests/agent/tools/script-pool.test.ts tests/agent/tools/schemas.test.ts`
Expected: FAIL（模块/工具不存在）

- [ ] **Step 4: 实现 schema（`agent/tools/schemas.ts` 末尾追加）**

```ts
  // ---- Phase 4：脚本池（19→22 见 schemas.test 注释；与 UI 共用 background/scripts 编排层）----
  {
    type: 'function',
    function: {
      name: 'list_scripts',
      description:
        '列出脚本库中的用户脚本摘要（不含代码体）。enabled 按启用状态过滤；urlContains 按匹配模式子串过滤（大小写不敏感）。需要完整代码时用 get_script。',
      parameters: obj({
        enabled: { type: 'boolean', description: '按启用状态过滤' },
        urlContains: { type: 'string', description: '匹配模式包含该子串（大小写不敏感）' },
      }),
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_script',
      description: '读取单个用户脚本的完整定义（含代码体）。id 来自 list_scripts。',
      parameters: obj({ id: { type: 'string', description: '脚本 id' } }, ['id']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_script',
      description:
        '创建用户脚本：以浏览器用户脚本权限在 matches 匹配的页面上自动运行。创建前先向用户说明脚本用途与作用范围。代码以页面脚本方式原样执行，无 GM_* API。matches 必填（match pattern，如 https://example.com/*），明确作用域。',
      parameters: obj(
        {
          name: { type: 'string', description: '脚本名' },
          code: { type: 'string', description: '完整 JS 代码体（无 ==UserScript== 元数据头）' },
          matches: { type: 'array', items: { type: 'string' }, description: 'match pattern 列表' },
          runAt: {
            type: 'string',
            enum: ['document_start', 'document_end', 'document_idle'],
            description: '运行时机，默认 document_idle',
          },
          world: {
            type: 'string',
            enum: ['USER_SCRIPT', 'MAIN'],
            description: '执行世界：USER_SCRIPT 隔离世界（默认）；MAIN 可访问页面变量',
          },
          enabled: { type: 'boolean', description: '创建后是否立即启用，默认 true' },
        },
        ['name', 'code', 'matches'],
      ),
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_script',
      description: '更新用户脚本的部分字段。代码/规则更新在下次页面导航后生效。',
      parameters: obj(
        {
          id: { type: 'string', description: '脚本 id' },
          patch: {
            type: 'object',
            description: '要更新的字段（至少一项）',
            properties: {
              name: { type: 'string' },
              code: { type: 'string' },
              matches: { type: 'array', items: { type: 'string' } },
              runAt: { type: 'string', enum: ['document_start', 'document_end', 'document_idle'] },
              world: { type: 'string', enum: ['USER_SCRIPT', 'MAIN'] },
              enabled: { type: 'boolean' },
            },
          },
        },
        ['id', 'patch'],
      ),
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_script',
      description: '删除用户脚本（不可恢复）。',
      parameters: obj({ id: { type: 'string', description: '脚本 id' } }, ['id']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'toggle_script',
      description: '启用或禁用用户脚本。禁用后匹配页面不再注入，刷新页面生效。',
      parameters: obj(
        {
          id: { type: 'string', description: '脚本 id' },
          enabled: { type: 'boolean', description: 'true 启用 / false 禁用' },
        },
        ['id', 'enabled'],
      ),
    },
  },
```

- [ ] **Step 5: 实现执行器（`agent/tools/script-pool.ts`）**

```ts
// agent/tools/script-pool.ts
// 脚本池六工具执行器（spec §8）。与 UI 共用 background/scripts 编排层——AI 改脚本 = 用户改脚本，行为零分叉。
// 全部豁免受限页预检（registry 在 RESTRICTED 检查之前分发）：不碰页面内容，纯 storage/注册操作。

import type { ToolResult } from '../../shared/types';
import type { ScriptInput, ScriptPatch } from '../../shared/messages';
import { getScript, listScripts, toSummary } from '../../storage/scripts';
import {
  handleCreate, handleDelete, handleSetEnabled, handleUpdate,
} from '../../background/scripts';

const err = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function doListScripts(args: { enabled?: boolean; urlContains?: string }): Promise<ToolResult> {
  try {
    let scripts = (await listScripts()).map(toSummary);
    if (args.enabled !== undefined) scripts = scripts.filter((s) => s.enabled === args.enabled);
    if (args.urlContains) {
      const needle = args.urlContains.toLowerCase();
      scripts = scripts.filter((s) => s.matches.some((m) => m.toLowerCase().includes(needle)));
    }
    return { ok: true, data: { scripts } };
  } catch (e) {
    return { ok: false, error: `list_scripts 失败：${err(e)}` };
  }
}

export async function doGetScript(args: { id: string }): Promise<ToolResult> {
  try {
    const script = await getScript(args.id);
    if (!script) return { ok: false, error: `脚本不存在：${args.id}` };
    return { ok: true, data: { script } };
  } catch (e) {
    return { ok: false, error: `get_script 失败：${err(e)}` };
  }
}

export async function doCreateScript(args: ScriptInput): Promise<ToolResult> {
  try {
    // matches 必填非空是工具层约束（spec §8）；编排层允许空 matches（导入场景）
    if (!Array.isArray(args.matches) || args.matches.length === 0) {
      return { ok: false, error: 'create_script 需要至少一条 matches 规则（脚本要有明确作用域）' };
    }
    const { script, warnings } = await handleCreate({ ...args, source: 'agent' });
    return { ok: true, data: { script, warnings } };
  } catch (e) {
    return { ok: false, error: `create_script 失败：${err(e)}` };
  }
}

export async function doUpdateScript(args: { id: string; patch: ScriptPatch }): Promise<ToolResult> {
  try {
    return { ok: true, data: { script: await handleUpdate(args.id, args.patch) } };
  } catch (e) {
    return { ok: false, error: `update_script 失败：${err(e)}` };
  }
}

export async function doDeleteScript(args: { id: string }): Promise<ToolResult> {
  try {
    await handleDelete(args.id);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `delete_script 失败：${err(e)}` };
  }
}

export async function doToggleScript(args: { id: string; enabled: boolean }): Promise<ToolResult> {
  try {
    return { ok: true, data: { script: await handleSetEnabled(args.id, args.enabled) } };
  } catch (e) {
    return { ok: false, error: `toggle_script 失败：${err(e)}` };
  }
}
```

- [ ] **Step 6: registry 分发（`agent/tools/registry.ts`）**

import 区补：

```ts
import {
  doListScripts, doGetScript, doCreateScript, doUpdateScript, doDeleteScript, doToggleScript,
} from './script-pool';
import type { ScriptInput, ScriptPatch } from '../../shared/messages';
```

在 `if (name === 'select_page') return doSelectPage(args as { tabId: number });` 之后、`// ---- 以下工具操作当前目标页，需受限页预检 ----` 之前插入：

```ts
  // 脚本池六工具：纯 storage/注册操作，不碰页面内容，豁免受限页预检（spec §8）。
  if (name === 'list_scripts') return doListScripts(args as { enabled?: boolean; urlContains?: string });
  if (name === 'get_script') return doGetScript(args as { id: string });
  if (name === 'create_script') return doCreateScript(args as ScriptInput);
  if (name === 'update_script') return doUpdateScript(args as { id: string; patch: ScriptPatch });
  if (name === 'delete_script') return doDeleteScript(args as { id: string });
  if (name === 'toggle_script') return doToggleScript(args as { id: string; enabled: boolean });
```

- [ ] **Step 7: 跑测试确认通过**

Run: `npx vitest run tests/agent/tools/ tests/background/scripts.test.ts`
Expected: PASS

- [ ] **Step 8: 类型检查 + 提交**

Run: `npm run compile`
Expected: 无错误

```bash
git add agent/tools/schemas.ts agent/tools/script-pool.ts agent/tools/registry.ts tests/agent/tools/script-pool.test.ts tests/agent/tools/schemas.test.ts
git commit -m "feat(tools): 脚本池 AI 六工具（list/get/create/update/delete/toggle，16→22）"
```

---

### Task 8: 前端 store（scripts）+ ui.store 详情态

**Files:**
- Create: `stores/scripts.ts`
- Modify: `stores/ui.ts`（+`scriptId`/`openScript`）
- Test: `tests/stores/scripts.test.ts`

**Interfaces:**
- Consumes: Task 4 `ScriptsRequest`/`ScriptsRuntimeEvent`/`ScriptSummary`。
- Produces（Task 9/10 依赖）：
  - `useScripts`（zustand）：`{ summaries, runtimeEntries, activeTabId, query, loading, engineWarning }` + `setQuery/setActiveTab/applyRuntimeEvent/refresh/setEngineWarning`
  - `filterSummaries(summaries: ScriptSummary[], query: string): ScriptSummary[]`（纯函数）
  - `sendScriptsRequest<T>(req: ScriptsRequest): Promise<T>`（`browser.runtime.sendMessage` 封装）
  - `stores/ui.ts`：`scriptId: string | null`、`openScript(id: string | null): void`

- [ ] **Step 1: 写失败测试**

创建 `tests/stores/scripts.test.ts`：

```ts
// tests/stores/scripts.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { useScripts, filterSummaries } from '../../stores/scripts';
import type { ScriptSummary } from '../../shared/types';

function mkSummary(over: Partial<ScriptSummary> = {}): ScriptSummary {
  return {
    id: 's1', name: '去广告', matches: ['https://a.com/*'], enabled: true,
    source: 'user', runAt: 'document_idle', world: 'USER_SCRIPT',
    updatedAt: 1, hasGrants: false, ...over,
  };
}

describe('filterSummaries', () => {
  const list = [
    mkSummary({ id: '1', name: '去广告助手', matches: ['https://a.com/*'] }),
    mkSummary({ id: '2', name: '自动展开', matches: ['https://forum.example.com/*'] }),
    mkSummary({ id: '3', name: '下载器', matches: ['https://dl.io/*'], source: 'import' as const }),
  ];
  it('空查询原样返回', () => expect(filterSummaries(list, '')).toHaveLength(3));
  it('按 name 子串（大小写不敏感）', () => {
    expect(filterSummaries(list, '广告').map((s) => s.id)).toEqual(['1']);
  });
  it('按 matches 子串', () => {
    expect(filterSummaries(list, 'FORUM').map((s) => s.id)).toEqual(['2']);
  });
});

describe('scripts store', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
    useScripts.setState({ summaries: [], runtimeEntries: {}, activeTabId: null, query: '', loading: false, engineWarning: null });
  });

  it('applyRuntimeEvent：按 tabId 落 runtimeEntries；activeTabId 过滤后可取到当前页运行集', () => {
    useScripts.getState().setActiveTab(1);
    useScripts.getState().applyRuntimeEvent({ type: 'SCRIPTS_RUNTIME', payload: { tabId: 1, url: 'https://a.com/', scriptIds: ['s1'] } });
    useScripts.getState().applyRuntimeEvent({ type: 'SCRIPTS_RUNTIME', payload: { tabId: 2, url: 'https://b.com/', scriptIds: [] } });
    expect(useScripts.getState().runtimeEntries[1]).toMatchObject({ scriptIds: ['s1'] });
    const s = useScripts.getState();
    expect(s.runtimeEntries[s.activeTabId ?? -1]?.scriptIds).toEqual(['s1']);
  });

  it('refresh：LIST + GET_RUNTIME + activeTabId 一次拉齐（fake onMessage 应答）', async () => {
    let activeId: number | undefined;
    await fakeBrowser.tabs.create({ url: 'https://a.com/', active: true }).then((t) => { activeId = t.id; });
    browser.runtime.onMessage.addListener((msg: { type: string }) => {
      if (msg.type === 'SCRIPTS_LIST') {
        return { ok: true, data: { scripts: [mkSummary()], engineAvailable: true } };
      }
      if (msg.type === 'SCRIPTS_GET_RUNTIME') {
        return { ok: true, data: { entries: [{ tabId: activeId, url: 'https://a.com/', scriptIds: ['s1'] }] } };
      }
      return { ok: false, error: 'unexpected' };
    });

    await useScripts.getState().refresh();
    const s = useScripts.getState();
    expect(s.summaries).toHaveLength(1);
    expect(s.activeTabId).toBe(activeId);
    expect(s.runtimeEntries[activeId!]?.scriptIds).toEqual(['s1']);
    expect(s.engineWarning).toBeNull();
  });

  it('refresh：LIST 失败（引擎不可用 flag）→ engineWarning 置位', async () => {
    browser.runtime.onMessage.addListener((msg: { type: string }) => {
      if (msg.type === 'SCRIPTS_LIST') {
        return { ok: true, data: { scripts: [], engineAvailable: false } };
      }
      return { ok: true, data: { entries: [] } };
    });
    await useScripts.getState().refresh();
    expect(useScripts.getState().engineWarning).toContain('不可用');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/stores/scripts.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `stores/scripts.ts`**

```ts
// stores/scripts.ts
// 脚本池前端状态（spec §7）：summaries + per-tab 运行态 + 搜索过滤。
// 运行区 = runtimeEntries[activeTabId]（组件侧取值）；广播按 tabId 全落，取值时按 activeTabId 过滤。

import { create } from 'zustand';
import type { ScriptsRequest, ScriptsRuntimeEntry, ScriptsListData } from '../shared/messages';
import type { ScriptSummary } from '../shared/types';

export async function sendScriptsRequest<T = unknown>(req: ScriptsRequest): Promise<T> {
  return (await browser.runtime.sendMessage(req)) as T;
}

/** 列表搜索：name/description/matches 大小写不敏感子串（纯函数，spec §9.1） */
export function filterSummaries(summaries: ScriptSummary[], query: string): ScriptSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return summaries;
  return summaries.filter(
    (s) =>
      s.name.toLowerCase().includes(q) ||
      (s.description ?? '').toLowerCase().includes(q) ||
      s.matches.some((m) => m.toLowerCase().includes(q)),
  );
}

interface ScriptsState {
  summaries: ScriptSummary[];
  runtimeEntries: Record<number, ScriptsRuntimeEntry>;
  activeTabId: number | null;
  query: string;
  loading: boolean;
  /** 引擎不可用文案（null = 可用） */
  engineWarning: string | null;
  setQuery: (q: string) => void;
  setActiveTab: (id: number | null) => void;
  applyRuntimeEvent: (e: ScriptsRuntimeEvent) => void;
  setEngineWarning: (w: string | null) => void;
  refresh: () => Promise<void>;
}

const ENGINE_WARNING_PREFIX = '脚本注入引擎不可用';

export const useScripts = create<ScriptsState>((set) => ({
  summaries: [],
  runtimeEntries: {},
  activeTabId: null,
  query: '',
  loading: false,
  engineWarning: null,

  setQuery: (query) => set({ query }),
  setActiveTab: (activeTabId) => set({ activeTabId }),

  applyRuntimeEvent: (e) =>
    set((s) => ({ runtimeEntries: { ...s.runtimeEntries, [e.payload.tabId]: e.payload } })),

  setEngineWarning: (engineWarning) => set({ engineWarning }),

  refresh: async () => {
    set({ loading: true });
    try {
      // 侧边栏里 currentWindow 有时取不到；退化到 lastFocusedWindow（对齐 ChatView 惯例）
      let [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tab) [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
      const listResp = await sendScriptsRequest<{ ok: boolean; data?: ScriptsListData }>({ type: 'SCRIPTS_LIST' });
      const rtResp = await sendScriptsRequest<{ ok: boolean; data?: { entries: ScriptsRuntimeEntry[] } }>({ type: 'SCRIPTS_GET_RUNTIME' });
      const entries = rtResp.data?.entries ?? [];
      set({
        summaries: listResp.data?.scripts ?? [],
        runtimeEntries: Object.fromEntries(entries.map((e) => [e.tabId, e])),
        activeTabId: tab?.id ?? null,
        engineWarning: listResp.data?.engineAvailable === false ? `${ENGINE_WARNING_PREFIX}：请在 chrome://extensions 开启开发者模式或升级 Chrome 120+` : null,
        loading: false,
      });
    } catch {
      set({ loading: false });
    }
  },
}));
```

`stores/ui.ts` 整体替换为：

```ts
// stores/ui.ts
import { create } from 'zustand';

export type Page = 'chat' | 'scripts' | 'debug' | 'settings';

interface UiState {
  page: Page;
  setPage: (p: Page) => void;
  /** 脚本详情态：非空 = ScriptsView 内路由到详情页 */
  scriptId: string | null;
  openScript: (id: string | null) => void;
}

export const useUi = create<UiState>((set) => ({
  page: 'chat',
  setPage: (page) => set({ page }),
  scriptId: null,
  openScript: (scriptId) => set({ scriptId }),
}));
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/stores/`
Expected: PASS（含既有 chat store 测试）

- [ ] **Step 5: 提交**

```bash
git add stores/scripts.ts stores/ui.ts tests/stores/scripts.test.ts
git commit -m "feat(scripts): 前端 store（运行态/过滤/refresh）+ ui 详情态"
```

### Task 9: ScriptsListView（列表页）+ 样式

**Files:**
- Create: `components/scripts/ScriptsListView.tsx`
- Modify: `entrypoints/sidepanel/styles.css`（文件末尾追加 `scripts-` 前缀类）

**Interfaces:**
- Consumes: Task 8 `useScripts`/`filterSummaries`/`sendScriptsRequest`、Task 4 `ScriptInput`、`PageShell`/`Button`/`Input` 组件、`stores/ui` 的 `openScript`。
- Produces: `ScriptsListView`（无 props）。操作语义：新建 = `SCRIPTS_CREATE`（name「未命名脚本」、code 空注释、matches 空）→ `openScript(id)`；导入 = file input 读文本 → `SCRIPTS_IMPORT`；启停 = `SCRIPTS_SET_ENABLED`；搜索 = `setQuery`。

- [ ] **Step 1: styles.css 末尾追加**

```css
/* —— Phase 4 脚本池（scripts- 前缀防撞名）—— */
.scripts-run {
  border: 1px solid var(--line);
  background: var(--surface);
  border-radius: 10px;
  padding: 8px 12px;
  margin-bottom: 10px;
  font-size: 12px;
}
.scripts-run__head { display: flex; align-items: center; gap: 6px; color: var(--ink-2); margin-bottom: 4px; }
.scripts-run__dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--ok); display: inline-block; flex: none;
  animation: scriptPulse 1.6s ease-in-out infinite;
}
.scripts-run__dot--off { background: var(--ink-3); animation: none; }
@keyframes scriptPulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
@media (prefers-reduced-motion: reduce) { .scripts-run__dot { animation: none; } }
.scripts-run__item { font-family: var(--mono); font-size: 11px; color: var(--ink); padding: 1px 0; }
.scripts-run__empty { color: var(--ink-3); }

.scripts-notice {
  display: flex; gap: 6px; align-items: flex-start;
  border: 1px solid var(--warn); background: var(--warn-wash); color: var(--warn);
  border-radius: 10px; padding: 8px 10px; font-size: 12px; margin-bottom: 10px;
}

.scripts-toolbar { display: flex; gap: 6px; margin-bottom: 10px; }
.scripts-toolbar .input { flex: 1; }

.scripts-row {
  display: flex; align-items: center; gap: 8px;
  border: 1px solid var(--line); border-radius: 10px; background: var(--surface);
  padding: 8px 10px; margin-bottom: 6px; cursor: pointer; text-align: left; width: 100%;
}
.scripts-row:hover { border-color: var(--line-strong); }
.scripts-row.is-off { opacity: 0.55; }
.scripts-row__name { font-weight: 600; color: var(--ink); font-size: 13px; white-space: nowrap; }
.scripts-row__match {
  font-family: var(--mono); font-size: 11px; color: var(--ink-3);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0;
}
.scripts-badge {
  font-size: 10px; padding: 1px 6px; border-radius: 999px;
  border: 1px solid var(--line); color: var(--ink-2); flex: none;
}
.scripts-badge--warn { color: var(--warn); border-color: var(--warn); background: var(--warn-wash); }
.scripts-badge--signal { color: var(--signal-ink); border-color: var(--signal); background: var(--signal-wash); }
.scripts-warnline { font-size: 11px; color: var(--warn); margin: 2px 0 8px; }
.scripts-footer { display: flex; gap: 6px; margin-top: 10px; }
```

- [ ] **Step 2: 实现 `components/scripts/ScriptsListView.tsx`**

```tsx
// components/scripts/ScriptsListView.tsx
// 脚本池列表页（spec §9.1）：当前页运行中区 + 搜索 + 脚本行（启停/徽标）+ 新建/导入。
import { useRef, useState } from 'react';
import { CircleAlert, Plus, Power, Search, Upload } from 'lucide-react';
import { PageShell } from '../ui/PageShell';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { filterSummaries, sendScriptsRequest, useScripts } from '../../stores/scripts';
import { useUi } from '../../stores/ui';
import type { ScriptsRuntimeEntry } from '../../shared/messages';
import type { ScriptSummary } from '../../shared/types';

const SOURCE_LABEL: Record<ScriptSummary['source'], string> = {
  user: 'user',
  agent: 'agent',
  import: 'TM',
};

export function ScriptsListView() {
  const { summaries, runtimeEntries, activeTabId, query, engineWarning, setQuery } = useScripts();
  const openScript = useUi((s) => s.openScript);
  const [importWarnings, setImportWarnings] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const runtime: ScriptsRuntimeEntry | undefined = activeTabId != null ? runtimeEntries[activeTabId] : undefined;
  const visible = filterSummaries(summaries, query);
  const runningIds = new Set(runtime?.scriptIds ?? []);

  async function createNew(): Promise<void> {
    const resp = await sendScriptsRequest<{ ok: boolean; data?: { script: { id: string } }; error?: string }>({
      type: 'SCRIPTS_CREATE',
      input: { name: '未命名脚本', code: '// 新脚本\n', matches: [] },
    });
    if (resp.ok && resp.data) {
      await useScripts.getState().refresh();
      openScript(resp.data.script.id);
    }
  }

  async function importFile(file: File): Promise<void> {
    const source = await file.text();
    const resp = await sendScriptsRequest<{ ok: boolean; data?: { script: { id: string }; warnings: string[] }; error?: string }>({
      type: 'SCRIPTS_IMPORT',
      source,
      filename: file.name,
    });
    if (resp.ok && resp.data) {
      setImportWarnings(resp.data.warnings);
      await useScripts.getState().refresh();
      openScript(resp.data.script.id);
    } else {
      setImportWarnings([resp.error ?? '导入失败']);
    }
  }

  async function setEnabled(id: string, enabled: boolean): Promise<void> {
    await sendScriptsRequest({ type: 'SCRIPTS_SET_ENABLED', id, enabled });
    await useScripts.getState().refresh();
  }

  return (
    <PageShell title="脚本池" eyebrow="LIBRARY">
      {engineWarning && (
        <div className="scripts-notice" role="alert">
          <CircleAlert size={14} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>{engineWarning}</span>
        </div>
      )}

      <div className="scripts-run">
        <div className="scripts-run__head">
          <span className={`scripts-run__dot${runtime && runtime.scriptIds.length > 0 ? '' : ' scripts-run__dot--off'}`} aria-hidden />
          <span className="mono">RUNNING · {runtime?.scriptIds.length ?? 0}</span>
        </div>
        {runtime == null || runtime.scriptIds.length === 0 ? (
          <div className="scripts-run__empty">无脚本在此页运行</div>
        ) : (
          runtime.scriptIds.map((id) => {
            const s = summaries.find((x) => x.id === id);
            return (
              <div key={id} className="scripts-run__item">
                {s?.name ?? id}
              </div>
            );
          })
        )}
      </div>

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

      <div>
        {visible.map((s) => (
          <button key={s.id} className={`scripts-row${s.enabled ? '' : ' is-off'}`} onClick={() => openScript(s.id)}>
            <span className="scripts-row__name">{s.name}</span>
            <span className="scripts-row__match">{s.matches.join(' ') || '（无匹配规则）'}</span>
            <span className={`scripts-badge scripts-badge--signal`} aria-hidden>
              {SOURCE_LABEL[s.source]}
            </span>
            {s.hasGrants && (
              <span className="scripts-badge scripts-badge--warn" title="脚本使用了 GM_* API（本扩展不支持，调用会报错）">
                GM
              </span>
            )}
            <Button
              variant="ghost"
              aria-label={s.enabled ? '禁用' : '启用'}
              aria-pressed={s.enabled}
              title={s.enabled ? '禁用' : '启用'}
              onClick={(e) => {
                e.stopPropagation();
                void setEnabled(s.id, !s.enabled);
              }}
            >
              <Power size={13} color={s.enabled ? 'var(--ok)' : 'var(--ink-3)'} />
            </Button>
          </button>
        ))}
        {visible.length === 0 && <div className="chat__empty">没有匹配的脚本</div>}
      </div>

      <div className="scripts-footer">
        <Button variant="primary" onClick={() => void createNew()}>
          <Plus size={14} /> 新建
        </Button>
        <Button onClick={() => fileRef.current?.click()}>
          <Upload size={14} /> 导入 .user.js
        </Button>
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
      </div>
    </PageShell>
  );
}
```

> 注：`chat__empty` 是现有空态类（复用）；`mono` 是现有双声道工具类。若类名不存在，用 styles.css 中实际空态类名替换（先 grep 确认）。

- [ ] **Step 3: 类型检查 + 构建冒烟**

Run: `npm run compile && npm run build`
Expected: 均无错误（build 产出 `.output/chrome-mv3`）

- [ ] **Step 4: 提交**

```bash
git add components/scripts/ScriptsListView.tsx entrypoints/sidepanel/styles.css
git commit -m "feat(scripts): 脚本池列表页（运行中区/搜索/启停/导入）+ 样式"
```

---

### Task 10: ScriptDetailView（详情页）+ ScriptsView 路由壳

**Files:**
- Modify: `components/scripts/ScriptsView.tsx`（占位符 → 路由壳）
- Create: `components/scripts/ScriptDetailView.tsx`

**Interfaces:**
- Consumes: Task 8 `useScripts`/`sendScriptsRequest`、`useUi.openScript`、Task 2 `stringifyUserScript`、`PageShell`/`Button`/`Input`。
- Produces: `ScriptsView`（壳：`ui.scriptId` 非空渲染详情，空渲染列表；挂载时 `refresh()` + 监听 `SCRIPTS_RUNTIME` 广播与 `tabs.onActivated`）。

- [ ] **Step 1: 实现 `components/scripts/ScriptsView.tsx`（整体替换占位符）**

```tsx
// components/scripts/ScriptsView.tsx
// 脚本池路由壳：ui.scriptId 非空 = 详情页；挂载时拉数据 + 订阅运行态广播（spec §7）。
import { useEffect } from 'react';
import { ScriptsListView } from './ScriptsListView';
import { ScriptDetailView } from './ScriptDetailView';
import { useScripts } from '../../stores/scripts';
import { useUi } from '../../stores/ui';
import type { ScriptsRuntimeEvent } from '../../shared/messages';

export function ScriptsView() {
  const scriptId = useUi((s) => s.scriptId);

  useEffect(() => {
    void useScripts.getState().refresh();
    const onMessage = (msg: unknown) => {
      const m = msg as { type?: string };
      if (m?.type === 'SCRIPTS_RUNTIME') {
        useScripts.getState().applyRuntimeEvent(msg as ScriptsRuntimeEvent);
      }
    };
    browser.runtime.onMessage.addListener(onMessage);
    // 切换浏览器标签页 → 更新 activeTabId；该 tab 无运行态条目（SW 重启丢失）时重拉兜底
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

  return scriptId ? <ScriptDetailView id={scriptId} /> : <ScriptsListView />;
}
```

- [ ] **Step 2: 实现 `components/scripts/ScriptDetailView.tsx`**

```tsx
// components/scripts/ScriptDetailView.tsx
// 脚本详情页（spec §9.2）：元数据表单 + code 编辑（轻量 textarea）+ 保存/删除/导出/重载当前页。
import { useEffect, useState } from 'react';
import { ArrowLeft, Download, RotateCw, Save, Trash2 } from 'lucide-react';
import { PageShell } from '../ui/PageShell';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { sendScriptsRequest, useScripts } from '../../stores/scripts';
import { useUi } from '../../stores/ui';
import { stringifyUserScript } from '../../shared/userscript-meta';
import type { ScriptRunAt, ScriptWorld, UserScript } from '../../shared/types';

export function ScriptDetailView({ id }: { id: string }) {
  const openScript = useUi((s) => s.openScript);
  const [script, setScript] = useState<UserScript | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const resp = await sendScriptsRequest<{ ok: boolean; data?: { script: UserScript }; error?: string }>({
        type: 'SCRIPTS_GET',
        id,
      });
      if (cancelled) return;
      if (resp.ok && resp.data) setScript(resp.data.script);
      else setNotFound(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  function patch(fields: Partial<UserScript>): void {
    setScript((s) => (s ? { ...s, ...fields } : s));
    setDirty(true);
  }

  async function save(): Promise<void> {
    if (!script) return;
    const matches = script.matches.map((m) => m.trim()).filter(Boolean);
    const resp = await sendScriptsRequest<{ ok: boolean; error?: string }>({
      type: 'SCRIPTS_UPDATE',
      id: script.id,
      patch: { name: script.name, code: script.code, matches, runAt: script.runAt, world: script.world },
    });
    setMessage(resp.ok ? '已重新注册，刷新页面生效' : (resp.error ?? '保存失败'));
    if (resp.ok) {
      setDirty(false);
      await useScripts.getState().refresh();
    }
  }

  async function remove(): Promise<void> {
    if (!script || !window.confirm(`删除脚本「${script.name}」？不可恢复。`)) return;
    const resp = await sendScriptsRequest<{ ok: boolean; error?: string }>({ type: 'SCRIPTS_DELETE', id: script.id });
    if (resp.ok) {
      openScript(null);
      await useScripts.getState().refresh();
    } else {
      setMessage(resp.error ?? '删除失败');
    }
  }

  function exportFile(): void {
    if (!script) return;
    const text = stringifyUserScript(script);
    const url = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${script.name.replace(/[\\/:*?"<>|]/g, '_')}.user.js`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function reloadActivePage(): Promise<void> {
    let [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab) [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id != null) await browser.tabs.reload(tab.id);
  }

  if (notFound) {
    return (
      <PageShell title="脚本详情" eyebrow="SCRIPT" actions={<Button onClick={() => openScript(null)}><ArrowLeft size={14} /> 返回</Button>}>
        <div className="chat__empty">脚本不存在或已被删除</div>
      </PageShell>
    );
  }
  if (!script) return <PageShell title="脚本详情" eyebrow="SCRIPT"><div className="chat__empty">加载中…</div></PageShell>;

  return (
    <PageShell
      title={script.name || '未命名脚本'}
      eyebrow="SCRIPT"
      actions={
        <Button variant="ghost" onClick={() => openScript(null)} aria-label="返回">
          <ArrowLeft size={14} />
        </Button>
      }
    >
      <div style={{ display: 'grid', gap: 10 }}>
        <div>
          <label className="scripts-run__head" htmlFor="sc-name" style={{ marginBottom: 0 }}>名称</label>
          <Input id="sc-name" value={script.name} onChange={(e) => patch({ name: e.target.value })} />
        </div>

        <div>
          <label className="scripts-run__head" htmlFor="sc-matches" style={{ marginBottom: 0 }}>
            匹配规则（match pattern，每行一条）
          </label>
          <textarea
            id="sc-matches"
            className="input script-editor"
            style={{ minHeight: 60 }}
            value={script.matches.join('\n')}
            onChange={(e) => patch({ matches: e.target.value.split('\n') })}
          />
          {script.matches.length === 0 && (
            <div className="scripts-warnline">未设置匹配规则：脚本不会在任何页面运行</div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 10 }}>
          <div style={{ flex: 1 }}>
            <label className="scripts-run__head" htmlFor="sc-runat" style={{ marginBottom: 0 }}>运行时机</label>
            <select
              id="sc-runat"
              className="input"
              value={script.runAt}
              onChange={(e) => patch({ runAt: e.target.value as ScriptRunAt })}
            >
              <option value="document_start">document_start</option>
              <option value="document_end">document_end</option>
              <option value="document_idle">document_idle（默认）</option>
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <label className="scripts-run__head" htmlFor="sc-world" style={{ marginBottom: 0 }}>执行世界</label>
            <select
              id="sc-world"
              className="input"
              value={script.world}
              onChange={(e) => patch({ world: e.target.value as ScriptWorld })}
            >
              <option value="USER_SCRIPT">USER_SCRIPT（隔离，默认）</option>
              <option value="MAIN">MAIN（可访问页面变量）</option>
            </select>
          </div>
        </div>

        {(script.meta?.version || script.meta?.author || script.meta?.grants) && (
          <div className="scripts-run">
            <div className="scripts-run__head mono">META</div>
            <div className="scripts-run__item">
              {script.meta?.version && <div>version: {script.meta.version}</div>}
              {script.meta?.author && <div>author: {script.meta.author}</div>}
              {script.meta?.description && <div>{script.meta.description}</div>}
              {script.meta?.grants && script.meta.grants.length > 0 && (
                <div className="scripts-warnline">
                  需要 GM_* API（{script.meta.grants.join(', ')}）——本扩展不支持，脚本调用会报错
                </div>
              )}
            </div>
          </div>
        )}

        <div>
          <label className="scripts-run__head" htmlFor="sc-code" style={{ marginBottom: 0 }}>代码</label>
          <textarea
            id="sc-code"
            className="script-editor"
            spellCheck={false}
            value={script.code}
            onChange={(e) => patch({ code: e.target.value })}
            onKeyDown={(e) => {
              // Tab 键插入两空格（轻量编辑器约定，spec §2 非目标：不做 CodeMirror）
              if (e.key === 'Tab') {
                e.preventDefault();
                const el = e.currentTarget;
                const { selectionStart, selectionEnd, value } = el;
                el.value = `${value.slice(0, selectionStart)}  ${value.slice(selectionEnd)}`;
                el.selectionStart = el.selectionEnd = selectionStart + 2;
                patch({ code: el.value });
              }
            }}
          />
        </div>

        {message && (
          <div className="scripts-warnline" role="status">
            {message}
          </div>
        )}

        <div className="scripts-footer">
          <Button variant="primary" disabled={!dirty} onClick={() => void save()}>
            <Save size={14} /> 保存
          </Button>
          <Button onClick={() => void reloadActivePage()}>
            <RotateCw size={14} /> 重载当前页
          </Button>
          <Button onClick={exportFile}>
            <Download size={14} /> 导出 .user.js
          </Button>
          <Button variant="danger" onClick={() => void remove()}>
            <Trash2 size={14} /> 删除
          </Button>
        </div>
      </div>
    </PageShell>
  );
}
```

- [ ] **Step 3: 类型检查 + 构建 + 全量测试**

Run: `npm run compile && npm test && npm run build`
Expected: 全部通过

- [ ] **Step 4: 提交**

```bash
git add components/scripts/ScriptsView.tsx components/scripts/ScriptDetailView.tsx
git commit -m "feat(scripts): 脚本详情页 + ScriptsView 路由壳（运行态广播订阅）"
```

---

### Task 11: 收尾——回归、文档、手测清单

**Files:**
- Modify: `CLAUDE.md`（当前阶段段落）

**Interfaces:**
- Consumes: 全部前序任务。
- Produces: 可交付分支状态。

- [ ] **Step 1: 全量回归**

Run: `npm run compile && npm test && npm run build`
Expected: 全部通过；`npm test` 覆盖 22 工具 schema 断言。

- [ ] **Step 2: 更新 CLAUDE.md「当前阶段」**

在 CLAUDE.md 的「待做（Phase 3b）：…」段落之后追加一段：

```markdown
Phase 4（脚本池）已完成（`feature/phase4-script-pool`）：`chrome.userScripts` 注入引擎（enabled↔register/unregister diff 同步 + 启动自愈）、脚本 CRUD/搜索/导入导出/启停 UI（列表 + 详情双页）、per-tab 运行态跟踪（「预期注入」语义，SCRIPTS_RUNTIME 广播）、TM 元数据兼容（`shared/userscript-meta.ts` 解析/序列化，GM_* 不做、带警告徽标）、AI 六工具 `list/get/create/update/delete/toggle_script`（工具 16→22，与 UI 共用 `background/scripts.ts` 编排层；确认门控下阶段经该文件 handler 拦截位接入 `confirmGate`）。
```

- [ ] **Step 3: 手测清单（构建产物加载验证，不进 CI）**

`npm run build` → `chrome://extensions` 加载 `.output/chrome-mv3`：

1. 脚本池页新建脚本：`@match` 填一个测试站点（如 `https://example.com/*`），code 写 `console.log('[phase4] hello')`，保存 → 重载当前页 → DevTools console 看到输出；列表页「RUNNING · 1」出现该脚本。
2. 导入真实 Tampermonkey 脚本（含 `@grant`）→ 警告提示出现 + 详情页 GM 徽标。
3. 禁用开关 → 重载页面 → 不执行、运行区消失。
4. 切换浏览器标签页 → 运行区跟随更新；切到 `chrome://` 页显示「无脚本在此页运行」。
5. 编辑 code 保存 → 提示「刷新页面生效」→ 重载当前页按钮可用。
6. 导出 `.user.js` 下载成功，内容含元数据头；再导入该文件往返无损。
7. 删除脚本（确认框）→ 列表移除、`chrome://extensions` → Service Worker 日志无注册残留报错。
8. 调试台执行 `list_scripts` / `create_script` 验证 AI 工具链路。
9. （浏览器版本支持时）关闭开发者模式 → 列表页顶部出现引擎不可用警示条，读操作不受影响。

- [ ] **Step 4: 提交文档**

```bash
git add CLAUDE.md
git commit -m "docs: Phase 4 脚本池完成（注入引擎/运行态/TM 兼容/AI 六工具）"
```

---

## Self-Review 记录（已执行）

- **Spec 覆盖**：§4 数据模型→Task 1/3；§5 TM 兼容→Task 2/6（import）；§6 注入与同步→Task 6；§6.2 运行态→Task 5/10（订阅）；§7 协议→Task 4/6（接线）/8（store）；§8 六工具→Task 7；§9 UI→Task 9/10；§10 测试→各任务（UI 组件测试按 Global Constraints 声明的偏离改为 store 级 + Task 11 手测）；§11 边界→Task 6（降级/校验）；§12 文件清单全覆盖；分支已切出。
- **占位符扫描**：无 TBD/TODO；所有代码步骤给出完整代码。
- **类型一致性**：`handleCreate → { script, warnings }`、`ScriptsListData { scripts, engineAvailable }`、`ScriptsRuntimeEntry { tabId, url, scriptIds }`、`toSummary` 字段、`useScripts` 形状在 Task 4/6/8/9/10 间已逐一核对一致。

