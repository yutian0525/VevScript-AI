# 上下文 token 优化：前缀稳定化与固定开销瘦身 设计

- 日期：2026-09-22
- 状态：已确认（对话中设计获用户批准）
- 背景：新对话的固定开销（system 提示词 + 工具 schema，每轮重发）实测偏高，且随用户技能数线性膨胀。同时发现 `buildContext` 把页面 URL/标题与记忆条目拼进 system 消息，使「工具 + system」这段最贵的前缀在导航、写记忆、标题抖动时反复失效，拿不到前缀缓存。

## 0. 实测基线

用临时 vitest 探针跑 `buildContext` + `getToolSchemas` 量得（量完已删）：

| | system 提示词 | 工具 schema | 合计 |
|---|---|---|---|
| agent 模式 | 1,925 字符 | 19,783 字符（37 个工具） | 21,708 字符 ≈ 6.5K token |
| ask 模式 | 1,843 字符 | 10,018 字符（18 个工具） | 11,861 字符 ≈ 3.9K token |

拆解（agent 模式，字符）：

| 块 | 大小 | 是否逐轮稳定 |
|---|---|---|
| `SYSTEM_PROMPT` | 825 | 稳定（用户改设置才变） |
| 技能清单块（内置 4 个） | 593 | 稳定（技能增删改才变） |
| 记忆块（空） | 340 | 说明稳定、条目随 page.url 变 |
| 页面块（URL + 标题） | 60 | **标题在 SPA 上会逐轮抖** |
| 模式段 | 131 / 254（ask） | 稳定 |
| 工具 schema | 19,783 | 稳定（但排在 prompt 最前，最贵） |

单工具最贵：`update_script` 2,292、`query_page` 1,804、`update_skill` 1,547。

技能清单每条约 68–90 字符，无上限：20 个技能 → 1,350 字符，100 个 → ~8,500 字符。

## 1. 关键决策记录

| # | 决策 | 选择 | 理由 |
|---|------|------|------|
| 1 | 优化路线 | 瘦身 + 前缀稳定化；**不做**工具懒加载 | 用户选定。懒加载省得更多但多一轮往返，且模型可能不知道解锁什么 |
| 2 | 易变块位置 | 尾部 `user` 消息：`[system, ...history, volatile]` | 前缀 = tools+system+history 单调增长，缓存命中最大；所有 OpenAI 兼容网关都接受末尾 user；与既有 `【前情摘要】` user 消息约定一致。末尾 `system` 消息被部分网关 400 或静默改写（否决）；内联进最后一条 user 会污染用户原话、且末条是 tool 消息时无处可拼（否决） |
| 3 | 记忆块拆分 | 说明/用法留 system，**条目**移 volatile | 说明文案稳定（~250 字符），整块挪会让它每轮按全价计费 |
| 4 | 分块滑窗（`truncateMessages`） | **不做** | 缓存匹配的是最长公共前缀，滑窗的分歧点在窗口起点，tools+system 照样命中——它只丢历史正文的缓存。收益不够抵「边界每 20 轮突然掉 20 条」的行为陡变 |
| 5 | schema 瘦身力度 | 保守：删重复与设计论证、合并重复的参数描述；保留全部操作要点与用户可感知后果 | 用户选定。合并参数重复描述信息一条不删（`query_page` 的 `locator` 从四遍变一遍），仍在保守档内 |
| 6 | ask 工具集 | 18 → 10 | 用户选定「看页面 + 答问 + 加载技能」档 |
| 7 | ask 下的记忆写工具 | 收走（**推翻 spec §3.4 的一半**） | 用户选定。§3.4 原文「记忆只改扩展自己的本地笔记，收走写权限会很别扭」——修订为 ask 保留 `memory_list`（读），写工具随其余写能力一并收走，边界更整齐：ask = 完全不产生任何持久化副作用 |
| 8 | 技能清单封顶 | 内置 4 个常驻不占名额 + 用户技能最多 20 个；描述超 60 字符截断 | 封顶后约 2,300 字符上限（~700 token），100 个技能也只多一行提示 |
| 9 | 技能排序 | 内置在前（按 `createdAt` 升序 = builtin.md 顺序），用户技能在后（按 `createdAt` 降序，最新在前） | **确定性排序是硬要求**：顺序抖动 = 前缀抖动 = 缓存全废 |
| 10 | 技能过滤方式 | **不做**按用户消息关键词过滤 | 看似聪明，实则每轮前缀都变、缓存全废，是负收益。清单只能留在稳定前缀里，靠确定性封顶控大小 |
| 11 | `list_skills` 搜索 | 新增 `query` 参数（子串匹配 + command 精确置顶 + 字符子序列兜底） | 封顶后模型必须能找回未列出的技能，否则封顶就是能力阉割 |
| 12 | 缓存命中可见性 | **本期不做** | 用户决定。记为已知盲区：无法验证缓存实际命中率（见 §9） |
| 13 | 压缩链路 | 不动 `agent/compact.ts` | 它自建上下文（无 tools、两行 system），不受本次布局改动影响 |

