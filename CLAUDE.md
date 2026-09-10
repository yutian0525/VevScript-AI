# ai-browser-extend

AI 驱动的浏览器操控助手。

让 AI 通过 accessibility snapshot（uid 树）和 DOM 动作操控网页。本项目是 Phase 1 骨架，已完成设计系统、侧边栏导航、聊天视图、脚本视图、设置视图和调试台。

## 技术栈

- **WXT** + **React 19** + **TypeScript 7**，面向 Chrome MV3（后续兼容 Firefox）。
- **Zustand**：状态管理（`stores/chat.ts`、`stores/ui.ts`）。
- **lucide-react**：图标（禁止用 emoji 代替图标）。
- **vitest v4** + **jsdom**：单元测试。

## 项目结构

```text
entrypoints/
  sidepanel/          侧边栏主 UI（App.tsx、styles.css）
  background.ts       Service Worker 入口
  content/            content script 入口
agent/
  tools/              工具注册表、schema、具体工具实现
  provider/           LLM provider 抽象
  run-turn.ts         agent 单轮执行
background/
  router.ts           消息路由
  agent-port.ts       长连接管理、CS_READY 等待
  debug-exec.ts       调试台工具执行通道
components/
  ui/                 通用 UI 组件
  chat/               聊天视图
  scripts/            脚本/快捷指令视图
  settings/           设置视图
  debug/              调试台视图
shared/
  messages.ts         前后台/CS 消息类型
stores/
  chat.ts             会话状态
  ui.ts               UI 状态
```

## 开发约定

### 样式

- 所有样式走 `entrypoints/sidepanel/styles.css`。
- 使用 CSS 变量（`:root` tokens），禁止硬编码色值。
- 当前主题色 `--signal: #53589a`，背景 `--paper: #efefef`。
- 双声道排版：`mono` 类用于机器语言（工具名、uid、JSON、状态令牌），`sans` 用于人语言。
- 组件通过 `className` 复用 `.btn`、`.input`、`.gauge` 等工具类。
- 动画必须考虑 `prefers-reduced-motion` 兜底。

### 工具开发

- 新增工具：在 `agent/tools/` 实现，注册到 `registry.ts`，并补充 schema。
- schema 会自动同步到调试台，无需额外修改 UI。
- 工具返回值统一使用 `{ ok: true, data? } | { ok: false; error }` 判别联合类型。

### 前后台通信

- 消息类型统一定义在 `shared/messages.ts`。
- 后台路由在 `background/router.ts`，入口挂在 `entrypoints/background.ts`。
- content script 就绪通知走 `CS_READY`，由 `background/agent-port.ts` 唤醒等待者。

## 常用命令

```bash
npm run dev          # 开发模式
npm run build        # 生产构建
npm run compile      # TypeScript 检查
npm run test         # 运行测试
```

## 当前阶段

`feature/phase1-skeleton` 已完成：

1. 设计系统落地（tokens、组件类、动效 keyframes、reduced-motion 兜底）。
2. 组件 className 化：`Button`、`Input`、`PageShell`、`ChatView`、`SettingsView`、`ScriptsView`。
3. Live 仪表条、滑动信号条导航、调试页入口。
4. 调试台 `DebugView` + 后台 `DEBUG_EXEC_TOOL` 通道 + 单测覆盖。

后续 Phase 2+ 将逐步接入真实 LLM 调用、完整 agent 循环、网络日志、多步任务等能力。

Phase 3a（感知与外联轻量集）已完成：新增 7 个工具 —— tabs 管理（list_pages/new_page/close_page/select_page，loop 持有可变 targetTab）、take_screenshot（喂多模态模型，注入 user 图片消息，压缩长边≤1024/jpeg，UI 卡片渲染缩略图）、evaluate_script（scripting.executeScript 注入包裹器 + 超时 + 序列化校验）、http_request（带凭证 fetch + 响应头白名单 + body 截断 64KB + 30s 超时）。工具总数 9→16。

