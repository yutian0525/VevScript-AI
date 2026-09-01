# AI Browser Extension 设计文档（Phase 4：脚本池 —— 脚本管理器 + 注入引擎 + AI 工具）

> 状态：已定稿，待实现。前置：Phase 3a（工具 9→16）已完成；Phase 3b（MAIN world hook + 观测三工具）设计已定稿但未实现，**本阶段不依赖 3b**（注入走 `chrome.userScripts`，观测 hook 是独立子系统）。
> 本阶段目标：落地类 Tampermonkey 的脚本管理器——脚本 CRUD/启停/搜索/导入导出 UI、`chrome.userScripts` 注入引擎、per-tab 运行态展示、AI 脚本管理六工具。

## 1. 目标与范围

给扩展补上原总体设计 §4.7 预留的「脚本池」：

1. **脚本管理**：脚本列表 + 详情双页 UI；新建/编辑/删除/启停/搜索/导入/导出。
2. **注入引擎**：enabled 脚本按 match pattern 自动注入匹配页面执行（runAt/world 可配）。
3. **运行态**：侧边栏展示「当前标签页正在运行的脚本」，跟随活动标签页切换更新。
4. **AI 工具**：`list/get/create/update/delete/toggle_script` 六工具，与 UI 同一编排层。

### brainstorming 已拍板的四个地基决策

1. **TM 兼容度 = 解析元数据 + 执行代码体**：导入 `.user.js` 解析 `==UserScript==` 头（name/match/run-at/grant 等），代码体照常执行；**GM_* API 不实现**——脚本调用即 ReferenceError（解析时给出警告徽标）。
2. **确认门控 = 先直通**：本阶段 AI 脚本工具直接落库，不建批准卡 UI；`settings.agent.confirmGate`（默认 true）保留并读取，门控状态机（pendingOps + 批准卡）拆到下阶段。工具层不感知门控，编排层预留单点拦截位。
3. **运行态 = 跟随当前标签页**：列表页顶部「当前页运行中」区，展示活动 tab 上匹配且启用的脚本；切换浏览器标签页自动更新。
4. **注入引擎 = `chrome.userScripts` API（方案 A）**：声明式注册、代码字符串直接注入、浏览器原生执行不受页面 CSP 限制；**不做 executeScript + `new Function` 降级**（strict-CSP 站点假可用，失败方式更诡异——诚实优于假降级，与原设计「不做伪沙箱」取向一致）。

## 2. 非目标（YAGNI）

- 不实现任何 GM_* API（GM_setValue/GM_xmlhttpRequest/…）。
- 不做确认门控 UI（pendingOps/批准卡，下阶段）。
- 不做 `@include`/`@exclude` glob 语义（与 match pattern 有损转换，宁缺毋滥——解析时警告并忽略）。
- 不做脚本执行错误回执（phone-home）——保证「代码原样执行」透明性；脚本异常走页面 window.onerror（Phase 3b hook 上线后天然可观测）。
- 不做 iframe 注入控制（v1 仅主帧）；不做 @noframes 之外的 frame 规则。
- 不做脚本市场/更新检查（@updateURL/@downloadURL 仅记录不使用）。
- 不做 CodeMirror——编辑器用轻量 textarea（tab 键插两空格），后续可升级。
- 不做 Firefox 适配（`userScripts` API 形状不同，代码隔离 API 调用点即可）。
- 不做执行结果捕获/返回值（脚本 fire-and-forget，同 Tampermonkey 心智）。

## 3. 架构总览

```
sidepanel                          background (SW)                  Chrome API
──────────────────────            ───────────────────────────      ─────────────
ScriptsListView(新)                background/scripts.ts(新)
  · 运行中区(当前tab)  ─request─▶   · CRUD 编排（落库+注册同步原子完成）
  · 搜索/列表/启停        response  · syncRegistrations() diff 同步   chrome.userScripts
  · 新建/导入(.user.js)             · per-tab 运行集计算与广播         .register/unregister
ScriptDetailView(新)               · SW 启动自愈 sync                 /update/getScripts
  · 元数据表单 + code 编辑 ─广播───
  · 保存/删除/导出/重载页           agent/tools/script-pool.ts(新)
stores/scripts.ts(新,zustand)      list/get/create/update/delete/toggle
shared/userscript-meta.ts(新)      （与 UI 走同一编排层，行为零分叉）
shared/match-pattern.ts(新)
```

