# GM API 扩充对齐 TM/VM/SC（Tier A+B）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在既有 GM 桥基建上新增 14 个函数型 GM API + 3 个特殊 grant，向 Tampermonkey / Violentmonkey / ScriptCat 对齐。

**Architecture:** 复用 Phase 5 的注册表唯一真源（`shared/gm-apis.ts`）+ wrapper 代码生成（`shared/gm-wrapper.ts`）+ 三事件桥 + SW 分发中心（`background/gm-api.ts`）+ `@connect` 门控 + 确认队列。本地/快照类 API 在 wrapper 加一行 ES5 函数体；桥类 API 走 `__GM_post` 到 SW；敏感能力（cookie/download）复用 `matchConnectWithPermissions` 门控；`window.onurlchange` 经 `webNavigation` 事件下行。

**Tech Stack:** WXT + React 19 + TypeScript 7（Chrome MV3）；vitest v4 + jsdom + `wxt/testing/fake-browser`；ES5 风格 wrapper 字符串拼装。

**规格来源：** `docs/superpowers/specs/2026-09-07-gm-api-expansion-tier-ab-design.md`

**测试命令约定：**
- 单测单文件：`npx vitest run <path>`
- TS 全量检查：`npm run compile`
- 手测脚本构建：`npm run build:manual`

---

### Task 1: 注册表扩充 + manifest 权限 + URL_CHANGE 事件类型

**Files:**
- Modify: `shared/gm-apis.ts`（`GmApiDef` 加 `objectApi?`；`GM_API_REGISTRY` 加 14 条；`SPECIAL_GRANTS` 加 3 个）
- Modify: `shared/gm-bridge.ts:14`（`GmEventKind` 加 `'URL_CHANGE'`）
- Modify: `wxt.config.ts:22`（permissions 加 downloads/cookies/webNavigation）
- Test: `tests/shared/gm-apis.test.ts`（更新 29 键断言 + classifyGrants 示例）

- [ ] **Step 1: 更新注册表单测（会失败）**

改写 `tests/shared/gm-apis.test.ts` 第一个 `it` 的期望数组为 29 键，并把 classifyGrants 里已被支持的 `GM_download` 换成真未知 API：

```typescript
  it('全部 29 个 API 有 impl 分支', () => {
    expect(Object.keys(GM_API_REGISTRY).sort()).toEqual([
      'GM_addElement', 'GM_addStyle', 'GM_addValueChangeListener', 'GM_closeNotification',
      'GM_cookie', 'GM_deleteValue', 'GM_deleteValues', 'GM_download', 'GM_getResourceText',
      'GM_getResourceURL', 'GM_getTab', 'GM_getTabs', 'GM_getValue', 'GM_getValues', 'GM_info',
      'GM_listValues', 'GM_llmChat', 'GM_log', 'GM_notification', 'GM_openInTab',
      'GM_registerMenuCommand', 'GM_removeValueChangeListener', 'GM_saveTab', 'GM_setClipboard',
      'GM_setValue', 'GM_setValues', 'GM_unregisterMenuCommand', 'GM_updateNotification',
      'GM_xmlhttpRequest',
    ]);
  });
```

在 `classifyGrants` 的 describe 内，把 `'GM_download'` 示例改为 `'GM_fakeApi'`（GM_download 现已注册为 supported）：

```typescript
  it('按注册表二分：supported / unsupported', () => {
    const r = classifyGrants(['GM_getValue', 'GM_fakeApi', 'unsafeWindow', 'none']);
    expect(r.supported).toEqual(['GM_getValue', 'unsafeWindow']);
    expect(r.unsupported).toEqual(['GM_fakeApi']);
  });
```

再补一条特殊 grant 断言：

```typescript
  it('新特殊 grant：window.close/focus/onurlchange 归 supported', () => {
    const { supported } = classifyGrants(['window.close', 'window.focus', 'window.onurlchange']);
    expect(supported).toEqual(['window.close', 'window.focus', 'window.onurlchange']);
  });
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run tests/shared/gm-apis.test.ts`
Expected: FAIL（注册表当前 15 键、SPECIAL_GRANTS 无 window.* ）

- [ ] **Step 3: 扩充注册表**

`shared/gm-apis.ts`：`GmApiDef` 加可选字段，`GM_API_REGISTRY` 追加 14 条，`SPECIAL_GRANTS` 加 3 个。

```typescript
export interface GmApiDef {
  impl: GmImpl;
  /** 点形式 GM.xxx 的 Promise 包装（GM_info 的 GM.info 是同引用，非 Promise） */
  promiseForm: boolean;
  /** 对象型 API 的子方法名（仅 GM_cookie）：@grant 一次装齐；点形式 GM.cookie 同引用 */
  objectApi?: string[];
}
```

在 `GM_xmlhttpRequest` 行之后（`GM_llmChat` 之前或之后皆可）追加：

```typescript
  // ---- Tier A（零新权限）----
  GM_removeValueChangeListener: { impl: 'local', promiseForm: true },
  GM_getValues: { impl: 'snapshot', promiseForm: true },
  GM_setValues: { impl: 'bridge', promiseForm: true },
  GM_deleteValues: { impl: 'bridge', promiseForm: true },
  GM_addElement: { impl: 'local', promiseForm: true },
  GM_unregisterMenuCommand: { impl: 'bridge', promiseForm: true },
  GM_getResourceURL: { impl: 'snapshot', promiseForm: true },
  GM_getTab: { impl: 'bridge', promiseForm: true },
  GM_saveTab: { impl: 'bridge', promiseForm: true },
  GM_getTabs: { impl: 'bridge', promiseForm: true },
  GM_closeNotification: { impl: 'bridge', promiseForm: true },
  GM_updateNotification: { impl: 'bridge', promiseForm: true },
  // ---- Tier B（需新权限）----
  GM_download: { impl: 'bridge', promiseForm: true },
  GM_cookie: { impl: 'bridge', promiseForm: false, objectApi: ['list', 'set', 'delete'] },
```

`SPECIAL_GRANTS`：

```typescript
export const SPECIAL_GRANTS = new Set(['unsafeWindow', 'window.close', 'window.focus', 'window.onurlchange']);
```

- [ ] **Step 4: 加 URL_CHANGE 事件类型**

`shared/gm-bridge.ts` 第 14 行的 `GmEventKind` 追加成员：

```typescript
export type GmEventKind = 'VALUE_CHANGE' | 'MENU_CLICK' | 'NOTIF_CLICK' | 'TAB_EVENT' | 'LLM_CHUNK' | 'URL_CHANGE';
```

- [ ] **Step 5: 加 manifest 权限**

`wxt.config.ts` 第 22 行 permissions 数组追加三项：

```typescript
    permissions: ['tabs', 'scripting', 'storage', 'sidePanel', 'webRequest', 'userScripts', 'notifications', 'clipboardWrite', 'offscreen', 'downloads', 'cookies', 'webNavigation'],
```

- [ ] **Step 6: 运行测试验证通过**

Run: `npx vitest run tests/shared/gm-apis.test.ts`
Expected: PASS

- [ ] **Step 7: 全量编译**

Run: `npm run compile`
Expected: 无错误

- [ ] **Step 8: Commit**

```bash
git add shared/gm-apis.ts shared/gm-bridge.ts wxt.config.ts tests/shared/gm-apis.test.ts
git commit -m "feat(gm): 注册表扩 14 API + 3 特殊 grant + URL_CHANGE 事件 + manifest 权限"
```

---

### Task 2: 预取管线支持二进制资源（GM_getResourceURL 数据源）

**Files:**
- Modify: `background/gm-resources.ts`（`CacheEntry` 加 `mime`/`encoding`；`fetchText` 拆文本/二进制；`getResourceBundle` 产 `resourceUrls`）
- Test: `tests/background/gm-resources.test.ts`（补二进制 + resourceUrls 用例）

**背景：** 现 `CacheEntry = {content, fetchedAt}` 只存文本。图片/字体走 base64 才能拼可用的 data: URL。`GM_getResourceText` 仍只对文本资源返回原文。

- [ ] **Step 1: 写失败测试**

在 `tests/background/gm-resources.test.ts` 的 `describe('gm-resources', ...)` 内追加：

```typescript
  it('二进制资源走 base64；getResourceBundle 产 data: URL', async () => {
    const png = new Uint8Array([137, 80, 78, 71]); // PNG 魔数片段
    const fetchMock = vi.fn(async (url: string) => {
      const isImg = url.endsWith('.png');
      return {
        ok: true, status: 200,
        headers: new Map([['content-type', isImg ? 'image/png' : 'text/css']]),
        text: async () => 'body{}',
        arrayBuffer: async () => png.buffer,
      };
    });
    vi.stubGlobal('fetch', fetchMock);
    const s = mkScript({ meta: { resources: { img: 'https://cdn/a.png', style: 'https://cdn/a.css' } } });
    await prefetchResources(s);
    const bundle = await getResourceBundle(s);
    // 文本资源：getResourceText 拿原文
    expect(bundle.resources.style).toBe('body{}');
    // 二进制资源：getResourceText 不返回（undefined），只在 resourceUrls 里
    expect(bundle.resources.img).toBeUndefined();
    expect(bundle.resourceUrls.img).toMatch(/^data:image\/png;base64,/);
    expect(bundle.resourceUrls.style).toMatch(/^data:text\/css/);
    vi.unstubAllGlobals();
  });
```

- [ ] **Step 2: 运行验证失败**

Run: `npx vitest run tests/background/gm-resources.test.ts`
Expected: FAIL（`resourceUrls` 不存在、img 走了 text 路径）

- [ ] **Step 3: 改 CacheEntry + fetch 分流**

`background/gm-resources.ts`：

```typescript
interface CacheEntry {
  content: string;               // encoding=text: 原文；encoding=base64: base64 串
  fetchedAt: number;
  mime?: string;
  encoding?: 'text' | 'base64';  // 旧缓存无此字段 → 惰性视为 'text'
}
type Cache = Record<string, CacheEntry>;

/** content-type 判文本：text/* 或常见文本类 application/*，否则二进制。 */
function isTextContentType(ct: string): boolean {
  return /(^text\/|application\/(json|xml|javascript|x-www-form-urlencoded|ecmascript)|\+json|\+xml|\bcss\b)/i.test(ct);
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}
```

把 `fetchText` 替换为 `fetchResource`（返回 CacheEntry 的内容部分）：

```typescript
async function fetchResource(url: string): Promise<{ content: string; mime: string; encoding: 'text' | 'base64' }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('timeout')), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: ac.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const mime = (resp.headers.get('content-type') ?? '').split(';')[0]!.trim() || 'application/octet-stream';
    if (isTextContentType(mime)) {
      const text = await resp.text();
      if (text.length > MAX_SINGLE) throw new Error(`超过单文件上限（${MAX_SINGLE} 字符）`);
      return { content: text, mime, encoding: 'text' };
    }
    const buf = await resp.arrayBuffer();
    if (buf.byteLength > MAX_SINGLE) throw new Error(`超过单文件上限（${MAX_SINGLE} 字节）`);
    return { content: toBase64(buf), mime, encoding: 'base64' };
  } finally {
    clearTimeout(timer);
  }
}
```

在 `prefetchResources` 里把 `const content = await fetchText(url);` 改为：

```typescript
      const r = await fetchResource(url);
      const content = r.content;
      if (fetched + content.length > MAX_TOTAL) {
        warnings.push(`依赖下载失败：${url}（超过资源总量上限）`);
        continue;
      }
      cache[url] = { content, fetchedAt: now, mime: r.mime, encoding: r.encoding };
      fetched += content.length;
```

- [ ] **Step 4: getResourceBundle 产 resourceUrls**

`getResourceBundle` 返回类型加 `resourceUrls`，`resources` 只收文本编码项：

```typescript
export async function getResourceBundle(script: UserScript): Promise<{ requireCodes: string[]; resources: Record<string, string>; resourceUrls: Record<string, string> }> {
  const cache = await readCache();
  const requires = script.meta?.requires ?? [];
  const resources = script.meta?.resources ?? {};
  const requireCodes: string[] = [];
  for (const url of requires) {
    const hit = cache[url];
    if (hit) requireCodes.push(hit.content); // @require 一律当代码文本（TM 语义）
  }
  const resourceTexts: Record<string, string> = {};
  const resourceUrls: Record<string, string> = {};
  for (const [name, url] of Object.entries(resources)) {
    const hit = cache[url];
    if (!hit) continue;
    const enc = hit.encoding ?? 'text'; // 惰性迁移：旧缓存无字段视为 text
    if (enc === 'text') {
      resourceTexts[name] = hit.content;
      resourceUrls[name] = `data:${hit.mime ?? 'text/plain'};charset=utf-8,${encodeURIComponent(hit.content)}`;
    } else {
      resourceUrls[name] = `data:${hit.mime ?? 'application/octet-stream'};base64,${hit.content}`;
    }
  }
  return { requireCodes, resources: resourceTexts, resourceUrls };
}
```

- [ ] **Step 5: 运行验证通过**

Run: `npx vitest run tests/background/gm-resources.test.ts`
Expected: PASS（含原有 3 用例——注意原用例 fetch mock 无 `arrayBuffer`，但其 content-type 为 `text/javascript`/空，走 text 分支不调 arrayBuffer；空 content-type 归 `application/octet-stream` 二进制分支需 arrayBuffer——见 Step 6 修正）

- [ ] **Step 6: 修原用例的空 content-type**