Phase 3b（MAIN world hook 基础设施 + 观测三工具）已完成：新增 MAIN world content script（`world:'MAIN'` + document_start）包装 fetch/XHR/console + window.onerror/unhandledrejection，经 window.postMessage 桥给同页 ISOLATED content.ts（RELAY_READY 握手 + backlog flush 补早期观测），后者 runtime.sendMessage 中继到 SW 的 per-tab 环形缓冲（`background/observe-store.ts`）；webRequest 三事件（onBeforeRequest/onCompleted/onErrorOccurred）建全量网络元数据主干，hook 捕获的 fetch/XHR body 按 (method+url+±2s) best-effort 关联富化；主帧导航清网络缓冲、tab 关闭清全缓冲。新增 3 个工具 —— list_console_messages、list_network_requests、get_network_request（读 SW 缓冲、零 CS 往返、豁免受限页预检）。headers 只从 hook 取，入缓冲存原文、读取时按 `settings.agent.networkCaptureHeaders`（redacted 默认 / full）脱敏敏感头。工具总数 16→19。

多会话管理 + 输入框重构 + 上下文压缩（`docs/superpowers/specs/2026-09-01-multi-session-and-context-compaction-design.md`）已完成：会话升为独立实体（`storage/conversations.ts`，主键 `local:conv:{id}` + 轻量 `local:conv-index` 列表元数据），与标签页解绑——tabId 只作 agent 运行时操作目标、convId 作存储键与后台并发闸门（`runningConvs`）。侧边栏默认开空的新会话（客户端草稿 id，不落库，首条消息发出时 loop 的 appendMessage 才建档），会话间上下文隔离；页眉顶部下拉抽屉（`ConversationMenu`）管列表/新建/切换/行内重命名/删除。输入框重构为环形上下文指示器（`ContextRing` = 压缩按钮，`agent/context-meter.ts` 的 80%/95% 颜色档位，hover 详情，点击压缩），每轮 token 用量在 assistant 消息下方弱标注；上下文窗口来源 = `agent/model-windows.ts` 映射表兜底 + 设置页 `contextWindow` 覆盖。上下文压缩为 LLM 增量摘要（`agent/compact.ts`：保留近 20 条原始消息 + 摘要置顶入 `buildContext` + 原始消息永不删），loop 内达 80% 阈值自动触发、也可点环手动触发（`agent:compact`，与运行中 loop 互斥）；Port 协议新增 usage/compact-start/compact-done 事件驱动 UI（chat store 的 promptTokens/compacting 状态）。旧的按标签页会话存储（`storage/sessions.ts`）已弃用删除，安装时清理旧 `session:{tabId}` key。

**已知限制（后续迭代收口）**：(1) 自动压缩失败静默自愈（不弹错），仅手动压缩（用户显式点击）报错——刻意取舍；(2) ChatView 的上下文窗口分母只在挂载时读一次 settings，设置页改动后需重载侧边栏才刷新（loop 侧实时读取不受影响）；(3) 遗留死字段 `ToolCtx.sessionId`（实为 convId）、`ProviderConfig` 双定义（types.ts / settings.ts）待清理；(4) Markdown 渲染性能观察点：流式期间全部历史 assistant 消息每帧全量重解析（react-markdown 每次调用重建 processor、零 memoization），长会话（百条消息）流式有掉帧风险，症状出现时加 `React.memo(Markdown)` 一行即可收缩到流式那条；(5) 单换行 `\n` 按 CommonMark 塌缩为空格（中文模型逐句单换行会粘连成段），可感知时引入 remark-breaks。

