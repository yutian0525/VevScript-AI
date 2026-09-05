# GM_llmChat（脚本调用大模型）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 GM_llmChat 桥接 API——用户脚本传文本/图片调大模型，支持流式 onChunk，经确认卡权限闸门（脚本级三档，默认每次询问），复用扩展 provider 配置。

**Architecture:** GM 桥三层链路（wrapper → ISOLATED 宿主透传 → SW 分发），SW 新 case 'LlmChat' 复用 `OpenAICompatProvider` 流式，chunk 经 `GM_EVENT('LLM_CHUNK')` 下行按通道号回传。权限档扩展现有 `local:gm:permissions`，确认卡走 `enqueueConfirm`。

**Tech Stack:** TypeScript / WXT / vitest v4 + fakeBrowser / React 19（设置 UI）

**规格：** `docs/superpowers/specs/2026-09-05-gm-llm-chat-design.md`
**工作区：** `D:\workspace-mou8\ai-browser-extend\.claude\worktrees\feat+script-optimize`（分支 feat/add-gm-ai）

**关键既有事实（实现者必读）：**
- `npm run compile` = TS 检查；`npm run test` = vitest。每 Task 结束两者都要过。
- wrapper 生成代码必须 ES5 风格（var/function，无箭头/模板串）——见 [shared/gm-wrapper.ts](shared/gm-wrapper.ts) 文件头注释。
- wrapper 已有握手 backlog 机制（`__GM_hostReady`/`__GM_backlog`/gmhost/gmhello），`__GM_post` 内部走 `__GM_send`。新增 API 必须经 `__GM_post`/`__GM_post_id`，不能直接 dispatchEvent。
- `handleGmCall` 的 `grantAllowed` 用 `API_TO_GRANT[api] ?? api` 查 `script.meta.grants`，`GRANT_EXEMPT` 豁免集不含新 API。
- 测试惯例：`fakeBrowser.reset()` + `vi.restoreAllMocks()` 起手；`handleGmCall` 直接调用（绕过消息层）；确认卡用 `__resetConfirmQueue()` + `getPending()` + `resolveConfirm()`。
- `OpenAICompatProvider.streamChat` 每次调用**恰好终止于一个 message-done**（可能前面有 error），消费者可 await 到 message-done 为止——这是 Task 5 有序性保证的基础。

---

### Task 1: 注册表 + 权限存储扩展（纯数据层）

**Files:**
- Modify: `shared/gm-apis.ts`（注册表加一行）
- Modify: `background/gm-permissions.ts`（llm 档三函数）
- Test: `tests/shared/gm-apis.test.ts`
- Test: `tests/background/gm-permissions.test.ts`

- [ ] **Step 1: 写 gm-apis 失败测试**

在 `tests/shared/gm-apis.test.ts` 现有 describe 内追加用例（先读文件确认插入点；若无合适 describe 就新建一个）：

```ts
describe('GM_llmChat 注册', () => {
  it('bridge 实现 + Promise 形态', () => {
    expect(GM_API_REGISTRY.GM_llmChat).toEqual({ impl: 'bridge', promiseForm: true });
  });
  it('classifyGrants 归为 supported', () => {
    const { supported, unsupported } = classifyGrants(['GM_llmChat', 'GM_fakeApi']);
    expect(supported).toEqual(['GM_llmChat']);
    expect(unsupported).toEqual(['GM_fakeApi']);
  });
});
```

（import 行若缺 `classifyGrants` / `GM_API_REGISTRY` 按文件现状补齐。）

- [ ] **Step 2: 写 gm-permissions 失败测试**

在 `tests/background/gm-permissions.test.ts` 末尾追加：

```ts
describe('llm 权限档', () => {
  beforeEach(() => fakeBrowser.reset());

  it('缺省 ask；set/get 往返', async () => {
    expect(await getLlmTier('s1')).toBe('ask'); // 无记录 → 默认每次询问
    await setLlmTier('s1', 'allow');
    expect(await getLlmTier('s1')).toBe('allow');
    await setLlmTier('s1', 'deny');
    expect(await getLlmTier('s1')).toBe('deny');
    expect(await getLlmTier('s2')).toBe('ask'); // 其它脚本不受影响
  });

  it('与 cors 共存：setLlmTier 不清 alwaysAllow，反之亦然', async () => {
    await setAlwaysAllow('s1', 'a.com');
    await setLlmTier('s1', 'allow');
    expect(await getAlwaysAllow('s1', 'a.com')).toBe(true);
    expect(await getLlmTier('s1')).toBe('allow');
  });

  it('removeScriptPermissions 连 llm 档一起删', async () => {
    await setLlmTier('s1', 'deny');
    await removeScriptPermissions('s1');
    expect(await getLlmTier('s1')).toBe('ask');
  });
});
```

（import 行追加 `getLlmTier, setLlmTier`。）

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run tests/shared/gm-apis.test.ts tests/background/gm-permissions.test.ts`
Expected: FAIL（`GM_llmChat` 为 undefined、`getLlmTier` 未导出）

- [ ] **Step 4: 实现**

`shared/gm-apis.ts` 的 `GM_API_REGISTRY` 末尾（`GM_xmlhttpRequest` 之后）加：

```ts
  GM_llmChat: { impl: 'bridge', promiseForm: true },
```

`background/gm-permissions.ts`：`PermissionsShape` 改为

```ts
interface PermissionsShape {
  [scriptId: string]: { cors: Record<string, 'allow'>; llm?: 'ask' | 'allow' | 'deny' };
}
```

文件末尾追加（`removeScriptPermissions` 语义不变，整条 delete 自然覆盖 llm 档）：

```ts
export type LlmTier = 'ask' | 'allow' | 'deny';

/** 脚本的 LLM 调用权限档（缺省 ask = 每次询问）。 */
export async function getLlmTier(scriptId: string): Promise<LlmTier> {
  const all = await readAll();
  return all[scriptId]?.llm ?? 'ask';
}

