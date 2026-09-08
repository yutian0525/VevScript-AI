# MAIN world hook 敏感站排除名单 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Boss直聘等强风控站打不开的根因是 MAIN world 观测 hook 包装 console/fetch/XHR 被指纹检测命中——把 hook 改为 SW 动态注册 + `excludeMatches` 用户可编辑排除名单（默认四招聘站），命中站点零注入零指纹，其余功能照常。

**Architecture:** hook 从 manifest 静态声明改 `registration: 'runtime'`（WXT 0.21.4 原生支持，构建时不再写进 manifest）。SW 新增名单存储模块（`background/hook-exclusions.ts`，独立 storage key）与注册同步模块（`background/hook-registration.ts`，`scripting.registerContentScripts` diff 同步），消息协议加 GET/SAVE 两条，设置页加第五张入口卡 + 二级管理页。ISOLATED content.ts 不动（无指纹风险）。

**Tech Stack:** WXT 0.21.4 / Chrome MV3 `scripting` API / wxt `storage`（`local:` 前缀）/ React 19 + 项目既有 tokens 样式 / vitest v4 + fakeBrowser。

**Spec:** `docs/superpowers/specs/2026-09-08-hook-exclusion-list-design.md`

---

## 背景知识（执行前必读）

- **为什么要动态注册**：MAIN world content script 在站点自己的 JS 之前运行，它包装的 `console.*`/`fetch`/`XMLHttpRequest.prototype.open|send` 是站点反爬可探测的指纹（`fetch.toString()` 不再是 native code 等）。静态 `<all_urls>` 声明无法排除特定站；`scripting.registerContentScripts` 的注册详情支持 `excludeMatches`，且注册本身页面不可见——这是唯一既可配置又零残留的方案。
- **ISOLATED content.ts 不动**：快照/点击/填表等工具走 ISOLATED world，页面 JS 探测不到，对风控无贡献。排除名单只关 hook。所以排除站上 AI 工具照常用，只是 `list_console_messages` 变空、网络观测无 body。
- **WXT `registration: 'runtime'` 的行为**（已查 WXT 0.21.4 源码验证）：`defineContentScript({ registration: 'runtime' })` 的入口不再进 manifest `content_scripts`，其 `matches` 并入 host_permissions；注册责任在我们（`browser.scripting.registerContentScripts`）。产物仍输出到 `content-scripts/hook.js`。
- **注册详情形状**（`browser.scripting.RegisteredContentScript`）：`{ id, matches, excludeMatches, js: [{file}], runAt, world, allFrames, persistAcrossSessions }`——注意与 `chrome.userScripts` 相反，**scripting 这边 `persistAcrossSessions` 存在且默认 false，必须显式传 `true`**，否则浏览器重启后 hook 不再注册。
- **测试约定**：`tests/background/*.test.ts`，`beforeEach(() => fakeBrowser.reset())`，fakeBrowser 对 `scripting.registerContentScripts`/`getRegisteredContentScripts`/`updateContentScripts`/`unregisterContentScripts` 有完整 mock（脚本池测试 `tests/background/scripts.test.ts` 已在用 `userScripts` 同款 API；实施时先跑 Task 2 第一步确认 fakeBrowser 支持面，若缺 `excludeMatches` 字段保留则以 diff 逻辑测试自建 fake 注册表替代）。
- **运行测试**：`npm run vitest run tests/background/hook-exclusions.test.ts`（单文件）；全量 `npm run test`；类型检查 `npm run compile`。

## 文件结构

```text
shared/messages.ts                    改：RequestMessage 联合 + HookExclusionsSaveData 响应类型
background/hook-exclusions.ts         新：名单存储（默认名单兜底 / save 校验 / reset）
background/hook-registration.ts       新：hook 动态注册 diff 同步
background/gm-permissions.ts          （不改，仅作存储模块风格参照）
entrypoints/hook.content.ts           改：加 registration: 'runtime'
entrypoints/background.ts             改：SW 启动 syncHookRegistration
components/settings/SettingsHome.tsx  改：第五张入口卡
components/settings/SettingsView.tsx  改：二级路由接线
components/settings/HookExclusionsPage.tsx  新：名单管理页
tests/background/hook-exclusions.test.ts    新
tests/background/hook-registration.test.ts  新
```

---

### Task 1: 名单存储模块 `background/hook-exclusions.ts`

