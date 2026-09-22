# 工具调用确认卡与三级确认策略 设计

- 日期：2026-09-22
- 状态：已确认（对话中设计获用户批准）
- 背景：agent 调工具目前零确认——`executeTool` 在 loop 里直接跑。系统里唯一的确认设施是脚本 GM API 用的 hub 标签页确认卡（`components/confirm/` + `background/confirm-queue.ts`），与 agent 会话无关。本期在侧栏会话流内加「工具调用确认卡」+ 三档确认策略（全部询问 / 仅敏感 / 自动放行），档位切换入口放在 ask/agent 选择器浮窗，选择器触发钮同步重构。

## 1. 关键决策记录

| # | 决策 | 选择 | 理由 |
|---|------|------|------|
| 1 | 确认卡位置 | 会话流内**单卡双态**（待确认就地展开面板，决策后折叠回一行工具卡） | 不开新标签页（区别于脚本确认卡）；一张卡对应一个调用，流里不重复占位 |
| 2 | 敏感清单划分 | 高危堆=敏感；微操堆不敏感；只读堆任何档位免确认 | 微操全确认则 agent 每点一个按钮都要点头，没法干活；只读全确认则每轮循环至少卡 1-2 次，直接瘫痪 |
| 3 | 敏感档判定方向 | **白名单放行**（敏感档只放行微操集，其余一律要问） | 未分类的新工具默认要问（fail-safe），漏登记的代价是「多问一次」而非「静默放行」 |
| 4 | 闸门位置 | `agent/loop.ts` 工具执行前 | loop 才有 convId、emit 通道、abort 信号；`executeTool` 是无状态分发器，塞不进「等人」语义 |
| 5 | 协议增量 | 单一新下行事件 `tool-confirm` + 单一新上行消息 `agent:confirm`；卡片状态转移复用既有 `tool-start`/`tool-end` | 协议增量最小；显式 `confirm-resolved` 事件与 `tool-end` 职责重叠（deny 时两事件抢一张卡的终态） |
| 6 | 超时 | 120s 自动拒绝 | 永不超时会让 loop 永久挂起（关掉侧栏后尤甚）；60s 读长参数不够用 |
| 7 | 决策按钮 | 允许执行 / 本次会话总是允许 / 拒绝 | 会话内记住是「全部询问」档的反疲劳关键 |
| 8 | 会话放行集 | loop 内存 `Set<toolName>`，不落库 | 权限记忆不该比任务活得久；SW 被杀重开任务重新问，重载扩展即失效 |
| 9 | 档位归属 | 全局设置 `settings.agent.confirmLevel` | 权限策略是用户级偏好；每次工具调用现读，中途改档下一发即生效（与 `getMode` 每轮重读同一哲学） |
| 10 | 默认档位 | `sensitive`（仅敏感） | 新机制的默认值应体现存在意义；现行为（零确认）等价于 `auto`，想要的人自己调 |
| 11 | ask 模式下的确认策略组 | 浮层内灰置 + 提示 | ask 只读，没东西可确认 |
| 12 | 设置页开关 | 本期不加，入口只在选择器浮层 | YAGNI |
| 13 | 被拒结果计入熔断阀 | 计入失败统计 | 模型连续被拒 → guard 暂停，属合理行为，无需新机制 |

## 2. 目标与非目标

**目标**

1. 会话流内确认卡：待确认的工具卡就地展开确认面板（工具名 + 风险标签 + 格式化参数 + 三按钮 + 倒计时），决策后折叠回普通一行工具卡。
2. 三档确认策略全局生效，选择器浮窗内切换，触发钮呈现「模式图标 + 权限状态文案」。
3. 待确认状态跨面板重挂载存活（attach 回放，倒计时按绝对时间戳连续）。
4. 停止 / 超时 / 拒绝三条路都能干净落卡、落 tool 消息、推进 loop，不悬挂。

**非目标（YAGNI）**

- 不动脚本 GM API 确认链路（`confirm-queue` / hub 页原样）。
- 不做跨会话/永久放行（只做会话内记住）。
- 不做设置页同款开关。
- 不改任何工具 schema、不改 system prompt——确认是执行侧闸门，模型无感，它只从被拒的 tool result 文案里读到发生了什么。

## 3. 分级模型（新文件 `agent/permission.ts`）

