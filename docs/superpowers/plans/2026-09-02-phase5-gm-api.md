# Phase 5：GM_* API 支持 + 脚本管理器优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给脚本池补上 14 个 GM_* API（wrapper + ISOLATED 事件桥 + SW 实现中心 + @connect 确认流）、脚本错误捕获展示、grant 徽标精确化、菜单命令入口、@require/@resource 支持，并写脚本作者文档。

**Architecture:** 注册时用纯函数 `buildWrappedCode` 给带 grant 的脚本前置 wrapper（preamble 内联 + GM 对象按 @grant 精确安装 + 值快照直嵌）；GM_* 调用经 window CustomEvent 桥（确定性 token 防伪）到同帧 ISOLATED content script，再 `runtime.sendMessage` 到 SW 的 `background/gm-api.ts` 统一分发（@grant 白名单校验 + GM_xmlhttpRequest 的 @connect 三分支确认流）。复用现有 MessageRouter / matchUrl / fakeBrowser 测试惯例。

**Tech Stack:** WXT + React 19 + TypeScript 7 + Zustand + vitest（fakeBrowser / jsdom per-file 注释）。工作区：`D:\workspace-mou8\ai-browser-extend\.claude\worktrees\phase4-script-pool`（`feature/phase4-script-pool` 分支续作，**所有 shell 命令都在此目录执行**）。

**Spec:** `docs/superpowers/specs/2026-09-02-ai-browser-extension-phase5-gm-api-design.md`；API 全集：`docs/gm-api.md`。

**测试命令统一为：** `npx vitest run <file> --passWithNoTests`（下文简称 `vitest run <file>`）。全量回归 `npm run test`，类型检查 `npm run compile`。

---

## 文件结构总览

```text
shared/
  gm-apis.ts          (新) API 注册表 + classifyGrants（纯函数）
  gm-bridge.ts        (新) 桥协议常量 + payload 类型（三界共用）
  gm-wrapper.ts       (新) buildWrappedCode：preamble 模板 + 拼装（纯函数）
  userscript-meta.ts  (改) @connect/@require/@resource 进 meta；grant 警告按注册表
  types.ts            (改) UserScriptMeta + connects/requires/resources；ScriptSummary + errorCount/hasRequires
  messages.ts         (改) +GM 桥消息 + 菜单/错误/确认消息
background/
  gm-token.ts         (新) seed 管理 + 确定性 token 派生（async，SW 专用）
  gm-permissions.ts   (新) always 授权读写（storage 薄封装）
  gm-resources.ts     (新) @require/@resource 预取 + 缓存（storage 薄封装）
  gm-api.ts           (新) SW 侧实现中心：GM_API_CALL 分发、值存储、菜单表、错误缓冲、@connect 确认
  scripts.ts          (改) toRegisterDetails 走 buildWrappedCode；CRUD 后 prefetchResources；清理菜单/错误表
content/
  gm-bridge-host.ts   (新) ISOLATED 侧桥宿主：token 获取、事件转发、下行分发
entrypoints/
  content.ts          (改) main() 挂 initBridgeHost
  background.ts       (改) 挂 initGmApi
components/scripts/
  ScriptsListView.tsx (改) 菜单命令区、错误徽标、grant 徽标精确化、批准卡
  ScriptDetailView.tsx(改) 错误折叠区、grant 可用性列表
  ScriptsConfirmCard.tsx (新) 批准卡
stores/scripts.ts     (改) +errors/menus/confirm 状态
agent/tools/schemas.ts(改) list_scripts 描述
wxt.config.ts          (改) +notifications +clipboardWrite
docs/gm-api.md         (改) 脚本作者文档补实现细节
CLAUDE.md              (改) Phase 5 记录
tests/…                对应测试文件（各任务列出）
```

任务依赖序：Task 1-2（注册表/桥协议，地基）→ 3-4（类型/解析器）→ 5（token）→ 6（wrapper）→ 7（SW 值存储+菜单+错误）→ 8（permissions）→ 9（resources）→ 10（@connect 确认 + XHR）→ 11（SW 编排接线）→ 12（桥宿主）→ 13（store + UI）→ 14（schemas + manifest + 文档 + 收尾）。

---

### Task 1: GM API 注册表（`shared/gm-apis.ts`）

**Files:**
- Create: `shared/gm-apis.ts`
- Test: `tests/shared/gm-apis.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/shared/gm-apis.test.ts
import { describe, it, expect } from 'vitest';
import { GM_API_REGISTRY, classifyGrants } from '../../shared/gm-apis';

describe('GM_API_REGISTRY', () => {
  it('首批 14 个 API 全部有 impl 分支', () => {
    expect(Object.keys(GM_API_REGISTRY).sort()).toEqual([
      'GM_addStyle', 'GM_addValueChangeListener', 'GM_deleteValue', 'GM_getResourceText',
      'GM_getValue', 'GM_info', 'GM_listValues', 'GM_log', 'GM_notification',
      'GM_openInTab', 'GM_registerMenuCommand', 'GM_setClipboard', 'GM_setValue',
      'GM_xmlhttpRequest',
    ]);
  });

  it('每个条目 impl 属于三个分支之一', () => {
    for (const [name, def] of Object.entries(GM_API_REGISTRY)) {
      expect(['snapshot', 'local', 'bridge']).toContain(def.impl);
      expect(typeof def.promiseForm).toBe('boolean');
    }
  });
});

describe('classifyGrants', () => {
  it('按注册表二分：supported / unsupported', () => {
    const r = classifyGrants(['GM_getValue', 'GM_download', 'unsafeWindow', 'none']);
    expect(r.supported).toEqual(['GM_getValue', 'unsafeWindow']);
    expect(r.unsupported).toEqual(['GM_download']);
  });

  it('none 与空数组都归空', () => {
    expect(classifyGrants(['none'])).toEqual({ supported: [], unsupported: [] });
    expect(classifyGrants([])).toEqual({ supported: [], unsupported: [] });
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/shared/gm-apis.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写实现**

```ts
// shared/gm-apis.ts
// GM API 注册表（spec §7）：wrapper 安装、grant 徽标分类（classifyGrants）、docs/gm-api.md 目录的唯一入口。
// impl 分支：snapshot=读注入时直嵌的快照（零桥）；local=当前 world 本地完成；bridge=经事件桥到 SW。
// promiseForm：点形式 GM.xxx 是否返回 Promise（spec §1.3 双形态决策）。

export type GmImpl = 'snapshot' | 'local' | 'bridge';

export interface GmApiDef {
  impl: GmImpl;
  /** 点形式 GM.xxx 的 Promise 包装（GM_info 的 GM.info 是同引用，非 Promise） */
  promiseForm: boolean;
  /** 点形式别名（默认 GM_foo → GM.foo；GM_info → GM.info） */
  dotAlias?: string;
}

export const GM_API_REGISTRY: Record<string, GmApiDef> = {
  GM_info: { impl: 'snapshot', promiseForm: false, dotAlias: 'GM.info' },
  GM_getValue: { impl: 'snapshot', promiseForm: true },
  GM_setValue: { impl: 'bridge', promiseForm: true },
  GM_deleteValue: { impl: 'bridge', promiseForm: true },
  GM_listValues: { impl: 'snapshot', promiseForm: true },
  GM_addValueChangeListener: { impl: 'local', promiseForm: true },
  GM_addStyle: { impl: 'local', promiseForm: true },
  GM_getResourceText: { impl: 'snapshot', promiseForm: true },
  GM_log: { impl: 'local', promiseForm: false },
  GM_registerMenuCommand: { impl: 'bridge', promiseForm: true },
  GM_setClipboard: { impl: 'bridge', promiseForm: true },
  GM_notification: { impl: 'bridge', promiseForm: true },
  GM_openInTab: { impl: 'bridge', promiseForm: true },
  GM_xmlhttpRequest: { impl: 'bridge', promiseForm: true },
};

/** 特殊 grant 名（非函数，但视为「受支持」——wrapper 直接提供值） */
export const SPECIAL_GRANTS = new Set(['unsafeWindow']);

/** grant 列表二分（spec §9.2 徽标精确化）。'none' 与空归空。 */
export function classifyGrants(grants: string[]): { supported: string[]; unsupported: string[] } {
  const supported: string[] = [];
  const unsupported: string[] = [];
  for (const g of grants) {
    if (g === 'none') continue;
    if (GM_API_REGISTRY[g] != null || SPECIAL_GRANTS.has(g)) supported.push(g);
    else unsupported.push(g);
  }
  return { supported, unsupported };
}
```

- [ ] **Step 4: 运行测试通过**

Run: `npx vitest run tests/shared/gm-apis.test.ts`
Expected: PASS（6 用例）

- [ ] **Step 5: Commit**

```bash
git add shared/gm-apis.ts tests/shared/gm-apis.test.ts
git commit -m "feat(gm): GM API 注册表 + classifyGrants（14 API 唯一入口）"
```

---

### Task 2: 桥协议常量与类型（`shared/gm-bridge.ts`）

**Files:**
- Create: `shared/gm-bridge.ts`

本任务无独立测试（纯常量/类型，被 Task 6/7/12 的测试间接覆盖）；`npm run compile` 验证。

- [ ] **Step 1: 写文件**

```ts
// shared/gm-bridge.ts
// GM 桥协议（spec §6）：page wrapper ↔ ISOLATED content script ↔ SW 三界共用的常量与 payload 类型。
// 事件名带 scriptId 后缀（gmreq:<id> / gmres:<id> / gmevt:<id>），token 防伪造（spec §6 确定性派生）。

/** 请求方向：wrapper → content。detail 形状（CustomEvent detail）。 */
export interface GmBridgeRequest {
  token: string;
  reqId: number;
  api: string;
  params: unknown[];
}

/** 响应方向：content → wrapper（同 reqId 配对）。 */
export interface GmBridgeResponse {
  reqId: number;
  ok: boolean;
  data?: unknown;
  error?: string;
}

/** SW → content → wrapper 下行事件（tabs.sendMessage GM_EVENT 的 payload）。 */
export type GmEventKind = 'VALUE_CHANGE' | 'MENU_CLICK' | 'NOTIF_CLICK' | 'TAB_EVENT';

export interface GmEventPayload {
  kind: GmEventKind;
  /** VALUE_CHANGE: { key, oldValue, newValue, remote }；MENU_CLICK: { key }；NOTIF_CLICK: { id, byUser }；TAB_EVENT: { tabId, closed } */
  data: Record<string, unknown>;
}

/** content script → SW：索取当前 URL 的桥 token 表（SW 用 matchUrl 算匹配脚本集）。 */
export interface GmBridgeTokens {
  entries: Array<{ scriptId: string; token: string }>;
}

export const gmReqEvent = (scriptId: string) => `gmreq:${scriptId}`;
export const gmResEvent = (scriptId: string) => `gmres:${scriptId}`;
export const gmEvtEvent = (scriptId: string) => `gmevt:${scriptId}`;
```

- [ ] **Step 2: 类型检查**

Run: `npm run compile`
Expected: 无错误

- [ ] **Step 3: Commit**

```bash
git add shared/gm-bridge.ts
git commit -m "feat(gm): 桥协议常量与 payload 类型（三界共用）"
```

---

### Task 3: 类型增量（`shared/types.ts`）

**Files:**
- Modify: `shared/types.ts`
- Test: `tests/shared/messages.test.ts`（沿用现有消息测试文件追加类型编译断言）

- [ ] **Step 1: 修改 `shared/types.ts`**

`UserScriptMeta` 接口追加三个可选字段（在 `noframes` 之前）：

```ts
  /** @connect 域名白名单（GM_xmlhttpRequest 跨域放行表，spec §8.1） */
  connects?: string[];
  /** @require URL 列表（创建/更新时预取，wrapper 前置拼接） */
  requires?: string[];
  /** @resource name → url（GM_getResourceText 的数据源） */
  resources?: Record<string, string>;
```

`ScriptSummary` 接口追加（在 `hasGrants` 之后）：

```ts
  /** SW 错误环形缓冲当前条数（0 = 无错误；spec §9.1） */
  errorCount: number;
  /** 有 @require（资源缺失时详情页提示，spec §9.4） */
  hasRequires: boolean;
```

- [ ] **Step 2: 修复编译错误**

`storage/scripts.ts` 的 `toSummary` 需要补这两个字段（模块级 `errorCounts` 参数化——storage 层不持有 SW 内存态，由调用方传入）：

```ts
// storage/scripts.ts —— toSummary 签名改为接收错误计数（SW 内存态由编排层持有）
export function toSummary(s: UserScript, errorCount = 0): ScriptSummary {
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
    errorCount,
    hasRequires: (s.meta?.requires?.length ?? 0) > 0,
  };
}
```

`background/scripts.ts` 的 `SCRIPTS_LIST` handler 改为（`gmErrors` 从 `background/gm-api.ts` 导入——该模块 Task 7 才创建，此处先以占位导入零值兼容，Task 7 完成后自然生效）：

```ts
import { gmErrorCounts } from './gm-api'; // Task 7 提供：Record<scriptId, number>（无错误为 0）

