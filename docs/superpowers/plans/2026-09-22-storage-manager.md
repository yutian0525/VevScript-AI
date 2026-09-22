# 存储管理页实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 设置二级页「存储管理」——按数据域统计 `chrome.storage.local` 用量、清理可再生数据（GM 资源缓存 / Agent trace）、全量备份导出与全量替换导入。

**Architecture:** 后台新模块 `background/storage-manager.ts` 承载四条消息（统计/清理/导出/导入），分组与备份拼装为纯函数可直测；UI 为 `components/settings/StoragePage.tsx` 三区块，挂设置壳新增「数据」组入口。

**Tech Stack:** WXT + React 19 + TypeScript；vitest + `wxt/testing/fake-browser` + @testing-library/react（组件测试用 `@vitest-environment jsdom`）；样式全走 `entrypoints/sidepanel/styles.css`。

**Spec:** `docs/superpowers/specs/2026-09-22-storage-manager-design.md`（计划从 spec 论证，执行者两份都读）

## Global Constraints

- **键前缀双轨（易错点）**：WXT `storage`（`wxt/utils/storage`）读写用带前缀键（`'local:scripts:index'`）；裸 `browser.storage.local` 用物理键（无前缀，如 `'scripts:index'`）。本模块全量 dump/clear/remove **一律裸 API + 物理键**；分组函数按物理键分类。新增 WXT 键时必须走 WXT storage（历史坑见 `shared/types.ts` UPDATE_STATE_KEY 注释）。
- 消息类型统一定义 `shared/messages.ts`；handler 经 `MessageRouter` 返回 `{ ok: true, data? }`（抛错由 router 包装为 `{ ok: false, error }`）。
- 样式全走 `entrypoints/sidepanel/styles.css`，只用 `:root` CSS 变量（`--ink/--ink-2/--ink-3/--line/--line-strong/--surface/--paper/--sunken/--signal/--err/--r-md/--t-fast/--ease` 等），禁硬编码色值；mono 类用于字节/键名等机器语言。
- 图标用 lucide-react，禁 emoji；危险操作用行内二次确认（首点变「确认…？」，5s 超时还原）。
- 每个任务收尾：`npx vitest run <相关测试>` 绿 → `npm run compile` 干净 → commit。全量测试在本计划最后一跑。
- 提交信息 conventional commits + 中文主题，尾行 `Co-Authored-By: Claude Code <noreply@anthropic.com>`。

---

### Task 1: 消息协议 + 分组/统计（STORAGE_USAGE_GET）

**Files:**
- Modify: `shared/messages.ts`（文件尾追加存储管理段）
- Create: `background/storage-manager.ts`
- Test: `tests/background/storage-manager.test.ts`

**Interfaces:**
- Consumes: 无（首个任务）
- Produces: `shared/messages.ts` 导出 `StorageGroupKey`（11 值联合）、`StorageUsageGroup`、`StorageTraceItem`、`StorageUsage`、`StorageCleanScope`、`StorageManagerRequest`、`StorageExportData`、`StorageImportResult`；`background/storage-manager.ts` 导出 `initStorageManagerModule(router: MessageRouter): void`、`classifyKey(key: string): StorageGroupKey`、`byteLength(v: unknown): number`、`getStorageUsage(): Promise<StorageUsage>`、`buildBackup(...)`、`jsonDataUrl(...)`、`parseBackup(...)`、`importBackup(...)`、`cleanStorage(...)`（后四个在 Task 3/4 实现，本任务只建文件骨架 + 前四项）

- [ ] **Step 1: 写失败测试（分类 + 字节 + 统计）**

创建 `tests/background/storage-manager.test.ts`：

```ts
// tests/background/storage-manager.test.ts
// 存储管理（background/storage-manager.ts）：分组分类、字节统计、清理、备份导出/导入。
// 注意：裸 browser.storage.local 用物理键（无 local: 前缀）；种子数据一律物理键直写。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
// Task 1 只 import 本任务实现的三个函数；Task 2/3/4 落地时把 cleanStorage/buildBackup/jsonDataUrl/parseBackup/importBackup 补进这行 import
import { classifyKey, byteLength, getStorageUsage } from '../../background/storage-manager';

beforeEach(() => {
  fakeBrowser.reset();
  vi.restoreAllMocks();
});

describe('classifyKey（物理键 → 数据域）', () => {
  it.each([
    ['conv-index', 'conv'],
    ['conv:abc123', 'conv'],
    ['conv:abc123:trace', 'trace'],
    ['scripts:index', 'scripts'],
    ['skills:index', 'skills'],
    ['memory:index', 'memory'],
    ['settings', 'settings'],
    ['gm:resources', 'gm-resources'],
    ['gm:permissions', 'gm-auth'],
    ['gm:seed', 'gm-auth'],
    ['script-values:s1', 'gm-values'],
    ['scripts:update-state', 'update-state'],
    ['scripts:last-update-check', 'update-state'],
    ['ext-update:state', 'update-state'],
    ['ext-update:last-check', 'update-state'],
    ['something-new', 'other'],
  ])('%s → %s', (key, expected) => {
    expect(classifyKey(key)).toBe(expected);
  });
});

describe('byteLength（UTF-8 精确字节）', () => {
  it('ASCII 与中文各按编码计', () => {
    expect(byteLength('ab')).toBe(4);        // "ab" 含两引号
    expect(byteLength('中')).toBe(5);        // "中" = 1 + 3 + 1
    expect(byteLength({ a: 1 })).toBe(7);    // {"a":1}
  });
});

describe('getStorageUsage', () => {
  beforeEach(async () => {
    await browser.storage.local.set({
      'conv-index': [{ id: 'a', title: '会话A', updatedAt: 1, status: 'active' }, { id: 'b', title: '会话B', updatedAt: 2, status: 'active' }],
      'conv:a': { id: 'a', messages: [] },
      'conv:a:trace': { turns: new Array(50).fill('x') },  // 大 trace
      'conv:b:trace': { turns: [] },
      'scripts:index': [{ id: 's1' }, { id: 's2' }, { id: 's3' }],
      'settings': { provider: { baseUrl: '', apiKey: 'sk-secret', model: 'm' }, agent: {}, prompt: {} },
      'gm:resources': { 'https://x/1.js': { content: 'x', fetchedAt: 1 }, 'https://x/2.js': { content: 'y', fetchedAt: 2 } },
      'unknown-key': { z: 1 },
    });
  });

  it('分组字节/条目数正确；traces 按字节降序且带会话标题；gmResources 计数', async () => {
    const u = await getStorageUsage();
    expect(u.totalBytes).toBeGreaterThan(0);
    const byGroup = Object.fromEntries(u.groups.map((g) => [g.group, g]));
    expect(byGroup['conv']!.items).toBe(1);            // conv:{id} 键数（conv-index 不计）
    expect(byGroup['trace']!.items).toBe(2);           // 两条 trace 键
    expect(byGroup['scripts']!.items).toBe(3);         // 数组长度
    expect(byGroup['other']!.bytes).toBeGreaterThan(0);
    expect(u.traces[0]!.convId).toBe('a');
    expect(u.traces[0]!.title).toBe('会话A');
    expect(u.traces[1]!.convId).toBe('b');
    expect(u.gmResources.count).toBe(2);
    expect(u.gmResources.bytes).toBeGreaterThan(0);
  });

  it('已删会话的残留 trace：title 置空仍可列出', async () => {
    await browser.storage.local.set({ 'conv:ghost:trace': { turns: [] } });
    const u = await getStorageUsage();
    const ghost = u.traces.find((t) => t.convId === 'ghost');
    expect(ghost).toBeDefined();
    expect(ghost!.title).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/background/storage-manager.test.ts`
