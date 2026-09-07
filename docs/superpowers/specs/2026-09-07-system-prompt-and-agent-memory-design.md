# 系统提示词自定义 + Agent 记忆设计

日期：2026-09-07
分支：`feat/system-prompt-and-memory`

## 1. 目标与范围

两件独立但共用注入通道的能力：

1. **系统提示词自定义**：设置页新增入口，用 Markdown 编辑器查看并**完整覆盖**内置 `SYSTEM_PROMPT`，可一键恢复默认。
2. **Agent 记忆**：跨会话的长期记忆池。AI 经工具自主增删改，用户在设置页手工编辑。记忆按站点作用域筛选后注入系统提示。

两者都不改动 agent 主循环的状态机结构，只在 `buildContext` 的系统消息组装处增加两段，并沿用 `LoopDeps` 的「每轮重读设置」模式。

不在本次范围：记忆导入导出、记忆自动过期、按会话隔离的记忆、语义检索。理由见 §8。

## 2. 系统提示词自定义

### 2.1 存储

`Settings` 增加第三个顶层段 `prompt`，沿用现有 merge-patch 语义（`storage/settings.ts`）：

```ts
export interface PromptConfig {
  /** 自定义系统提示词全文。空串 = 使用内置 SYSTEM_PROMPT。 */
  custom: string;
  /** 保存自定义时的内置全文快照，用于「内置已更新」提示。 */
  baseSnapshot?: string;
}
```

- `DEFAULT_SETTINGS.prompt = { custom: '' }`。
- `getSettings` / `saveSettings` / `SettingsPatch` 同步增加 `prompt` 段，与 `provider`/`agent` 同构。
- 上限 `MAX_CUSTOM_PROMPT = 16 * 1024` 字符，超限在页面侧拦截（不进 storage）。

### 2.2 生效路径

`agent/context.ts` 新增纯函数：

```ts
export function resolveSystemPrompt(custom?: string): string {
  return custom?.trim() ? custom : SYSTEM_PROMPT;
}
```

`LoopDeps` 增加 `getSystemPrompt?: () => Promise<string>`，由 `background/agent-port.ts` 的 `makeDeps` 注入（读 `getSettings().prompt.custom` 后过 `resolveSystemPrompt`）。缺省不传 = 用内置，便于测试。每轮重读，与既有 `getMaxTokens` / `getMode` 一致——设置页改完下一轮生效，无需重启面板。

### 2.3 覆盖边界（关键约束）

自定义**只替换 `SYSTEM_PROMPT` 这一个常量**。动态块照旧追加，顺序为：

```
resolveSystemPrompt(custom)
  + pageBlock      当前页面 URL/标题
  + skillsBlock    可用技能简述（buildSkillsPrompt）
  + memoryBlock    记忆（本次新增，见 §3.3）
  + modePrompt     ask/agent 能力边界
```

即用户把提示词删空，`load_skill` 用法、模式约束、记忆用法说明依然存在。**记忆的用法指令必须放在 `memoryBlock` 而非 `SYSTEM_PROMPT` 里**，否则覆盖提示词的用户会连带丢掉记忆能力的说明。

### 2.4 `buildContext` 签名重构

现状 6 个位置参数（`history, page, keepRecent, summary, skills, mode`），再加系统提示词与记忆就是 8 个，不可维护。改为：

```ts
export interface BuildContextOptions {
  keepRecent?: number;                                   // 默认 60
  summary?: { text: string; coversUpTo: number };
  skills?: SkillBrief[];
  mode?: AgentMode;                                      // 默认 'agent'
  systemPrompt?: string;                                 // 缺省用内置 SYSTEM_PROMPT
  memory?: MemoryState;                                  // 见 §3.3
}
export function buildContext(
  history: ChatMessage[],
  page: PageInfo,
  opts?: BuildContextOptions,
): ChatMessage[]
```

`page` 保持第二个位置参数（始终必需且语义主要），其余进具名 `opts`。收益：`tests/agent/context.test.ts` 中只传两参的调用点全部不动，仅需改传三参以上的 5 处（`context.test.ts` 3 处、`mode.test.ts` 1 处、`skills-context.test.ts` 1 处）+ `loop.ts` 1 处。

### 2.5 页面

`components/settings/SystemPromptPage.tsx`，设置页第 5 张卡（`SettingsSub` 增加 `'prompt'`，图标 lucide `ScrollText`）。