assistant 消息 Markdown 渲染（`docs/superpowers/specs/2026-09-02-markdown-rendering-design.md`）已完成：`components/chat/Markdown.tsx` 纯渲染组件（react-markdown@10 + remark-gfm，GFM 表格/任务列表/删除线），components 覆盖表定制 code（行内 `md-code` mono 芯片）/pre（`md-codeblock` 复用 .well 井视觉 + 语言标签）/a（`_blank` + noreferrer）/table（`md-table-scroll` 横滚）/img（拒绝渲染）；流式 caret 为 CSS 伪元素（`md--live` 修饰类 + `.md > :last-child::after`，列表/引用/codeblock 尾部下沉一层防掉行，嵌套列表接受落子列表下方）；`.msg-assistant` 删 pre-wrap 交块级排版。安全 = react-markdown 默认行为（原始 HTML 转义、危险 scheme 过滤、零 dangerouslySetInnerHTML，不引入 DOMPurify）；覆盖组件必须解构 react-markdown 注入的 `node` prop（否则泄漏进 DOM，测试有回归断言）。首个组件渲染测试 `tests/chat/markdown.test.tsx`（@testing-library/react + jsdom，13 用例）。

会话续存 + 流式续播 + 滚动跟随已完成（本次三项修改）：

1. **切标签回来保持原会话**：当前会话指针存 `session:currentConvId`（`chrome.storage.session`，浏览器关闭时由浏览器自动清空），`useConversations.init()` 在面板挂载时读指针恢复会话，读不到才开新草稿——于是「同一次浏览器会话内切标签/重开面板」保持原会话，「浏览器重启后首次打开」才新开。`switchTo` 不再把 storage 的 `running` 强降为 idle。
2. **不打断任务、切回续播**：Port 协议拆成「领域事件 `AgentEvent`（loop 只管语义）+ 下行 `PortMsgToPanel = AgentEvent & {convId}`（分布式条件类型 `WithConv<T>` 叠加，直接交叉会破坏判别联合）」；SW 端 `panelPorts: Set<Port>` 广播替代捏死单端口，面板端口改为模块级单例（`stores/agent-port-client.ts`，跨 ChatView 卸载存活），按 `currentId` 过滤 convId 丢弃非当前会话事件。新增 `background/agent-tail.ts` 维护 per-conv「未落库的流式尾巴」（reasoning/text 增量累积，`tool-start`/`done`/`paused`/`error` 边界清空，`usage`/`state` 不动——因 loop 在 `usage` 之后才 `appendMessage`）；面板（重）挂载发 `agent:attach`，后台经 `buildAttachEvents` 回权威运行态（只认 `runningConvs` 有没有活 loop，storage 里的假 running 顺手修正回 idle）+ `replayTail` 补发尾巴。工具卡片刻意不进尾巴：`loadFromStorage` 把「有 toolCall 无结果」渲染成 `status:'running'`，随后到达的 `tool-end` 按 callId 幂等收口。chat store 新增 `sealed` 标记，防止补发的增量追加到 storage 载入的历史项上。
3. **滚动跟随**：`follow` 状态 + `.chat__stage` 定位层 + `.chat__tobottom` 悬浮钮（lucide `ArrowDownToLine`）；`onScroll` 距底 ≤32px 判定贴底，用户上滚即关跟随、滚回底部自动重开。流式期间一律瞬时滚动（smooth 的中间态会被 scroll 监听误判成用户上滚），只有点悬浮钮走 smooth 且尊重 `prefers-reduced-motion`。

待做（Phase 3c+）：见 `docs/superpowers/plans/2026-09-01-ai-browser-extension-phase3b.md` 末尾 handoff（已知降级：postMessage 同源页内可被监听、console.toString 反爬指纹、hookKeys 长命 SPA 增长、翻页迟到 flush、rel=noopener 无 openerTabId；未做：深度诊断模式 debugger/CDP、networkCaptureHeaders 设置页 UI）。

Phase 4（脚本池）已完成（`feature/phase4-script-pool`）：`chrome.userScripts` 注入引擎（enabled↔register/unregister diff 同步 + 启动自愈）、脚本 CRUD/搜索/导入导出/启停 UI（列表 + 详情双页）、per-tab 运行态跟踪（「预期注入」语义，SCRIPTS_RUNTIME 广播）、TM 元数据兼容（`shared/userscript-meta.ts` 解析/序列化，GM_* 不做、带警告徽标）、AI 六工具 `list/get/create/update/delete/toggle_script`（工具 19→25，与 UI 共用 `background/scripts.ts` 编排层；确认门控下阶段经该文件 handler 拦截位接入 `confirmGate`）。

