# 通用确认卡组件 + 跨域确认 hub 页设计

日期：2026-09-05
状态：设计已确认，待实现

## 1. 背景与动机

当前 `GM_xmlhttpRequest` 的 @connect 跨域确认（Phase 5）只在**侧边栏「脚本池」页内联渲染** `ScriptsConfirmCard`：

- 脚本触发跨域请求 → SW `doXmlHttpRequest` → `matchConnectWithPermissions` 返回 `CONFIRM`；
- `queueConfirm` 登记 `pendingConfirms` map + 广播 `GM_CONFIRM_PENDING`；
- 面板 `ScriptsView` 订阅广播 → zustand `confirms[]` → `ScriptsListView` 内联渲染确认卡；
- 用户点 allow-once/always/deny → `GM_CONFIRM_RESOLVE` → SW `resolveConfirm` 解析 promise + 广播 `GM_CONFIRM_RESOLVED`；60s 超时兜底拒绝。

**痛点**：确认卡只在侧边栏「脚本池」页可见。若侧边栏未开、或停在别的页（会话/设置），跨域请求触发时用户根本看不到，60s 后静默拒绝 —— 是真实的 UX 缺口。

**动机**：把确认从「藏在侧边栏」改成「新标签页强提示」，同时把确认卡抽成**通用组件**，为将来 `confirmGate`（AI 写操作批准门控，见 `background/scripts.ts` 文件头注释）零改造复用。

## 2. 目标与非目标

**目标**

1. 抽出通用确认抽象：数据模型、后台队列、消息协议、页面、卡片组件四层全部去 @connect 化。
2. @connect 跨域确认改为在**新标签页的 hub 页**呈现（单 hub 页 + 队列列表）。
3. 彻底移除侧边栏内联确认卡及其 store/订阅。
4. 保持 @connect 判定逻辑（`matchConnect` 系列）与副作用（`gm-permissions`）不变。

**非目标**

- 不实现 `confirmGate`（AI 写操作门控）—— 本设计只保证其将来可零改造接入（`enqueueConfirm({kind:'script-op', ...})`）。
- 不改 `matchConnect`/`matchConnectWithPermissions`/`gm-permissions.ts` 的判定与存储逻辑。
- 不引入 Port 长连接（确认是低频请求-响应交互，复用现有 `runtime.sendMessage` 广播即可）。

## 3. 关键决策记录

| # | 决策 | 选择 |
|---|------|------|
| 1 | 通用化层级 | **全链路通用化**：数据模型/SW 队列/新标签页/组件全部去 @connect 化 |
| 2 | 队列/tab 模型 | **单 hub 页 + 队列列表**：一个常驻确认页排队展示所有待确认项 |
| 3 | 侧边栏内联卡 | **彻底移除**：hub 页成为唯一确认面 |
| 4 | 超时/生命周期 | **60s 超时 + 关窗=拒全部**：两者都算隐式拒绝，SW 监听 tab 关闭事件 |
| 5 | 卡片信息密度 | **丰富上下文卡**：脚本名 + 主机 + 请求方法 + 完整 URL + 来源页 |
| 架构 | 通用抽象放哪 | **抽独立 `background/confirm-queue.ts` + 复用 sendMessage 广播** |

## 4. 数据模型（`shared/confirm.ts`，三环境共享）

队列只管「登记 / 广播 / 超时 / 解析」，**不含任何副作用**。所有确认的文案、明细、按钮都由生产者填入 props；`kind` 仅用于生产者区分自己的请求来源，队列与页面对其无特殊逻辑。

```ts
export type ConfirmKind = 'connect'; // 将来扩展：| 'script-op' 等

export interface ConfirmDetailRow {
  label: string;   // "主机" / "方法" / "URL" / "来源"
  value: string;
  mono?: boolean;  // 机器语言（host/url/method）走等宽
}

export interface ConfirmAction {
  decision: string;                            // 回传给生产者的决策标识
  label: string;                               // "允许一次" / "总是允许" / "拒绝"
  variant?: 'primary' | 'danger' | 'default';  // 映射 .btn 变体
  countdown?: boolean;                         // 是否在按钮上跑本地倒计时
}

export interface ConfirmRequest {
  confirmId: string;
  kind: ConfirmKind;
  title: string;               // "跨域请求确认"
  message: string;             // "脚本「My Script」请求跨域访问"
  rows: ConfirmDetailRow[];
  actions: ConfirmAction[];
  createdAt: number;
  timeoutMs: number;           // 60_000
}
```