export async function setLlmTier(scriptId: string, tier: LlmTier): Promise<void> {
  const all = await readAll();
  const entry = all[scriptId] ?? { cors: {} };
  entry.llm = tier;
  all[scriptId] = entry;
  await storage.setItem(KEY, all);
}
```

- [ ] **Step 5: 跑测试确认通过 + compile**

Run: `npx vitest run tests/shared/gm-apis.test.ts tests/background/gm-permissions.test.ts && npm run compile`
Expected: 全 PASS，compile 无错

- [ ] **Step 6: Commit**

```bash
git add shared/gm-apis.ts background/gm-permissions.ts tests/shared/gm-apis.test.ts tests/background/gm-permissions.test.ts
git commit -m "feat(gm): GM_llmChat 注册表 + llm 权限档存储"
```

---

### Task 2: 桥协议 GmEventKind + wrapper 通道机制

**Files:**
- Modify: `shared/gm-bridge.ts`（GmEventKind + 'LLM_CHUNK'）
- Modify: `shared/gm-wrapper.ts`（__GM_inst / __GM_post_id / LLM_CHUNK 分支 / GM_llmChat 安装）
- Test: `tests/shared/gm-wrapper.test.ts`

- [ ] **Step 1: 写失败测试**

在 `tests/shared/gm-wrapper.test.ts` 末尾追加：

```ts
describe('GM_llmChat wrapper', () => {
  const opts = { token: 't', values: {}, resources: {}, requireCodes: [], extensionVersion: '1.0.0' };

  it('grant 精确安装：声明才安装，且带 LLM_CHUNK 通道注册/清理逻辑', () => {
    const code = buildWrappedCode(mkScript({ meta: { grants: ['GM_llmChat'] } }), opts);
    expect(code).toContain('install("GM_llmChat"');
    expect(code).toContain('__GM_plain_llm');
    expect(code).toContain("__GM_listeners.set('llmchan:' + chan");
    expect(code).toContain("__GM_listeners.delete('llmchan:' + chan");
    // 点形式 Promise 包装由 promiseForm 驱动
    expect(code).toContain('install("GM.llmChat"');
    // 未声明则不安装
    const code2 = buildWrappedCode(mkScript(), opts);
    expect(code2).not.toContain('install("GM_llmChat"');
  });

  it('preamble 含页实例 id（chan 前缀）+ 显式 reqId 版 __GM_post_id；__GM_post 委托它', () => {
    const code = buildWrappedCode(mkScript({ meta: { grants: ['GM_llmChat'] } }), opts);
    expect(code).toContain('var __GM_inst =');
    expect(code).toContain('function __GM_post_id(api, params, reqId)');
    expect(code).toMatch(/var reqId = \+\+__GM_reqSeq;\s*\n\s*return __GM_post_id\(api, params, reqId\);/);
  });

  it('gmevt 分发器含 LLM_CHUNK 分支（按 chan 找 llmchan: 监听）', () => {
    const code = buildWrappedCode(mkScript(), opts);
    expect(code).toContain("d.kind === 'LLM_CHUNK'");
    expect(code).toContain("__GM_listeners.get('llmchan:' + d.data.chan)");
  });

  it('onChunk 摘除后过桥：payload 里无 onChunk 键（__GM_plain_llm 摘函数语义）', () => {
    const code = buildWrappedCode(mkScript({ meta: { grants: ['GM_llmChat'] } }), opts);
    // __GM_plain_llm：先摘 onChunk 存闭包，再走 __GM_plain 清余下函数
    expect(code).toMatch(/function __GM_plain_llm\(v\) \{[\s\S]*?delete v\.onChunk[\s\S]*?return __GM_plain\(v\)/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/shared/gm-wrapper.test.ts`
Expected: 新 describe 4 个用例 FAIL

- [ ] **Step 3: 实现 gm-bridge.ts**

`GmEventKind` 改为：

```ts
export type GmEventKind = 'VALUE_CHANGE' | 'MENU_CLICK' | 'NOTIF_CLICK' | 'TAB_EVENT' | 'LLM_CHUNK';
```

- [ ] **Step 4: 实现 gm-wrapper.ts preamble 改动**

preamble 内 `var __GM_reqSeq = 0;` 之后加一行（ES5，勿用 crypto.randomUUID——需保持目标页面兼容面）：

```js
  var __GM_inst = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
```

`__GM_post` 拆为显式 reqId 版 + 自增包装（注意保留握手 backlog 逻辑在 `__GM_post_id` 内）：

```js
  function __GM_post_id(api, params, reqId) {
    return new Promise(function (resolve, reject) {
      __GM_pending.set(reqId, { resolve: resolve, reject: reject });
      var detail = { token: __GM_token, reqId: reqId, api: api, params: params };
      if (__GM_hostReady) __GM_send(detail);
      else __GM_backlog.push(detail);
    });
  }
  function __GM_post(api, params) {
    var reqId = ++__GM_reqSeq;
    return __GM_post_id(api, params, reqId);
  }
```

gmevt 分发器（`TAB_EVENT` 分支之后）加：

```js
    } else if (d.kind === 'LLM_CHUNK') {
      var lc = __GM_listeners.get('llmchan:' + d.data.chan);
      if (lc) lc(d.data.delta);
```

- [ ] **Step 5: 实现 GM_llmChat 安装表达式**

`GM_INSTALLS` 数组末尾加（注意整个表达式是单引号 JS 字符串，内部字符串用双引号）：

```ts
  // LLM 调用：onChunk 先摘出存闭包（函数不可过桥），chan = 页实例id:reqId 供 SW 下行 LLM_CHUNK 配对。
  // 成功/失败都清监听；不提供 abort（一次性语义，文档明示）。
  ['GM_llmChat', 'function (details) { var onChunk = details && typeof details.onChunk === "function" ? details.onChunk : null; var d = __GM_plain_llm(details); var reqId = ++__GM_reqSeq; var chan = __GM_inst + ":" + reqId; if (onChunk) __GM_listeners.set("llmchan:" + chan, onChunk); return __GM_post_id("LlmChat", [d], reqId).then(function (r) { if (onChunk) __GM_listeners.delete("llmchan:" + chan); return r; }, function (e) { if (onChunk) __GM_listeners.delete("llmchan:" + chan); throw e; }); }'],
```

preamble 内 `__GM_plain` 函数之后加辅助（浅拷贝摘 onChunk 再走通用摘函数）：

```js
  function __GM_plain_llm(v) {
    var copy = __GM_plain(v);
    if (copy && copy.onChunk !== undefined) delete copy.onChunk; // __GM_plain 已摘函数，防御 onChunk 为非函数值残留
    return copy;
  }
```

（注：`__GM_plain` 本身就会摘掉所有函数，`__GM_plain_llm` 的存在意义是语义显式 + 防御 onChunk 被塞了非函数可克隆值时混进 payload。）

- [ ] **Step 6: 跑测试 + compile**

Run: `npx vitest run tests/shared/gm-wrapper.test.ts && npm run compile`
Expected: 全 PASS（既有用例不受影响——`__GM_post` 行为等价重构）

- [ ] **Step 6b: gmt-selftest fixture 补 grant（连带修复）**

`fixtures/userscripts/gmt-selftest.user.js` 的 @grant 列表（`GM_xmlhttpRequest` 行后）加：

```
// @grant        GM_llmChat
```

`tests/shared/gmt-selftest-fixture.test.ts` 的「grants：14 个 API = 15 项」用例是按注册表动态计算的——grant 加上后自动绿；「buildWrappedCode 安装全部」用例依赖 Task 2 已落的安装表达式。跑：

Run: `npx vitest run tests/shared/gmt-selftest-fixture.test.ts`
Expected: PASS（若仍红，按断言消息定位——通常 fixture 里还有逐 API 安装断言列表需同步加 GM_llmChat）

- [ ] **Step 7: Commit**

```bash
git add shared/gm-bridge.ts shared/gm-wrapper.ts tests/shared/gm-wrapper.test.ts
git commit -m "feat(gm): wrapper GM_llmChat 安装 + LLM_CHUNK 通道机制"
```

---

### Task 3: SW 分发 case 'LlmChat'（校验/限幅/权限/确认卡）

**Files:**
- Modify: `background/gm-api.ts`（API_TO_GRANT、case 'LlmChat'、doLlmChat、llmSessionAllow）
- Modify: `shared/confirm.ts`（ConfirmKind 加 'llm'）
- Test: `tests/background/gm-api.test.ts`

- [ ] **Step 1: 写失败测试（参数校验 + grant）**

在 `tests/background/gm-api.test.ts` 末尾追加（`call`/`mkScript` 复用文件顶部既有 helper）：

```ts
describe('gm-api LlmChat 参数校验', () => {
  beforeEach(() => { fakeBrowser.reset(); vi.restoreAllMocks(); __resetConfirmQueue(); vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({} as never); });

  it('未 grant → permission not requested', async () => {
    await saveScript(mkScript()); // 只 grant GM_setValue
    const r = await call('LlmChat', [{ messages: [{ role: 'user', content: 'hi' }] }]);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('permission not requested') });
  });

  it('模型未配置 → 明确报错', async () => {
    await saveScript(mkScript({ meta: { grants: ['GM_llmChat'] } }));
    const r = await call('LlmChat', [{ messages: [{ role: 'user', content: 'hi' }] }]);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('模型未配置') });
  });

  it('messages 缺失/空 → 报错', async () => {
    await saveScript(mkScript({ meta: { grants: ['GM_llmChat'] } }));
    const r1 = await call('LlmChat', [{}]);
    const r2 = await call('LlmChat', [{ messages: [] }]);
    expect(r1).toMatchObject({ ok: false, error: expect.stringContaining('messages') });
    expect(r2).toMatchObject({ ok: false, error: expect.stringContaining('messages') });
  });

  it('非法 role / content 形状 / part type → 报错', async () => {
    await saveScript(mkScript({ meta: { grants: ['GM_llmChat'] } }));
    const bad = await call('LlmChat', [{ messages: [{ role: 'tool', content: 'x' }] }]);
    expect(bad).toMatchObject({ ok: false, error: expect.stringContaining('role') });
    const bad2 = await call('LlmChat', [{ messages: [{ role: 'user', content: 42 }] }]);
    expect(bad2).toMatchObject({ ok: false, error: expect.stringContaining('content') });
    const bad3 = await call('LlmChat', [{ messages: [{ role: 'user', content: [{ type: 'audio', text: 'x' }] }] }]);
    expect(bad3).toMatchObject({ ok: false, error: expect.stringContaining('type') });
  });

  it('图片超 5MB / 载荷超 2MB → 报错', async () => {
    await saveScript(mkScript({ meta: { grants: ['GM_llmChat'] } }));
    const big = 'data:image/png;base64,' + 'A'.repeat(5 * 1024 * 1024);
    const r1 = await call('LlmChat', [{ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: big } }] }] }]);
    expect(r1).toMatchObject({ ok: false, error: expect.stringContaining('图片过大') });
    const fat = 'x'.repeat(2 * 1024 * 1024 + 1);
    const r2 = await call('LlmChat', [{ messages: [{ role: 'user', content: fat }] }]);
    expect(r2).toMatchObject({ ok: false, error: expect.stringContaining('载荷过大') });
  });
});
```

（文件顶部 import 需追加 `__resetConfirmQueue` 与 `getPending`/`resolveConfirm`——来自 `../../background/confirm-queue`，与 gm-connect.test.ts 同款。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/background/gm-api.test.ts`
Expected: 新用例 FAIL（未知 GM API）