## 2. 目标与非目标

**目标**

1. agent 模式新对话固定开销：21,708 → ~15,200 字符（**-30%**）。
2. ask 模式新对话固定开销：11,861 → ~5,400 字符（**-56%**）。
3. tools + system 前缀在整段会话内**逐字节稳定**，只有尾部 volatile 块随页面/记忆变化——导航、写记忆、标题抖动都不再打断前缀缓存。
4. 技能清单大小有确定上界，不随技能数线性膨胀。
5. 模型感知的信息量不减少：页面信息、记忆条目、全部工具操作要点都还在，只是换了位置。

**非目标（YAGNI）**

- 不做工具懒加载 / 动态工具集解锁。
- 不做分块滑窗（决策 4）。
- 不做缓存命中计量与展示（决策 12）。
- 不改 agent 模式的工具集（37 个不变，只瘦描述）。
- 不动压缩链路、不动确认卡链路、不动 GM API。

## 3. 消息布局重排（`agent/context.ts`）

`buildContext` 输出形状改为：

```
[ system(稳定) , ...history(逐轮增长) , volatile(每轮重算，可选) ]
```

### 3.1 system 消息（缓存前缀的一部分）

顺序不变，只摘掉易变部分：

```
<系统提示词全文>            ← 内置 SYSTEM_PROMPT 或用户自定义
<技能清单块>                ← §7
<记忆说明与用法>            ← §4 的 stable
<模式段>
```

页面块从 system 移除（进 volatile）。

### 3.2 volatile 消息（不进缓存前缀）

一条 `role: 'user'` 消息，追加在消息数组最末。首行显式声明它是系统注入而非用户发言，避免模型把它当成用户的最新指令：

```
【环境】以下为当前页面与记忆的即时状态（由系统注入，非用户发言）：

当前页面：
- URL: https://example.com/x
- 标题: 示例站点

记忆条目（当前生效）：
[g1 全局] ...
[s1 example.com] ...

另有 2 条记忆因长度限制未列出，可用 memory_list 查看。

其他站点已有记忆（需要时用 memory_list 取全文）：a.com (3) · b.com (1)
```

**空则不追加**：拼装时逐段判空——页面段在 `page.url` 为空（受限页、未取到）时省略，记忆段在 §4 的 volatile 为空时省略。两段都空则整条消息不追加（不产生空壳消息）；只有一段有内容时照常追加，只带那一段。

### 3.3 边界情况

- **首轮**：history 只有一条 user，输出为 `[system, user, user]`——两条连续 user。OpenAI 兼容协议允许，且首轮就有缓存价值（tools+system 稳定）。
- **summary 分支**：`[system, 摘要user, ...recent, volatile]`——volatile 仍在最末，摘要位置不变。
- **末条是 tool 消息**：volatile 追加在所有 tool 结果之后。协议约束是「assistant(tool_calls) 后必须紧跟其全部 tool 响应」，在其后追加 user 消息合法。
- **用户自定义系统提示词**：仍在 system 首位，前缀照常稳定（自定义提示词本身就是稳定的）。
- **`summarizeContext`（`agent/trace.ts`）**：仍读 `messages[0]` 取 system 字符数，语义不变。可选加一项 volatile 字符数（见 §8）。

## 4. 记忆块拆分（`agent/memory-prompt.ts`）

签名改为：

```ts
export function buildMemoryPrompt(state: MemoryState, url: string): { stable: string; volatile: string }
```

**stable**（进 system）

```
## 记忆

<冷启动文案「你具备跨会话的长期记忆，当前为空。」 或 「下面是你在之前的会话中记录的、以及用户手工维护的长期记忆，它们跨会话持久存在。」>

<usageBlock：发现值得保留的信息时调用 memory_write… / 不要记一次性信息… / 记忆过时… / 只在当前页面命中作用域时…>
```