**单一数据源原则**：UI 与 AI 工具都经 SW 的同一 CRUD 编排层（storage 落库 + userScripts 注册同步原子完成）；sidepanel 不直接读写 `local:scripts:index`。

## 4. 数据模型与存储（`storage/scripts.ts`）

```ts
interface UserScript {
  id: string;                    // uuid（crypto.randomUUID）
  name: string;
  enabled: boolean;
  matches: string[];             // match patterns（@match 语义）
  code: string;
  runAt: 'document_start' | 'document_end' | 'document_idle';
  world: 'USER_SCRIPT' | 'MAIN'; // 默认 USER_SCRIPT（隔离世界）
  source: 'user' | 'agent' | 'import';
  meta?: {                       // TM 导入保留的展示性元数据（不参与注入）
    namespace?: string;
    version?: string;
    author?: string;
    description?: string;
    grants?: string[];           // 仅用于「需要 GM_*（本扩展不支持）」警告徽标
    noframes?: boolean;         // 仅记录展示
  };
  createdAt: number;
  updatedAt: number;
}
```

- **存储键**：单键 `local:scripts:index`（`UserScript[]`），沿用原总体设计 §8 键名。个人量级（<100 条）全量读写无压力，YAGNI 分键。
- **上限**：200 条/单脚本 code ≤ 256KB，超限报错（上限常量导出，工具层与编排层共用）。
- API：`listScripts() / getScript(id) / saveScript(script) / deleteScript(id)`（纯 storage 层，无注册逻辑）。
- `confirmGate` 保留在 `storage/settings.ts`，本阶段只读取展示（设置页已有开关），编排层留注释标记门控接入点。

## 5. TM 兼容层（`shared/userscript-meta.ts`，纯函数）

### 5.1 解析 `parseUserScript(source: string, fallbackName?: string)`

返回 `{ fields, warnings }`：

- 提取 `// ==UserScript==` … `// ==/UserScript==` 块（无块 = 整段作为 code，fields 全默认，warning 提示「未找到元数据头」）。
- 支持键：`@name`（缺省用 fallbackName/「未命名脚本」）、`@namespace`、`@version`、`@author`、`@description`、`@match`（多条）、`@run-at`（`document-start|document-end|document-idle` → 内部下划线枚举，缺省 `document_idle`）、`@grant`（多条，记录到 `meta.grants`）、`@noframes`（记录）。
- **警告规则**：
  - `@grant` 存在非 `none` 值 →「本扩展不支持 GM_* API，脚本可能运行报错」。
  - `@include` / `@exclude` / `@ant-match` 等不支持的匹配键 → 警告并忽略。
  - 无任何 `@match` → `matches: []` + 警告（**不默认 `<all_urls>`**；无匹配规则 = 不注册不运行，UI 醒目提示补规则）。
  - `@updateURL` / `@downloadURL` / `@icon` 等其它键 → 静默忽略进 `meta` 之外的未知键计数（一条汇总 warning「已忽略 N 个不支持的元数据键」即可，不逐键罗列）。
- 块外的代码体原样保留（不 trim 块内缩进，不改写用户代码）。

### 5.2 序列化 `stringifyUserScript(script: UserScript): string`

反向生成带元数据头的 `.user.js` 文本（导出用）：`@name/@namespace/@version/@author/@description/@match(多条)/@run-at/@grant(有则输出)/@noframes`。`parseUserScript(stringifyUserScript(s))` 往返等价（meta 无损）。

### 5.3 导入 / 导出

- 导入：列表页「导入 .user.js」（file input `accept=".user.js,.js"`）；「新建」时粘贴内容含元数据头则自动解析预填表单。导入默认 `enabled: true`、`source: 'import'`；warnings 全部透传到 UI 展示。
- 导出：详情页「导出 .user.js」——纯前端 `<a download>` + blob，无需消息通道。

## 6. 注入引擎与注册同步（`background/scripts.ts`）

### 6.1 同步机制

- `syncRegistrations()`：读 index → 期望注册集（enabled 脚本）vs `chrome.userScripts.getScripts()` 现有注册 → diff：
  - 新增 enabled → `userScripts.register({ id, matches, js: [{ code }], runAt, world, persistAcrossSessions: true })`
  - disabled / 已删除 → `userScripts.unregister({ ids })`
  - code/matches/runAt/world 变化 → `userScripts.update(...)`（下次导航生效；已加载页面不重跑，UI 提示「刷新页面生效」+「重载当前页」按钮）