Phase 4 修订（2026-09-02，文本为源）：`UserScript.text`（完整 .user.js 原文）为唯一真源，name/matches/code/runAt/world/meta 均为保存时 `parseUserScript` 的解析投影（旧记录 `stringifyUserScript` 反拼惰性迁移，text 上限 280KB）；`@include` pattern 形式并入 matches、新增 `@world` 键；`@match` 容错（合法并入、非法警告+跳过该条，不因一条坏规则整条拒绝导入——贴合 TM 导入即可用）；详情页=源码编辑器+实时解析面板（无表单填空）；工具修订：`get_script` 行区间读取（offset/limit + totalLines）、`create_script` 参数改 `source`（完整 .user.js 文本）、`update_script` patch={text | edit 行区间 | enabled}，替换后整体重解析。

Phase 5（GM_* API + 管理器优化）已完成：14 个 GM API（`shared/gm-apis.ts` 注册表为唯一入口；wrapper `shared/gm-wrapper.ts` 按 @grant 精确安装 + 值快照直嵌 + 语法预探测；桥 `shared/gm-bridge.ts` 三事件 gmreq/gmres/gmevt + 确定性 token `background/gm-token.ts`；ISOLATED 桥宿主 `content/gm-bridge-host.ts`；SW 中心 `background/gm-api.ts`——grant 白名单/值广播/菜单表/错误缓冲 + @connect 三分支 60s 确认队列 + 批准卡）；脚本错误捕获展示（环形缓冲 20 条 + 列表徽标 + 详情折叠区）；grant 徽标精确化（classifyGrants）；菜单命令入口（侧边栏脚本页）；@require/@resource 预取缓存（`background/gm-resources.ts`，7 天 TTL/单文件 2MB/总量 10MB）。API 文档 `docs/gm-api.md`。已知降级：无 unsafe header 改写（无 DNR）、XHR 非流式 ≤1MB、token 防伪非 VM 级、SW 重启丢内存态（菜单靠 reload 自愈）、handleUpdate 预取告警不进 UI、早到 gmreq 竞态（Phase 6 握手+backlog 收口）。工具计数 22 不变（summary 增字段）。

设置页枢纽 + 脚本运行时调试台（2026-09-03）已完成：railnav 减为 3 项（会话/脚本池/设置），调试台入口收进设置页。设置页改为壳（`components/settings/SettingsView.tsx` 内部 `useState` 二级路由，不持久化）→ 三入口：模型设置（`ModelSettings.tsx`，原表单平移）/ 工具调试台（`components/debug/ToolBenchPage.tsx`，按能力域 PAGE/TABS/NET/SCRIPTS 四分分组 + tag chip 四档，修正原 12 个错标 TABS）/ 脚本运行时调试台（`components/scriptdebug/ScriptDebugPage.tsx`）。工具能力域数据抽 `components/debug/tool-tags.ts`（可测），结果面板抽 `components/debug/ResultPanel.tsx`（工具台与 GM 台共用）。脚本运行时调试台三块：白名单视图（`GM_DEBUG_INFO` 回 grant 二分/@connect/始终允许主机/注入态）、GM API 列表（读 `GM_API_REGISTRY` 14 行）、三类直调（bridge 7 + SW 分支 2 完整真实链路，页面内 5 置灰）。直调链路：面板 `GM_DEBUG_CALL`→SW `bridgeTokensForUrl` 查 token→`GM_DEBUG_INVOKE` 下行 content→`gm-bridge-host.debugCall()` 在页面 dispatch `gmreq`（debug 命名空间 reqId 从 10 亿起）→宿主真实 token 校验 + `handleGmCall`→`gmres` 回环（10s 超时），除 wrapper 函数体外全链路真实。直调 api 用点形式短名（SetValue/XmlHttpRequest…）。已知边界：SW 内存态随重启丢失；页面内 5 API 置灰是第一版取舍；受限页因查不到 token 直接报错。