- **编辑器**：把 `components/detail/CodeEditor.tsx` 泛化出 `language?: 'javascript' | 'markdown'`（默认 `javascript`，`DetailCodeTab` 调用点不变）。语言在挂载时决定，不支持运行时切换（现有组件的 extensions 只构建一次，切换需重建 `EditorView`，本场景不需要）。新增依赖 `@codemirror/lang-markdown`（官方包，钉版本）。
- **编辑/预览切换**：预览复用 `components/chat/Markdown.tsx`。
- **初始内容**：`custom` 为空时预填内置全文，并在顶部挂提示条「当前使用内置提示词（未自定义）」。保存即固化为自定义——这就是覆盖式的含义。
- **操作**：保存 / 恢复默认（`window.confirm` 后清空 `custom` 与 `baseSnapshot`，编辑器回内置全文）/ 字符计数（超 16KB 时禁用保存并出错误文案）。
- **内置已更新提示**：`baseSnapshot` 存在且 `!== SYSTEM_PROMPT` 时出提示条「你的自定义基于旧版内置提示词」，可展开查看当前内置全文（只读 `.well`），由用户自行决定是否合并。保存时写入 `baseSnapshot = SYSTEM_PROMPT`。
- 面板直接调 `getSettings`/`saveSettings`，与 `ModelSettings.tsx` 一致，不经 background 路由。

## 3. Agent 记忆

### 3.1 实体

`shared/types.ts`：

```ts
export interface MemoryEntry {
  /** nanoid(8)：短 id 省注入 token，且足够唯一（本地 ≤100 条） */
  id: string;
  /** 记忆正文，≤500 字符 */
  content: string;
  /** 站点作用域（match pattern）。空数组 = 全局记忆，始终注入 */
  matches: string[];
  /** 来源：AI 自主记录 / 用户手工添加 */
  source: 'ai' | 'user';
  createdAt: number;
  updatedAt: number;
}
```

无 per-entry `enabled`：停用一条记忆与删除它区别不大，删除只需一次点击（YAGNI）。整体开关见 §3.5。

### 3.2 存储

`storage/memory.ts`，单键 `local:memory:index`（`MemoryEntry[]`），与 `storage/skills.ts` 同构。

```ts
export const MAX_ENTRIES = 100;
export const MAX_CONTENT_LENGTH = 500;

listMemories(): Promise<MemoryEntry[]>
getMemoryEntry(id): Promise<MemoryEntry | undefined>
saveMemory(entry): Promise<void>      // upsert，校验见下
deleteMemory(id): Promise<void>       // 幂等
newMemory(fields): MemoryEntry        // id = nanoid(8), 时间戳
```

`saveMemory` 校验（全部 throw 中文可读文案）：

- 新增时 `length >= MAX_ENTRIES` → 报错，提示先删。
- `content` 为空或超 `MAX_CONTENT_LENGTH` → 报错。
- `matches` 每条过 `isValidMatchPattern`（`shared/match-pattern.ts`）；**任一非法即整条拒存**，错误文案点名那条 pattern。

> 与脚本池「合法并入、非法警告 + 跳过该条」的差异是刻意的：脚本可能有几十条 `@match`，坏一条不该毁掉整次导入；记忆只有一个 `matches` 字段，静默跳过会让 AI 以为写成功了、而实际作用域是错的——这种失败必须显式。

### 3.3 注入（三层）

`agent/memory-prompt.ts`，纯函数，被 `context.ts` 调用。分三层是为了解决「模型在导航前看不到目标站记忆」——记忆过滤依赖 `page.url`，而 `page.url` 每轮循环顶部才重读（`loop.ts` 的 `deps.getPageInfo(targetTab)`），所以导航后的新站记忆本来要等下一轮才出现。第三层让模型在规划阶段就知道「目标站有记忆」，可主动取。

| 层 | 内容 | 何时出现 |
|---|---|---|
| 1 | 全局记忆（`matches` 空）全文 | 始终 |
| 2 | `matchUrl(matches, page.url)` 命中的记忆全文 | 当前页命中时 |
| 3 | 其余记忆的**站点清单**（pattern + 条数，无正文） | 存在未命中记忆时 |