原用例「7 天内缓存命中不重取」的 fetch mock `headers: new Map()`（无 content-type）会落二进制分支调 `arrayBuffer`（mock 未提供 → 抛错）。给该 mock 补 `arrayBuffer: async () => new ArrayBuffer(0)`，或把 headers 改为 `new Map([['content-type','text/javascript']])`。采用后者（更贴近 @require 是 JS）：

```typescript
    const fetchMock = vi.fn(async (url: string) => ({ ok: true, status: 200, headers: new Map([['content-type', 'text/javascript']]), text: async () => `v1 ${url}` }));
```

同理「失败返回 warning」用例 fetch 返回 `ok:false` 在 `!resp.ok` 就抛错，不触 content-type 分支，无需改。

Run: `npx vitest run tests/background/gm-resources.test.ts`
Expected: PASS（全部用例）

- [ ] **Step 7: 编译**

Run: `npm run compile`
Expected: 无错误（注意：`getResourceBundle` 调用方 `background/scripts.ts` 现只解构 `{requireCodes, resources}`，新增字段可选解构不破坏——Task 12 再接线 resourceUrls）

- [ ] **Step 8: Commit**

```bash
git add background/gm-resources.ts tests/background/gm-resources.test.ts
git commit -m "feat(gm): 预取管线支持二进制资源（base64+mime），getResourceBundle 产 data: URL"
```

---

### Task 3: wrapper 本地/快照类 API（getValues/addElement/removeValueChangeListener/getResourceURL）

**Files:**
- Modify: `shared/gm-wrapper.ts`（`WrapperDeps` 加 `resourceUrls?`；preamble 加 `__resourceUrls` 占位；`GM_INSTALLS` 加 4 行；`buildWrappedCode` 替换 `RESOURCEURLS_PLACEHOLDER`）
- Test: `tests/shared/gm-wrapper.test.ts`（补 4 API 安装断言）

- [ ] **Step 1: 写失败测试**

在 `tests/shared/gm-wrapper.test.ts` 顶层 `describe('buildWrappedCode', ...)` 内追加：

```typescript
  it('本地/快照类 API：getValues/addElement/removeValueChangeListener/getResourceURL', () => {
    const s = mkScript({ meta: { grants: ['GM_getValues', 'GM_addElement', 'GM_removeValueChangeListener', 'GM_getResourceURL'] } });
    const code = buildWrappedCode(s, {
      token: 't', values: { a: 1 }, resources: {}, resourceUrls: { logo: 'data:image/png;base64,AAA' },
      requireCodes: [], extensionVersion: '1.0.0',
    });
    expect(code).toContain('install("GM_getValues"');
    expect(code).toContain('install("GM_addElement"');
    expect(code).toContain('install("GM_removeValueChangeListener"');
    expect(code).toContain('install("GM_getResourceURL"');
    // getResourceURL 数据源：注入时快照 __resourceUrls
    expect(code).toContain('__resourceUrls = {"logo":"data:image/png;base64,AAA"}');
    // 全为 local/snapshot：无 __GM_post（无这些 API 的桥调用）
    expect(code).not.toContain('__GM_post("SetValues"');
  });
```

- [ ] **Step 2: 运行验证失败**

Run: `npx vitest run tests/shared/gm-wrapper.test.ts`
Expected: FAIL

- [ ] **Step 3: WrapperDeps 加 resourceUrls（可选，Task 12 接线真值）**

`shared/gm-wrapper.ts` 的 `WrapperDeps` 接口加字段：

```typescript
export interface WrapperDeps {
  token: string;
  values: Record<string, unknown>;
  resources: Record<string, string>;
  /** @resource 的 data: URL 快照（GM_getResourceURL 零 RPC 数据源）；可选，缺省 {} */
  resourceUrls?: Record<string, string>;
  requireCodes: string[];
  extensionVersion: string;
}
```

- [ ] **Step 4: preamble 加 __resourceUrls 占位**

在 preamble 里 `var __resources = RESOURCES_PLACEHOLDER;` 之后加一行：

```typescript
  var __resourceUrls = RESOURCEURLS_PLACEHOLDER;
```

- [ ] **Step 5: GM_INSTALLS 加 4 行**

在 `GM_INSTALLS` 数组内（`GM_getResourceText` 附近逻辑相关处）追加：

```typescript
  ['GM_getValues', 'function (keys) { var out = {}; if (Array.isArray(keys)) { for (var i = 0; i < keys.length; i++) { var k = keys[i]; out[k] = __values[k]; } } else if (keys && typeof keys === "object") { for (var k2 in keys) { if (Object.prototype.hasOwnProperty.call(keys, k2)) { out[k2] = __values[k2] === undefined ? keys[k2] : __values[k2]; } } } else { for (var k3 in __values) { if (Object.prototype.hasOwnProperty.call(__values, k3)) out[k3] = __values[k3]; } } return out; }'],
  ['GM_removeValueChangeListener', 'function (id) { var i = String(id).lastIndexOf(":"); if (i < 0) return; var key = String(id).slice(0, i); var idx = parseInt(String(id).slice(i + 1), 10); var arr = __GM_valueHooks.get(key); if (arr && arr[idx]) arr[idx] = null; }'],
  ['GM_addElement', 'function (a, b, c) { var parent, tag, attrs; if (typeof a === "string") { parent = null; tag = a; attrs = b || {}; } else { parent = a; tag = b; attrs = c || {}; } var el = document.createElement(tag); for (var k in attrs) { if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue; if (k === "textContent") el.textContent = attrs[k]; else if (k === "innerHTML") el.innerHTML = attrs[k]; else el.setAttribute(k, attrs[k]); } (parent || document.head || document.documentElement).appendChild(el); return el; }'],
  ['GM_getResourceURL', 'function (name) { return __resourceUrls[name]; }'],
```

> 注：`GM_removeValueChangeListener` 置 `null` 而非删除，保持后续 idx 稳定（`GM_addValueChangeListener` 返回 `key:idx`，idx 是数组下标）。对应地，`GM_addValueChangeListener` 的 wrapper 事件分发处 `hooks.forEach(fn => fn(...))` 需容忍 null——见 Step 6。

- [ ] **Step 6: 值变更分发容忍 null 槽**

preamble 里 VALUE_CHANGE 分支现为 `if (hooks) hooks.forEach(function (fn) { fn(...); });`。改为跳过 null：

```typescript
    if (d.kind === 'VALUE_CHANGE') {
      var hooks = __GM_valueHooks.get(d.data.key);
      if (hooks) hooks.forEach(function (fn) { if (fn) fn(d.data.key, d.data.oldValue, d.data.newValue, d.data.remote); });
    } else if (d.kind === 'MENU_CLICK') {
```

- [ ] **Step 7: buildWrappedCode 替换新占位**

在 `buildWrappedCode` 的 `head` 链式 `.replace(...)` 里追加一段（在 `RESOURCES_PLACEHOLDER` 之后）：

```typescript
    .replace('RESOURCEURLS_PLACEHOLDER', () => J(deps.resourceUrls ?? {}))
```

- [ ] **Step 8: 运行验证通过**

Run: `npx vitest run tests/shared/gm-wrapper.test.ts`
Expected: PASS（含原有全部用例——原用例不传 resourceUrls，`?? {}` 兜底为 `{}`，占位替换为 `{}`，不影响既有断言）

- [ ] **Step 9: 编译**

Run: `npm run compile`
Expected: 无错误

- [ ] **Step 10: Commit**

```bash
git add shared/gm-wrapper.ts tests/shared/gm-wrapper.test.ts
git commit -m "feat(gm): wrapper 本地/快照类 API（getValues/addElement/removeValueChangeListener/getResourceURL）"
```

---

### Task 4: wrapper 桥类 API（批量值/菜单注销/通知管理/getTab 系/download）

**Files:**
- Modify: `shared/gm-wrapper.ts`（`GM_INSTALLS` 加 8 行）
- Test: `tests/shared/gm-wrapper.test.ts`

- [ ] **Step 1: 写失败测试**

追加到 `describe('buildWrappedCode', ...)`：

```typescript
  it('桥类 API：setValues/deleteValues/unregisterMenu/通知管理/getTab 系/download', () => {
    const s = mkScript({ meta: { grants: [
      'GM_setValues', 'GM_deleteValues', 'GM_unregisterMenuCommand',
      'GM_closeNotification', 'GM_updateNotification', 'GM_getTab', 'GM_saveTab', 'GM_getTabs', 'GM_download',
    ] } });
    const code = buildWrappedCode(s, { token: 't', values: {}, resources: {}, requireCodes: [], extensionVersion: '1.0.0' });
    expect(code).toContain('__GM_post("SetValues"');
    expect(code).toContain('__GM_post("DeleteValues"');
    expect(code).toContain('__GM_post("UnregisterMenu"');
    expect(code).toContain('__GM_post("CloseNotification"');
    expect(code).toContain('__GM_post("UpdateNotification"');
    expect(code).toContain('__GM_post("GetTab"');
    expect(code).toContain('__GM_post("SaveTab"');
    expect(code).toContain('__GM_post("GetTabs"');
    // download：url/details 双签名归一化 + onload/onerror 留闭包（过桥用 __GM_plain）
    expect(code).toContain('__GM_post("Download"');
    expect(code).toContain('typeof arg === "string"');
  });
```

- [ ] **Step 2: 运行验证失败**

Run: `npx vitest run tests/shared/gm-wrapper.test.ts`
Expected: FAIL

- [ ] **Step 3: GM_INSTALLS 加 8 行**

在 `GM_INSTALLS` 数组追加（batch 值 API 同步更新本地 `__values` 快照，与 `GM_setValue` 一致）：

```typescript
  ['GM_setValues', 'function (obj) { if (obj && typeof obj === "object") { for (var k in obj) { if (Object.prototype.hasOwnProperty.call(obj, k)) __values[k] = obj[k]; } } return __GM_post("SetValues", [__GM_plain(obj)]); }'],
  ['GM_deleteValues', 'function (keys) { if (Array.isArray(keys)) { for (var i = 0; i < keys.length; i++) delete __values[keys[i]]; } return __GM_post("DeleteValues", [keys]); }'],
  ['GM_unregisterMenuCommand', 'function (key) { __GM_listeners.delete("menu:" + key); return __GM_post("UnregisterMenu", [key]); }'],
  ['GM_closeNotification', 'function (id) { return __GM_post("CloseNotification", [id]); }'],
  ['GM_updateNotification', 'function (id, details) { return __GM_post("UpdateNotification", [id, __GM_plain(details)]); }'],
  ['GM_getTab', 'function (cb) { var p = __GM_post("GetTab", []); if (typeof cb === "function") p.then(cb); return p; }'],
  ['GM_saveTab', 'function (data) { return __GM_post("SaveTab", [__GM_plain(data)]); }'],
  ['GM_getTabs', 'function (cb) { var p = __GM_post("GetTabs", []); if (typeof cb === "function") p.then(cb); return p; }'],
  ['GM_download', 'function (arg, name) { var details = typeof arg === "string" ? { url: arg, name: name } : (arg || {}); var d = __GM_plain(details); __GM_post("Download", [d]).then(function (r) { if (r && r.error) { details.onerror && details.onerror(r); } else { details.onload && details.onload(r); } }, function (e) { details.onerror && details.onerror({ error: String(e) }); }); return { abort: function () {} }; }'],
```

- [ ] **Step 4: 运行验证通过**

Run: `npx vitest run tests/shared/gm-wrapper.test.ts`
Expected: PASS

- [ ] **Step 5: 编译**

Run: `npm run compile`
Expected: 无错误

- [ ] **Step 6: Commit**

```bash
git add shared/gm-wrapper.ts tests/shared/gm-wrapper.test.ts
git commit -m "feat(gm): wrapper 桥类 API（批量值/菜单注销/通知管理/getTab 系/download）"
```

---

### Task 5: wrapper 对象型 API（GM_cookie.list/set/delete）

**Files:**
- Modify: `shared/gm-wrapper.ts`（`GM_INSTALLS` 加 GM_cookie 对象字面量；`emit` 支持 objectApi）
- Test: `tests/shared/gm-wrapper.test.ts`

**背景：** `install(name, fn)` 现只处理函数值。`GM_cookie` 是 `{list,set,delete}` 对象，点形式 `GM.cookie` 同引用（不包 Promise——三方法本身已返回 Promise）。

- [ ] **Step 1: 写失败测试**

追加到 `describe('buildWrappedCode', ...)`：

```typescript
  it('对象型 GM_cookie：@grant 一次装齐三方法，GM.cookie 同引用（非 Promise 包装）', () => {
    const s = mkScript({ meta: { grants: ['GM_cookie'] } });
    const code = buildWrappedCode(s, { token: 't', values: {}, resources: {}, requireCodes: [], extensionVersion: '1.0.0' });
    expect(code).toContain('install("GM_cookie"');
    expect(code).toContain('__GM_post("CookieList"');
    expect(code).toContain('__GM_post("CookieSet"');
    expect(code).toContain('__GM_post("CookieDelete"');
    // 点形式同引用（对象），不生成通用 Promise 包装函数
    expect(code).toContain('GM.cookie = GM_cookie;');
    expect(code).not.toContain('install("GM.cookie", function ()');
  });
```

- [ ] **Step 2: 运行验证失败**

Run: `npx vitest run tests/shared/gm-wrapper.test.ts`
Expected: FAIL