- [ ] **Step 3: 实现校验 + 权限决策（先不接 provider）**

`background/gm-api.ts` 分步改动：

3a. `API_TO_GRANT` 加 `LlmChat: 'GM_llmChat',`。

3b. `shared/confirm.ts` 的 `ConfirmKind` 改为：

```ts
export type ConfirmKind = 'connect' | 'llm'; // 将来扩展：| 'script-op' 等
```

3c. `background/gm-api.ts` import 区加：

```ts
import { OpenAICompatProvider } from '../agent/provider/openai-compat';
import type { ChatMessage, ContentPart, StreamEvent } from '../agent/provider/types';
import { getSettings } from '../storage/settings';
import { getLlmTier } from './gm-permissions';
```

3d. 内存态 + 纯校验函数（放 doXmlHttpRequest 之后）：

```ts
// ---- GM_llmChat（脚本调用大模型，spec docs/superpowers/specs/2026-09-05-gm-llm-chat-design.md）----

// 「本会话内允许」：SW 内存态，重启失效（与菜单表同款取舍）。档位变更时由 SCRIPTS_SET_LLM_TIER 清。
const llmSessionAllow = new Set<string>();

const LLM_IMAGE_MAX = 5 * 1024 * 1024;      // 单张 data URL 上限（base64 后）
const LLM_PAYLOAD_MAX = 2 * 1024 * 1024;    // 消息总载荷上限
const LLM_RESPONSE_MAX = 1024 * 1024;       // 响应聚合文本上限
const LLM_DEFAULT_TIMEOUT = 120_000;

/** 测试注入点：SW 内不可 mock import 的 provider 构造，经此替换。 */
let llmProviderFactory: (config: { baseUrl: string; apiKey: string; model: string; extraBody?: Record<string, unknown> }) => Pick<ReturnType<OpenAICompatProvider['streamChat']>, 'cancel'>> & { streamChat: OpenAICompatProvider['streamChat'] } =
  (config) => new OpenAICompatProvider(config);

/** 仅测试用：替换 provider 工厂。 */
export function __setLlmProviderFactory(f: typeof llmProviderFactory): void { llmProviderFactory = f; }

interface LlmDetails {
  messages?: unknown;
  timeout?: number;
}

function fail(msg: string): { ok: false; error: string } {
  return { ok: false, error: msg };
}

/** 参数校验 + 归一化为 ChatMessage[]。返回 union：失败带 error。 */
function validateLlmMessages(raw: unknown): { ok: true; messages: ChatMessage[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return fail('缺少 messages 或为空数组');
  const out: ChatMessage[] = [];
  for (const m of raw) {
    const role = (m as { role?: unknown })?.role;
    if (role !== 'system' && role !== 'user' && role !== 'assistant') {
      return fail(`非法 role: ${String(role)}（仅支持 system/user/assistant）`);
    }
    const content = (m as { content?: unknown })?.content;
    if (typeof content === 'string') { out.push({ role, content }); continue; }
    if (!Array.isArray(content)) return fail('非法 content（应为字符串或 {type,...} 数组）');
    const parts: ContentPart[] = [];
    for (const p of content) {
      const t = (p as { type?: unknown })?.type;
      if (t === 'text') {
        parts.push({ type: 'text', text: String((p as { text?: unknown })?.text ?? '') });
      } else if (t === 'image_url') {
        const url = String((p as { image_url?: { url?: unknown } })?.image_url?.url ?? '');
        if (url.startsWith('data:') && url.length > LLM_IMAGE_MAX) {
          return fail(`图片过大：${Math.round(url.length / 1024)}KB（上限 5MB）`);
        }
        parts.push({ type: 'image_url', imageUrl: url });
      } else {
        return fail(`非法 content part type: ${String(t)}`);
      }
    }
    out.push({ role, content: parts });
  }
  const payload = JSON.stringify(out);
  if (payload.length > LLM_PAYLOAD_MAX) {
    return fail(`消息载荷过大：${Math.round(payload.length / 1024)}KB（上限 2MB）`);
  }
  return { ok: true, messages: out };
}
```

- [ ] **Step 4: 实现权限档决策 + 确认卡（仍不接 provider）**

继续在 doLlmChat 前加：