router.on('SCRIPTS_LIST', async () => ({
  ok: true,
  data: {
    scripts: (await listScripts()).map((s) => toSummary(s, gmErrorCounts()[s.id] ?? 0)),
    engineAvailable: engineAvailable(),
  },
}));
```

Task 7 之前先在 `background/gm-api.ts` 写最小占位（避免编译失败）：

```ts
// background/gm-api.ts（Task 7 会完整实现；此处先占位满足 Task 3 编译）
export function gmErrorCounts(): Record<string, number> { return {}; }
```

`agent/tools/script-pool.ts` 的 `doListScripts` 同步改：

```ts
let scripts = (await listScripts()).map((s) => toSummary(s, gmErrorCounts()[s.id] ?? 0));
```

（文件头补 `import { gmErrorCounts } from '../../background/gm-api';`）

- [ ] **Step 3: 全量测试回归**

Run: `npm run test`
Expected: 全部 PASS（toSummary 默认参数 0，既有断言不破坏；若 `tests/storage/scripts.test.ts` 有 toSummary 精确断言则更新为含 `errorCount: 0, hasRequires: false`）

- [ ] **Step 4: Commit**

```bash
git add shared/types.ts storage/scripts.ts background/gm-api.ts agent/tools/script-pool.ts tests/
git commit -m "feat(gm): 类型增量——meta connects/requires/resources、summary errorCount/hasRequires"
```

---

### Task 4: 解析器升级（`shared/userscript-meta.ts`）

**Files:**
- Modify: `shared/userscript-meta.ts`
- Test: `tests/shared/userscript-meta.test.ts`

- [ ] **Step 1: 写失败测试（追加到现有 describe）**

```ts
  it('@connect/@require/@resource 解析进 meta（多条去重）', () => {
    const src = [
      '// ==UserScript==',
      '// @name        t',
      '// @match       https://a.com/*',
      '// @connect     api.a.com',
      '// @connect     api.a.com',
      '// @connect     b.com',
      '// @require     https://cdn.example/lib.js',
      '// @require     https://cdn.example/lib.js',
      '// @resource    css https://cdn.example/s.css',
      '// ==/UserScript==',
      'x();',
    ].join('\n');
    const { fields, warnings } = parseUserScript(src);
    expect(fields.meta.connects).toEqual(['api.a.com', 'b.com']);
    expect(fields.meta.requires).toEqual(['https://cdn.example/lib.js']);
    expect(fields.meta.resources).toEqual({ css: 'https://cdn.example/s.css' });
    // connect/require/resource 不再进 ignoredKeys 警告
    expect(warnings.join('\n')).not.toContain('@connect');
    expect(warnings.join('\n')).not.toContain('@require');
  });

  it('grant 警告按注册表判定：有 unsupported 才警示，全 supported 无警告', () => {
    const ok = parseUserScript('// ==UserScript==\n// @name t\n// @match https://a.com/*\n// @grant GM_getValue\n// @grant GM_setValue\n// ==/UserScript==\nx();');
    expect(ok.warnings.some((w) => w.includes('不支持'))).toBe(false);
    expect(ok.fields.meta.grants).toEqual(['GM_getValue', 'GM_setValue']);

    const bad = parseUserScript('// ==UserScript==\n// @name t\n// @match https://a.com/*\n// @grant GM_getValue\n// @grant GM_download\n// ==/UserScript==\nx();');
    expect(bad.warnings.some((w) => w.includes('GM_download'))).toBe(true);
    expect(bad.warnings.some((w) => w.includes('GM_getValue'))).toBe(false);
  });
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/shared/userscript-meta.test.ts`
Expected: 新增 2 用例 FAIL（connects 等字段不存在；grant 警告仍是无条件）

- [ ] **Step 3: 修改解析器**

文件头追加导入：

```ts
import { classifyGrants } from './gm-apis';
```

case 段追加（`case 'grant'` 之后）：

```ts
      case 'connect': if (value && !connects.includes(value)) connects.push(value); break;
      case 'require': if (value && !requires.includes(value)) requires.push(value); break;
      case 'resource': {
        // @resource <name> <url>（VM parseMeta 的 pair 匹配模式）
        const pair = /^(\S+)\s+(\S+)$/.exec(value);
        if (pair) resources[pair[1] ?? ''] = pair[2] ?? '';
        break;
      }
```

声明区追加（`const badMatches: string[] = [];` 之后）：

```ts
  const connects: string[] = [];
  const requires: string[] = [];
  const resources: Record<string, string> = {};
```

meta 落位（return 之前，`if (matches.length === 0)` 之前）：

```ts
  if (connects.length > 0) meta.connects = connects;
  if (requires.length > 0) meta.requires = requires;
  if (Object.keys(resources).length > 0) meta.resources = resources;
```

grant 警告改为按注册表判定（替换现有 `const realGrants ... warnings.push(...)` 块）：

```ts
  const realGrants = grants.filter((g) => g !== 'none');
  if (realGrants.length > 0) {
    meta.grants = grants;
    const { supported, unsupported } = classifyGrants(grants);
    if (unsupported.length > 0) {
      warnings.push(`@grant 未支持：${unsupported.join(', ')}——调用会报错（可用：${supported.join(', ')} 或见 docs/gm-api.md）`);
    }
  }
```

`stringifyUserScript` 追加输出（`if (meta.noframes)` 之前）：

```ts
  if (meta.connects) for (const c of meta.connects) lines.push(`// @connect     ${c}`);
  if (meta.requires) for (const r of meta.requires) lines.push(`// @require     ${r}`);
  if (meta.resources) for (const [n, u] of Object.entries(meta.resources)) lines.push(`// @resource    ${n} ${u}`);
```

- [ ] **Step 4: 运行测试**

Run: `npx vitest run tests/shared/userscript-meta.test.ts`
Expected: 全部 PASS。注意既有用例「解析标准头」断言 `warnings.some((w) => w.includes('GM_*'))` —— GM_setValue 已支持，该断言会失败，**更新它**为 `expect(fields.meta.grants).toEqual(['GM_setValue']); expect(warnings.some((w) => w.includes('不支持'))).toBe(false);`。既有「其它不支持的键汇总」用例不受影响（connect/require/resource 已移出 ignoredKeys）。

- [ ] **Step 5: Commit**

```bash
git add shared/userscript-meta.ts tests/shared/userscript-meta.test.ts
git commit -m "feat(gm): 解析器支持 @connect/@require/@resource；grant 警告按注册表判定"
```

---

### Task 5: token 派生（`background/gm-token.ts`）

**Files:**
- Create: `background/gm-token.ts`
- Test: `tests/background/gm-token.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/background/gm-token.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { storage } from 'wxt/utils/storage';
import { getBridgeToken, bridgeTokensForUrl } from '../../background/gm-token';
import { saveScript } from '../../storage/scripts';
import type { UserScript } from '../../shared/types';

function mkScript(over: Partial<UserScript> = {}): UserScript {
  return {
    id: 's1', text: '// ==UserScript==\n// @name t\n// @match https://a.com/*\n// ==/UserScript==\nx();',
    name: 't', enabled: true, matches: ['https://a.com/*'], code: 'x();',
    runAt: 'document_idle', world: 'USER_SCRIPT', source: 'user', createdAt: 1, updatedAt: 1, ...over,
  };
}