Expected: FAIL（`Cannot find module '../../background/storage-manager'`）

- [ ] **Step 3: 加消息类型（shared/messages.ts 文件尾）**

```ts
// ---------- 存储管理（sidepanel → bg request/response，走 MessageRouter）----------

/** 物理键（无 local: 前缀）→ 数据域分类结果，UI 据此显示中文名 */
export type StorageGroupKey =
  | 'conv' | 'trace' | 'scripts' | 'skills' | 'memory' | 'settings'
  | 'gm-resources' | 'gm-auth' | 'gm-values' | 'update-state' | 'other';

export interface StorageUsageGroup { group: StorageGroupKey; bytes: number; items?: number }

export interface StorageTraceItem { convId: string; title?: string; bytes: number }

export interface StorageUsage {
  totalBytes: number;
  groups: StorageUsageGroup[];   // 按字节降序
  traces: StorageTraceItem[];    // 有 trace 的会话，按字节降序（清理列表）
  gmResources: { bytes: number; count: number };
}

export type StorageCleanScope =
  | { kind: 'gm-resources' }
  | { kind: 'trace'; convIds?: string[] };  // 缺省 = 全清

export type StorageManagerRequest =
  | { type: 'STORAGE_USAGE_GET' }
  | { type: 'STORAGE_CLEAN'; scope: StorageCleanScope }
  | { type: 'STORAGE_EXPORT'; includeApiKey: boolean }
  | { type: 'STORAGE_IMPORT'; payload: string };

export interface StorageExportData { filename: string; dataUrl: string }
export interface StorageImportResult { apiKeyMissing: boolean }
```

- [ ] **Step 4: 实现 storage-manager.ts 骨架 + 分类/统计**

创建 `background/storage-manager.ts`：

```ts
// background/storage-manager.ts
// 存储管理编排（spec §3）：分组统计 + 可再生数据清理 + 全量备份导出/导入（全量替换）。
// 全量 dump/clear/remove 只能走裸 browser.storage.local——物理键（无 WXT local: 前缀），
// 分组函数按物理键分类；对照表见 spec §1。

import type {
  StorageCleanScope, StorageGroupKey, StorageUsage, StorageUsageGroup,
} from '../shared/messages';
import type { MessageRouter } from './router';

const PHYS_CONV_INDEX = 'conv-index';
const PHYS_SETTINGS = 'settings';
const PHYS_GM_RESOURCES = 'gm:resources';
const TRACE_SUFFIX = ':trace';

/** 数组型单键域：items = 数组长度而非键数（conv-index 是索引不计条目） */
const ARRAY_KEYS = new Set(['scripts:index', 'skills:index', 'memory:index']);

export function classifyKey(key: string): StorageGroupKey {
  if (key === PHYS_CONV_INDEX) return 'conv';
  if (key.startsWith('conv:')) return key.endsWith(TRACE_SUFFIX) ? 'trace' : 'conv';
  if (key === 'scripts:index') return 'scripts';
  if (key === 'skills:index') return 'skills';
  if (key === 'memory:index') return 'memory';
  if (key === PHYS_SETTINGS) return 'settings';
  if (key === PHYS_GM_RESOURCES) return 'gm-resources';
  if (key === 'gm:permissions' || key === 'gm:seed') return 'gm-auth';
  if (key.startsWith('script-values:')) return 'gm-values';
  if (key === 'scripts:update-state' || key === 'scripts:last-update-check'
    || key === 'ext-update:state' || key === 'ext-update:last-check') return 'update-state';
  return 'other';
}

export function byteLength(v: unknown): number {
  return new TextEncoder().encode(JSON.stringify(v ?? null)).length;
}

export async function getStorageUsage(): Promise<StorageUsage> {
  const dump = await browser.storage.local.get(null);
  const bytesByKey = new Map<string, number>();
  let totalBytes = 0;
  for (const [k, v] of Object.entries(dump)) {
    const b = byteLength(v);
    bytesByKey.set(k, b);
    totalBytes += b;
  }
  const groups = new Map<StorageGroupKey, StorageUsageGroup>();
  for (const [k, b] of bytesByKey) {
    const g = classifyKey(k);
    const cur = groups.get(g) ?? { group: g, bytes: 0, items: 0 };
    cur.bytes += b;
    if (ARRAY_KEYS.has(k)) cur.items += Array.isArray(dump[k]) ? (dump[k] as unknown[]).length : 0;
    else if (k !== PHYS_CONV_INDEX) cur.items += 1; // conv-index 不计条目
    groups.set(g, cur);
  }
  const groupArr = [...groups.values()].sort((a, b) => b.bytes - a.bytes);

  // trace 按会话明细：convId 取键中段，标题从 conv-index 拼（已删会话 title 置空）
  const convIndex = Array.isArray(dump[PHYS_CONV_INDEX])
    ? (dump[PHYS_CONV_INDEX] as Array<{ id: string; title?: string }>) : [];
  const titleById = new Map(convIndex.map((m) => [m.id, m.title]));
  const traces = [...bytesByKey.entries()]
    .filter(([k]) => classifyKey(k) === 'trace')
    .map(([k, bytes]) => {
      const convId = k.slice('conv:'.length, k.length - TRACE_SUFFIX.length);
      return { convId, title: titleById.get(convId), bytes };
    })
    .sort((a, b) => b.bytes - a.bytes);

  const resCache = (dump[PHYS_GM_RESOURCES] as Record<string, unknown> | undefined) ?? {};
  const gmResources = {
    bytes: bytesByKey.get(PHYS_GM_RESOURCES) ?? 0,
    count: Object.keys(resCache).length,
  };
  return { totalBytes, groups: groupArr, traces, gmResources };
}

// ---------- 清理 / 导出 / 导入（Task 2/3/4 实现，先挂路由空位） ----------

export function initStorageManagerModule(router: MessageRouter): void {
  router.on('STORAGE_USAGE_GET', async () => ({ ok: true, data: await getStorageUsage() }));
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run tests/background/storage-manager.test.ts`
Expected: PASS（测试文件按任务分段追加——本步只含 Task 1 的三个 describe，后续任务各追加自己的 describe 并扩充顶部 import）

- [ ] **Step 6: Commit**

```bash
git add shared/messages.ts background/storage-manager.ts tests/background/storage-manager.test.ts
git commit -m "feat(storage): 存储管理后台——物理键分组统计 STORAGE_USAGE_GET"
```

---