技能系统 + 斜杠指令（2026-09-04）已完成：`Skill` 实体（`local:skills:index`，command 唯一键 kebab-case——`saveSkill` 新增/更新两路径都校验，上限 100 条/正文 64KB/简述 200 字符）仅经 `.md` 导入产生（YAML frontmatter name/description/command + 正文，`shared/skill-md.ts` 手写最小解析：CRLF 归一化 + 启发式拆分——非 frontmatter 开头的段并回前一段并留「已并入」warning，序列化 name/description 换行防御；多文档 `\n---\n\n` 串联；同 command 覆盖更新保留 id/enabled，坏文档跳过+warning 带 filename 归属）；管理页 = 设置页二级页 `SkillsPage`（第四入口，列表搜索/多选导入聚合/导出 Blob 下载/启停/删除/详情只读，无新建无编辑）；启用技能简述经 `LoopDeps.getSkills` 每轮 `buildContext` 第 5 参注入 system prompt（`buildSkillsPrompt`，port 侧 storage 故障降级空数组）；斜杠指令 = 输入框 `/` 浮层（`components/chat/slash.ts` 纯函数 shouldOpenSlash/handleSlashKey/completeSlash + `SlashMenu` 展示组件，Enter/Tab/点击 = 补全 `/cmd ` 非发送，Esc dismissed 后输入变化重开，候选统一截断 8 条）+ loop 侧 `/^\/([a-z0-9-]+)(?:\s+([\s\S]*))?$/` 解析（原文落库，命中 enabled 技能把正文作为隐藏 system 消息仅注入触发轮——`pendingSlash` 消费即清防多轮重复，未命中原样普通文本；resumeAgentLoop 恢复轮不重新注入）；AI 自主调用为遵循式（无新工具位，工具数 25 不变）。已知取舍：多文档拆分对正文含 `---` 水平线的文档会并段+warning；浮层空匹配无占位行、blur 不关浮层、IME 组合期 Enter 未豁免（与既有 send-on-Enter 同病）；徽标正则不 trim 与 loop 侧 trim 后解析有纯外观分叉。

AI 写脚本流程优化（2026-09-06，`docs/superpowers/specs/2026-09-06-ai-script-authoring-optimization-design.md`）已完成，四修卡死 + 分步写入：

