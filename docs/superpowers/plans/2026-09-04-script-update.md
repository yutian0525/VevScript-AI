# 脚本更新功能实现计划（URL 导入 + 启动检查更新 + 手动更新）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 侧边栏脚本管理器支持粘贴 .user.js 直链导入；浏览器启动时自动检查有更新源脚本的 @version，列表页徽标提醒；详情页手动检查并确认更新。

**Architecture:** 更新逻辑独立成 `background/scripts-update.ts`（编排层 scripts.ts 已 439 行不再膨胀）。检查结果存独立键 `local:scripts:update-state`（text 为唯一真源，运行时状态不进 UserScript 投影）。启动检查（onStartup/onInstalled）fire-and-forget 写 storage + 广播；UI 经 3 个新消息（IMPORT_URL / CHECK_UPDATE / APPLY_UPDATE）操作，复用现有 `handleImport` / `handleUpdate` 管线。

**Tech Stack:** WXT + React 19 + TS、vitest v4 + wxt fakeBrowser、lucide-react。

**Spec:** `docs/superpowers/specs/2026-09-04-script-update-design.md`

**工作目录：** 全程在 `D:\workspace-mou8\abe-dev`（分支 `feat/update-scripts`）。相对路径以仓库根为基准。

**命令约定：** 单测 `npx vitest run <path>`；全量 `npm run test`；类型检查 `npm run compile`；构建 `npm run build`。

---

## 文件结构总览

| 动作 | 文件 | 职责 |
|---|---|---|
| 新增 | `shared/version.ts` | 纯函数版本比较 |
| 新增 | `background/scripts-update.ts` | update-state 存取 + 检查/导入/应用编排 |
| 修改 | `shared/types.ts` | `ScriptUpdateState` 类型 + `UPDATE_STATE_KEY` 常量 |
| 修改 | `shared/messages.ts` | 3 请求 + 1 广播类型 |
| 修改 | `shared/userscript-meta.ts` | `injectMetaLines` 纯函数 |
| 修改 | `background/scripts.ts` | 接线 3 handler + 不变量清理 |
| 修改 | `entrypoints/background.ts` | onStartup/onInstalled 挂启动检查 |
| 修改 | `stores/scripts.ts` | `updates` / `dismissed` 状态 + 复水 |
| 修改 | `components/scripts/ScriptsView.tsx` | SCRIPTS_UPDATES 广播监听 |
| 修改 | `components/scripts/ScriptsListView.tsx` | URL 导入入口 + 更新徽标 + 操作条 |
| 修改 | `components/detail/DetailInfoTab.tsx` | 检查更新行 + 按钮 |
| 修改 | `entrypoints/sidepanel/styles.css` | `scripts-card__updatebar` |
| 新增测试 | `tests/shared/version.test.ts`、`tests/background/scripts-update.test.ts` | |
| 修改测试 | `tests/shared/userscript-meta.test.ts`、`tests/background/scripts.test.ts`（追加） | |

UI 组件（Task 7-9）无组件测试先例（spec §5 决策），验收 = compile + 全量测试 + 代码走查。

**已核实的既有事实**（实现者可直接依赖）：
- `Button` 组件接受 icon+文本混合 children（ScriptsListView 现有用法 `<Button><Plus size={16}/></Button>`）。
- fakeBrowser 下 `runtime.sendMessage` 广播无接收方 reject 被 `.catch(() => {})` 吞掉，测试安全（现有 handleCreate 测试已触发过同类广播）。
- tests/background/scripts.test.ts 已有 helper：`installFakeUserScripts()`、`mkText()`，并已静态导入 `handleImport`/`handleUpdate`/`handleDelete`/`MessageRouter`/`initScriptsModule`。
- gm-resources.test.ts 的 fetch mock 惯例：`vi.stubGlobal('fetch', ...)` + `vi.unstubAllGlobals()`。

---

### Task 1: `shared/version.ts` 版本比较纯函数（TDD）

**Files:**
- Create: `shared/version.ts`
- Test: `tests/shared/version.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/shared/version.test.ts
import { describe, it, expect } from 'vitest';
import { compareVersions } from '../../shared/version';

describe('compareVersions（spec §1.5）', () => {
  it('数值段比较：1.2.10 > 1.2.9', () => {
    expect(compareVersions('1.2.10', '1.2.9')).toBe(1);
    expect(compareVersions('1.2.9', '1.2.10')).toBe(-1);
  });
  it('相等（含补零对齐）：1.2 === 1.2.0；空串 === 0', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('', '')).toBe(0);
    expect(compareVersions('', '0')).toBe(0);
  });
  it('段数不齐短补零：1.2 < 1.2.1', () => {
    expect(compareVersions('1.2', '1.2.1')).toBe(-1);
  });
  it('非数字段字符串比较：1.2a < 1.2b', () => {
    expect(compareVersions('1.2a', '1.2b')).toBe(-1);
  });
  it('空串低于一切具体版本：空串 < 0.0.1（远端无 @version 不误报）', () => {
    expect(compareVersions('', '0.0.1')).toBe(-1);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /d/workspace-mou8/abe-dev && npx vitest run tests/shared/version.test.ts`
Expected: FAIL（Cannot find module '../../shared/version'）

- [ ] **Step 3: 写最小实现**

```ts
// shared/version.ts
// 版本号比较（spec §1.5）：按 '.' 分段逐段比；数字段数值比较、非数字段字符串比较；段数不齐短补零。
// 缺失/空串视为 '0'——远端无 @version 时不误报有更新。

export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const segs = (v: string): string[] => (v.trim() || '0').split('.');
  const A = segs(a);
  const B = segs(b);
  const n = Math.max(A.length, B.length);
  for (let i = 0; i < n; i++) {
    const x = A[i] ?? '0';
    const y = B[i] ?? '0';
    const nx = Number(x);
    const ny = Number(y);
    let c: number;
    if (x !== '' && y !== '' && Number.isFinite(nx) && Number.isFinite(ny)) {
      c = nx === ny ? 0 : nx > ny ? 1 : -1;
    } else {
      c = x === y ? 0 : x > y ? 1 : -1;
    }
    if (c !== 0) return c as -1 | 0 | 1;
  }
  return 0;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd /d/workspace-mou8/abe-dev && npx vitest run tests/shared/version.test.ts`
Expected: PASS（5 用例）

- [ ] **Step 5: Commit**

