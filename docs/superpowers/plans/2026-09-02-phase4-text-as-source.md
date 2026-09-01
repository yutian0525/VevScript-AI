# Phase 4 修订「文本为源」Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 脚本编辑模型改为 TM 式——`UserScript.text`（完整 `.user.js` 原文）为唯一真源；`@include` pattern 形式生效、新增 `@world` 键；`get_script` 行区间读取、`create_script`/`update_script` 文本化；详情页改源码编辑器。

**Architecture:** text 为源、解析投影为用：保存（create/update/import）时 `parseUserScript(text)` 重建全部投影字段（name/matches/code/runAt/world/meta），供注册引擎/运行态匹配/列表徽标消费；旧记录经 `stringifyUserScript` 反拼惰性迁移。AI 工具与 UI 共用 background 编排层不变。

**Tech Stack:** 不变（WXT + React 19 + TS + Zustand + vitest v4 / WxtVitest）。

**Spec:** `docs/superpowers/specs/2026-09-01-ai-browser-extension-phase4-script-pool-design.md`（含 2026-09-02 修订记录）

## Global Constraints

- 分支：`feature/phase4-script-pool` 续开发。每个 commit 精确 `git add <具体文件>`，**绝不 `git add -A`**。
- 测试：`npx vitest run <测试文件>`；全量 `npm test`；`npm run compile`（TS 检查）。后台/store/storage 测试用 `fakeBrowser`（`beforeEach(() => fakeBrowser.reset())`）。
- **中间态红是计划内的**：Task 2 改共享类型后，未改到的消费文件（background/工具/UI）会编译报错、旧测试会红。每个 task 的验收 = **本 task 的测试文件绿**；`npm run compile` 全绿恢复点在 Task 6 末，全量绿恢复点在 Task 7。除本 task 文件外不要顺手修其它文件——那是后续 task 的活。
- fake-browser 怪癖（前一轮实证）：onMessage 监听器直接 return 响应对象会被丢弃（生产代码 `sendResponse + return true`，测试 mock `mockResolvedValue`）；`fakeBrowser.reset()` 后无聚焦窗口，测试里 `tabs.query({currentWindow})` 前需 `windows.create({focused:true})`；模块级 Map 不随 reset 清空（background 测试 beforeEach 清 runtimeMap）。
- 代码风格：中文注释；错误中文文案；工具返回 `{ ok: true, data? } | { ok: false, error }`；执行器命名 `doXxx`。
- 行号语义（全链路统一）：**1-based、含端点**；行分割用 `text.split('\n')`；`get_script` 越界钳制、`update_script.edit` 越界报错。
- 工具总数仍 22（本轮改 3 个工具的参数，不增删）。
- `confirmGate` 拦截位约定不变（`background/scripts.ts` 写 handler 入口，下阶段接入）。

---

### Task 1: 解析器修订（@include pattern 形式 + @world）

**Files:**
- Modify: `shared/userscript-meta.ts`
- Test: `tests/shared/userscript-meta.test.ts`

**Interfaces:**
- Consumes: `shared/match-pattern.ts` 的 `isValidMatchPattern`（已有）。
- Produces（后续 task 依赖）:
  - `ParsedUserScript.fields` 增加 `world: ScriptWorld`（`'USER_SCRIPT' | 'MAIN'`，缺省/无头/非法均回退 `USER_SCRIPT`）
  - `@include`：值通过 `isValidMatchPattern` → 并入 `matches`（去重，追加在 @match 之后按出现顺序）；`/^\/.+\/$/` 正则形式 → 警告「正则形式不支持」；其它 → 警告「不符合 match pattern 语法」
  - `stringifyUserScript`：`world === 'MAIN'` 时输出 `// @world       MAIN`（USER_SCRIPT 缺省不输出）
  - 无匹配规则警告文案改为：`未找到 @match/@include 匹配规则：脚本不会在任何页面运行，请在头部补规则`（含 `@match` 子串，旧断言兼容）

- [ ] **Step 1: 替换测试文件**