- [ ] **Step 3: GM_INSTALLS 加 GM_cookie 对象字面量**

在 `GM_INSTALLS` 追加（`delete` 键加引号避免 ES5 保留字歧义）：

```typescript
  ['GM_cookie', '{ list: function (d) { return __GM_post("CookieList", [__GM_plain(d)]); }, set: function (d) { return __GM_post("CookieSet", [__GM_plain(d)]); }, "delete": function (d) { return __GM_post("CookieDelete", [__GM_plain(d)]); } }'],
```

- [ ] **Step 4: emit 支持 objectApi**

在 `installLines` 内的 `emit` 函数里，把 promiseForm 分支改为 objectApi 优先的 if/else：

```typescript
  const emit = (name: string, syncExpr: string) => {
    lines.push(`  ${name} = install(${J(name)}, ${syncExpr});`);
    vars.push(name);
    const def = GM_API_REGISTRY[name];
    if (def?.objectApi) {
      // 对象型：点形式同引用（GM.cookie = GM_cookie），三方法本身已返回 Promise
      const dot = name.replace(/^GM_/, 'GM.');
      lines.push(`  ${dot} = ${name};`);
    } else if (def?.promiseForm) {
      const dot = name.replace(/^GM_/, 'GM.');
      lines.push(`  install(${J(dot)}, function () { var a = [].slice.call(arguments); var r = GM[${J(name)}].apply(null, a); return r && typeof r.then === 'function' ? r : Promise.resolve(r); });`);
    }
  };
```

- [ ] **Step 5: 运行验证通过**

Run: `npx vitest run tests/shared/gm-wrapper.test.ts`
Expected: PASS

- [ ] **Step 6: 编译**

Run: `npm run compile`
Expected: 无错误

- [ ] **Step 7: Commit**

```bash
git add shared/gm-wrapper.ts tests/shared/gm-wrapper.test.ts
git commit -m "feat(gm): wrapper 对象型 GM_cookie（三方法 + GM.cookie 同引用）"
```

---

### Task 6: wrapper 特殊 grant（window.close/focus/onurlchange + URL_CHANGE 分发）

**Files:**
- Modify: `shared/gm-wrapper.ts`（preamble gmevt 加 URL_CHANGE 分支；新增 `specialGrantLines`；`buildWrappedCode` 插入该段）
- Test: `tests/shared/gm-wrapper.test.ts`

**背景：** 特殊 grant 不在 `GM_API_REGISTRY`（不进 `GM_INSTALLS`），改的是 `unsafeWindow` 而非 GM 对象。它们仍属 realGrants（≠'none'），故 `buildWrappedCode` 不会短路成裸 code。

- [ ] **Step 1: 写失败测试**

追加到 `describe('buildWrappedCode', ...)`：

```typescript
  it('特殊 grant：window.close/focus 覆写 unsafeWindow，onurlchange 占位 + URL_CHANGE 分发', () => {
    const s = mkScript({ meta: { grants: ['window.close', 'window.focus', 'window.onurlchange'] } });
    const code = buildWrappedCode(s, { token: 't', values: {}, resources: {}, requireCodes: [], extensionVersion: '1.0.0' });
    expect(code).toContain('unsafeWindow.close = function () { __GM_post("WindowClose", []); };');
    expect(code).toContain('unsafeWindow.focus = function () { __GM_post("WindowFocus", []); };');
    expect(code).toContain('unsafeWindow.onurlchange = null;');
    // URL_CHANGE 分支在 preamble（始终存在，未 grant 则 SW 不下行）
    expect(code).toContain("d.kind === 'URL_CHANGE'");
    expect(code).toContain("new CustomEvent('urlchange'");
  });

  it('未 grant 特殊项：不覆写 unsafeWindow.close/focus/onurlchange', () => {
    const code = buildWrappedCode(mkScript(), { token: 't', values: {}, resources: {}, requireCodes: [], extensionVersion: '1.0.0' });
    expect(code).not.toContain('unsafeWindow.close = function');
    expect(code).not.toContain('unsafeWindow.onurlchange = null;');
  });
```

- [ ] **Step 2: 运行验证失败**

Run: `npx vitest run tests/shared/gm-wrapper.test.ts`
Expected: FAIL

- [ ] **Step 3: preamble 加 URL_CHANGE 分发分支**

在 preamble 的 gmevt 监听器 `LLM_CHUNK` 分支之后追加：

```typescript
    } else if (d.kind === 'LLM_CHUNK') {
      var lc = __GM_listeners.get('llmchan:' + d.data.chan);
      if (lc) lc(d.data.delta);
    } else if (d.kind === 'URL_CHANGE') {
      try { if (typeof unsafeWindow.onurlchange === 'function') unsafeWindow.onurlchange({ url: d.data.url }); } catch (e) { /* 回调异常不阻断 */ }
      try { unsafeWindow.dispatchEvent(new CustomEvent('urlchange', { detail: { url: d.data.url } })); } catch (e) { /* ignore */ }
    }
```

- [ ] **Step 4: 新增 specialGrantLines 函数**

在 `installLines` 函数附近新增：

```typescript
/** 特殊 grant（window.close/focus/onurlchange）：改 unsafeWindow 而非 GM 对象，按 grant 条件 emit。 */
function specialGrantLines(script: UserScript): string {
  const grants = script.meta?.grants ?? [];
  const lines: string[] = [];
  if (grants.includes('window.close')) lines.push('  unsafeWindow.close = function () { __GM_post("WindowClose", []); };');
  if (grants.includes('window.focus')) lines.push('  unsafeWindow.focus = function () { __GM_post("WindowFocus", []); };');
  if (grants.includes('window.onurlchange')) lines.push('  unsafeWindow.onurlchange = null;');
  return lines.join('\n');
}
```

- [ ] **Step 5: buildWrappedCode 插入特殊 grant 段**

在 `buildWrappedCode` 的最终拼装处，把 `installs` 段与 `specialGrantLines` 合并。找到：

```typescript
  const { code: installs, vars } = installLines(script);
```

在其后加：

```typescript
  const specials = specialGrantLines(script);
```

并把末尾 `return [head, varDecl, installs + '\n', tail].join('\n');` 改为：

```typescript
  return [head, varDecl, installs + '\n', specials + '\n', tail].join('\n');
```

- [ ] **Step 6: 运行验证通过**

Run: `npx vitest run tests/shared/gm-wrapper.test.ts`
Expected: PASS（全部用例）

- [ ] **Step 7: 编译**

Run: `npm run compile`
Expected: 无错误

- [ ] **Step 8: Commit**

```bash
git add shared/gm-wrapper.ts tests/shared/gm-wrapper.test.ts
git commit -m "feat(gm): wrapper 特殊 grant（window.close/focus/onurlchange）+ URL_CHANGE 分发"
```

---

### Task 7: SW 批量值 + 菜单注销 + 通知管理

**Files:**
- Modify: `background/gm-api.ts`（`API_TO_GRANT` 加映射；`GRANT_EXEMPT` 加批量值；`handleGmCall` switch 加 5 case）
- Test: `tests/background/gm-api.test.ts`

- [ ] **Step 1: 写失败测试**

在 `tests/background/gm-api.test.ts` 追加（复用文件顶部现有 `mkScript`/imports；若无 `readValuesForSnapshot`/`getMenuSnapshot` import 则补）：

```typescript
import { handleGmCall, readValuesForSnapshot, getMenuSnapshot } from '../../background/gm-api';

describe('批量值 + 菜单注销 + 通知管理', () => {
  beforeEach(() => { fakeBrowser.reset(); vi.restoreAllMocks(); });

  it('SetValues 批量写；DeleteValues 批量删', async () => {
    await saveScript(mkScript({ meta: { grants: ['GM_setValues', 'GM_deleteValues'] } }));
    await handleGmCall({ scriptId: 's1', api: 'SetValues', reqId: 1, params: [{ a: 1, b: 2, c: 3 }] }, { tab: { id: 1, url: 'https://a.com/' } } as never);
    expect(await readValuesForSnapshot('s1')).toEqual({ a: 1, b: 2, c: 3 });
    await handleGmCall({ scriptId: 's1', api: 'DeleteValues', reqId: 2, params: [['a', 'c']] }, { tab: { id: 1, url: 'https://a.com/' } } as never);
    expect(await readValuesForSnapshot('s1')).toEqual({ b: 2 });
  });

  it('UnregisterMenu 从菜单表移除', async () => {
    await saveScript(mkScript({ meta: { grants: ['GM_registerMenuCommand', 'GM_unregisterMenuCommand'] } }));
    await handleGmCall({ scriptId: 's1', api: 'RegisterMenu', reqId: 1, params: ['k1', '命令一'] }, { tab: { id: 9, url: 'https://a.com/' } } as never);
    expect(getMenuSnapshot().find((e) => e.scriptId === 's1')?.commands).toEqual([{ key: 'k1', name: '命令一' }]);
    await handleGmCall({ scriptId: 's1', api: 'UnregisterMenu', reqId: 2, params: ['k1'] }, { tab: { id: 9, url: 'https://a.com/' } } as never);
    expect(getMenuSnapshot().find((e) => e.scriptId === 's1')).toBeUndefined();
  });

  it('CloseNotification/UpdateNotification 调 notifications API', async () => {
    await saveScript(mkScript({ meta: { grants: ['GM_closeNotification', 'GM_updateNotification'] } }));
    const clear = vi.fn(async () => true);
    const update = vi.fn(async () => true);
    (browser as unknown as { notifications: Record<string, unknown> }).notifications = { clear, update };
    await handleGmCall({ scriptId: 's1', api: 'CloseNotification', reqId: 1, params: ['n1'] }, { tab: { id: 1, url: 'https://a.com/' } } as never);
    expect(clear).toHaveBeenCalledWith('n1');
    await handleGmCall({ scriptId: 's1', api: 'UpdateNotification', reqId: 2, params: ['n1', { title: 'T', text: 'X' }] }, { tab: { id: 1, url: 'https://a.com/' } } as never);
    expect(update).toHaveBeenCalledWith('n1', expect.objectContaining({ title: 'T', message: 'X' }));
  });
});
```

- [ ] **Step 2: 运行验证失败**

Run: `npx vitest run tests/background/gm-api.test.ts`
Expected: FAIL（switch 无这些 case → 「未知 GM API」）

- [ ] **Step 3: API_TO_GRANT + GRANT_EXEMPT**

`background/gm-api.ts` 的 `API_TO_GRANT` 对象追加：

```typescript
  SetValues: 'GM_setValues',
  DeleteValues: 'GM_deleteValues',
  UnregisterMenu: 'GM_unregisterMenuCommand',
  CloseNotification: 'GM_closeNotification',
  UpdateNotification: 'GM_updateNotification',
  GetTab: 'GM_getTab',
  SaveTab: 'GM_saveTab',
  GetTabs: 'GM_getTabs',
  Download: 'GM_download',
  CookieList: 'GM_cookie',
  CookieSet: 'GM_cookie',
  CookieDelete: 'GM_cookie',
  WindowClose: 'window.close',
  WindowFocus: 'window.focus',
```

`GRANT_EXEMPT` 加批量值读（与单值一致，grant 已在 wrapper 安装期把关）：

```typescript
const GRANT_EXEMPT = new Set(['ReportError', 'SetValue', 'GetValue', 'DeleteValue', 'ListValues', 'SetValues', 'DeleteValues', 'GetValues']);
```

- [ ] **Step 4: switch 加 5 case**

在 `handleGmCall` switch 内追加（`ListValues` case 之后）：

```typescript
    case 'SetValues': {
      const [obj] = params as [Record<string, unknown>];
      const values = await readValues(scriptId);
      const entries = obj && typeof obj === 'object' ? Object.entries(obj) : [];
      for (const [key, value] of entries) {
        const oldValue = values[key];
        values[key] = value;
        await broadcastValueChange(scriptId, key, oldValue, value, sender);
      }
      await writeValues(scriptId, values);
      return { ok: true, data: null };
    }
    case 'DeleteValues': {
      const [keys] = params as [string[]];
      const values = await readValues(scriptId);
      for (const key of Array.isArray(keys) ? keys : []) {
        const oldValue = values[key];
        delete values[key];
        await broadcastValueChange(scriptId, key, oldValue, undefined, sender);
      }
      await writeValues(scriptId, values);
      return { ok: true, data: null };
    }
    case 'UnregisterMenu': {
      const [key] = params as [string];
      const cmds = menuTable.get(scriptId);
      if (cmds) { cmds.delete(key); if (cmds.size === 0) menuTable.delete(scriptId); }
      broadcastMenus();
      return { ok: true, data: null };
    }
    case 'CloseNotification': {
      const [id] = params as [string];
      try { await browser.notifications?.clear(id); return { ok: true, data: null }; }
      catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
    }
    case 'UpdateNotification': {
      const [id, details] = params as [string, { title?: string; text?: string }];
      try {
        await browser.notifications?.update(id, { type: 'basic', iconUrl: NOTIF_ICON, title: details?.title ?? scriptId, message: details?.text ?? '' });
        return { ok: true, data: null };
      } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
    }
```

- [ ] **Step 5: 运行验证通过**

Run: `npx vitest run tests/background/gm-api.test.ts`
Expected: PASS

- [ ] **Step 6: 编译**

Run: `npm run compile`
Expected: 无错误

- [ ] **Step 7: Commit**