**Files:**
- Create: `background/hook-exclusions.ts`
- Test: `tests/background/hook-exclusions.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/background/hook-exclusions.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { storage } from 'wxt/utils/storage';
import {
  DEFAULT_HOOK_EXCLUSIONS,
  getHookExclusions,
  saveHookExclusions,
  resetHookExclusions,
  validatePatterns,
} from '../../background/hook-exclusions';

describe('hook-exclusions', () => {
  beforeEach(() => fakeBrowser.reset());

  it('未存过时返回默认名单（招聘风控四站）', async () => {
    expect(await getHookExclusions()).toEqual(DEFAULT_HOOK_EXCLUSIONS);
  });

  it('saveHookExclusions 全量覆盖落库，get 回读一致', async () => {
    const next = ['*://*.example.com/*'];
    await saveHookExclusions(next);
    expect(await getHookExclusions()).toEqual(next);
    // 落库后不再兜底默认值
    expect(await getHookExclusions()).not.toEqual(DEFAULT_HOOK_EXCLUSIONS);
  });

  it('saveHookExclusions 拒绝非法 pattern 并列出条目', async () => {
    expect(() => saveHookExclusions(['*://*.ok.com/*', 'not-a-pattern']))
      .toThrow('非法 match pattern：not-a-pattern');
    // 整体拒绝：合法条目也不落库
    expect(await getHookExclusions()).toEqual(DEFAULT_HOOK_EXCLUSIONS);
  });

  it('validatePatterns 返回非法条目（纯函数，UI 预检共用）', () => {
    expect(validatePatterns(['bad one', '*://*.zhipin.com/*'])).toEqual(['bad one']);
    expect(validatePatterns(['*://*.a.com/*', '<all_urls>'])).toEqual([]);
  });

  it('resetHookExclusions 删存储键回默认', async () => {
    await saveHookExclusions(['*://*.example.com/*']);
    const restored = await resetHookExclusions();
    expect(restored).toEqual(DEFAULT_HOOK_EXCLUSIONS);
    expect(await getHookExclusions()).toEqual(DEFAULT_HOOK_EXCLUSIONS);
    // 存储键确实被删（下次 get 走默认分支）
    expect(await storage.getItem('local:hook:exclusions')).toBeNull();
  });

  it('默认名单含招聘风控四站', () => {
    expect(DEFAULT_HOOK_EXCLUSIONS).toEqual([
      '*://*.zhipin.com/*',
      '*://*.lagou.com/*',
      '*://*.zhaopin.com/*',
      '*://*.51job.com/*',
    ]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run vitest run tests/background/hook-exclusions.test.ts`
Expected: FAIL（模块不存在，import 报错）

- [ ] **Step 3: 最小实现**

```ts
// background/hook-exclusions.ts
// MAIN world hook 敏感站排除名单存储（spec 2026-09-08 §3.1）。
// 命中名单的站点不注入观测 hook（消除扩展指纹，防风控站拒开）；
// 注册同步在 hook-registration.ts，本模块只管名单的存取与校验。
// 存储模块风格仿 gm-permissions.ts：独立 key、纯存取、UI/注册层共用。

import { storage } from 'wxt/utils/storage';
import { isValidMatchPattern } from '../shared/match-pattern';

const KEY = 'local:hook:exclusions';

/** 出厂默认：招聘类强风控站（Boss直聘/拉勾/智联/前程无忧）。
 *  站点反爬会指纹检测 MAIN world hook 包装过的 console/fetch/XHR，命中即拒开。 */
export const DEFAULT_HOOK_EXCLUSIONS: string[] = [
  '*://*.zhipin.com/*',
  '*://*.lagou.com/*',
  '*://*.zhaopin.com/*',
  '*://*.51job.com/*',
];

/** 纯函数：返回 patterns 中的非法条目（UI 添加时预检与 save 前置校验共用）。 */
export function validatePatterns(patterns: string[]): string[] {
  return patterns.filter((p) => !isValidMatchPattern(p));
}

/** 读名单：未存过（用户没改过）时返回出厂默认名单。 */
export async function getHookExclusions(): Promise<string[]> {
  const saved = await storage.getItem<{ patterns: string[] }>(KEY);
  return saved?.patterns ?? DEFAULT_HOOK_EXCLUSIONS;
}

/** 全量覆盖落库。任一条非法则整体拒绝（抛错并列出坏条目），不部分落库。 */
export async function saveHookExclusions(patterns: string[]): Promise<void> {
  const bad = validatePatterns(patterns);
  if (bad.length > 0) {
    throw new Error(`非法 match pattern：${bad.join('、')}`);
  }
  await storage.setItem(KEY, { patterns });
}

/** 删存储键回默认名单，返回默认名单（UI 刷新用）。 */
export async function resetHookExclusions(): Promise<string[]> {
  await storage.removeItem(KEY);
  return DEFAULT_HOOK_EXCLUSIONS;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run vitest run tests/background/hook-exclusions.test.ts`