```ts
export interface MemoryBrief {
  id: string; content: string; matches: string[]; updatedAt: number;
}
export interface MemoryState {
  /** 总开关。false → buildMemoryPrompt 返回空串（连冷启动文案都不注入） */
  enabled: boolean;
  /** false 时说明文案不提 memory_write/memory_delete（工具没下发，避免幻觉调用） */
  writable: boolean;
  entries: MemoryBrief[];
}
export function buildMemoryPrompt(state: MemoryState, url: string): string
```

`enabled` 与 `writable` 两个标志都必需：仅有 `writable` 无法区分「总开关关闭」（不注入任何文案）与「只读模式下记忆池为空」（注入只读版冷启动文案），两者的 `entries` 都是空数组。

规则：

- **展示顺序**：全局（`updatedAt` 倒序）→ 当前页命中（`updatedAt` 倒序）。全局在前是因为它多为用户偏好，任何页面都适用。
- **预算** `INJECT_BUDGET_CHARS = 6000`，**两层各分半（3000/3000），某层未用满的额度让给另一层**。避免任一层饿死另一层——全局记忆（如「用中文回复」）被挤掉会立刻被用户察觉，站点记忆被挤掉会让 agent 在当前页重复踩坑，两者都不能牺牲。超预算的条目不注入，附一行「另有 N 条记忆因长度限制未列出，可用 memory_list 查看」。最坏情况（100 条 × 500 字）注入约 3K token，站点作用域下日常远小于此。
- **条目格式**：`[{id} {作用域}] {content}`，作用域为 `全局` 或第一条 pattern（多 pattern 时附 `等 N 条`）。
- **站点清单**：第 3 层按 pattern 聚合计数、去重，最多列 30 个 pattern，超出附「另有 N 个站点」。形如
  `*://*.bilibili.com/* (3) · *://github.com/* (2)`
- **冷启动**：记忆池为空时**仍注入**一段简短说明（说明「你具备跨会话长期记忆，当前为空」+ 何时该记）。否则模型永远不知道自己有这个能力，记忆池会永远是空的。
- `writable === false` 时，说明文案只讲「这些是已有记忆」与 `memory_list`，不提写工具。

说明文案要点（写在块内，非 `SYSTEM_PROMPT`）：

- 该记：用户的偏好与习惯、某站点的固定操作路径、踩过的坑与解法、账号/环境的稳定事实。
- 不该记：本轮的中间结果、页面上随时会变的数字、一次性的临时信息。
- 记忆过时或错误时用 `memory_write`（带 id）改写、或 `memory_delete` 删除，不要留下互相矛盾的两条。
- 写入无需征求用户同意，但要在回复里简短告知记了什么。
- **导航到新站点后，该站记忆会在下一步出现在这里；需要提前知道就用 `memory_list({ scope })` 查**。（给模型正确的心智模型，避免它以为清单里的站点没有细节。）

### 3.4 工具（27 → 30）

schema 进 `agent/tools/schemas.ts`，实现放 `agent/tools/memory.ts`，分发进 `agent/tools/registry.ts`（纯 storage 操作，豁免受限页预检，与 `load_skill` 同位置）。

| 工具 | 参数 | 语义 |
|---|---|---|
| `memory_list` | `scope?`, `limit?` | 列出记忆全文（含未命中当前页的）。`scope` 匹配规则见下；缺省 = 全库（写入前查重用）。`limit` 默认 30、上限 100，按 `updatedAt` 倒序取。 |
| `memory_write` | `content`, `matches?`, `id?` | 无 `id` = 新增；带 `id` = 改写（`content` 必传；`matches` 传了才改，不传保持原值）。`id` 不存在时报错，不静默新增。写入的 `source` 恒为 `'ai'`。 |
| `memory_delete` | `id` | 幂等，不存在也返回成功（`deleted: false`）。 |

`memory_list` 的 `scope` 匹配规则（两趟，模型传完整 URL 或站点关键词都能命中）：

1. 先试 `matchUrl(entry.matches, scope)`——`scope` 是完整 URL（如 `https://www.bilibili.com/video/x`）时命中。
2. 未命中则对 `entry.matches` 每条 pattern 做大小写不敏感子串匹配——`scope` 是关键词（如 `bilibili`）时命中，不必抄完整 pattern。

带 `scope` 时**全局记忆（`matches` 空）不参与匹配、不出现在结果里**：它们已常驻注入，混进来只会挤占返回额度。