**volatile**（进尾部块，无内容时返回 `''`）

```
记忆条目（当前生效）：
<renderEntry 逐行>

另有 N 条记忆因长度限制未列出，可用 memory_list 查看。

其他站点已有记忆（需要时用 memory_list 取全文）：<siteList>
```

- `state.enabled === false` → `{ stable: '', volatile: '' }`（与现状一致，连冷启动文案都不注入）。
- 装箱预算 `INJECT_BUDGET_CHARS`（6000）、三层分组、半预算两趟补装逻辑**全部不变**，只是输出的两段分开承载。
- `usageBlock(writable)` 的选择由调用方传参：**ask 模式下强制按只读渲染**（§6.3）。

## 5. 工具 schema 瘦身（`agent/tools/schemas.ts`）

### 5.1 规则

| 动作 | 判据 | 例子 |
|---|---|---|
| **删** | 与 `SYSTEM_PROMPT`「工具使用要点」重复的跨工具引导 | `take_snapshot` 的「已知目标是什么时，优先用 query_page 定向查询而非倒整棵树」——系统提示词已有一份且它在前缀里 |
| **删** | 设计论证（实现理由、为什么这么设计） | 「描述对齐 chrome-devtools-mcp」这类元信息 |
| **压** | 冗长的边界说明压成短句 | 「穿透同源 iframe；跨域 iframe 内容无法读取，返回值的 skippedFrames 会计数」→「穿透同源 iframe；跨域 iframe 读不到，skippedFrames 计数」 |
| **合并** | 同一参数在多处重复的描述 | `query_page` 的 `locator` 现在在 `anyOf[0..2].description` + `properties` + 顶层 `locator.description` 共写了四遍 → 一份 |
| **留** | 工具特有操作要点 | uid 来源与失效、`detail` 档位差异、`region` 用法、长内容分步写入 |
| **留** | 用户可感知的后果 | 深度观测会出「正在调试此浏览器」提示条、附着期间用户开不了 DevTools |

### 5.2 逐工具过一遍

37 个全部过，重点是最贵的几个：`update_script`(2,292) / `query_page`(1,804) / `update_skill`(1,547) / `create_script`(953) / `evaluate_script`(909) / `memory_write`(834)。

### 5.3 防回涨

新增 `tests/agent/schema-budget.test.ts`：

- 全部 schema 序列化字符数 ≤ **14,500**（当前 19,783，瘦身后预计 ~12,900，留约 13% 余量）
- 单工具 ≤ **1,600** 字符（当前最大 2,292）

超限即测试失败，把「描述又写长了」变成 CI 可见的回归。

## 6. ask 工具集重划（`agent/mode.ts`）

### 6.1 新白名单（18 → 10）

```ts
export const ASK_MODE_TOOLS: ReadonlySet<string> = new Set([
  'take_snapshot',        // 读页面结构
  'query_page',           // 定向查询
  'take_screenshot',      // 截图（喂多模态）
  'list_pages',           // 列标签页
  'list_console_messages',
  'list_network_requests',
  'load_skill',           // 取技能正文
  'list_skills',
  'get_skill',
  'memory_list',          // 记忆只读（§3.4 修订，决策 7）
]);
```

**收走 8 个**（-5,232 字符）：`toggle_deep_observe`(738)、`get_network_request`(555)、`wait_for`(658)、`list_scripts`(733)、`get_script`(686)、`grep_script`(751)、`memory_write`(834)、`memory_delete`(277)。

理由：ask 的语义收窄为「看页面 + 答问 + 加载技能」。深度观测是调试/操作链路的开关，`get_network_request` 依赖它；`wait_for` 在没有操作可做的模式里无等待对象；脚本池读三件属于「写脚本」链路（agent 主场）。

### 6.2 `modePrompt('ask')` 文案同步