`tests/shared/userscript-meta.test.ts` **整体替换**为：

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
  it('解析标准头：name/matches/run-at/world/grants/代码体', () => {
    const { fields, warnings } = parseUserScript(fixture);
    expect(fields.name).toBe('去广告助手');
    expect(fields.matches).toEqual(['https://example.com/*', 'https://www.example.com/*']);
    expect(fields.runAt).toBe('document_end');
    expect(fields.world).toBe('USER_SCRIPT'); // 缺省
    expect(fields.code).toBe('\ndocument.querySelector(\'.ad\')?.remove();');
    expect(fields.meta).toMatchObject({ namespace: 'https://example.org/', version: '1.2.0', author: 'someone', description: '移除页面广告', grants: ['GM_setValue'] });
    expect(warnings.some((w) => w.includes('GM_*'))).toBe(true);
  });

  it('无元数据头：整段作为 code + 警告', () => {
    const { fields, warnings } = parseUserScript('console.log(1)', 'my.user.js');
    expect(fields.code).toBe('console.log(1)');
    expect(fields.name).toBe('my');
    expect(fields.matches).toEqual([]);
    expect(fields.world).toBe('USER_SCRIPT');
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

  it('@include pattern 形式并入 matches（去重），不再警告', () => {
    const src = '// ==UserScript==\n// @match https://a.com/*\n// @include https://b.com/*\n// @include https://a.com/*\n// ==/UserScript==\ncode();';
    const r = parseUserScript(src);
    expect(r.fields.matches).toEqual(['https://a.com/*', 'https://b.com/*']);
    expect(r.warnings.some((w) => w.includes('@include'))).toBe(false);
  });

  it('@include 正则形式 /…/ 警告并忽略', () => {
    const src = '// ==UserScript==\n// @include /^https:\\/\\/a\\.com\\//\n// ==/UserScript==\ncode();';
    const r = parseUserScript(src);
    expect(r.fields.matches).toEqual([]);
    expect(r.warnings.some((w) => w.includes('正则形式'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('@match/@include'))).toBe(true); // 无匹配规则警告仍在
  });

  it('@include 非 pattern glob 警告并忽略', () => {
    const src = '// ==UserScript==\n// @include *.a.com/*\n// ==/UserScript==\ncode();';
    const r = parseUserScript(src);
    expect(r.fields.matches).toEqual([]);
    expect(r.warnings.some((w) => w.includes('match pattern 语法'))).toBe(true);
  });

  it('@world：USER_SCRIPT/MAIN 映射 + 非法值警告回退 USER_SCRIPT', () => {
    const mk = (v: string) => `// ==UserScript==\n// @world ${v}\n// ==/UserScript==\n`;
    expect(parseUserScript(mk('MAIN')).fields.world).toBe('MAIN');
    expect(parseUserScript(mk('USER_SCRIPT')).fields.world).toBe('USER_SCRIPT');
    const bad = parseUserScript(mk('ISOLATED'));
    expect(bad.fields.world).toBe('USER_SCRIPT');
    expect(bad.warnings.some((w) => w.includes('@world'))).toBe(true);
  });

  it('其它不支持的键汇总为一条 ignored 警告', () => {
    const src = '// ==UserScript==\n// @icon a.png\n// @updateURL https://u\n// @downloadURL https://d\n// ==/UserScript==\n';
    const { warnings } = parseUserScript(src);
    expect(warnings.filter((w) => w.includes('已忽略'))).toHaveLength(1);
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
  it('stringify → parse 元数据无损（world USER_SCRIPT 缺省不输出）', () => {
    const s: UserScript = {
      id: 's1', text: '', name: '测试', enabled: true, matches: ['https://a.com/*'],
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
    expect(back.fields.world).toBe('USER_SCRIPT');
    expect(back.fields.code).toBe('\nconsole.log("x");');
    expect(back.fields.meta).toEqual(s.meta);
  });

  it('world MAIN 往返无损（@world 输出）', () => {
    const s: UserScript = {
      id: 's2', text: '', name: '主世界', enabled: true, matches: ['https://a.com/*'],
      code: 'x();', runAt: 'document_idle', world: 'MAIN', source: 'user',
      createdAt: 0, updatedAt: 0,
    };
    const text = stringifyUserScript(s);
    expect(text).toContain('@world');
    const back = parseUserScript(text);
    expect(back.fields.world).toBe('MAIN');
    expect(back.fields.name).toBe('主世界');
    expect(back.fields.code).toBe('\nx();');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/shared/userscript-meta.test.ts`
Expected: FAIL（`fields.world` 为 undefined、@include 用例失败）

- [ ] **Step 3: 整体替换 `shared/userscript-meta.ts`**

```ts
// shared/userscript-meta.ts
// Tampermonkey ==UserScript== 元数据解析/序列化（纯函数，spec §5）。
// 兼容策略（修订 2026-09-02 文本为源）：解析头 + 代码体原样执行；GM_* 不实现（grants 仅作警告徽标）；
// @include 的 pattern 形式并入 matches 按 @match 语义生效，正则/其它 glob 形式警告并忽略。

import type { ScriptRunAt, ScriptWorld, UserScript, UserScriptMeta } from './types';
import { isValidMatchPattern } from './match-pattern';

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

/** glob 语义的匹配键：与 match pattern 有损，警告并忽略（@include 已单独支持 pattern 形式） */
const UNSUPPORTED_MATCH_KEYS = new Set(['exclude', 'ant-match']);

export interface ParsedUserScript {
  fields: { name: string; matches: string[]; runAt: ScriptRunAt; world: ScriptWorld; code: string; meta: UserScriptMeta };
  warnings: string[];
}

export function parseUserScript(source: string, fallbackName?: string): ParsedUserScript {
  const lines = source.split(/\r?\n/);
  const startIdx = lines.findIndex((l) => l.trim() === '// ==UserScript==');
  const endIdx = lines.findIndex((l) => l.trim() === '// ==/UserScript==');
  const defaultName = fallbackName?.replace(/\.user\.js$|\.js$/i, '').trim() || '未命名脚本';
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    return {
      fields: { name: defaultName, matches: [], runAt: 'document_idle', world: 'USER_SCRIPT', code: source, meta: {} },
      warnings: ['未找到 ==UserScript== 元数据头，将使用默认设置'],
    };
  }

  const matches: string[] = [];
  const grants: string[] = [];
  const regexIncludes: string[] = [];
  const badIncludes: string[] = [];
  const meta: UserScriptMeta = {};
  const ignoredKeys = new Set<string>();
  let name = '';
  let runAt: ScriptRunAt = 'document_idle';
  let world: ScriptWorld = 'USER_SCRIPT';
  let badRunAt = '';
  let badWorld = '';
  let unsupportedMatch = false;

  for (const line of lines.slice(startIdx + 1, endIdx)) {
    const m = /^\s*\/\/\s*@(\S+)\s*(.*)$/.exec(line);
    if (!m) continue;
    // noUncheckedIndexedAccess 下捕获组类型为 string | undefined；正则命中时组 1/2 必存在，?? 仅为编译兜底，运行时行为不变
    const key = m[1] ?? '';
    const value = (m[2] ?? '').trim();
    switch (key) {
      case 'name': name = value; break;
      case 'namespace': meta.namespace = value; break;
      case 'version': meta.version = value; break;
      case 'author': meta.author = value; break;
      case 'description': meta.description = value; break;
      case 'match': matches.push(value); break;
      case 'include': {
        // 修订 2026-09-02：pattern 形式并入 matches（去重）；正则 /…/ 与非法 glob 警告忽略
        if (/^\/.+\/$/.test(value)) regexIncludes.push(value);
        else if (value && isValidMatchPattern(value)) {
          if (!matches.includes(value)) matches.push(value);
        } else badIncludes.push(value);
        break;
      }
      case 'world': {
        if (value === 'USER_SCRIPT' || value === 'MAIN') world = value;
        else badWorld = value;
        break;
      }
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
  if (regexIncludes.length > 0) warnings.push(`@include 正则形式不支持（${regexIncludes.join('、')}），已忽略`);
  if (badIncludes.length > 0) warnings.push(`@include 值不符合 match pattern 语法（${badIncludes.join('、')}），已忽略`);
  if (badWorld) warnings.push(`@world 值「${badWorld}」不支持，已用 USER_SCRIPT`);
  const realGrants = grants.filter((g) => g !== 'none');
  if (realGrants.length > 0) {
    meta.grants = grants;
    warnings.push(`@grant 非 none：本扩展不支持 GM_* API（${realGrants.join(', ')}），脚本调用会报错`);
  }
  if (unsupportedMatch) warnings.push('不支持的匹配键 @exclude/@ant-match 已忽略，请改用 @match');
  if (ignoredKeys.size > 0) {
    warnings.push(`已忽略 ${ignoredKeys.size} 个不支持的元数据键：${[...ignoredKeys].map((k) => `@${k}`).join(' ')}`);
  }
  if (matches.length === 0) warnings.push('未找到 @match/@include 匹配规则：脚本不会在任何页面运行，请在头部补规则');

  return {
    fields: { name: name || defaultName, matches, runAt, world, code: lines.slice(endIdx + 1).join('\n'), meta },
    warnings,
  };
}

/** 反向生成带元数据头的 .user.js 文本（修订后仅用于旧记录 text 迁移与兜底，导出直接用原文）。 */
export function stringifyUserScript(script: UserScript): string {
  const meta = script.meta ?? {};
  const lines = ['// ==UserScript==', `// @name        ${script.name}`];
  if (meta.namespace) lines.push(`// @namespace   ${meta.namespace}`);
  if (meta.version) lines.push(`// @version     ${meta.version}`);
  if (meta.author) lines.push(`// @author      ${meta.author}`);
  if (meta.description) lines.push(`// @description ${meta.description}`);
  for (const m of script.matches) lines.push(`// @match       ${m}`);
  lines.push(`// @run-at      ${RUN_AT_OUT[script.runAt]}`);
  if (script.world === 'MAIN') lines.push('// @world       MAIN');
  if (meta.grants) for (const g of meta.grants) lines.push(`// @grant       ${g}`);
  if (meta.noframes) lines.push('// @noframes');
  lines.push('// ==/UserScript==', '');
  return [...lines, script.code].join('\n');
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/shared/userscript-meta.test.ts`
Expected: PASS（全部用例）

- [ ] **Step 5: 提交**

```bash
git add shared/userscript-meta.ts tests/shared/userscript-meta.test.ts
git commit -m "feat(scripts): 解析器修订——@include pattern 形式并入 matches + @world 键"
```

---

### Task 2: 共享类型 + 消息协议修订

**Files:**
- Modify: `shared/types.ts`
- Modify: `shared/messages.ts`
- Test: `tests/shared/messages-phase4.test.ts`

**Interfaces:**
- Consumes: Task 1 无类型依赖（本 task 只动类型层）。
- Produces（Task 3-6 依赖的精确形状）:
  - `UserScript` 增加 `text: string`（id 之后；必填）
  - `ScriptEditRange { startLine: number; endLine: number; text: string }`
  - `ScriptInput { text: string; enabled?: boolean; source?: ScriptSource }`（去掉 name/code/matches/runAt/world）
  - `ScriptPatch { text?: string; enabled?: boolean; edit?: ScriptEditRange }`（去掉 name/code/matches/runAt/world）
  - `ScriptGetData { script: UserScript; totalLines: number; startLine: number; endLine: number }`
  - `ScriptsRequest`：`SCRIPTS_GET` 加 `offset?: number; limit?: number`；`SCRIPTS_IMPORT` 字段 `source` → `text`

- [ ] **Step 1: 替换测试文件**

`tests/shared/messages-phase4.test.ts` **整体替换**为：

```ts
// tests/shared/messages-phase4.test.ts
// 协议类型回归：8 个脚本 request 可构造 + 广播事件形状（spec §7 + 2026-09-02 修订）。
import { describe, it, expect, expectTypeOf } from 'vitest';
import type {
  ScriptsRequest, ScriptsRuntimeEvent, ScriptsListData,
  ScriptInput, ScriptPatch, ScriptGetData,
} from '../../shared/messages';

describe('Phase 4 脚本消息协议', () => {
  it('8 个 request 类型可构造且可赋值给 ScriptsRequest（含修订后的 GET 区间/IMPORT text）', () => {
    const reqs: ScriptsRequest[] = [
      { type: 'SCRIPTS_LIST' },
      { type: 'SCRIPTS_GET', id: 's1' },
      { type: 'SCRIPTS_GET', id: 's1', offset: 10, limit: 20 },
      { type: 'SCRIPTS_CREATE', input: { text: '// ==UserScript==\n' } },
      { type: 'SCRIPTS_UPDATE', id: 's1', patch: { enabled: false } },
      { type: 'SCRIPTS_UPDATE', id: 's1', patch: { text: '// ==UserScript==\n' } },
      { type: 'SCRIPTS_UPDATE', id: 's1', patch: { edit: { startLine: 1, endLine: 2, text: 'x' } } },
      { type: 'SCRIPTS_DELETE', id: 's1' },
      { type: 'SCRIPTS_SET_ENABLED', id: 's1', enabled: true },
      { type: 'SCRIPTS_IMPORT', text: '// ==UserScript==\n', filename: 'a.user.js' },
      { type: 'SCRIPTS_GET_RUNTIME' },
    ];
    expect(reqs.length).toBe(11);
  });

  it('ScriptInput：text 必填，其余可选', () => {
    const input: ScriptInput = { text: '// x\n' };
    expectTypeOf(input).toMatchTypeOf<ScriptInput>();
  });

  it('ScriptPatch：text/enabled/edit 均可选，edit 为行区间', () => {
    const patch: ScriptPatch = { edit: { startLine: 2, endLine: 3, text: 'y' } };
    expectTypeOf(patch).toMatchTypeOf<ScriptPatch>();
  });

  it('ScriptGetData 形状', () => {
    const d: ScriptGetData = {
      script: {
        id: 's1', text: '', name: 'n', enabled: true, matches: [], code: '',
        runAt: 'document_idle', world: 'USER_SCRIPT', source: 'user', createdAt: 0, updatedAt: 0,
      },
      totalLines: 1, startLine: 1, endLine: 1,
    };
    expect(d.totalLines).toBe(1);
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
Expected: FAIL（`text`/`ScriptEditRange`/`ScriptGetData` 不存在）

- [ ] **Step 3: 实现**

`shared/types.ts` 的 `UserScript`（`id` 字段之后插入 `text`，其余字段注释微调）：

```ts
export interface UserScript {
  id: string;
  /** 完整 .user.js 原文（含 ==UserScript== 头）——唯一真源（修订 2026-09-02）；name/matches/code/runAt/world/meta 均为保存时解析生成的投影 */
  text: string;
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
```

`shared/messages.ts` 的 Phase 4 段——`ScriptInput`/`ScriptPatch` **整体替换**，并新增 `ScriptEditRange`/`ScriptGetData`：

```ts
/** 行区间替换（修订 2026-09-02）：1-based、含端点；非法区间/越界由编排层报错 */
export interface ScriptEditRange {
  startLine: number;
  endLine: number;
  text: string;
}

export interface ScriptInput {
  /** 完整 .user.js 文本（含 ==UserScript== 头）——唯一配置源（修订 2026-09-02） */
  text: string;
  enabled?: boolean;
  /** 创建来源：UI 默认 user；AI 工具传 agent；导入走 SCRIPTS_IMPORT（固定 import） */
  source?: ScriptSource;
}

export interface ScriptPatch {
  /** 整文替换：替换后整体重解析（投影字段全部重建） */
  text?: string;
  enabled?: boolean;
  /** 行区间替换：在当前原文上 splice 后整体重解析 */
  edit?: ScriptEditRange;
}

/** SCRIPTS_GET 响应 data 形状：传 offset/limit 时 script.text 为行切片（修订 2026-09-02） */
export interface ScriptGetData {
  script: UserScript;
  totalLines: number;
  startLine: number;
  endLine: number;
}
```

`ScriptsRequest` 联合中两行改为：

```ts
  | { type: 'SCRIPTS_GET'; id: string; offset?: number; limit?: number }
  | { type: 'SCRIPTS_IMPORT'; text: string; filename?: string }
```

（`ScriptsRuntimeEntry`/`ScriptsRuntimeEvent`/`ScriptsListData` 不动；顶部 import 若有无用项由编译提示清理。）

- [ ] **Step 4: 跑本 task 测试确认通过**

Run: `npx vitest run tests/shared/messages-phase4.test.ts tests/shared/userscript-meta.test.ts`
Expected: PASS

> 注意：此时 `npm run compile` 会因 background/tools/UI 尚未适配而报错、其它旧测试会红——**计划内中间态**，不要修本 task 之外的文件。

- [ ] **Step 5: 提交**

```bash
git add shared/types.ts shared/messages.ts tests/shared/messages-phase4.test.ts
git commit -m "feat(scripts): 共享类型/协议修订——UserScript.text 真源 + text/edit patch + GET 行区间"
```

---

### Task 3: 存储层——text 真源 + 旧记录惰性迁移

**Files:**
- Modify: `storage/scripts.ts`
- Test: `tests/storage/scripts.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `UserScript.text`、Task 1 的 `stringifyUserScript`。
- Produces（Task 4-6 依赖）:
  - `MAX_TEXT_LENGTH = 280 * 1024`（新导出）；`saveScript` 增加 text 上限校验
  - `listScripts()`/`getScript()` 对缺 `text` 的旧记录用 `stringifyUserScript` 反拼补齐并**惰性写回**
  - `toSummary` 不变（无 text）

- [ ] **Step 1: 替换测试文件**

`tests/storage/scripts.test.ts` **整体替换**为：

```ts
// tests/storage/scripts.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { storage } from 'wxt/utils/storage';
import {
  listScripts, getScript, saveScript, deleteScript, toSummary, MAX_SCRIPTS, MAX_TEXT_LENGTH,
} from '../../storage/scripts';
import type { UserScript } from '../../shared/types';

function mkScript(over: Partial<UserScript> = {}): UserScript {
  return {
    id: 's1', text: '// ==UserScript==\n// @name 测试\n// @match https://a.com/*\n// ==/UserScript==\nconsole.log(1);\n',
    name: '测试', enabled: true, matches: ['https://a.com/*'],
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

  it('text 超长抛错', async () => {
    await expect(saveScript(mkScript({ text: 'x'.repeat(MAX_TEXT_LENGTH + 1) }))).rejects.toThrow('上限');
  });

  it('旧记录缺 text：listScripts 反拼补齐并惰性写回', async () => {
    const legacy = {
      id: 'old', name: '旧', enabled: true, matches: ['https://a.com/*'], code: 'x();',
      runAt: 'document_idle', world: 'USER_SCRIPT', source: 'import', createdAt: 1, updatedAt: 1,
    };
    await storage.setItem('local:scripts:index', [legacy]);
    const all = await listScripts();
    expect(all[0]!.text).toContain('@name');
    expect(all[0]!.text).toContain('x();');
    const raw = await storage.getItem<Array<Record<string, unknown>>>('local:scripts:index');
    expect(raw![0]!).toHaveProperty('text');
  });
});

describe('toSummary', () => {
  it('裁掉 code/text，带 hasGrants/description', () => {
    const s = mkScript({ meta: { description: '描述', grants: ['GM_getValue'] } });
    const sum = toSummary(s);
    expect(sum).not.toHaveProperty('code');
    expect(sum).not.toHaveProperty('text');
    expect(sum).toMatchObject({ id: 's1', description: '描述', hasGrants: true });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/storage/scripts.test.ts`
Expected: FAIL（`MAX_TEXT_LENGTH` 不存在；迁移用例失败）

- [ ] **Step 3: 整体替换 `storage/scripts.ts`**

```ts
// storage/scripts.ts
// 脚本池存储（spec §4）。单键 local:scripts:index（UserScript[]），沿用原总体设计 §8 键名。
// 个人量级（<100 条）全量读写无压力，YAGNI 分键。
// 修订 2026-09-02（文本为源）：text 为唯一真源；旧记录（无 text）读取时用 stringifyUserScript 反拼惰性迁移。

import { storage } from 'wxt/utils/storage';
import type { ScriptSummary, UserScript } from '../shared/types';
import { stringifyUserScript } from '../shared/userscript-meta';

const KEY = 'local:scripts:index' as const;

export const MAX_SCRIPTS = 200;
export const MAX_CODE_LENGTH = 256 * 1024;
/** text = 头部 + 代码体，上限略宽于 code（修订 2026-09-02） */
export const MAX_TEXT_LENGTH = 280 * 1024;

/** 旧记录（无 text）→ stringifyUserScript 反拼补齐，并惰性写回（一次性迁移，失败不影响读取）。 */
async function migrateText(all: UserScript[]): Promise<UserScript[]> {
  let changed = false;
  const next = all.map((s) => {
    if (typeof s.text === 'string') return s;
    changed = true;
    return { ...s, text: stringifyUserScript(s) };
  });
  if (changed) await storage.setItem(KEY, next).catch(() => {});
  return next;
}

export async function listScripts(): Promise<UserScript[]> {
  return migrateText((await storage.getItem<UserScript[]>(KEY)) ?? []);
}

export async function getScript(id: string): Promise<UserScript | undefined> {
  return (await listScripts()).find((s) => s.id === id);
}

/** upsert；数量/code/text 上限超限 throw（文案给用户/模型可读的中文原因）。 */
export async function saveScript(script: UserScript): Promise<void> {
  const all = await listScripts();
  const exists = all.some((s) => s.id === script.id);
  if (!exists && all.length >= MAX_SCRIPTS) {
    throw new Error(`脚本数量已达上限（${MAX_SCRIPTS} 条），请先删除部分脚本`);
  }
  if (script.code.length > MAX_CODE_LENGTH) {
    throw new Error(`脚本代码超过上限（${MAX_CODE_LENGTH} 字符）`);
  }
  if (script.text.length > MAX_TEXT_LENGTH) {
    throw new Error(`脚本文本超过上限（${MAX_TEXT_LENGTH} 字符）`);
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

- [ ] **Step 4: 跑本 task 测试确认通过**

Run: `npx vitest run tests/storage/scripts.test.ts`
Expected: PASS

> 仍为计划内中间态：compile 因 background/tools/UI 未适配而报错，不修本 task 之外文件。

- [ ] **Step 5: 提交**

```bash
git add storage/scripts.ts tests/storage/scripts.test.ts
git commit -m "feat(scripts): 存储层 text 真源 + 旧记录反拼惰性迁移（MAX_TEXT_LENGTH 280KB）"
```

---

### Task 4: 编排层——文本为源 CRUD + 行区间原语 + handleGet

**Files:**
- Modify: `background/scripts.ts`
- Test: `tests/background/scripts.test.ts`

**Interfaces:**
- Consumes: Task 1 parser（fields.world）、Task 2 类型、Task 3 `MAX_TEXT_LENGTH`。
- Produces（Task 5/6 依赖）:
  - `spliceLines(text, startLine, endLine, replacement): string`（导出；非法区间/越界 throw）
  - `handleCreate(input: ScriptInput)`：text 必填 → 解析 → 校验 → 落库 → sync；返回 `{ script, warnings }`（warnings = 解析 warnings + sync warnings）
  - `handleUpdate(id, patch { text? | edit? | enabled? })`：text/edit 路径整体重解析；enabled-only 不重解析；空 patch 报错
  - `handleGet(id, offset?, limit?): Promise<ScriptGetData>`：缺省全文；区间 1-based、越界钳制、limit 缺省读到末尾
  - `handleImport(text, filename?)`：原文存 text；签名第二参仍为 filename
  - `handleDelete`/`handleSetEnabled`/`syncRegistrations`/运行态全不变

- [ ] **Step 1: 整体替换测试文件**

`tests/background/scripts.test.ts` **整体替换**为：

```ts
// tests/background/scripts.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  computeRuntimeScriptIds, recomputeTab, recomputeAllTabs, dropTab, getRuntimeSnapshot,
  handleCreate, handleUpdate, handleDelete, handleSetEnabled, handleImport, handleGet, spliceLines,
  syncRegistrations, initScriptsModule, ENGINE_UNAVAILABLE_MSG,
} from '../../background/scripts';
import { listScripts, saveScript } from '../../storage/scripts';
// 注：new MessageRouter() 需要运行时值——type-only 导入会被擦除导致运行时 TypeError
import { MessageRouter } from '../../background/router';
import type { UserScript } from '../../shared/types';

function mkScript(over: Partial<UserScript> = {}): UserScript {
  return {
    id: 's1', text: '// ==UserScript==\n// @name 测试\n// @match https://a.com/*\n// ==/UserScript==\nx();\n',
    name: '测试', enabled: true, matches: ['https://a.com/*'],
    code: 'x();', runAt: 'document_idle', world: 'USER_SCRIPT',
    source: 'user', createdAt: 1, updatedAt: 1, ...over,
  };
}

describe('运行态跟踪（预期注入语义）', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
    // runtimeMap 是模块级状态，fakeBrowser.reset 不会清它——用公共导出清掉上一用例残留
    getRuntimeSnapshot().forEach((e) => dropTab(e.tabId));
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
    const spy = vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue(undefined);

    await recomputeTab(1, 'https://a.com/');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toMatchObject({
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
    vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue(undefined);
    await fakeBrowser.tabs.create({ url: 'https://a.com/' });
    await fakeBrowser.tabs.create({ url: 'https://b.com/' });

    await recomputeAllTabs();
    const snap = getRuntimeSnapshot();
    expect(snap).toHaveLength(2);
    const urls = snap.map((e) => e.url).sort();
    expect(urls).toEqual(['https://a.com/', 'https://b.com/']);
  });

  it('dropTab 移除条目', async () => {
    vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue(undefined);
    await recomputeTab(7, 'https://a.com/');
    dropTab(7);
    expect(getRuntimeSnapshot()).toEqual([]);
  });
});

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

describe('CRUD 编排 + 注册同步（文本为源）', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    uninstallFakeUserScripts();
    vi.restoreAllMocks();
    vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue(undefined);
  });

  /** 标准头 + 代码体；4 行头 + body 各行 */
  const mkText = (body: string, extraHeader = ''): string =>
    `// ==UserScript==\n// @name n\n// @match https://a.com/*${extraHeader}\n// ==/UserScript==\n${body}`;

  it('spliceLines：行区间替换 + 非法/越界报错', () => {
    expect(spliceLines('a\nb\nc', 2, 2, 'X')).toBe('a\nX\nc');
    expect(spliceLines('a\nb\nc', 1, 2, 'X\nY')).toBe('X\nY\nc');
    expect(spliceLines('a\nb\nc', 3, 3, 'X\nY')).toBe('a\nb\nX\nY');
    expect(() => spliceLines('a\nb\nc', 0, 2, 'X')).toThrow('非法行区间');
    expect(() => spliceLines('a\nb\nc', 3, 2, 'X')).toThrow('非法行区间');
    expect(() => spliceLines('a\nb\nc', 2, 9, 'X')).toThrow('越界');
  });

  it('handleCreate：解析投影落库 + register（code/matches/runAt/world/persistAcrossSessions）', async () => {
    const api = installFakeUserScripts();
    const { script, warnings } = await handleCreate({ text: mkText('c();') });
    expect(warnings).toEqual([]);
    expect(script).toMatchObject({
      name: 'n', matches: ['https://a.com/*'], code: 'c();',
      runAt: 'document_idle', world: 'USER_SCRIPT', source: 'user', enabled: true,
    });
    expect((await listScripts()).map((s) => s.id)).toEqual([script.id]);
    expect(api.register).toHaveBeenCalledTimes(1);
    expect(api.register.mock.calls[0]![0]).toEqual([
      expect.objectContaining({
        id: script.id, matches: ['https://a.com/*'],
        js: [{ code: 'c();' }], runAt: 'document_idle', world: 'USER_SCRIPT', persistAcrossSessions: true,
      }),
    ]);
  });

  it('handleCreate：非法 pattern 拒绝并列出条目；无匹配规则允许（matches 为空）', async () => {
    installFakeUserScripts();
    await expect(handleCreate({ text: mkText('c', '\n// @match https://bad') })).rejects.toThrow('非法 match pattern');
    const { script } = await handleCreate({ text: 'console.log(1);' });
    expect(script.matches).toEqual([]);
  });

  it('handleCreate：引擎不可用 → 照常落库 + warnings 带固定文案', async () => {
    // beforeEach 已卸载 userScripts 属性 → 引擎不可用路径
    const { warnings } = await handleCreate({ text: mkText('c') });
    expect(await listScripts()).toHaveLength(1);
    expect(warnings.some((w) => w.includes(ENGINE_UNAVAILABLE_MSG))).toBe(true);
  });

  it('handleUpdate：text 整文替换 → 整体重解析 + update 同步；enabled-only → unregister', async () => {
    const api = installFakeUserScripts();
    const { script } = await handleCreate({ text: mkText('v1') });
    // 模拟「已按 v1 注册」状态（mock 不记录先前 register，需显式喂 getScripts）
    api.getScripts.mockResolvedValue([
      { id: script.id, matches: ['https://a.com/*'], js: [{ code: 'v1' }], runAt: 'document_idle', world: 'USER_SCRIPT' },
    ]);
    api.update.mockClear();
    await handleUpdate(script.id, { text: mkText('v2') });
    expect(api.update).toHaveBeenCalledTimes(1);
    expect(api.update.mock.calls[0]![0]).toEqual([
      expect.objectContaining({ id: script.id, js: [{ code: 'v2' }] }),
    ]);
    await handleSetEnabled(script.id, false);
    expect(api.unregister).toHaveBeenCalledWith([script.id]);
  });

  it('handleUpdate：edit 行区间替换（含重解析）+ 非法/越界报错', async () => {
    installFakeUserScripts();
    const text = ['// ==UserScript==', '// @name n', '// @match https://a.com/*', '// ==/UserScript==', 'a();', 'b();', 'c();'].join('\n');
    const { script } = await handleCreate({ text });
    const next = await handleUpdate(script.id, { edit: { startLine: 5, endLine: 6, text: 'X();\nY();' } });
    expect(next.code).toBe('a();\nX();\nY();\nc();');
    expect(next.name).toBe('n');
    await expect(handleUpdate(script.id, { edit: { startLine: 0, endLine: 2, text: 'z' } })).rejects.toThrow('非法行区间');
    await expect(handleUpdate(script.id, { edit: { startLine: 2, endLine: 99, text: 'z' } })).rejects.toThrow('越界');
  });

  it('handleUpdate：空 patch 报错', async () => {
    installFakeUserScripts();
    const { script } = await handleCreate({ text: mkText('c') });
    await expect(handleUpdate(script.id, {})).rejects.toThrow('patch 至少包含');
  });

  it('handleGet：全文 / 行区间切片 / 越界钳制；未知 id 报错', async () => {
    installFakeUserScripts();
    const { script } = await handleCreate({ text: mkText('h1\nh2\nh3') });
    const full = await handleGet(script.id);
    expect(full.totalLines).toBe(7);
    expect(full.startLine).toBe(1);
    expect(full.endLine).toBe(7);
    expect(full.script.text).toBe(script.text);

    const slice = await handleGet(script.id, 5, 2);
    expect(slice).toMatchObject({ totalLines: 7, startLine: 5, endLine: 6 });
    expect(slice.script.text).toBe('h1\nh2');

    const tail = await handleGet(script.id, 99);
    expect(tail).toMatchObject({ startLine: 7, endLine: 7 });
    expect(tail.script.text).toBe('h3');

    await expect(handleGet('nope')).rejects.toThrow('脚本不存在');
  });

  it('handleDelete：删库 + unregister', async () => {
    const api = installFakeUserScripts();
    const { script } = await handleCreate({ text: mkText('c') });
    api.getScripts.mockResolvedValue([
      { id: script.id, matches: ['https://a.com/*'], js: [{ code: 'c' }], runAt: 'document_idle', world: 'USER_SCRIPT' },
    ]);
    await handleDelete(script.id);
    expect(await listScripts()).toEqual([]);
    expect(api.unregister).toHaveBeenCalledWith([script.id]);
  });

  it('update/delete/setEnabled 引擎不可用 → throw 固定文案', async () => {
    const { script } = await handleCreate({ text: mkText('c') });
    await expect(handleUpdate(script.id, { enabled: false })).rejects.toThrow(ENGINE_UNAVAILABLE_MSG);
    await expect(handleDelete(script.id)).rejects.toThrow(ENGINE_UNAVAILABLE_MSG);
    await expect(handleSetEnabled(script.id, false)).rejects.toThrow(ENGINE_UNAVAILABLE_MSG);
  });

  it('syncRegistrations：漂移自愈（库里已删的注销、code 漂移的更新）', async () => {
    const api = installFakeUserScripts();
    await handleCreate({ text: mkText('c1'), enabled: true });
    const all = await listScripts();
    // mock 不反映先前 register——直接喂「已注册」状态：keep（code 陈旧）+ ghost（库里已不存在）
    api.getScripts.mockResolvedValue([
      { id: all[0]!.id, matches: ['https://a.com/*'], js: [{ code: 'stale' }], runAt: 'document_idle', world: 'USER_SCRIPT' },
      { id: 'ghost', matches: ['<all_urls>'], js: [{ code: 'g' }], runAt: 'document_idle', world: 'USER_SCRIPT' },
    ]);
    api.update.mockClear();
    api.unregister.mockClear();
    await syncRegistrations();
    expect(api.update).toHaveBeenCalledTimes(1); // keep: code 漂移 → update
    expect(api.update.mock.calls[0]![0]).toEqual([expect.objectContaining({ id: all[0]!.id, js: [{ code: 'c1' }] })]);
    expect(api.unregister).toHaveBeenCalledWith(['ghost']); // 库里已无 → 注销
  });

  it('handleImport：原文存 text + TM 元数据解析 + warnings 透传', async () => {
    installFakeUserScripts();
    const src = '// ==UserScript==\n// @name imp\n// @match https://i.com/*\n// @grant GM_log\n// ==/UserScript==\nlog();';
    const { script, warnings } = await handleImport(src, 'imp.user.js');
    expect(script.text).toBe(src);
    expect(script).toMatchObject({ name: 'imp', enabled: true, source: 'import', matches: ['https://i.com/*'] });
    expect(warnings.some((w) => w.includes('GM_*'))).toBe(true);
  });

  it('handleImport：@include pattern 形式并入 matches 生效', async () => {
    installFakeUserScripts();
    const src = '// ==UserScript==\n// @name inc\n// @include https://i.com/*\n// ==/UserScript==\nlog();';
    const { script } = await handleImport(src);
    expect(script.matches).toEqual(['https://i.com/*']);
  });

  it('initScriptsModule：挂 8 个 handler + tabs 监听 + 启动 sync', async () => {
    const api = installFakeUserScripts();
    const router = new MessageRouter();
    vi.spyOn(browser.tabs.onUpdated, 'addListener').mockImplementation(() => {});
    vi.spyOn(browser.tabs.onRemoved, 'addListener').mockImplementation(() => {});

    initScriptsModule(router);
    // 空库时启动 sync 无缺失注册可补（register 不会被调）；getScripts 仅由启动自愈 sync 触达
    await vi.waitFor(() => expect(api.getScripts).toHaveBeenCalled());

    // 8 个 handler 全部有注册（未注册类型才会报 no handler；SCRIPTS_GET 无参走 handleGet throw → router 兜底 ok:false）
    for (const type of ['SCRIPTS_LIST', 'SCRIPTS_GET', 'SCRIPTS_CREATE', 'SCRIPTS_UPDATE', 'SCRIPTS_DELETE', 'SCRIPTS_SET_ENABLED', 'SCRIPTS_IMPORT', 'SCRIPTS_GET_RUNTIME']) {
      const r = await router.dispatch({ type } as { type: string });
      expect(r).not.toMatchObject({ error: expect.stringContaining('no handler') });
    }
  });

  it('initScriptsModule：SCRIPTS_LIST 返回 engineAvailable + 摘要；GET 未知 id 报错；GET 区间透传', async () => {
    installFakeUserScripts();
    await handleCreate({ text: mkText('h1\nh2') });
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

    const all = await listScripts();
    const sliced = (await router.dispatch({ type: 'SCRIPTS_GET', id: all[0]!.id, offset: 5, limit: 1 })) as { ok: boolean; data?: { script: { text: string }; startLine: number; totalLines: number } };
    expect(sliced.ok).toBe(true);
    expect(sliced.data).toMatchObject({ startLine: 5, totalLines: 6 });
    expect(sliced.data!.script.text).toBe('h1');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/background/scripts.test.ts`
Expected: FAIL（`handleGet`/`spliceLines` 不存在；handleCreate 仍按字段式处理）

- [ ] **Step 3: 修改 `background/scripts.ts`**

3a. 顶部 import 区替换为：

```ts
import type { MessageRouter } from './router';
import type { ScriptGetData, ScriptInput, ScriptPatch, ScriptsRuntimeEntry } from '../shared/messages';
import type { ScriptRunAt, ScriptSource, ScriptWorld, UserScript } from '../shared/types';
import { deleteScript, getScript, listScripts, saveScript, toSummary, MAX_CODE_LENGTH, MAX_TEXT_LENGTH } from '../storage/scripts';
import { isValidMatchPattern, matchUrl } from '../shared/match-pattern';
import { parseUserScript } from '../shared/userscript-meta';
```

3b. 在 `// ---------- CRUD 编排` 注释之前插入新段：

```ts
// ---------- 文本为源（修订 2026-09-02）：行区间原语 + 解析构建 ----------

/** 行区间替换（1-based 含端点）：非法区间/越界 throw；返回替换后的完整文本。 */
export function spliceLines(text: string, startLine: number, endLine: number, replacement: string): string {
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
    throw new Error(`非法行区间：${startLine}-${endLine}（需 1 ≤ startLine ≤ endLine）`);
  }
  const lines = text.split('\n');
  if (endLine > lines.length) {
    throw new Error(`行区间越界：endLine=${endLine} 超过总行数 ${lines.length}`);
  }
  return [...lines.slice(0, startLine - 1), replacement, ...lines.slice(endLine)].join('\n');
}

/** 文本 → 校验通过的全量 UserScript：投影字段全部由 parseUserScript 生成（spec §6.1 修订）。 */
function buildFromText(args: {
  text: string; id: string; enabled: boolean; source: ScriptSource; createdAt: number; fallbackName?: string;
}): { script: UserScript; warnings: string[] } {
  if (args.text.length > MAX_TEXT_LENGTH) throw new Error(`脚本文本超过上限（${MAX_TEXT_LENGTH} 字符）`);
  const parsed = parseUserScript(args.text, args.fallbackName);
  const errors = validateScriptFields({
    name: parsed.fields.name, code: parsed.fields.code, matches: parsed.fields.matches,
    runAt: parsed.fields.runAt, world: parsed.fields.world,
  });
  if (errors.length > 0) throw new Error(errors.join('；'));
  const script: UserScript = {
    id: args.id,
    text: args.text,
    name: parsed.fields.name,
    enabled: args.enabled,
    matches: parsed.fields.matches,
    code: parsed.fields.code,
    runAt: parsed.fields.runAt,
    world: parsed.fields.world,
    source: args.source,
    meta: Object.keys(parsed.fields.meta).length > 0 ? parsed.fields.meta : undefined,
    createdAt: args.createdAt,
    updatedAt: Date.now(),
  };
  return { script, warnings: parsed.warnings };
}
```

3c. `handleCreate` **整体替换**为：

```ts
export async function handleCreate(input: ScriptInput): Promise<{ script: UserScript; warnings: string[] }> {
  if (typeof input?.text !== 'string' || !input.text.trim()) {
    throw new Error('text 必填：完整的 .user.js 文本（含 ==UserScript== 头）');
  }
  const { script, warnings } = buildFromText({
    text: input.text, id: newId(), enabled: input.enabled ?? true,
    source: input.source ?? 'user', createdAt: Date.now(),
  });
  await saveScript(script);
  const syncWarnings = await syncBestEffort();
  await recomputeAllTabs().catch(() => {});
  return { script, warnings: [...warnings, ...syncWarnings] };
}
```

3d. `handleUpdate` **整体替换**为：

```ts
export async function handleUpdate(id: string, patch: ScriptPatch): Promise<UserScript> {
  await requireEngine(); // spec §6.1：改注册类操作引擎不可用直接报固定文案
  const existing = await getScript(id);
  if (!existing) throw new Error(`脚本不存在：${id}`);
  if (patch.text === undefined && patch.edit === undefined && patch.enabled === undefined) {
    throw new Error('patch 至少包含 text / enabled / edit 之一');
  }
  let next: UserScript;
  if (patch.text !== undefined || patch.edit) {
    // 文本路径：整文替换或行区间 splice 后整体重解析（文本为源，投影字段全部重建）
    let text = existing.text;
    if (patch.edit) {
      text = spliceLines(text, patch.edit.startLine, patch.edit.endLine, patch.edit.text);
    } else if (typeof patch.text === 'string' && patch.text.trim()) {
      text = patch.text;
    } else {
      throw new Error('text 必填：完整的 .user.js 文本（含 ==UserScript== 头）');
    }
    next = buildFromText({
      text, id: existing.id, enabled: patch.enabled ?? existing.enabled,
      source: existing.source, createdAt: existing.createdAt,
    }).script;
  } else {
    // 仅启停：不重解析
    next = { ...existing, enabled: patch.enabled as boolean, updatedAt: Date.now() };
  }
  await saveScript(next);
  await syncRegistrations();
  await recomputeAllTabs().catch(() => {});
  return next;
}
```

3e. `handleGet` 新增（放在 `handleUpdate` 之后）：

```ts
/** 行区间读取（修订 2026-09-02）：offset/limit 缺省全文；1-based、越界钳制、limit 缺省读到末尾。 */
export async function handleGet(id: string, offset?: number, limit?: number): Promise<ScriptGetData> {
  const script = await getScript(id);
  if (!script) throw new Error(`脚本不存在：${id}`);
  const lines = script.text.split('\n');
  const totalLines = lines.length;
  if (offset === undefined && limit === undefined) {
    return { script, totalLines, startLine: 1, endLine: totalLines };
  }
  const rawStart = Math.trunc(offset ?? 1);
  const rawEnd = limit === undefined ? totalLines : rawStart + Math.max(1, Math.trunc(limit)) - 1;
  const startLine = Math.min(Math.max(1, rawStart), totalLines);
  const endLine = Math.min(Math.max(1, rawEnd), totalLines);
  const text = startLine > endLine ? '' : lines.slice(startLine - 1, endLine).join('\n');
  return { script: { ...script, text }, totalLines, startLine, endLine };
}
```

3f. `handleImport` **整体替换**为：

```ts
export async function handleImport(text: string, filename?: string): Promise<{ script: UserScript; warnings: string[] }> {
  const { script, warnings } = buildFromText({
    text, id: newId(), enabled: true, source: 'import', createdAt: Date.now(), fallbackName: filename,
  });
  await saveScript(script);
  const syncWarnings = await syncBestEffort();
  await recomputeAllTabs().catch(() => {});
  return { script, warnings: [...warnings, ...syncWarnings] };
}
```

3g. `initScriptsModule` 内两个 handler 替换：

```ts
  router.on('SCRIPTS_GET', async (msg) => {
    const { id, offset, limit } = msg as unknown as { id: string; offset?: number; limit?: number };
    return { ok: true, data: await handleGet(id, offset, limit) };
  });
```

```ts
  router.on('SCRIPTS_IMPORT', async (msg) => {
    const { text, filename } = msg as unknown as { text: string; filename?: string };
    const { script, warnings } = await handleImport(text, filename);
    return { ok: true, data: { script, warnings } };
  });
```

（`validateScriptFields`、注册同步、运行态跟踪、其余 handler 均不动。）

- [ ] **Step 4: 跑本 task 测试确认通过**

Run: `npx vitest run tests/background/scripts.test.ts tests/storage/scripts.test.ts tests/shared/`
Expected: PASS

> 仍为计划内中间态：compile 因工具/UI 未适配而报错。

- [ ] **Step 5: 提交**

```bash
git add background/scripts.ts tests/background/scripts.test.ts
git commit -m "feat(scripts): 编排层文本为源——handleCreate/Update 走解析投影 + spliceLines/handleGet 行区间"
```

---

### Task 5: 工具层——三 schema 修订 + 执行器文本化

**Files:**
- Modify: `agent/tools/schemas.ts`（get_script / create_script / update_script 三个块整体替换）
- Modify: `agent/tools/script-pool.ts`（整体替换）
- Test: `tests/agent/tools/script-pool.test.ts`（整体替换）、`tests/agent/tools/schemas.test.ts`（替换 1 个用例）

**Interfaces:**
- Consumes: Task 4 的 `handleGet(id, offset?, limit?)`、`parseUserScript`。
- Produces:
  - `get_script` 参数 `{ id, offset?, limit? }`；`create_script` 参数 `{ source, enabled? }`（**工具参数名 source**，spec §8 冻结；执行器内部映射到编排层字段 `text`）；`update_script` 参数 `{ id, patch: { text?, enabled?, edit? } }`
  - `doCreateScript(args: { source?: string; text?: string; enabled?: boolean })`：text 缺失/空白报错、解析后无匹配规则报错、落库 source 强制 `'agent'`
  - `doGetScript(args: { id, offset?, limit? })` 透传 `handleGet`
  - `list_scripts`/`delete_script`/`toggle_script` 与 registry 分发不变（工具总数仍 22）

- [ ] **Step 1: 替换测试文件**

`tests/agent/tools/script-pool.test.ts` **整体替换**为：

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

/** 标准 TM 头 + 代码体：4 行头 + 空行 + body 各行 */
const mkTm = (name: string, match: string, body = 'c();'): string =>
  `// ==UserScript==\n// @name ${name}\n// @match ${match}\n// ==/UserScript==\n\n${body}`;

describe('script-pool 工具执行器', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
    // sendMessage 的重载让 mock 返回类型推断为 void，这里 as never 只为过编译，不改变运行时（同 registry.test.ts）
    vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({} as never);
  });

  it('create_script：文本化创建（source 参数）+ 强制 agent 来源；无匹配规则/缺 source 报错', async () => {
    installFakeUserScripts();
    const ok = await doCreateScript({ source: mkTm('n', 'https://a.com/*') });
    expect(ok.ok).toBe(true);
    const saved = (await listScripts())[0]!;
    expect(saved.source).toBe('agent');
    expect(saved).toMatchObject({ name: 'n', code: 'c();', matches: ['https://a.com/*'] });

    const empty = await doCreateScript({ source: 'console.log(1);' });
    expect(empty).toMatchObject({ ok: false });
    expect((empty as { error: string }).error).toContain('@match');

    const missing = await doCreateScript({});
    expect(missing).toMatchObject({ ok: false });
    expect((missing as { error: string }).error).toContain('source');
  });

  it('list_scripts：摘要无 code/text；enabled/urlContains 过滤', async () => {
    installFakeUserScripts();
    await doCreateScript({ source: mkTm('alpha', 'https://a.com/*') });
    await doCreateScript({ source: mkTm('beta', 'https://b.com/*'), enabled: false });

    const all = await doListScripts({});
    expect(all.ok).toBe(true);
    const scripts = (all as { data: { scripts: Array<Record<string, unknown>> } }).data.scripts;
    expect(scripts).toHaveLength(2);
    for (const s of scripts) {
      expect(s).not.toHaveProperty('code');
      expect(s).not.toHaveProperty('text');
    }

    expect(((await doListScripts({ enabled: true })) as { data: { scripts: unknown[] } }).data.scripts).toHaveLength(1);
    const filtered = (await doListScripts({ urlContains: 'b.com' })) as { data: { scripts: Array<{ name: string }> } };
    expect(filtered.data.scripts.map((s) => s.name)).toEqual(['beta']);
  });

  it('get_script：全文 + totalLines；行区间切片；未知 id 报错', async () => {
    installFakeUserScripts();
    const created = (await doCreateScript({ source: mkTm('n', 'https://a.com/*', 'a();\nb();') })) as { data: { script: { id: string } } };
    const id = created.data.script.id;
    // mkTm 7 行：4 头 + 空行 + 2 行 body

    const full = (await doGetScript({ id })) as { data: { script: { text: string; code: string }; totalLines: number; startLine: number; endLine: number } };
    expect(full.data.script.code).toBe('a();\nb();');
    expect(full.data).toMatchObject({ totalLines: 7, startLine: 1, endLine: 7 });
    expect(full.data.script.text).toContain('@name');

    const slice = (await doGetScript({ id, offset: 6, limit: 2 })) as { data: { script: { text: string }; startLine: number; endLine: number; totalLines: number } };
    expect(slice.data.script.text).toBe('a();\nb();');
    expect(slice.data).toMatchObject({ startLine: 6, endLine: 7, totalLines: 7 });

    expect(await doGetScript({ id: 'nope' })).toMatchObject({ ok: false });
  });

  it('update_script：text 整文替换 + edit 行区间 + toggle/delete 全链路', async () => {
    installFakeUserScripts();
    const created = (await doCreateScript({ source: mkTm('n', 'https://a.com/*', 'v1;') })) as { data: { script: { id: string } } };
    const id = created.data.script.id;

    expect((await doUpdateScript({ id, patch: { text: mkTm('n2', 'https://a.com/*', 'v2;') } })).ok).toBe(true);
    expect((await listScripts())[0]!.code).toBe('v2;');
    expect((await listScripts())[0]!.name).toBe('n2');

    // mkTm('n2',…,'v2;') 6 行：4 头 + 空行 + 第 6 行 v2;
    expect((await doUpdateScript({ id, patch: { edit: { startLine: 6, endLine: 6, text: 'x();' } } })).ok).toBe(true);
    expect((await listScripts())[0]!.code).toBe('x();');

    expect((await doToggleScript({ id, enabled: false })).ok).toBe(true);
    expect((await listScripts())[0]!.enabled).toBe(false);
    expect((await doDeleteScript({ id })).ok).toBe(true);
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

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/agent/tools/script-pool.test.ts`
Expected: FAIL（create_script 仍按 name/code/matches 处理）

- [ ] **Step 3: 替换 `agent/tools/schemas.ts` 三个 schema 块**

`get_script` 块（`name: 'get_script'` 所在对象）**整体替换**为：

```ts
  {
    type: 'function',
    function: {
      name: 'get_script',
      description:
        '读取单个用户脚本：完整 text（.user.js 原文）+ 解析投影 + totalLines 总行数。可选 offset/limit 读取行区间（1-based 含端点，越界自动钳制；limit 缺省读到末尾），此时 script.text 为切片、startLine/endLine 为实际返回区间。id 来自 list_scripts。',
      parameters: obj(
        {
          id: { type: 'string', description: '脚本 id' },
          offset: { type: 'number', description: '起始行（1-based，缺省 1）' },
          limit: { type: 'number', description: '行数（缺省读到末尾）' },
        },
        ['id'],
      ),
    },
  },
```

`create_script` 块**整体替换**为：

```ts
  {
    type: 'function',
    function: {
      name: 'create_script',
      description:
        '创建用户脚本：以浏览器用户脚本权限在头部匹配规则命中的页面上自动运行。创建前先向用户说明脚本用途与作用范围。source 是完整的 .user.js 文本（含 ==UserScript== 元数据头）——头部 @字段 即配置（@name/@match/@include/@run-at/@world/@grant），没有独立的名称/匹配参数。代码以页面脚本方式原样执行，无 GM_* API。解析后须有匹配规则（@match 或 pattern 形式的 @include）。',
      parameters: obj(
        {
          source: { type: 'string', description: '完整 .user.js 文本（含 ==UserScript== 元数据头）' },
          enabled: { type: 'boolean', description: '创建后是否立即启用，默认 true' },
        },
        ['source'],
      ),
    },
  },
```

`update_script` 块**整体替换**为：

```ts
  {
    type: 'function',
    function: {
      name: 'update_script',
      description:
        '更新用户脚本。patch 至少一项：text 整文替换（完整 .user.js 原文，重新解析头部）；edit 行区间替换（1-based 含端点，越界报错，替换后整体重解析）；enabled 启停。改头部字段（名称/匹配/时机等）就是改原文，没有独立字段可改。规则/代码更新在下次页面导航后生效。',
      parameters: obj(
        {
          id: { type: 'string', description: '脚本 id' },
          patch: {
            type: 'object',
            description: '至少包含 text / enabled / edit 之一',
            properties: {
              text: { type: 'string', description: '整文替换：完整 .user.js 原文' },
              enabled: { type: 'boolean', description: '启停' },
              edit: {
                type: 'object',
                description: '行区间替换（在当前原文上 splice 后整体重解析）',
                properties: {
                  startLine: { type: 'number', description: '起始行（1-based）' },
                  endLine: { type: 'number', description: '结束行（含端点）' },
                  text: { type: 'string', description: '替换文本（可多行）' },
                },
                required: ['startLine', 'endLine', 'text'],
              },
            },
          },
        },
        ['id', 'patch'],
      ),
    },
  },
```

- [ ] **Step 4: 整体替换 `agent/tools/script-pool.ts`**

```ts
// agent/tools/script-pool.ts
// 脚本池六工具执行器（spec §8 + 2026-09-02 修订：文本为源）。与 UI 共用 background/scripts 编排层——AI 改脚本 = 用户改脚本，行为零分叉。
// 全部豁免受限页预检（registry 在 RESTRICTED 检查之前分发）：不碰页面内容，纯 storage/注册操作。

import type { ToolResult } from '../../shared/types';
import type { ScriptPatch } from '../../shared/messages';
import { parseUserScript } from '../../shared/userscript-meta';
import { listScripts, toSummary } from '../../storage/scripts';
import {
  handleCreate, handleDelete, handleGet, handleSetEnabled, handleUpdate,
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

export async function doGetScript(args: { id: string; offset?: number; limit?: number }): Promise<ToolResult> {
  try {
    // data: { script, totalLines, startLine, endLine }；传区间时 script.text 为行切片（spec §8 修订）
    return { ok: true, data: await handleGet(args.id, args.offset, args.limit) };
  } catch (e) {
    return { ok: false, error: `get_script 失败：${err(e)}` };
  }
}

export async function doCreateScript(args: { source?: string; text?: string; enabled?: boolean }): Promise<ToolResult> {
  try {
    // 工具参数名是 source（spec §8 冻结），编排层字段名是 text——此处做名称映射；text 别名留给内部调用
    const text = typeof args.source === 'string' ? args.source : args.text;
    // matches 非空是工具层约束（spec §8：解析头部后有匹配规则才创建）；编排层允许空 matches（导入场景）
    if (typeof text !== 'string' || !text.trim()) {
      return { ok: false, error: 'create_script 需要 source：完整的 .user.js 文本（含 ==UserScript== 元数据头）' };
    }
    if (parseUserScript(text).fields.matches.length === 0) {
      return { ok: false, error: 'create_script 解析后无匹配规则：请在头部添加 @match（pattern 形式的 @include 也计入）' };
    }
    const { script, warnings } = await handleCreate({ text, enabled: args.enabled, source: 'agent' });
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

- [ ] **Step 5: 替换 `tests/agent/tools/schemas.test.ts` 的 create_script 用例**

把用例 `it('create_script：name/code/matches 必填，runAt/world 枚举', ...)` **整体替换**为：

```ts
  it('create_script：source 必填；update_script patch.edit 行区间；get_script 行区间参数', () => {
    const create = TOOL_SCHEMAS.find((s) => s.function.name === 'create_script')!;
    const cp = create.function.parameters as { properties: Record<string, { type: string }>; required: string[] };
    expect(cp.required).toEqual(['source']);
    expect(cp.properties.source!.type).toBe('string');

    const update = TOOL_SCHEMAS.find((s) => s.function.name === 'update_script')!;
    const up = update.function.parameters as {
      properties: { patch: { properties: Record<string, { required?: string[] }> } };
      required: string[];
    };
    expect(up.required).toEqual(['id', 'patch']);
    expect(up.properties.patch.properties.edit!.required).toEqual(['startLine', 'endLine', 'text']);

    const get = TOOL_SCHEMAS.find((s) => s.function.name === 'get_script')!;
    const gp = get.function.parameters as { properties: Record<string, { type: string }>; required: string[] };
    expect(gp.required).toEqual(['id']);
    expect(gp.properties.offset!.type).toBe('number');
    expect(gp.properties.limit!.type).toBe('number');
  });
```

（22 个工具计数用例、toggle_script 用例、其余用例不动。）

- [ ] **Step 6: 跑本 task 测试确认通过**

Run: `npx vitest run tests/agent/tools/`
Expected: PASS（含 registry.test.ts 等其余工具测试）

- [ ] **Step 7: 提交**

```bash
git add agent/tools/schemas.ts agent/tools/script-pool.ts tests/agent/tools/script-pool.test.ts tests/agent/tools/schemas.test.ts
git commit -m "feat(scripts): 工具层文本化——create_script source 参数、get_script 行区间、update_script text/edit patch"
```

---

### Task 6: UI——详情页源码编辑器 + 列表页文本化新建/导入

**Files:**
- Modify: `components/scripts/ScriptDetailView.tsx`（整体替换）
- Modify: `components/scripts/ScriptsListView.tsx`（3 处替换）

**Interfaces:**
- Consumes: Task 2 `SCRIPTS_GET { id } → ScriptGetData`（含 `script.text`）、`SCRIPTS_IMPORT { text, filename? }`、`SCRIPTS_CREATE { input: { text } }`、Task 1 `parseUserScript`。
- Produces: 无下游消费者（UI 是末端）。无新增样式（复用 `.scripts-run`/`.scripts-warnline`/`.script-editor`）。

- [ ] **Step 1: 整体替换 `components/scripts/ScriptDetailView.tsx`**

```tsx
// components/scripts/ScriptDetailView.tsx
// 脚本详情页（spec §9.2 修订：文本为源）——源码 textarea + 实时解析面板 + 保存/启停/删除/导出/重载当前页。
// text（.user.js 原文）是唯一真源：头部 @字段 即配置，解析面板随输入实时重算，保存 patch { text }。
import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Download, Power, RotateCw, Save, Trash2 } from 'lucide-react';
import { PageShell } from '../ui/PageShell';
import { Button } from '../ui/Button';
import { sendScriptsRequest, useScripts } from '../../stores/scripts';
import { useUi } from '../../stores/ui';
import { parseUserScript } from '../../shared/userscript-meta';
import type { UserScript } from '../../shared/types';

export function ScriptDetailView({ id }: { id: string }) {
  const openScript = useUi((s) => s.openScript);
  const [script, setScript] = useState<UserScript | null>(null);
  const [text, setText] = useState('');
  const [notFound, setNotFound] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const resp = await sendScriptsRequest<{ ok: boolean; data?: { script: UserScript }; error?: string }>({
          type: 'SCRIPTS_GET',
          id,
        });
        if (cancelled) return;
        if (resp.ok && resp.data) {
          setScript(resp.data.script);
          setText(resp.data.script.text);
        } else {
          setNotFound(true);
        }
      } catch {
        // 传输异常（如 SW 死亡）时兜底为未找到，避免永停「加载中」
        if (!cancelled) setNotFound(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  // 实时解析：头部即配置，所见即所得（仅预览——保存才落库重注册）
  const parsed = useMemo(() => parseUserScript(text), [text]);
  const f = parsed.fields;

  // 启停当前脚本（头部之外的运行时开关，同 TM）
  async function toggleEnabled(): Promise<void> {
    if (!script) return;
    const resp = await sendScriptsRequest<{ ok: boolean; data?: { script: UserScript }; error?: string }>({
      type: 'SCRIPTS_SET_ENABLED',
      id: script.id,
      enabled: !script.enabled,
    });
    if (resp.ok && resp.data) {
      setScript(resp.data.script);
      setMessage(resp.data.script.enabled ? '已启用，刷新页面生效' : '已禁用，刷新页面生效');
      await useScripts.getState().refresh();
    } else {
      setMessage(resp.error ?? '操作失败');
    }
  }

  async function save(): Promise<void> {
    if (!script) return;
    const resp = await sendScriptsRequest<{ ok: boolean; data?: { script: UserScript }; error?: string }>({
      type: 'SCRIPTS_UPDATE',
      id: script.id,
      patch: { text },
    });
    if (resp.ok && resp.data) {
      setScript(resp.data.script);
      setDirty(false);
      setMessage('已重新注册，刷新页面生效');
      await useScripts.getState().refresh();
    } else {
      setMessage(resp.error ?? '保存失败');
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
    // 修订：直接下载原文（不再反向拼头部）
    const url = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(script.name || 'script').replace(/[\\/:*?"<>|]/g, '_')}.user.js`;
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
      title={f.name || script.name || '未命名脚本'}
      eyebrow="SCRIPT"
      actions={
        <Button variant="ghost" onClick={() => openScript(null)} aria-label="返回">
          <ArrowLeft size={14} />
        </Button>
      }
    >
      <div style={{ display: 'grid', gap: 10 }}>
        <div className="scripts-run">
          <div className="scripts-run__head mono">HEADER · 实时解析（头部即配置）</div>
          <div className="scripts-run__item">
            <div>name: {f.name || '（未设置）'}</div>
            {f.meta.version && <div>version: {f.meta.version}</div>}
            {f.meta.author && <div>author: {f.meta.author}</div>}
            {f.meta.description && <div>{f.meta.description}</div>}
            <div className="mono">match: {f.matches.length > 0 ? f.matches.join('  ') : '（无——脚本不会运行）'}</div>
            <div className="mono">run-at: {f.runAt} · world: {f.world}</div>
            {f.meta.grants && f.meta.grants.length > 0 && (
              <div className="scripts-warnline">
                需要 GM_* API（{f.meta.grants.join(', ')}）——本扩展不支持，脚本调用会报错
              </div>
            )}
          </div>
          {parsed.warnings.length > 0 && (
            <div className="scripts-warnline">
              {parsed.warnings.map((w, i) => (
                <div key={i}>{w}</div>
              ))}
            </div>
          )}
        </div>

        <div>
          <label className="scripts-run__head" htmlFor="sc-text" style={{ marginBottom: 0 }}>
            源码（.user.js 原文，头部 @字段 即配置）
          </label>
          <textarea
            id="sc-text"
            className="script-editor"
            spellCheck={false}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setDirty(true);
            }}
            onKeyDown={(e) => {
              // Tab 键插入两空格（轻量编辑器约定，spec §2 非目标：不做 CodeMirror）
              if (e.key === 'Tab') {
                e.preventDefault();
                const el = e.currentTarget;
                const { selectionStart, selectionEnd, value } = el;
                el.value = `${value.slice(0, selectionStart)}  ${value.slice(selectionEnd)}`;
                el.selectionStart = el.selectionEnd = selectionStart + 2;
                setText(el.value);
                setDirty(true);
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
          <Button onClick={() => void toggleEnabled()}>
            <Power size={14} color={script.enabled ? 'var(--ok)' : 'var(--ink-3)'} /> {script.enabled ? '禁用' : '启用'}
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

- [ ] **Step 2: 修改 `components/scripts/ScriptsListView.tsx`（3 处）**

2a. `SOURCE_LABEL` 常量之后追加模板常量：

```ts
// 新建模板：带头部骨架（spec §9.1 修订：头部即配置，落地直接进详情页编辑原文）
const NEW_SCRIPT_TEMPLATE = [
  '// ==UserScript==',
  '// @name        未命名脚本',
  '// @match       *://*/*',
  '// @run-at      document-idle',
  '// ==/UserScript==',
  '',
  '',
].join('\n');
```

2b. `createNew` **整体替换**为：

```ts
  async function createNew(): Promise<void> {
    const resp = await sendScriptsRequest<{ ok: boolean; data?: { script: { id: string } }; error?: string }>({
      type: 'SCRIPTS_CREATE',
      input: { text: NEW_SCRIPT_TEMPLATE },
    });
    if (resp.ok && resp.data) {
      await useScripts.getState().refresh();
      openScript(resp.data.script.id);
    }
  }
```

2c. `importFile` 开头两行替换（`source` → `text`，响应类型不变）：

```ts
  async function importFile(file: File): Promise<void> {
    const text = await file.text();
    const resp = await sendScriptsRequest<{ ok: boolean; data?: { script: { id: string }; warnings: string[] }; error?: string }>({
      type: 'SCRIPTS_IMPORT',
      text,
      filename: file.name,
    });
```

（`importFile` 的其余部分、`setEnabled`、render 全不动。）

- [ ] **Step 3: 编译 + 构建恢复全绿（本修订的 compile 恢复点）**

Run: `npm run compile && npm run build`
Expected: 全绿。若仍报错，只允许修本 task 范围内的遗漏适配（如 stores/scripts.ts 的类型引用）；超出范围的报错停下上报，不要顺手大修。

Run: `npx vitest run`
Expected: 全绿（此前各 task 的中间态红在本步收拢）。

- [ ] **Step 4: 提交**

```bash
git add components/scripts/ScriptDetailView.tsx components/scripts/ScriptsListView.tsx
git commit -m "feat(scripts): 详情页文本为源——源码编辑器+实时解析面板；列表页模板化新建/导入 text 字段"
```

---

### Task 7: 收尾——CLAUDE.md 修订记录 + 全量回归

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: CLAUDE.md「当前阶段」Phase 4 段末尾追加一句**

在 `（工具 16→22，与 UI 共用 `background/scripts.ts` 编排层；确认门控下阶段经该文件 handler 拦截位接入 `confirmGate`）。` 之后追加：

```markdown
Phase 4 修订（2026-09-02，文本为源）：`UserScript.text`（完整 .user.js 原文）为唯一真源，name/matches/code/runAt/world/meta 均为保存时 `parseUserScript` 的解析投影（旧记录 `stringifyUserScript` 反拼惰性迁移，text 上限 280KB）；`@include` pattern 形式并入 matches、新增 `@world` 键；详情页=源码编辑器+实时解析面板（无表单填空）；工具修订：`get_script` 行区间读取（offset/limit + totalLines）、`create_script` 参数改 `source`（完整 .user.js 文本）、`update_script` patch={text | edit 行区间 | enabled}，替换后整体重解析。
```

- [ ] **Step 2: 全量回归**

Run: `npm run compile && npm test && npm run build`
Expected: 全绿。

- [ ] **Step 3: 提交**

```bash
git add CLAUDE.md
git commit -m "docs: CLAUDE.md 记录 Phase 4 文本为源修订"
```

---

## Self-Review 记录（计划写毕自检）

1. **Spec 覆盖**：spec §4 text/上限/迁移 → T2/T3；§5.1 @include+@world/警告 → T1；§5.2 stringify 兜底化 → T1；§5.3 导出原文 → T6；§6.1 文本为源 CRUD/行区间 → T4；§7 协议 → T2/T4；§8 三工具 → T5；§9 UI → T6；§13 参数冻结修订说明 → T7（CLAUDE.md）+ spec 状态行。无缺口。
2. **占位符**：无 TBD/TODO；所有代码步骤给出完整代码。
3. **类型一致性**：`ScriptGetData{script,totalLines,startLine,endLine}`（T2 定义 = T4 实现 = T5 schema 描述 = T6 消费）；工具参数名 `source` ↔ 编排层字段 `text` 的映射只在 T5 `doCreateScript` 一处；行号 1-based 含端点贯穿 T4/T5/T6；`MAX_TEXT_LENGTH` 只在 T3 定义、T4 导入。
4. **已知取舍（Ruling 记录）**：`update_script` 的 text 路径在 `patch.text` 非字符串/空白时报「text 必填」而非静默忽略（防御运行时垃圾输入）；`handleGet` 只传 limit 不传 offset 时按 offset=1 起读；`initScriptsModule` 8-type 探针依赖 router 对 throw 的 catch 包装（`background/router.ts` 现状，不新增依赖）。