返回值瘦身（照 `toWriteResult` 的教训，不回灌全库）：

- `memory_list` → `{ total, returned, entries: [{ id, content, matches, source, updatedAt }] }`
- `memory_write` → `{ id, content: 截断 120 字, matches, total, created: boolean }`
- `memory_delete` → `{ id, deleted: boolean, total }`

三个工具全部进 `ASK_MODE_TOOLS`（`agent/mode.ts`）。理由：ask 模式的语义是「不改网页/浏览器状态」，记忆只改扩展自己的本地笔记；且「以后都这样」这类交代大多发生在问答里。

### 3.5 开关与守卫

`AgentConfig` 增加两个布尔（默认均 `true`）：

- `memoryEnabled`：总开关。关闭 = 不注入记忆块、不下发三个工具。
- `memoryWritable`：关闭 = 只注入 + 只下发 `memory_list`，记忆改由人工维护。

`getToolSchemas` 增加第二个参数：

```ts
export type MemoryCap = 'off' | 'read' | 'full';
export function getToolSchemas(mode: AgentMode = 'agent', memory: MemoryCap = 'full'): ToolSchema[]
```

`memory === 'off'` 滤掉三个工具，`'read'` 只留 `memory_list`。默认 `'full'` 使调试台（`ToolBenchPage`）等既有调用点不受影响。

`executeTool` 增加硬闸：`ToolCtx` 加 `memory?: MemoryCap`，记忆工具在 `'off'` / 写工具在 `'read'` 时返回可读错误。位置与形状对齐既有 ask 模式守卫——工具清单靠 prompt 遵循不等于硬约束，仍需兜底拦幻觉调用。

`LoopDeps` 增加 `getMemoryState?: () => Promise<MemoryState>`（一次读同时给出三个字段，避免每轮多次读；命名避开 storage 层的 `getMemoryEntry(id)`）。loop 每轮把它传给 `buildContext` 的 `opts.memory`，并经纯函数得出 cap 传给 `getToolSchemas` 与 `executeTool` 的 ctx：

```ts
export function memoryStateToCap(s: MemoryState): MemoryCap {
  if (!s.enabled) return 'off';
  return s.writable ? 'full' : 'read';
}
```

`memoryEnabled === false` 时 `getMemoryState` 返回 `{ enabled: false, writable: false, entries: [] }`，cap 为 `'off'`，`buildMemoryPrompt` 返回空串。

### 3.6 页面

`components/settings/MemoryPage.tsx`，设置页第 6 张卡（`SettingsSub` 增加 `'memory'`，图标 lucide `Brain`）。列表 ↔ 详情双页，与 `SkillsPage` 同构。

- **顶部**：两个开关（启用记忆 / 允许 AI 写入），写 `settings.agent`。
- **列表**：搜索框（`content` 与 `matches` 子串）+「新建」按钮 + 记忆卡。卡片显示正文截两行、作用域 chip（`全局` 或 pattern）、来源 chip（`AI` / `手工`）、更新时间、删除钮（`window.confirm`）。
- **详情**：正文 `textarea`（带字符计数，超 500 禁用保存）+ 作用域输入（`textarea`，每行一条 pattern，空行忽略，实时过 `isValidMatchPattern` 标红非法行，全空 = 全局）+ 保存/删除。用户手工新建的 `source = 'user'`；编辑 AI 记录的条目**保留原 `source`**（来源是事实记录，不因编辑而改写）。
- **不走 background 路由**：面板直接调 `storage/memory.ts`，与 `ModelSettings` 直接调 `storage/settings.ts` 一致。刻意不照技能池的 `SKILLS_*` 消息链——那层间接对记忆没有收益（无 md 解析、无注入引擎、无 tabs 监听），省掉一个编排层、一组消息类型、一个 zustand store。AI 侧经 `executeTool` 落到同一个 storage 模块。
- **`storage.watch`**：监听 `local:memory:index`，AI 在任务中写入记忆时，正打开的列表自动刷新。组件卸载时取消监听。

## 4. 数据流

```
设置页（面板）──直接读写──> storage/settings.ts  ──┐
设置页（面板）──直接读写──> storage/memory.ts   ──┤
                                                  │ 每轮读
AI 工具 ──executeTool──> storage/memory.ts     ──┤
                                                  v
                             LoopDeps.getSystemPrompt / getMemoryState
                                                  │
                                                  v
              buildContext(history, page, { systemPrompt, memory, skills, mode, summary })
                                                  │
                          system = 提示词 + 页面 + 技能 + 记忆 + 模式
                                                  v
                                      getToolSchemas(mode, cap) → runTurn
```