**副作用边界**：`enqueueConfirm(spec)` 返回 `Promise<string>`（decision）。`always` 落库、`deny` 回错误等副作用全部由生产者（@connect）在拿到 decision 后自己处理。队列彻底不认识 @connect。

## 5. 后台队列模块（`background/confirm-queue.ts`）

从 `gm-api.ts` 搬出确认队列并泛化：

```ts
const pending = new Map<string, { req: ConfirmRequest; resolve: (d: string) => void }>();
let hubTabId: number | null = null;

// 内部哨兵 decision：生产者把「非自己认识的 decision」一律当 deny 处理
const TIMEOUT = '__timeout__';
const CLOSED = '__closed__';

export function getPending(): ConfirmRequest[];  // hub 页复水快照

/** 登记 + 广播 CONFIRM_PENDING + 开/聚焦 hub + 起 timeoutMs 超时。返回决策 promise。 */
export function enqueueConfirm(
  spec: Omit<ConfirmRequest, 'confirmId' | 'createdAt'>,
): Promise<string>;

/** 解析 promise + 删表 + 广播 CONFIRM_RESOLVED。confirmId 不存在时空操作（幂等）。 */
export function resolveConfirm(confirmId: string, decision: string): void;

export function initConfirmQueue(router: RouterLike): void;
```

**hub 生命周期**

- `ensureHub()`：`enqueueConfirm` 内调用。`hubTabId==null` → `tabs.create({ url: getURL('/confirm.html'), active: true })` 记 `hubTabId`；已开 → `tabs.update(hubTabId, { active: true })` 聚焦。`tabs.get` 兜底：记录的 `hubTabId` 已失效（用户已关但未触发监听）时按 null 重开。
- `onHubClosed(tabId)`：`tabs.onRemoved` 监听。`tabId===hubTabId` → `hubTabId=null` + 剩余全部 `resolveConfirm(id, CLOSED)`（生产者视作 deny）。
- **超时**：每条 `enqueueConfirm` 起 `setTimeout(timeoutMs)` → `resolveConfirm(id, TIMEOUT)`；`resolveConfirm` 命中时清除对应 timer。
- 队列清空后 hub 页**不主动关**（留给用户关；关窗时无 pending，`onHubClosed` 空操作）。

**入口注册**：`entrypoints/background.ts` 加 `initConfirmQueue(router)`。

## 6. 消息协议（`shared/messages.ts`）

`GM_` 前缀去掉，泛化为通用确认协议：

```ts
// ScriptsRequest 联合：
//   删 { type: 'GM_CONFIRM_RESOLVE'; confirmId; decision: 'allow-once'|'always'|'deny' }
//   加 { type: 'CONFIRM_RESOLVE'; confirmId: string; decision: string }
//   加 { type: 'CONFIRM_GET_STATE' }        // hub 页复水，回 { confirms: ConfirmRequest[] }

// bg → 页面广播（fire-and-forget）：
export interface ConfirmPendingEvent  { type: 'CONFIRM_PENDING'; confirm: ConfirmRequest }
export interface ConfirmResolvedEvent { type: 'CONFIRM_RESOLVED'; confirmId: string }
```

`ConfirmRequest`/`ConfirmDetailRow`/`ConfirmAction` 从 `shared/confirm.ts` re-export 或直接 import。

## 7. `gm-api.ts` 收口（生产者改造）

**删除**：`GmConfirm` 接口、`pendingConfirms` map、`CONFIRM_TIMEOUT_MS`、`queueConfirm`、`resolveConfirm`、`getPendingConfirms`、router 里的 `GM_CONFIRM_RESOLVE` 分支、`SCRIPTS_GET_GM_STATE` 响应里的 `confirms` 字段。

**改造 `doXmlHttpRequest`**（CONFIRM 分支）：