```bash
git add background/gm-api.ts tests/background/gm-api.test.ts
git commit -m "feat(gm): SW 批量值（SetValues/DeleteValues）+ 菜单注销 + 通知管理"
```

---

### Task 8: SW per-tab 存储子系统（GM_getTab/saveTab/getTabs）

**Files:**
- Create: `background/gm-tab-store.ts`
- Modify: `background/gm-api.ts`（`handleGmCall` 加 3 case；`cleanupScriptState` 调 `cleanupTabData`）
- Test: `tests/background/gm-tab-store.test.ts`

- [ ] **Step 1: 写失败测试（模块）**

Create `tests/background/gm-tab-store.test.ts`：

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { getTabData, saveTabData, getAllTabData, cleanupTabData } from '../../background/gm-tab-store';

describe('gm-tab-store', () => {
  beforeEach(() => fakeBrowser.reset());

  it('getTab 首次空对象；saveTab 后读回', async () => {
    expect(await getTabData('s1', 9)).toEqual({});
    await saveTabData('s1', 9, { count: 3 });
    expect(await getTabData('s1', 9)).toEqual({ count: 3 });
  });

  it('getTabs 聚合按 tabId', async () => {
    await saveTabData('s1', 9, { a: 1 });
    await saveTabData('s1', 10, { b: 2 });
    await saveTabData('s2', 9, { c: 3 }); // 别的脚本不混入
    expect(await getAllTabData('s1')).toEqual({ '9': { a: 1 }, '10': { b: 2 } });
  });

  it('cleanup 清该脚本全部 tab 数据', async () => {
    await saveTabData('s1', 9, { a: 1 });
    await saveTabData('s1', 10, { b: 2 });
    await cleanupTabData('s1');
    expect(await getAllTabData('s1')).toEqual({});
  });
});
```

- [ ] **Step 2: 运行验证失败**

Run: `npx vitest run tests/background/gm-tab-store.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 建模块**

Create `background/gm-tab-store.ts`：

```typescript
// background/gm-tab-store.ts
// GM_getTab/saveTab/getTabs 的 per-tab 临时存储（spec §5.1）。
// 键 gm-tab:{scriptId}:{tabId} 存 chrome.storage.session——tab/浏览器关闭随会话失效，
// 符合 GM_getTab「本 tab 临时数据」语义，不做持久化。用 browser.storage.session 裸键
// （非 WXT storage）因需按前缀枚举（getTabs）。

const PREFIX = 'gm-tab:';
const keyFor = (scriptId: string, tabId: number): string => `${PREFIX}${scriptId}:${tabId}`;

type TabData = Record<string, unknown>;

export async function getTabData(scriptId: string, tabId: number): Promise<TabData> {
  const k = keyFor(scriptId, tabId);
  const got = await browser.storage.session.get(k);
  return (got[k] as TabData) ?? {};
}

export async function saveTabData(scriptId: string, tabId: number, data: TabData): Promise<void> {
  await browser.storage.session.set({ [keyFor(scriptId, tabId)]: data });
}

/** 该脚本全部 tab 的数据：{ [tabId]: data }（对齐 TM GM_getTabs 回调形状）。 */
export async function getAllTabData(scriptId: string): Promise<Record<string, TabData>> {
  const all = await browser.storage.session.get();
  const prefix = `${PREFIX}${scriptId}:`;
  const out: Record<string, TabData> = {};
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v as TabData;
  }
  return out;
}

/** 脚本删除时清该脚本全部 tab 数据（gm-api.cleanupScriptState 调用）。 */
export async function cleanupTabData(scriptId: string): Promise<void> {
  const all = await browser.storage.session.get();
  const prefix = `${PREFIX}${scriptId}:`;
  const keys = Object.keys(all).filter((k) => k.startsWith(prefix));
  if (keys.length > 0) await browser.storage.session.remove(keys);
}
```

- [ ] **Step 4: 运行验证通过（模块）**

Run: `npx vitest run tests/background/gm-tab-store.test.ts`
Expected: PASS

- [ ] **Step 5: 写 handleGmCall 接线测试**

在 `tests/background/gm-api.test.ts` 的批量值 describe 内追加：

```typescript
  it('GetTab/SaveTab/GetTabs 经 handleGmCall 往返', async () => {
    await saveScript(mkScript({ meta: { grants: ['GM_getTab', 'GM_saveTab', 'GM_getTabs'] } }));
    const sender = { tab: { id: 7, url: 'https://a.com/' } } as never;
    expect((await handleGmCall({ scriptId: 's1', api: 'GetTab', reqId: 1, params: [] }, sender) as { data: unknown }).data).toEqual({});
    await handleGmCall({ scriptId: 's1', api: 'SaveTab', reqId: 2, params: [{ hits: 5 }] }, sender);
    expect((await handleGmCall({ scriptId: 's1', api: 'GetTab', reqId: 3, params: [] }, sender) as { data: unknown }).data).toEqual({ hits: 5 });
    expect((await handleGmCall({ scriptId: 's1', api: 'GetTabs', reqId: 4, params: [] }, sender) as { data: unknown }).data).toEqual({ '7': { hits: 5 } });
  });
```

- [ ] **Step 6: 运行验证失败**

Run: `npx vitest run tests/background/gm-api.test.ts`
Expected: FAIL（switch 无 GetTab 等）

- [ ] **Step 7: 接线 handleGmCall + cleanup**

`background/gm-api.ts` 顶部 import：

```typescript
import { getTabData, saveTabData, getAllTabData, cleanupTabData } from './gm-tab-store';
```

`handleGmCall` switch 追加：

```typescript
    case 'GetTab': {
      const tabId = sender?.tab?.id;
      if (tabId == null) return { ok: false, error: 'GetTab 缺少 tab 上下文' };
      return { ok: true, data: await getTabData(scriptId, tabId) };
    }
    case 'SaveTab': {
      const tabId = sender?.tab?.id;
      if (tabId == null) return { ok: false, error: 'SaveTab 缺少 tab 上下文' };
      await saveTabData(scriptId, tabId, (params[0] ?? {}) as Record<string, unknown>);
      return { ok: true, data: null };
    }
    case 'GetTabs':
      return { ok: true, data: await getAllTabData(scriptId) };
```

`cleanupScriptState` 函数体加一行（现有 `await storage.removeItem(valuesKey(scriptId));` 之后）：

```typescript
  await cleanupTabData(scriptId);
```

- [ ] **Step 8: 运行验证通过**

Run: `npx vitest run tests/background/gm-api.test.ts tests/background/gm-tab-store.test.ts`
Expected: PASS

- [ ] **Step 9: 编译 + Commit**

```bash
npm run compile
git add background/gm-tab-store.ts background/gm-api.ts tests/background/gm-tab-store.test.ts tests/background/gm-api.test.ts
git commit -m "feat(gm): SW per-tab 存储（GM_getTab/saveTab/getTabs）"
```

---

### Task 9: SW cookie（GM_cookie.list/set/delete，@connect 门控）

**Files:**
- Create: `background/gm-cookie.ts`（纯 chrome.cookies 封装 + 目标 URL 推导）
- Modify: `background/gm-api.ts`（`doCookie` 门控 + switch 3 case）
- Test: `tests/background/gm-cookie.test.ts`

**架构：** gm-cookie.ts 只封装 chrome.cookies（无门控，避免与 gm-api 循环依赖）；门控（matchConnectWithPermissions + 确认卡）留在 gm-api.ts 的 `doCookie`，复用 XHR 同款流程。

- [ ] **Step 1: 写失败测试（模块）**

Create `tests/background/gm-cookie.test.ts`：

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { listCookies, setCookie, deleteCookie, cookieTargetUrl } from '../../background/gm-cookie';

describe('gm-cookie 封装', () => {
  beforeEach(() => { fakeBrowser.reset(); vi.restoreAllMocks(); });

  it('cookieTargetUrl：url 优先，其次 domain 构造 https', () => {
    expect(cookieTargetUrl({ url: 'https://a.com/x' })).toBe('https://a.com/x');
    expect(cookieTargetUrl({ domain: '.a.com' })).toBe('https://a.com/');
    expect(cookieTargetUrl({})).toBe('');
  });

  it('list/set/delete 透传 chrome.cookies', async () => {
    const getAll = vi.fn(async () => [{ name: 'k', value: 'v', domain: 'a.com' }]);
    const set = vi.fn(async () => ({}));
    const remove = vi.fn(async () => ({}));
    (browser as unknown as { cookies: Record<string, unknown> }).cookies = { getAll, set, remove };
    expect(await listCookies({ url: 'https://a.com/' })).toEqual([{ name: 'k', value: 'v', domain: 'a.com' }]);
    await setCookie({ url: 'https://a.com/', name: 'k', value: 'v' });
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://a.com/', name: 'k', value: 'v' }));
    await deleteCookie({ url: 'https://a.com/', name: 'k' });
    expect(remove).toHaveBeenCalledWith({ url: 'https://a.com/', name: 'k' });
  });
});
```

- [ ] **Step 2: 运行验证失败**

Run: `npx vitest run tests/background/gm-cookie.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 建模块**

Create `background/gm-cookie.ts`：

```typescript
// background/gm-cookie.ts
// GM_cookie.list/set/delete 的 chrome.cookies 薄封装（spec §5.2）。
// 门控（@connect + 确认卡）在 background/gm-api.ts 的 doCookie——本模块只做 API 透传。

export interface CookieDetails {
  url?: string;
  domain?: string;
  name?: string;
  path?: string;
  value?: string;
  expirationDate?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'no_restriction' | 'lax' | 'strict';
}

type CookiesApi = {
  getAll(d: Record<string, unknown>): Promise<unknown[]>;
  set(d: Record<string, unknown>): Promise<unknown>;
  remove(d: Record<string, unknown>): Promise<unknown>;
};

function api(): CookiesApi {
  const c = (browser as unknown as { cookies?: CookiesApi }).cookies;
  if (!c) throw new Error('cookies API 不可用（需 manifest cookies 权限）');
  return c;
}

/** 门控用的目标 URL：url 优先，否则由 domain 构造 https（去前导点）。 */
export function cookieTargetUrl(d: CookieDetails): string {
  if (d.url) return d.url;
  if (d.domain) return `https://${d.domain.replace(/^\./, '')}/`;
  return '';
}

export async function listCookies(d: CookieDetails): Promise<unknown[]> {
  const query: Record<string, unknown> = {};
  if (d.url) query.url = d.url;
  if (d.domain) query.domain = d.domain;
  if (d.name) query.name = d.name;
  if (d.path) query.path = d.path;
  return api().getAll(query);
}

export async function setCookie(d: CookieDetails): Promise<void> {
  const set: Record<string, unknown> = { url: cookieTargetUrl(d), name: d.name, value: d.value };
  if (d.path) set.path = d.path;
  if (d.expirationDate) set.expirationDate = d.expirationDate;
  if (d.httpOnly != null) set.httpOnly = d.httpOnly;
  if (d.secure != null) set.secure = d.secure;
  if (d.sameSite) set.sameSite = d.sameSite;
  await api().set(set);
}

export async function deleteCookie(d: CookieDetails): Promise<void> {
  await api().remove({ url: cookieTargetUrl(d), name: d.name });
}
```

- [ ] **Step 4: 运行验证通过（模块）**

Run: `npx vitest run tests/background/gm-cookie.test.ts`
Expected: PASS

- [ ] **Step 5: 写门控接线测试**

在 `tests/background/gm-cookie.test.ts` 追加（走 handleGmCall + 确认队列，仿 gm-connect.test.ts）：

```typescript
import { handleGmCall } from '../../background/gm-api';
import { resolveConfirm, getPending, __resetConfirmQueue } from '../../background/confirm-queue';
import { saveScript } from '../../storage/scripts';
import type { UserScript } from '../../shared/types';

function mkScript(over: Partial<UserScript> = {}): UserScript {
  return {
    id: 's1', text: '', name: 't', enabled: true, matches: ['https://a.com/*'], code: '',
    runAt: 'document_idle', world: 'USER_SCRIPT', source: 'user', createdAt: 1, updatedAt: 1,
    meta: { grants: ['GM_cookie'] }, ...over,
  };
}