```bash
git add shared/version.ts tests/shared/version.test.ts
git commit -m "feat(scripts-update): compareVersions 纯函数（数字段/补零/字符串段/缺失视为 0）"
```

---

### Task 2: `ScriptUpdateState` 类型 + 消息协议扩展

**Files:**
- Modify: `shared/types.ts`（UserScript 接口之后）
- Modify: `shared/messages.ts`（顶部 types import + ScriptsRequest 联合末尾 + 广播区）

- [ ] **Step 1: types.ts 在 UserScript 接口后追加**

```ts
/** 启动/手动更新检查结果（独立于 UserScript：运行时状态，非解析投影，spec §1.2） */
export interface ScriptUpdateState {
  remoteVersion: string;
  checkedAt: number;
  status: 'available' | 'up-to-date' | 'error';
  /** status='error' 时的原因（HTTP 404 / 超时 / 解析失败…） */
  message?: string;
}

/** chrome.storage.local 键：脚本更新检查结果 map（scriptId → ScriptUpdateState，spec §1.2） */
export const UPDATE_STATE_KEY = 'local:scripts:update-state';
```

- [ ] **Step 2: messages.ts 顶部 `from './types'` 的 type import 里补 `ScriptUpdateState`**

- [ ] **Step 3: messages.ts —— ScriptsRequest 联合末尾（`GM_DEBUG_INFO` 行后）追加 3 请求**

```ts
  | { type: 'SCRIPTS_IMPORT_URL'; url: string }
  | { type: 'SCRIPTS_CHECK_UPDATE'; id: string }
  | { type: 'SCRIPTS_APPLY_UPDATE'; id: string }
```

- [ ] **Step 4: messages.ts —— `ScriptsRuntimeEvent` 接口后追加广播类型**

```ts
/** bg → 扩展页面广播：更新检查后的全量更新状态 map（fire-and-forget；spec §2） */
export interface ScriptsUpdatesEvent {
  type: 'SCRIPTS_UPDATES';
  updates: Record<string, ScriptUpdateState>;
}
```

- [ ] **Step 5: 类型检查**

Run: `cd /d/workspace-mou8/abe-dev && npm run compile`
Expected: 无错误

- [ ] **Step 6: Commit**

```bash
git add shared/types.ts shared/messages.ts
git commit -m "feat(scripts-update): ScriptUpdateState/UPDATE_STATE_KEY 类型 + 3 请求/1 广播消息协议"
```

---

### Task 3: `injectMetaLines` 头部注入纯函数（TDD）

**Files:**
- Modify: `shared/userscript-meta.ts`（文件末尾追加）
- Test: `tests/shared/userscript-meta.test.ts`（顶部 import 补 + 文件末尾追加 describe）

- [ ] **Step 1: 写失败测试**

tests/shared/userscript-meta.test.ts 顶部的 userscript-meta import 补 `injectMetaLines`；文件末尾追加：

```ts
describe('injectMetaLines（spec §1.4：URL 导入/应用更新时保留更新源）', () => {
  it('无更新源脚本在头块内注入 @updateURL', () => {
    const src = '// ==UserScript==\n// @name t\n// @match https://a.com/*\n// ==/UserScript==\ncode();';
    const out = injectMetaLines(src, { updateURL: 'https://x/s.user.js' });
    expect(out).toContain('// @updateURL    https://x/s.user.js');
    expect(out.indexOf('@updateURL')).toBeGreaterThan(out.indexOf('==UserScript=='));
    expect(out.indexOf('@updateURL')).toBeLessThan(out.indexOf('==/UserScript=='));
  });

  it('已有 updateURL 不覆盖', () => {
    const src = '// ==UserScript==\n// @updateURL https://old/a.user.js\n// ==/UserScript==\ncode();';
    const out = injectMetaLines(src, { updateURL: 'https://new/b.user.js' });
    expect(out).toContain('https://old/a.user.js');
    expect(out).not.toContain('https://new/b.user.js');
  });

  it('头不在首行 / 无头文本原样返回', () => {
    expect(injectMetaLines('alert(1);', { updateURL: 'https://x/s.user.js' })).toBe('alert(1);');
    expect(injectMetaLines('// 注释\n// ==UserScript==\n// ==/UserScript==\nc();', { updateURL: 'https://x' })).not.toContain('@updateURL');
  });
});
```

（「已有不覆盖」语义由实现保证：调用方只传缺失键——`handleImportUrl` 传 `meta.updateURL ?? url.href`，远端已有则值为远端的（相同），本地已有则 Task 4 只传本地值。函数本身不做已有键检测。）

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /d/workspace-mou8/abe-dev && npx vitest run tests/shared/userscript-meta.test.ts`
Expected: FAIL（injectMetaLines 未导出）

- [ ] **Step 3: 实现（shared/userscript-meta.ts 末尾追加）**

```ts
/** 头部注入（spec §1.4）：向 ==UserScript== 块内（==/UserScript== 行前）追加元数据行。
 * 头必须在首行才注入——远端文本头前有注释时宁可少记更新源也不错插。
 * 「不覆盖已有键」由调用方保证：只传缺失/应保留的键（见 handleImportUrl / handleApplyUpdate）。 */
export function injectMetaLines(
  source: string,
  lines: { updateURL?: string; downloadURL?: string },
): string {
  if (!lines.updateURL && !lines.downloadURL) return source;
  const lineEnd = source.indexOf('\n');
  const head = lineEnd === -1 ? source : source.slice(0, lineEnd);
  if (head.trim() !== '// ==UserScript==') return source;
  const outLines = source.split('\n');
  const endIdx = outLines.findIndex((l) => l.trim() === '// ==/UserScript==');
  if (endIdx === -1) return source;
  const injects: string[] = [];
  if (lines.updateURL) injects.push(`// @updateURL    ${lines.updateURL}`);
  if (lines.downloadURL) injects.push(`// @downloadURL  ${lines.downloadURL}`);
  outLines.splice(endIdx, 0, ...injects);
  return outLines.join('\n');
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd /d/workspace-mou8/abe-dev && npx vitest run tests/shared/userscript-meta.test.ts`
Expected: PASS（含原有用例）

- [ ] **Step 5: Commit**

```bash
git add shared/userscript-meta.ts tests/shared/userscript-meta.test.ts
git commit -m "feat(scripts-update): injectMetaLines 头部注入（头在首行才注入、无键原样）"
```

---

### Task 4: `background/scripts-update.ts` 核心编排（TDD）

**Files:**
- Create: `background/scripts-update.ts`
- Test: `tests/background/scripts-update.test.ts`

**前置：** Task 1-3 已合入。

- [ ] **Step 1: 写失败测试（全新文件）**

```ts
// tests/background/scripts-update.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  readUpdateStates, clearUpdateState, checkScriptUpdate, runStartupUpdateCheck,
  handleImportUrl, handleApplyUpdate, updateCheckUrl, updateDownloadUrl,
} from '../../background/scripts-update';
import { saveScript, listScripts } from '../../storage/scripts';
import type { UserScript } from '../../shared/types';