- **CRUD 原子语义**：编排层 handler = 落库 → syncRegistrations，两步任一失败整体报错（storage 已写则报「已保存但注册失败」+ 原因，不回滚——用户可从错误提示恢复）。
- **自愈**：SW 顶层启动时调一次 `syncRegistrations()`（persistAcrossSessions 理论自持久，扩展更新/注册漂移时对齐）。
- **降级**：`chrome.userScripts` undefined → 读操作（list/get/get_runtime）照常；写操作返回固定文案「脚本注入引擎不可用：请在 chrome://extensions 开启开发者模式或升级 Chrome 120+」；UI 顶部常驻警示条（可折叠）。导入/新建在降级态仍可保存（enabled 但不注册，引擎恢复后由启动 sync 自动注册）。
- match pattern 非法 → create/update/import 拒绝，返回非法条目列表（校验用 `shared/match-pattern.ts`）。**编排层允许 `matches: []`**（导入无 @match 的脚本能保存，但永不注册，UI 醒目提示）；「必填非空」只是工具层 create_script 的 schema 约束。

### 6.2 运行态跟踪（语义 = 预期注入）

- **语义声明**：「运行中」= 当前 tab URL 匹配（match pattern 语义）且启用的脚本。**不是**「实际执行成功」回执——脚本抛错仍显示运行中。v1 不做 phone-home（污染「代码原样执行」承诺），spec 明示此降级。
- `shared/match-pattern.ts`（纯函数）：`matchPatternToRegExp()` / `matchUrl(patterns, url)` / `isValidMatchPattern()`。`<all_urls>` 等标准 pattern 不匹配 `chrome://` 等受限页（match pattern 语义天然排除），受限页运行集恒空。
- SW 维护内存 `Map<tabId, { url, scriptIds }>`，更新时机：
  - `tabs.onUpdated`（`changeInfo.url` 出现或 `status === 'complete'`）→ 重算该 tab
  - `tabs.onRemoved` → 删该 tab 条目
  - CRUD/启停落库后 → **重算全部已知 tab**（脚本变更影响所有已跟踪页）
- **广播**：某 tab 运行集变化 → `runtime.sendMessage({ type: 'SCRIPTS_RUNTIME', payload: { tabId, url, scriptIds } })`（bg → 所有扩展页面，fire-and-forget）。
- SW 重启 map 清空，下次导航/查询自重建——best-effort，与 observe-store 同哲学。

## 7. 消息协议（`shared/messages.ts` 追加）

```ts
// sidepanel → bg（request/response，走现有 MessageRouter）
SCRIPTS_LIST        {}                                   → { scripts: ScriptSummary[] }   // 摘要无 code
SCRIPTS_GET         { id }                               → { script: UserScript }
SCRIPTS_CREATE      { input: ScriptInput }               → { script: UserScript }
SCRIPTS_UPDATE      { id, patch: ScriptPatch }           → { script: UserScript }
SCRIPTS_DELETE      { id }                               → {}
SCRIPTS_SET_ENABLED { id, enabled }                      → { script: UserScript }
SCRIPTS_IMPORT      { source: string, filename?: string } → { script: UserScript, warnings: string[] }
SCRIPTS_GET_RUNTIME {}                                   → { entries: Array<{ tabId, url, scriptIds }> }

// bg → panel 广播（fire-and-forget）
SCRIPTS_RUNTIME     { tabId, url, scriptIds }
```

- `ScriptSummary` = UserScript 去 code/meta 详情化裁剪；`ScriptInput` / `ScriptPatch` 形状见 §8 工具契约（消息与工具共用同一校验）。UserScript 及相关类型统一定义在 `shared/types.ts`（messages.ts 只放消息形状）。
- 导出下载不需要消息（详情页已持有全文）。
- **UI 侧状态**（`stores/scripts.ts` 新建 zustand）：`activeTabId`（对齐 chat 现有获取方式）、`runtimeEntries`、`scripts`、`query`、`selectedId`、`engineAvailable`；收到 `SCRIPTS_RUNTIME` 广播按 `tabId === activeTabId` 过滤落 store；ScriptsView 挂载/切回时主动发 `SCRIPTS_GET_RUNTIME` + `SCRIPTS_LIST`（兜住广播丢失）。active tab 切换时 UI 重查运行集。