describe('GM_cookie 门控', () => {
  beforeEach(() => { fakeBrowser.reset(); vi.restoreAllMocks(); __resetConfirmQueue();
    vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({} as never);
    vi.spyOn(browser.tabs, 'create').mockResolvedValue({ id: 100 } as never);
    (browser as unknown as { cookies: Record<string, unknown> }).cookies = { getAll: vi.fn(async () => [{ name: 'k' }]), set: vi.fn(async () => ({})), remove: vi.fn(async () => ({})) };
  });

  it('跨域 cookie 未列 @connect → 弹卡；allow-once 后放行 list', async () => {
    await saveScript(mkScript());
    const pending = handleGmCall({ scriptId: 's1', api: 'CookieList', reqId: 1, params: [{ url: 'https://c.com/' }] }, { tab: { id: 1, url: 'https://a.com/' } } as never);
    await new Promise((r) => setTimeout(r, 10));
    const confirms = getPending();
    expect(confirms).toHaveLength(1);
    expect(confirms[0]).toMatchObject({ kind: 'connect' });
    resolveConfirm(confirms[0]!.confirmId, 'allow-once');
    const r = await pending as { ok: boolean; data?: unknown };
    expect(r.ok).toBe(true);
    expect(r.data).toEqual([{ name: 'k' }]);
  });

  it('self 域直通（同 host 不弹卡）', async () => {
    await saveScript(mkScript());
    const r = await handleGmCall({ scriptId: 's1', api: 'CookieList', reqId: 2, params: [{ url: 'https://a.com/' }] }, { tab: { id: 1, url: 'https://a.com/' } } as never);
    expect((r as { ok: boolean }).ok).toBe(true);
    expect(getPending()).toHaveLength(0);
  });
});
```

- [ ] **Step 6: 运行验证失败**

Run: `npx vitest run tests/background/gm-cookie.test.ts`
Expected: FAIL（switch 无 CookieList 等）

- [ ] **Step 7: gm-api.ts 加 doCookie + switch**

`background/gm-api.ts` 顶部 import：

```typescript
import { listCookies, setCookie, deleteCookie, cookieTargetUrl, type CookieDetails } from './gm-cookie';
```

新增 `doCookie`（放在 `doXmlHttpRequest` 附近）：

```typescript
async function doCookie(
  scriptId: string, op: 'list' | 'set' | 'delete', params: unknown[], sender: Sender,
): Promise<{ ok: true; data?: unknown } | { ok: false; error: string }> {
  const details = (params[0] ?? {}) as CookieDetails;
  const script = await getScript(scriptId);
  if (!script) return { ok: false, error: '脚本不存在' };
  const targetUrl = cookieTargetUrl(details);
  if (!targetUrl) return { ok: false, error: 'GM_cookie 缺少 url 或 domain' };
  const pageUrl = sender?.tab?.url ?? '';
  const decision = await matchConnectWithPermissions(script.meta?.connects ?? [], targetUrl, pageUrl, scriptId);
  if (decision === ConnectDecision.CONFIRM) {
    const host = hostOf(targetUrl);
    const choice = await enqueueConfirm({
      kind: 'connect',
      title: 'Cookie 访问确认',
      message: `脚本「${script.name}」请求读写 cookie`,
      rows: [
        { label: '主机', value: host, mono: true },
        { label: '操作', value: op, mono: true },
        { label: '来源', value: pageUrl || '（未知）', mono: true },
      ],
      actions: [
        { decision: 'allow-once', label: '允许一次', variant: 'primary' },
        { decision: 'always', label: '总是允许' },
        { decision: 'deny', label: '拒绝', variant: 'danger', countdown: true },
      ],
      timeoutMs: 60_000,
    });
    if (choice === 'always') {
      const { setAlwaysAllow } = await import('./gm-permissions');
      await setAlwaysAllow(scriptId, host);
    } else if (choice !== 'allow-once') {
      return { ok: false, error: 'permission denied（用户拒绝或超时；可加 @connect 或在确认页批准）' };
    }
  } else if (decision === ConnectDecision.DENY) {
    return { ok: false, error: `Refused：cookie 主机「${hostOf(targetUrl)}」不在 @connect 列表` };
  }
  try {
    if (op === 'list') return { ok: true, data: await listCookies(details) };
    if (op === 'set') { await setCookie(details); return { ok: true, data: null }; }
    await deleteCookie(details);
    return { ok: true, data: null };
  } catch (e) {
    return { ok: false, error: `GM_cookie.${op} 失败：${e instanceof Error ? e.message : String(e)}` };
  }
}
```

`handleGmCall` switch 追加：

```typescript
    case 'CookieList':
      return doCookie(scriptId, 'list', params, sender);
    case 'CookieSet':
      return doCookie(scriptId, 'set', params, sender);
    case 'CookieDelete':
      return doCookie(scriptId, 'delete', params, sender);
```

- [ ] **Step 8: 运行验证通过**

Run: `npx vitest run tests/background/gm-cookie.test.ts`
Expected: PASS

- [ ] **Step 9: 编译 + Commit**

```bash
npm run compile
git add background/gm-cookie.ts background/gm-api.ts tests/background/gm-cookie.test.ts
git commit -m "feat(gm): SW cookie（GM_cookie.list/set/delete，@connect 门控复用）"
```

---

### Task 10: SW download（GM_download，chrome.downloads + @connect 门控）

**Files:**
- Create: `background/gm-download.ts`
- Modify: `background/gm-api.ts`（`doDownload` 门控 + switch case Download）
- Test: `tests/background/gm-download.test.ts`

**语义（spec §5.3/§9）：** onload/onerror 保证；onprogress 首版缺省。SW resolve 于下载终态（complete→ok / interrupted→error）。

- [ ] **Step 1: 写失败测试（模块）**

Create `tests/background/gm-download.test.ts`：

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { runDownload } from '../../background/gm-download';

type Delta = { id: number; state?: { current?: string }; error?: { current?: string } };

function fakeDownloads() {
  let listener: ((d: Delta) => void) | undefined;
  const download = vi.fn(async () => 42);
  const removeListener = vi.fn();
  (browser as unknown as { downloads: unknown }).downloads = {
    download,
    onChanged: { addListener: (cb: (d: Delta) => void) => { listener = cb; }, removeListener },
  };
  return { download, removeListener, emit: (d: Delta) => listener?.(d) };
}

describe('gm-download', () => {
  beforeEach(() => { fakeBrowser.reset(); vi.restoreAllMocks(); });

  it('complete → ok；filename/headers 透传', async () => {
    const f = fakeDownloads();
    const p = runDownload({ url: 'https://c.com/f.zip', name: 'f.zip', headers: { 'X-A': '1' } });
    await new Promise((r) => setTimeout(r, 0)); // 等 download() resolve、id 落定
    f.emit({ id: 42, state: { current: 'complete' } });
    expect(await p).toEqual({ ok: true });
    expect(f.download).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://c.com/f.zip', filename: 'f.zip', headers: [{ name: 'X-A', value: '1' }],
    }));
  });

  it('interrupted → error', async () => {
    const f = fakeDownloads();
    const p = runDownload({ url: 'https://c.com/f.zip' });
    await new Promise((r) => setTimeout(r, 0));
    f.emit({ id: 42, state: { current: 'interrupted' }, error: { current: 'NETWORK_FAILED' } });
    expect(await p).toEqual({ ok: false, error: 'NETWORK_FAILED' });
  });
});
```

- [ ] **Step 2: 运行验证失败**

Run: `npx vitest run tests/background/gm-download.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 建模块**

Create `background/gm-download.ts`：

```typescript
// background/gm-download.ts
// GM_download 的 chrome.downloads 封装（spec §5.3）。onload/onerror 保证；onprogress 首版缺省。
// resolve 于下载终态：state=complete → ok；state=interrupted → error。门控在 gm-api.doDownload。

export interface DownloadDetails {
  url?: string;
  name?: string;
  headers?: Record<string, string>;
  saveAs?: boolean;
}

interface DownloadDelta { id: number; state?: { current?: string }; error?: { current?: string } }
type DownloadsApi = {
  download(opts: Record<string, unknown>): Promise<number>;
  onChanged: {
    addListener(cb: (d: DownloadDelta) => void): void;
    removeListener(cb: (d: DownloadDelta) => void): void;
  };
};

function api(): DownloadsApi {
  const d = (browser as unknown as { downloads?: DownloadsApi }).downloads;
  if (!d) throw new Error('downloads API 不可用（需 manifest downloads 权限）');
  return d;
}

/** 触发下载，Promise resolve 于终态。listener 先挂再 download，避免漏接早到的 onChanged。 */
export function runDownload(details: DownloadDetails): Promise<{ ok: true } | { ok: false; error: string }> {
  const d = api();
  let id: number | undefined;
  const headers = details.headers
    ? Object.entries(details.headers).map(([name, value]) => ({ name, value }))
    : undefined;
  return new Promise((resolve) => {
    const onChanged = (delta: DownloadDelta): void => {
      if (id === undefined || delta.id !== id) return;
      const state = delta.state?.current;
      if (state === 'complete') { d.onChanged.removeListener(onChanged); resolve({ ok: true }); }
      else if (state === 'interrupted') { d.onChanged.removeListener(onChanged); resolve({ ok: false, error: delta.error?.current ?? 'interrupted' }); }
    };
    d.onChanged.addListener(onChanged);
    const opts: Record<string, unknown> = { url: details.url, saveAs: !!details.saveAs };
    if (details.name) opts.filename = details.name;
    if (headers) opts.headers = headers;
    d.download(opts).then((got) => { id = got; }, (e) => {
      d.onChanged.removeListener(onChanged);
      resolve({ ok: false, error: e instanceof Error ? e.message : String(e) });
    });
  });
}
```

- [ ] **Step 4: 运行验证通过（模块）**

Run: `npx vitest run tests/background/gm-download.test.ts`
Expected: PASS

- [ ] **Step 5: 写门控接线测试**

在 `tests/background/gm-download.test.ts` 追加（走 handleGmCall + 确认队列）：

```typescript
import { handleGmCall } from '../../background/gm-api';
import { resolveConfirm, getPending, __resetConfirmQueue } from '../../background/confirm-queue';
import { saveScript } from '../../storage/scripts';
import type { UserScript } from '../../shared/types';

function mkScript(over: Partial<UserScript> = {}): UserScript {
  return {
    id: 's1', text: '', name: 't', enabled: true, matches: ['https://a.com/*'], code: '',
    runAt: 'document_idle', world: 'USER_SCRIPT', source: 'user', createdAt: 1, updatedAt: 1,
    meta: { grants: ['GM_download'] }, ...over,
  };
}

describe('GM_download 门控', () => {
  beforeEach(() => { fakeBrowser.reset(); vi.restoreAllMocks(); __resetConfirmQueue();
    vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({} as never);
    vi.spyOn(browser.tabs, 'create').mockResolvedValue({ id: 100 } as never);
  });

  it('跨域下载未列 @connect → 弹卡；allow-once 后 complete→ok', async () => {
    await saveScript(mkScript());
    const f = fakeDownloads();
    const pending = handleGmCall({ scriptId: 's1', api: 'Download', reqId: 1, params: [{ url: 'https://c.com/f.zip' }] }, { tab: { id: 1, url: 'https://a.com/' } } as never);
    await new Promise((r) => setTimeout(r, 10));
    const confirms = getPending();
    expect(confirms).toHaveLength(1);
    resolveConfirm(confirms[0]!.confirmId, 'allow-once');
    await new Promise((r) => setTimeout(r, 10));
    f.emit({ id: 42, state: { current: 'complete' } });
    expect((await pending as { ok: boolean }).ok).toBe(true);
  });
});
```

- [ ] **Step 6: 运行验证失败**

Run: `npx vitest run tests/background/gm-download.test.ts`
Expected: FAIL（switch 无 Download）

- [ ] **Step 7: gm-api.ts 加 doDownload + switch**

`background/gm-api.ts` 顶部 import：

```typescript
import { runDownload, type DownloadDetails } from './gm-download';
```

新增 `doDownload`（`doXmlHttpRequest` 附近）：

```typescript
async function doDownload(
  scriptId: string, params: unknown[], sender: Sender,
): Promise<{ ok: true; data?: unknown } | { ok: false; error: string }> {
  const details = (params[0] ?? {}) as DownloadDetails;
  if (!details.url) return { ok: false, error: 'GM_download 缺少 url' };
  const script = await getScript(scriptId);
  if (!script) return { ok: false, error: '脚本不存在' };
  const pageUrl = sender?.tab?.url ?? '';
  const decision = await matchConnectWithPermissions(script.meta?.connects ?? [], details.url, pageUrl, scriptId);
  if (decision === ConnectDecision.CONFIRM) {
    const host = hostOf(details.url);
    const choice = await enqueueConfirm({
      kind: 'connect',
      title: '下载确认',
      message: `脚本「${script.name}」请求下载文件`,
      rows: [
        { label: '主机', value: host, mono: true },
        { label: 'URL', value: details.url, mono: true },
        { label: '文件名', value: details.name ?? '（默认）', mono: true },
        { label: '来源', value: pageUrl || '（未知）', mono: true },
      ],
      actions: [
        { decision: 'allow-once', label: '允许一次', variant: 'primary' },
        { decision: 'always', label: '总是允许' },
        { decision: 'deny', label: '拒绝', variant: 'danger', countdown: true },
      ],
      timeoutMs: 60_000,
    });
    if (choice === 'always') {
      const { setAlwaysAllow } = await import('./gm-permissions');
      await setAlwaysAllow(scriptId, host);
    } else if (choice !== 'allow-once') {
      return { ok: false, error: 'permission denied（用户拒绝或超时）' };
    }
  } else if (decision === ConnectDecision.DENY) {
    return { ok: false, error: `Refused：下载主机「${hostOf(details.url)}」不在 @connect 列表` };
  }
  try {
    return await runDownload(details);
  } catch (e) {
    return { ok: false, error: `GM_download 失败：${e instanceof Error ? e.message : String(e)}` };
  }
}
```

`handleGmCall` switch 追加：

```typescript
    case 'Download':
      return doDownload(scriptId, params, sender);