function mkScript(over: Partial<UserScript> = {}): UserScript {
  return {
    id: 's1',
    text: '// ==UserScript==\n// @name t\n// @version 1.0.0\n// @match https://a.com/*\n// ==/UserScript==\ncode();',
    name: 't', enabled: true, matches: ['https://a.com/*'], code: 'code();',
    runAt: 'document_idle', world: 'USER_SCRIPT', source: 'import', createdAt: 1, updatedAt: 1,
    ...over,
  };
}

function okFetch(body: string) {
  return vi.fn(async () => ({ ok: true, status: 200, text: async () => body }));
}

beforeEach(() => {
  fakeBrowser.reset();
  vi.restoreAllMocks();
});

describe('update-state 存取', () => {
  it('空库返回 {}；clearUpdateState 对不存在 id 幂等', async () => {
    expect(await readUpdateStates()).toEqual({});
    await clearUpdateState('nope');
    expect(await readUpdateStates()).toEqual({});
  });
});

describe('updateCheckUrl / updateDownloadUrl（TM 回退链）', () => {
  it('检查 = updateURL ?? downloadURL；下载 = downloadURL ?? updateURL', () => {
    const both = mkScript({ meta: { updateURL: 'u', downloadURL: 'd' } });
    const onlyUp = mkScript({ meta: { updateURL: 'u' } });
    const onlyDown = mkScript({ meta: { downloadURL: 'd' } });
    const none = mkScript({});
    expect(updateCheckUrl(both)).toBe('u');
    expect(updateDownloadUrl(both)).toBe('d');
    expect(updateCheckUrl(onlyUp)).toBe('u');
    expect(updateDownloadUrl(onlyUp)).toBe('u');
    expect(updateCheckUrl(onlyDown)).toBe('d');
    expect(updateDownloadUrl(onlyDown)).toBe('d');
    expect(updateCheckUrl(none)).toBeUndefined();
    expect(updateDownloadUrl(none)).toBeUndefined();
  });
});

describe('checkScriptUpdate', () => {
  it('远端版本更高 → available', async () => {
    vi.stubGlobal('fetch', okFetch('// ==UserScript==\n// @version 2.0.0\n// ==/UserScript==\nx'));
    const st = await checkScriptUpdate(mkScript({ meta: { updateURL: 'https://x/u' } }));
    expect(st.status).toBe('available');
    expect(st.remoteVersion).toBe('2.0.0');
    vi.unstubAllGlobals();
  });
  it('远端低 → up-to-date（降级不提示）', async () => {
    vi.stubGlobal('fetch', okFetch('// ==UserScript==\n// @version 0.9.0\n// ==/UserScript==\nx'));
    const st = await checkScriptUpdate(mkScript({ meta: { updateURL: 'https://x/u' } }));
    expect(st.status).toBe('up-to-date');
    vi.unstubAllGlobals();
  });
  it('远端无 @version → 视为 0 → up-to-date 不误报', async () => {
    vi.stubGlobal('fetch', okFetch('// ==UserScript==\n// @name t\n// ==/UserScript==\nx'));
    const st = await checkScriptUpdate(mkScript({ meta: { updateURL: 'https://x/u' } }));
    expect(st.status).toBe('up-to-date');
    vi.unstubAllGlobals();
  });
  it('HTTP 404 → error 带原因', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, text: async () => '' })));
    const st = await checkScriptUpdate(mkScript({ meta: { updateURL: 'https://x/u' } }));
    expect(st.status).toBe('error');
    expect(st.message).toContain('404');
    vi.unstubAllGlobals();
  });
  it('下载到 HTML（无脚本头）→ error', async () => {
    vi.stubGlobal('fetch', okFetch('<html><body>login</body></html>'));
    const st = await checkScriptUpdate(mkScript({ meta: { updateURL: 'https://x/u' } }));
    expect(st.status).toBe('error');
    expect(st.message).toContain('不是有效脚本');
    vi.unstubAllGlobals();
  });
  it('无更新源 → error 且不发起 fetch', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    const st = await checkScriptUpdate(mkScript({}));
    expect(st.status).toBe('error');
    expect(st.message).toContain('无更新源');
    expect(f).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe('runStartupUpdateCheck', () => {
  it('只查有更新源的脚本；结果落 storage 并广播', async () => {
    await saveScript(mkScript({ id: 'a', meta: { updateURL: 'https://x/a' } }));
    await saveScript(mkScript({ id: 'b' }));
    const fetchMock = vi.fn(async (url: string) => ({
      ok: true, status: 200, text: async () => '// ==UserScript==\n// @version 9.9.9\n// ==/UserScript==\nx',
    }));
    vi.stubGlobal('fetch', fetchMock);
    const sendSpy = vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue(undefined);
    await runStartupUpdateCheck();
    expect(fetchMock).toHaveBeenCalledTimes(1); // 只有 a
    const map = await readUpdateStates();
    expect(map.a?.status).toBe('available');
    expect(map.b).toBeUndefined();
    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'SCRIPTS_UPDATES' }));
    vi.unstubAllGlobals();
  });
});

