# AI 写脚本流程优化（分步写入 + 检索工具 + 卡死四修）设计

- 日期：2026-09-06
- 状态：设计已确认，待实施
- 分支：feat/ai-script-optimize

## 1. 问题诊断

现象：让 AI 写复杂脚本时，它说「现在帮你创建脚本」后长时间无任何输出，等很久也没结果；有时最终暂停报错。

排查结论 —— 四个机制叠加，不是单一 bug：

| # | 机制 | 证据 |
|---|---|---|
| 1 | **参数生成期零反馈**。模型吐完文本后开始生成 `create_script.source`（几万 token 的 JSON 转义串），这段时间面板收不到任何事件：`tool-call-delta` 只在 run-turn 内聚合、从不 emit，`tool-start` 要等 `message-done` 聚合完才发 | [run-turn.ts:47-54](../../../agent/run-turn.ts#L47-L54)、[messages.ts:108-120](../../../shared/messages.ts#L108-L120) 的 `AgentEvent` 无对应事件 |
| 2 | **`max_tokens` 从不下发 → 截断 → 重试循环**。loop 调 `runTurn` 不传 `maxTokens`，provider 的 `body.max_tokens` 永不设置，走服务端默认（多数兼容网关 2048~4096）。长脚本必然 `finish_reason=length`，走「参数不完整请重发」分支，模型重发、再截断，5 轮后 `errorThreshold` 熔断 paused | [loop.ts:101](../../../agent/loop.ts#L101)、[openai-compat.ts:120](../../../agent/provider/openai-compat.ts#L120)、[loop.ts:127](../../../agent/loop.ts#L127) |
| 3 | **10s 静默窗口与缓冲式网关互踩**。`llmTimeoutSec` 默认 10s：网关若把 `tool_calls.arguments` 缓冲后一次性下发，10s 内无字节即 abort 重试，三次全超时后报错。反向配置（设 0 = 不限时）时网关真挂死则 `runTurn` 的 Promise 永不 resolve，`runningConvs` 永久占位、面板永久 running | [settings.ts:38](../../../storage/settings.ts#L38)、[openai-compat.ts:153](../../../agent/provider/openai-compat.ts#L153) |
| 4 | **同一份代码在上下文存三份**。工具返回完整 `script`，loop 整个 `JSON.stringify` 进 tool 消息 → 模型的 `tool_call.arguments` 一份、结果里 `script.text` 一份、`script.code` 又一份。300 行脚本约 6k×3=18k token 一次入账，直接把上下文推到 80% 阈值触发自动压缩，再多一次 LLM 调用 | [script-pool.ts:74](../../../agent/tools/script-pool.ts#L74)、[loop.ts:203](../../../agent/loop.ts#L203) |

1 与 3 造成「没动静」的观感，2 造成「很慢且最后失败」，4 造成流程整体拖沓。

## 2. 目标

1. 长脚本走「骨架 → 分次追加」路径，单次模型输出降到几百 token 量级。
2. 参数生成期用户能看到进度，消除「卡死感」。
3. 读脚本按需分页/检索，不整份灌进上下文；写脚本不回灌全文。
4. 无论网关行为如何，运行态不会永久悬挂。

## 3. 卡死四修

### 3.1 下发 `max_tokens`

- `AgentSettings` 新增 `maxTokens: number`，默认 **8192**；`0` = 不下发（保留旧行为，给对该字段敏感的特殊网关）。设置页「模型设置」加一个数字输入。
- [loop.ts:101](../../../agent/loop.ts#L101) 的 `runTurn` 调用带上 `maxTokens`；`LoopDeps` 新增 `getMaxTokens?: () => Promise<number>`（缺省不下发，保持测试注入的旧行为）。
- `finishReason==='length' && toolCalls.length>0` 分支（[loop.ts:127](../../../agent/loop.ts#L127)）的 tool 消息文案改为教学式：
  > 错误：模型输出被截断，该工具调用参数不完整。若在写长脚本，请改用分步方式：先 `create_script` 只提交元数据头 + 骨架，再用 `update_script` 的 `patch.append` 分次追加代码体。

  错误返回是对模型最有效的纠正信号，比提示词约束更硬。

### 3.2 静默窗口

- `llmTimeoutSec` 默认 **10 → 60**。10s 对缓冲式网关与长 reasoning 都过短，是误杀主因。
- provider 内部对「不限时」加硬兜底：`timeoutMs === 0` 时按 **300s** 静默判死，杜绝 Promise 永不 resolve 导致的永久 running。实现为 `effectiveTimeout = timeoutMs > 0 ? timeoutMs : HARD_SILENT_CAP`，`armSilentTimer` 用它，其余逻辑不动。
- 连带更新 [tests/storage/settings.test.ts](../../../tests/storage/settings.test.ts) 中三处默认值断言。

### 3.3 新增 `tool-args-delta` 事件

- `AgentEvent` 加一支：`{ type: 'tool-args-delta'; name: string; bytes: number }`（`bytes` = 该 tool_call 参数已累计字节数，非增量）。
- `RunTurnHooks` 加 `onToolArgsDelta?: (name: string, bytes: number) => void`，在 run-turn 的 `tool-call-delta` 分支聚合后调用（此处已知 `name` 与累计长度）。
- **节流在 loop 侧**：`200ms 或 1KB 先到者发`，每轮 `runTurn` 前重置节流器。避免逐 token 广播的性能开销。
- `AgentTail` 加 `argsProgress?: { name: string; bytes: number }`：`tool-args-delta` 覆盖写入，`tool-start`/`done`/`paused`/`error` 已走 `emptyTail()` 自然清空。`replayTail` 在末尾补发一条 —— 切标签回来仍看到进度，且不会留僵尸进度条。
- chat store 的 `argsProgress` 存**顶层 state**（瞬态，不入 `messages`），`tool-start` 与终止事件清空；ChatView 在流式区域渲染「正在生成 create_script 参数… 3.2KB」。

### 3.4 工具返回瘦身

`create_script` / `update_script` 不再返回完整 `script`，改为精简形状：

```ts
{ id, name, lines, bytes, matches, enabled, runAt, world, warnings, balance }
```

`balance` 见 §4.5。省掉 `text`+`code` 双份回灌，单次约省 2/3 上下文。UI 侧的 `SCRIPTS_CREATE`/`SCRIPTS_UPDATE` 消息响应形状**不变**（详情页需要全文），瘦身只发生在 AI 工具层 [script-pool.ts](../../../agent/tools/script-pool.ts)。

## 4. 工具形状

### 4.1 写入原语：`append` 与 `replace`

`ScriptPatch`（[messages.ts:144](../../../shared/messages.ts#L144)）扩两支，现有 `text`（整文）/ `edit`（行区间）/ `enabled` / `applyUpdate` 全部保留不动：

```ts
export interface ScriptPatch {
  text?: string;
  enabled?: boolean;
  edit?: ScriptEditRange;
  applyUpdate?: boolean;
  /** 追加到原文末尾（不需要行号）。分步写脚本的主力原语。 */
  append?: string;
  /** 字符串精确替换（不依赖行号，绕开行号漂移）。 */
  replace?: { old: string; new: string; all?: boolean };
}
```

**`append` 语义**：拼到 `text` 末尾（若原文不以换行结尾则先补一个 `\n`），随后整体重解析。

> **关键约定：骨架不预先闭合 IIFE。** `create_script` 提交的骨架写到 `(function () {\n  'use strict';\n` 为止，**不写** `})();`；由最后一段 `append` 带上闭合。否则追加内容会落到 IIFE 外的全局作用域，拿不到内部变量、且污染页面。此约定必须同时写进 `create_script` 的 schema description 与 write-script 技能正文 —— 它是分步流程能否成立的前提，也是 §4.5 配平扫描「中间态 unclosed 属正常」的由来。

**`replace` 语义**：用 `split`/`join` 做字面量替换（不走正则，避开元字符陷阱）。
- `old` 未命中 → 报错「未找到该文本」。
- `old` 命中多处且未传 `all` → 报错并列出命中处的行号，提示「加上下文让 old 唯一，或传 all:true」。
- `all: true` → 全部替换。
- 命中 1 处 → 直接替换。

替换后整体重解析。

**互斥规则**：`applyUpdate` 保持最高优先（现有行为，与其余分支互斥且优先生效）。`text` / `edit` / `append` / `replace` 四支同传两支以上 → 报错列出冲突分支名，要求只传一支；不静默按优先级取一支（静默取舍会让模型误以为两处改动都生效）。`enabled` 可与任一支同传（不冲突，现有行为）。

注：现有实现里 `edit` 与 `text` 同传时静默偏向 `edit`（[scripts.ts:307-313](../../../background/scripts.ts#L307-L313)）。本次收紧为报错，属行为变更 —— 该组合此前无调用方依赖（UI 只传一支，工具 schema 也要求择一）。

### 4.2 硬闸：`create_script.source` 长度上限

工具层（[script-pool.ts](../../../agent/tools/script-pool.ts) 的 `doCreateScript`）在既有 matches 校验之前加：`source` 超过 **200 行或 8192 字符**即报错：

> create_script 的 source 过长（{n} 行 / {m} 字符，上限 200 行 / 8192 字符）。长脚本请分步：先只提交元数据头 + 未闭合的 IIFE 骨架，再用 update_script 的 patch.append 分次追加代码体，最后一段带上 `})();` 闭合。

阈值宽松 —— 200 行以下的脚本仍可一次写完，不白多一次往返。

**不受限的路径**：`create_script(url=...)` 直链导入、UI 导入、`patch.text` 整文替换、`patch.applyUpdate`。这些不是模型在逐 token 吐字，`MAX_TEXT_LENGTH`（280KB，[storage/scripts.ts:16](../../../storage/scripts.ts#L16)）继续管总量，两者各管一层。

### 4.3 `list_scripts` 加规模字段

`ScriptSummary`（[types.ts:83](../../../shared/types.ts#L83)）新增 `lines: number`、`bytes: number`，由 `toSummary` 计算（`text.split('\n').length` / `text.length`）。模型据此判断该不该分页读、要不要 grep 定位。UI 列表也可顺带显示规模。

### 4.4 `get_script` 行号标注 + 默认限量

改动**只在 AI 工具层**（`doGetScript`）：编排层 `handleGet` 的返回形状与语义完全不动，详情页 `SCRIPTS_GET` 拿到的仍是干净原文。

- **行号标注**：返回文本每行加前缀 `%4d| `（右对齐），如 `  12| const x = 1;`。目的是让模型做 `edit` 时不必自己数行。
- **默认限量**：模型不传 `offset`/`limit` 时，工具层自己按 `limit=200` 请求。总行数超 200 时在返回里附提示：
  > 已返回第 1-200 行（共 {totalLines} 行）。继续读用 offset=201，定位特定代码用 grep_script。
- schema description 同步说明行号前缀**不是文件内容**，写回时不要带上它。

### 4.5 新增 `grep_script`（工具 26 → 27）

```
grep_script({ pattern, id?, ignoreCase?, contextLines?, limit? })
  → { matches: [{ scriptId, name, line, text }], truncated, warning? }
```

- `id` 缺省 = 搜全库（能回答「哪个脚本动了这个选择器」）。
- `pattern` 按正则编译；非法正则降级为字面量子串搜索并在 `warning` 说明。
- `contextLines` 默认 0，`limit` 默认 50，超出置 `truncated: true`。
- 返回的 `text` 带行号前缀，与 `get_script` 一致。
- 纯 storage 读取：豁免受限页预检（与其余脚本工具同列），并加入 [mode.ts](../../../agent/mode.ts) 的 `ASK_MODE_TOOLS`（只读，ask 模式可用）。

### 4.6 配平扫描 `shared/js-balance.ts`

纯函数词法扫描（**不做 eval** —— SW 的 CSP 禁 eval，wrapper 里的 `new Function` 语法预探测跑在页面 USER_SCRIPT world，后台复用不了，见 [scripts.ts:170-173](../../../background/scripts.ts#L170-L173)）：

```ts
export function checkBalance(code: string): { ok: boolean; detail?: string }
```

逐字符扫描，跳过单/双引号串、模板串（含 `${}` 嵌套）、行/块注释、正则字面量；统计 `{}` `()` `[]` 配平与未闭合引号。正则字面量与除号的区分用「前一个有意义 token」启发式判定。

**只报告不阻断**：结果以 `balance: 'ok' | 'unclosed'`（+ `detail`）附在 create/update 的返回里。分步 append 的中间态**必然** unclosed（骨架不闭合 IIFE），阻断就没法分步了。提示词侧说明：中间态 unclosed 正常，最后一段写完应为 `ok`；若不 ok 就用 `grep_script` 找漏掉的括号。

抓得住「少个右括号」这类分步最典型的错误；抓不住语义错误 —— 那一层由注入后 `list_console_messages` 观测兜底（wrapper 的语法预探测会把 SyntaxError 打进 console，已有链路）。

## 5. 提示词与技能

### 5.1 write-script 技能正文（[builtin.md](../../../public/skills/builtin.md)）

第 1、2 步（确认需求 / 探索页面）不动。第 3 步「编写、安装、调试」重写为分步流程：

1. **提交骨架**：`create_script(source=元数据头 + 未闭合 IIFE)`。头部要求同旧版（`@name` 中文、`@match` 宁窄勿宽、`@version`、`@description`、必要时 `@run-at`）。骨架**不写** `})();`。
2. **分段追加**：`update_script(patch.append=...)` 按功能块逐段追加，每段 50~80 行。硬规则：**切在函数或语句块边界，绝不切在语句中间**。最后一段带上 `})();` 闭合 IIFE。
3. **确认配平**：最后一次 append 的返回应为 `balance: 'ok'`；不 ok 就用 `grep_script` 定位漏掉的括号，用 `patch.replace` 修正。
4. **注入验证**：`navigate_page` 到目标页（刷新触发注入）→ `list_console_messages` 看有无报错 → `take_screenshot` / `evaluate_script` 验证效果。
5. **迭代修正**：优先 `patch.replace`（精确、不依赖行号）；需要看代码时 `get_script` 按行区间读或 `grep_script` 定位，不要整份读回。
6. 收尾同旧版（说明作用范围、如何启停）。

技能正文一并声明「本扩展支持的 14 个 GM API」清单（沿用旧版内容，不变）。

### 5.2 schema description

- `create_script`：写明长度阈值、骨架不闭合 IIFE 的约定、超限时改走分步。
- `update_script`：写明 `append`/`replace` 语义与优先级、`replace` 的 `old` 需唯一、`balance` 字段含义。
- `get_script`：写明行号前缀不是内容、默认限量 200 行、翻页与 grep 的分工。
- `grep_script`：写明 `id` 缺省搜全库。
- `list_scripts`：提及 `lines`/`bytes` 用于判断读取策略。

### 5.3 SYSTEM_PROMPT

[context.ts:6](../../../agent/context.ts#L6) 的「工具使用要点」加一条通用规则（不限于脚本）：

> 写长内容（脚本、长文本）时不要一次性塞进单个工具参数 —— 单次输出有长度上限，超限会被截断。先建骨架再分次追加。

## 6. 测试

| 目标 | 用例 |
|---|---|
| `js-balance` | 平衡/缺右括号/多右括号；字符串与模板串里的括号不计入；`${}` 嵌套；正则字面量里的 `(` `[`；正则 vs 除号歧义；行注释与块注释里的引号；未闭合引号 |
| `append` | 追加后重解析投影字段；原文无尾换行时补换行；骨架 unclosed → 末段闭合后 `ok` |
| `replace` | 命中 1 处替换成功；未命中报错；命中多处未传 all 报错且列出行号；`all:true` 全替；`old` 含正则元字符（`.` `*` `(`）按字面量处理 |
| patch 互斥 | 多支同传报错；`applyUpdate` 优先 |
| 硬闸 | 201 行报错、200 行通过；8193 字符报错；`url` 分支与 `patch.text` 不受限 |
| `get_script` | 行号前缀格式与对齐；默认 limit=200 且超长时带提示；显式 offset/limit 仍生效；编排层 `handleGet` 返回不带行号（回归断言） |
| `grep_script` | 单脚本/全库；`ignoreCase`；`contextLines`；`limit` 截断置 `truncated`；非法正则降级并带 warning；无命中返回空数组 |
| `list_scripts` | `lines`/`bytes` 计算正确 |
| 返回瘦身 | create/update 返回不含 `text`/`code`（回归断言）；UI 消息响应仍含全文 |
| `max_tokens` | 设置值 → 请求体含 `max_tokens`；0 → 请求体无该字段 |
| 静默硬兜底 | `timeoutMs:0` 时仍在 300s 后判死（注入短 cap 测试） |
| `tool-args-delta` | run-turn 触发 hook 带累计字节；loop 节流（200ms/1KB）；`reduceTail` 写入 `argsProgress` 并在 `tool-start`/`done` 清空；`replayTail` 补发；chat store 顶层态更新与清空 |
| 截断教学文案 | `finishReason=length` + toolCalls 时 tool 消息含分步指引 |

## 7. 不做的事

- **不做草稿态分段提交**（`create → draftId → write_chunk → commit`）：引入草稿生命周期与 SW 重启丢失问题，`append` 已够。
- **不跳过中间态的 `syncRegistrations`**：每次 `append` 都会触发一次全量注册同步（[scripts.ts:326](../../../background/scripts.ts#L326)），分 5 段即 5 次。正确性优先，个人量级（<200 脚本）开销可接受。
- **不做真 eval 语法校验**：SW 禁 eval；offscreen document 同受 extension_pages CSP 限制，为此引入 sandbox 页不值当。配平扫描 + 注入后 console 观测两层够用。
- **不改 `edit` 行区间原语**：保留作兼容手段，不因为有了 `replace` 就删。
- **不做上下文里的代码去重**：瘦身返回已解决主要冗余，进一步做需要改 loop 的 tool 消息装配，收益不成比例。

## 8. 已知边界

- `append` 中间态的脚本若被注入（用户此刻刷新了匹配页面），wrapper 语法预探测会报 SyntaxError 到 console。属预期：脚本尚未写完。write-script 流程要求写完再刷新验证。
- `js-balance` 的正则字面量识别是启发式（靠前一个 token 判断 `/` 是除号还是正则开头），极端写法可能误判，导致 `balance` 误报。因为只报告不阻断，最坏后果是模型多花一次 grep 排查。
- 部分模型（如 o1 系列）用 `max_completion_tokens` 而非 `max_tokens`。本设计只下发 `max_tokens`；这类模型可把设置里的 `maxTokens` 置 0 关掉，或用 `extraBody` 自行补字段。
- `tool-args-delta` 的 `bytes` 是 JSON 转义后的字节数，比实际代码略大（引号/换行转义），进度显示仅供体感参考。
- 硬闸按「行数或字符数」判定，与 token 数只是近似关系。中文注释密集的脚本字符数少而 token 多，仍可能触发截断 —— 兜底靠 §3.1 的教学文案。