```ts
export type ConfirmLevel = 'all' | 'sensitive' | 'auto';   // 全部询问 / 仅敏感 / 自动放行

/** 敏感集：任意 JS、跨域网络、导航/开闭标签页、脚本池与技能池写入（写入即代码未来会自动跑）。 */
export const SENSITIVE_TOOLS: ReadonlySet<string> = new Set([
  'evaluate_script', 'http_request', 'navigate_page', 'new_page', 'close_page',
  'create_script', 'update_script', 'delete_script', 'toggle_script',
  'create_skill', 'update_skill', 'delete_skill',
]);

/** 微操集：页面细节交互 + 扩展自己的笔记。仅用于 sensitive 档白名单放行。 */
const MICROP_TOOLS: ReadonlySet<string> = new Set([
  'click', 'fill', 'fill_form', 'hover', 'scroll', 'press_key', 'select_page',
  'memory_write', 'memory_delete',
]);

export function needsConfirm(name: string, level: ConfirmLevel): boolean {
  if (level === 'auto') return false;
  if (isReadonlyTool(name)) return false;   // ASK_MODE_TOOLS \ MEMORY_WRITE_TOOLS（复用 agent/mode.ts）
  if (level === 'all') return true;
  return !MICROP_TOOLS.has(name);           // sensitive：微操放行，敏感+未分类一律问
}
```

三堆覆盖全部 37 个工具名：只读 16（ask 白名单减记忆写）、敏感 12、微操 9。微操集不参与 `all`/`auto` 判定（`all` 全问、`auto` 全放），只做 sensitive 档的放行白名单。

**归类完备性测试**：遍历 `TOOL_SCHEMAS` 全部工具名，断言每个名字恰好落入 只读/微操/敏感 之一——防未来新增工具漏分类（漏了会在 sensitive 档默认要问，测试把「默认要问」变成显式决定）。

## 4. 设置（`storage/settings.ts`）

`AgentConfig` 增加 `confirmLevel: ConfirmLevel`，默认 `'sensitive'`。走既有 `SettingsPatch` merge 机制，无额外迁移。

## 5. 协议（`shared/messages.ts`）

```ts
// AgentEvent 新增：
| { type: 'tool-confirm'; callId: string; name: string; args: string; until: number }
// until = createdAt + 120_000 绝对时间戳（跨重挂载倒计时连续）

// PortMsgFromPanel 新增：
| { type: 'agent:confirm'; convId: string; callId: string; decision: 'allow' | 'allow-session' | 'deny' }
```

`args` 直接用 loop 手里的 `tc.arguments` 原文（未解析 JSON 串），不做二次序列化。

## 6. loop 侧（`agent/loop.ts`）

`LoopDeps` 新增两个可选 dep（**两者都缺省 = 不设闸**，旧行为，测试与调试链路零改动；生产 `makeDeps` 必传）：

```ts
getConfirmLevel?: () => Promise<ConfirmLevel>;
confirmToolCall?: (req: { callId: string; name: string; args: Record<string, unknown> })
  => Promise<'allow' | 'allow-session' | 'deny' | 'timeout'>;
```

`drive()` 内局部持有会话放行集 `const sessionAllowed = new Set<string>()`（随 loop 生灭）。每个工具调用在参数解析后、执行前：

```
needConfirm = deps.confirmToolCall 存在
  && !sessionAllowed.has(name)
  && needsConfirm(name, (await deps.getConfirmLevel?.()) ?? 'sensitive')

不确认 → 现状路径：emit tool-start → executeTool → …
要确认 →
  emit { type:'tool-confirm', callId, name, args: tc.arguments, until: Date.now() + CONFIRM_TIMEOUT_MS }
  verdict = await deps.confirmToolCall({ callId, name, args: toolArgs })
  ├─ 'allow' / 'allow-session'
  │    → 'allow-session' 记入 sessionAllowed
  │    → emit tool-start（卡片翻转回运行态）→ executeTool → tool-end（现状不变）
  └─ 'deny' / 'timeout'
       → 不发 tool-start，直接 emit tool-end(ok:false, summary:'已拒绝' | '确认超时')
       → tool 消息 content（模型可读）：
          deny:    用户拒绝了该操作（{name}）。不要原样重试；向用户说明情况或提出替代方案。
          timeout: 确认超时（120 秒无响应），已自动取消 {name}。可继续其他操作，或询问用户。
```