现文案写着「读控制台/网络/**脚本库**」，去掉脚本库，并补一句「本模式不产生任何持久化副作用（不写记忆、不改脚本/技能）」。

### 6.3 记忆块按只读渲染

`buildContext` 内计算：

```ts
const memoryForPrompt = memory ? { ...memory, writable: memory.writable && mode === 'agent' } : undefined;
```

否则 ask 模式下记忆块会宣传一个没下发的 `memory_write`（工具清单已由 `ASK_MODE_TOOLS` 过滤掉，但提示词没跟着变）。硬闸侧无需改动：`registry.executeTool` 的 ask 守卫先于记忆档位守卫拦截。

## 7. 技能清单封顶与检索

### 7.1 新纯函数模块 `agent/skill-brief.ts`

镜像 `agent/memory-prompt.ts` 的模式（prompt 整形逻辑独立成纯函数模块，便于单测）：

```ts
export const SKILL_LIST_CAP = 20;        // 用户技能上限（内置不占名额）
export const SKILL_DESC_MAX = 60;        // 描述字符上限

export interface SkillBrief {
  name: string;
  command: string;
  description: string;
  builtin?: boolean;
  createdAt: number;
}

/** 排序 + 封顶 + 截断。返回展示用 briefs 与未列出条数。 */
export function selectSkillBriefs(briefs: SkillBrief[], cap = SKILL_LIST_CAP):
  { shown: SkillBrief[]; hidden: number };

/** 描述截断：在 limit 之前最后一个「；」或「，」处切，无分隔符则硬切；超限追加「…」。 */
export function truncateDescription(desc: string, limit = SKILL_DESC_MAX): string;
```

- **排序**：`builtin` 在前（`createdAt` 升序 = builtin.md 顺序），非 builtin 在后（`createdAt` 降序，最新在前）。同 `createdAt` 用 `command` 字典序兜底保证全序（确定性是硬要求，决策 9）。
- **截断**：内置 4 个描述都在 45 字符内，不受影响。
- **`SkillBrief` 的归属**：类型定义从 `agent/context.ts` 搬到 `agent/skill-brief.ts`（它现在带 `builtin` / `createdAt` 两个新字段，且封顶逻辑与它同址）。`agent/context.ts` 转出以保持既有 import 不变：
  ```ts
  export type { SkillBrief } from './skill-brief';
  ```
  这样 `agent/loop.ts:7` 与 `agent/trace.ts:5` 的 `import type { SkillBrief } from './context'` 无需改动。

### 7.2 `buildSkillsPrompt`（`agent/context.ts`）

- 调 `selectSkillBriefs` 拿 `{ shown, hidden }`。
- 行格式不变：`- /<command> <name>：<截断后描述>`。
- `hidden > 0` 时追加一行：`另有 ${hidden} 个技能未列出，用 list_skills（可传 query 模糊搜索）查看`。
- 块首说明文案补一句「下面只列前 N 个」。
- `briefs.length === 0` 仍返回 `''`（与现状一致）。
- `SKILL_AUTHORING_GUIDE` 仍只在 agent 模式追加（现状保留）。

### 7.3 `SkillBrief` 数据来源（`background/agent-port.ts`）

`getSkills` 改为传全量启用技能（含 `builtin` / `createdAt`），排序与封顶交给 §7.1——**prompt 整形逻辑不落在 background 层**：

```ts
getSkills: async () =>
  (await listSkills().catch(() => [] as Skill[]))
    .filter((s) => s.enabled)
    .map((s) => ({ name: s.name, command: s.command, description: s.description,
                   builtin: s.builtin, createdAt: s.createdAt })),
```

### 7.4 `list_skills` 模糊搜索

**新纯函数 `shared/skill-search.ts`**：

```ts
export interface SkillSearchHit { skill: SkillSummary & { contentChars: number }; score: number; why: string }