```ts
/** 权限档决策：deny 拒 / allow 放 / ask 查 session 表，未命中弹确认卡。 */
async function llmGate(scriptId: string, scriptName: string, msgCount: number, payloadKB: number): Promise<{ ok: true } | { ok: false; error: string }> {
  const tier = await getLlmTier(scriptId);
  if (tier === 'deny') return fail('permission denied: 大模型调用已被用户拒绝（可在脚本详情 → 设置 → 模型调用 改档位）');
  if (tier === 'allow') return { ok: true };
  if (llmSessionAllow.has(scriptId)) return { ok: true };
  const choice = await enqueueConfirm({
    kind: 'llm',
    title: '大模型调用确认',
    message: `脚本「${scriptName}」请求调用大模型`,
    rows: [
      { label: '脚本', value: scriptName },
      { label: '模型', value: (await getSettings()).provider.model || '（未配置）', mono: true },
      { label: '消息数', value: String(msgCount), mono: true },
      { label: '载荷', value: `${payloadKB}KB`, mono: true },
    ],
    actions: [
      { decision: 'allow-once', label: '允许一次', variant: 'primary' },
      { decision: 'session', label: '本会话内允许' },
      { decision: 'deny', label: '拒绝', variant: 'danger', countdown: true },
    ],
    timeoutMs: 60_000,
  });
  if (choice === 'session') { llmSessionAllow.add(scriptId); return { ok: true }; }
  if (choice === 'allow-once') return { ok: true };
  return fail('permission denied: 大模型调用已被用户拒绝（可在脚本详情 → 设置 → 模型调用 改档位）');
}
```

- [ ] **Step 5: 实现 doLlmChat 主体 + switch 接线**

```ts
async function doLlmChat(
  scriptId: string, params: unknown[], sender: Sender,
): Promise<{ ok: true; data?: unknown } | { ok: false; error: string }> {
  const details = (params[0] ?? {}) as LlmDetails;
  const v = validateLlmMessages(details.messages);
  if (!v.ok) return v;
  const script = await getScript(scriptId);
  if (!script) return fail('脚本不存在');

  const { provider } = await getSettings();
  if (!provider.baseUrl || !provider.apiKey || !provider.model) {
    return fail('模型未配置：请到侧边栏 设置 → 模型设置 配置后重试');
  }
  const payloadKB = Math.round(JSON.stringify(v.messages).length / 1024);
  const gate = await llmGate(scriptId, script.name, v.messages.length, payloadKB);
  if (!gate.ok) return gate;

  const tabId = sender?.tab?.id;
  const chan = params[1] as string | undefined; // wrapper 传的通道号（见 Task 6 直调兼容）
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('timeout')), details.timeout ?? LLM_DEFAULT_TIMEOUT);

  // chunk 下行 promise 链：保证 gmres resolve 晚于所有 LLM_CHUNK（时序不变量）
  let chain: Promise<void> = Promise.resolve();
  const enqueueChunk = (delta: string): void => {
    chain = chain.then(() =>
      tabId != null && chan ? sendGmEvent(tabId, scriptId, 'LLM_CHUNK', { chan, delta }) : undefined,
    );
  };

  let text = '';
  let usage: { promptTokens?: number; completionTokens?: number } | undefined;
  let finishReason: string | undefined;
  let streamError: string | undefined;

  try {
    const p = llmProviderFactory(provider);
    p.streamChat({ messages: v.messages, tools: [], signal: ac.signal }, (ev: StreamEvent) => {
      if (ev.type === 'text-delta') {
        text += ev.text;
        if (text.length > LLM_RESPONSE_MAX) { ac.abort(new Error('response-too-large')); return; }
        enqueueChunk(ev.text);
      } else if (ev.type === 'message-done') {
        usage = ev.usage; finishReason = ev.finishReason;
      } else if (ev.type === 'error') {
        streamError = ev.error;
      }
      // reasoning-delta 忽略（不下发）
    });
    await chain;
  } finally {
    clearTimeout(timer);
  }

  if (text.length > LLM_RESPONSE_MAX) return fail('响应过大：超 1MB 上限');
  if (ac.signal.reason instanceof Error && ac.signal.reason.message === 'timeout') {
    return fail(`LLM 调用超时（${details.timeout ?? LLM_DEFAULT_TIMEOUT}ms）`);
  }
  if (streamError) return fail(`LLM 调用失败: ${streamError}`);
  return { ok: true, data: { text, usage, finishReason } };
}
```

`handleGmCall` 的 switch 在 `case 'XmlHttpRequest':` 之前加：

```ts
    case 'LlmChat':
      return doLlmChat(scriptId, params, sender);
```

- [ ] **Step 6: 写权限/确认卡测试（接着 Step 1 的 describe 追加）**

```ts
describe('gm-api LlmChat 权限档', () => {
  beforeEach(() => {
    fakeBrowser.reset(); vi.restoreAllMocks(); __resetConfirmQueue();
    vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({} as never);
    // 注入 fake provider：立即 text-delta 两段 + message-done
    __setLlmProviderFactory(() => ({
      streamChat: (_params: unknown, onEvent: (ev: { type: string; text?: string; usage?: unknown; finishReason?: string; error?: string }) => void) => {
        queueMicrotask(() => {
          onEvent({ type: 'text-delta', text: '你' });
          onEvent({ type: 'text-delta', text: '好' });
          onEvent({ type: 'message-done', usage: { promptTokens: 3, completionTokens: 2 }, finishReason: 'stop' });
        });
        return { cancel: () => {} };
      },
    }));
  });

  it('deny 档直接拒绝（不弹卡、不调 provider）', async () => {
    await saveScript(mkScript({ meta: { grants: ['GM_llmChat'] } }));
    await setLlmTier('s1', 'deny');
    const r = await call('LlmChat', [{ messages: [{ role: 'user', content: 'hi' }] }]);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('permission denied') });
    expect(getPending()).toHaveLength(0);
  });

  it('allow 档直通', async () => {
    await saveScript(mkScript({ meta: { grants: ['GM_llmChat'] } }));
    await setLlmTier('s1', 'allow');
    // settings 里无 provider 配置——用 saveSettings 造一份
    const { saveSettings } = await import('../../storage/settings');
    await saveSettings({ provider: { baseUrl: 'https://api.test/v1', apiKey: 'k', model: 'm' } });
    const r = await call('LlmChat', [{ messages: [{ role: 'user', content: 'hi' }] }]);
    expect(r).toEqual({ ok: true, data: { text: '你好', usage: { promptTokens: 3, completionTokens: 2 }, finishReason: 'stop' } });
  });

  it('ask 档：弹卡 → deny 决策拒绝；allow-once 一次放行；session 后免卡', async () => {
    const { saveSettings } = await import('../../storage/settings');
    await saveSettings({ provider: { baseUrl: 'https://api.test/v1', apiKey: 'k', model: 'm' } });
    await saveScript(mkScript({ meta: { grants: ['GM_llmChat'] } }));
    const okParams = [{ messages: [{ role: 'user', content: 'hi' }] }, 'inst1:1'];

    const p1 = call('LlmChat', okParams);
    await new Promise((r) => setTimeout(r, 10));
    const confirms = getPending();
    expect(confirms).toHaveLength(1);
    expect(confirms[0]).toMatchObject({ kind: 'llm', title: '大模型调用确认' });
    resolveConfirm(confirms[0]!.confirmId, 'deny');
    expect(await p1).toMatchObject({ ok: false, error: expect.stringContaining('permission denied') });

    const p2 = call('LlmChat', okParams);
    await new Promise((r) => setTimeout(r, 10));
    resolveConfirm(getPending()[0]!.confirmId, 'allow-once');
    expect(await p2).toMatchObject({ ok: true });

    const r3 = await call('LlmChat', okParams); // session 已记？
    // allow-once 不记 session —— 第三次仍弹卡；先 resolve session 一次再验证免卡
    await new Promise((r) => setTimeout(r, 10));
    resolveConfirm(getPending()[0]!.confirmId, 'session');
    expect(await r3).toMatchObject({ ok: true });
    const r4 = await call('LlmChat', okParams);
    expect(await r4).toMatchObject({ ok: true });
    expect(getPending()).toHaveLength(0);
  });
});
```