```

- [ ] **Step 8: 运行验证通过**

Run: `npx vitest run tests/background/gm-download.test.ts`
Expected: PASS

- [ ] **Step 9: 编译 + Commit**

```bash
npm run compile
git add background/gm-download.ts background/gm-api.ts tests/background/gm-download.test.ts
git commit -m "feat(gm): SW download（chrome.downloads + @connect 门控，onload/onerror）"
```

---

### Task 11: SW window.close/focus + urlchange（webNavigation 下行）

**Files:**
- Create: `background/gm-urlchange.ts`
- Modify: `background/gm-api.ts`（switch 加 WindowClose/WindowFocus；`initGmApi` 调 `initUrlChange`；导出 `sendGmEvent` 或内联 dispatch）
- Test: `tests/background/gm-urlchange.test.ts`、`tests/background/gm-api.test.ts`

- [ ] **Step 1: 写失败测试（urlchange 过滤 + dispatch）**

Create `tests/background/gm-urlchange.test.ts`：

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { scriptsForUrlChange, initUrlChange } from '../../background/gm-urlchange';
import { saveScript } from '../../storage/scripts';
import type { UserScript } from '../../shared/types';

function mkScript(over: Partial<UserScript>): UserScript {
  return {
    id: 's1', text: '', name: 't', enabled: true, matches: ['https://a.com/*'], code: '',
    runAt: 'document_idle', world: 'USER_SCRIPT', source: 'user', createdAt: 1, updatedAt: 1,
    meta: { grants: ['window.onurlchange'] }, ...over,
  };
}

describe('gm-urlchange', () => {
  beforeEach(() => { fakeBrowser.reset(); vi.restoreAllMocks(); });

  it('scriptsForUrlChange：仅 @grant window.onurlchange 且 match 命中且启用', async () => {
    await saveScript(mkScript({ id: 's1', matches: ['https://a.com/*'], meta: { grants: ['window.onurlchange'] } }));
    await saveScript(mkScript({ id: 's2', matches: ['https://a.com/*'], meta: { grants: [] } }));
    await saveScript(mkScript({ id: 's3', matches: ['https://b.com/*'], meta: { grants: ['window.onurlchange'] } }));
    await saveScript(mkScript({ id: 's4', enabled: false, matches: ['https://a.com/*'], meta: { grants: ['window.onurlchange'] } }));
    expect(await scriptsForUrlChange('https://a.com/page')).toEqual(['s1']);
  });

  it('initUrlChange：主帧导航事件 → dispatch 每个命中脚本；子帧忽略', async () => {
    await saveScript(mkScript({ id: 's1', matches: ['https://a.com/*'], meta: { grants: ['window.onurlchange'] } }));
    let hist: ((d: { tabId: number; frameId: number; url: string }) => void) | undefined;
    (browser as unknown as { webNavigation: unknown }).webNavigation = {
      onHistoryStateUpdated: { addListener: (cb: typeof hist) => { hist = cb; } },
      onReferenceFragmentUpdated: { addListener: vi.fn() },
    };
    const dispatch = vi.fn();
    initUrlChange(dispatch);
    hist!({ tabId: 5, frameId: 1, url: 'https://a.com/x' }); // 子帧忽略
    await new Promise((r) => setTimeout(r, 0));
    expect(dispatch).not.toHaveBeenCalled();
    hist!({ tabId: 5, frameId: 0, url: 'https://a.com/x' }); // 主帧
    await new Promise((r) => setTimeout(r, 0));
    expect(dispatch).toHaveBeenCalledWith(5, 's1', 'https://a.com/x');
  });
});
```

- [ ] **Step 2: 运行验证失败**

Run: `npx vitest run tests/background/gm-urlchange.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 建模块**

Create `background/gm-urlchange.ts`：

```typescript
// background/gm-urlchange.ts
// window.onurlchange 支持（spec §5.4）：SW 监听 webNavigation 的 SPA 导航事件（pushState/
// replaceState = onHistoryStateUpdated；hash = onReferenceFragmentUpdated），仅主帧，
// 找出 @grant window.onurlchange 且 match 命中的启用脚本，经 dispatch 下行 URL_CHANGE。

import { listScripts } from '../storage/scripts';
import { matchUrl } from '../shared/match-pattern';

/** 该 URL 下应收到 urlchange 的脚本 id：启用 + match 命中 + @grant window.onurlchange。 */
export async function scriptsForUrlChange(url: string): Promise<string[]> {
  if (!url) return [];
  const all = await listScripts();
  return all
    .filter((s) => s.enabled && matchUrl(s.matches, url) && (s.meta?.grants ?? []).includes('window.onurlchange'))
    .map((s) => s.id);
}

export type UrlChangeDispatch = (tabId: number, scriptId: string, url: string) => void;

interface NavDetails { tabId: number; frameId: number; url: string }
interface NavEvent { addListener(cb: (d: NavDetails) => void): void }
interface WebNav { onHistoryStateUpdated?: NavEvent; onReferenceFragmentUpdated?: NavEvent }

/** 注册 webNavigation 监听（幂等由调用方保证：initGmApi 只调一次）。无 webNavigation 时静默。 */
export function initUrlChange(dispatch: UrlChangeDispatch): void {
  const wn = (browser as unknown as { webNavigation?: WebNav }).webNavigation;
  if (!wn) return;
  const handler = async (d: NavDetails): Promise<void> => {
    if (d.frameId !== 0) return; // 仅主帧
    const ids = await scriptsForUrlChange(d.url);
    for (const id of ids) dispatch(d.tabId, id, d.url);
  };
  wn.onHistoryStateUpdated?.addListener((d) => void handler(d));
  wn.onReferenceFragmentUpdated?.addListener((d) => void handler(d));
}
```

- [ ] **Step 4: 运行验证通过（模块）**

Run: `npx vitest run tests/background/gm-urlchange.test.ts`
Expected: PASS

- [ ] **Step 5: 写 WindowClose/WindowFocus 测试**

在 `tests/background/gm-api.test.ts` 的批量值 describe 内追加：

```typescript
  it('WindowClose 关 tab；WindowFocus 激活 tab', async () => {
    await saveScript(mkScript({ meta: { grants: ['window.close', 'window.focus'] } }));
    const remove = vi.spyOn(browser.tabs, 'remove').mockResolvedValue(undefined as never);
    const update = vi.spyOn(browser.tabs, 'update').mockResolvedValue({} as never);
    await handleGmCall({ scriptId: 's1', api: 'WindowClose', reqId: 1, params: [] }, { tab: { id: 8, url: 'https://a.com/' } } as never);
    expect(remove).toHaveBeenCalledWith(8);
    await handleGmCall({ scriptId: 's1', api: 'WindowFocus', reqId: 2, params: [] }, { tab: { id: 8, url: 'https://a.com/' } } as never);
    expect(update).toHaveBeenCalledWith(8, { active: true });
  });
```

- [ ] **Step 6: 运行验证失败**

Run: `npx vitest run tests/background/gm-api.test.ts`
Expected: FAIL（switch 无 WindowClose）

- [ ] **Step 7: gm-api.ts 加 case + 接线 urlchange**

`background/gm-api.ts` 顶部 import：

```typescript
import { initUrlChange } from './gm-urlchange';
```

`handleGmCall` switch 追加：

```typescript
    case 'WindowClose': {
      const tabId = sender?.tab?.id;
      if (tabId == null) return { ok: false, error: 'window.close 缺少 tab 上下文' };
      try { await browser.tabs.remove(tabId); return { ok: true, data: null }; }
      catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
    }
    case 'WindowFocus': {
      const tabId = sender?.tab?.id;
      if (tabId == null) return { ok: false, error: 'window.focus 缺少 tab 上下文' };
      try { await browser.tabs.update(tabId, { active: true }); return { ok: true, data: null }; }
      catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
    }
```

`initGmApi` 函数体末尾（notifications 监听之后）追加：

```typescript
  initUrlChange((tabId, scriptId, url) => void sendGmEvent(tabId, scriptId, 'URL_CHANGE', { url }));
```

- [ ] **Step 8: 运行验证通过**

Run: `npx vitest run tests/background/gm-api.test.ts tests/background/gm-urlchange.test.ts`
Expected: PASS

- [ ] **Step 9: 编译 + Commit**

```bash
npm run compile
git add background/gm-urlchange.ts background/gm-api.ts tests/background/gm-urlchange.test.ts tests/background/gm-api.test.ts
git commit -m "feat(gm): SW window.close/focus + urlchange（webNavigation 下行 URL_CHANGE）"
```

---

### Task 12: 接线 resourceUrls 到脚本注册（GM_getResourceURL 数据源）

**Files:**
- Modify: `background/scripts.ts:158-167`（`toRegisterDetailsAsync` 传 `resourceUrls`）
- Test: `tests/background/scripts.test.ts`（新增注册产物含 data: URL 断言）

**背景：** Task 2/3 已分别验证 `getResourceBundle` 产 `resourceUrls`、`buildWrappedCode` 渲染 `__resourceUrls`。本任务连接二者：`toRegisterDetailsAsync` 把 `bundle.resourceUrls` 传入 wrapper。

- [ ] **Step 1: 写失败测试**

在 `tests/background/scripts.test.ts` 追加（若已有 engine stub 帮助函数则复用；否则用下面自包含写法直接调 `syncRegistrations` + 捕获注册码）。先确认文件顶部已 import `fakeBrowser`、`saveScript`；追加：

```typescript
import { syncRegistrations } from '../../background/scripts';

describe('注册产物：@resource 的 GM_getResourceURL 快照', () => {
  beforeEach(() => { fakeBrowser.reset(); vi.restoreAllMocks(); });

  it('文本 @resource → wrapper 内嵌 data: URL', async () => {
    // 预取：文本资源落缓存
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, headers: new Map([['content-type', 'text/css']]), text: async () => 'body{color:red}' })));
    // engine stub：捕获 register 的 code
    let captured = '';
    (browser as unknown as { userScripts: unknown }).userScripts = {
      getScripts: async () => [],
      register: async (arr: Array<{ id: string; js: Array<{ code: string }> }>) => { captured = arr[0]?.js[0]?.code ?? ''; },
      update: async () => {}, unregister: async () => {}, configureWorld: async () => {},
    };
    const { prefetchResources } = await import('../../background/gm-resources');
    const s = { id: 'r1', text: '', name: 't', enabled: true, matches: ['https://a.com/*'],
      code: 'x();', runAt: 'document_idle', world: 'USER_SCRIPT', source: 'user', createdAt: 1, updatedAt: 1,
      meta: { grants: ['GM_getResourceURL'], resources: { theme: 'https://cdn/t.css' } } } as never;
    await saveScript(s);
    await prefetchResources(s);
    await syncRegistrations();
    expect(captured).toContain('__resourceUrls = {"theme":"data:text/css');
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: 运行验证失败**

Run: `npx vitest run tests/background/scripts.test.ts`
Expected: FAIL（`toRegisterDetailsAsync` 未传 resourceUrls → `__resourceUrls = {}`）

- [ ] **Step 3: 接线**

`background/scripts.ts` 的 `toRegisterDetailsAsync` 里，`buildWrappedCode` 调用加 `resourceUrls`：

```typescript
  const code = buildWrappedCode(s, {
    token, values, resources: bundle.resources, resourceUrls: bundle.resourceUrls,
    requireCodes: bundle.requireCodes, extensionVersion: extensionVersion(),
  });
```

- [ ] **Step 4: 运行验证通过**

Run: `npx vitest run tests/background/scripts.test.ts`
Expected: PASS（含原有全部用例）

- [ ] **Step 5: 编译 + Commit**

```bash
npm run compile
git add background/scripts.ts tests/background/scripts.test.ts
git commit -m "feat(gm): 注册时传 resourceUrls 快照（GM_getResourceURL 落地）"
```

---

### Task 13: 扩展现有手测模块（storage / dom-resource / tabs）

**Files:**
- Modify: `fixtures/userscripts/manual/storage.user.js.src`（+3 卡 + @grant）
- Modify: `fixtures/userscripts/manual/dom-resource.user.js.src`（+2 卡 + @grant/@resource）
- Modify: `fixtures/userscripts/manual/tabs.user.js.src`（+3 卡 + @grant）
- 产物：`npm run build:manual` 重生成对应 `.user.js`

> 说明：每卡遵循 `{ id: 'sN', api, desc, steps, expect }`；交互步骤 `{ id, label }` 挂 `actions`。卡 id 用小写字母+纯数字（fixtures 测试 `CARD_RE = /\{ id: '([a-z]\d+)'/`）。本任务的护栏断言更新在 Task 14 统一改（两任务连续执行）。

- [ ] **Step 1: storage.user.js.src — 加 @grant + 3 卡**

@grant 段追加：

```
// @grant        GM_getValues
// @grant        GM_setValues
// @grant        GM_deleteValues
// @grant        GM_removeValueChangeListener
```

`actions` 对象追加：

```javascript
    's8-batch': function (log) {
      GM_setValues({ '__gmt_b.x': 1, '__gmt_b.y': 2 });
      log('s8', 'GM_getValues(["__gmt_b.x","__gmt_b.y"]) → ' + JSON.stringify(GM_getValues(['__gmt_b.x', '__gmt_b.y'])));
    },
    's9-batchdel': function (log) {
      GM_deleteValues(['__gmt_b.x', '__gmt_b.y']);
      log('s9', '删后 GM_getValues → ' + JSON.stringify(GM_getValues(['__gmt_b.x', '__gmt_b.y'])));
    },
    's10-remove': function (log) {
      var id = GM_addValueChangeListener('__gmt_b.evt', function () { GMT.log('s10', '不该触发：监听已移除'); });
      GM_removeValueChangeListener(id);
      GM_setValue('__gmt_b.evt', 'z' + (Date.now() % 1000));
      log('s10', '已注册后立即移除并触发 setValue；若下方无「不该触发」行即通过');
    }
```

`cards` 数组追加（在 s7 之后）：