- `CONFIRM_TIMEOUT_MS = 120_000`，常量放 `agent/permission.ts`。
- trace：`TurnToolRecord` 增 `confirm?: 'allow' | 'allow-session' | 'deny' | 'timeout'` 与 `confirmMs?: number`（决策等待时长）。`ms` 保持「执行耗时」原语义；deny 时 `ms: 0`。convdebug 时间线顺手加一枚决策标记（token 小改）。
- 熔断阀：deny 的 `ToolResult` 为 `ok:false`，被 `recordTurn` 计入失败统计（决策 #13）。

## 7. 后台接线（`background/agent-port.ts`）

- 模块级 `pendingConfirms = new Map<convId, PendingConfirm>()`，单槽即可（单 conv 单 loop，loop 内逐个 await）。`PendingConfirm = { callId, name, args, until, resolve }`。
- `makeDeps`：
  - `getConfirmLevel`: `async () => (await getSettings()).agent.confirmLevel`
  - `confirmToolCall`: 登记 pending → `broadcast(convId, { type:'tool-confirm', … })` → 等三者任一：`agent:confirm` 消息 resolve / 120s timer resolve `'timeout'` / loop 的 AbortController abort resolve `'deny'`（停止键）。finally 清槽。
- Port 上行处理：`'agent:confirm'` → 查 `pendingConfirms.get(convId)`，**callId 一致才 resolve**（防陈旧确认串轮），`decision` 原样传给 loop（`'allow-session'` 的记名动作在 loop）。查无此条 = 空操作（幂等，覆盖超时后才点按钮的场景）。
- loop 结束清理：`runningConvs.delete` 附近同步清 `pendingConfirms` 并兜底 resolve，防悬挂。
- **重挂载存活**：`buildAttachEvents` 若该 conv 有 pending，事件序列**末尾**追加 `tool-confirm` 事件（放在 state/尾巴回放之后，让它赢下同帧的 argsProgress 清理）。`until` 是绝对时间戳，倒计时天然连续。

## 8. 面板

### 8.1 store（`stores/chat.ts`）

- `ChatItem.status` 扩为 `'running' | 'done' | 'confirm'`；新增 `confirmUntil?: number`。
- `applyEvent` 新分支：
  - `'tool-confirm'`：`collapseTrailingThinking`；按 callId 幂等——已有卡（`loadFromStorage` 把「落库无结果」渲染成 running 的卡）原位翻转为 confirm 态，无卡则 push；清 `argsProgress`。
  - `'tool-start'` 幂等分支扩展：已存在同 callId 卡且 status 为 confirm → 翻转 running（其余幂等跳过行为不变）。
  - `'tool-end'` 现状按 callId 原位终结，天然覆盖 deny/timeout（不发 tool-start 的路径）。

### 8.2 确认态卡片（`ChatView.tsx` MessageRow）

- `status === 'confirm'` 渲染确认面板（独立块，不走 tooltip-button 折叠结构）：
  - 头：`ShieldAlert` + 工具名（mono）+ 风险标签（`SENSITIVE_TOOLS.has(name)` → 「敏感」，否则「写入」；面板可直接 import `agent/permission.ts` 的纯函数）
  - 参数：`well` 块 + 复用 `formatArgs`
  - 按钮行：允许执行（primary）/ 本次会话总是允许（default）/ 拒绝（danger）+ mono 倒计时（deadline = `confirmUntil`，每秒 tick；归零只显示「已超时」，**本地不做决策**，权威收尾永远来自后台 tool-end）
- 点击决策 → `postToAgent({ type:'agent:confirm', convId, callId, decision })`，本地立即置禁用态防双击；卡片翻转由 `tool-start`/`tool-end` 事件权威驱动。
- 决策留痕口径：deny/timeout 的终态 summary（「已拒绝」/「确认超时」）即留痕；allow 后走正常业务摘要，不加「已允许」——执行成功本身就说明放行了。

### 8.3 选择器重构（`ModeSelect.tsx`）

- **触发钮**：`Eye`（ask）/`Bot`（agent）图标 + 权限状态文案（ask → 「只读」；agent → 「全部询问 / 仅敏感 / 自动放行」）+ 底背景色 chip（`--sunken` 系 token；ask 前景保留 signal-ink）；**去掉 ChevronDown**。tooltip 改为双行说明（行为模式 + 确认策略）。
- **浮层**两组：
  - 行为模式：现有 Agent/Ask 两项不动。
  - 确认策略：三档 + 描述文案（全部询问=每个写操作都问你 / 仅敏感=高危操作才问 / 自动放行=全部放行）。组标题走 token 样式；键盘 ↑↓ 导航扁平跨两组五项。
  - ask 模式下确认策略组 disabled + hint「只读模式无需确认」。