1. **卡死四修**：(a) loop 下发 `max_tokens`（`AgentConfig.maxTokens` 默认 8192，0=不下发；`LoopDeps.getMaxTokens` 每轮读 settings）；(b) `llmTimeoutSec` 默认 10→60s，且 `timeoutMs=0`（不限时）仍有 300s 静默硬兜底（`ProviderOptions.hardCapMs`，防网关挂死 → Promise 永不 resolve → runningConvs 永久占位 → 面板永久 running）；(c) 新增 `tool-args-delta` 事件（run-turn 的 `onToolArgsDelta` hook 回调累计字节 → loop 侧 `makeArgsThrottle` 节流（首次立即 + 满 200ms 或涨够 1KB）→ agent-tail `argsProgress` 续播 → chat store 顶层瞬态 → ChatView 消息流末尾进度条），根治「模型在写长参数时 UI 全静默」；(d) AI 工具层写操作返回瘦身（`toWriteResult`：id/name/lines/bytes/matches/enabled/runAt/world/warnings/balance，不回灌 text/code——同一份代码此前在上下文存三份）。
2. **分步写入**：`ScriptPatch` 扩 `append`（追加到末尾，不需行号）与 `replace`（`{old,new,all?}` 字面量精确替换，old 需唯一否则报错列行号）；`handleUpdate` 文本分支四支互斥（text/edit/append/replace 同传两支报错，不再静默取优先）；`create_script` 长度硬闸（`MAX_CREATE_LINES`=200 / `MAX_CREATE_CHARS`=8192，超限报错文案教分步；url 导入/patch.text 不受限）。骨架约定：create 只交元数据头 + 未闭合 IIFE（`(function () {` 结尾），末段 append 带 `})();` 闭合——提前闭合会让追加落到全局作用域。write-script 技能第 3 步重写为分步流程。
3. **配平扫描**：`shared/js-balance.ts` 纯函数词法扫描（跳过字符串/模板串含 `${}` 嵌套/注释/正则字面量，检查 {}()[] 配平与未闭合引号；不做 eval——SW CSP 禁 eval），写入返回带 `balance: 'ok' | 'unclosed'`（只报告不阻断——分步中间态必然 unclosed）。
4. **按需读取**：`list_scripts` 摘要加 `lines`/`bytes`；`get_script` 每行带 `%4d| ` 行号前缀（`annotateLines`，仅 AI 工具层，编排层 handleGet 不动）+ 默认限量 200 行 + notice 翻页提示；新增 `grep_script` 工具（26→27，`agent/tools/script-grep.ts`：正则优先非法降级字面量+warning、id 缺省搜全库、contextLines 去重膨胀、limit 截断；纯 storage 豁免受限页预检，进 ASK_MODE_TOOLS）。
5. **教学式纠正**：finishReason=length + toolCalls 的 tool 消息改为分步指引（截断 → create 骨架 → append 追加 → 末段闭合）；四个脚本工具 schema description 写入分步规则与 balance 判读；SYSTEM_PROMPT 加「写长内容先建骨架再分次追加」通用规则。已知边界：js-balance 的正则/除号区分是启发式（`return /re/` 会误判为除号）；`bytes` 是 UTF-16 code units 非严格字节；部分模型（o1 系）需 `maxTokens` 置 0 或经 extraBody 补 `max_completion_tokens`。

系统提示词自定义 + Agent 记忆（2026-09-07，`docs/superpowers/specs/2026-09-07-system-prompt-and-agent-memory-design.md`）已完成：