```javascript
      { id: 's8', api: 'GM_setValues(obj) / GM_getValues(keys)', desc: '批量写 + 批量读（下划线同步）。', steps: [{ id: 's8-batch', label: '批量写两键并读回' }], expect: '日志 {"__gmt_b.x":1,"__gmt_b.y":2}' },
      { id: 's9', api: 'GM_deleteValues(keys)', desc: '批量删。', steps: [{ id: 's9-batchdel', label: '批量删两键并读回' }], expect: '日志两键均 undefined' },
      { id: 's10', api: 'GM_removeValueChangeListener(id)', desc: '移除监听后事件不再触发。', steps: [{ id: 's10-remove', label: '注册→移除→触发' }, '确认下方无「不该触发」行'], expect: '无「不该触发」日志行' }
```

- [ ] **Step 2: dom-resource.user.js.src — 加 @grant/@resource + 2 卡**

头部加（@resource 用稳定小图，jsdelivr 空 png 或项目可访问的公共图；此处用 data 图无法测 URL 加载，故用真实小图 URL）：

```
// @grant        GM_addElement
// @grant        GM_getResourceURL
// @resource     logo https://www.google.com/favicon.ico
// @connect      www.google.com
```

`actions` 追加：

```javascript
    'd6-addel': function (log) {
      var el = GM_addElement('div', { id: 'gmt-addel', textContent: 'GM_addElement 探针', style: 'position:fixed;left:12px;top:60px;z-index:2147483646;background:#188038;color:#fff;padding:6px 10px;border-radius:4px;font:12px system-ui' });
      log('d6', 'GM_addElement 返回 tagName=' + el.tagName + '，看左上第二个绿块');
    },
    'd7-resurl': function (log) {
      var url = GM_getResourceURL('logo');
      log('d7', 'GM_getResourceURL("logo") 前缀 → ' + String(url).slice(0, 32));
      var img = GM_addElement('img', { src: url, style: 'position:fixed;left:12px;top:100px;z-index:2147483646;width:32px;height:32px;border:1px solid #ccc' });
      void img;
    }
```

`cards` 追加：

```javascript
      { id: 'd6', api: 'GM_addElement(tag, attrs)', desc: '创建并插入元素（textContent/style 特判）。', steps: [{ id: 'd6-addel', label: '插入绿色探针块' }], expect: '左上出现绿色「GM_addElement 探针」块' },
      { id: 'd7', api: 'GM_getResourceURL(name)', desc: '返回 @resource 的 data: URL；插入 <img> 验证可加载。', steps: [{ id: 'd7-resurl', label: '取 URL 并插入图片' }, '看左上是否出现 32x32 图标'], expect: '日志前缀为 data:image/... 且图片渲染' }
```

- [ ] **Step 3: tabs.user.js.src — 加 @grant + 3 卡**

@grant 段追加：

```
// @grant        GM_getTab
// @grant        GM_saveTab
// @grant        GM_getTabs
// @grant        window.close
// @grant        window.focus
```

`actions` 追加：

```javascript
    't3-savetab': function (log) {
      GM_saveTab({ visited: Date.now() });
      GM_getTab(function (data) { GMT.log('t3', 'GM_getTab 读回 → ' + JSON.stringify(data)); });
      log('t3', '已 saveTab + getTab（回调打印读回值）');
    },
    't4-gettabs': function (log) {
      GM_getTabs(function (all) { GMT.log('t4', 'GM_getTabs → ' + JSON.stringify(all)); });
      log('t4', '已请求 GM_getTabs（回调打印全 tab 数据）');
    },
    't5-focus': function (log) {
      unsafeWindow.focus();
      log('t5', '已调 window.focus（本 tab 激活；多窗口下更明显）');
    }
```

`cards` 追加：

```javascript
      { id: 't3', api: 'GM_saveTab(data) / GM_getTab(cb)', desc: '本 tab 私有数据写后读回（回调形态）。', steps: [{ id: 't3-savetab', label: 'saveTab + getTab' }], expect: '日志读回 {"visited":<ts>}' },
      { id: 't4', api: 'GM_getTabs(cb)', desc: '全部 tab 的本脚本数据 {tabId:data}。', steps: [{ id: 't4-gettabs', label: 'getTabs' }], expect: '日志含当前 tab 的数据条目' },
      { id: 't5', api: 'window.focus（特殊 grant）', desc: '激活脚本所在 tab。', steps: [{ id: 't5-focus', label: 'focus 本 tab' }], expect: '本 tab 被激活（无报错）' }
```

> 注：`window.close` 已加 @grant 供白名单/调试台核对，但不设卡（会关掉手测页本身，破坏面板）。文案在 t5 卡说明即可。

- [ ] **Step 4: 重新构建产物**

Run: `npm run build:manual`
Expected: 打印 `built gmt-manual-storage.user.js ...` 等，无报错

- [ ] **Step 5: 编译（TS 不涉及 fixtures，仅确保无副作用）**

Run: `npm run compile`
Expected: 无错误

- [ ] **Step 6: Commit**

```bash
git add fixtures/userscripts/manual/storage.user.js.src fixtures/userscripts/manual/dom-resource.user.js.src fixtures/userscripts/manual/tabs.user.js.src fixtures/userscripts/manual/gmt-manual-storage.user.js fixtures/userscripts/manual/gmt-manual-dom-resource.user.js fixtures/userscripts/manual/gmt-manual-tabs.user.js
git commit -m "test(gm): 扩展 storage/dom-resource/tabs 手测模块覆盖新 API"
```

---

### Task 14: 新增手测模块（cookie / download / urlchange / notify-menu）+ 护栏

**Files:**
- Create: `fixtures/userscripts/manual/cookie.user.js.src`、`download.user.js.src`、`urlchange.user.js.src`、`notify-menu.user.js.src`
- Modify: `tests/shared/gmt-manual-fixtures.test.ts`（加 4 组 import + FIXTURES 条目）
- 产物：`npm run build:manual` 生成 4 个 `.user.js`

> 约束：卡 id 用**单字母 + 数字**（fixtures 测试 `CARD_RE = /\{ id: '([a-z]\d+)'/`——`nm1` 这类双字母不被计数）。每模块必含 4 个内核 grant：`GM_getValue`/`GM_setValue`/`GM_deleteValue`/`GM_addStyle`（`_panel-core.js` 依赖）。中文名格式 `GM 手测·<label>`，`@match *://*/*`，`@run-at document-end`，`@noframes`。

- [ ] **Step 1: 建 cookie.user.js.src（3 卡，自域 cookie）**

```javascript
// ==UserScript==
// @name         GM 手测·Cookie
// @namespace    ai-browser-extend/gmt-manual
// @version      1.0.0
// @description  GM_cookie 人工测试：自域 list/set/delete（自域直通不弹卡）
// @match        *://*/*
// @run-at       document-end
// @grant        GM_cookie
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_addStyle
// @noframes
// ==/UserScript==

(function () {
  var actions = {
    'c1-list': function (log) {
      GM_cookie.list({ url: location.href }).then(function (cs) {
        log('c1', 'list → ' + (Array.isArray(cs) ? cs.length + ' 条：' + cs.slice(0, 3).map(function (c) { return c.name; }).join(',') : JSON.stringify(cs)));
      }, function (e) { log('c1', 'list 失败：' + e.message); });
    },
    'c2-set': function (log) {
      GM_cookie.set({ url: location.origin + '/', name: '__gmt_ck', value: 'v' + (Date.now() % 1000) }).then(function () {
        log('c2', 'set 成功，再 list 找 __gmt_ck');
      }, function (e) { log('c2', 'set 失败：' + e.message); });
    },
    'c3-del': function (log) {
      GM_cookie.delete({ url: location.origin + '/', name: '__gmt_ck' }).then(function () {
        log('c3', 'delete 成功');
      }, function (e) { log('c3', 'delete 失败：' + e.message); });
    }
  };

  GMT.render({
    module: 'cookie',
    title: 'GM 手测·Cookie',
    cards: [
      { id: 'c1', api: 'GM_cookie.list(details)', desc: '读当前页 cookie（自域直通，不弹卡）。', steps: [{ id: 'c1-list', label: 'list 当前页 cookie' }], expect: '日志列出 cookie 条数/名（无 permission 报错）' },
      { id: 'c2', api: 'GM_cookie.set(details)', desc: '在自域写一个测试 cookie。', steps: [{ id: 'c2-set', label: 'set __gmt_ck' }, '再点 c1 的 list 确认出现 __gmt_ck'], expect: 'set 成功；list 能看到 __gmt_ck' },
      { id: 'c3', api: 'GM_cookie.delete(details)', desc: '删除测试 cookie。', steps: [{ id: 'c3-del', label: 'delete __gmt_ck' }, '再 list 确认消失'], expect: 'delete 成功；list 不再含 __gmt_ck' }
    ],
    actions: actions
  });
})();
```

- [ ] **Step 2: 建 download.user.js.src（1 卡，@connect CDN）**

```javascript
// ==UserScript==
// @name         GM 手测·下载
// @namespace    ai-browser-extend/gmt-manual
// @version      1.0.0
// @description  GM_download 人工测试：跨域下载（首次弹确认卡）
// @match        *://*/*
// @run-at       document-end
// @grant        GM_download
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_addStyle
// @connect      cdn.jsdelivr.net
// @noframes
// ==/UserScript==

(function () {
  var actions = {
    'w1-dl': function (log) {
      log('w1', '触发下载…（首次跨域会弹确认卡，允许后看浏览器下载条）');
      GM_download({
        url: 'https://cdn.jsdelivr.net/npm/lodash@4.17.21/package.json',
        name: 'gmt-download-probe.json',
        onload: function () { GMT.log('w1', 'onload：下载完成'); },
        onerror: function (e) { GMT.log('w1', 'onerror：' + JSON.stringify(e)); }
      });
    }
  };

  GMT.render({
    module: 'download',
    title: 'GM 手测·下载',
    cards: [
      { id: 'w1', api: 'GM_download(details)', desc: '下载文件到本地（chrome.downloads，跨域首次弹确认卡）。', steps: [{ id: 'w1-dl', label: '下载探针文件' }, '允许确认卡后看浏览器下载条'], expect: '下载条出现 gmt-download-probe.json；日志 onload' }
    ],
    actions: actions
  });
})();
```

- [ ] **Step 3: 先建这两个文件，构建校验**

Run: `npm run build:manual`
Expected: 打印 `built gmt-manual-cookie.user.js ...`、`built gmt-manual-download.user.js ...`

- [ ] **Step 4: 建 urlchange.user.js.src（2 卡，SPA 导航）**

```javascript
// ==UserScript==
// @name         GM 手测·URL变化
// @namespace    ai-browser-extend/gmt-manual
// @version      1.0.0
// @description  window.onurlchange 人工测试：pushState / hash 触发回调
// @match        *://*/*
// @run-at       document-end
// @grant        window.onurlchange
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_addStyle
// @noframes
// ==/UserScript==

(function () {
  // 注册两种接收形态：onurlchange 属性 + 'urlchange' 事件（TM 双形态）
  window.onurlchange = function (info) { GMT.log('u1', 'onurlchange 回调 → ' + JSON.stringify(info)); };
  window.addEventListener('urlchange', function (e) { GMT.log('u1', "'urlchange' 事件 → " + JSON.stringify(e.detail)); });

  var n = 0;
  var actions = {
    'u1-push': function (log) {
      n += 1;
      history.pushState({}, '', location.pathname + '?__gmt_url=' + n);
      log('u1', '已 pushState ?__gmt_url=' + n + '（SW webNavigation 下行后应见回调/事件行）');
    },
    'u2-hash': function (log) {
      location.hash = 'gmt-' + Date.now();
      log('u2', '已改 hash（onReferenceFragmentUpdated 触发）');
    }
  };

  GMT.render({
    module: 'urlchange',
    title: 'GM 手测·URL变化',
    cards: [
      { id: 'u1', api: 'window.onurlchange（pushState）', desc: 'SPA pushState 触发回调 + urlchange 事件。', steps: [{ id: 'u1-push', label: 'pushState 改 URL' }, '看是否出现回调/事件行'], expect: '出现 onurlchange 回调行与 urlchange 事件行，url 含 __gmt_url' },
      { id: 'u2', api: 'window.onurlchange（hash）', desc: 'hash 变化触发。', steps: [{ id: 'u2-hash', label: '改 hash' }], expect: '出现携带新 hash 的回调/事件行' }
    ],
    actions: actions
  });
})();
```

- [ ] **Step 5: 建 notify-menu.user.js.src（4 卡）**