（注意：`session` 记忆验证依赖上面 `llmSessionAllow` 是模块级 Set——测试间要防串：beforeEach 里加 `__resetLlmSession()`。在 gm-api.ts 的 `__setLlmProviderFactory` 旁边导出：

```ts
/** 仅测试用：清 session 授权表。 */
export function __resetLlmSession(): void { llmSessionAllow.clear(); }
```

并在本 describe 的 beforeEach 调 `__resetLlmSession()`。上一用例「allow-once 一次放行」后的 r3 断言链已含第三次弹卡 resolve 'session'，逻辑成立但阅读绕——如实现时觉得难读，可拆成两个 it。）

- [ ] **Step 7: 跑全部 gm-api 测试 + compile**

Run: `npx vitest run tests/background/gm-api.test.ts && npm run compile`
Expected: 全 PASS

- [ ] **Step 8: Commit**

```bash
git add background/gm-api.ts shared/confirm.ts tests/background/gm-api.test.ts
git commit -m "feat(gm): LlmChat SW 分发——校验/限幅/三档权限/确认卡 + fake provider 注入"
```

---

### Task 4: chunk 下行有序性 + 超时/响应超限测试

**Files:**
- Modify: `tests/background/gm-api.test.ts`（追加用例）

- [ ] **Step 1: 写有序性失败测试**

在 `tests/background/gm-api.test.ts` 追加：

```ts
describe('gm-api LlmChat 流式下行', () => {
  beforeEach(() => {
    fakeBrowser.reset(); vi.restoreAllMocks(); __resetConfirmQueue(); __resetLlmSession();
    vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({} as never);
    const { saveSettings } = await import('../../storage/settings');
    await saveSettings({ provider: { baseUrl: 'https://api.test/v1', apiKey: 'k', model: 'm' } });
    await saveScript(mkScript({ meta: { grants: ['GM_llmChat'] } }));
    await setLlmTier('s1', 'allow');
  });

  it('chunk 有序：LLM_CHUNK 按序到达 tab，gmres 晚于全部 chunk；chan 原样回显', async () => {
    const tabSpy = vi.spyOn(browser.tabs, 'sendMessage').mockResolvedValue(undefined as never);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    __setLlmProviderFactory(() => ({
      streamChat: (_p: unknown, onEvent: (ev: { type: string; text?: string }) => void) => {
        void gate.then(() => {
          onEvent({ type: 'text-delta', text: 'a' });
          onEvent({ type: 'text-delta', text: 'b' });
          onEvent({ type: 'message-done' });
        });
        return { cancel: () => {} };
      },
    }));
    const pending = call('LlmChat', [{ messages: [{ role: 'user', content: 'hi' }] }, 'inst9:7']);
    await new Promise((r) => setTimeout(r, 10)); // 让 provider 流先起（chunk 被 gate 挡住）
    release();
    const r = await pending as { ok: boolean; data?: { text: string } };
    expect(r).toMatchObject({ ok: true, data: { text: 'ab' } });
    const chunks = tabSpy.mock.calls
      .filter((c) => (c[1] as { kind?: string })?.kind === 'LLM_CHUNK')
      .map((c) => (c[1] as { data: { chan: string; delta: string } }).data);
    expect(chunks).toEqual([
      { chan: 'inst9:7', delta: 'a' },
      { chan: 'inst9:7', delta: 'b' },
    ]);
  });

  it('响应超 1MB：cancel 流并报「响应过大」', async () => {
    let cancelled = false;
    __setLlmProviderFactory(() => ({
      streamChat: (_p: unknown, onEvent: (ev: { type: string; text?: string }) => void) => {
        queueMicrotask(() => {
          onEvent({ type: 'text-delta', text: 'x'.repeat(1024 * 1024 + 1) });
          onEvent({ type: 'message-done' });
        });
        return { cancel: () => { cancelled = true; } };
      },
    }));
    const r = await call('LlmChat', [{ messages: [{ role: 'user', content: 'hi' }] }]);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('响应过大') });
    expect(cancelled).toBe(true);
  });

  it('provider error 事件 → 「LLM 调用失败:」前缀', async () => {
    __setLlmProviderFactory(() => ({
      streamChat: (_p: unknown, onEvent: (ev: { type: string; error?: string }) => void) => {
        queueMicrotask(() => { onEvent({ type: 'error', error: 'HTTP 500: boom' }); onEvent({ type: 'message-done' }); });
        return { cancel: () => {} };
      },
    }));
    const r = await call('LlmChat', [{ messages: [{ role: 'user', content: 'hi' }] }]);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('HTTP 500: boom') });
  });
});
```

- [ ] **Step 2: 跑测试**

Run: `npx vitest run tests/background/gm-api.test.ts`
Expected: PASS（Task 3 已实现行为；若有序性用例失败，检查 doLlmChat 的 `await chain` 是否漏写）

- [ ] **Step 3: Commit**

```bash
git add tests/background/gm-api.test.ts
git commit -m "test(gm): LlmChat 流式有序性/响应超限/错误透传"
```

---

### Task 5: 权限设置消息 + UI（脚本详情页「模型调用」区）

**Files:**
- Modify: `shared/messages.ts`（ScriptsRequest 两消息）
- Modify: `background/scripts.ts`（两 handler，档位变更清 session）
- Modify: `components/detail/DetailSettingsTab.tsx`（模型调用区）
- Test: `tests/background/scripts-settings.test.ts`（若无此文件则看现有 scripts 相关测试文件名，跟随现状放）

- [ ] **Step 1: 消息类型**

`shared/messages.ts` 的 `ScriptsRequest` union 中 `SCRIPTS_REVOKE_PERMISSION` 行后加：

```ts
  | { type: 'SCRIPTS_GET_LLM_TIER'; id: string }
  | { type: 'SCRIPTS_SET_LLM_TIER'; id: string; tier: 'ask' | 'allow' | 'deny' }
```

- [ ] **Step 2: 写 handler 测试**

新建 `tests/background/scripts-llm-tier.test.ts`（惯例照 tests/background/scripts.test.ts：`new MessageRouter()` + `initScriptsModule(router)` + `router.dispatch` 验证；`initScriptsModule` 会触发启动 sync——需装 fakeUserScripts 或 spy tabs 监听，照 scripts.test.ts 的 `installFakeUserScripts`/spy 写法处理）：

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { MessageRouter } from '../../background/router';
import { initScriptsModule } from '../../background/scripts';
import { getLlmTier, setLlmTier } from '../../background/gm-permissions';
import { saveScript } from '../../storage/scripts';
import type { UserScript } from '../../shared/types';

function mkScript(over: Partial<UserScript> = {}): UserScript {
  return {
    id: 's1', text: '', name: 't', enabled: true, matches: ['https://a.com/*'], code: '',
    runAt: 'document_idle', world: 'USER_SCRIPT', source: 'user', createdAt: 1, updatedAt: 1,
    meta: {}, ...over,
  };
}