## 8. AI 工具契约（`agent/tools/script-pool.ts`，+6 工具）

> 计数基线：若 Phase 3b 先落地则 19→25；若本阶段先行则 16→22（本阶段不依赖 3b，顺序无关）。

```
list_scripts    enabled?: boolean; urlContains?: string
                → data: { scripts: [{ id, name, matches, enabled, source, runAt, world, updatedAt }] }
get_script      id: string
                → data: { script }          // 全文含 code（模型读代码）
create_script   name: string; code: string; matches: string[]; runAt?; world?; enabled?
update_script   id: string; patch: { name?, code?, matches?, runAt?, world?, enabled? }
delete_script   id: string
toggle_script   id: string; enabled: boolean
```

- 六工具与 UI 走**同一编排层**（`background/scripts.ts` handler 函数直接复用），AI 改脚本 = 用户改脚本，行为零分叉。
- 全部豁免受限页预检（不碰页面内容，纯 storage/注册操作；registry.ts 受限页检查之前分发）。
- `create_script` schema description 注明：脚本以用户脚本权限在匹配页面上运行；要求模型先向用户说明脚本用途与作用域再创建。code 非空 + ≤256KB；matches 必填非空数组 + 语法校验（校验失败返回非法条目列表，模型可自修正）。
- 工具返回沿用 `{ ok: true, data? } | { ok: false, error }` 判别联合。
- schema 经现有 `TOOL_SCHEMAS` 机制自动同步调试台。

## 9. UI（`components/scripts/`，沿用设计系统 tokens；图标一律 lucide-react）

### 9.1 ScriptsListView（列表页）

- 顶部「当前页运行中」区：活动 tab 运行集（脚本名列表，`●` 脉冲圆点，`prefers-reduced-motion` 下静态）；空态「无脚本在此页运行」；受限页显示「此页面不注入脚本」。
- 搜索框：name/description/matches 大小写不敏感子串过滤（纯前端，过滤 store 内数据）。
- 脚本行：名称 + 匹配摘要（mono）+ 来源徽标（user/agent/import）+ GM_* 警告徽标（`meta.grants` 非 none 时）+ enabled 开关（即时发 `SCRIPTS_SET_ENABLED`）+ 点击进详情。
- 底部操作：「新建」「导入 .user.js」。
- 引擎不可用警示条（`engineAvailable === false` 时顶部常驻，可折叠）。
- 双声道排版：脚本名 sans、匹配 pattern/状态令牌 mono。

### 9.2 ScriptDetailView（详情页）

- 返回（清 `ui.scriptId`）、name input、matches 编辑（textarea 每行一条 pattern，失焦逐条校验标红）、runAt select、world select（USER_SCRIPT/MAIN + 一行差异说明）、enabled 开关、meta 只读区（version/author/description/grants 警告）、code textarea（mono、Tab 键插两空格、固定高度内部滚动）。
- 操作：保存 / 删除（二次确认）/ 导出 .user.js / 重载当前页（`tabs.reload`）。
- 保存后提示「已重新注册，刷新页面生效」。
- 导航：`stores/ui.ts` 加 `scriptId: string | null`（非空 = 详情态），railnav 不动。

## 10. 测试策略（沿用现有 vitest + jsdom 惯例）

| 层 | 用例 |
|---|---|
| `userscript-meta.ts` | 各种头解析 / 无头 / grants 警告 / @include 忽略 / run-at 映射 / 无 @match 警告 / stringify 往返无损 |
| `match-pattern.ts` | 合法/非法 pattern、路径通配、`<all_urls>` 不匹配受限页、大小写与端口语义 |
| `storage/scripts.ts` | CRUD / 200 条上限 / 256KB 上限（storage mock 对齐现有测试做法） |
| `background/scripts.ts` | syncRegistrations diff（register/unregister/update 三路，mock userScripts API）/ 引擎不可用降级文案 / 运行集重算三时机 / 广播 payload |
| 工具执行器 | mock 编排层：参数校验、非法 matches 错误、豁免受限页、list 摘要不含 code |
| schema | +6 断言、create_script 必填项/枚举 |
| UI（jsdom） | 列表过滤 / 运行区随 SCRIPTS_RUNTIME 广播更新 / 详情保存流程 / 引擎警示条显隐 |