```javascript
// ==UserScript==
// @name         GM 手测·通知菜单
// @namespace    ai-browser-extend/gmt-manual
// @version      1.0.0
// @description  通知管理 + 菜单注销人工测试
// @match        *://*/*
// @run-at       document-end
// @grant        GM_notification
// @grant        GM_closeNotification
// @grant        GM_updateNotification
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_addStyle
// @noframes
// ==/UserScript==

(function () {
  var NID = 'gmt-notif-probe';
  var menuKey = null;
  var actions = {
    'n1-notify': function (log) {
      GM_notification({ title: 'GMT', text: '通知探针（3s 后自动更新）', tag: NID });
      log('n1', '已发通知（系统通知区）');
    },
    'n2-update': function (log) {
      GM_updateNotification(NID, { title: 'GMT（已更新）', text: '更新后的正文' });
      log('n2', '已请求更新通知（部分平台需通知仍在显示）');
    },
    'n3-close': function (log) {
      GM_closeNotification(NID);
      log('n3', '已请求关闭通知');
    },
    'n4-menu': function (log) {
      menuKey = GM_registerMenuCommand('GMT 探针命令', function () { GMT.log('n4', '菜单命令被点击'); });
      log('n4', '已注册菜单（侧边栏脚本页「菜单命令」区）；点「注销」后应消失');
    },
    'n5-unmenu': function (log) {
      if (menuKey == null) { log('n5', '先点上一步注册'); return; }
      GM_unregisterMenuCommand(menuKey);
      log('n5', '已注销菜单——去侧边栏确认命令项消失');
    }
  };

  GMT.render({
    module: 'notify-menu',
    title: 'GM 手测·通知菜单',
    cards: [
      { id: 'n1', api: 'GM_notification(details)', desc: '发系统通知。', steps: [{ id: 'n1-notify', label: '发通知' }], expect: '系统通知区出现「GMT」通知' },
      { id: 'n2', api: 'GM_updateNotification(id, details)', desc: '更新已发通知的标题/正文。', steps: [{ id: 'n2-update', label: '更新通知' }], expect: '通知标题变为「GMT（已更新）」' },
      { id: 'n3', api: 'GM_closeNotification(id)', desc: '关闭已发通知。', steps: [{ id: 'n3-close', label: '关闭通知' }], expect: '通知消失' },
      { id: 'n4', api: 'GM_registerMenuCommand(name, fn)', desc: '注册菜单命令（侧边栏脚本页）。', steps: [{ id: 'n4-menu', label: '注册菜单' }, '去侧边栏脚本页看「菜单命令」区'], expect: '侧边栏出现「GMT 探针命令」' },
      { id: 'n5', api: 'GM_unregisterMenuCommand(key)', desc: '注销菜单命令。', steps: [{ id: 'n5-unmenu', label: '注销菜单' }, '去侧边栏确认消失'], expect: '侧边栏菜单命令项消失' }
    ],
    actions: actions
  });
})();
```

- [ ] **Step 6: 构建 4 个新产物**

Run: `npm run build:manual`
Expected: 打印 4 个新 `built gmt-manual-*.user.js`（cookie/download/urlchange/notify-menu），无报错

- [ ] **Step 7: 更新 fixtures 护栏测试**

在 `tests/shared/gmt-manual-fixtures.test.ts` 顶部 import 段追加 4 组（产物 + 源）：

```typescript
import cookieText from '../../fixtures/userscripts/manual/gmt-manual-cookie.user.js?raw';
import downloadText from '../../fixtures/userscripts/manual/gmt-manual-download.user.js?raw';
import urlchangeText from '../../fixtures/userscripts/manual/gmt-manual-urlchange.user.js?raw';
import notifyMenuText from '../../fixtures/userscripts/manual/gmt-manual-notify-menu.user.js?raw';

import cookieSrc from '../../fixtures/userscripts/manual/cookie.user.js.src?raw';
import downloadSrc from '../../fixtures/userscripts/manual/download.user.js.src?raw';
import urlchangeSrc from '../../fixtures/userscripts/manual/urlchange.user.js.src?raw';
import notifyMenuSrc from '../../fixtures/userscripts/manual/notify-menu.user.js.src?raw';
```

`FIXTURES` 数组追加 4 条（grants 逐文件核对，且 storage/dom-resource/tabs 现有条目的 `cards`/`grants` 按 Task 13 更新）。先更新三个已扩展模块：

```typescript
  // storage: 7 → 10 卡，grants 加 4 个批量/移除 API
  { mod: 'storage', label: '值存储', cards: 10,
    grants: ['GM_info', 'GM_getValue', 'GM_setValue', 'GM_deleteValue', 'GM_listValues', 'GM_addValueChangeListener', 'GM_addStyle', 'GM_getValues', 'GM_setValues', 'GM_deleteValues', 'GM_removeValueChangeListener'],
    text: storageText, src: storageSrc },
  // dom-resource: 5 → 7 卡，grants 加 addElement/getResourceURL
  { mod: 'dom-resource', label: 'DOM资源日志', cards: 7,
    grants: ['GM_addStyle', 'GM_getResourceText', 'GM_log', 'GM_getValue', 'GM_setValue', 'GM_deleteValue', 'unsafeWindow', 'GM_addElement', 'GM_getResourceURL'],
    text: domResourceText, src: domResourceSrc },
  // tabs: 2 → 5 卡，grants 加 getTab 系 + window.close/focus
  { mod: 'tabs', label: '标签页', cards: 5,
    grants: ['GM_openInTab', 'GM_setValue', 'GM_getValue', 'GM_addStyle', 'GM_deleteValue', 'GM_getTab', 'GM_saveTab', 'GM_getTabs', 'window.close', 'window.focus'],
    text: tabsText, src: tabsSrc },
```

新增 4 条：

```typescript
  { mod: 'cookie', label: 'Cookie', cards: 3,
    grants: ['GM_cookie', 'GM_getValue', 'GM_setValue', 'GM_deleteValue', 'GM_addStyle'],
    text: cookieText, src: cookieSrc },
  { mod: 'download', label: '下载', cards: 1,
    grants: ['GM_download', 'GM_getValue', 'GM_setValue', 'GM_deleteValue', 'GM_addStyle'],
    text: downloadText, src: downloadSrc },
  { mod: 'urlchange', label: 'URL变化', cards: 2,
    grants: ['window.onurlchange', 'GM_getValue', 'GM_setValue', 'GM_deleteValue', 'GM_addStyle'],
    text: urlchangeText, src: urlchangeSrc },
  { mod: 'notify-menu', label: '通知菜单', cards: 5,
    grants: ['GM_notification', 'GM_closeNotification', 'GM_updateNotification', 'GM_registerMenuCommand', 'GM_unregisterMenuCommand', 'GM_getValue', 'GM_setValue', 'GM_deleteValue', 'GM_addStyle'],
    text: notifyMenuText, src: notifyMenuSrc },
```

> 注：dom-resource 现声明 `@connect www.google.com`（Task 13），若「解析零警告」用例对 connects 敏感需一并核对；`download` 的 `@connect cdn.jsdelivr.net`、`cookie`/`urlchange`/`notify-menu` 无 @connect。附加护栏（§末尾 describe）如需可补 `download` 的 @connect 断言。

- [ ] **Step 8: 运行 fixtures 护栏**

Run: `npx vitest run tests/shared/gmt-manual-fixtures.test.ts`
Expected: PASS（9 模块全部：解析零警告 / grants 并集且已注册 / 卡片数 / 体量 / 源同步）

- [ ] **Step 9: 全量测试 + 编译**

Run: `npm run test`
Expected: 全绿

Run: `npm run compile`
Expected: 无错误

- [ ] **Step 10: Commit**

```bash
git add fixtures/userscripts/manual/cookie.user.js.src fixtures/userscripts/manual/download.user.js.src fixtures/userscripts/manual/urlchange.user.js.src fixtures/userscripts/manual/notify-menu.user.js.src fixtures/userscripts/manual/gmt-manual-cookie.user.js fixtures/userscripts/manual/gmt-manual-download.user.js fixtures/userscripts/manual/gmt-manual-urlchange.user.js fixtures/userscripts/manual/gmt-manual-notify-menu.user.js tests/shared/gmt-manual-fixtures.test.ts
git commit -m "test(gm): 新增 cookie/download/urlchange/notify-menu 手测模块 + 护栏更新"
```

---

### Task 15: 文档更新（gm-api.md + CLAUDE.md）

**Files:**
- Modify: `docs/gm-api.md`（落地项「后续候选」→「已实现」，更新计数）
- Modify: `CLAUDE.md`（追加本次扩充的 Phase 记录段）

- [ ] **Step 1: gm-api.md 状态迁移**

把下列 API 的「本扩展」列从「后续候选」改为「已实现（Tier A/B）」，并在需要处补签名/差异：
- §2 值存储：`GM_removeValueChangeListener`、`GM_getValues`、`GM_setValues`、`GM_deleteValues`
- §3 页面与 DOM：`GM_addElement`、`window.close`、`window.focus`、`window.onurlchange`（后者标注「webNavigation 下行，仅主帧」）
- §4 资源：`GM_getResourceURL`（标注「data: URL，二进制经 base64 预取」）
- §5 菜单：`GM_unregisterMenuCommand`
- §6 网络：`GM_download`（标注「chrome.downloads + @connect 门控；onload/onerror，onprogress 暂缺」）、`GM_cookie.list/set/delete`（标注「@connect 门控复用，cookies 权限」）
- §7 标签页：`GM_getTab`、`GM_saveTab`、`GM_getTabs`（标注「storage.session per-tab」）
- §8 通知：`GM_closeNotification`、`GM_updateNotification`

§11 速览增补「Tier A+B 新增 14 函数 + 3 特殊 grant」小节；把开头「共 35 个函数型 API + 4 个特殊 grant」的支持状态统计更新为「已实现 29 函数 + 4 特殊 grant」。

- [ ] **Step 2: gm-api.md 加实现说明段**

在「Phase 5 实现说明」后新增「Tier A+B 实现说明（2026-09-07）」段，覆盖：
- `GM_cookie`/`GM_download` 门控复用 `@connect` + always-allow（与 `GM_xmlhttpRequest` 同库，授权同一 host 会同时覆盖三者）。
- `window.onurlchange`：SW `webNavigation.onHistoryStateUpdated`/`onReferenceFragmentUpdated` 主帧下行，`window.onurlchange` 属性 + `'urlchange'` 事件双形态。
- `GM_getTab/saveTab/getTabs`：`storage.session` per-tab，浏览器关闭清空。
- `GM_getResourceURL`：预取按 content-type 分文本/二进制（base64），返回完整 data: URL。
- 已知边界：download 无 onprogress；window.close/focus 作用于整 tab；urlchange 不覆盖 iframe。

- [ ] **Step 3: CLAUDE.md 追加 Phase 记录**

在 `CLAUDE.md` 「Phase 5（GM_* API + 管理器优化）已完成」段之后，追加一段（同格式）：

```markdown
GM API 扩充 Tier A+B（2026-09-07，`docs/superpowers/specs/2026-09-07-gm-api-expansion-tier-ab-design.md`）已完成：新增 14 函数型 API + 3 特殊 grant（注册表 15→29 函数 grant，特殊 grant 1→4）。Tier A（零新权限）：批量值 `GM_getValues/setValues/deleteValues`、`GM_removeValueChangeListener`、`GM_addElement`、`GM_unregisterMenuCommand`、`GM_getResourceURL`、`GM_getTab/saveTab/getTabs`（`background/gm-tab-store.ts`，storage.session per-tab）、`GM_closeNotification/updateNotification`、`window.close/focus`。Tier B（新权限）：`GM_download`（`background/gm-download.ts`，chrome.downloads + downloads 权限 + @connect 门控，onload/onerror，onprogress 暂缺）、`GM_cookie.list/set/delete`（`background/gm-cookie.ts`，cookies 权限 + @connect 门控复用，对象型 grant 一次装齐三方法）、`window.onurlchange`（`background/gm-urlchange.ts`，webNavigation 主帧导航下行 URL_CHANGE + `'urlchange'` 事件双形态）。manifest 加 downloads/cookies/webNavigation。预取管线（`background/gm-resources.ts`）扩二进制 base64+mime，`GM_getResourceURL` 拼完整 data: URL。手测 fixtures 扩 storage/dom-resource/tabs + 新增 cookie/download/urlchange/notify-menu 四模块（9 模块护栏）。已知边界：cookie/download/xhr 共用同一 @connect 授权库；download 无 onprogress；window.close/focus 作用整 tab；urlchange 仅主帧不覆盖 iframe。
```

- [ ] **Step 4: 全量测试 + 编译（最终门槛）**

Run: `npm run test`
Expected: 全绿

Run: `npm run compile`
Expected: 无错误

- [ ] **Step 5: Commit**

```bash
git add docs/gm-api.md CLAUDE.md
git commit -m "docs(gm): gm-api.md 落地项转已实现 + CLAUDE.md 追加 Tier A+B 记录"
```

---

## 自检记录（写完计划后的 fresh-eyes 检查）

- **Spec 覆盖：** §2 清单 14+3 → Task 1/3/4/5/6/7/8/9/10/11；§4 各层 → Task 1(注册表)/3-6(wrapper)/7/12；§5 子系统 → Task 8(tab-store)/9(cookie)/10(download)/11(urlchange)/2(预取)；§6 fixtures → Task 13/14；§7 测试 → 各 Task 内 TDD；§8 文档 → Task 15。无遗漏。
- **类型一致：** `WrapperDeps.resourceUrls?`（Task 3 定义，Task 12 传值）；`GmApiDef.objectApi?`（Task 1 定义，Task 5 用）；`GmEventKind` 加 `URL_CHANGE`（Task 1 定义，Task 6 wrapper 分发、Task 11 SW 发送）；短 api 名（SetValues/CookieList/Download/WindowClose…）在 wrapper（Task 4/5/6）与 `API_TO_GRANT`+switch（Task 7/9/10/11）两侧一致。
- **门控复用：** cookie（Task 9）/download（Task 10）均调 `matchConnectWithPermissions` + `enqueueConfirm`（kind:'connect'），与 XHR 同库——`ConfirmKind` 无需扩。
- **占位符扫描：** 无 TBD/TODO；每个改码步骤含完整代码与命令。