```ts
if (decision === ConnectDecision.CONFIRM) {
  const script = await getScript(scriptId);
  const host = hostOf(details.url);
  const choice = await enqueueConfirm({
    kind: 'connect',
    title: '跨域请求确认',
    message: `脚本「${script?.name ?? scriptId}」请求跨域访问`,
    rows: [
      { label: '主机', value: host, mono: true },
      { label: '方法', value: (details.method ?? 'GET').toUpperCase(), mono: true },
      { label: 'URL', value: details.url, mono: true },
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
    // deny / __timeout__ / __closed__ 一律拒绝
    return { ok: false, error: 'permission denied（用户拒绝或确认超时/关闭；可加 @connect 或在确认页批准）' };
  }
}
```

副作用（`setAlwaysAllow`、错误返回）从旧 `resolveConfirm` 搬回生产者，队列不再认识 @connect。

## 8. hub 页与组件（`entrypoints/confirm/` + `components/confirm/`）

**入口 `entrypoints/confirm/`**（对齐 `script-detail/` 模式）

- `index.html`：标准壳，`<div id="root">` + `<script type="module" src="./main.tsx">`，`<title>跨域请求确认</title>`。
- `main.tsx`：`ReactDOM.createRoot(...).render(<ConfirmHubApp />)`，复用 `../sidepanel/styles.css`。
- WXT 自动产出 `confirm.html`。`tabs.create({ url: getURL('/confirm.html') })` 打开 —— 扩展自有页，**无需** web_accessible_resources（同 script-detail）。

**`components/confirm/ConfirmHubApp.tsx`**（页面容器）

- 挂载：`CONFIRM_GET_STATE` 复水 `confirms[]` + 订阅 `CONFIRM_PENDING`/`CONFIRM_RESOLVED` 广播。
- 事件 → 状态用**纯函数 reducer** `applyConfirmEvent(state, msg)`（抽到组件外，可单测）；hub 是独立页，轻量 `useState`，不引 zustand。
- 空列表渲染占位「暂无待确认请求」；否则映射 `<ConfirmCard>` 列表。
- 页眉「跨域请求确认 · N 个待确认」。
- 决策：`onDecide(confirmId, decision)` → `runtime.sendMessage({ type: 'CONFIRM_RESOLVE', confirmId, decision })`；本地乐观移除（广播回来的 `CONFIRM_RESOLVED` 幂等收口）。

**`components/confirm/ConfirmCard.tsx`**（纯展示，通用）

- props：`{ confirm: ConfirmRequest; onDecide: (decision: string) => void }`。
- 渲染：`title` + `message` + `rows.map`（`mono` 走等宽）+ `actions.map`（`variant` 映射 `.btn` 变体）。
- `countdown` 的按钮：本地 `useState` 从 `Math.ceil((createdAt + timeoutMs - now) / 1000)` 起跑倒计时，显示「拒绝（Ns）」；归零由 SW 广播的 `CONFIRM_RESOLVED`（超时哨兵）驱动移除。
- 零 @connect 语义 —— 文案/行/按钮全部来自 props。图标沿用 `ShieldAlert`（lucide，禁 emoji）。

**布局 ASCII（hub 页，居中单列卡栈）**

```
┌────────────────────────────────────┐
│ 跨域请求确认            2 个待确认  │
├────────────────────────────────────┤
│ ⚠ 脚本「My Script」请求跨域访问     │
│                                    │
│   主机   api.example.com           │
│   方法   POST                      │
│   URL    https://api.exa…/v1/data  │
│   来源   https://site.com/page     │
│                                    │
│  [允许一次] [总是允许] [拒绝 58s]  │
└────────────────────────────────────┘
```

## 9. 旧内联卡清理（全链路去 confirms）

- **删** `components/scripts/ScriptsConfirmCard.tsx`。
- `stores/scripts.ts`：删 `GmConfirmItem`、`confirms` 字段、`applyConfirmEvent`、`applyConfirmResolved`、`refresh` 里 confirms 复水。
- `components/scripts/ScriptsView.tsx`：删 `GM_CONFIRM_PENDING`/`GM_CONFIRM_RESOLVED` 订阅分支 + `GmConfirmItem` import。
- `components/scripts/ScriptsListView.tsx`：删 `confirms.map(...)` 渲染 + `ScriptsConfirmCard` import + `confirms` 解构。
- `components/popup/PopupApp.tsx`：`SCRIPTS_GET_GM_STATE` 泛型去掉 `confirms` 字段 + `GmConfirmItem` import。