describe('SCRIPTS_GET/SET_LLM_TIER', () => {
  beforeEach(() => { fakeBrowser.reset(); vi.restoreAllMocks(); });

  it('get 缺省 ask；set 往返；dispatch 不报 no handler', async () => {
    await saveScript(mkScript());
    vi.spyOn(browser.tabs.onUpdated, 'addListener').mockImplementation(() => {});
    vi.spyOn(browser.tabs.onRemoved, 'addListener').mockImplementation(() => {});
    const router = new MessageRouter();
    initScriptsModule(router);

    const r1 = await router.dispatch({ type: 'SCRIPTS_GET_LLM_TIER', id: 's1' } as never);
    expect(r1).toEqual({ ok: true, data: { tier: 'ask' } });
    await router.dispatch({ type: 'SCRIPTS_SET_LLM_TIER', id: 's1', tier: 'deny' } as never);
    expect(await getLlmTier('s1')).toBe('deny');
    const r2 = await router.dispatch({ type: 'SCRIPTS_GET_LLM_TIER', id: 's1' } as never);
    expect(r2).toEqual({ ok: true, data: { tier: 'deny' } });
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run tests/background/scripts-llm-tier.test.ts`
Expected: FAIL（`SCRIPTS_GET_LLM_TIER` 无 handler，dispatch 报 no handler）

- [ ] **Step 4: 实现 handler**

`background/scripts.ts` 的 `SCRIPTS_REVOKE_PERMISSION` handler 后加：

```ts
  // 脚本详情页「模型调用」档位：读档 + 写档（写档同时清该脚本的会话内授权，档位优先）
  router.on('SCRIPTS_GET_LLM_TIER', async (msg) => {
    const { id } = msg as unknown as { id: string };
    return { ok: true, data: { tier: await getLlmTier(id) } };
  });

  router.on('SCRIPTS_SET_LLM_TIER', async (msg) => {
    const { id, tier } = msg as unknown as { id: string; tier: 'ask' | 'allow' | 'deny' };
    await setLlmTier(id, tier);
    __resetLlmSessionFor(id); // 见下：gm-api 导出
    return { ok: true };
  });
```

import 行改：`import { listAllowedHosts, revokeHost, removeScriptPermissions, getLlmTier, setLlmTier } from './gm-permissions';`
并在 `background/gm-api.ts` 加导出（`__resetLlmSession` 旁）：

```ts
/** 档位变更时清单脚本的会话内授权（scripts.ts SCRIPTS_SET_LLM_TIER 调用）。 */
export function __resetLlmSessionFor(scriptId: string): void { llmSessionAllow.delete(scriptId); }
```

- [ ] **Step 5: UI——DetailSettingsTab 加「模型调用」区**

`components/detail/DetailSettingsTab.tsx` 改造（完整目标形态）：

```tsx
// components/detail/DetailSettingsTab.tsx
// 设置 Tab：XHR 安全（授权域名查看/撤销）+ 模型调用权限档（三选一）。
import { useEffect, useState } from 'react';
import { Undo2, ShieldOff, Bot } from 'lucide-react';
import { Button } from '../ui/Button';
import { sendScriptsRequest } from '../../stores/scripts';
import { DetailTabHeader } from './DetailTabHeader';
import { DetailEmptyCard } from './DetailEmptyCard';

type LlmTier = 'ask' | 'allow' | 'deny';

const TIER_OPTIONS: Array<{ value: LlmTier; label: string; hint: string }> = [
  { value: 'ask', label: '每次询问', hint: '每次调用弹确认卡（默认）' },
  { value: 'allow', label: '始终允许', hint: '不弹卡直接放行' },
  { value: 'deny', label: '始终拒绝', hint: '调用直接报错' },
];

export function DetailSettingsTab({ id }: { id: string }) {
  const [hosts, setHosts] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [tier, setTier] = useState<LlmTier>('ask');
  const [tierBusy, setTierBusy] = useState(false);

  async function pull(): Promise<void> {
    setLoading(true);
    try {
      const resp = await sendScriptsRequest<{ ok: boolean; data?: { hosts: string[] }; error?: string }>({
        type: 'SCRIPTS_GET_PERMISSIONS', id,
      });
      setHosts(resp.ok ? resp.data?.hosts ?? [] : []);
      const t = await sendScriptsRequest<{ ok: boolean; data?: { tier: LlmTier }; error?: string }>({
        type: 'SCRIPTS_GET_LLM_TIER', id,
      });
      if (t.ok && t.data) setTier(t.data.tier);
    } catch {
      setHosts([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void pull(); }, [id]);

  async function revoke(host: string): Promise<void> {
    setMessage('');
    try {
      const resp = await sendScriptsRequest<{ ok: boolean; error?: string }>({ type: 'SCRIPTS_REVOKE_PERMISSION', id, host });
      if (resp.ok) await pull();
      else setMessage(resp.error ?? `撤销 ${host} 失败`);
    } catch {
      setMessage(`撤销 ${host} 失败`);
    }
  }

  async function changeTier(next: LlmTier): Promise<void> {
    setTierBusy(true);
    setMessage('');
    try {
      const resp = await sendScriptsRequest<{ ok: boolean; error?: string }>({ type: 'SCRIPTS_SET_LLM_TIER', id, tier: next });
      if (resp.ok) setTier(next);
      else setMessage(resp.error ?? '设置失败');
    } catch {
      setMessage('设置失败');
    } finally {
      setTierBusy(false);
    }
  }

  return (
    <div className="detail__info">
      <DetailTabHeader
        title="模型调用"
        hint="脚本调用大模型（GM_llmChat）的权限档。「始终允许/拒绝」立即生效；改档会同时清除已给的「本会话内允许」授权。"
      />
      {message && <div className="scripts-warnline" role="status">{message}</div>}
      <div className="detail__hostlist">
        {TIER_OPTIONS.map((opt) => (
          <div key={opt.value} className="detail__hostrow" style={tier === opt.value ? { borderColor: 'var(--signal)' } : undefined}>
            <span>
              <span style={{ fontWeight: 500 }}>{opt.label}</span>
              <span style={{ color: 'var(--ink-3)', marginLeft: 8, fontSize: 12 }}>{opt.hint}</span>
            </span>
            <Button
              variant={tier === opt.value ? 'primary' : 'ghost'}
              disabled={tierBusy || tier === opt.value}
              onClick={() => void changeTier(opt.value)}
            >
              {tier === opt.value ? '当前' : '选用'}
            </Button>
          </div>
        ))}
      </div>

      <DetailTabHeader
        title="XHR 安全"
        hint="这些域名已获得该脚本的跨域请求授权（在确认卡点「总是允许」时记录）；撤销后，脚本再请求这些域名会重新弹确认。"
      />
      {loading ? (
        <div className="chat__empty">加载中…</div>
      ) : hosts.length === 0 ? (
        <DetailEmptyCard icon={ShieldOff} title="无已授权域名" hint="脚本请求跨域时将逐次询问" />
      ) : (
        <div className="detail__hostlist">
          {hosts.map((h) => (
            <div key={h} className="detail__hostrow">
              <span className="mono">{h}</span>
              <Button variant="ghost" aria-label={`撤销 ${h}`} onClick={() => void revoke(h)}>
                <Undo2 size={13} /> 撤销
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

（`Bot` import 若未用到则删——以 `npm run compile` 干净为准。Button variants 实为 `'primary' | 'secondary' | 'signal' | 'danger' | 'ghost'`，上方代码的 `variant={tier === opt.value ? 'primary' : 'ghost'}` 合法。）

- [ ] **Step 6: 跑测试 + compile**

Run: `npx vitest run tests/background/scripts-llm-tier.test.ts && npm run compile`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add shared/messages.ts background/scripts.ts background/gm-api.ts components/detail/DetailSettingsTab.tsx tests/background/scripts-llm-tier.test.ts
git commit -m "feat(gm): 模型调用权限档设置——消息对 + 详情页 UI（改档清会话授权）"
```

---

### Task 6: 直调兼容（chan 缺省路径）+ 调试台 CALL 表 + API_TO_GRANT 断言

**Files:**
- Modify: `components/scriptdebug/ScriptDebugPage.tsx`（CALL 表加 GM_llmChat 条目——否则 call-registry-parity 测试红且调试台渲染该行时 `CALL[name]!` 非空断言运行时崩）
- Modify: `tests/background/gm-debug.test.ts`（追加用例）

先读 `components/scriptdebug/ScriptDebugPage.tsx` 的 CALL 表形状（现有条目如 `XmlHttpRequest: { kind: 'bridge', short: 'XmlHttpRequest', hint: '[{url:"..."}]' }`——以实际字段为准），在 CALL 表加：

```ts
  GM_llmChat: { kind: 'bridge', short: 'LlmChat', hint: '[{"messages":[{"role":"user","content":"hi"}]}]' },
```

跑 `npx vitest run tests/scriptdebug/call-registry-parity.test.ts` 确认绿。

说明：debugCall 走真实桥但无 wrapper——params 里没有 chan，`doLlmChat` 的 `const chan = params[1]` 为 undefined，chunk 静默不下发（`chan ? ... : undefined`），仅返回终值。这正是规格 §7.1「直调 = 非流式语义」。本 Task 用测试锁死该行为，并断言 grant 映射。

- [ ] **Step 1: 写测试**

先读 `tests/background/gm-debug.test.ts` 文件头确认 import 与 mkScript 形状（该文件已有 `initGmApi` 挂 router 的惯例），然后末尾追加（import 需追加：`__setLlmProviderFactory` 来自 `../../background/gm-api`、`setLlmTier` 来自 `../../background/gm-permissions`、`saveSettings` 来自 `../../storage/settings`；mkScript/`call`/`handleGmCall` 等复用文件既有 helper，若无则照 gm-api.test.ts 抄）：

```ts
describe('LlmChat 直调（调试台）', () => {
  it('无 chan 参数：chunk 不下发、终值照常返回', async () => {
    // beforeEach 里的 provider fake 由本 describe 自建（若文件已有 provider fake 惯例则跟随）
    const { saveSettings } = await import('../../storage/settings');
    await saveSettings({ provider: { baseUrl: 'https://api.test/v1', apiKey: 'k', model: 'm' } });
    await saveScript(mkScript({ meta: { grants: ['GM_llmChat'] } }));
    await setLlmTier('s1', 'allow');
    const tabSpy = vi.spyOn(browser.tabs, 'sendMessage').mockResolvedValue(undefined as never);
    __setLlmProviderFactory(() => ({
      streamChat: (_p: unknown, onEvent: (ev: { type: string; text?: string }) => void) => {
        queueMicrotask(() => { onEvent({ type: 'text-delta', text: '直调' }); onEvent({ type: 'message-done' }); });
        return { cancel: () => {} };
      },
    }));
    const r = await handleGmCall(
      { scriptId: 's1', api: 'LlmChat', reqId: 1, params: [{ messages: [{ role: 'user', content: 'hi' }] }] },
      { tab: { id: 1, url: 'https://a.com/' } } as never,
    );
    expect(r).toMatchObject({ ok: true, data: { text: '直调' } });
    expect(tabSpy.mock.calls.filter((c) => (c[1] as { kind?: string })?.kind === 'LLM_CHUNK')).toHaveLength(0);
  });

  it('API_TO_GRANT：LlmChat 映射 GM_llmChat（经 grantAllowed 间接验证）', async () => {
    await saveScript(mkScript()); // 无 GM_llmChat grant
    const r = await handleGmCall(
      { scriptId: 's1', api: 'LlmChat', reqId: 1, params: [{ messages: [{ role: 'user', content: 'x' }] }] },
      { tab: { id: 1, url: 'https://a.com/' } } as never,
    );
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('permission not requested: LlmChat') });
  });
});
```

（注：本 describe 需自带 beforeEach——`fakeBrowser.reset()`、`vi.restoreAllMocks()`、`__resetConfirmQueue()`、`__resetLlmSession()`、`vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({} as never)`，照 gm-api.test.ts 惯例。）

- [ ] **Step 2: 跑测试**

Run: `npx vitest run tests/background/gm-debug.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add components/scriptdebug/ScriptDebugPage.tsx tests/background/gm-debug.test.ts
git commit -m "feat(gm): LlmChat 直调无 chan 静默下行 + 调试台 CALL 表 + grant 映射断言"
```

---

### Task 7: 手测脚本 + 文档

**Files:**
- Create: `fixtures/userscripts/manual/llm.user.js.src`
- Modify: `docs/gm-api.md`
- Build: `node scripts/build-manual.mjs`

- [ ] **Step 1: 写手测脚本源**

创建 `fixtures/userscripts/manual/llm.user.js.src`（遵循既有 `<module>.user.js.src` 格式：元头 + 正文，`build-manual.mjs` 会拼 `_panel-core.js`。卡片 API 形状照 `storage.user.js.src`——`{ id, api, desc, steps, expect }`，steps 可为字符串或 `{ id, label }`，actions 是 `id → fn(log)` 表，日志用 `GMT.log(cardId, text)`）：

```
// ==UserScript==
// @name         GM 手测·大模型
// @namespace    ai-browser-extend/gmt-manual
// @version      1.0.0
// @description  GM_llmChat 模块人工测试：说明 + 步骤 + 人工标记
// @match        *://*/*
// @run-at       document-end
// @grant        GM_llmChat
// @grant        GM_log
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @noframes
// ==/UserScript==

(function () {
  var MSGL = [{ role: 'user', content: '用一句话介绍你自己' }];

  function colorDataUrl(size, color) {
    var c = document.createElement('canvas');
    c.width = size; c.height = size;
    var ctx = c.getContext('2d');
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, size, size);
    return c.toDataURL('image/png');
  }

  // l6 用：无 GM_llmChat grant 的临时脚本（人工导入触发 permission not requested）
  var NO_GRANT_SRC = [
    '// ==UserScript==',
    '// @name         GM 手测·llm无授权',
    '// @namespace    ai-browser-extend/gmt-manual',
    '// @version      1.0.0',
    '// @description  触发 permission not requested 的临时脚本（测完删除）',
    '// @match        *://*/*',
    '// @run-at       document-end',
    '// @grant        GM_log',
    '// @noframes',
    '// ==/UserScript==',
    '',
    '(function () {',
    '  GM_log("即将调用未授权 API");',
    '  try { GM_llmChat({ messages: [{ role: "user", content: "hi" }] }).then(function (r) { GM_log("意外成功：" + JSON.stringify(r)); }, function (e) { GM_log("预期报错：" + e.message); }); } catch (e) { GM_log("预期报错(未安装)：" + e.message); }',
    '})();'
  ].join('\n');

  var actions = {
    'l1-text': function (log) {
      GM_llmChat({ messages: MSGL }).then(function (r) {
        log('l1', 'text=' + r.text + ' | usage=' + JSON.stringify(r.usage) + ' | finish=' + r.finishReason);
      }, function (e) { log('l1', '失败：' + e.message); });
      log('l1', '已发起（等 Promise）…');
    },
    'l2-stream': function (log) {
      var n = 0;
      GM_llmChat({ messages: MSGL, onChunk: function (d) { n++; log('l2', 'chunk#' + n + ': ' + d); } }).then(function (r) {
        log('l2', '终值 text=' + r.text);
      }, function (e) { log('l2', '失败：' + e.message); });
      log('l2', '已发起（等流）…');
    },
    'l3-image': function (log) {
      GM_llmChat({
        messages: [{ role: 'user', content: [
          { type: 'text', text: '图里是什么颜色的方块？只答颜色。' },
          { type: 'image_url', image_url: { url: colorDataUrl(64, '#e53935') } },
        ] }],
      }).then(function (r) { log('l3', '回答：' + r.text); }, function (e) { log('l3', '失败：' + e.message); });
      log('l3', '已发起…');
    },
    'l4-deny': function (log) {
      GM_llmChat({ messages: MSGL }).then(function (r) {
        log('l4', '意外成功：' + r.text);
      }, function (e) { log('l4', '预期报错：' + e.message); });
    },
    'l5-oversize': function (log) {
      // 画 3000x3000 纯色 → toDataURL 约 >5MB base64
      GM_llmChat({
        messages: [{ role: 'user', content: [
          { type: 'text', text: 'hi' },
          { type: 'image_url', image_url: { url: colorDataUrl(3000, '#000000') } },
        ] }],
      }).then(function (r) { log('l5', '意外成功：' + r.text); }, function (e) { log('l5', '预期报错：' + e.message); });
      log('l5', '已发起…');
    },
    'l6-nogrant-copy': function (log) {
      GM_setValue('gmt_llm_nogrant_src', NO_GRANT_SRC);
      log('l6', '临时脚本源已存 GM 值 gmt_llm_nogrant_src——到侧边栏脚本页手动导入：脚本详情 → 复制该值内容另存为 .user.js 导入，或从控制台读取');
    }
  };

  GMT.render({
    module: 'llm',
    title: 'GM 手测·大模型',
    cards: [
      { id: 'l1', api: 'GM_llmChat（文本单轮）', desc: 'await 一次调用，校验返回三件套。', steps: [{ id: 'l1-text', label: '发起调用' }], expect: 'text 非空、usage/finishReason 有值（网关支持时）' },
      { id: 'l2', api: 'GM_llmChat（流式 onChunk）', desc: 'onChunk 逐段日志，结束后终值一致。', steps: [{ id: 'l2-stream', label: '发起流式调用' }], expect: 'chunk 若干条后终值 text = 各 chunk 拼接' },
      { id: 'l3', api: 'GM_llmChat（多模态）', desc: 'canvas 生成红色方块 data URL 传入。', steps: [{ id: 'l3-image', label: '发起图片调用' }], expect: '回答含「红」' },
      { id: 'l4', api: '权限档 deny', desc: '先到脚本详情 → 设置 → 模型调用 改「始终拒绝」，再点按钮；测完改回。', steps: [{ id: 'l4-deny', label: '改档后发起调用' }], expect: '报 permission denied' },
      { id: 'l5', api: '图片超限', desc: '3000x3000 纯色 PNG base64 超 5MB。', steps: [{ id: 'l5-oversize', label: '发起超大图调用' }], expect: '报「图片过大」' },
      { id: 'l6', api: '未授权 grant', desc: '导入无 GM_llmChat grant 的临时脚本触发 permission not requested。', steps: [{ id: 'l6-nogrant-copy', label: '取临时脚本源' }, '导入临时脚本并打开任意其 @match 命中页面', '核对其 GM_log 输出「预期报错」'], expect: '报 permission not requested' }
    ],
    actions: actions
  });
})();
```

- [ ] **Step 2: 构建产物**

Run: `node scripts/build-manual.mjs`
Expected: 输出含 `built gmt-manual-llm.user.js (N bytes)`

- [ ] **Step 3: 文档更新**

`docs/gm-api.md`：

3a. 「Phase 5 实现说明」bullet 列表末尾（unsafeWindow 条目后）加：

```markdown
- **GM_llmChat**：脚本调用扩展配置的大模型（OpenAI 兼容，`设置 → 模型设置` 同源配置，脚本不可自选模型/覆盖）。`messages` 数组（system/user/assistant；content 为字符串或多段 `{type:'text'|'image_url',...}`，图片 data URL ≤5MB 或 http(s) URL）；`onChunk(delta)` 可选收流式文本增量；Promise resolve `{ text, usage, finishReason }`。权限档 per-script（默认「每次询问」弹确认卡：允许一次 / 本会话内允许 / 拒绝 60s 超时），脚本详情 → 设置 → 模型调用 可改档。限制：消息载荷 ≤2MB、响应聚合 ≤1MB（超限报错不截断）、整调用超时默认 120s。无 abort、无 tool 角色、reasoning 不下发。
```

3b. 新章节（`## 9. 日志` 之后、`## 10. 明确不做` 之前）：

```markdown
## 9.5 大模型（本扩展新增，非 GM 生态标准）

| API | 点形式 | 语义 | TM | VM | SC | 本扩展 |
|---|---|---|---|---|---|---|
| `GM_llmChat(details)` | `GM.llmChat` | 调扩展配置的大模型（文本/图片、流式 onChunk） | ✗ | ✗ | ✗ | **本扩展**（权限档三选一 + 确认卡；限制见 Phase 5 实现说明） |
```

3c. `## 11. Phase 5 首批 14 个速览` 标题与首行改为 15 个，速览列表末尾加 `GM_llmChat`。

- [ ] **Step 4: compile + 全量测试**

Run: `npm run compile && npm run test`
Expected: 全 PASS（手测脚本是 fixture 不进编译，但确认没碰坏别的）

- [ ] **Step 5: Commit**

```bash
git add fixtures/userscripts/manual/llm.user.js.src fixtures/userscripts/manual/gmt-manual-llm.user.js docs/gm-api.md
git commit -m "feat(gm): GM_llmChat 手测脚本 + gm-api.md 文档"
```

---

### Task 8: 收尾验证

- [ ] **Step 1: 全量回归**

Run: `npm run compile && npm run test`
Expected: 全 PASS

- [ ] **Step 2: 手工冒烟（需浏览器，用户配合）**

1. `npm run dev` 加载扩展；
2. 设置 → 模型设置 配好 baseUrl/apiKey/model；
3. 侧边栏脚本页导入 `fixtures/userscripts/manual/gmt-manual-llm.user.js`；
4. 打开任意普通网页 → 面板出现 → l1/l2/l3 依次跑（首次调用应弹「大模型调用确认」卡）；
5. 脚本详情 → 设置：改档「始终拒绝」→ l4 报错；改回「每次询问」；
6. l5 报「图片过大」；l6 按卡片指引导入临时脚本验证报错。

- [ ] **Step 3: 已知降级记录（写进 PR 描述或 handoff）**

- 「本会话内允许」为 SW 内存态，SW 重启回到档位语义；
- 直调（调试台）为非流式语义（无 onChunk 通道）；
- http(s) 图片 URL 原样透传不预检（由网关自取）；
- 流式无 abort（Promise 一次性语义）。

- [ ] **Step 4: Commit（如有散落修改）+ 汇报**

```bash
git status --short  # 确认干净或补提交
```