### Task 2: 清理（STORAGE_CLEAN）

**Files:**
- Modify: `background/storage-manager.ts`（追加 cleanStorage + 路由注册）
- Test: `tests/background/storage-manager.test.ts`（追加 describe）

**Interfaces:**
- Consumes: Task 1 的 `classifyKey` / `initStorageManagerModule`
- Produces: `cleanStorage(scope: StorageCleanScope): Promise<void>`

- [ ] **Step 1: 追加失败测试（测试文件追加 describe）**

```ts
describe('cleanStorage（只清可再生数据）', () => {
  beforeEach(async () => {
    await browser.storage.local.set({
      'gm:resources': { 'https://x/1.js': { content: 'x', fetchedAt: 1 } },
      'conv:a': { id: 'a', messages: [] },
      'conv:a:trace': { turns: [1, 2, 3] },
      'conv:b:trace': { turns: [] },
    });
  });

  it('gm-resources：整键删除，其余不动', async () => {
    await cleanStorage({ kind: 'gm-resources' });
    const dump = await browser.storage.local.get(null);
    expect(dump['gm:resources']).toBeUndefined();
    expect(dump['conv:a:trace']).toBeDefined(); // trace 不受影响
  });

  it('trace 按 convIds：只删指定会话，本体保留', async () => {
    await cleanStorage({ kind: 'trace', convIds: ['a'] });
    const dump = await browser.storage.local.get(null);
    expect(dump['conv:a:trace']).toBeUndefined();
    expect(dump['conv:b:trace']).toBeDefined();
    expect(dump['conv:a']).toBeDefined(); // 会话本体不动
  });

  it('trace 缺省全清：所有 :trace 键删除，会话本体保留', async () => {
    await cleanStorage({ kind: 'trace' });
    const dump = await browser.storage.local.get(null);
    expect(dump['conv:a:trace']).toBeUndefined();
    expect(dump['conv:b:trace']).toBeUndefined();
    expect(dump['conv:a']).toBeDefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/background/storage-manager.test.ts`
Expected: FAIL（`cleanStorage is not a function`）

- [ ] **Step 3: 实现 cleanStorage 并注册路由**

在 `storage-manager.ts` 替换 Task 1 留下的「清理 / 导出 / 导入」占位段，追加：

```ts
export async function cleanStorage(scope: StorageCleanScope): Promise<void> {
  if (scope.kind === 'gm-resources') {
    await browser.storage.local.remove(PHYS_GM_RESOURCES); // 下次用到重新预取（7 天 TTL 原语义）
    return;
  }
  if (scope.convIds) {
    await browser.storage.local.remove(scope.convIds.map((id) => `conv:${id}${TRACE_SUFFIX}`));
    return;
  }
  const dump = await browser.storage.local.get(null);
  const traceKeys = Object.keys(dump).filter((k) => classifyKey(k) === 'trace');
  if (traceKeys.length) await browser.storage.local.remove(traceKeys);
}
```

`initStorageManagerModule` 里追加：

```ts
router.on('STORAGE_CLEAN', async (msg) => {
  const { scope } = msg as unknown as { scope: StorageCleanScope };
  await cleanStorage(scope);
  return { ok: true };
});
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/background/storage-manager.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add background/storage-manager.ts tests/background/storage-manager.test.ts
git commit -m "feat(storage): 可再生数据清理——GM 资源缓存整键删 + trace 按会话/全清"
```

---

### Task 3: 备份导出（buildBackup + jsonDataUrl + STORAGE_EXPORT）

**Files:**
- Modify: `background/storage-manager.ts`（追加导出管线 + 路由注册）
- Test: `tests/background/storage-manager.test.ts`（追加 describe）

**Interfaces:**
- Consumes: Task 1 的物理键常量（PHYS_SETTINGS 等，文件内私有）
- Produces: `buildBackup(dump: Record<string, unknown>, includeApiKey: boolean, extVersion: string, now?: Date): { json: string; filename: string }`；`jsonDataUrl(json: string): string`；消息 `STORAGE_EXPORT` 响应 data 形状 `StorageExportData { filename, dataUrl }`

- [ ] **Step 1: 追加失败测试**

```ts
describe('buildBackup / jsonDataUrl（备份文件拼装）', () => {
  const dump = {
    'settings': { provider: { baseUrl: 'https://api.x.com', apiKey: 'sk-secret', model: 'm' }, agent: {}, prompt: {} },
    'conv:a': { id: 'a', title: '中文会话' },
  };

  it('includeApiKey=false：provider.apiKey 置空串，settings 其余字段保留', () => {
    const b = buildBackup(dump, false, '1.2.3', new Date('2026-09-22T10:00:00Z'));
    const parsed = JSON.parse(b.json) as { meta: Record<string, unknown>; data: typeof dump };
    expect(parsed.meta).toMatchObject({ app: 'vevscript-ai', kind: 'full-backup', extVersion: '1.2.3', includesApiKey: false });
    const s = parsed.data['settings'] as typeof dump.settings;
    expect(s.provider.apiKey).toBe('');
    expect(s.provider.baseUrl).toBe('https://api.x.com'); // 其余字段不动
    expect(parsed.data['conv:a']).toEqual({ id: 'a', title: '中文会话' });
  });

  it('includeApiKey=true：Key 原样保留', () => {
    const b = buildBackup(dump, true, '1.2.3', new Date('2026-09-22T10:00:00Z'));
    const parsed = JSON.parse(b.json) as { meta: { includesApiKey: boolean }; data: typeof dump };
    expect(parsed.meta.includesApiKey).toBe(true);
    const s = parsed.data['settings'] as typeof dump.settings;
    expect(s.provider.apiKey).toBe('sk-secret');
  });

  it('文件名：vevscript-ai-backup-v{版本}-{YYYYMMDD}.json；不改动传入 dump', () => {
    const snapshot = JSON.stringify(dump);
    const b = buildBackup(dump, false, '1.2.3', new Date('2026-09-22T10:00:00Z'));
    expect(b.filename).toBe('vevscript-ai-backup-v1.2.3-20260922.json');
    expect(JSON.stringify(dump)).toBe(snapshot); // 深拷贝，剔除不改原对象
  });

  it('jsonDataUrl：unicode 安全，可解码还原', () => {
    const b = buildBackup(dump, true, '1.2.3', new Date());
    const url = jsonDataUrl(b.json);
    expect(url.startsWith('data:application/json;base64,')).toBe(true);
    const b64 = url.slice('data:application/json;base64,'.length);
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    expect(new TextDecoder().decode(bytes)).toBe(b.json); // 中文不烂
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/background/storage-manager.test.ts`
Expected: FAIL（`buildBackup is not a function`）

- [ ] **Step 3: 实现导出管线并注册路由**

`storage-manager.ts` 追加：