describe('handleImportUrl', () => {
  it('非 http(s) 协议拒绝', async () => {
    await expect(handleImportUrl('file:///c/x.user.js')).rejects.toThrow('http(s)');
    await expect(handleImportUrl('javascript:alert(1)')).rejects.toThrow('http(s)');
  });
  it('下载内容无脚本头 → 拒绝', async () => {
    vi.stubGlobal('fetch', okFetch('<html>404 page</html>'));
    await expect(handleImportUrl('https://x/s.js')).rejects.toThrow('不是有效脚本');
    vi.unstubAllGlobals();
  });
  it('成功：头无更新源 → 导入 URL 记为 @updateURL', async () => {
    const body = '// ==UserScript==\n// @name from-url\n// @match https://a.com/*\n// ==/UserScript==\ncode();';
    vi.stubGlobal('fetch', okFetch(body));
    const { script } = await handleImportUrl('https://cdn.example.com/s.user.js');
    expect(script.name).toBe('from-url');
    expect(script.meta?.updateURL).toBe('https://cdn.example.com/s.user.js');
    expect((await listScripts()).length).toBe(1);
    vi.unstubAllGlobals();
  });
  it('成功：头已有 updateURL → 不覆盖', async () => {
    const body = '// ==UserScript==\n// @name t\n// @updateURL https://origin/u\n// @match https://a.com/*\n// ==/UserScript==\ncode();';
    vi.stubGlobal('fetch', okFetch(body));
    const { script } = await handleImportUrl('https://cdn.example.com/other.user.js');
    expect(script.meta?.updateURL).toBe('https://origin/u');
    vi.unstubAllGlobals();
  });
});