## 10. 样式

hub 页复用现有 `.scripts-notice`/`.btn`/`.mono` tokens；新增少量 `.confirm-hub` 布局类（居中单列卡栈）+ `.confirm-card` 明细行网格。用 `:root` CSS 变量，禁硬编码色值。动画（若有）走 `prefers-reduced-motion` 兜底。

## 11. 测试策略

**改现有**

- `tests/background/gm-connect.test.ts`：`getPendingConfirms`/`resolveConfirm` 改 import 自 `confirm-queue`；`toMatchObject({ scriptId, host })` 改为断言 `ConfirmRequest`（`kind:'connect'` + rows 含 host/url/method）。四条确认流用例（allow-once/always/deny/列了不中直 DENY）语义不变，验证生产者副作用（`setAlwaysAllow`、deny 错误）仍正确。
- `tests/background/gm-api.test.ts`：`resolveConfirm` import 换源；`SCRIPTS_GET_GM_STATE` 断言去掉 confirms 字段。

**新增**

- `tests/background/confirm-queue.test.ts`：enqueue 广播 `CONFIRM_PENDING` + `getPending` 快照；`resolveConfirm` 解析 promise + 广播 `CONFIRM_RESOLVED` + timer 清除；60s 超时 → `__timeout__` 决策；`onHubClosed` → 剩余全部 `__closed__`；首个 pending `tabs.create` / 已开则 `tabs.update` 聚焦（mock `browser.tabs`）。
- `tests/confirm/confirm-hub.test.tsx`（@testing-library/react + jsdom，对齐 markdown/popup 测试）：`applyConfirmEvent` reducer 纯函数用例（pending 追加 / resolved 移除 / 幂等）；`ConfirmCard` 按 props 渲染 rows/actions + 点击回调 decision + 倒计时按钮显示秒数。

**收尾验证**：`npm run compile`（TS 全绿）+ `npm run test`（新旧用例）+ `npm run build`（确认 WXT 产出 `confirm.html` 入口）。

## 12. 保留不动

`matchConnect`/`matchConnectWithPermissions`/`gm-permissions.ts`（`getAlwaysAllow`/`setAlwaysAllow`/`listAlwaysAllow`/`revokeHost` 等）全部保留 —— 纯 @connect 判定与授权存储，与通用队列无关。

## 13. 影响面清单

| 文件 | 动作 |
|------|------|
| `shared/confirm.ts` | 新增：数据模型 |
| `background/confirm-queue.ts` | 新增：通用队列 + hub 生命周期 |
| `entrypoints/confirm/index.html` + `main.tsx` | 新增：hub 页入口 |
| `components/confirm/ConfirmHubApp.tsx` | 新增：页面容器 + reducer |
| `components/confirm/ConfirmCard.tsx` | 新增：通用展示卡 |
| `entrypoints/background.ts` | 改：注册 `initConfirmQueue` |
| `background/gm-api.ts` | 改：删队列、`doXmlHttpRequest` 改调 `enqueueConfirm` + 搬回副作用 |
| `shared/messages.ts` | 改：协议泛化（`CONFIRM_*`） |
| `stores/scripts.ts` | 改：删 confirms 全套 |
| `components/scripts/ScriptsView.tsx` | 改：删 confirm 订阅 |
| `components/scripts/ScriptsListView.tsx` | 改：删内联卡渲染 |
| `components/popup/PopupApp.tsx` | 改：类型去 confirms |
| `components/scripts/ScriptsConfirmCard.tsx` | 删除 |
| `entrypoints/sidepanel/styles.css` | 改：加 `.confirm-hub`/`.confirm-card` 类 |
| `tests/background/gm-connect.test.ts` | 改：import 换源 + 断言泛化 |
| `tests/background/gm-api.test.ts` | 改：import 换源 + 去 confirms 断言 |
| `tests/background/confirm-queue.test.ts` | 新增 |
| `tests/confirm/confirm-hub.test.tsx` | 新增 |