1. **系统提示词覆盖式自定义**：`Settings` 新增第三个顶层段 `prompt`（`{ custom, baseSnapshot? }`，上限 16KB），`resolveSystemPrompt(custom)` 决定用自定义还是内置 `SYSTEM_PROMPT`，经 `LoopDeps.getSystemPrompt` 每轮重读。**覆盖只替换 `SYSTEM_PROMPT` 常量，动态块照旧追加**（页面信息 + 技能清单 + 记忆 + 模式说明）——故记忆的用法指令必须放在记忆块而非 `SYSTEM_PROMPT` 里，否则覆盖提示词的用户会连带丢掉记忆能力说明。设置页第 2 张卡 `SystemPromptPage`（CodeMirror md 编辑器 + 预览切换 + 恢复默认 + 「你的自定义基于旧版内置提示词」提示条，靠保存时留的 `baseSnapshot` 快照比对；dirty 门控防「已保存」假象与零改动固化）。`CodeEditor` 泛化出 `language?: 'javascript' | 'markdown'`（新依赖 `@codemirror/lang-markdown`）。已知取舍：编辑后固化在当时版本，后续内置规则改进不自动进入；误删承重规则（uid/stale、分步写入、不可信输入）会让 agent 明显变笨且不易归因，页面上只做文案提示不做技术阻拦。
2. **Agent 记忆（条目式 + 站点作用域）**：`MemoryEntry`（`id` = nanoid(8) 省注入 token、`content` ≤500 字、`matches` 空数组 = 全局、`source: 'ai' | 'user'`）存单键 `local:memory:index`，上限 100 条；非法 match pattern **整条拒存**（不同于脚本池的「跳过坏规则 + 警告」——记忆只有一个 matches 字段，静默跳过会让 AI 以为写成功了而作用域是错的）。
3. **三层注入**（`agent/memory-prompt.ts` 纯函数）：全局记忆全文 → 当前页 `matchUrl` 命中的记忆全文 → 其余记忆只出**站点清单**（pattern + 条数，最多 30 个）。第三层是为了补「模型在导航**前**看不到目标站记忆」这个洞——记忆过滤依赖 `page.url`，而它每轮循环顶部才重读，导航后的新站记忆本来要等下一轮。预算 6000 字符由全局与站点两层**各分半、未用满的额度让给另一层**（全局被挤掉用户立刻察觉，站点被挤掉 agent 在当前页重复踩坑，都不能牺牲）。空库仍注入冷启动文案，否则模型永远不知道自己有这个能力。
4. **三个工具（27 → 30）**：`memory_list`（`scope` 两趟匹配——先当完整 URL 走 `matchUrl`，未命中再对 pattern 做子串匹配；带 `scope` 时排除全局记忆，因其已常驻注入）、`memory_write`（无 id 新增 / 带 id 改写，`matches` 传了才改，保留 `createdAt` 与 `source`）、`memory_delete`（幂等）。返回值瘦身（正文截 120 字、不回灌全库）。三个都进 `ASK_MODE_TOOLS`——ask 的语义是「不改网页/浏览器状态」，记忆只改扩展自己的本地笔记。新增 `MEMORY` 能力域（调试台第六组）。
5. **两个开关 + 三档守卫**：`AgentConfig.memoryEnabled`（关 = 不注入不下发）与 `memoryWritable`（关 = 只注入 + 只给 `memory_list`）→ `MemoryCap = 'off' | 'read' | 'full'`，`getToolSchemas(mode, cap)` 二维过滤 + `executeTool` 硬闸兜底拦幻觉调用（与既有 ask 守卫同一位置同一形状）。`MemoryState` 必须同时带 `enabled` 与 `writable`：仅有 `writable` 无法区分「总开关关闭」（完全静默）与「只读模式下记忆池为空」（注入只读版冷启动文案），两者 `entries` 都是空数组。
6. **设置页不走 background 路由**：`MemoryPage` 直接读写 `storage/memory.ts`（同 `ModelSettings` 直接读写 `storage/settings.ts`），刻意不照技能池的 `SKILLS_*` 消息链——记忆无 md 解析、无注入引擎、无 tabs 监听，那层间接省掉一个编排层、一组消息类型、一个 zustand store。加 `storage.watch` 让 AI 任务中写入时列表自动刷新。
7. **`buildContext` 签名重构**：6 个位置参数改 `(history, page, opts)`，`page` 仍是必需主参数，其余进具名 `opts`（原先再加两项就是 8 个位置参数）。

**已知限制**：(1) 覆盖提示词后固化在当时版本；(2) 同一轮内导航后的后续工具仍看不到新站记忆——三层注入让模型有能力主动规避（先 `memory_list` 再动手）但不强制，最坏延迟一轮；(3) click 触发的同标签跳转 URL 更新时序无保证（`navigate_page` 内部 `await waitForCsReady` 能保证，页内跳转不能——这是 `getPageInfo` 既有特性，非记忆新引入）；(4) 站点清单按 pattern 字面聚合，`*://bilibili.com/*` 与 `*://*.bilibili.com/*` 显示为两项；(5) `memory_list` 的 `scope` 第二趟是子串匹配，`scope: 'com'` 会命中大量条目；(6) AI 与用户并发写同一条时后写覆盖（wxt storage 无事务，`storage.watch` 会让面板刷新到最新值）。

页内脚本运行时 + 渐进式感知（2026-09-08，`docs/superpowers/specs/2026-09-07-page-script-runtime-and-progressive-perception-design.md`）已完成，对症两个实测问题：