/** 按 query 检索技能。空 query 返回原序全量。命中 0 个返回空数组（诊断文案由工具层组装）。 */
export function searchSkills(skills: SkillSearchHit['skill'][], query: string): SkillSearchHit[];
```

打分（归一化：`toLowerCase().trim()`）：

| 匹配 | 分 |
|---|---|
| `command` 精确相等 | 100 |
| `command` 子串 | 80 |
| `name` 子串 | 60 |
| `description` 子串 | 40 |
| 字符子序列命中（`wscr` → `write-script`） | 20 |

- 中文靠子串匹配即可，无需分词。
- 同分按 `command` 字典序兜底（确定性）。
- 空 query → 原序全量（保持现状行为）。

**工具层（`agent/tools/skill-pool.ts` `doListSkills`）**：

- 参数加 `query?: string`。
- 命中 0 个时**不返回空列表**——返回诊断：`{ skills: [], hint: '无匹配「xxx」；技能库共 N 个，前 10 个是：<command 列表>' }`（沿用 `query_page` 命中 0 个给改法的思路，避免模型读到空列表以为技能库是空的）。
- 命中时返回全部命中（已按分排序），不截断。

**schema（`agent/tools/schemas.ts`）**：`list_skills` 加 `query` 参数；描述补一句「系统提示词里只列前 20 个技能，需要找未列出的用 query 搜」。

## 8. 观测（`agent/trace.ts` / `components/convdebug/`）

`TurnContextSummary` 加 `volatileChars: number`（尾部易变块字符数），`summarizeContext` 统计末条 volatile 消息长度。conv-debug 轮次时间线展示。

理由：布局改动后，「system 变小了、但总量没变」是可能的误判来源，把 volatile 单独计一列才能看清构成。**这只是字符计量，不是缓存命中计量**（决策 12）。

## 9. 已知盲区（本期不解决，显式记录）

1. **无法验证缓存实际命中率**。决策 12 决定不做 `Usage.cachedTokens`（OpenAI `prompt_tokens_details.cached_tokens` / DeepSeek `prompt_cache_hit_tokens`）解析与展示。因此「前缀稳定化到底省了多少」只能靠推理，不能靠观测。若后续想验证，接入点明确：`agent/provider/openai-compat.ts` 的 usage 解析 + `agent/provider/types.ts` 的 `Usage` + conv-debug 时间线。
2. **历史超过 61 条后，历史正文的缓存每轮失效**（决策 4 不做分块滑窗）。tools+system 前缀不受影响。
3. **网关是否做前缀缓存不由本扩展控制**。前缀稳定化零行为成本，命中与否取决于上游；中转网关可能整段不计缓存。

## 10. 测试计划

**新增**

- `tests/agent/context-prefix-stability.test.ts`（核心不变量）：
  - 同一会话连续两轮（history 增长一条），除末条 volatile 外**逐字节相同**。
  - 把 `page.url` / `page.title` 改掉后，除末条 volatile 外仍逐字节相同。
  - 改记忆条目后，除末条 volatile 外仍逐字节相同。
  - volatile 为空时不追加消息（数组长度与改前一致）。
- `tests/agent/skill-brief.test.ts`：排序（内置在前、用户降序、`command` 兜底全序）、封顶 20、`hidden` 计数、描述在分隔符处截断、无分隔符硬切、内置 4 个不被截断。
- `tests/shared/skill-search.test.ts`：五档打分、command 精确置顶、子序列命中、中文子串、空 query 原序、命中 0 个返回空数组、同分 `command` 兜底。
- `tests/agent/schema-budget.test.ts`：总量 ≤ 14,500、单工具 ≤ 1,600。
- `tests/agent/mode.test.ts` 补：ask 工具集恰为 §6.1 的 10 个（集合相等断言，防止悄悄加回）。

**更新**

- `tests/agent/context.test.ts`、`tests/agent/skills-context.test.ts`：断言「页面信息在 system 里」的用例改为断言在末条 volatile 里。
- `tests/agent/memory-prompt.test.ts`：适配 `{ stable, volatile }` 返回形状；补 ask 只读渲染用例。
- `tests/agent/tools/skill-pool.test.ts`：补 `query` 与命中 0 个诊断。
- `tests/agent/tools/schemas.test.ts`：随描述瘦身调整既有断言。
- `tests/agent/trace.test.ts`：补 `volatileChars`。

## 11. 涉及文件

**改**

- `agent/context.ts` — 布局重排、system 组成、volatile 拼装、`buildSkillsPrompt` 接封顶
- `agent/memory-prompt.ts` — 返回 `{ stable, volatile }`
- `agent/mode.ts` — `ASK_MODE_TOOLS` 18→10、`modePrompt('ask')` 文案
- `agent/tools/schemas.ts` — 37 个描述瘦身 + `list_skills` 加 `query`
- `agent/tools/skill-pool.ts` — `doListSkills` 加 `query` 与命中 0 个诊断
- `background/agent-port.ts` — `getSkills` 传 `builtin` / `createdAt`
- `agent/trace.ts` — `volatileChars`
- `components/convdebug/TurnTimeline.tsx` — 展示 `volatileChars`
- `storage/traces.ts` — `TurnContextSummary` 加字段

**新增**

- `agent/skill-brief.ts` — 排序 / 封顶 / 截断纯函数
- `shared/skill-search.ts` — 技能检索打分纯函数
- 上述测试文件

**不动**

- `agent/compact.ts`、`agent/loop.ts`（仅 `buildContext` 调用点，签名不变）、`agent/tools/registry.ts`、`agent/permission.ts`、确认卡链路、GM API