describe('handleApplyUpdate', () => {
  it('无更新源 → 报错', async () => {
    await saveScript(mkScript({ id: 'n1' }));
    await expect(handleApplyUpdate('n1')).rejects.toThrow('无更新源');
  });
  it('成功：远端文本覆盖 + 本地更新源保留 + update-state 清除', async () => {
    await saveScript(mkScript({ id: 'a1', meta: { version: '1.0.0', downloadURL: 'https://x/d' } }));
    // 预置一条 stale state，验证成功后被清
    const { UPDATE_STATE_KEY } = await import('../../shared/types');
    const { storage } = await import('wxt/utils/storage');
    await storage.setItem(UPDATE_STATE_KEY, { a1: { remoteVersion: '9', checkedAt: 1, status: 'available' } });
    const remote = '// ==UserScript==\n// @name t\n// @version 2.0.0\n// @match https://a.com/*\n// ==/UserScript==\nnewcode();';
    vi.stubGlobal('fetch', okFetch(remote));
    const next = await handleApplyUpdate('a1');
    expect(next.meta?.version).toBe('2.0.0');
    expect(next.meta?.downloadURL).toBe('https://x/d'); // 本地更新源保留
    expect(next.code).toBe('newcode();');
    const map = await readUpdateStates();
    expect(map.a1).toBeUndefined(); // 徽标清除
    vi.unstubAllGlobals();
  });
  it('下载超长 → 拒绝且不写库', async () => {
    await saveScript(mkScript({ id: 'a2', meta: { downloadURL: 'https://x/d' } }));
    vi.stubGlobal('fetch', okFetch('x'.repeat(280 * 1024 + 1)));
    await expect(handleApplyUpdate('a2')).rejects.toThrow('超过上限');
    expect((await listScripts()).find((x) => x.id === 'a2')?.meta?.version).toBe('1.0.0');
    vi.unstubAllGlobals();
  });
  it('远端空码（头后无代码体）→ 拒绝', async () => {
    await saveScript(mkScript({ id: 'a3', meta: { downloadURL: 'https://x/d' } }));
    vi.stubGlobal('fetch', okFetch('// ==UserScript==\n// @name t\n// ==/UserScript==\n'));
    await expect(handleApplyUpdate('a3')).rejects.toThrow('code 不能为空');
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /d/workspace-mou8/abe-dev && npx vitest run tests/background/scripts-update.test.ts`
Expected: FAIL（Cannot find module '../../background/scripts-update'）

- [ ] **Step 3: 写实现（完整文件）**

```ts
// background/scripts-update.ts
// 脚本更新编排（spec §1）：update-state 独立存取 + URL 导入 + 手动检查/应用 + 启动批量检查。
// 复用 handleImport / handleUpdate（text 为唯一真源）；meta 是解析投影 → 更新源经 injectMetaLines 注入文本。

import { storage } from 'wxt/utils/storage';
import type { ScriptUpdateState, UserScript } from '../shared/types';
import { UPDATE_STATE_KEY } from '../shared/types';
import { parseUserScript, injectMetaLines } from '../shared/userscript-meta';
import { compareVersions } from '../shared/version';
import { MAX_TEXT_LENGTH } from '../storage/scripts';
import { handleImport, handleUpdate, getScript, listScripts } from './scripts';

const CHECK_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const CHECK_CONCURRENCY = 4;

export type ScriptUpdateMap = Record<string, ScriptUpdateState>;

// ---------- 存取 ----------

export async function readUpdateStates(): Promise<ScriptUpdateMap> {
  return (await storage.getItem<ScriptUpdateMap>(UPDATE_STATE_KEY)) ?? {};
}

async function writeUpdateStates(map: ScriptUpdateMap): Promise<void> {
  await storage.setItem(UPDATE_STATE_KEY, map);
}

/** 删除单脚本条目（不变量：应用更新成功 / 脚本删除 / 文本更新后由 scripts.ts 调用） */
export async function clearUpdateState(scriptId: string): Promise<void> {
  const map = await readUpdateStates();
  if (!(scriptId in map)) return;
  delete map[scriptId];
  await writeUpdateStates(map);
}

// ---------- fetch（AbortController 超时，gm-resources 同款） ----------

async function fetchText(url: string, timeoutMs: number): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs);
  try {
    const resp = await fetch(url, { signal: ac.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.text();
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 更新源（TM 语义回退链） ----------

export function updateCheckUrl(s: UserScript): string | undefined {
  return s.meta?.updateURL ?? s.meta?.downloadURL;
}
export function updateDownloadUrl(s: UserScript): string | undefined {
  return s.meta?.downloadURL ?? s.meta?.updateURL;
}

// ---------- 单脚本检查 ----------

export async function checkScriptUpdate(s: UserScript): Promise<ScriptUpdateState> {
  const url = updateCheckUrl(s);
  if (!url) {
    return { remoteVersion: '', checkedAt: Date.now(), status: 'error', message: '无更新源（@updateURL/@downloadURL）' };
  }
  try {
    const text = await fetchText(url, CHECK_TIMEOUT_MS);
    if (!text.includes('// ==UserScript==')) {
      return { remoteVersion: '', checkedAt: Date.now(), status: 'error', message: '下载内容不是有效脚本' };
    }
    const remote = parseUserScript(text).fields.meta.version ?? '';
    const local = s.meta?.version ?? '';
    return {
      remoteVersion: remote,
      checkedAt: Date.now(),
      status: compareVersions(remote, local) > 0 ? 'available' : 'up-to-date',
    };
  } catch (e) {
    return { remoteVersion: '', checkedAt: Date.now(), status: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}

// ---------- 启动批量检查（fire-and-forget；并发上限 4） ----------

export async function runStartupUpdateCheck(): Promise<void> {
  const all = await listScripts();
  const targets = all.filter((s) => updateCheckUrl(s) != null);
  if (targets.length === 0) return;
  const prev = await readUpdateStates();
  const results: ScriptUpdateMap = { ...prev };
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(CHECK_CONCURRENCY, targets.length) }, async () => {
      while (cursor < targets.length) {
        const s = targets[cursor++]!;
        results[s.id] = await checkScriptUpdate(s);
      }
    }),
  );
  await writeUpdateStates(results);
  await broadcastUpdates(results);
}

async function broadcastUpdates(updates: ScriptUpdateMap): Promise<void> {
  // 无接收方（sidepanel 未开）时 sendMessage 会 reject——fire-and-forget，吞掉即可
  void browser.runtime.sendMessage({ type: 'SCRIPTS_UPDATES', updates }).catch(() => {});
}

// ---------- URL 导入（SCRIPTS_IMPORT_URL） ----------

export async function handleImportUrl(rawUrl: string): Promise<{ script: UserScript; warnings: string[] }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('URL 格式无效');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('仅支持 http(s) 直链');
  }
  const text = await fetchText(url.href, DOWNLOAD_TIMEOUT_MS);
  if (text.length > MAX_TEXT_LENGTH) throw new Error(`脚本文本超过上限（${MAX_TEXT_LENGTH} 字符）`);
  if (!text.includes('// ==UserScript==')) throw new Error('下载内容不是有效脚本（缺少 ==UserScript== 头）');
  // 头里没写更新源 → 导入 URL 记为 @updateURL（后续可自动检查更新）；已有则不覆盖
  const metaUpdateUrl = parseUserScript(text).fields.meta.updateURL;
  const withMeta = injectMetaLines(text, { updateURL: metaUpdateUrl ?? url.href });
  return handleImport(withMeta);
}

// ---------- 应用更新（SCRIPTS_APPLY_UPDATE） ----------

export async function handleApplyUpdate(id: string): Promise<UserScript> {
  const existing = await getScript(id);
  if (!existing) throw new Error(`脚本不存在：${id}`);
  const url = updateDownloadUrl(existing);
  if (!url) throw new Error('无更新源（@updateURL/@downloadURL）');
  const text = await fetchText(url, DOWNLOAD_TIMEOUT_MS);
  if (text.length > MAX_TEXT_LENGTH) throw new Error(`脚本文本超过上限（${MAX_TEXT_LENGTH} 字符）`);
  if (!text.includes('// ==UserScript==')) throw new Error('下载内容不是有效脚本（缺少 ==UserScript== 头）');
  // 本地已有更新源 → 带进远端新文本（远端可能没写这两个键；injectMetaLines 只加不覆盖语义由「远端无此键」保证）
  const withMeta = injectMetaLines(text, {
    updateURL: existing.meta?.updateURL,
    downloadURL: existing.meta?.downloadURL,
  });
  const next = await handleUpdate(id, { text: withMeta });
  await clearUpdateState(id); // 版本已对齐，徽标消失
  return next;
}
```

注意：`handleApplyUpdate` 里 `injectMetaLines(text, { updateURL: existing.meta?.updateURL, ... })` 若远端新文本**已含** `@updateURL` 会造成重复行——但远端已有的话该行在 inject 前已存在，splice 只是再插一行同键行，parseUserScript 取后值……为杜绝歧义，实现时改为显式判断：

```ts
  const remoteMeta = parseUserScript(text).fields.meta;
  const withMeta = injectMetaLines(text, {
    updateURL: remoteMeta.updateURL ?? existing.meta?.updateURL,
    downloadURL: remoteMeta.downloadURL ?? existing.meta?.downloadURL,
  });
```

（远端有 → 不 inject；远端无 → 补本地值。Task 3 的「已有不覆盖」测试即覆盖此语义。）

- [ ] **Step 4: 运行测试确认通过**

Run: `cd /d/workspace-mou8/abe-dev && npx vitest run tests/background/scripts-update.test.ts`
Expected: PASS（17 用例）

- [ ] **Step 5: 全量回归 + 类型检查**

Run: `cd /d/workspace-mou8/abe-dev && npm run test && npm run compile`
Expected: 全部 PASS、无类型错误

- [ ] **Step 6: Commit**

```bash
git add background/scripts-update.ts tests/background/scripts-update.test.ts
git commit -m "feat(scripts-update): 更新编排层——update-state 存取/检查/URL 导入/应用更新/启动批量检查"
```

---

### Task 5: `background/scripts.ts` 接线 + 不变量 + 启动钩子（TDD）

**Files:**
- Modify: `background/scripts.ts`
- Modify: `entrypoints/background.ts`
- Test: `tests/background/scripts.test.ts`（文件末尾追加）

**架构决策（已定，执行者勿改）：** 启动检查只在 `entrypoints/background.ts` 的 `onStartup` + `onInstalled` 两个独立 listener 触发，**不**放 `initScriptsModule`——MV3 SW 因任意消息被杀后重启都会重新执行模块初始化，放那里会把「检查更新」变成高频行为；onStartup/onInstalled 才是 spec §1.6 的语义。

- [ ] **Step 1: 写失败测试（tests/background/scripts.test.ts 末尾追加；顶部静态 import 补齐）**

顶部补：

```ts
import { storage } from 'wxt/utils/storage';
import { UPDATE_STATE_KEY, type ScriptUpdateState } from '../../shared/types';
import { readUpdateStates } from '../../background/scripts-update';
```

末尾追加：

```ts
describe('更新接线（spec §2）', () => {
  function setState(id: string): void {
    void storage.setItem(UPDATE_STATE_KEY, {
      [id]: { remoteVersion: '9', checkedAt: 1, status: 'available' } satisfies ScriptUpdateState,
    });
  }

  it('SCRIPTS_IMPORT_URL / CHECK_UPDATE / APPLY_UPDATE 三个 handler 已挂', async () => {
    installFakeUserScripts();
    const router = new MessageRouter();
    initScriptsModule(router);
    for (const type of ['SCRIPTS_IMPORT_URL', 'SCRIPTS_CHECK_UPDATE', 'SCRIPTS_APPLY_UPDATE']) {
      const r = await router.dispatch({ type } as { type: string });
      expect(r).not.toMatchObject({ error: expect.stringContaining('no handler') });
    }
  });

  it('不变量：handleUpdate 文本路径清 update-state', async () => {
    installFakeUserScripts();
    const { script } = await handleImport('// ==UserScript==\n// @name t\n// @match https://a.com/*\n// ==/UserScript==\ncode();');
    setState(script.id);
    await handleUpdate(script.id, { text: '// ==UserScript==\n// @name t2\n// @match https://a.com/*\n// ==/UserScript==\ncode2();' });
    expect((await readUpdateStates())[script.id]).toBeUndefined();
  });

  it('不变量：handleDelete 清 update-state', async () => {
    installFakeUserScripts();
    const { script } = await handleImport('// ==UserScript==\n// @name t\n// @match https://a.com/*\n// ==/UserScript==\ncode();');
    setState(script.id);
    await handleDelete(script.id);
    expect((await readUpdateStates())[script.id]).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /d/workspace-mou8/abe-dev && npx vitest run tests/background/scripts.test.ts`
Expected: FAIL（no handler / state 未清）

- [ ] **Step 3: 实现**

`background/scripts.ts` 顶部 import 补：

```ts
import { handleImportUrl, checkScriptUpdate, handleApplyUpdate, clearUpdateState } from './scripts-update';
```

（循环依赖说明：scripts-update.ts 静态 import scripts.ts 的 handleImport/handleUpdate/getScript/listScripts；scripts.ts 反向 import scripts-update.ts。两模块顶层均无相互立即执行调用，函数体内调用时各自模块已初始化完毕，ESM 循环安全。若执行中遇 TDZ 报错，把 scripts.ts 侧改为函数内 `await import('./scripts-update')`。）

`initScriptsModule` 内、`SCRIPTS_REVOKE_PERMISSION` handler 之后追加：

```ts
  router.on('SCRIPTS_IMPORT_URL', async (msg) => {
    const { url } = msg as unknown as { url: string };
    const { script, warnings } = await handleImportUrl(url);
    return { ok: true, data: { script, warnings } };
  });

  router.on('SCRIPTS_CHECK_UPDATE', async (msg) => {
    const { id } = msg as unknown as { id: string };
    const script = await getScript(id);
    if (!script) throw new Error(`脚本不存在：${id}`);
    return { ok: true, data: await checkScriptUpdate(script) };
  });

  router.on('SCRIPTS_APPLY_UPDATE', async (msg) => {
    const { id } = msg as unknown as { id: string };
    return { ok: true, data: { script: await handleApplyUpdate(id) } };
  });
```

`handleUpdate` 文本路径分支内（`next = buildFromText({...}).script;` 之后、`saveScript(next)` 之前）追加：

```ts
    await clearUpdateState(id); // spec §1.2 不变量：本地改动使旧检查结果过期
```

`handleDelete` 内（`deleteScript(id)` 之后）追加：

```ts
  await clearUpdateState(id).catch(() => {}); // spec §1.2 不变量
```

`entrypoints/background.ts`：import 补 `import { runStartupUpdateCheck } from '../background/scripts-update';`；`defineBackground` 回调内（`initGmApi(router);` 之后）追加：

```ts
  // 浏览器启动 / 扩展安装更新时批量检查脚本更新（spec §1.6；fire-and-forget 不阻塞）
  browser.runtime.onStartup.addListener(() => { void runStartupUpdateCheck().catch(() => {}); });
  browser.runtime.onInstalled.addListener(() => { void runStartupUpdateCheck().catch(() => {}); });
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd /d/workspace-mou8/abe-dev && npx vitest run tests/background/scripts.test.ts`
Expected: PASS（含新 3 用例）

- [ ] **Step 5: 全量回归 + 类型检查**

Run: `cd /d/workspace-mou8/abe-dev && npm run test && npm run compile`
Expected: 全部 PASS

- [ ] **Step 6: Commit**

```bash
git add background/scripts.ts entrypoints/background.ts tests/background/scripts.test.ts
git commit -m "feat(scripts-update): 编排层接线 3 handler + onStartup/onInstalled 启动检查 + 不变量清理"
```

---

### Task 6: store 扩展 + ScriptsView 广播监听

**Files:**
- Modify: `stores/scripts.ts`
- Modify: `components/scripts/ScriptsView.tsx`

- [ ] **Step 1: stores/scripts.ts**

import 补：

```ts
import type { ScriptsUpdatesEvent } from '../shared/messages';
import { UPDATE_STATE_KEY, type ScriptUpdateState } from '../shared/types';
```

`ScriptsState` 接口补（`confirms` 字段后）：

```ts
  /** 启动/手动检查的更新状态 map（scriptId → state；spec §2） */
  updates: Record<string, ScriptUpdateState>;
  /** 本次会话忽略更新的脚本（不持久化；下轮启动重查还会提醒） */
  dismissed: Set<string>;
  applyUpdatesEvent: (e: ScriptsUpdatesEvent) => void;
  dismissUpdate: (scriptId: string) => void;
```

初始值（`confirms: []` 后）：

```ts
  updates: {},
  dismissed: new Set<string>(),
```

action 实现（`applyConfirmResolved` 后）：

```ts
  applyUpdatesEvent: (e) => set({ updates: e.updates }),
  dismissUpdate: (scriptId) => set((s) => {
    const next = new Set(s.dismissed);
    next.add(scriptId);
    return { dismissed: next };
  }),
```

`refresh()` 的 gmResp 取值后追加复水（侧边栏冷开错过 SCRIPTS_UPDATES 广播；storage 直读，面板与 SW 共享同一键）：

```ts
      const storedUpdates = (await browser.storage.local.get(UPDATE_STATE_KEY))[UPDATE_STATE_KEY] as Record<string, ScriptUpdateState> | undefined;
```

`set({...})` 内（`confirms: gmResp.data?.confirms ?? [],` 后）补：

```ts
        updates: storedUpdates ?? {},
```

- [ ] **Step 2: components/scripts/ScriptsView.tsx**

import 行（`from '../../shared/messages'`）补 `ScriptsUpdatesEvent`；`onMessage` 函数里 `GM_CONFIRM_RESOLVED` 分支后补：

```ts
      if (m?.type === 'SCRIPTS_UPDATES') {
        useScripts.getState().applyUpdatesEvent(msg as ScriptsUpdatesEvent);
      }
```

- [ ] **Step 3: 类型检查 + 全量测试**

Run: `cd /d/workspace-mou8/abe-dev && npm run compile && npm run test`
Expected: 通过

- [ ] **Step 4: Commit**

```bash
git add stores/scripts.ts components/scripts/ScriptsView.tsx
git commit -m "feat(scripts-update): store updates/dismissed 状态 + SCRIPTS_UPDATES 监听 + storage 复水"
```

---

### Task 7: 列表页 UI——URL 导入入口

**Files:**
- Modify: `components/scripts/ScriptsListView.tsx`

- [ ] **Step 1: 实现**

lucide import 行补 `Link`：

```ts
import { CircleAlert, Link, Plus, Search, Trash2, Upload } from 'lucide-react';
```

组件内新增状态（`fileRef` 后）：

```ts
  const [urlBarOpen, setUrlBarOpen] = useState(false);
  const [urlValue, setUrlValue] = useState('');
  const [urlBusy, setUrlBusy] = useState(false);
```

新增函数（`importFile` 后）：

```ts
  async function importUrl(): Promise<void> {
    const url = urlValue.trim();
    if (!url) return;
    setUrlBusy(true);
    try {
      const resp = await sendScriptsRequest<{ ok: boolean; data?: { script: { id: string }; warnings: string[] }; error?: string }>({
        type: 'SCRIPTS_IMPORT_URL', url,
      });
      if (resp.ok && resp.data) {
        setUrlBarOpen(false);
        setUrlValue('');
        setImportWarnings(resp.data.warnings);
        await useScripts.getState().refresh();
        openScriptTab(resp.data.script.id);
      } else {
        setImportWarnings([resp.error ?? 'URL 导入失败']);
      }
    } finally {
      setUrlBusy(false);
    }
  }
```

actions 区（Upload Button 后）加第三个 icon 按钮：

```tsx
          <Button variant="ghost" className="btn--icon" aria-label="从 URL 导入" onClick={() => setUrlBarOpen((v) => !v)}>
            <Link size={16} />
          </Button>
```

`scripts-toolbar` div 之后、`importWarnings` 块之前插输入条：

```tsx
      {urlBarOpen && (
        <div className="scripts-toolbar" role="form" aria-label="从 URL 导入脚本">
          <Input
            aria-label="脚本 URL"
            placeholder="https://…/script.user.js"
            value={urlValue}
            onChange={(e) => setUrlValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void importUrl(); }}
            disabled={urlBusy}
          />
          <Button variant="signal" disabled={urlBusy || !urlValue.trim()} onClick={() => void importUrl()}>
            {urlBusy ? '导入中…' : '导入'}
          </Button>
        </div>
      )}
```

- [ ] **Step 2: 类型检查 + 全量测试**

Run: `cd /d/workspace-mou8/abe-dev && npm run compile && npm run test`
Expected: 通过

- [ ] **Step 3: Commit**

```bash
git add components/scripts/ScriptsListView.tsx
git commit -m "feat(scripts-ui): 列表页 URL 导入入口（Link 按钮 + 行内输入条 + 回车提交）"
```

---

### Task 8: 列表页 UI——更新徽标 + 确认更新操作条

**Files:**
- Modify: `components/scripts/ScriptsListView.tsx`

- [ ] **Step 1: 实现**

组件解构补 `updates, dismissed`：

```ts
  const { summaries, query, engineWarning, confirms, updates, dismissed, setQuery } = useScripts();
```

新增函数（`setEnabled` 后）：

```ts
  async function applyUpdate(id: string, name: string, version: string): Promise<void> {
    if (!window.confirm(`将下载新版本并覆盖本地修改（含代码与设置），确认更新「${name}」到 v${version}？`)) return;
    const resp = await sendScriptsRequest<{ ok: boolean; error?: string }>({ type: 'SCRIPTS_APPLY_UPDATE', id });
    if (!resp.ok) {
      setImportWarnings([resp.error ?? '更新失败']);
      return;
    }
    await useScripts.getState().refresh();
  }
```

卡片 map 回调内、`return (` 前取状态：

```tsx
          {(() => {
            const upd = updates[s.id];
            const hasUpdate = upd?.status === 'available' && !dismissed.has(s.id);
            return (
            /* 原卡片 JSX 保持不动，仅做下面两处插入 */
```

（更简单的做法——不用 IIFE：卡片 map 回调改为块体 `{visible.map((s) => { const upd = updates[s.id]; const hasUpdate = upd?.status === 'available' && !dismissed.has(s.id); return (...原 JSX...); })}`。执行者采用块体方案。）

`scripts-card__badges` span 内、errorCount 徽标后追加：

```tsx
                {hasUpdate && (
                  <span className="scripts-badge scripts-badge--signal mono" title="有可用更新，确认后从更新源下载">
                    ↑ v{upd!.remoteVersion}
                  </span>
                )}
```

`scripts-card__meta` div 之后追加操作条：

```tsx
            {hasUpdate && (
              <div className="scripts-card__updatebar">
                <Button
                  variant="signal"
                  onClick={(e) => { e.stopPropagation(); void applyUpdate(s.id, s.name, upd!.remoteVersion); }}
                >
                  更新到 v{upd!.remoteVersion}
                </Button>
                <Button
                  variant="ghost"
                  onClick={(e) => { e.stopPropagation(); useScripts.getState().dismissUpdate(s.id); }}
                >
                  忽略
                </Button>
              </div>
            )}
```

- [ ] **Step 2: 类型检查 + 全量测试**

Run: `cd /d/workspace-mou8/abe-dev && npm run compile && npm run test`
Expected: 通过

- [ ] **Step 3: Commit**

```bash
git add components/scripts/ScriptsListView.tsx
git commit -m "feat(scripts-ui): 卡片更新徽标（↑ vX.Y.Z）+ 确认更新/忽略操作条"
```

---

### Task 9: 详情页——检查更新行 + 按钮

**Files:**
- Modify: `components/detail/DetailInfoTab.tsx`

- [ ] **Step 1: 实现**

import 区改为：

```ts
import { useEffect, useState } from 'react';
import { Check, RefreshCw, X } from 'lucide-react';
import { Button } from '../ui/Button';
import { sendScriptsRequest } from '../../stores/scripts';
import { classifyGrants } from '../../shared/gm-apis';
import { UPDATE_STATE_KEY, type ScriptUpdateState } from '../../shared/types';
import type { UserScript } from '../../shared/types';
```

组件内新增状态（`const [busy, setBusy] = useState(false);` 后）：

```ts
  const hasSource = Boolean(meta.updateURL || meta.downloadURL);
  const [checkState, setCheckState] = useState<ScriptUpdateState | null>(null);
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState(false);

  // 复水：上次启动检查的结果直接显示，不用再点
  useEffect(() => {
    let alive = true;
    void (async () => {
      const stored = (await browser.storage.local.get(UPDATE_STATE_KEY))[UPDATE_STATE_KEY] as Record<string, ScriptUpdateState> | undefined;
      if (alive && stored?.[script.id]) setCheckState(stored[script.id]);
    })();
    return () => { alive = false; };
  }, [script.id]);
```

新增函数（`toggleEnabled` 后）：

```ts
  async function checkUpdate(): Promise<void> {
    setChecking(true);
    try {
      const resp = await sendScriptsRequest<{ ok: boolean; data?: ScriptUpdateState; error?: string }>({ type: 'SCRIPTS_CHECK_UPDATE', id: script.id });
      setCheckState(resp.ok && resp.data ? resp.data : { remoteVersion: '', checkedAt: Date.now(), status: 'error', message: resp.error ?? '检查失败' });
    } finally {
      setChecking(false);
    }
  }

  async function doApplyUpdate(): Promise<void> {
    if (!checkState) return;
    if (!window.confirm(`将下载新版本并覆盖本地修改（含代码与设置），确认更新「${script.name}」到 v${checkState.remoteVersion}？`)) return;
    setUpdating(true);
    try {
      const resp = await sendScriptsRequest<{ ok: boolean; data?: { script: UserScript }; error?: string }>({ type: 'SCRIPTS_APPLY_UPDATE', id: script.id });
      if (resp.ok && resp.data) {
        setCheckState(null);
        onChanged(resp.data.script, `已更新到 v${resp.data.script.meta?.version ?? checkState.remoteVersion}`);
      } else {
        setCheckState({ ...checkState, status: 'error', message: resp.error ?? '更新失败' });
      }
    } finally {
      setUpdating(false);
    }
  }
```

「版本」inforow 之后插入检查结果行：

```tsx
      {(hasSource || checkState) && (
        <div className="detail__inforow">
          <span className="detail__infokey" title="update check">更新检查</span>
          <span className="detail__infoval">
            {checkState == null && <span style={{ color: 'var(--ink-3)' }}>尚未检查</span>}
            {checkState?.status === 'up-to-date' && <span>已是最新{checkState.remoteVersion ? ` v${checkState.remoteVersion}` : ''}</span>}
            {checkState?.status === 'available' && (
              <>
                <span>有新版本 v{checkState.remoteVersion}</span>
                <Button variant="signal" disabled={updating} onClick={() => void doApplyUpdate()} style={{ marginLeft: 8 }}>
                  更新
                </Button>
              </>
            )}
            {checkState?.status === 'error' && <span style={{ color: 'var(--warn)' }}>{checkState.message}</span>}
          </span>
        </div>
      )}
```

底部操作区（启停按钮之前）加检查按钮（无源置灰 + title 说明，spec §3.2）：

```tsx
        <Button
          variant="ghost"
          disabled={!hasSource || checking || updating}
          title={hasSource ? undefined : '无更新源（@updateURL/@downloadURL）'}
          onClick={() => void checkUpdate()}
        >
          <RefreshCw size={13} /> {checking ? '检查中…' : '检查更新'}
        </Button>
```

- [ ] **Step 2: 类型检查 + 全量测试**

Run: `cd /d/workspace-mou8/abe-dev && npm run compile && npm run test`
Expected: 通过

- [ ] **Step 3: Commit**

```bash
git add components/detail/DetailInfoTab.tsx
git commit -m "feat(scripts-ui): 详情页检查更新行（复水 + 手动检查 + 行内更新）"
```

---

### Task 10: 样式 + 构建验证 + 收尾

**Files:**
- Modify: `entrypoints/sidepanel/styles.css`（.scripts-card--off 行后）

- [ ] **Step 1: 追加样式**

```css
.scripts-card__updatebar {
  display: flex; gap: 8px; align-items: center; margin-top: 7px; padding-top: 7px;
  border-top: 1px dashed var(--line);
}
```

- [ ] **Step 2: 生产构建验证**

Run: `cd /d/workspace-mou8/abe-dev && npm run build`
Expected: 构建成功（sidepanel / script-detail 产物正常）

- [ ] **Step 3: 全量回归**

Run: `cd /d/workspace-mou8/abe-dev && npm run test && npm run compile`
Expected: 全部 PASS

- [ ] **Step 4: Commit**

```bash
git add entrypoints/sidepanel/styles.css
git commit -m "feat(scripts-ui): scripts-card__updatebar 样式（更新操作条分隔线布局）"
```

---

## 验收清单（对照 spec）

- [ ] URL 直链导入：工具栏 Link 按钮 → 输入条 → 回车/导入 → 成功开详情页；非 http(s) 拒绝；HTML 拒绝；无更新源头注入导入 URL
- [ ] 启动检查：onStartup/onInstalled 触发（不在 initScriptsModule）；只查有更新源脚本；并发 4；结果落 storage + 广播
- [ ] 列表提醒：available → `↑ vX.Y.Z` 徽标 + 操作条（更新/忽略）；忽略会话内隐藏；error 不进列表
- [ ] 确认更新：confirm 文案声明覆盖 → APPLY_UPDATE → 本地更新源保留 → 徽标消失
- [ ] 详情页：无源按钮置灰 + title 说明；有源可检查；复水上次结果；行内更新 → onChanged 刷版本
- [ ] 不变量：handleUpdate 文本路径 / handleDelete / 应用更新成功 → 清 update-state
- [ ] `npm run test`、`npm run compile`、`npm run build` 全绿

## Handoff（执行完成后回填）

- 启动检查挂载位置最终为 entrypoints/background.ts 的 onStartup + onInstalled 双 listener（Task 5 架构决策段）——若实现时语义有变，回填此处。
- Task 4 `handleApplyUpdate` 内 remoteMeta 先解析再 inject 的写法（防重复行）已内联在 Step 3 尾部说明，实现时采用。
- UPDATE_STATE_KEY 落点 shared/types.ts（Task 2 定稿）；scripts-update.ts 与 store/详情页均从 shared 导入。