jsdom 不可覆盖的（真实 userScripts 注册、注入生效、跨 world 行为）留手测清单：导入真实 TM 脚本 → 启用 → 刷新目标页生效；禁用 → 刷新后不执行；运行区随标签页切换更新。

## 11. 边界与错误处理

- **引擎不可用**：固定文案 + 警示条；读不受影响；保存照常（不注册）。
- **受限页**：match pattern 天然不匹配，运行区提示「此页面不注入脚本」。
- **SW 重启**：运行集 map 丢失自重建；注册靠 persistAcrossSessions + 启动自愈 sync。
- **注册失败但已落库**：报「已保存但注册失败」+ 原因，不回滚。
- **脚本代码执行出错**：浏览器按页面脚本异常抛 window.onerror，工具层不捕获（透明执行）。
- **并发**：sidepanel 与 agent loop 可能同时发 CRUD——SW 单线程 + handler 内落库读改写串行（同一 microtask 内完成），MV3 下无需加锁；编排层 handler 保持同步读-改-写即可。

## 12. 组件与文件改动

### 新建

| 文件 | 职责 | 可单测 |
|---|---|---|
| `shared/userscript-meta.ts` | TM 元数据解析/序列化（纯函数） | ✅ |
| `shared/match-pattern.ts` | match pattern 校验与匹配（纯函数） | ✅ |
| `storage/scripts.ts` | UserScript 存储 CRUD + 上限 | ✅ |
| `background/scripts.ts` | CRUD 编排（落库+注册同步）、syncRegistrations、运行集跟踪与广播、消息 handler | ✅（mock userScripts） |
| `agent/tools/script-pool.ts` | 六工具执行器 | ✅ |
| `components/scripts/ScriptsListView.tsx` | 列表页（运行区/搜索/行/导入） | ✅ jsdom |
| `components/scripts/ScriptDetailView.tsx` | 详情页（表单/编辑/导出/删除） | ✅ jsdom |
| `stores/scripts.ts` | 脚本 + 运行态 zustand store | ✅ |

### 修改

| 文件 | 改动 |
|---|---|
| `shared/messages.ts` | +§7 消息类型（8 request + 1 广播）+ UserScript/Summary/Input/Patch 类型（或入 shared/types.ts） |
| `shared/types.ts` | UserScript 等共享类型落位 |
| `agent/tools/schemas.ts` | +6 schema（计数基线见 §8） |
| `agent/tools/registry.ts` | +6 分发，豁免受限页预检 |
| `entrypoints/background.ts` | 挂 scripts 消息 handler + tabs 监听 + 启动自愈 sync |
| `components/scripts/ScriptsView.tsx` | 占位符 → 列表/详情路由壳 |
| `stores/ui.ts` | + `scriptId: string \| null` |
| `wxt.config.ts` | permissions + `userScripts` |
| `entrypoints/sidepanel/App.tsx` | 无结构改动（ScriptsView 内部路由） |

### 分支

从当前 `feature/phase1-skeleton` 切出 `feature/phase4-script-pool` 开发。

## 13. 给后续阶段的接口契约（本阶段冻结）

- **编排层单点**：`background/scripts.ts` 的 CRUD handler 是门控接入点——下阶段确认门控（pendingOps + 批准卡）只需在 handler 前拦截，UI/工具层零改动。
- `UserScript` 数据形状冻结；`parseUserScript`/`stringifyUserScript` 是 TM 兼容层的全部入口，后续补 GM_* 时在其上加 API shim 层，不动解析器。
- 运行态广播（`SCRIPTS_RUNTIME`）形状冻结，后续「实际执行回执」（若做）以增量字段并入。
- 六工具名与参数冻结（对齐 chrome-devtools-mcp 语义惯例），后续只增不改。

## 14. 已知降级（实现中接受）

- 「运行中」是预期注入（URL×enabled 匹配计算），非执行成功回执；脚本抛错仍显示运行中。
- `@include`/`@exclude` 不支持（警告并忽略）；GM_* API 缺失（导入带 grant 的脚本给常驻警告徽标）。
- 仅主帧注入；iframe 内不执行。
- 引擎依赖 Chrome 120+（旧版需开发者模式，新版已放开）；不可用时功能降级为纯管理（不注入）。
- 已加载页面在 update/register 后不自动重跑（UI 引导刷新）；SW 重启丢运行集 map（自重建）。
- Firefox 的 userScripts API 形状不同，本阶段 Chrome-only。