describe('gm-token', () => {
  beforeEach(() => fakeBrowser.reset());

  it('同 seed 同 scriptId 派生相同 token；不同 scriptId 不同', async () => {
    const t1 = await getBridgeToken('s1');
    const t2 = await getBridgeToken('s1');
    const t3 = await getBridgeToken('s2');
    expect(t1).toBe(t2);
    expect(t1).not.toBe(t3);
    expect(t1).toMatch(/^[a-f0-9]{16,}$/);
  });

  it('seed 持久化：第二次调用不换 token（SW 重启语义）', async () => {
    const t1 = await getBridgeToken('s1');
    const raw = await storage.getItem<string>('local:gm:seed');
    expect(typeof raw).toBe('string');
    const t2 = await getBridgeToken('s1');
    expect(t2).toBe(t1);
  });

  it('bridgeTokensForUrl：enabled + matchUrl 过滤，disabled 不发 token', async () => {
    await saveScript(mkScript());
    await saveScript(mkScript({ id: 's2', enabled: false }));
    const entries = await bridgeTokensForUrl('https://a.com/x');
    expect(entries.map((e) => e.scriptId)).toEqual(['s1']);
    expect(typeof entries[0]!.token).toBe('string');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/background/gm-token.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写实现**

```ts
// background/gm-token.ts
// 桥 token 派生（spec §6）：token = FNV-1a(seed + ':' + scriptId) 的 hex。
// 确定性派生 → SW 重启不换 token → 已开页面的桥不断。seed 存 local:gm:seed，首次生成后持久。

import { storage } from 'wxt/utils/storage';
import { listScripts } from '../storage/scripts';
import { matchUrl } from '../shared/match-pattern';

const SEED_KEY = 'local:gm:seed';

async function getSeed(): Promise<string> {
  const raw = await storage.getItem<string>(SEED_KEY);
  if (typeof raw === 'string' && raw.length >= 16) return raw;
  const seed = crypto.randomUUID().replace(/-/g, '');
  await storage.setItem(SEED_KEY, seed);
  return seed;
}

/** FNV-1a 64 位近似（JS number 精度内 32 位循环两次拼接）——确定性、无依赖、够防猜。 */
function fnv1a(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    h1 ^= input.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = (h2 + Math.imul(input.charCodeAt(i) + i, 0x85ebca6b)) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

export async function getBridgeToken(scriptId: string): Promise<string> {
  const seed = await getSeed();
  return fnv1a(`${seed}:${scriptId}`);
}

/** 当前 URL 匹配且启用的脚本的 [{ scriptId, token }]（content script 桥宿主索取，spec §6）。 */
export async function bridgeTokensForUrl(url: string): Promise<Array<{ scriptId: string; token: string }>> {
  if (!url) return [];
  const all = await listScripts();
  const matched = all.filter((s) => s.enabled && matchUrl(s.matches, url));
  return Promise.all(matched.map(async (s) => ({ scriptId: s.id, token: await getBridgeToken(s.id) })));
}
```

- [ ] **Step 4: 运行测试通过**

Run: `npx vitest run tests/background/gm-token.test.ts`
Expected: PASS（3 用例）

- [ ] **Step 5: Commit**

```bash
git add background/gm-token.ts tests/background/gm-token.test.ts
git commit -m "feat(gm): 确定性桥 token 派生（FNV-1a，SW 重启不断桥）"
```

---

### Task 6: wrapper 生成器（`shared/gm-wrapper.ts`）

**Files:**
- Create: `shared/gm-wrapper.ts`
- Test: `tests/shared/gm-wrapper.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/shared/gm-wrapper.test.ts
import { describe, it, expect } from 'vitest';
import { buildWrappedCode, PREAMBLE_MARKER } from '../../shared/gm-wrapper';
import type { UserScript } from '../../shared/types';

function mkScript(over: Partial<UserScript> = {}): UserScript {
  return {
    id: 's1',
    text: '// ==UserScript==\n// @name t\n// @match https://a.com/*\n// @grant GM_getValue\n// @grant GM_setValue\n// ==/UserScript==\nuserCode();',
    name: 't', enabled: true, matches: ['https://a.com/*'], code: 'userCode();',
    runAt: 'document_idle', world: 'USER_SCRIPT', source: 'user', createdAt: 1, updatedAt: 1,
    meta: { grants: ['GM_getValue', 'GM_setValue'] }, ...over,
  };
}

describe('buildWrappedCode', () => {
  it('包含 preamble/GM_info/快照/token，用户代码在末尾', () => {
    const code = buildWrappedCode(mkScript(), {
      token: 'tok123', values: { k: 1 }, resources: {}, requireCodes: [], extensionVersion: '1.0.0',
    });
    expect(code).toContain(PREAMBLE_MARKER);
    expect(code).toContain('"scriptHandler":"ai-browser-extend"');
    expect(code).toContain('"version":"1.0.0"');
    expect(code).toContain('__values = {"k":1}');
    expect(code).toContain("'tok123'");
    expect(code.indexOf('userCode();')).toBeGreaterThan(code.indexOf(PREAMBLE_MARKER));
    // 末尾执行（预编译探测 + try/catch 包裹用户代码）
    expect(code).toContain('new __GM_probe(');
    expect(code.trimEnd().endsWith('})();'));
  });

  it('grant 安装精确：只安装声明过的 API', () => {
    const code = buildWrappedCode(mkScript(), {
      token: 't', values: {}, resources: {}, requireCodes: [], extensionVersion: '1.0.0',
    });
    expect(code).toContain("install('GM_getValue'");
    expect(code).toContain("install('GM_setValue'");
    expect(code).not.toContain("install('GM_xmlhttpRequest'");
  });

  it('点形式双形态：GM.getValue 为 Promise 包装、GM_getValue 同步', () => {
    const code = buildWrappedCode(mkScript(), {
      token: 't', values: {}, resources: {}, requireCodes: [], extensionVersion: '1.0.0',
    });
    expect(code).toContain('GM.getValue');
    expect(code).toContain('GM_getValue');
  });

  it('unsafeWindow grant：MAIN world = window', () => {
    const s = mkScript({ world: 'MAIN', meta: { grants: ['unsafeWindow'] } });
    const code = buildWrappedCode(s, { token: 't', values: {}, resources: {}, requireCodes: [], extensionVersion: '1.0.0' });
    expect(code).toContain('var unsafeWindow = window;');
  });

  it('@require 内容在用户代码之前、preamble 之后', () => {
    const code = buildWrappedCode(mkScript(), {
      token: 't', values: {}, resources: {}, requireCodes: ['libBody();'], extensionVersion: '1.0.0',
    });
    const p = code.indexOf(PREAMBLE_MARKER);
    const r = code.indexOf('libBody();');
    const u = code.indexOf('userCode();');
    expect(p).toBeLessThan(r);
    expect(r).toBeLessThan(u);
  });

  it('无 grant 且无 @require：返回裸 code（零开销）', () => {
    const s = mkScript({ meta: undefined, text: '// ==UserScript==\n// @name t\n// @match https://a.com/*\n// ==/UserScript==\nuserCode();' });
    const code = buildWrappedCode(s, { token: 't', values: {}, resources: {}, requireCodes: [], extensionVersion: '1.0.0' });
    expect(code).toBe('userCode();');
  });

  it('@grant none + @require：加 wrapper（require 拼接宿主），GM 仅 GM_info', () => {
    const s = mkScript({
      meta: { requires: ['https://cdn/lib.js'] },
      text: '// ==UserScript==\n// @name t\n// @match https://a.com/*\n// @grant none\n// @require https://cdn/lib.js\n// ==/UserScript==\nuserCode();',
    });
    const code = buildWrappedCode(s, { token: 't', values: {}, resources: {}, requireCodes: ['lib();'], extensionVersion: '1.0.0' });
    expect(code).toContain(PREAMBLE_MARKER);
    expect(code).toContain('lib();');
    expect(code).not.toContain("install('GM_setValue'");
  });

  it('语法错误探测：new __GM_probe 包装用户代码字符串', () => {
    const code = buildWrappedCode(mkScript(), {
      token: 't', values: {}, resources: {}, requireCodes: [], extensionVersion: '1.0.0',
    });
    // 用户代码以字符串形式传给 __GM_probe（JSON.stringify 转义）
    expect(code).toContain(JSON.stringify('userCode();').slice(1, -1));
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/shared/gm-wrapper.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写实现**

```ts
// shared/gm-wrapper.ts
// wrapper 生成（spec §5）：preamble 内联 + GM 对象按 @grant 精确安装 + 值快照直嵌 + require 前置。
// 纯函数（字符串拼装）——无 grant 且无 @require 的脚本返回裸 code（零开销）。
// preamble 里只用页面环境必然存在的全局（window/document/console），不依赖扩展 API。

import type { UserScript } from './types';
import { GM_API_REGISTRY, SPECIAL_GRANTS } from './gm-apis';

export const PREAMBLE_MARKER = '/* __GM_PREAMBLE__ */';

export interface WrapperDeps {
  token: string;
  /** 注入时值快照（GM_getValue 零 RPC 数据源） */
  values: Record<string, unknown>;
  /** @resource 内容（name → text） */
  resources: Record<string, string>;
  /** @require 预取产物（按声明顺序） */
  requireCodes: string[];
  extensionVersion: string;
}

const J = JSON.stringify;

function gmInfoLiteral(script: UserScript, version: string): string {
  const m = script.meta ?? {};
  return J({
    scriptHandler: 'ai-browser-extend',
    version,
    script: {
      name: script.name,
      namespace: m.namespace ?? '',
      version: m.version ?? '0.0',
      description: m.description ?? '',
      matches: script.matches,
      grants: m.grants ?? [],
    },
    injectInto: script.world === 'MAIN' ? 'Main' : 'UserScript',
  });
}

function preamble(scriptId: string): string {
  // IIFE 闭包持有 token/pending；事件桥客户端（gmreq/gmres/gmevt 三事件，spec §6）。
  return `${PREAMBLE_MARKER}
(function () {
  'use strict';
  var __GM_id = ${J(scriptId)};
  var __GM_token = ${'TOKEN_PLACEHOLDER'};
  var __GM_reqSeq = 0;
  var __GM_pending = new Map();
  var __GM_listeners = new Map();
  var __GM_valueHooks = new Map();
  var __GM_resEvent = 'gmres:' + __GM_id;
  var __GM_evtEvent = 'gmevt:' + __GM_id;
  function __GM_post(api, params) {
    return new Promise(function (resolve, reject) {
      var reqId = ++__GM_reqSeq;
      __GM_pending.set(reqId, { resolve: resolve, reject: reject });
      window.dispatchEvent(new CustomEvent('gmreq:' + __GM_id, {
        detail: { token: __GM_token, reqId: reqId, api: api, params: params }
      }));
    });
  }
  window.addEventListener(__GM_resEvent, function (e) {
    var d = e.detail || {};
    var p = __GM_pending.get(d.reqId);
    if (!p) return;
    __GM_pending.delete(d.reqId);
    if (d.ok) p.resolve(d.data); else p.reject(new Error(d.error || 'GM bridge error'));
  });
  window.addEventListener(__GM_evtEvent, function (e) {
    var d = e.detail || {};
    if (d.kind === 'VALUE_CHANGE') {
      var hooks = __GM_valueHooks.get(d.data.key);
      if (hooks) hooks.forEach(function (fn) { fn(d.data.key, d.data.oldValue, d.data.newValue, d.data.remote); });
    } else if (d.kind === 'MENU_CLICK') {
      var cb = __GM_listeners.get('menu:' + d.data.key);
      if (cb) cb();
    } else if (d.kind === 'NOTIF_CLICK') {
      var nc = __GM_listeners.get('notif:' + d.data.id);
      if (nc) nc(d.data.byUser ? 'click' : 'close');
    } else if (d.kind === 'TAB_EVENT') {
      var tc = __GM_listeners.get('tab:' + d.data.tabId);
      if (tc) tc(d.data);
    }
  });
  function __GM_report(message, stack, line) {
    try { __GM_post('ReportError', [message, stack, line]); } catch (e) { /* 上报失败静默 */ }
  }
  window.__GM_probe = Function; // 与预编译探测共用语言级构造
  var install = function (name, fn, promise) {
    var parts = name.split('.');
    var obj = parts.length > 1 ? (GM[parts[0]] = GM[parts[0]] || {}) : GM;
    var key = parts.length > 1 ? parts.slice(1).join('.') : name;
    obj[key] = fn;
    if (promise && parts.length === 1) {
      var dot = GM[name.replace('GM_', 'GM.')] ;
      void dot;
    }
  };
  var GM = {};
  var __values = VALUES_PLACEHOLDER;
  var __resources = RESOURCES_PLACEHOLDER;
  var GM_info = GMINFO_PLACEHOLDER;
  GM.info = GM_info;
  var unsafeWindow = window;
`;
}

function installLines(script: UserScript): string {
  // 按 @grant 精确安装（spec §5）；下划线形式同步语义、点形式 Promise（双形态决策）
  const grants = script.meta?.grants ?? [];
  const real = grants.filter((g) => g !== 'none' && !SPECIAL_GRANTS.has(g));
  const lines: string[] = [];
  const emit = (name: string, syncExpr: string) => {
    const def = GM_API_REGISTRY[name];
    lines.push(`  install(${J(name)}, ${syncExpr});`);
    if (def?.promiseForm) {
      const dot = name.replace(/^GM_/, 'GM.');
      lines.push(`  install(${J(dot)}, function () { var a = [].slice.call(arguments); var r = GM[${J(name)}].apply(null, a); return r && typeof r.then === 'function' ? r : Promise.resolve(r); });`);
    }
  };
  if (real.includes('GM_info')) emit('GM_info', 'GM_info');
  if (real.includes('GM_getValue')) emit('GM_getValue', 'function (key, def) { var v = __values[key]; return v === undefined ? def : v; }');
  if (real.includes('GM_setValue')) emit('GM_setValue', 'function (key, val) { __values[key] = val; __GM_post("SetValue", [key, val]); }');
  if (real.includes('GM_deleteValue')) emit('GM_deleteValue', 'function (key) { delete __values[key]; __GM_post("DeleteValue", [key]); }');
  if (real.includes('GM_listValues')) emit('GM_listValues', 'function () { return Object.keys(__values); }');
  if (real.includes('GM_addValueChangeListener')) emit('GM_addValueChangeListener', 'function (key, fn) { var arr = __GM_valueHooks.get(key) || []; arr.push(fn); __GM_valueHooks.set(key, arr); return key + ":" + (arr.length - 1); }');
  if (real.includes('GM_addStyle')) emit('GM_addStyle', 'function (css) { var el = document.createElement("style"); el.textContent = css; (document.head || document.documentElement).appendChild(el); return el; }');
  if (real.includes('GM_getResourceText')) emit('GM_getResourceText', 'function (name) { return __resources[name]; }');
  if (real.includes('GM_log')) emit('GM_log', 'function () { var a = [].slice.call(arguments); a.unshift(GM_info.script.name); console.log.apply(console, a); }');
  if (real.includes('GM_registerMenuCommand')) emit('GM_registerMenuCommand', 'function (name, fn) { var key = "m" + (++__GM_reqSeq); __GM_listeners.set("menu:" + key, fn); __GM_post("RegisterMenu", [key, name]); return key; }');
  if (real.includes('GM_setClipboard')) emit('GM_setClipboard', 'function (text) { return __GM_post("SetClipboard", [text]); }');
  if (real.includes('GM_notification')) emit('GM_notification', 'function (details, ondone) { var id = "n" + (++__GM_reqSeq); if (ondone) __GM_listeners.set("notif:" + id, ondone); __GM_post("Notification", [details, id]); }');
  if (real.includes('GM_openInTab')) emit('GM_openInTab', 'function (url, opts) { opts = opts || {}; var h = { closed: false, onclose: null, close: function () { __GM_post("CloseTab", [h.__tabId]); } }; __GM_post("OpenInTab", [url, opts, id_of(h)]).then(function (tabId) { h.__tabId = tabId; __GM_listeners.set("tab:" + tabId, function (d) { h.closed = !!d.closed; if (d.closed && h.onclose) h.onclose(); }); }); return h; }');
  if (real.includes('GM_xmlhttpRequest')) emit('GM_xmlhttpRequest', 'function (details) { var reqId = ++__GM_reqSeq; __GM_post("XmlHttpRequest", [details]).then(function (resp) { if (resp && resp.error) { details.onerror && details.onerror(resp); } else { details.onload && details.onload(resp); } }, function (err) { details.onerror && details.onerror({ error: String(err) }); }); return { abort: function () { __GM_post("AbortRequest", [reqId]); } }; }');
  return lines.join('\n');
}

function id_of(h: unknown): number {
  return (h as { __tabId?: number }).__tabId ?? -1;
}

/** 拼装完整注入代码。无 grant 且无 @require → 返回裸 code（spec §5 零开销）。 */
export function buildWrappedCode(script: UserScript, deps: WrapperDeps): string {
  const grants = script.meta?.grants ?? [];
  const hasRequires = (script.meta?.requires?.length ?? 0) > 0;
  const realGrants = grants.filter((g) => g !== 'none');
  if (realGrants.length === 0 && !hasRequires) return script.code;

  const head = preamble(script.id)
    .replace('TOKEN_PLACEHOLDER', J(deps.token))
    .replace('VALUES_PLACEHOLDER', J(deps.values))
    .replace('RESOURCES_PLACEHOLDER', J(deps.resources))
    .replace('GMINFO_PLACEHOLDER', gmInfoLiteral(script, deps.extensionVersion));

  const requiresBlock = deps.requireCodes.length > 0
    ? deps.requireCodes.map((c) => `${c};`).join('\n')
    : '';

  // 预编译探测（语法错误上报，spec §5）+ try/catch 执行
  const userCode = J(script.code).slice(1, -1); // JSON 转义后的字符串字面量内容
  const tail = `
  try { new __GM_probe(${userCode}); } catch (e) {
    console.error('[' + GM_info.script.name + '] 语法错误:', e && e.message);
    __GM_report('SyntaxError: ' + (e && e.message), String(e && e.stack), 0);
    return;
  }
  try { (new __GM_probe(${userCode}))(); } catch (e) {
    console.error('[' + GM_info.script.name + ']', e);
    __GM_report(String(e && e.message), String(e && e.stack), e && e.lineNumber || 0);
  }
})();
`;

  return [head, installLines(script) + '\n', requiresBlock, tail].join('\n');
}
```

**实现注意**：`GM_openInTab` 行内的 `id_of(h)` 调用写错了安装表达式（那是要在 Promise then 里才赋值的字段）——正确写法是先创建句柄再在 `.then` 里拿 tabId，`install` 的同步表达式只需引用句柄变量。落地时把该行改为：

```ts
  if (real.includes('GM_openInTab')) emit('GM_openInTab', 'function (url, opts) { opts = opts || {}; var h = { closed: false, onclose: null, close: function () { __GM_post("CloseTab", [h.__tabId]); } }; __GM_post("OpenInTab", [url, opts]).then(function (tabId) { h.__tabId = tabId; __GM_listeners.set("tab:" + tabId, function (d) { h.closed = !!d.closed; if (d.closed && h.onclose) h.onclose(); }); }); return h; }');
```

（去掉 `id_of(h)` 引用与文件底部的 `id_of` 辅助函数，测试只断言安装行存在，不涉及该内部细节。）

- [ ] **Step 4: 运行测试**

Run: `npx vitest run tests/shared/gm-wrapper.test.ts`
Expected: 全部 PASS。若 `install('GM_getValue'` 断言失败，检查 `emit` 的 `J(name)` 生成的是 `"GM_getValue"`（带引号）而断言也带引号——两边一致即可。

- [ ] **Step 5: Commit**

```bash
git add shared/gm-wrapper.ts tests/shared/gm-wrapper.test.ts
git commit -m "feat(gm): buildWrappedCode——preamble + 按 grant 精确安装 + 快照直嵌 + 语法预探测"
```

---

### Task 7: SW 实现中心——值存储/菜单/错误/简单 API（`background/gm-api.ts`）

**Files:**
- Create: `background/gm-api.ts`（替换 Task 3 的占位文件）
- Test: `tests/background/gm-api.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/background/gm-api.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { storage } from 'wxt/utils/storage';
import { MessageRouter } from '../../background/router';
import {
  initGmApi, gmErrorCounts, getErrorBuffer, clearErrors, getMenuSnapshot,
} from '../../background/gm-api';
import { saveScript } from '../../storage/scripts';
import type { UserScript } from '../../shared/types';

function mkScript(over: Partial<UserScript> = {}): UserScript {
  return {
    id: 's1', text: '// ==UserScript==\n// @name t\n// @match https://a.com/*\n// @grant GM_setValue\n// ==/UserScript==\nx();',
    name: 't', enabled: true, matches: ['https://a.com/*'], code: 'x();',
    runAt: 'document_idle', world: 'USER_SCRIPT', source: 'user', createdAt: 1, updatedAt: 1,
    meta: { grants: ['GM_setValue'] }, ...over,
  };
}

/** 直接调用 handleGmCall（绕过消息层），sender 模拟来自 tab 1 */
async function call(api: string, params: unknown[], scriptId = 's1') {
  const { handleGmCall } = await import('../../background/gm-api');
  return handleGmCall({ scriptId, api, reqId: 1, params }, { tab: { id: 1, url: 'https://a.com/' } } as never);
}

describe('gm-api 值存储', () => {
  beforeEach(() => { fakeBrowser.reset(); vi.restoreAllMocks(); vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({} as never); });

  it('SetValue 落库 + 广播 GM_EVENT( VALUE_CHANGE )；同 tab 广播 remote=false', async () => {
    await saveScript(mkScript());
    const spy = vi.spyOn(browser.tabs, 'sendMessage').mockResolvedValue(undefined as never);
    const r = await call('SetValue', ['k', 42]);
    expect(r).toEqual({ ok: true, data: null });
    const raw = await storage.getItem<Record<string, unknown>>('local:script-values:s1');
    expect(raw).toEqual({ k: 42 });
    expect(spy).toHaveBeenCalled();
  });

  it('GetValue 读库（桥侧兜底——正常路径走快照，此为桥直读）', async () => {
    await storage.setItem('local:script-values:s1', { k: 'v' });
    const r = await call('GetValue', ['k']);
    expect(r).toEqual({ ok: true, data: 'v' });
  });

  it('DeleteValue 删键', async () => {
    await storage.setItem('local:script-values:s1', { k: 'v', k2: 2 });
    await call('DeleteValue', ['k']);
    const raw = await storage.getItem<Record<string, unknown>>('local:script-values:s1');
    expect(raw).toEqual({ k2: 2 });
  });

  it('grant 白名单：未 grant 的 API 拒绝', async () => {
    await saveScript(mkScript()); // 只 grant 了 GM_setValue
    const r = await call('GM_notification', [{}]);
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toContain('permission');
  });
});

describe('gm-api 错误缓冲', () => {
  beforeEach(() => { fakeBrowser.reset(); vi.restoreAllMocks(); vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({} as never); });

  it('ReportError 入环形缓冲（≤20）+ 广播 SCRIPTS_ERROR + gmErrorCounts', async () => {
    await saveScript(mkScript());
    for (let i = 0; i < 25; i++) await call('ReportError', [`err${i}`, 'stack', i]);
    const buf = getErrorBuffer('s1');
    expect(buf).toHaveLength(20);
    expect(buf[0]!.message).toBe('err5'); // 丢最旧
    expect(gmErrorCounts()).toEqual({ s1: 20 });
  });

  it('clearErrors 清空并广播', async () => {
    await saveScript(mkScript());
    await call('ReportError', ['e', 's', 1]);
    await clearErrors('s1');
    expect(getErrorBuffer('s1')).toEqual([]);
  });
});

describe('gm-api 菜单表', () => {
  beforeEach(() => { fakeBrowser.reset(); vi.restoreAllMocks(); vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({} as never); });

  it('RegisterMenu 落表 + SCRIPTS_MENUS 广播；invokeMenuCommand 路由 MENU_CLICK 下行', async () => {
    await saveScript(mkScript({ meta: { grants: ['GM_registerMenuCommand'] } }));
    await call('RegisterMenu', ['m1', '抓取数据'], 's1');
    const snap = getMenuSnapshot();
    expect(snap).toEqual([{ scriptId: 's1', commands: [{ key: 'm1', name: '抓取数据' }] }]);

    const tabSpy = vi.spyOn(browser.tabs, 'sendMessage').mockResolvedValue(undefined as never);
    await (await import('../../background/gm-api')).invokeMenuCommand('s1', 'm1');
    expect(tabSpy.mock.calls[0]![0]).toBe(1); // 发到注册来源 tab
    const payload = tabSpy.mock.calls[0]![1] as { type: string; scriptId: string; kind: string };
    expect(payload).toMatchObject({ type: 'GM_EVENT', scriptId: 's1', kind: 'MENU_CLICK' });
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/background/gm-api.test.ts`
Expected: FAIL（handleGmCall 等不存在）

- [ ] **Step 3: 写实现**

```ts
// background/gm-api.ts
// GM API SW 侧实现中心（spec §3/§8）：GM_API_CALL 分发、@grant 白名单、值存储与广播、
// 菜单表、错误环形缓冲、SetClipboard/Notification/OpenInTab；GM_xmlhttpRequest 的 @connect
// 确认流在 Task 10 并入（本任务先分发占位错误）。token 表查询（GM_BRIDGE_TOKENS）同。

import type { GmEventKind, GmBridgeTokens } from '../shared/gm-bridge';
import { storage } from 'wxt/utils/storage';
import { getScript } from '../storage/scripts';
import { GM_API_REGISTRY } from '../shared/gm-apis';
import { bridgeTokensForUrl } from './gm-token';

export interface GmErrorEntry {
  at: number;
  message: string;
  stack?: string;
  line?: number;
}

export interface GmMenuCommand {
  key: string;
  name: string;
  tabId: number; // 注册来源 tab（MENU_CLICK 回发目标）
}

interface GmCallRequest {
  scriptId: string;
  api: string;
  reqId: number;
  params: unknown[];
}

type Sender = { tab?: { id?: number; url?: string } } | undefined;

// ---- SW 内存态（重启丢失、可自重建，spec §4.1）----
const errorBuffers = new Map<string, GmErrorEntry[]>();
const ERROR_BUFFER_MAX = 20;
const menuTable = new Map<string, Map<string, GmMenuCommand>>();

export function gmErrorCounts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, buf] of errorBuffers) if (buf.length > 0) out[id] = buf.length;
  return out;
}

export function getErrorBuffer(scriptId: string): GmErrorEntry[] {
  return [...(errorBuffers.get(scriptId) ?? [])];
}

async function broadcastToPanel(msg: Record<string, unknown>): Promise<void> {
  void browser.runtime.sendMessage(msg).catch(() => {});
}

export async function clearErrors(scriptId: string): Promise<void> {
  errorBuffers.delete(scriptId);
  await broadcastToPanel({ type: 'SCRIPTS_ERROR_CLEARED', scriptId });
}

function pushError(scriptId: string, entry: GmErrorEntry): void {
  const buf = errorBuffers.get(scriptId) ?? [];
  buf.push(entry);
  while (buf.length > ERROR_BUFFER_MAX) buf.shift();
  errorBuffers.set(scriptId, buf);
  void broadcastToPanel({ type: 'SCRIPTS_ERROR', scriptId, error: entry });
}

export function getMenuSnapshot(): Array<{ scriptId: string; commands: Array<{ key: string; name: string }> }> {
  const out: Array<{ scriptId: string; commands: Array<{ key: string; name: string }> }> = [];
  for (const [scriptId, cmds] of menuTable) {
    if (cmds.size === 0) continue;
    out.push({ scriptId, commands: [...cmds.values()].map(({ key, name }) => ({ key, name })) });
  }
  return out;
}

function broadcastMenus(): void {
  void broadcastToPanel({ type: 'SCRIPTS_MENUS', entries: getMenuSnapshot() });
}

/** 侧边栏点击菜单命令 → MENU_CLICK 下行到注册来源 tab（spec §9.3）。 */
export async function invokeMenuCommand(scriptId: string, key: string): Promise<void> {
  const cmd = menuTable.get(scriptId)?.get(key);
  if (!cmd) return;
  await sendGmEvent(cmd.tabId, scriptId, 'MENU_CLICK', { key });
}

async function sendGmEvent(tabId: number, scriptId: string, kind: GmEventKind, data: Record<string, unknown>): Promise<void> {
  try {
    await browser.tabs.sendMessage(tabId, { type: 'GM_EVENT', scriptId, kind, data });
  } catch {
    // tab 可能已关闭/无接收方——fire-and-forget
  }
}

// ---- 值存储 ----

const valuesKey = (scriptId: string) => `local:script-values:${scriptId}` as const;

async function readValues(scriptId: string): Promise<Record<string, unknown>> {
  return (await storage.getItem<Record<string, unknown>>(valuesKey(scriptId))) ?? {};
}

async function writeValues(scriptId: string, next: Record<string, unknown>): Promise<void> {
  await storage.setItem(valuesKey(scriptId), next);
}

/** 脚本删除时清值域（background/scripts.ts handleDelete 调用）。 */
export async function cleanupScriptState(scriptId: string): Promise<void> {
  errorBuffers.delete(scriptId);
  menuTable.delete(scriptId);
  await storage.removeItem(valuesKey(scriptId));
  broadcastMenus();
}

// ---- @grant 白名单（spec §3）----

async function grantAllowed(scriptId: string, api: string): Promise<boolean> {
  const script = await getScript(scriptId);
  if (!script) return false;
  const grants = script.meta?.grants ?? [];
  if (grants.includes(api)) return true;
  // 点形式别名：GM.getValue 归 GM_getValue
  const under = api.replace(/^GM\./, 'GM_');
  return grants.includes(under);
}

// ---- 分发 ----

export async function handleGmCall(req: GmCallRequest, sender: Sender): Promise<{ ok: true; data?: unknown } | { ok: false; error: string }> {
  const { scriptId, api, params } = req;
  // 内部通道不受 grant 限制（错误上报/值同步是框架自身调用）
  if (api === 'ReportError') {
    const [message, stack, line] = params as [string, string?, number?];
    pushError(scriptId, { at: Date.now(), message: String(message ?? ''), stack, line });
    return { ok: true, data: null };
  }
  if (!(await grantAllowed(scriptId, api))) {
    return { ok: false, error: `permission not requested: ${api}（@grant 未声明）` };
  }
  switch (api) {
    case 'SetValue': {
      const [key, value] = params as [string, unknown];
      const values = await readValues(scriptId);
      const oldValue = values[key];
      values[key] = value;
      await writeValues(scriptId, values);
      // 广播 VALUE_CHANGE：其它 tab remote=true（本 tab 的监听由 wrapper 本地触发，spec §8）
      await broadcastValueChange(scriptId, key, oldValue, value, sender, false);
      return { ok: true, data: null };
    }
    case 'DeleteValue': {
      const [key] = params as [string];
      const values = await readValues(scriptId);
      const oldValue = values[key];
      delete values[key];
      await writeValues(scriptId, values);
      await broadcastValueChange(scriptId, key, oldValue, undefined, sender, false);
      return { ok: true, data: null };
    }
    case 'GetValue': {
      const [key, def] = params as [string, unknown];
      const values = await readValues(scriptId);
      return { ok: true, data: key in values ? values[key] : def };
    }
    case 'RegisterMenu': {
      const [key, name] = params as [string, string];
      const tabId = sender?.tab?.id;
      if (tabId == null) return { ok: false, error: 'RegisterMenu 缺少 tab 上下文' };
      const cmds = menuTable.get(scriptId) ?? new Map<string, GmMenuCommand>();
      cmds.set(key, { key, name, tabId });
      menuTable.set(scriptId, cmds);
      broadcastMenus();
      return { ok: true, data: null };
    }
    case 'SetClipboard': {
      const [text] = params as [string];
      try {
        await navigator.clipboard.writeText(String(text ?? ''));
        return { ok: true, data: null };
      } catch (e) {
        return { ok: false, error: `剪贴板写入失败（MV3 SW 无手势链时可能被拒）：${e instanceof Error ? e.message : String(e)}` };
      }
    }
    case 'Notification': {
      const [details, notifId] = params as [{ title?: string; text?: string }, string];
      try {
        await browser.notifications.create(notifId, { type: 'basic', title: details?.title ?? scriptId, message: details?.text ?? '' });
        return { ok: true, data: null };
      } catch (e) {
        return { ok: false, error: `通知失败：${e instanceof Error ? e.message : String(e)}` };
      }
    }
    case 'OpenInTab': {
      const [url, opts] = params as [string, { active?: boolean }];
      const tab = await browser.tabs.create({ url, active: opts?.active !== false });
      browser.tabs.onRemoved.addListener(function onRemoved(tabId) {
        if (tabId !== tab.id) return;
        browser.tabs.onRemoved.removeListener(onRemoved);
        if (sender?.tab?.id != null) {
          void sendGmEvent(sender.tab.id, scriptId, 'TAB_EVENT', { tabId: tab.id, closed: true });
        }
      });
      return { ok: true, data: tab.id };
    }
    case 'CloseTab': {
      const [tabId] = params as [number];
      try { await browser.tabs.remove(tabId); return { ok: true, data: null }; }
      catch (e) { return { ok: false, error: String(e) }; }
    }
    case 'XmlHttpRequest':
    case 'AbortRequest':
      return { ok: false, error: `GM_xmlhttpRequest 将在 Task 10 接入（当前为占位）` };
    default:
      return { ok: false, error: `未知 GM API：${api}` };
  }
}

async function broadcastValueChange(
  scriptId: string, key: string, oldValue: unknown, newValue: unknown,
  sender: Sender, remote: boolean,
): Promise<void> {
  // 打到所有已跟踪该脚本的 tab（复用运行态跟踪 map 的语义：遍历 scripts 运行集太重，
  // 直接用 tabs.query 全量 + SW 侧 matchUrl 过滤——量级个人 <20 tab 可接受）
  const tabs = await browser.tabs.query({}).catch(() => []);
  const script = await getScript(scriptId);
  if (!script) return;
  const targets = tabs.filter((t) => t.id != null && t.url && script.matches.length > 0
    && (await import('../shared/match-pattern')).matchUrl(script.matches, t.url));
  for (const t of targets) {
    // 同 tab（发起方）的本地监听由 wrapper 同步触发，SW 只发 remote 标记；此处统一发，wrapper 按 remote 过滤
    void sendGmEvent(t.id!, scriptId, 'VALUE_CHANGE', { key, oldValue, newValue, remote: remote || t.id !== sender?.tab?.id });
  }
}

// ---- 消息接线 ----

export function initGmApi(router: { on: (type: string, handler: (msg: Record<string, unknown>, sender?: Sender) => unknown) => void }): void {
  router.on('GM_API_CALL', async (msg, sender) => {
    const { scriptId, api, reqId, params } = msg as unknown as GmCallRequest & { type: string };
    void reqId; // content 宿主持有 reqId 配对，SW 返回体透传
    return handleGmCall({ scriptId, api, reqId, params }, sender);
  });

  router.on('GM_BRIDGE_TOKENS', async (msg) => {
    const { url } = msg as unknown as { url: string };
    const entries = await bridgeTokensForUrl(url);
    return { ok: true, data: { entries } satisfies GmBridgeTokens };
  });

  router.on('SCRIPTS_MENU_INVOKE', async (msg) => {
    const { scriptId, key } = msg as unknown as { scriptId: string; key: string };
    await invokeMenuCommand(scriptId, key);
    return { ok: true };
  });

  router.on('SCRIPTS_CLEAR_ERRORS', async (msg) => {
    const { scriptId } = msg as unknown as { scriptId: string };
    await clearErrors(scriptId);
    return { ok: true };
  });
}
```

**同时**：`entrypoints/background.ts` 在 `initScriptsModule(router)` 之后挂 `initGmApi(router)`（`import { initGmApi } from '../background/gm-api';`）。通知权限在 Task 14 加（本任务测试 mock 了 `browser.notifications`——fakeBrowser 未内置该 API，测试文件顶部补 `(browser as any).notifications = { create: vi.fn(async () => 'id') };`）。

- [ ] **Step 4: 运行测试**

Run: `npx vitest run tests/background/gm-api.test.ts`
Expected: 全部 PASS（通知用例需先挂 notifications stub）

- [ ] **Step 5: Commit**

```bash
git add background/gm-api.ts tests/background/gm-api.test.ts entrypoints/background.ts
git commit -m "feat(gm): SW 实现中心——grant 白名单/值存储广播/菜单表/错误缓冲/剪贴板/通知/开tab"
```

---

### Task 8: always 授权存储（`background/gm-permissions.ts`）

**Files:**
- Create: `background/gm-permissions.ts`
- Test: `tests/background/gm-permissions.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/background/gm-permissions.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { storage } from 'wxt/utils/storage';
import { getAlwaysAllow, setAlwaysAllow, removeScriptPermissions } from '../../background/gm-permissions';

describe('gm-permissions', () => {
  beforeEach(() => fakeBrowser.reset());

  it('setAlwaysAllow 落库；getAlwaysAllow 命中/未命中', async () => {
    expect(await getAlwaysAllow('s1', 'api.a.com')).toBe(false);
    await setAlwaysAllow('s1', 'api.a.com');
    expect(await getAlwaysAllow('s1', 'api.a.com')).toBe(true);
    expect(await getAlwaysAllow('s1', 'other.com')).toBe(false);
    expect(await getAlwaysAllow('s2', 'api.a.com')).toBe(false);
  });

  it('removeScriptPermissions 清整个脚本的授权（删除脚本时调用）', async () => {
    await setAlwaysAllow('s1', 'a.com');
    await setAlwaysAllow('s1', 'b.com');
    await setAlwaysAllow('s2', 'a.com');
    await removeScriptPermissions('s1');
    expect(await getAlwaysAllow('s1', 'a.com')).toBe(false);
    expect(await getAlwaysAllow('s2', 'a.com')).toBe(true);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/background/gm-permissions.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写实现**

```ts
// background/gm-permissions.ts
// 「总是允许」跨域授权（spec §4.1 local:gm:permissions，SC PermissionDAO 同款形状）。

import { storage } from 'wxt/utils/storage';

const KEY = 'local:gm:permissions';

interface PermissionsShape {
  [scriptId: string]: { cors: Record<string, 'allow'> };
}

async function readAll(): Promise<PermissionsShape> {
  return (await storage.getItem<PermissionsShape>(KEY)) ?? {};
}

export async function getAlwaysAllow(scriptId: string, host: string): Promise<boolean> {
  const all = await readAll();
  return all[scriptId]?.cors?.[host] === 'allow';
}

export async function setAlwaysAllow(scriptId: string, host: string): Promise<void> {
  const all = await readAll();
  const entry = all[scriptId] ?? { cors: {} };
  entry.cors[host] = 'allow';
  all[scriptId] = entry;
  await storage.setItem(KEY, all);
}

export async function removeScriptPermissions(scriptId: string): Promise<void> {
  const all = await readAll();
  delete all[scriptId];
  await storage.setItem(KEY, all);
}
```

- [ ] **Step 4: 运行测试通过**

Run: `npx vitest run tests/background/gm-permissions.test.ts`
Expected: PASS（2 用例）

- [ ] **Step 5: Commit**

```bash
git add background/gm-permissions.ts tests/background/gm-permissions.test.ts
git commit -m "feat(gm): always 授权存储（cors 域名持久化）"
```

---

### Task 9: @require/@resource 预取（`background/gm-resources.ts`）

**Files:**
- Create: `background/gm-resources.ts`
- Test: `tests/background/gm-resources.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/background/gm-resources.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { prefetchResources, getResourceBundle } from '../../background/gm-resources';
import type { UserScript } from '../../shared/types';

function mkScript(over: Partial<UserScript> = {}): UserScript {
  return {
    id: 's1', text: '', name: 't', enabled: true, matches: ['https://a.com/*'], code: '',
    runAt: 'document_idle', world: 'USER_SCRIPT', source: 'user', createdAt: 1, updatedAt: 1,
    meta: { requires: ['https://cdn/lib.js'], resources: { css: 'https://cdn/s.css' } }, ...over,
  };
}

describe('gm-resources', () => {
  beforeEach(() => { fakeBrowser.reset(); vi.restoreAllMocks(); });

  it('prefetchResources：fetch 全部资源落缓存；成功返回空 warnings', async () => {
    const fetchMock = vi.fn(async (url: string) => ({
      ok: true, status: 200, headers: new Map([['content-type', 'text/javascript']]),
      text: async () => `content of ${url}`,
    }));
    vi.stubGlobal('fetch', fetchMock);
    const warnings = await prefetchResources(mkScript());
    expect(warnings).toEqual([]);
    const bundle = await getResourceBundle(mkScript());
    expect(bundle.requireCodes).toEqual(['content of https://cdn/lib.js']);
    expect(bundle.resources).toEqual({ css: 'content of https://cdn/s.css' });
    vi.unstubAllGlobals();
  });

  it('失败返回 warning 且不阻塞（spec §9.4 缺哪段跳哪段）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, headers: new Map(), text: async () => '' })));
    const warnings = await prefetchResources(mkScript());
    expect(warnings).toHaveLength(2); // require + resource 各一条
    expect(warnings[0]).toContain('https://cdn/lib.js');
    const bundle = await getResourceBundle(mkScript());
    expect(bundle.requireCodes).toEqual([undefined].filter(() => false)); // 失败段被跳过
    vi.unstubAllGlobals();
  });

  it('7 天内缓存命中不重取', async () => {
    const fetchMock = vi.fn(async (url: string) => ({ ok: true, status: 200, headers: new Map(), text: async () => `v1 ${url}` }));
    vi.stubGlobal('fetch', fetchMock);
    await prefetchResources(mkScript());
    await prefetchResources(mkScript());
    expect(fetchMock).toHaveBeenCalledTimes(2); // 第二次全命中缓存
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/background/gm-resources.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写实现**

```ts
// background/gm-resources.ts
// @require/@resource 预取与缓存（spec §9.4）：创建/更新时同步预取（30s 超时、单文件 ≤2MB、总量 ≤10MB），
// 7 天内缓存命中跳过；失败=保存成功但 warning，注入时缺哪段跳哪段。

import { storage } from 'wxt/utils/storage';
import type { UserScript } from '../shared/types';

const CACHE_KEY = 'local:gm:resources';
const FETCH_TIMEOUT_MS = 30_000;
const MAX_SINGLE = 2 * 1024 * 1024;
const MAX_TOTAL = 10 * 1024 * 1024;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface CacheEntry {
  content: string;
  fetchedAt: number;
}
type Cache = Record<string, CacheEntry>;

async function readCache(): Promise<Cache> {
  return (await storage.getItem<Cache>(CACHE_KEY)) ?? {};
}

async function fetchText(url: string): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('timeout')), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: ac.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const text = await resp.text();
    if (text.length > MAX_SINGLE) throw new Error(`超过单文件上限（${MAX_SINGLE} 字符）`);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/** 预取脚本声明的全部资源。返回 warnings（空 = 全成功/无资源）。 */
export async function prefetchResources(script: UserScript): Promise<string[]> {
  const requires = script.meta?.requires ?? [];
  const resources = script.meta?.resources ?? {};
  const urls = [...requires, ...Object.values(resources)];
  if (urls.length === 0) return [];

  const cache = await readCache();
  const now = Date.now();
  const warnings: string[] = [];
  let fetched = 0;

  for (const url of urls) {
    const hit = cache[url];
    if (hit && now - hit.fetchedAt < CACHE_TTL_MS) continue;
    try {
      const content = await fetchText(url);
      if (fetched + content.length > MAX_TOTAL) {
        warnings.push(`依赖下载失败：${url}（超过资源总量上限）`);
        continue;
      }
      cache[url] = { content, fetchedAt: now };
      fetched += content.length;
    } catch (e) {
      warnings.push(`依赖下载失败：${url}（${e instanceof Error ? e.message : String(e)}）`);
    }
  }
  if (Object.keys(cache).length > 0) await storage.setItem(CACHE_KEY, cache);
  return warnings;
}

/** wrapper 拼装时的资源包：requireCodes 按 meta.requires 顺序、resources name→text（缺段跳过，spec §9.4）。 */
export async function getResourceBundle(script: UserScript): Promise<{ requireCodes: string[]; resources: Record<string, string> }> {
  const cache = await readCache();
  const requires = script.meta?.requires ?? [];
  const resources = script.meta?.resources ?? {};
  const requireCodes: string[] = [];
  for (const url of requires) {
    const hit = cache[url];
    if (hit) requireCodes.push(hit.content);
  }
  const resourceTexts: Record<string, string> = {};
  for (const [name, url] of Object.entries(resources)) {
    const hit = cache[url];
    if (hit) resourceTexts[name] = hit.content;
  }
  return { requireCodes, resources: resourceTexts };
}
```

- [ ] **Step 4: 运行测试**

Run: `npx vitest run tests/background/gm-resources.test.ts`
Expected: 全部 PASS（注意第二个用例 `bundle.requireCodes` 断言实际应为 `[]`——`[undefined].filter(() => false)` 恒为 `[]`，语义等价但直接写 `[]` 更清晰，落地时改为 `expect(bundle.requireCodes).toEqual([]);`）

- [ ] **Step 5: Commit**

```bash
git add background/gm-resources.ts tests/background/gm-resources.test.ts
git commit -m "feat(gm): @require/@resource 预取缓存（7 天 TTL、单文件 2MB、总量 10MB）"
```

---

### Task 10: @connect 校验 + XHR + 确认流（并入 `background/gm-api.ts`）

**Files:**
- Modify: `background/gm-api.ts`
- Test: `tests/background/gm-connect.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/background/gm-connect.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { storage } from 'wxt/utils/storage';
import { matchConnect, ConnectDecision } from '../../background/gm-api';
import { setAlwaysAllow } from '../../background/gm-permissions';
import type { UserScript } from '../../shared/types';

function mkScript(over: Partial<UserScript> = {}): UserScript {
  return {
    id: 's1', text: '', name: 't', enabled: true, matches: ['https://a.com/*'], code: '',
    runAt: 'document_idle', world: 'USER_SCRIPT', source: 'user', createdAt: 1, updatedAt: 1,
    meta: { grants: ['GM_xmlhttpRequest'] }, ...over,
  };
}

import { saveScript } from '../../storage/scripts';

describe('matchConnect', () => {
  it('self：同 host / 子域放行', () => {
    expect(matchConnect([], 'https://api.a.com/x', 'https://a.com/', [])).toBe(ConnectDecision.ALLOW);
    expect(matchConnect([], 'https://a.com/x', 'https://a.com/', [])).toBe(ConnectDecision.ALLOW);
  });

  it('@connect 命中放行（精确 / *.通配 / *）', () => {
    expect(matchConnect(['api.b.com'], 'https://api.b.com/x', 'https://a.com/', [])).toBe(ConnectDecision.ALLOW);
    expect(matchConnect(['*.b.com'], 'https://x.b.com/x', 'https://a.com/', [])).toBe(ConnectDecision.ALLOW);
    expect(matchConnect(['*'], 'https://any.com/x', 'https://a.com/', [])).toBe(ConnectDecision.ALLOW);
  });

  it('列了 @connect 不命中 → DENY（提示补 @connect）', () => {
    expect(matchConnect(['b.com'], 'https://c.com/x', 'https://a.com/', [])).toBe(ConnectDecision.DENY);
  });

  it('未列 @connect：always 授权 → ALLOW；否则 CONFIRM', async () => {
    await setAlwaysAllow('s1', 'c.com');
    expect(await matchConnectAsync([], 'https://c.com/x', 'https://a.com/', 's1')).toBe(ConnectDecision.ALLOW);
    expect(await matchConnectAsync([], 'https://d.com/x', 'https://a.com/', 's1')).toBe(ConnectDecision.CONFIRM);
  });

  async function matchConnectAsync(connects: string[], reqUrl: string, pageUrl: string, scriptId: string): Promise<ConnectDecision> {
    const { matchConnectWithPermissions } = await import('../../background/gm-api');
    return matchConnectWithPermissions(connects, reqUrl, pageUrl, scriptId);
  }
});

describe('确认流（XmlHttpRequest handler）', () => {
  beforeEach(() => { fakeBrowser.reset(); vi.restoreAllMocks(); vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({} as never); });

  it('CONFIRM 路径：广播 GM_CONFIRM_PENDING；resolve allow-once 后 fetch', async () => {
    await saveScript(mkScript());
    const { handleGmCall, resolveConfirm } = await import('../../background/gm-api');
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, headers: new Map(), text: async () => 'body', url: 'https://c.com/x' }));
    vi.stubGlobal('fetch', fetchMock);

    const pending = handleGmCall(
      { scriptId: 's1', api: 'XmlHttpRequest', reqId: 1, params: [{ url: 'https://c.com/x', method: 'GET' }] },
      { tab: { id: 1, url: 'https://a.com/' } } as never,
    );
    await new Promise((r) => setTimeout(r, 10)); // 等 CONFIRM 广播

    const { getPendingConfirms } = await import('../../background/gm-api');
    const confirms = getPendingConfirms();
    expect(confirms).toHaveLength(1);
    expect(confirms[0]).toMatchObject({ scriptId: 's1', host: 'c.com' });

    await resolveConfirm(confirms[0]!.confirmId, 'allow-once');
    const r = await pending;
    expect(r).toEqual({ ok: true, data: { status: 200, body: 'body', headers: {}, finalUrl: 'https://c.com/x' } });
    vi.unstubAllGlobals();
  });

  it('resolve always → 落库 + fetch；deny → onerror 语义（ok:false）', async () => {
    await saveScript(mkScript());
    const { handleGmCall, resolveConfirm, getPendingConfirms } = await import('../../background/gm-api');
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, headers: new Map(), text: async () => 'ok', url: 'https://d.com/x' }));
    vi.stubGlobal('fetch', fetchMock);

    const pending = handleGmCall(
      { scriptId: 's1', api: 'XmlHttpRequest', reqId: 2, params: [{ url: 'https://d.com/x' }] },
      { tab: { id: 1, url: 'https://a.com/' } } as never,
    );
    await new Promise((r) => setTimeout(r, 10));
    const cid = getPendingConfirms()[0]!.confirmId;
    await resolveConfirm(cid, 'always');
    expect(await pending).toMatchObject({ ok: true });
    // always 已落库：下一次同域直通
    const again = await handleGmCall(
      { scriptId: 's1', api: 'XmlHttpRequest', reqId: 3, params: [{ url: 'https://d.com/x' }] },
      { tab: { id: 1, url: 'https://a.com/' } } as never,
    );
    expect(again).toMatchObject({ ok: true });
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/background/gm-connect.test.ts`
Expected: FAIL（matchConnect 等不存在）

- [ ] **Step 3: 实现并接入 `background/gm-api.ts`**

追加到文件（`handleGmCall` 的 XmlHttpRequest/AbortRequest case 替换为真实实现）：

```ts
// ---- @connect 校验（spec §8.1）----

export const ConnectDecision = { ALLOW: 0, DENY: 1, CONFIRM: 2 } as const;
export type ConnectDecision = (typeof ConnectDecision)[keyof typeof ConnectDecision];

function hostOf(url: string): string {
  try { return new URL(url).hostname; } catch { return ''; }
}

export function matchConnect(
  connects: string[], reqUrl: string, pageUrl: string, alwaysAllowedHosts: string[],
): ConnectDecision {
  const reqHost = hostOf(reqUrl);
  const pageHost = hostOf(pageUrl);
  if (!reqHost) return ConnectDecision.DENY;
  // self：同 host / 子域（页面是父域）
  if (reqHost === pageHost || `.${reqHost}`.endsWith(`.${pageHost}`)) return ConnectDecision.ALLOW;
  if (connects.includes('*')) return ConnectDecision.ALLOW;
  for (const c of connects) {
    const cc = c.toLowerCase();
    if (cc.startsWith('*.')) {
      const base = cc.slice(2);
      if (reqHost === base || reqHost.endsWith(`.${base}`)) return ConnectDecision.ALLOW;
    } else if (cc === reqHost) return ConnectDecision.ALLOW;
  }
  if (connects.some((c) => c && c !== 'none')) return ConnectDecision.DENY;
  if (alwaysAllowedHosts.includes(reqHost)) return ConnectDecision.ALLOW;
  return ConnectDecision.CONFIRM;
}

/** 异步版：查 always 授权库。 */
export async function matchConnectWithPermissions(
  connects: string[], reqUrl: string, pageUrl: string, scriptId: string,
): Promise<ConnectDecision> {
  const { getAlwaysAllow } = await import('./gm-permissions');
  const allowed = await getAlwaysAllow(scriptId, hostOf(reqUrl));
  return matchConnect(connects, reqUrl, pageUrl, allowed ? [hostOf(reqUrl)] : []);
}

// ---- 确认队列（spec §8.1，60s 超时拒绝）----

export interface GmConfirm {
  confirmId: string;
  scriptId: string;
  host: string;
  url: string;
  createdAt: number;
}

const pendingConfirms = new Map<string, { confirm: GmConfirm; resolve: (v: 'allow-once' | 'always' | 'deny') => void }>();
const CONFIRM_TIMEOUT_MS = 60_000;

export function getPendingConfirms(): GmConfirm[] {
  return [...pendingConfirms.values()].map((p) => p.confirm);
}

function queueConfirm(scriptId: string, url: string): Promise<'allow-once' | 'always' | 'deny'> {
  return new Promise((resolve) => {
    const confirmId = crypto.randomUUID();
    const confirm: GmConfirm = { confirmId, scriptId, host: hostOf(url), url, createdAt: Date.now() };
    pendingConfirms.set(confirmId, { confirm, resolve });
    void broadcastToPanel({ type: 'GM_CONFIRM_PENDING', confirm });
    setTimeout(() => {
      if (pendingConfirms.has(confirmId)) {
        pendingConfirms.delete(confirmId);
        resolve('deny');
        void broadcastToPanel({ type: 'GM_CONFIRM_RESOLVED', confirmId });
      }
    }, CONFIRM_TIMEOUT_MS);
  });
}

export async function resolveConfirm(confirmId: string, decision: 'allow-once' | 'always' | 'deny'): Promise<void> {
  const entry = pendingConfirms.get(confirmId);
  if (!entry) return;
  pendingConfirms.delete(confirmId);
  if (decision === 'always') {
    const { setAlwaysAllow } = await import('./gm-permissions');
    await setAlwaysAllow(entry.confirm.scriptId, entry.confirm.host);
  }
  entry.resolve(decision);
  void broadcastToPanel({ type: 'GM_CONFIRM_RESOLVED', confirmId });
}

// ---- GM_xmlhttpRequest 实现（替换 Task 7 占位 case）----

const XHR_MAX_BODY = 1024 * 1024;
const HEADER_ALLOW = new Set(['content-type', 'content-length', 'server', 'date', 'cache-control', 'last-modified', 'etag']);

async function doXmlHttpRequest(
  scriptId: string, params: unknown[], sender: Sender,
): Promise<{ ok: true; data?: unknown } | { ok: false; error: string }> {
  const details = (params[0] ?? {}) as { url?: string; method?: string; headers?: Record<string, string>; body?: string; timeout?: number };
  if (!details.url) return { ok: false, error: 'GM_xmlhttpRequest 缺少 url' };
  const script = await getScript(scriptId);
  if (!script) return { ok: false, error: '脚本不存在' };
  const pageUrl = sender?.tab?.url ?? '';
  const decision = await matchConnectWithPermissions(script.meta?.connects ?? [], details.url, pageUrl, scriptId);
  if (decision === ConnectDecision.CONFIRM) {
    const choice = await queueConfirm(scriptId, details.url);
    if (choice === 'deny') return { ok: false, error: 'permission denied（用户拒绝或确认超时；可在脚本头部加 @connect 或打开侧边栏批准）' };
  } else if (decision === ConnectDecision.DENY) {
    return { ok: false, error: `Refused to connect to "${hostOf(details.url)}"：不在 @connect 列表（SC 同款语义，请补 @connect）` };
  }
  // unsafe header 忽略 + 记 warning（无 DNR，spec §8.1 差异声明）
  const headers: Record<string, string> = {};
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(details.headers ?? {})) {
    if (/^(user-agent|referer|cookie|origin|host|cookie2)$/i.test(k)) dropped.push(k);
    else headers[k] = v;
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('timeout')), details.timeout ?? 30_000);
  try {
    const resp = await fetch(details.url, {
      method: details.method ?? 'GET',
      headers,
      body: details.body,
      signal: ac.signal,
      credentials: 'include',
    });
    const text = await resp.text();
    const outHeaders: Record<string, string> = {};
    resp.headers.forEach((v, k) => { if (HEADER_ALLOW.has(k.toLowerCase())) outHeaders[k.toLowerCase()] = v; });
    return {
      ok: true,
      data: {
        status: resp.status,
        statusText: resp.statusText,
        headers: outHeaders,
        body: text.length > XHR_MAX_BODY ? text.slice(0, XHR_MAX_BODY) : text,
        truncated: text.length > XHR_MAX_BODY,
        finalUrl: resp.url,
        ...(dropped.length > 0 ? { droppedHeaders: dropped } : {}),
      },
    };
  } catch (e) {
    return { ok: false, error: `GM_xmlhttpRequest 失败：${e instanceof Error ? e.message : String(e)}` };
  } finally {
    clearTimeout(timer);
  }
}
```

`handleGmCall` 里替换 case：

```ts
    case 'XmlHttpRequest':
      return doXmlHttpRequest(scriptId, params, sender);
    case 'AbortRequest':
      return { ok: true, data: null }; // 一次性请求模型：abort 后到的响应被 content 宿主丢弃（简化语义，文档明示）
```

`initGmApi` 追加：

```ts
  router.on('GM_CONFIRM_RESOLVE', async (msg) => {
    const { confirmId, decision } = msg as unknown as { confirmId: string; decision: 'allow-once' | 'always' | 'deny' };
    await resolveConfirm(confirmId, decision);
    return { ok: true };
  });
```

- [ ] **Step 4: 运行测试**

Run: `npx vitest run tests/background/gm-connect.test.ts tests/background/gm-api.test.ts`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add background/gm-api.ts tests/background/gm-connect.test.ts
git commit -m "feat(gm): @connect 三分支校验 + XHR 实现 + 60s 确认队列（allow-once/always/deny）"
```

---

### Task 11: 编排层接线（`background/scripts.ts` 走 wrapper + 预取 + 清理）

**Files:**
- Modify: `background/scripts.ts`
- Test: `tests/background/scripts.test.ts`（追加用例）

- [ ] **Step 1: 写失败测试（追加到现有文件）**

```ts
describe('wrapper 接线（Phase 5）', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
    getRuntimeSnapshot().forEach((e) => dropTab(e.tabId));
    vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({} as never);
  });

  it('toRegisterDetails 经 syncRegistrations：grant 脚本注册的是 wrapped code', async () => {
    installFakeUserScripts();
    await saveScript(mkScript({ meta: { grants: ['GM_setValue'] } }));
    await syncRegistrations();
    const api = (browser as unknown as { userScripts: FakeUserScriptsApi }).userScripts;
    const reg = api.register.mock.calls[0]![0] as { js: Array<{ code: string }> };
    expect(reg.js[0]!.code).toContain('__GM_PREAMBLE__');
    expect(reg.js[0]!.code).toContain('userCode();'.length > 0 ? 'install' : '');
  });

  it('无 grant 脚本注册裸 code（零开销）', async () => {
    installFakeUserScripts();
    await saveScript(mkScript({ meta: undefined }));
    await syncRegistrations();
    const api = (browser as unknown as { userScripts: FakeUserScriptsApi }).userScripts;
    const reg = api.register.mock.calls[0]![0] as { js: Array<{ code: string }> };
    expect(reg.js[0]!.code).toBe('x();');
  });

  it('handleCreate 后预取 @require（fetch mock 落缓存）', async () => {
    installFakeUserScripts();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, headers: new Map(), text: async () => 'lib();' })));
    const src = '// ==UserScript==\n// @name t\n// @match https://a.com/*\n// @grant GM_getValue\n// @require https://cdn/lib.js\n// ==/UserScript==\nx();';
    const { script } = await handleCreate({ text: src });
    expect(script.meta?.requires).toEqual(['https://cdn/lib.js']);
    const { getResourceBundle } = await import('../../background/gm-resources');
    const bundle = await getResourceBundle(script);
    expect(bundle.requireCodes).toEqual(['lib();']);
    vi.unstubAllGlobals();
  });

  it('handleDelete 清理值域/错误/菜单', async () => {
    installFakeUserScripts();
    await saveScript(mkScript());
    const { storage } = await import('wxt/utils/storage');
    await storage.setItem('local:script-values:s1', { k: 1 });
    await handleDelete('s1');
    expect(await storage.getItem('local:script-values:s1')).toBeNull();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/background/scripts.test.ts`
Expected: 新增用例 FAIL（注册的是裸 code；无预取；无清理）

- [ ] **Step 3: 修改 `background/scripts.ts`**

文件头追加导入：

```ts
import { buildWrappedCode } from '../shared/gm-wrapper';
import { getBridgeToken } from './gm-token';
import { prefetchResources, getResourceBundle } from './gm-resources';
import { cleanupScriptState, readValuesForSnapshot } from './gm-api';
```

`toRegisterDetails` 改为 async（buildWrappedCode 的 deps 需要 token/值/资源——**不能在 diff 循环里逐个 await**，改为先构建全部再 diff）：

```ts
async function toRegisterDetailsAsync(s: UserScript): Promise<RegisterUserScript> {
  const grants = s.meta?.grants ?? [];
  const realGrants = grants.filter((g) => g !== 'none');
  const hasRequires = (s.meta?.requires?.length ?? 0) > 0;
  if (realGrants.length === 0 && !hasRequires) {
    return { id: s.id, matches: s.matches, js: [{ code: s.code }], runAt: s.runAt, world: s.world, persistAcrossSessions: true };
  }
  const [token, values, bundle] = await Promise.all([
    getBridgeToken(s.id),
    readValuesForSnapshot(s.id),
    getResourceBundle(s),
  ]);
  const manifest = browser.runtime.getManifest();
  return {
    id: s.id,
    matches: s.matches,
    js: [{ code: buildWrappedCode(s, { token, values, resources: bundle.resources, requireCodes: bundle.requireCodes, extensionVersion: manifest.version }) }],
    runAt: s.runAt,
    world: s.world,
    persistAcrossSessions: true,
  };
}
```

`syncRegistrations` 中 `missing`/`drifted` 两处 `.map(toRegisterDetails)` 改为：

```ts
  if (missing.length > 0) await api.register(await Promise.all(missing.map(toRegisterDetailsAsync)));
  // drifted 循环内：
  for (const s of drifted) {
    try {
      await api.update([await toRegisterDetailsAsync(s)]);
    } catch {
      await api.unregister([s.id]);
      await api.register([await toRegisterDetailsAsync(s)]);
    }
  }
```

`sameRegistration` 不变（drift 检测比的是 UserScript 投影字段，投影变了就 update，重拿 wrapper——正确）。

`handleCreate` / `handleImport` 落库后追加预取（`syncBestEffort()` 之前）：

```ts
  const resWarnings = await prefetchResources(script);
```

返回合并：`warnings: [...warnings, ...resWarnings, ...syncWarnings]`。

`handleUpdate` 文本路径同样追加（`saveScript(next)` 之后）：`const resWarnings = await prefetchResources(next);`——handleUpdate 返回 `UserScript`，warning 无处挂；**改为预取失败仅 console.warn**（UI 已有「依赖下载失败」展示位在详情页 warnings 区——本阶段从简：update 路径 console.warn，spec 降级记录）。

`handleDelete` 追加（`deleteScript(id)` 之后）：

```ts
  await cleanupScriptState(id);
```

`background/gm-api.ts` 导出值快照读取（Task 7 已有 `readValues`，追加导出别名）：

```ts
export async function readValuesForSnapshot(scriptId: string): Promise<Record<string, unknown>> {
  return readValues(scriptId);
}
```

- [ ] **Step 4: 运行全部脚本测试**

Run: `npx vitest run tests/background/scripts.test.ts`
Expected: 全部 PASS（含既有用例——无 grant 脚本路径行为不变）

- [ ] **Step 5: Commit**

```bash
git add background/scripts.ts background/gm-api.ts tests/background/scripts.test.ts
git commit -m "feat(gm): 注册走 buildWrappedCode + CRUD 预取资源 + 删除清理脚本态"
```

---

### Task 12: ISOLATED 桥宿主（`content/gm-bridge-host.ts` + content.ts 挂载）

**Files:**
- Create: `content/gm-bridge-host.ts`
- Modify: `entrypoints/content.ts`
- Test: `tests/content/gm-bridge-host.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/content/gm-bridge-host.test.ts
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { initBridgeHost } from '../../content/gm-bridge-host';
import { gmReqEvent, gmResEvent } from '../../shared/gm-bridge';

describe('gm-bridge-host', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
  });

  it('initBridgeHost：拉 token 表 + 挂 gmreq 监听 + 转发 GM_API_CALL 到 runtime', async () => {
    // fake-browser 契约：sendResponse + return true（同 stores 测试惯例）
    browser.runtime.onMessage.addListener((msg: { type: string }, _sender, sendResponse) => {
      if (msg.type === 'GM_BRIDGE_TOKENS') {
        sendResponse({ ok: true, data: { entries: [{ scriptId: 's1', token: 'tok' }] } });
        return true;
      }
      if (msg.type === 'GM_API_CALL') {
        expect(msg).toMatchObject({ scriptId: 's1', api: 'SetValue', params: ['k', 1] });
        sendResponse({ ok: true, data: null });
        return true;
      }
      sendResponse({ ok: false, error: 'unexpected' });
      return true;
    });

    const dispose = initBridgeHost();
    await new Promise((r) => setTimeout(r, 10)); // 等 token 拉取

    // 模拟 wrapper 派发请求（正确 token）
    const resListener = vi.fn();
    window.addEventListener(gmResEvent('s1'), resListener);
    window.dispatchEvent(new CustomEvent(gmReqEvent('s1'), {
      detail: { token: 'tok', reqId: 7, api: 'SetValue', params: ['k', 1] },
    }));
    await new Promise((r) => setTimeout(r, 10));
    expect(resListener).toHaveBeenCalledTimes(1);
    expect((resListener.mock.calls[0]![0] as CustomEvent).detail).toMatchObject({ reqId: 7, ok: true });
    dispose();
  });

  it('错误 token 的请求被丢弃（不转发、不响应）', async () => {
    browser.runtime.onMessage.addListener((_msg, _sender, sendResponse) => { sendResponse({ ok: true }); return true; });
    const dispose = initBridgeHost();
    await new Promise((r) => setTimeout(r, 10));

    const sendSpy = vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({} as never);
    const resListener = vi.fn();
    window.addEventListener(gmResEvent('s1'), resListener);
    window.dispatchEvent(new CustomEvent(gmReqEvent('s1'), {
      detail: { token: 'WRONG', reqId: 8, api: 'SetValue', params: [] },
    }));
    await new Promise((r) => setTimeout(r, 10));
    expect(sendSpy).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'GM_API_CALL' }));
    expect(resListener).not.toHaveBeenCalled();
    dispose();
  });

  it('GM_EVENT 下行：宿主转发为 gmevt 页面事件', async () => {
    browser.runtime.onMessage.addListener((_msg, _sender, sendResponse) => { sendResponse({ ok: true, data: { entries: [] } }); return true; });
    const dispose = initBridgeHost();
    await new Promise((r) => setTimeout(r, 10));

    const evtListener = vi.fn();
    window.addEventListener('gmevt:s1', evtListener);
    // 直接调宿主导出的 handleGmEvent（模拟 tabs.sendMessage 到达）
    const { handleGmEvent } = await import('../../content/gm-bridge-host');
    handleGmEvent({ type: 'GM_EVENT', scriptId: 's1', kind: 'MENU_CLICK', data: { key: 'm1' } });
    expect(evtListener).toHaveBeenCalledTimes(1);
    expect((evtListener.mock.calls[0]![0] as CustomEvent).detail).toMatchObject({ kind: 'MENU_CLICK', data: { key: 'm1' } });
    dispose();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/content/gm-bridge-host.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写实现**

```ts
// content/gm-bridge-host.ts
// ISOLATED 侧桥宿主（spec §6）：向 SW 拉 token 表（按当前 URL），监听 gmreq:* 页面事件
// 校验 token 后转发 GM_API_CALL；SW 下行 GM_EVENT 转发为 gmevt:* 页面事件。
// 与 wrapper 同帧同页（USER_SCRIPT/MAIN 世界派发的 CustomEvent 在 ISOLATED 世界可见——同一 DOM）。

import { gmReqEvent, gmResEvent, gmEvtEvent, type GmBridgeRequest } from '../shared/gm-bridge';

interface TokenEntry { scriptId: string; token: string }

let tokens = new Map<string, string>();
let disposed = false;
let reqListener: ((e: Event) => void) | null = null;

async function refreshTokens(): Promise<void> {
  try {
    const resp = await browser.runtime.sendMessage({ type: 'GM_BRIDGE_TOKENS', url: location.href }) as
      { ok: boolean; data?: { entries: TokenEntry[] } } | undefined;
    if (resp?.ok && resp.data) {
      tokens = new Map(resp.data.entries.map((e) => [e.scriptId, e.token]));
    }
  } catch {
    // SW 未就绪——保持现有表，下次导航自愈
  }
}

export function initBridgeHost(): () => void {
  void refreshTokens();
  reqListener = (e: Event) => {
    const detail = (e as CustomEvent<GmBridgeRequest>).detail;
    if (!detail || typeof detail.api !== 'string') return;
    const token = tokens.get(detail.scriptId ?? '');
    if (!token || token !== detail.token) return; // 防伪造（spec §6）
    void browser.runtime.sendMessage({
      type: 'GM_API_CALL',
      scriptId: detail.scriptId,
      api: detail.api,
      reqId: detail.reqId,
      params: detail.params,
    }).then((resp) => {
      window.dispatchEvent(new CustomEvent(gmResEvent(detail.scriptId), {
        detail: { reqId: detail.reqId, ...(resp as { ok: boolean; data?: unknown; error?: string }) },
      }));
    }).catch((err) => {
      window.dispatchEvent(new CustomEvent(gmResEvent(detail.scriptId), {
        detail: { reqId: detail.reqId, ok: false, error: String(err) },
      }));
    });
  };
  window.addEventListener('gmreq:', reqListener); // capture 事件名前缀——见下方说明
  return () => {
    disposed = true;
    if (reqListener) window.removeEventListener('gmreq:', reqListener);
  };
}

/** SW 的 GM_EVENT 消息到达 content script 时的转发入口（entrypoints/content.ts onMessage 分支调用）。 */
export function handleGmEvent(msg: { type: 'GM_EVENT'; scriptId: string; kind: string; data: Record<string, unknown> }): void {
  window.dispatchEvent(new CustomEvent(gmEvtEvent(msg.scriptId), { detail: { kind: msg.kind, data: msg.data } }));
}
```

**关键修正**：`window.addEventListener('gmreq:', ...)` 前缀监听不行——DOM 事件名必须精确。正确做法是动态监听：宿主在 token 表刷新后，对每个 scriptId `addEventListener(gmReqEvent(scriptId), ...)`。落地时改为：

```ts
let listenersByScript = new Map<string, (e: Event) => void>();

function attachFor(scriptId: string): void {
  if (listenersByScript.has(scriptId)) return;
  const listener = (e: Event) => {
    const detail = (e as CustomEvent<GmBridgeRequest>).detail;
    if (!detail || typeof detail.api !== 'string') return;
    if (tokens.get(scriptId) !== detail.token) return; // 防伪造
    void browser.runtime.sendMessage({
      type: 'GM_API_CALL', scriptId, api: detail.api, reqId: detail.reqId, params: detail.params,
    }).then((resp) => {
      window.dispatchEvent(new CustomEvent(gmResEvent(scriptId), {
        detail: { reqId: detail.reqId, ...(resp as { ok: boolean; data?: unknown; error?: string }) },
      }));
    }).catch((err) => {
      window.dispatchEvent(new CustomEvent(gmResEvent(scriptId), {
        detail: { reqId: detail.reqId, ok: false, error: String(err) },
      }));
    });
  };
  window.addEventListener(gmReqEvent(scriptId), listener);
  listenersByScript.set(scriptId, listener);
}

export function initBridgeHost(): () => void {
  void refreshTokens().then(() => {
    for (const id of tokens.keys()) attachFor(id);
  });
  return () => {
    for (const [id, fn] of listenersByScript) window.removeEventListener(gmReqEvent(id), fn);
    listenersByScript = new Map();
  };
}
```

（`refreshTokens` 成功后重挂监听：token 表是全量替换，`refreshTokens` 末尾加 `for (const id of tokens.keys()) attachFor(id);`。）

`entrypoints/content.ts` 的 `main()` 挂载（现有 onMessage listener 之后）：

```ts
    // GM 桥宿主（Phase 5 spec §6）：拉 token 表 + 转发 gmreq/gmevt
    const disposeBridge = initBridgeHost();
    // SW 下行 GM_EVENT → 页面 gmevt（tabs.sendMessage 单发，此 listener 同时服务 CS 请求与 GM 下行）
    const gmListener = (msg: unknown) => {
      const m = msg as { type?: string };
      if (m?.type === 'GM_EVENT') handleGmEvent(m as Parameters<typeof handleGmEvent>[0]);
    };
    browser.runtime.onMessage.addListener(gmListener);
```

（`main()` 返回值惯例：现有 content script 不返回 dispose——保持一致，不清理（页面卸载即销毁）。上面 disposeBridge 仅测试用。）

- [ ] **Step 4: 运行测试**

Run: `npx vitest run tests/content/gm-bridge-host.test.ts`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add content/gm-bridge-host.ts entrypoints/content.ts tests/content/gm-bridge-host.test.ts
git commit -m "feat(gm): ISOLATED 桥宿主——token 校验转发 + GM_EVENT 下行分发"
```

---

### Task 13: store 扩展 + UI 三新区（菜单/错误/批准卡）

**Files:**
- Modify: `stores/scripts.ts`、`components/scripts/ScriptsView.tsx`、`components/scripts/ScriptsListView.tsx`、`components/scripts/ScriptDetailView.tsx`
- Create: `components/scripts/ScriptsConfirmCard.tsx`
- Modify: `entrypoints/sidepanel/styles.css`
- Test: `tests/stores/scripts.test.ts`（追加）

- [ ] **Step 1: store 测试先行（追加到 `tests/stores/scripts.test.ts`）**

```ts
describe('Phase 5：menus/errors/confirms 状态', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
    useScripts.setState({ summaries: [], runtimeEntries: {}, activeTabId: null, query: '', loading: false, engineWarning: null, menus: [], errors: {}, confirms: [] });
  });

  it('applyMenusEvent / applyErrorEvent / applyConfirmEvent', () => {
    const s = useScripts.getState();
    s.applyMenusEvent({ type: 'SCRIPTS_MENUS', entries: [{ scriptId: 's1', commands: [{ key: 'm1', name: '抓取' }] }] });
    expect(useScripts.getState().menus).toHaveLength(1);

    s.applyErrorEvent({ type: 'SCRIPTS_ERROR', scriptId: 's1', error: { at: 1, message: 'boom' } });
    expect(useScripts.getState().errors['s1']).toHaveLength(1);

    s.applyConfirmEvent({ type: 'GM_CONFIRM_PENDING', confirm: { confirmId: 'c1', scriptId: 's1', host: 'x.com', url: 'https://x.com/', createdAt: 1 } });
    expect(useScripts.getState().confirms).toHaveLength(1);
  });

  it('activeMenuCommands：当前 tab 运行集内脚本的菜单命令展开', () => {
    useScripts.setState({
      activeTabId: 1,
      runtimeEntries: { 1: { tabId: 1, url: 'https://a.com/', scriptIds: ['s1'] } },
      menus: [{ scriptId: 's1', commands: [{ key: 'm1', name: '抓取' }], scriptId_x: undefined as never }],
      summaries: [mkSummary()],
    } as never);
    const cmds = useScripts.getState().activeMenuCommands();
    expect(cmds).toEqual([{ scriptId: 's1', key: 'm1', name: '抓取' }]);
  });
});
```

（`mkSummary` 是测试文件已有的 helper；`activeMenuCommands` 的 menus 元素形状 `{ scriptId, commands }`——上面误写的 `scriptId_x` 字段去掉。）

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/stores/scripts.test.ts`
Expected: 新用例 FAIL（menus 等字段不存在）

- [ ] **Step 3: store 实现（`stores/scripts.ts`）**

类型与状态追加：

```ts
export interface GmMenuEntry { scriptId: string; commands: Array<{ key: string; name: string }> }
export interface GmErrorItem { at: number; message: string; stack?: string; line?: number }
export interface GmConfirmItem { confirmId: string; scriptId: string; host: string; url: string; createdAt: number }
```

`ScriptsState` 追加字段与方法：

```ts
  menus: GmMenuEntry[];
  errors: Record<string, GmErrorItem[]>;
  confirms: GmConfirmItem[];
  applyMenusEvent: (e: { entries: GmMenuEntry[] }) => void;
  applyErrorEvent: (e: { scriptId: string; error: GmErrorItem }) => void;
  applyConfirmEvent: (e: { confirm: GmConfirmItem }) => void;
  applyConfirmResolved: (confirmId: string) => void;
  activeMenuCommands: () => Array<{ scriptId: string; key: string; name: string }>;
```

实现（`create` 内）：

```ts
  menus: [],
  errors: {},
  confirms: [],

  applyMenusEvent: (e) => set({ menus: e.entries }),

  applyErrorEvent: (e) =>
    set((s) => {
      const cur = s.errors[e.scriptId] ?? [];
      const next = [...cur, e.error].slice(-20);
      return { errors: { ...s.errors, [e.scriptId]: next } };
    }),

  applyConfirmEvent: (e) => set((s) => ({ confirms: [...s.confirms, e.confirm] })),
  applyConfirmResolved: (confirmId) => set((s) => ({ confirms: s.confirms.filter((c) => c.confirmId !== confirmId) })),

  activeMenuCommands: () => {
    const s = useScripts.getState();
    const entry = s.activeTabId != null ? s.runtimeEntries[s.activeTabId] : undefined;
    if (!entry) return [];
    const out: Array<{ scriptId: string; key: string; name: string }> = [];
    for (const m of s.menus) {
      if (!entry.scriptIds.includes(m.scriptId)) continue;
      for (const c of m.commands) out.push({ scriptId: m.scriptId, key: c.key, name: c.name });
    }
    return out;
  },
```

`ScriptsView.tsx` 的 onMessage 订阅追加分支：

```ts
      if (m?.type === 'SCRIPTS_MENUS') useScripts.getState().applyMenusEvent(msg as never);
      if (m?.type === 'SCRIPTS_ERROR') useScripts.getState().applyErrorEvent(msg as never);
      if (m?.type === 'GM_CONFIRM_PENDING') useScripts.getState().applyConfirmEvent(msg as never);
      if (m?.type === 'GM_CONFIRM_RESOLVED') useScripts.getState().applyConfirmResolved((msg as { confirmId: string }).confirmId);
      if (m?.type === 'SCRIPTS_ERROR_CLEARED') {
        const { scriptId } = msg as { scriptId: string };
        useScripts.setState((s) => { const e = { ...s.errors }; delete e[scriptId]; return { errors: e }; });
      }
```

- [ ] **Step 4: 批准卡组件（`components/scripts/ScriptsConfirmCard.tsx`）**

```tsx
// components/scripts/ScriptsConfirmCard.tsx
// 批准卡（spec §11）：SW GM_CONFIRM_PENDING 广播驱动；允许一次/总是允许/拒绝 + 60s 倒计时。
import { useEffect, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { Button } from '../ui/Button';
import type { GmConfirmItem } from '../../stores/scripts';

async function resolve(confirmId: string, decision: 'allow-once' | 'always' | 'deny'): Promise<void> {
  await browser.runtime.sendMessage({ type: 'GM_CONFIRM_RESOLVE', confirmId, decision });
}

export function ScriptsConfirmCard({ confirm }: { confirm: GmConfirmItem }) {
  const [left, setLeft] = useState(60);
  useEffect(() => {
    const t = setInterval(() => setLeft((v) => Math.max(0, v - 1)), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="scripts-notice" role="alert">
      <ShieldAlert size={14} style={{ flexShrink: 0, marginTop: 1 }} />
      <div style={{ flex: 1 }}>
        <div>脚本「{confirm.scriptId.slice(0, 8)}」请求跨域访问 <span className="mono">{confirm.host}</span></div>
        <div className="mono" style={{ fontSize: 11, color: 'var(--ink-3)' }}>{confirm.url}</div>
        <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
          <Button onClick={() => void resolve(confirm.confirmId, 'allow-once')}>允许一次</Button>
          <Button onClick={() => void resolve(confirm.confirmId, 'always')}>总是允许</Button>
          <Button variant="danger" onClick={() => void resolve(confirm.confirmId, 'deny')}>拒绝（{left}s）</Button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: 列表页与详情页改造**

`ScriptsListView.tsx`：

1. 引擎警示条之后追加批准卡区与菜单命令区：

```tsx
      {confirms.map((c) => <ScriptsConfirmCard key={c.confirmId} confirm={c} />)}

      <div className="scripts-run">
        <div className="scripts-run__head mono">MENU · {menuCommands.length}</div>
        {menuCommands.length === 0 ? (
          <div className="scripts-run__empty">当前页脚本无菜单命令</div>
        ) : (
          menuCommands.map((c) => (
            <button
              key={`${c.scriptId}:${c.key}`}
              className="scripts-menubtn"
              onClick={() => void sendScriptsRequest({ type: 'SCRIPTS_MENU_INVOKE', scriptId: c.scriptId, key: c.key })}
            >
              {c.name}
            </button>
          ))
        )}
      </div>
```

（组件头取 `const { ..., menus, confirms } = useScripts();` 与 `const menuCommands = useScripts.getState().activeMenuCommands();`——为响应式正确，用 hook 内计算：`const menuCommands = useMemo(() => { /* 同 activeMenuCommands 逻辑 */ }, [menus, runtimeEntries, activeTabId]);` 或直接在 store selector 里派生。落地时用 `const menuCommands = activeMenuCommandsSelector(runtimeEntries[activeTabId ?? -1], menus);`——把 `activeMenuCommands` 的纯逻辑提为可导出纯函数 `selectMenuCommands(entry, menus)` 供组件与 store 双用。）

2. grant 徽标精确化（替换现有 `s.hasGrants` 徽标块）：

```tsx
            {(() => {
              const g = grantBadge(s);
              return g ? (
                <span className={`scripts-badge ${g.unsupportedCount > 0 ? 'scripts-badge--warn' : ''}`} title={g.title}>
                  GM {g.supportedCount > 0 ? `${g.supportedCount}✓` : ''}{g.unsupportedCount > 0 ? ` ${g.unsupportedCount}✗` : ''}
                </span>
              ) : null;
            })()}
```

（`grantBadge(s)` 从 `ScriptSummary` 派生：summary 已有 `hasGrants` 但无明细——**加 `grantSupported: string[]` / `grantUnsupported: string[]` 到 ScriptSummary**（Task 3 types + toSummary 从 `classifyGrants` 填充），徽标与详情页都吃它。`grantBadge` 返回 `null` 当两列表都空。）

3. 错误徽标（启停按钮之前）：

```tsx
            {s.errorCount > 0 && (
              <span className="scripts-badge scripts-badge--warn" title="脚本运行报错（详情页查看）">{s.errorCount} errors</span>
            )}
```

`ScriptDetailView.tsx`：

1. 解析面板 grant 段替换为逐条标注：

```tsx
            {f.meta.grants && f.meta.grants.length > 0 && (
              <div className="mono" style={{ fontSize: 11 }}>
                {f.meta.grants.map((g) => {
                  const { supported } = classifyGrants([g]);
                  return (
                    <div key={g} style={{ color: supported.length > 0 ? 'var(--ink-2)' : 'var(--warn)' }}>
                      {supported.length > 0 ? '✓' : '✗'} {g}
                    </div>
                  );
                })}
              </div>
            )}
```

2. 「运行错误」折叠区（源码编辑区之后、footer 之前）：

```tsx
        {errors.length > 0 && (
          <div className="scripts-run">
            <div className="scripts-run__head mono">
              ERRORS · {errors.length}
              <Button variant="ghost" style={{ marginLeft: 'auto' }} onClick={() => void sendScriptsRequest({ type: 'SCRIPTS_CLEAR_ERRORS', id })}>
                清空
              </Button>
            </div>
            {errors.slice(-10).reverse().map((e, i) => (
              <div key={i} className="scripts-run__item">
                {new Date(e.at).toLocaleTimeString()} · line {e.line ?? '?'} · {e.message}
              </div>
            ))}
          </div>
        )}
```

（组件头 `const errors = useScripts((s) => s.errors[id] ?? []);`）

`styles.css` 追加（scripts 区末尾）：

```css
.scripts-menubtn {
  font: inherit; font-size: 12px; text-align: left; cursor: pointer;
  border: 1px solid var(--line); background: var(--surface); color: var(--ink);
  border-radius: 8px; padding: 4px 8px; margin: 2px 0; display: block; width: 100%;
}
.scripts-menubtn:hover { border-color: var(--line-strong); }
```

- [ ] **Step 6: ScriptSummary grant 明细化（回填 Task 3）**

`shared/types.ts` ScriptSummary 追加：

```ts
  grantSupported: string[];
  grantUnsupported: string[];
```

`storage/scripts.ts` toSummary 填充：

```ts
    const { supported, unsupported } = classifyGrants(s.meta?.grants ?? []);
    // …返回对象内：
    grantSupported: supported,
    grantUnsupported: unsupported,
```

（文件头 `import { classifyGrants } from '../shared/gm-apis';`；既有 toSummary 测试若做精确 toEqual 断言需补这两个字段。）

- [ ] **Step 7: 运行测试**

Run: `npx vitest run tests/stores/scripts.test.ts tests/storage/scripts.test.ts`
Expected: 全部 PASS

- [ ] **Step 8: Commit**

```bash
git add stores/scripts.ts components/scripts/ shared/types.ts storage/scripts.ts entrypoints/sidepanel/styles.css tests/
git commit -m "feat(gm): UI 三新区——菜单命令区/错误徽标与详情错误区/批准卡；grant 徽标精确化"
```

---

### Task 14: schema 描述、manifest 权限、文档与收尾

**Files:**
- Modify: `agent/tools/schemas.ts`、`wxt.config.ts`、`docs/gm-api.md`、`CLAUDE.md`
- Test: `tests/agent/tools/schemas.test.ts`（更新既有断言）

- [ ] **Step 1: schemas 描述更新**

`list_scripts` 的 description 改为：

```ts
      description:
        '列出脚本库中的用户脚本摘要（不含代码体）。enabled 按启用状态过滤；urlContains 按匹配模式子串过滤（大小写不敏感）。summary 含 errorCount（脚本运行报错条数，>0 时可主动向用户提议排查）与 grantSupported/grantUnsupported（GM API 支持状态）。需要完整代码时用 get_script。',
```

- [ ] **Step 2: schemas 测试补 grant 字段断言（追加用例）**

```ts
  it('list_scripts 描述提及 errorCount 与 grant 状态', () => {
    const l = TOOL_SCHEMAS.find((s) => s.function.name === 'list_scripts')!;
    expect(l.function.description).toContain('errorCount');
    expect(l.function.description).toContain('grantUnsupported');
  });
```

- [ ] **Step 3: manifest 权限**

`wxt.config.ts`：

```ts
    permissions: ['tabs', 'scripting', 'storage', 'sidePanel', 'webRequest', 'userScripts', 'notifications', 'clipboardWrite'],
```

- [ ] **Step 4: 全量回归 + 类型检查**

Run: `npm run test && npm run compile`
Expected: 全部 PASS、无类型错误。（既有 `tests/storage/scripts.test.ts` 的 toSummary 断言、`tests/agent/tools/script-pool.test.ts` 的 summary 断言若做精确匹配需补新字段——errorCount/hasRequires/grantSupported/grantUnsupported。）

- [ ] **Step 5: 文档更新**

`docs/gm-api.md` 头部状态段替换为（原「Phase 5 计划实现」的条目转为实现说明）：

```markdown
> 状态：Phase 5 已实现首批 14 个（见 §11 速览）。本节补充实现行为细节：
> - 双形态：`GM_xxx` 下划线形式同步（值类读快照）；`GM.xxx` 点形式返回 Promise。
> - 值存储：注入时快照直嵌；写穿透 SW 落库并广播其它 tab（`GM_addValueChangeListener` 的 remote=true）。
> - `GM_xmlhttpRequest`：@connect 三分支（self/子域与 @connect 命中放行；列了不中拒绝；未列入确认卡——允许一次/总是允许/拒绝，60s 超时拒）。被 fetch 禁的头（user-agent/referer/cookie/origin/host）忽略并在响应 droppedHeaders 列出。响应非流式、≤1MB 截断（truncated 标记）。
> - `GM_addStyle` 当前 world 直接建 DOM；`GM_log` 本地 console 带 `[脚本名]` 前缀。
> - `GM_registerMenuCommand` 入口在侧边栏脚本页「菜单命令」区（非浏览器右键菜单）。
> - `GM_setClipboard` 仅文本；MV3 SW 无手势链时可能失败（错误文本可见）。
> - `unsafeWindow`：MAIN world = window；USER_SCRIPT world = 隔离世界 window。
```

`CLAUDE.md` 末尾追加：

```markdown
Phase 5（GM_* API + 管理器优化）已完成：14 个 GM API（`shared/gm-apis.ts` 注册表为唯一入口；wrapper `shared/gm-wrapper.ts` 按 @grant 精确安装 + 值快照直嵌；桥 `shared/gm-bridge.ts` 三消息；SW 中心 `background/gm-api.ts`——grant 白名单/值广播/菜单表/错误缓冲/@connect 三分支确认流 + 批准卡）；脚本错误捕获展示（环形缓冲 20 条 + 列表徽标 + 详情折叠区）；grant 徽标精确化（classifyGrants 二分）；菜单命令入口（侧边栏脚本页）；@require/@resource 预取缓存（7 天 TTL、单文件 2MB、总量 10MB）。API 文档 `docs/gm-api.md`。已知降级：无 unsafe header 改写（无 DNR）、XHR 非流式 ≤1MB、token 防伪非 VM 级、SW 重启丢内存态（菜单靠 reload 自愈）。
```

- [ ] **Step 6: Commit**

```bash
git add agent/tools/schemas.ts wxt.config.ts docs/gm-api.md CLAUDE.md tests/agent/tools/schemas.test.ts
git commit -m "feat(gm): schema 描述/manifest 权限/文档/CLAUDE.md 收尾"
```

---

## 手测清单（jsdom 盲区，实施完成后人工过一遍）

1. `npm run dev` 加载扩展 → 导入一个带 `@grant GM_setValue/GM_getValue` 的真实脚本 → 目标页 console 验证 GM_setValue 后 GM_getValue 读回（刷新页面后仍在——持久化）。
2. 两个 tab 打开同一匹配页 → A tab `GM_setValue` → B tab 的 `GM_addValueChangeListener` 触发（remote=true）。
3. `@grant GM_xmlhttpRequest` + `@connect api.example.com` 脚本 → 同域请求直通；未列域名请求 → 侧边栏弹批准卡 → 三按钮行为 + 60s 倒计时。
4. `GM_registerMenuCommand` 脚本 → 侧边栏脚本页「菜单命令」区出现按钮 → 点击 → 页面 console 见回调日志。
5. 故意写 `throw new Error('x')` 的脚本 → 列表页红徽标 + 详情页错误折叠区有条目。
6. `@require https://cdn.jsdelivr.net/...` 脚本导入 → wrapper 前置依赖代码（页面可用其全局）。
7. `GM_notification` → 系统通知弹出；点击 → 脚本 ondone 回调触发。
8. MAIN world 脚本的 `unsafeWindow === window` 为 true。

## Self-Review 记录

- **Spec 覆盖**：§1.1 三目标（14 API/文档/四项优化）→ Task 1-14 覆盖；§5 wrapper/§6 桥/§7 注册表 → Task 1/2/6；§8 语义表 14 行 → Task 6（安装）+ Task 7/10（SW 实现）；§8.1 确认流 → Task 10；§9.1-9.4 四项优化 → Task 7/9/13；§10 消息协议 → Task 2/7/10/13；§11 UI → Task 13；§12 测试策略逐层有对应；§13 文件清单全部落位；§14 边界在 gm-api.md 更新中如实记录。
- **占位符扫描**：无 TBD/TODO；Task 6/12 内嵌的「实现注意/关键修正」块是给执行者的纠偏说明，非未完成项。
- **类型一致性**：`buildWrappedCode(script, deps)` 签名 Task 6 定义、Task 11 消费一致；`GmErrorEntry`/`GmMenuCommand`/`GmConfirm` Task 7/10/13 贯穿一致；`classifyGrants` Task 1 定义、Task 4/13 消费一致；`matchConnect` 返回 `ConnectDecision` 枚举 Task 10 内部自洽。