```ts
// ---------- 备份导出（spec §3.3） ----------

interface SettingsLike { provider?: { apiKey?: string } }

export function buildBackup(
  dump: Record<string, unknown>,
  includeApiKey: boolean,
  extVersion: string,
  now = new Date(),
): { json: string; filename: string } {
  // 深拷贝后处理，绝不改调用方的 dump
  const data = JSON.parse(JSON.stringify(dump)) as Record<string, unknown>;
  if (!includeApiKey) {
    const s = data[PHYS_SETTINGS] as SettingsLike | undefined;
    if (s?.provider) s.provider.apiKey = ''; // 剔除 = 置空串：保住 settings 形状
  }
  const meta = {
    app: 'vevscript-ai',
    kind: 'full-backup',
    exportedAt: now.toISOString(),
    extVersion,
    includesApiKey: includeApiKey,
  };
  const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  return {
    json: JSON.stringify({ meta, data }, null, 2),
    filename: `vevscript-ai-backup-v${extVersion}-${ymd}.json`,
  };
}

/** MV3 SW 无 URL.createObjectURL，导出走 data: URL。btoa 只收 Latin1，经 TextEncoder
 *  转字节后分块转二进制串（中文等 BMP 外字符不烂）。 */
export function jsonDataUrl(json: string): string {
  const bytes = new TextEncoder().encode(json);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:application/json;base64,${btoa(bin)}`;
}
```

`initStorageManagerModule` 追加：

```ts
router.on('STORAGE_EXPORT', async (msg) => {
  const { includeApiKey } = msg as unknown as { includeApiKey: boolean };
  const dump = await browser.storage.local.get(null);
  const b = buildBackup(dump, includeApiKey, browser.runtime.getManifest().version);
  return { ok: true, data: { filename: b.filename, dataUrl: jsonDataUrl(b.json) } };
});
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/background/storage-manager.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add background/storage-manager.ts tests/background/storage-manager.test.ts
git commit -m "feat(storage): 全量备份导出——apiKey 勾选剔除 + unicode 安全 data: URL"
```

---

### Task 4: 备份导入（parseBackup + importBackup + STORAGE_IMPORT）

**Files:**
- Modify: `background/storage-manager.ts`（追加导入管线 + 路由注册）
- Test: `tests/background/storage-manager.test.ts`（追加 describe）

**Interfaces:**
- Consumes: Task 3 的 `buildBackup` / `jsonDataUrl`（留存先行复用导出管线）
- Produces: `parseBackup(text: string): { meta: { app: string; kind: string; includesApiKey?: boolean }, data: Record<string, unknown> }`（无效抛中文错误）；`importBackup(payload: string): Promise<StorageImportResult>`

- [ ] **Step 1: 追加失败测试**

```ts
describe('importBackup（校验 + 留存先行 + 全量替换）', () => {
  /** fakeBrowser 的 downloads 桩（WXT fakeBrowser 未内置；留存下载走它） */
  function installFakeDownloads() {
    (browser as unknown as Record<string, unknown>).downloads = {
      download: vi.fn(async () => 1),
    };
  }
  function fakeDownload(): ReturnType<typeof vi.fn> {
    return (browser as unknown as { downloads: { download: ReturnType<typeof vi.fn> } }).downloads.download;
  }
  function validPayload(): string {
    const b = buildBackup({ 'conv:new': { id: 'new' }, 'settings': { provider: { baseUrl: '', apiKey: 'sk-new', model: 'm' } } }, true, '1.2.3');
    return b.json;
  }

  beforeEach(() => {
    installFakeDownloads();
    // 导入前的旧数据：含 sentinel + 旧 apiKey
    return browser.storage.local.set({
      'conv:old': { id: 'old' },
      'settings': { provider: { baseUrl: '', apiKey: 'sk-old', model: 'm' } },
    });
  });

  it.each([
    ['not json', '坏 JSON'],
    ['wrong meta', JSON.stringify({ meta: { app: 'other', kind: 'full-backup' }, data: {} })],
    ['wrong kind', JSON.stringify({ meta: { app: 'vevscript-ai', kind: 'partial' }, data: {} })],
    ['no data', JSON.stringify({ meta: { app: 'vevscript-ai', kind: 'full-backup' } })],
  ])('%s → 抛错且不动现有数据', async (_name, bad) => {
    await expect(importBackup(bad)).rejects.toThrow();
    const dump = await browser.storage.local.get(null);
    expect(dump['conv:old']).toBeDefined(); // sentinel 完好
  });

  it('合法 payload：留存下载 → clear + 整体替换', async () => {
    const res = await importBackup(validPayload());
    expect(res).toEqual({ apiKeyMissing: false });
    expect(fakeDownload).toHaveBeenCalledTimes(1); // 留存先下载
    const dump = await browser.storage.local.get(null);
    expect(dump['conv:old']).toBeUndefined();
    expect(dump['conv:new']).toBeDefined();
    const s = dump['settings'] as typeof dump.settings;
    expect(s.provider.apiKey).toBe('sk-new');
  });

  it('本地有 Key、导入不含 Key → apiKeyMissing=true；本地没有则 false', async () => {
    const noKey = buildBackup({ 'conv:new': {} }, false, '1.2.3').json;
    expect((await importBackup(noKey)).apiKeyMissing).toBe(true);
    // 再造一次「本地无 Key」的前置状态
    await browser.storage.local.set({ 'conv:old': {}, 'settings': { provider: { baseUrl: '', apiKey: '', model: 'm' } } });
    expect((await importBackup(noKey)).apiKeyMissing).toBe(false);
  });

  it('留存下载失败 → 中止导入，现有数据完好', async () => {
    fakeDownload().mockRejectedValueOnce(new Error('disk full'));
    await expect(importBackup(validPayload())).rejects.toThrow('留存下载失败');
    const dump = await browser.storage.local.get(null);
    expect(dump['conv:old']).toBeDefined();
    expect(dump['conv:new']).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/background/storage-manager.test.ts`
Expected: FAIL（`parseBackup is not a function` 或 `importBackup is not a function`）

- [ ] **Step 3: 实现导入管线并注册路由**

`storage-manager.ts` 追加：

```ts
// ---------- 备份导入（spec §3.4，全量替换） ----------

interface BackupMeta { app?: string; kind?: string; includesApiKey?: boolean }

export function parseBackup(text: string): { meta: BackupMeta; data: Record<string, unknown> } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('不是有效的 JSON 文件');
  }
  const obj = parsed as { meta?: BackupMeta; data?: unknown };
  if (obj?.meta?.app !== 'vevscript-ai' || obj?.meta?.kind !== 'full-backup') {
    throw new Error('不是本扩展的完整备份文件（缺少有效文件头）');
  }
  if (typeof obj.data !== 'object' || obj.data === null) {
    throw new Error('备份缺少 data 数据体');
  }
  return { meta: obj.meta, data: obj.data as Record<string, unknown> };
}

export async function importBackup(payload: string): Promise<StorageImportResult> {
  const { data } = parseBackup(payload); // 校验不过不碰现有数据
  const current = await browser.storage.local.get(null);
  // 留存先行：固定含 Key 的完整备份（留存是给自己看的），下载成功才动库
  const backup = buildBackup(current, true, browser.runtime.getManifest().version);
  try {
    await browser.downloads.download({ url: jsonDataUrl(backup.json), filename: backup.filename });
  } catch (e) {
    throw new Error(`留存下载失败，已中止导入：${e instanceof Error ? e.message : String(e)}`);
  }
  const hadKey = Boolean((current[PHYS_SETTINGS] as SettingsLike | undefined)?.provider?.apiKey);
  const importedKey = Boolean((data[PHYS_SETTINGS] as SettingsLike | undefined)?.provider?.apiKey);
  await browser.storage.local.clear();
  await browser.storage.local.set(data);
  return { apiKeyMissing: hadKey && !importedKey };
}
```

`initStorageManagerModule` 追加：

```ts
router.on('STORAGE_IMPORT', async (msg) => {
  const { payload } = msg as unknown as { payload: string };
  return { ok: true, data: await importBackup(payload) };
});
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/background/storage-manager.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add background/storage-manager.ts tests/background/storage-manager.test.ts
git commit -m "feat(storage): 备份导入——校验不碰库 + 留存先行 + 全量替换 + apiKeyMissing 判定"
```

---

### Task 5: UI 入口 + 用量总览区

**Files:**
- Modify: `components/settings/SettingsHome.tsx`（SettingsSub 类型 + GROUPS 新组）
- Modify: `components/settings/SettingsView.tsx`（路由分支）
- Create: `components/settings/StoragePage.tsx`
- Modify: `entrypoints/sidepanel/styles.css`（`.stor__*` 样式块）
- Test: `tests/settings/settings-view.test.tsx`（追加用例：入口卡进二级页）

**Interfaces:**
- Consumes: Task 1-4 的 `StorageManagerRequest` 消息（经 `browser.runtime.sendMessage`）；`PageShell`（`components/ui/PageShell`，props `title/eyebrow/onBack/backLabel`）
- Produces: `StoragePage({ onBack }: { onBack: () => void })`；`stores/ui.ts` 追加 `sendStorageRequest<T>(req: StorageManagerRequest): Promise<T>`

- [ ] **Step 1: stores/ui.ts 追加请求 helper**

```ts
export async function sendStorageRequest<T = unknown>(req: StorageManagerRequest): Promise<T> {
  return (await browser.runtime.sendMessage(req)) as T;
}
```

文件头 import 行补 `import type { ExtUpdateRequest, StorageManagerRequest } from '../shared/messages';`（与现有 ExtUpdateRequest 合并）。

- [ ] **Step 2: 追加失败测试（settings-view.test.tsx）**

```ts
it('点「存储管理」入口进二级页（STORAGE），返回回列表', () => {
  render(<SettingsView />);
  fireEvent.click(screen.getByText('存储管理'));
  expect(screen.getByText('STORAGE')).toBeTruthy(); // eyebrow
  fireEvent.click(screen.getByLabelText('返回设置'));
  expect(screen.getByText('模型设置')).toBeTruthy();
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run tests/settings/settings-view.test.tsx`
Expected: FAIL（找不到「存储管理」文本）

- [ ] **Step 4: 实现入口与页面骨架**

`SettingsHome.tsx`：

```tsx
// lucide import 行补 Database
import { SlidersHorizontal, SquareTerminal, FlaskConical, ChevronRight, ScrollText, Brain, Info, Activity, Database } from 'lucide-react';
// SettingsSub 改为：
export type SettingsSub = 'model' | 'prompt' | 'memory' | 'toolbench' | 'scriptdebug' | 'storage' | 'about' | 'convdebug';
// GROUPS 在「开发者工具」组之后、「关于」组之前插入：
{
  label: '数据',
  entries: [
    { key: 'storage', title: '存储管理', desc: '各域占用 / 清理缓存 / 导出导入备份', Icon: Database },
  ],
},
```

`SettingsView.tsx`：import `StoragePage`，三分支链里加：

```tsx
) : sub === 'storage' ? (
  <StoragePage onBack={back} />
```

`StoragePage.tsx`（本任务先做总览区）：

```tsx
// components/settings/StoragePage.tsx
// 存储管理二级页（spec §4）：用量总览 / 清理可再生数据 / 备份导出导入。统计经 bg 统一算。
import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { PageShell } from '../ui/PageShell';
import { sendStorageRequest } from '../../stores/ui';
import type { StorageGroupKey, StorageUsage } from '../../shared/messages';

const GROUP_LABELS: Record<StorageGroupKey, string> = {
  conv: '会话本体', trace: 'Agent 调用记录', scripts: '脚本池', skills: '技能',
  memory: '记忆', settings: '设置（含密钥）', 'gm-resources': 'GM 资源缓存',
  'gm-auth': 'GM 授权', 'gm-values': 'GM 脚本值', 'update-state': '更新状态', other: '其它',
};

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function StoragePage({ onBack }: { onBack: () => void }) {
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await sendStorageRequest<{ ok: boolean; data?: StorageUsage }>({ type: 'STORAGE_USAGE_GET' });
      if (resp?.ok && resp.data) setUsage(resp.data);
    } catch { /* 无 handler（如纯 UI 测试环境）静默，列表留空 */ } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const maxBytes = usage?.groups[0]?.bytes ?? 0; // groups 已按字节降序，首个即最大域

  return (
    <PageShell title="存储管理" eyebrow="STORAGE" onBack={onBack} backLabel="返回设置">
      <section className="section">
        <h2 className="section__title">用量总览</h2>
        <div className="stor__total">
          <span>全部持久数据</span>
          <span className="mono">{usage ? fmtBytes(usage.totalBytes) : '…'}</span>
          <button type="button" className="btn btn--icon" aria-label="刷新统计" onClick={() => void refresh()}>
            <RefreshCw size={14} strokeWidth={1.8} className={loading ? 'spin' : undefined} />
          </button>
        </div>
        <div className="stor__rows">
          {usage?.groups.map((g) => (
            <div key={g.group} className="stor__row">
              <span className="stor__row-label">{GROUP_LABELS[g.group]}</span>
              {g.items != null && <span className="stor__row-items mono">{g.items} 项</span>}
              <span className="stor__bar" aria-hidden>
                <span className="stor__bar-fill" style={{ width: maxBytes ? `${Math.max(2, (g.bytes / maxBytes) * 100)}%` : '0%' }} />
              </span>
              <span className="stor__row-bytes mono">{fmtBytes(g.bytes)}</span>
            </div>
          ))}
        </div>
      </section>
    </PageShell>
  );
}
```

`styles.css` 在关于软件页样式块之后追加：

```css
/* ============ 存储管理页 ============ */
.stor__total {
  display: flex; align-items: center; gap: 10px;
  font-size: 13px; color: var(--ink); padding-bottom: 8px; border-bottom: 1px solid var(--line-strong);
}
.stor__total .mono { flex: 1; text-align: right; }
.stor__rows { display: flex; flex-direction: column; }
.stor__row {
  display: flex; align-items: center; gap: 10px;
  padding: 9px 0; border-bottom: 1px solid var(--line);
}
.stor__row-label { font-size: 13px; color: var(--ink); flex: 1; min-width: 0; }
.stor__row-items { font-size: 11px; color: var(--ink-3); flex-shrink: 0; }
.stor__bar { flex: 0 0 72px; height: 4px; border-radius: 2px; background: var(--sunken); overflow: hidden; }
.stor__bar-fill { display: block; height: 100%; background: var(--signal); }
.stor__row-bytes { font-size: 11.5px; color: var(--ink-2); width: 68px; text-align: right; flex-shrink: 0; }
```

- [ ] **Step 5: 跑测试确认通过 + 编译**

Run: `npx vitest run tests/settings/settings-view.test.tsx && npm run compile`
Expected: PASS + 无类型错误

- [ ] **Step 6: Commit**

```bash
git add components/settings/SettingsHome.tsx components/settings/SettingsView.tsx components/settings/StoragePage.tsx entrypoints/sidepanel/styles.css stores/ui.ts tests/settings/settings-view.test.tsx
git commit -m "feat(ui): 设置新增「数据 > 存储管理」二级页——按数据域用量总览"
```

---

### Task 6: 清理区（行内二次确认）

**Files:**
- Modify: `components/settings/StoragePage.tsx`（清理区块 + ConfirmButton）
- Modify: `entrypoints/sidepanel/styles.css`（补充清理区样式）
- Test: `tests/settings/storage-page.test.tsx`（新建）

**Interfaces:**
- Consumes: Task 5 的 `StoragePage` 与 `refresh`；消息 `STORAGE_CLEAN`（scope 形状见 Task 1 类型）
- Produces: `ConfirmButton`（组件内私有，不导出）

- [ ] **Step 1: 写失败测试**

新建 `tests/settings/storage-page.test.tsx`：

```tsx
// tests/settings/storage-page.test.tsx
// 存储管理页测试：用量渲染 / 清理二次确认 / 备份导出导入交互。
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { StoragePage } from '../../components/settings/StoragePage';
import type { StorageUsage } from '../../shared/messages';

const USAGE: StorageUsage = {
  totalBytes: 100,
  groups: [{ group: 'trace', bytes: 60, items: 2 }, { group: 'conv', bytes: 40, items: 1 }],
  traces: [{ convId: 'a', title: '会话A', bytes: 50 }, { convId: 'b', bytes: 10 }],
  gmResources: { bytes: 30, count: 3 },
};

function mockBg(handlers: Record<string, (msg: { type: string }) => unknown>) {
  vi.spyOn(browser.runtime, 'sendMessage').mockImplementation(async (msg: unknown) => {
    const m = msg as { type: string };
    return handlers[m.type]?.(m) ?? { ok: false, error: `no handler: ${m.type}` };
  });
}

beforeEach(() => {
  fakeBrowser.reset();
  vi.restoreAllMocks();
});
afterEach(cleanup);

describe('StoragePage 用量总览', () => {
  it('渲染各域中文名、条目数与字节', async () => {
    mockBg({ STORAGE_USAGE_GET: () => ({ ok: true, data: USAGE }) });
    render(<StoragePage onBack={() => {}} />);
    expect(await screen.findByText('Agent 调用记录')).toBeTruthy();
    expect(screen.getByText('会话本体')).toBeTruthy();
    expect(screen.getByText('2 项')).toBeTruthy();
    expect(screen.getByText('60 B')).toBeTruthy();
  });
});

describe('StoragePage 清理区', () => {
  it('GM 资源缓存清空：二次确认后发 STORAGE_CLEAN 并刷新', async () => {
    const clean = vi.fn(() => ({ ok: true }));
    mockBg({
      STORAGE_USAGE_GET: () => ({ ok: true, data: USAGE }),
      STORAGE_CLEAN: clean,
    });
    render(<StoragePage onBack={() => {}} />);
    const arm = await screen.findByRole('button', { name: '清空缓存' });
    fireEvent.click(arm); // 第一次：武装
    fireEvent.click(screen.getByRole('button', { name: '确认清空？' })); // 第二次：执行
    await waitFor(() => {
      expect(clean).toHaveBeenCalledWith({ type: 'STORAGE_CLEAN', scope: { kind: 'gm-resources' } });
    });
  });

  it('trace 按会话勾选清理：只带勾选的 convIds', async () => {
    const clean = vi.fn(() => ({ ok: true }));
    mockBg({
      STORAGE_USAGE_GET: () => ({ ok: true, data: USAGE }),
      STORAGE_CLEAN: clean,
    });
    render(<StoragePage onBack={() => {}} />);
    fireEvent.click(await screen.findByLabelText('会话A'));
    fireEvent.click(screen.getByRole('button', { name: '清理选中' }));
    fireEvent.click(screen.getByRole('button', { name: '确认清理？' }));
    await waitFor(() => {
      expect(clean).toHaveBeenCalledWith({ type: 'STORAGE_CLEAN', scope: { kind: 'trace', convIds: ['a'] } });
    });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/settings/storage-page.test.tsx`
Expected: FAIL（找不到「清空缓存」按钮）

- [ ] **Step 3: 实现清理区**

`StoragePage.tsx`：文件尾追加私有组件 + 页面里清理区块（置于用量总览 section 之后）：

```tsx
// 文件内 import 补：Trash2（lucide-react）、sendStorageRequest 已有
import type { StorageCleanScope } from '../../shared/messages';

/** 行内二次确认按钮（spec §4.2）：首点武装变 confirmLabel，5s 超时还原；再点执行。 */
function ConfirmButton({ label, confirmLabel, onConfirm }: { label: string; confirmLabel: string; onConfirm: () => void }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 5000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button
      type="button"
      className={`btn ${armed ? 'btn--danger' : ''}`}
      onClick={() => {
        if (armed) { setArmed(false); onConfirm(); } else { setArmed(true); }
      }}
    >
      <Trash2 size={14} strokeWidth={1.8} aria-hidden />
      {armed ? confirmLabel : label}
    </button>
  );
}
```

组件内新增状态与动作（`traceSel` 声明须在 `doClean` 之前，`refresh` 复用 Task 5 的 useCallback）：

```tsx
const [traceSel, setTraceSel] = useState<Set<string>>(new Set());

const doClean = useCallback(async (scope: StorageCleanScope) => {
  await sendStorageRequest({ type: 'STORAGE_CLEAN', scope });
  setTraceSel(new Set());
  await refresh();
}, [refresh]);
```

JSX（用量总览 section 之后）：

```tsx
<section className="section">
  <h2 className="section__title">清理（可再生数据）</h2>
  <div className="stor__rows">
    <div className="stor__row">
      <span className="stor__row-label">GM 资源缓存
        <span className="stor__row-items mono"> · {usage?.gmResources.count ?? 0} 项 · {usage ? fmtBytes(usage.gmResources.bytes) : ''}</span>
      </span>
      <ConfirmButton label="清空缓存" confirmLabel="确认清空？" onConfirm={() => void doClean({ kind: 'gm-resources' })} />
    </div>
    <div className="stor__trace-block">
      <div className="stor__row">
        <span className="stor__row-label">Agent 调用记录（清理后会话调试页对应记录消失）</span>
        <ConfirmButton
          label={traceSel.size ? '清理选中' : '全部清理'}
          confirmLabel="确认清理？"
          onConfirm={() => void doClean(traceSel.size ? { kind: 'trace', convIds: [...traceSel] } : { kind: 'trace' })}
        />
      </div>
      {usage?.traces.map((t) => (
        <label key={t.convId} className="stor__trace-row">
          <input
            type="checkbox"
            aria-label={t.title ?? t.convId}
            checked={traceSel.has(t.convId)}
            onChange={(e) => {
              const next = new Set(traceSel);
              if (e.target.checked) next.add(t.convId); else next.delete(t.convId);
              setTraceSel(next);
            }}
          />
          <span className="stor__row-label">{t.title ?? t.convId}</span>
          <span className="stor__row-bytes mono">{fmtBytes(t.bytes)}</span>
        </label>
      ))}
      {usage && usage.traces.length === 0 && <div className="stor__empty">暂无调用记录</div>}
    </div>
  </div>
</section>
```

`styles.css` 的存储管理块末尾追加：

```css
.stor__trace-block { display: flex; flex-direction: column; }
.stor__trace-row { display: flex; align-items: center; gap: 10px; padding: 7px 0 7px 14px; border-bottom: 1px solid var(--line); cursor: pointer; }
.stor__empty { font-size: 12px; color: var(--ink-3); padding: 9px 0 7px 14px; }
.stor__row .btn { flex-shrink: 0; }
```

- [ ] **Step 4: 跑测试确认通过 + 编译**

Run: `npx vitest run tests/settings/storage-page.test.tsx && npm run compile`
Expected: PASS + 无类型错误

- [ ] **Step 5: Commit**

```bash
git add components/settings/StoragePage.tsx entrypoints/sidepanel/styles.css tests/settings/storage-page.test.tsx
git commit -m "feat(ui): 存储管理清理区——GM 缓存整清 + trace 按会话勾选，行内二次确认"
```

---

### Task 7: 备份区（导出 + 导入全流程）

**Files:**
- Modify: `components/settings/StoragePage.tsx`（备份区块）
- Modify: `entrypoints/sidepanel/styles.css`（备份区样式）
- Test: `tests/settings/storage-page.test.tsx`（追加 describe）

**Interfaces:**
- Consumes: 消息 `STORAGE_EXPORT`（data: `StorageExportData`）、`STORAGE_IMPORT`（data: `StorageImportResult`）；Task 5 的 `sendStorageRequest`
- Produces: 无（页面收口）

- [ ] **Step 1: 追加失败测试**

`tests/settings/storage-page.test.tsx` 追加：

```tsx
describe('StoragePage 备份区', () => {
  beforeEach(() => {
    // downloads/reload 直赋桩不进 restoreAllMocks 回收链，用完即删防泄漏给后续用例
    delete (browser as unknown as Record<string, unknown>).downloads;
    delete (browser.runtime as unknown as Record<string, unknown>).reload;
  });

  it('导出：勾选不含 Key → 发 STORAGE_EXPORT 且用返回的 filename 下载', async () => {
    const download = vi.fn(async () => 1);
    (browser as unknown as Record<string, unknown>).downloads = { download };
    mockBg({
      STORAGE_USAGE_GET: () => ({ ok: true, data: USAGE }),
      STORAGE_EXPORT: (m) => {
        expect((m as { includeApiKey: boolean }).includeApiKey).toBe(false); // 默认不勾
        return { ok: true, data: { filename: 'vevscript-ai-backup-v1.0.0-20260922.json', dataUrl: 'data:application/json;base64,e30=' } };
      },
    });
    render(<StoragePage onBack={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: '导出全部数据' }));
    await waitFor(() => {
      expect(download).toHaveBeenCalledWith(expect.objectContaining({ filename: 'vevscript-ai-backup-v1.0.0-20260922.json' }));
    });
  });

  it('导入：选文件 → 确认卡 → 发 STORAGE_IMPORT → apiKeyMissing 提示后 reload', async () => {
    const reload = vi.fn();
    (browser.runtime as unknown as { reload: () => void }).reload = reload;
    mockBg({
      STORAGE_USAGE_GET: () => ({ ok: true, data: USAGE }),
      STORAGE_IMPORT: () => ({ ok: true, data: { apiKeyMissing: true } }),
    });
    render(<StoragePage onBack={() => {}} />);
    const input = await screen.findByTestId('stor-import-input') as HTMLInputElement;
    const file = new File(['{"meta":{},"data":{}}'], 'backup.json', { type: 'application/json' });
    await waitFor(() => fireEvent.change(input, { target: { files: [file] } }));
    // 文件异步读入后出确认卡
    fireEvent.click(await screen.findByRole('button', { name: '确认导入' }));
    expect(await screen.findByText(/API Key 未包含/)).toBeTruthy();
    // reload 延迟 1200ms 触发，放宽 waitFor 窗口等真实定时器
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1), { timeout: 3000 });
  });

  it('导入失败：行内报错，不 reload', async () => {
    const reload = vi.fn();
    (browser.runtime as unknown as { reload: () => void }).reload = reload;
    mockBg({
      STORAGE_USAGE_GET: () => ({ ok: true, data: USAGE }),
      STORAGE_IMPORT: () => ({ ok: false, error: '不是本扩展的完整备份文件（缺少有效文件头）' }),
    });
    render(<StoragePage onBack={() => {}} />);
    const input = await screen.findByTestId('stor-import-input') as HTMLInputElement;
    const file = new File(['garbage'], 'backup.json', { type: 'application/json' });
    await waitFor(() => fireEvent.change(input, { target: { files: [file] } }));
    fireEvent.click(await screen.findByRole('button', { name: '确认导入' }));
    expect(await screen.findByText('不是本扩展的完整备份文件（缺少有效文件头）')).toBeTruthy();
    expect(reload).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/settings/storage-page.test.tsx`
Expected: FAIL（找不到「导出全部数据」按钮）

- [ ] **Step 3: 实现备份区**

`StoragePage.tsx` 组件内追加状态与动作：

```tsx
const [includeKey, setIncludeKey] = useState(false);
const [busy, setBusy] = useState<'' | 'export' | 'import'>('');
const [notice, setNotice] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null);
const [pending, setPending] = useState<{ name: string; text: string } | null>(null);

const doExport = async () => {
  setBusy('export'); setNotice(null);
  try {
    const resp = await sendStorageRequest<{ ok: boolean; data?: { filename: string; dataUrl: string }; error?: string }>({
      type: 'STORAGE_EXPORT', includeApiKey: includeKey,
    });
    if (!resp?.ok || !resp.data) throw new Error(resp?.error ?? '导出失败');
    await browser.downloads.download({ url: resp.data.dataUrl, filename: resp.data.filename });
    setNotice({ text: `已导出 ${resp.data.filename}`, kind: 'ok' });
  } catch (e) {
    setNotice({ text: e instanceof Error ? e.message : String(e), kind: 'err' });
  } finally {
    setBusy('');
  }
};

const onPickFile = async (f: File | undefined) => {
  if (!f) return;
  setNotice(null);
  setPending({ name: f.name, text: await f.text() });
};

const doImport = async () => {
  if (!pending) return;
  setBusy('import');
  try {
    const resp = await sendStorageRequest<{ ok: boolean; data?: { apiKeyMissing: boolean }; error?: string }>({
      type: 'STORAGE_IMPORT', payload: pending.text,
    });
    if (!resp?.ok || !resp.data) throw new Error(resp?.error ?? '导入失败');
    setNotice({
      text: resp.data.apiKeyMissing
        ? '导入完成，即将重载（备份未含 API Key，重载后请到模型设置重填）'
        : '导入完成，即将重载',
      kind: 'ok',
    });
    setPending(null);
    setTimeout(() => browser.runtime.reload(), 1200);
  } catch (e) {
    setNotice({ text: e instanceof Error ? e.message : String(e), kind: 'err' });
    setPending(null);
  } finally {
    setBusy('');
  }
};
```

JSX（清理 section 之后）：

```tsx
<section className="section">
  <h2 className="section__title">备份</h2>
  <div className="stor__rows">
    <div className="stor__row">
      <label className="stor__row-label stor__check">
        <input type="checkbox" checked={includeKey} onChange={(e) => setIncludeKey(e.target.checked)} />
        包含模型 API Key（默认不勾，勾选后导出文件含明文密钥，请妥善保管）
      </label>
      <button type="button" className="btn" onClick={() => void doExport()} disabled={busy !== ''}>
        <Download size={14} strokeWidth={1.8} aria-hidden /> {busy === 'export' ? '导出中…' : '导出全部数据'}
      </button>
    </div>
    <div className="stor__row">
      <span className="stor__row-label">导入 = 全量替换当前数据（当前数据会先自动留存到下载目录）</span>
      <input
        data-testid="stor-import-input"
        type="file"
        accept=".json,application/json"
        className="stor__file"
        onChange={(e) => { void onPickFile(e.target.files?.[0]); e.target.value = ''; }}
      />
    </div>
    {pending && (
      <div className="stor__confirm">
        <span>将导入 <span className="mono">{pending.name}</span>：确认后当前数据先留存、再整体替换，完成后自动重载。</span>
        <div className="stor__confirm-actions">
          <button type="button" className="btn btn--danger" onClick={() => void doImport()} disabled={busy !== ''}>
            {busy === 'import' ? '导入中…' : '确认导入'}
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => setPending(null)}>取消</button>
        </div>
      </div>
    )}
    {notice && (
      <div className={`status-text ${notice.kind === 'err' ? 'status-text--err' : 'status-text--ok'}`}>{notice.text}</div>
    )}
  </div>
</section>
```

import 行补 `Download`（lucide-react）。

`styles.css` 追加：

```css
.stor__check { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--ink-2); cursor: pointer; }
.stor__file { max-width: 200px; font-size: 11.5px; color: var(--ink-2); }
.stor__confirm {
  display: flex; flex-direction: column; gap: 8px;
  border: 1px solid var(--line-strong); border-left: 3px solid var(--signal);
  border-radius: 10px; background: var(--surface); padding: 10px 12px; font-size: 12.5px; color: var(--ink-2);
}
.stor__confirm-actions { display: flex; gap: 8px; }
```

- [ ] **Step 4: 跑测试确认通过 + 编译**

Run: `npx vitest run tests/settings/storage-page.test.tsx && npm run compile`
Expected: PASS + 无类型错误

- [ ] **Step 5: Commit**

```bash
git add components/settings/StoragePage.tsx entrypoints/sidepanel/styles.css tests/settings/storage-page.test.tsx
git commit -m "feat(ui): 存储管理备份区——导出含 Key 勾选 + 导入确认卡/结果提示/自动重载"
```

---

### Task 8: 全量验证 + SW 挂线 + 历史记录

**Files:**
- Modify: `entrypoints/background.ts`（initStorageManagerModule 接线）
- Modify: `docs/history.md`（记录本次迭代）
- Test: 全量

**Interfaces:**
- Consumes: Task 1-4 的 `initStorageManagerModule`
- Produces: 可构建、可手测的完整功能

- [ ] **Step 1: background.ts 挂线**

import 行（与其它 init 并列）：

```ts
import { initStorageManagerModule } from '../background/storage-manager';
```

`initSkillsModule(router);` 之后加：

```ts
  initStorageManagerModule(router);
```

- [ ] **Step 2: 全量验证**

Run: `npm run test 2>&1 | tail -5 && npm run compile 2>&1 | tail -3 && npm run build 2>&1 | tail -3`
Expected: 全部测试 PASS（存量用例 + 本计划新增约 35 个）、编译干净、构建成功

- [ ] **Step 3: 手测清单（npm run dev，真机过一遍）**

1. 设置 → 数据 → 存储管理：总览各域字节数与真实数据量级相符。
2. GM 资源缓存清空：二次确认 → 行消失；运行一个带 @require 的脚本可重新预取。
3. Agent 调用记录：与某会话聊一轮后刷新，对应会话 trace 出现并可清理。
4. 导出：默认不含 Key，用文本编辑器打开备份文件确认 `provider.apiKey` 为空串、中文不乱码。
5. 导入：重新导入刚导出的文件 → 数据不变、自动重载；导入一个手改坏 meta 的文件 → 行内报错且数据未动。

- [ ] **Step 4: docs/history.md 记录**

在文件头部迭代记录区追加一节（格式沿用现有条目风格），要点：存储管理页（用量总览 11 域分组 / 清理只给可再生数据 / 备份全量替换语义 + 留存先行 + apiKeyMissing 判定）、键前缀双轨坑（裸 API 物理键 vs WXT 前缀键）、data: URL unicode 方案。并同步更新「当前阶段」的工具计数旁注（无工具数变化则只加存储管理条目）。

- [ ] **Step 5: Commit**

```bash
git add entrypoints/background.ts docs/history.md
git commit -m "feat(storage): 存储管理页收尾——SW 挂线 + 迭代记录"
```

---

## Self-Review 结论

- **Spec 覆盖**：§1 分组（Task 1）/ §2 协议（Task 1）/ §3.1 统计（Task 1）/ §3.2 清理（Task 2）/ §3.3 导出（Task 3）/ §3.4 导入（Task 4）/ §4.1 入口（Task 5）/ §4.2 三区块（Task 5/6/7）/ §5 测试（各任务 + Task 8 全量）/ §6 边界（留存失败中止 = Task 4 测试；残留 trace = Task 1 测试）。无缺口。
- **类型一致性**：`StorageGroupKey`/`StorageUsage`/`StorageCleanScope`/`StorageManagerRequest`/`StorageExportData`/`StorageImportResult` 在 Task 1 定义、Task 2-7 引用同名；`classifyKey`/`cleanStorage`/`buildBackup`/`jsonDataUrl`/`parseBackup`/`importBackup` 签名前后一致；`sendStorageRequest` 在 Task 5 定义、Task 6/7 复用。
- **占位符**：无 TBD/TODO；所有代码步骤含完整代码。