1. **感知贵**（jsdom 实测：MDN 文档页快照 45,658 字符 / ~11,430 tokens 且已撞 1200 节点上限，知乎发现页 22,581 字符 / ~9,258 tokens；StaticText 与父 name 重复占 37~48%、绝对 URL 占 28~31%；tool 输出零截断 + 保留最近 60 条 → 8 步任务约 80k）。四改：StaticText 去重（省 20~27%）、URL 瘦身（同源省 origin、查询串截 30 带 … 标记、跨源超长保 host 只截 host 之后——host 是跨源分支存在的唯一理由，丢了模型会把外链误判成同源路径；再省 7~8%）、`take_snapshot` 分级（`interactive` 新默认 = 可交互角色 + 标题 + 视口内文本，其余折叠为计数行「… [N 个未展开节点]」（措辞刻意中性——被滤的可能是 img/navigation/list 这类非交互元素，写「纯文本已折叠」会误导），约省 54%；`full` 保留全量；`region` 限定子树），可交互白名单 20 个角色（13 标签路径产出 + 5 显式 ARIA 纯交互角色（searchbox/spinbutton/menuitemcheckbox/menuitemradio/treeitem——这些标签路径不产出、页面却会显式标注，漏掉即整行消失且折叠行无 name 无从定位）+ dialog/alertdialog 模态边界 + Iframe 帧边界行，见 `content/snapshot/filter.ts` 的 `INTERACTIVE_ROLES`）、新增 `query_page` 定向查询（几百 tokens，命中 0 时回 `relaxed` 逐级放宽 + `nearMiss` 候选 + 可执行 hint，见 `content/query.ts` + `content/locator-diagnose.ts`）。删死字段 `SNAPSHOT.verbose`（全项目无人消费）。
2. **动作失真**（「点了没反应」四因）：(a) iframe 完全不可见——`buildSnapshot` 与 locator 现均递归穿透同源 iframe，跨域帧计 `skippedFrames`；点击/输入行为交由 `content/interact.ts` 的既有 CS 动作工具承担。

**run_page_script 已拆除（2026-09-10）**：真机验证发现其默认路径（ISOLATED world）被扩展自身 CSP 拦死——`scriptRunner` 依赖 `AsyncFunction` 构造器编译脚本体（等价 eval），而 ISOLATED world 受扩展 CSP（`script-src 'self'`）管辖，MV3 不允许给扩展 CSP 加 `unsafe-eval`，此路无法修复。曾考虑的对照方案也各有硬伤：扩展的 `WORLD_CSP`（`background/scripts.ts`）只对 userScripts world 放行 eval，改走 `chrome.userScripts.execute` 需 Chrome 135+ 且 uid 表/helper 工厂均需跨世界重建（一块正经工作量）；main world 又受页面 CSP 约束、严格 CSP 站点同样会挂。故整链路拆除：`agent/tools/page-script.ts`、`content/script-runtime.ts`、`content/helpers/{events,index}.ts`、`/page-script` 技能（builtin.md 回到 3 篇）、工具计数 32 → 31。**保留**：`content/helpers/wait.ts` + `step-error.ts`（`wait_for` 工具复用其 waitFor 与 StepError）、`take_snapshot` 分级/region、`query_page`（locator 三形状 schema 已补 `anyOf` 显式声明——原 schema 只有 description 无类型约束，部分模型把语义对象/uid 序列化成 JSON 字符串上送被当 CSS 解析；CS 侧另加防御性 try-parse，形似 JSON 的字符串先解析再分派）。loop 层不变量随之泛化：**任何工具** data 里的 `screenshot` 字段一律摘出走 user 图片消息，base64 永不进文本上下文。

**已知限制**：(1) `near` 是启发式，会猜错（`nearTier` 可判读）；且锚点只认**可见文本**（`textContent` 包含匹配）——标签只在 `aria-label`/`placeholder` 里（无可见文字）时 near 找不到锚点，改用 `{role,text}`；(2) `waitFor({idle})` 等不到纯前端渲染（无请求）的变化，需用谓词形式；(3) ISOLATED 派发事件 `isTrusted:false`，校验它的库会拒（只有 CDP 能发真事件）；(4) 跨域 iframe 不可穿透，仅以 `skippedFrames` 告知盲区；(5) `interactive` 档可能漏掉非交互文本（折叠计数行保留结构感，可用 `region` 深入或退回 `full`）；(6) `wait_for` 的 `appear` 传失效 uid 会前置拦截立即报错（失效 uid 等 locator 轮询只可能死等到超时，`content/wait.ts`）。