Expected: PASS（7 用例）

- [ ] **Step 5: 全量测试 + 类型检查不回归**

Run: `npm run compile && npm run test`
Expected: 全部 PASS

- [ ] **Step 6: Commit**

```bash
git add background/hook-exclusions.ts tests/background/hook-exclusions.test.ts
git commit -m "feat(hook): 排除名单存储模块（默认招聘四站 + 校验 + reset）"
```

---

### Task 2: hook 动态注册同步 `background/hook-registration.ts`

**Files:**
- Create: `background/hook-registration.ts`
- Test: `tests/background/hook-registration.test.ts`

- [ ] **Step 1: 写失败测试**

fakeBrowser 若未实现 `scripting.registerContentScripts` 系 API，测试内用自建可变数组伪造注册表并 vi.mock 掉 `browser.scripting`（两种路径都给出，执行时按实际情况二选一，优先 fakeBrowser）：

```ts
// tests/background/hook-registration.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { saveHookExclusions } from '../../background/hook-exclusions';
import {
  HOOK_REGISTRATION_ID,
  HOOK_REGISTRATION,
  syncHookRegistration,
} from '../../background/hook-registration';

describe('hook-registration', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    // fakeBrowser 未实现 scripting 注册 API 时的兜底：自建最小注册表 mock。
    // （若 fakeBrowser 已实现，删除本块即可，断言不变。）
    if (!fakeBrowser.scripting?.registerContentScripts) {
      const registry: Array<Record<string, unknown>> = [];
      vi.stubGlobal('browser', {
        ...fakeBrowser,
        runtime: { ...fakeBrowser.runtime, getURL: (p: string) => `chrome-extension://test/${p}` },
        scripting: {
          registerContentScripts: vi.fn(async (scripts: Array<Record<string, unknown>>) => { registry.push(...scripts); }),
          getRegisteredContentScripts: vi.fn(async () => [...registry]),
          updateContentScripts: vi.fn(async (scripts: Array<Record<string, unknown>>) => {
            for (const s of scripts) {
              const i = registry.findIndex((r) => r.id === s.id);
              if (i >= 0) registry[i] = { ...registry[i], ...s };
            }
          }),
          unregisterContentScripts: vi.fn(async (f?: { ids?: string[] }) => {
            if (!f?.ids) { registry.length = 0; return; }
            for (const id of f.ids) {
              const i = registry.findIndex((r) => r.id === id);
              if (i >= 0) registry.splice(i, 1);
            }
          }),
        },
      });
    }
  });

  it('未注册时 registerContentScripts，注册详情含 excludeMatches/persistAcrossSessions', async () => {
    await syncHookRegistration();
    const registered = await browser.scripting.getRegisteredContentScripts();
    const hook = registered.find((r) => r.id === HOOK_REGISTRATION_ID);
    expect(hook).toBeDefined();
    expect(hook.matches).toEqual(['<all_urls>']);
    expect(hook.world).toBe('MAIN');
    expect(hook.runAt).toBe('document_start');
    expect(hook.allFrames).toBe(true);
    expect(hook.persistAcrossSessions).toBe(true);
    expect(hook.excludeMatches).toEqual([
      '*://*.zhipin.com/*', '*://*.lagou.com/*', '*://*.zhaopin.com/*', '*://*.51job.com/*',
    ]);
    expect(hook.js).toEqual([{ file: 'content-scripts/hook.js' }]);
  });

  it('已注册且名单一致 → 跳过（不再调 register/update）', async () => {
    await syncHookRegistration();
    const spy = vi.spyOn(browser.scripting, 'registerContentScripts');
    const updateSpy = vi.spyOn(browser.scripting, 'updateContentScripts');
    await syncHookRegistration();
    expect(spy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('名单变更后 sync → updateContentScripts 更新 excludeMatches', async () => {
    await syncHookRegistration();
    await saveHookExclusions(['*://*.example.com/*']);
    await syncHookRegistration();
    const registered = await browser.scripting.getRegisteredContentScripts();
    const hook = registered.find((r) => r.id === HOOK_REGISTRATION_ID);
    expect(hook.excludeMatches).toEqual(['*://*.example.com/*']);
  });

  it('getRegisteredContentScripts 抛错 → 按未注册自愈 register', async () => {
    await syncHookRegistration();
    vi.spyOn(browser.scripting, 'getRegisteredContentScripts').mockRejectedValueOnce(new Error('drift'));
    await syncHookRegistration(); // 不抛错
    const registered = await browser.scripting.getRegisteredContentScripts();
    expect(registered.find((r) => r.id === HOOK_REGISTRATION_ID)).toBeDefined();
  });

  it('HOOK_REGISTRATION 常量形状（导出供测试与 UI 提示共用）', () => {
    expect(HOOK_REGISTRATION_ID).toBe('hook-observe');
    expect(HOOK_REGISTRATION.matches).toEqual(['<all_urls>']);
    expect(HOOK_REGISTRATION.js).toEqual([{ file: 'content-scripts/hook.js' }]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run vitest run tests/background/hook-registration.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 最小实现**

```ts
// background/hook-registration.ts
// MAIN world hook 的动态注册同步（spec 2026-09-08 §3.2）。
// hook.content.ts 用 registration: 'runtime'，manifest 不再声明，注册责任在本模块：
// matches=<all_urls> + excludeMatches=敏感站名单，diff 同步（同 scripts.ts 期望注册集自愈模式）。

import {
  getHookExclusions,
} from './hook-exclusions';

export const HOOK_REGISTRATION_ID = 'hook-observe';

/** WXT registration:'runtime' 的 hook 产物路径（构建输出 content-scripts/hook.js）。
 *  动态注册不进 manifest，getManifest 取不到，写死相对路径（实施时已核对产物名）。 */
export const HOOK_REGISTRATION = {
  id: HOOK_REGISTRATION_ID,
  matches: ['<all_urls>'],
  runAt: 'document_start',
  world: 'MAIN',
  allFrames: true,
  // scripting 的 RegisteredContentScript 默认不跨会话持久（与 userScripts 相反），
  // 必须显式 true，否则浏览器重启后 hook 不再注册。
  persistAcrossSessions: true,
  js: [{ file: 'content-scripts/hook.js' }],
} as const;

/** 名单变更 / SW 冷启动时对齐注册。幂等：一致则跳过。 */
export async function syncHookRegistration(): Promise<void> {
  const excludeMatches = await getHookExclusions();
  const desired = { ...HOOK_REGISTRATION, excludeMatches };

  let registered: Array<{ id: string; excludeMatches?: string[] }> = [];
  try {
    registered = await browser.scripting.getRegisteredContentScripts();
  } catch {
    registered = []; // 极端漂移 → 按未注册处理，走 register 自愈
  }
  const existing = registered.find((r) => r.id === HOOK_REGISTRATION_ID);

  if (!existing) {
    await browser.scripting.registerContentScripts([desired as unknown as Browser.scripting.RegisteredContentScript]);
    return;
  }
  const same = JSON.stringify(existing.excludeMatches ?? []) === JSON.stringify(excludeMatches);
  if (!same) {
    await browser.scripting.updateContentScripts([desired as unknown as Browser.scripting.RegisteredContentScript]);
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run vitest run tests/background/hook-registration.test.ts`
Expected: PASS（5 用例）

- [ ] **Step 5: 类型检查**

Run: `npm run compile`
Expected: 无类型错误（若 `Browser.scripting.RegisteredContentScript` 类型名不存在，改用 `as never` 或项目内已有的 userScripts 封装同款局部 interface 风格）

- [ ] **Step 6: Commit**

```bash
git add background/hook-registration.ts tests/background/hook-registration.test.ts
git commit -m "feat(hook): SW 动态注册同步（excludeMatches diff，persistAcrossSessions 显式 true）"
```

---

### Task 3: hook 改 runtime 注册 + SW 启动接线

**Files:**
- Modify: `entrypoints/hook.content.ts:8-13`
- Modify: `entrypoints/background.ts`（`initScriptsModule` 附近）

- [ ] **Step 1: hook.content.ts 加 `registration: 'runtime'`**

```ts
// entrypoints/hook.content.ts 第 8-13 行的 defineContentScript 改为：
export default defineContentScript({
  matches: ['<all_urls>'],
  world: 'MAIN',
  runAt: 'document_start',
  allFrames: true,
  // 动态注册（SW 的 hook-registration.ts 负责）：manifest 不再静态声明本脚本，
  // 从而能用 excludeMatches 排除风控站（Boss直聘等指纹检测 MAIN world 包装即拒开）。
  registration: 'runtime',
  main() {
```

（其余内容不动。）

- [ ] **Step 2: 构建验证 manifest 不再含 hook**

Run: `npm run build`
Expected: `.output/chrome-mv3/manifest.json` 的 `content_scripts` 只剩 content.js 一条（无 `"world":"MAIN"` 条目），且 `content-scripts/hook.js` 产物文件仍存在：

```bash
grep -c "hook.js" .output/chrome-mv3/manifest.json   # Expected: 0
ls .output/chrome-mv3/content-scripts/hook.js        # Expected: 文件存在
```

- [ ] **Step 3: SW 启动接线（entrypoints/background.ts）**

import 区加：

```ts
import { syncHookRegistration } from '../background/hook-registration';
```

`defineBackground` 内、`initScriptsModule(router);` 附近（`attachObservers();` 之后）加：

```ts
  // hook 动态注册对齐（registration:'runtime' 的启动自愈，同 syncRegistrations 时序）。
  // 失败静默：SW 下次冷启动再试；注册 API 缺失（极旧 Chrome）也不阻断其余初始化。
  void syncHookRegistration().catch(() => {});
```

- [ ] **Step 4: 全量测试 + 类型检查 + 构建**

Run: `npm run compile && npm run test && npm run build`
Expected: 全部 PASS / 构建成功，manifest 无 hook 条目

- [ ] **Step 5: Commit**

```bash
git add entrypoints/hook.content.ts entrypoints/background.ts
git commit -m "feat(hook): 改 SW 动态注册（registration:runtime）+ 启动对齐接线"
```

---

### Task 4: 消息协议 GET/SAVE + router 接线

**Files:**
- Modify: `shared/messages.ts`（`SkillsRequest` 联合之后）
- Modify: `background/hook-registration.ts`（同文件加 handler 接线，或新建接线函数——按项目惯例，存取模块 + init 接线分离，接线放 `background/hook-registration.ts` 内新增 `initHookRegistration(router)`）
- Modify: `entrypoints/background.ts`（`initSkillsModule(router);` 之后调用）

- [ ] **Step 1: shared/messages.ts 加请求类型**

在 `SkillsRequest` 定义之后加：

```ts
// ---------- Hook 排除名单（sidepanel → bg request/response，走 MessageRouter）----------

/** HOOK_EXCLUSIONS_GET 响应 data：patterns=当前名单，defaults=出厂默认（UI 判「已改动」）。 */
export interface HookExclusionsData {
  patterns: string[];
  defaults: string[];
}

export type HookExclusionsRequest =
  | { type: 'HOOK_EXCLUSIONS_GET' }
  | { type: 'HOOK_EXCLUSIONS_SAVE'; patterns: string[] };
```

- [ ] **Step 2: background/hook-registration.ts 加 handler 接线**

文件末尾追加（import 区补 `MessageRouter` 与存取模块、`validatePatterns`、`DEFAULT_HOOK_EXCLUSIONS`）：

```ts
import type { MessageRouter } from './router';
import {
  DEFAULT_HOOK_EXCLUSIONS,
  getHookExclusions,
  saveHookExclusions,
  resetHookExclusions,
  validatePatterns,
} from './hook-exclusions';

/** 消息接线（spec 2026-09-08 §3.3）：GET / SAVE（save 全量覆盖 + 校验 + 注册同步）。 */
export function initHookRegistration(router: MessageRouter): void {
  router.on('HOOK_EXCLUSIONS_GET', async () => ({
    ok: true,
    data: { patterns: await getHookExclusions(), defaults: DEFAULT_HOOK_EXCLUSIONS },
  }));

  router.on('HOOK_EXCLUSIONS_SAVE', async (msg) => {
    const patterns = (msg as unknown as { patterns: string[] }).patterns;
    // 校验在 saveHookExclusions 内（非法整体拒绝抛错，router 统一转 { ok:false, error }）
    await saveHookExclusions(patterns);
    // 注册同步失败不回滚落库（下次 SW 冷启动自愈），返回 warnings 提示
    let warnings: string[] = [];
    try {
      await syncHookRegistration();
    } catch (e) {
      warnings = [`名单已保存，但 hook 注册同步失败（刷新扩展后自愈）：${e instanceof Error ? e.message : String(e)}`];
    }
    return { ok: true, data: { patterns: await getHookExclusions(), defaults: DEFAULT_HOOK_EXCLUSIONS, warnings } };
  });
}
```

注：`resetHookExclusions` 与 `validatePatterns` 若未被 handler 直接用到，仍保留导出（UI 直调走 storage 不经 SW 的场景不存在——reset 走 SAVE 语义即可）。若 `npm run compile` 报 unused import，删掉未用导入即可（`resetHookExclusions`/`validatePatterns` 不 import，UI 层经 SAVE 传默认名单）。

- [ ] **Step 3: entrypoints/background.ts 接线**

`initSkillsModule(router);` 之后加：

```ts
  initHookRegistration(router);
```

import 区加：

```ts
import { initHookRegistration } from '../background/hook-registration';
```

（与 Task 3 Step 3 的 `syncHookRegistration` 启动调用同文件——合并为一个 import：`import { syncHookRegistration, initHookRegistration } from '../background/hook-registration';`）

- [ ] **Step 4: 写 handler 测试（追加到 tests/background/hook-registration.test.ts）**

```ts
import { initHookRegistration } from '../../background/hook-registration';
import { DEFAULT_HOOK_EXCLUSIONS } from '../../background/hook-exclusions';

describe('hook-registration 消息接线', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    // （同上文自建 mock 块，此处略——执行时复制上文 mock；若 fakeBrowser 已实现则删）
  });

  it('HOOK_EXCLUSIONS_GET 返回当前名单 + 默认名单', async () => {
    const router = new MessageRouter();
    initHookRegistration(router);
    const resp = await router.dispatch({ type: 'HOOK_EXCLUSIONS_GET' }) as { ok: boolean; data?: { patterns: string[]; defaults: string[] } };
    expect(resp.ok).toBe(true);
    expect(resp.data?.patterns).toEqual(DEFAULT_HOOK_EXCLUSIONS);
    expect(resp.data?.defaults).toEqual(DEFAULT_HOOK_EXCLUSIONS);
  });

  it('HOOK_EXCLUSIONS_SAVE 合法路径：落库 + 同步注册', async () => {
    const router = new MessageRouter();
    initHookRegistration(router);
    const resp = await router.dispatch({ type: 'HOOK_EXCLUSIONS_SAVE', patterns: ['*://*.example.com/*'] }) as { ok: boolean; data?: { patterns: string[]; warnings?: string[] } };
    expect(resp.ok).toBe(true);
    expect(resp.data?.patterns).toEqual(['*://*.example.com/*']);
    const registered = await browser.scripting.getRegisteredContentScripts();
    const hook = registered.find((r) => r.id === 'hook-observe');
    expect(hook?.excludeMatches).toEqual(['*://*.example.com/*']);
  });

  it('HOOK_EXCLUSIONS_SAVE 非法 pattern：整体拒绝返回 ok:false', async () => {
    const router = new MessageRouter();
    initHookRegistration(router);
    const resp = await router.dispatch({ type: 'HOOK_EXCLUSIONS_SAVE', patterns: ['bad one'] }) as { ok: boolean; error?: string };
    expect(resp.ok).toBe(false);
    expect(resp.error).toContain('非法 match pattern');
  });
});
```

（测试文件顶部补 `import { MessageRouter } from '../../background/router';`。）

- [ ] **Step 5: 跑测试确认通过**

Run: `npm run vitest run tests/background/hook-registration.test.ts`
Expected: PASS（Task 2 的 5 例 + 本任务 3 例）

- [ ] **Step 6: 全量测试 + 类型检查**

Run: `npm run compile && npm run test`
Expected: 全部 PASS

- [ ] **Step 7: Commit**

```bash
git add shared/messages.ts background/hook-registration.ts entrypoints/background.ts tests/background/hook-registration.test.ts
git commit -m "feat(hook): HOOK_EXCLUSIONS_GET/SAVE 消息协议 + router 接线"
```

---

### Task 5: 设置页入口卡 + 排除名单管理页

**Files:**
- Modify: `components/settings/SettingsHome.tsx`
- Modify: `components/settings/SettingsView.tsx`
- Create: `components/settings/HookExclusionsPage.tsx`

- [ ] **Step 1: SettingsHome 加第五张卡**

```tsx
// components/settings/SettingsHome.tsx
// 1) lucide 导入区加 ShieldOff：
import { SlidersHorizontal, SquareTerminal, FlaskConical, ChevronRight, Sparkles, ShieldOff } from 'lucide-react';
// 2) SettingsSub 类型扩为：
export type SettingsSub = 'model' | 'toolbench' | 'scriptdebug' | 'skills' | 'hookexclusions';
// 3) ENTRIES 数组末尾加：
  { key: 'hookexclusions', title: '敏感站点排除', desc: '风控站（如 Boss直聘）不注入观测 hook，防止被指纹检测拒开', Icon: ShieldOff },
```

- [ ] **Step 2: SettingsView 接线二级路由**

```tsx
// components/settings/SettingsView.tsx
import { HookExclusionsPage } from './HookExclusionsPage';
// return 的三元链在 skills 分支后加：
      ) : sub === 'hookexclusions' ? (
        <HookExclusionsPage onBack={back} />
```

- [ ] **Step 3: 写 HookExclusionsPage**

```tsx
// components/settings/HookExclusionsPage.tsx
// 敏感站点排除管理页（spec 2026-09-08 §3.4）：命中名单的站点不注入 MAIN world 观测 hook。
// 保存即生效（每次增删直调 SAVE，无独立保存钮）；已打开页面需刷新才生效。
import { useEffect, useState } from 'react';
import { Plus, Trash2, RotateCcw } from 'lucide-react';
import { PageShell } from '../ui/PageShell';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { isValidMatchPattern } from '../../shared/match-pattern';
import { sendHookExclusionsRequest } from '../../stores/hook-exclusions';
import type { HookExclusionsData } from '../../shared/messages';

export function HookExclusionsPage({ onBack }: { onBack: () => void }) {
  const [data, setData] = useState<HookExclusionsData>({ patterns: [], defaults: [] });
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  useEffect(() => { void refresh(); }, []);

  const refresh = async (): Promise<void> => {
    const resp = await sendHookExclusionsRequest<{ ok: boolean; data?: HookExclusionsData; error?: string }>({ type: 'HOOK_EXCLUSIONS_GET' });
    if (resp.ok && resp.data) setData(resp.data);
  };

  const save = async (patterns: string[]): Promise<boolean> => {
    setError(null); setWarning(null);
    const resp = await sendHookExclusionsRequest<{ ok: boolean; data?: HookExclusionsData & { warnings?: string[] }; error?: string }>({
      type: 'HOOK_EXCLUSIONS_SAVE', patterns,
    });
    if (!resp.ok) { setError(resp.error ?? '保存失败'); return false; }
    if (resp.data) setData({ patterns: resp.data.patterns, defaults: resp.data.defaults });
    if (resp.data?.warnings?.length) setWarning(resp.data.warnings[0]);
    return true;
  };

  const add = async (): Promise<void> => {
    const p = draft.trim();
    if (!p) return;
    if (!isValidMatchPattern(p)) { setError(`非法 match pattern：${p}`); return; }
    if (data.patterns.includes(p)) { setError(`已在名单中：${p}`); return; }
    if (await save([...data.patterns, p])) setDraft('');
  };

  const remove = async (p: string): Promise<void> => {
    await save(data.patterns.filter((x) => x !== p));
  };

  const reset = async (): Promise<void> => {
    await save(data.defaults);
  };

  return (
    <PageShell title="敏感站点排除" eyebrow="HOOK" onBack={onBack}>
      <section className="section">
        <h2 className="section__title">排除名单</h2>
        <span className="hint">命中名单的站点不注入 MAIN world 观测 hook（消除扩展指纹，防 Boss直聘类风控站拒开）。
          保存后需刷新已打开的页面才生效；该站 console 观测失效、网络请求/响应 body 不可用；自己的用户脚本不受此名单约束。</span>
        <div style={{ display: 'flex', gap: 8 }}>
          <Input
            value={draft}
            onChange={(e) => { setDraft(e.target.value); setError(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter') void add(); }}
            placeholder="*://*.example.com/*"
            className="mono-input"
          />
          <Button onClick={() => void add()}><Plus size={14} /> 添加</Button>
        </div>
        {error && <span className="status-text status-text--err">{error}</span>}
        {warning && <span className="status-text status-text--warn">{warning}</span>}
        <div className="well" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {data.patterns.length === 0 && <span className="hint">名单为空：所有站点均注入观测 hook。</span>}
          {data.patterns.map((p) => (
            <div key={p} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <code className="mono">{p}</code>
              <Button onClick={() => void remove(p)} aria-label={`删除 ${p}`}>
                <Trash2 size={14} />
              </Button>
            </div>
          ))}
        </div>
        <Button onClick={() => void reset()}><RotateCcw size={14} /> 恢复默认</Button>
      </section>
    </PageShell>
  );
}
```

- [ ] **Step 4: 新建 stores/hook-exclusions.ts（请求发送 + 类型）**

项目惯例：请求发送器放 stores（`stores/scripts.ts` 的 `sendScriptsRequest` 同款）。

```ts
// stores/hook-exclusions.ts
// 敏感站点排除名单的前端请求发送器（sendScriptsRequest 同款惯例）。
export async function sendHookExclusionsRequest<T = unknown>(req: unknown): Promise<T> {
  return (await browser.runtime.sendMessage(req)) as T;
}
```

- [ ] **Step 5: 类型检查 + 全量测试 + 构建**

Run: `npm run compile && npm run test && npm run build`
Expected: 全部 PASS / 构建成功

- [ ] **Step 6: Commit**

```bash
git add components/settings/SettingsHome.tsx components/settings/SettingsView.tsx components/settings/HookExclusionsPage.tsx stores/hook-exclusions.ts
git commit -m "feat(settings): 敏感站点排除管理页（增删/恢复默认 + 保存即生效）"
```

---

### Task 6: 手测验证 + 文档收尾

**Files:**
- Modify: `CLAUDE.md`（当前阶段段末追加一段）

- [ ] **Step 1: 构建产物核验**

Run: `npm run build && grep -c "hook.js" .output/chrome-mv3/manifest.json && ls .output/chrome-mv3/content-scripts/`
Expected: `0`（manifest 无 hook 条目）；content-scripts/ 下 hook.js 存在

- [ ] **Step 2: 浏览器手测（chrome://extensions 加载 .output/chrome-mv3）**

1. 重载扩展后开 https://www.zhipin.com/ → 页面正常打开（核心验收）。
2. 开 https://example.com/ → F12 Console 里 `fetch.toString()` 应为 `"function fetch() { [native code] }"`（hook 已注入→被包装）。注：这句是验证 hook 在非排除站正常注入，反向验证排除名单只作用于名单站。
3. 侧边栏设置 → 敏感站点排除 → 添加 `*://*.example.com/*` → 刷新 example.com 标签 → Console 再查 `fetch.toString()`，仍是 native code 即排除生效；侧边栏 list_console_messages（工具调试台）对 example.com 返回空。
4. 删除刚才的条目 → 刷新 → `fetch.toString()` 变回被包装形态。
5. 「恢复默认」→ 名单回到四站。

- [ ] **Step 3: CLAUDE.md 收尾段**

CLAUDE.md「当前阶段」末尾追加：

```markdown
敏感站排除名单（2026-09-08，`docs/superpowers/specs/2026-09-08-hook-exclusion-list-design.md`）已完成：MAIN world 观测 hook（`entrypoints/hook.content.ts`）改 SW 动态注册（`registration: 'runtime'`，manifest 不再静态声明），`background/hook-registration.ts` 经 scripting.registerContentScripts diff 同步（`persistAcrossSessions` 显式 true——scripting 侧默认不跨会话，与 userScripts 相反），excludeMatches 承载名单；`background/hook-exclusions.ts` 独立存储（`local:hook:exclusions`，默认招聘四站 zhipin/lagou/zhaopin/51job，未存过时兜底），`HOOK_EXCLUSIONS_GET/SAVE` 消息 + 设置页第五卡「敏感站点排除」（增删/恢复默认，保存即生效，刷新页面后生效）。动机：Boss直聘等强风控站指纹检测 MAIN world hook 包装的 console/fetch/XHR 拒开；排除站上 console 观测失效、网络观测无 body，AI 工具（ISOLATED）照常。已知边界：第三方风控 iframe（跨域文档）不覆盖；用户自己的脚本池脚本不归名单管；dev 模式改 hook 需重载扩展（SW 冷启动 sync 兜底）。
```

- [ ] **Step 4: 全量测试 + 类型检查 + 最终 Commit**

Run: `npm run compile && npm run test`
Expected: 全部 PASS

```bash
git add CLAUDE.md
git commit -m "docs: 敏感站排除名单完成收尾（CLAUDE.md 当前阶段）"
```

---

## 收尾核对（执行完逐项勾）

- [ ] manifest 无 hook 静态条目，hook.js 产物存在
- [ ] Boss直聘能正常打开（核心验收）
- [ ] 非排除站 hook 正常注入（fetch 被包装）
- [ ] 设置页增删/恢复默认生效
- [ ] `npm run compile && npm run test` 全绿
- [ ] CLAUDE.md 收尾段已加