- 选档即 `saveSettings({ agent: { confirmLevel } })` + 组件本地 state 直写（组件直连 storage 有 `ChatView` 读 `getSettings` 先例）；挂载时读一次初值。运行中 loop 每发工具现读 settings，权威永远在 storage，UI 只是影子。

### 8.4 样式（`styles.css`）

- `.toolconfirm` 系列类（面板块 / 头部 / 按钮行 / 倒计时），全部走 `:root` token，动画带 `prefers-reduced-motion` 兜底。
- `.modeselect__trigger` chip 化：加背景、去 chevron 相关样式；ask 态前景色沿用 `--signal-ink`。

## 9. 边界情况

| 场景 | 行为 |
|---|---|
| 面板全程关闭 | 120s 自动拒绝 → 落 tool 消息 → loop 继续（模型读到拒绝自行汇报） |
| 确认等待中点停止 | abort → `confirmToolCall` resolve `'deny'` → 该调用落 deny 终态 → loop 下一检查点干净退出 |
| 确认等待中切会话再切回 | attach 回放 `tool-confirm`，倒计时按绝对 `until` 继续 |
| 多会话并行 | `pendingConfirms` 按 convId 各一槽，互不干扰 |
| 超时后才点按钮 | 后台查无 pending（已清槽）→ 空操作；面板侧 tool-end 已终结卡片 |
| 双击决策按钮 | 面板本地禁用 + 后台 callId 校验幂等 |
| SW 中途被杀 | pendingConfirm 与 loop 同灭；storage 里无结果调用渲染 running（既有已知限制，本期不修） |
| ask 模式 + 全部询问 | `memory_write`/`memory_delete` 要确认（属微操堆），纯只读工具仍免 |

## 10. 测试计划

- `tests/agent/permission.test.ts`：三档 × 三堆判定矩阵；`TOOL_SCHEMAS` 全名归类完备性断言；超时常量。
- `tests/agent/loop.test.ts` 增补：allow 路径（决策后才有 tool-start、工具真执行）；deny（不执行、tool-end ok:false、tool 消息含引导文案）；timeout（同 deny、文案不同）；`allow-session` 后同工具第二发不再 emit `tool-confirm`；confirm 等待中 abort。
- `tests/stores/chat.test.ts` 增补：`tool-confirm` 建卡 / 翻转既有 running 卡（幂等）/ 清 argsProgress；`tool-start` 翻转 confirm 卡；`tool-end` 终结 confirm 卡。
- `tests/storage/settings.test.ts`：`confirmLevel` 默认 `'sensitive'` + patch 回读。
- attach 回放用例：`buildAttachEvents` 带 pending confirm 的补发序列；`agent:confirm` 陈旧/重复消息幂等。

## 11. 涉及文件

| 文件 | 动作 |
|---|---|
| `agent/permission.ts` | 新增：ConfirmLevel、SENSITIVE_TOOLS、MICROP_TOOLS、needsConfirm、CONFIRM_TIMEOUT_MS |
| `shared/messages.ts` | `tool-confirm` 事件 + `agent:confirm` 上行消息 |
| `storage/settings.ts` | `agent.confirmLevel` 字段与默认值 |
| `agent/loop.ts` | 确认闸门、sessionAllowed、deny/timeout 路径 |
| `storage/traces.ts` | `TurnToolRecord.confirm` / `confirmMs` |
| `background/agent-port.ts` | confirmToolCall 实现、pendingConfirms、`agent:confirm` handler、attach 回放 |
| `stores/chat.ts` | confirm 态卡片状态机 |
| `components/chat/ChatView.tsx` | 确认面板渲染与决策发送 |
| `components/chat/ModeSelect.tsx` | 触发钮重构 + 浮层两组 |
| `entrypoints/sidepanel/styles.css` | `.toolconfirm` 系列、触发钮 chip 化 |
| `components/convdebug/*` | 时间线工具条目加决策标记（token 小改） |
| `docs/history.md` | 迭代记录 |
| 测试 | §10 所列 |