## 5. 错误处理

- `storage` 读失败：`getSystemPrompt` 降级为内置提示词、`getMemoryState` 降级为 `{ enabled: false, writable: false, entries: [] }`（对齐 `getSkills` 的 `.catch(() => [])` 降级）。任务不因记忆读不出来而中断，代价是该轮模型拿不到记忆也不能写——瞬时故障可接受。
- `memory_write` 超限/非法 pattern/`id` 不存在：返回 `{ ok: false, error }`，模型读错误后自行调整（与既有工具一致，错误不是终点）。
- 设置页保存失败：`status-text--err` 显示原因，表单值不回滚。
- 并发写：AI 与用户同时改同一条 → 后写覆盖（wxt storage 无事务）。`storage.watch` 会让面板列表刷新到最新值。记忆是本地笔记，此代价可接受。

## 6. 测试

新增：

- `tests/storage/memory.test.ts`：条数上限、正文上限、非法 pattern 拒存（含错误文案点名）、upsert 保 `createdAt`、删除幂等、`newMemory` 的 id 长度。
- `tests/agent/memory-prompt.test.ts`：全局始终注入；命中/未命中站点的分层；站点清单聚合与 30 个上限；预算截断与「另有 N 条」；**半预算让渡**（一层用不满时另一层可超过 3000）；空库冷启动文案；`writable: false` 不提写工具；`enabled: false` 返回空串（与只读空库的冷启动文案区分）。
- `tests/agent/tools/memory-tool.test.ts`：新增/改写/删除/`id` 不存在报错；`memory_list` 的 `scope` 两趟匹配（完整 URL 走 `matchUrl`、关键词走子串）、带 `scope` 时排除全局记忆、`limit` 截断；`cap` 守卫（`off` 拒全部、`read` 拒写）。

扩展：

- `tests/agent/context.test.ts`：`systemPrompt` 覆盖生效、空串回落内置、记忆块位置在技能之后模式之前。
- `tests/storage/settings.test.ts`：`prompt` 段默认值与 merge-patch。
- `tests/agent/mode.test.ts`：`getToolSchemas(mode, cap)` 二维过滤矩阵。
- 现有 5 处 `buildContext` 三参以上调用改为 `opts` 形式。

## 7. 已知限制

1. **覆盖后固化**：编辑过系统提示词即锁定在当时版本，后续内置规则改进不会自动进入。靠 `baseSnapshot` 提示条缓解，合并仍是手工活。
2. **误删承重规则不易归因**：删掉 uid/stale、分步写入、不可信输入这几条后，agent 会明显变笨但报错不指向提示词。页面上会对这几段标注「承重」提示，但不做技术阻拦。
3. **同一轮内导航后的后续工具仍看不到新站记忆**：三层注入让模型有能力主动规避（先 `memory_list` 再动手），但不强制，最坏情况延迟一轮收口。
4. **click 触发的同标签跳转，URL 更新时序无保证**：`navigate_page` 内部 `await waitForCsReady` 能保证，click 导致的页内跳转不能。这是 `getPageInfo` 既有特性，记忆功能只是继承，非新引入。
5. **站点清单按 pattern 字面聚合**：同一站点写成 `*://bilibili.com/*` 与 `*://*.bilibili.com/*` 会显示成两个条目。
6. **`memory_list` 的 `scope` 第二趟是子串匹配**：`scope: 'com'` 会命中大量条目。第一趟（完整 URL 走 `matchUrl`）是精确的，关键词趟只求召回，配合 `limit` 可接受。
7. **并发写后写覆盖**（§5）。

## 8. 明确不做（v1）

- **记忆导入导出**：技能有此能力是因为技能靠 `.md` 导入产生；记忆是运行中长出来的，v1 不做备份通道。
- **记忆自动过期**：无可靠的「过时」判据；靠说明文案让模型改写/删除。
- **按会话隔离的记忆**：会话已有自己的历史与摘要，记忆的价值恰在跨会话。
- **语义检索**：条目短、站点作用域已完成主要筛选，向量检索的复杂度换不来收益。
