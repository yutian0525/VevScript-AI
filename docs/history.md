# 开发历程记录

> 本文件由 CLAUDE.md「当前阶段」迁出（2026-09-10）：逐项迭代的完成记录、设计细节与踩坑存档于此，CLAUDE.md 只保留活跃约定与指针。各迭代的完整设计文档在 `docs/superpowers/specs/`，实施计划在 `docs/superpowers/plans/`。

## Phase 1（骨架）

`feature/phase1-skeleton` 已完成：

1. 设计系统落地（tokens、组件类、动效 keyframes、reduced-motion 兜底）。
2. 组件 className 化：`Button`、`Input`、`PageShell`、`ChatView`、`SettingsView`、`ScriptsView`。
3. Live 仪表条、滑动信号条导航、调试页入口。
4. 调试台 `DebugView` + 后台 `DEBUG_EXEC_TOOL` 通道 + 单测覆盖。

后续 Phase 2+ 将逐步接入真实 LLM 调用、完整 agent 循环、网络日志、多步任务等能力。

## Phase 3a（感知与外联轻量集）

已完成：新增 7 个工具 —— tabs 管理（list_pages/new_page/close_page/select_page，loop 持有可变 targetTab）、take_screenshot（喂多模态模型，注入 user 图片消息，压缩长边≤1024/jpeg，UI 卡片渲染缩略图）、evaluate_script（scripting.executeScript 注入包裹器 + 超时 + 序列化校验）、http_request（带凭证 fetch + 响应头白名单 + body 截断 64KB + 30s 超时）。工具总数 9→16。

## Phase 3b（MAIN world hook 基础设施 + 观测三工具）

已完成：新增 MAIN world content script（`world:'MAIN'` + document_start）包装 fetch/XHR/console + window.onerror/unhandledrejection，经 window.postMessage 桥给同页 ISOLATED content.ts（RELAY_READY 握手 + backlog flush 补早期观测），后者 runtime.sendMessage 中继到 SW 的 per-tab 环形缓冲（`background/observe-store.ts`）；webRequest 三事件（onBeforeRequest/onCompleted/onErrorOccurred）建全量网络元数据主干，hook 捕获的 fetch/XHR body 按 (method+url+±2s) best-effort 关联富化；主帧导航清网络缓冲、tab 关闭清全缓冲。新增 3 个工具 —— list_console_messages、list_network_requests、get_network_request（读 SW 缓冲、零 CS 往返、豁免受限页预检）。headers 只从 hook 取，入缓冲存原文、读取时按 `settings.agent.networkCaptureHeaders`（redacted 默认 / full）脱敏敏感头。工具总数 16→19。

待做（Phase 3c+）：见 `docs/superpowers/plans/2026-09-01-ai-browser-extension-phase3b.md` 末尾 handoff（已知降级：postMessage 同源页内可被监听、console.toString 反爬指纹、hookKeys 长命 SPA 增长、翻页迟到 flush、rel=noopener 无 openerTabId；未做：深度诊断模式 debugger/CDP、networkCaptureHeaders 设置页 UI）。

## 多会话管理 + 输入框重构 + 上下文压缩

（`docs/superpowers/specs/2026-09-01-multi-session-and-context-compaction-design.md`）已完成：会话升为独立实体（`storage/conversations.ts`，主键 `local:conv:{id}` + 轻量 `local:conv-index` 列表元数据），与标签页解绑——tabId 只作 agent 运行时操作目标、convId 作存储键与后台并发闸门（`runningConvs`）。侧边栏默认开空的新会话（客户端草稿 id，不落库，首条消息发出时 loop 的 appendMessage 才建档），会话间上下文隔离；页眉顶部下拉抽屉（`ConversationMenu`）管列表/新建/切换/行内重命名/删除。输入框重构为环形上下文指示器（`ContextRing` = 压缩按钮，`agent/context-meter.ts` 的 80%/95% 颜色档位，hover 详情，点击压缩），每轮 token 用量在 assistant 消息下方弱标注；上下文窗口来源 = `agent/model-windows.ts` 映射表兜底 + 设置页 `contextWindow` 覆盖。上下文压缩为 LLM 增量摘要（`agent/compact.ts`：保留近 20 条原始消息 + 摘要置顶入 `buildContext` + 原始消息永不删），loop 内达 80% 阈值自动触发、也可点环手动触发（`agent:compact`，与运行中 loop 互斥）；Port 协议新增 usage/compact-start/compact-done 事件驱动 UI（chat store 的 promptTokens/compacting 状态）。旧的按标签页会话存储（`storage/sessions.ts`）已弃用删除，安装时清理旧 `session:{tabId}` key。

**已知限制（后续迭代收口）**：(1) 自动压缩失败静默自愈（不弹错），仅手动压缩（用户显式点击）报错——刻意取舍；(2) ChatView 的上下文窗口分母只在挂载时读一次 settings，设置页改动后需重载侧边栏才刷新（loop 侧实时读取不受影响）；(3) 遗留死字段 `ToolCtx.sessionId`（实为 convId）、`ProviderConfig` 双定义（types.ts / settings.ts）待清理；(4) Markdown 渲染性能观察点：流式期间全部历史 assistant 消息每帧全量重解析（react-markdown 每次调用重建 processor、零 memoization），长会话（百条消息）流式有掉帧风险，症状出现时加 `React.memo(Markdown)` 一行即可收缩到流式那条；(5) 单换行 `\n` 按 CommonMark 塌缩为空格（中文模型逐句单换行会粘连成段），可感知时引入 remark-breaks。

## assistant 消息 Markdown 渲染

（`docs/superpowers/specs/2026-09-02-markdown-rendering-design.md`）已完成：`components/chat/Markdown.tsx` 纯渲染组件（react-markdown@10 + remark-gfm，GFM 表格/任务列表/删除线），components 覆盖表定制 code（行内 `md-code` mono 芯片）/pre（`md-codeblock` 复用 .well 井视觉 + 语言标签）/a（`_blank` + noreferrer）/table（`md-table-scroll` 横滚）/img（拒绝渲染）；流式 caret 为 CSS 伪元素（`md--live` 修饰类 + `.md > :last-child::after`，列表/引用/codeblock 尾部下沉一层防掉行，嵌套列表接受落子列表下方）；`.msg-assistant` 删 pre-wrap 交块级排版。安全 = react-markdown 默认行为（原始 HTML 转义、危险 scheme 过滤、零 dangerouslySetInnerHTML，不引入 DOMPurify）；覆盖组件必须解构 react-markdown 注入的 `node` prop（否则泄漏进 DOM，测试有回归断言）。首个组件渲染测试 `tests/chat/markdown.test.tsx`（@testing-library/react + jsdom，13 用例）。

## 会话续存 + 流式续播 + 滚动跟随

1. **切标签回来保持原会话**：当前会话指针存 `session:currentConvId`（`chrome.storage.session`，浏览器关闭时由浏览器自动清空），`useConversations.init()` 在面板挂载时读指针恢复会话，读不到才开新草稿——于是「同一次浏览器会话内切标签/重开面板」保持原会话，「浏览器重启后首次打开」才新开。`switchTo` 不再把 storage 的 `running` 强降为 idle。
2. **不打断任务、切回续播**：Port 协议拆成「领域事件 `AgentEvent`（loop 只管语义）+ 下行 `PortMsgToPanel = AgentEvent & {convId}`（分布式条件类型 `WithConv<T>` 叠加，直接交叉会破坏判别联合）」；SW 端 `panelPorts: Set<Port>` 广播替代捏死单端口，面板端口改为模块级单例（`stores/agent-port-client.ts`，跨 ChatView 卸载存活），按 `currentId` 过滤 convId 丢弃非当前会话事件。新增 `background/agent-tail.ts` 维护 per-conv「未落库的流式尾巴」（reasoning/text 增量累积，`tool-start`/`done`/`paused`/`error` 边界清空，`usage`/`state` 不动——因 loop 在 `usage` 之后才 `appendMessage`）；面板（重）挂载发 `agent:attach`，后台经 `buildAttachEvents` 回权威运行态（只认 `runningConvs` 有没有活 loop，storage 里的假 running 顺手修正回 idle）+ `replayTail` 补发尾巴。工具卡片刻意不进尾巴：`loadFromStorage` 把「有 toolCall 无结果」渲染成 `status:'running'`，随后到达的 `tool-end` 按 callId 幂等收口。chat store 新增 `sealed` 标记，防止补发的增量追加到 storage 载入的历史项上。
3. **滚动跟随**：`follow` 状态 + `.chat__stage` 定位层 + `.chat__tobottom` 悬浮钮（lucide `ArrowDownToLine`）；`onScroll` 距底 ≤32px 判定贴底，用户上滚即关跟随、滚回底部自动重开。流式期间一律瞬时滚动（smooth 的中间态会被 scroll 监听误判成用户上滚），只有点悬浮钮走 smooth 且尊重 `prefers-reduced-motion`。

## Phase 4（脚本池）

已完成（`feature/phase4-script-pool`）：`chrome.userScripts` 注入引擎（enabled↔register/unregister diff 同步 + 启动自愈）、脚本 CRUD/搜索/导入导出/启停 UI（列表 + 详情双页）、per-tab 运行态跟踪（「预期注入」语义，SCRIPTS_RUNTIME 广播）、TM 元数据兼容（`shared/userscript-meta.ts` 解析/序列化，GM_* 不做、带警告徽标）、AI 六工具 `list/get/create/update/delete/toggle_script`（工具 19→25，与 UI 共用 `background/scripts.ts` 编排层；确认门控下阶段经该文件 handler 拦截位接入 `confirmGate`）。

## Phase 4 修订（2026-09-02，文本为源）

`UserScript.text`（完整 .user.js 原文）为唯一真源，name/matches/code/runAt/world/meta 均为保存时 `parseUserScript` 的解析投影（旧记录 `stringifyUserScript` 反拼惰性迁移，text 上限 280KB）；`@include` pattern 形式并入 matches、新增 `@world` 键；`@match` 容错（合法并入、非法警告+跳过该条，不因一条坏规则整条拒绝导入——贴合 TM 导入即可用）；详情页=源码编辑器+实时解析面板（无表单填空）；工具修订：`get_script` 行区间读取（offset/limit + totalLines）、`create_script` 参数改 `source`（完整 .user.js 文本）、`update_script` patch={text | edit 行区间 | enabled}，替换后整体重解析。

## Phase 5（GM_* API + 管理器优化）

已完成：14 个 GM API（`shared/gm-apis.ts` 注册表为唯一入口；wrapper `shared/gm-wrapper.ts` 按 @grant 精确安装 + 值快照直嵌 + 语法预探测；桥 `shared/gm-bridge.ts` 三事件 gmreq/gmres/gmevt + 确定性 token `background/gm-token.ts`；ISOLATED 桥宿主 `content/gm-bridge-host.ts`；SW 中心 `background/gm-api.ts`——grant 白名单/值广播/菜单表/错误缓冲 + @connect 三分支 60s 确认队列 + 批准卡）；脚本错误捕获展示（环形缓冲 20 条 + 列表徽标 + 详情折叠区）；grant 徽标精确化（classifyGrants）；菜单命令入口（侧边栏脚本页）；@require/@resource 预取缓存（`background/gm-resources.ts`，7 天 TTL/单文件 2MB/总量 10MB）。API 文档 `docs/gm-api.md`。已知降级：无 unsafe header 改写（无 DNR）、XHR 非流式 ≤1MB、token 防伪非 VM 级、SW 重启丢内存态（菜单靠 reload 自愈）、handleUpdate 预取告警不进 UI、早到 gmreq 竞态（Phase 6 握手+backlog 收口）。工具计数 22 不变（summary 增字段）。

## GM API 扩充 Tier A+B（2026-09-07）

（`docs/superpowers/specs/2026-09-07-gm-api-expansion-tier-ab-design.md`）已完成：新增 14 函数型 API + 3 特殊 grant（注册表 `shared/gm-apis.ts` 15→29 函数 grant，`SPECIAL_GRANTS` 1→4）。Tier A（零新权限）：批量值 `GM_getValues/setValues/deleteValues`、`GM_removeValueChangeListener`、`GM_addElement`、`GM_unregisterMenuCommand`、`GM_getResourceURL`、`GM_getTab/saveTab/getTabs`（`background/gm-tab-store.ts`，storage.session per-tab 键 `gm-tab:{scriptId}:{tabId}`）、`GM_closeNotification/updateNotification`、特殊 grant `window.close/focus`。Tier B（新权限）：`GM_download`（`background/gm-download.ts`，chrome.downloads + downloads 权限 + @connect 门控，onload/onerror，onprogress 暂缺）、`GM_cookie.list/set/delete`（`background/gm-cookie.ts`，cookies 权限 + @connect 门控复用，对象型 grant 一次装齐三方法）、特殊 grant `window.onurlchange`（`background/gm-urlchange.ts`，webNavigation onHistoryStateUpdated/onReferenceFragmentUpdated 主帧下行 URL_CHANGE + `'urlchange'` 事件双形态）。manifest 加 downloads/cookies/webNavigation 三权限。预取管线（`background/gm-resources.ts`）扩二进制 base64+mime，`GM_getResourceURL` 拼完整 data: URL。wrapper（`shared/gm-wrapper.ts`）objectApi 分支支持对象型 grant、specialGrantLines 处理特殊 grant + preamble 加 URL_CHANGE 分发。手测 fixtures 扩 storage/dom-resource/tabs + 新增 cookie/download/urlchange/notify-menu 四模块（`gmt-selftest` 同步 29+4 grant，调试台 CALL 表登记 14 新 API）。已知边界：cookie/download/xhr 共用同一 @connect 授权库；download 无 onprogress；window.close/focus 作用整 tab；urlchange 仅主帧不覆盖 iframe。工具计数不变（GM API 非 agent 工具）。

## 设置页枢纽 + 脚本运行时调试台（2026-09-03）

已完成：railnav 减为 3 项（会话/脚本池/设置），调试台入口收进设置页。设置页改为壳（`components/settings/SettingsView.tsx` 内部 `useState` 二级路由，不持久化）→ 三入口：模型设置（`ModelSettings.tsx`，原表单平移）/ 工具调试台（`components/debug/ToolBenchPage.tsx`，按能力域 PAGE/TABS/NET/SCRIPTS 四分分组 + tag chip 四档，修正原 12 个错标 TABS）/ 脚本运行时调试台（`components/scriptdebug/ScriptDebugPage.tsx`）。工具能力域数据抽 `components/debug/tool-tags.ts`（可测），结果面板抽 `components/debug/ResultPanel.tsx`（工具台与 GM 台共用）。脚本运行时调试台三块：白名单视图（`GM_DEBUG_INFO` 回 grant 二分/@connect/始终允许主机/注入态）、GM API 列表（读 `GM_API_REGISTRY` 14 行）、三类直调（bridge 7 + SW 分支 2 完整真实链路，页面内 5 置灰）。直调链路：面板 `GM_DEBUG_CALL`→SW `bridgeTokensForUrl` 查 token→`GM_DEBUG_INVOKE` 下行 content→`gm-bridge-host.debugCall()` 在页面 dispatch `gmreq`（debug 命名空间 reqId 从 10 亿起）→宿主真实 token 校验 + `handleGmCall`→`gmres` 回环（10s 超时），除 wrapper 函数体外全链路真实。直调 api 用点形式短名（SetValue/XmlHttpRequest…）。已知边界：SW 内存态随重启丢失；页面内 5 API 置灰是第一版取舍；受限页因查不到 token 直接报错。

## 技能系统 + 斜杠指令（2026-09-04）

已完成：`Skill` 实体（`local:skills:index`，command 唯一键 kebab-case——`saveSkill` 新增/更新两路径都校验，上限 100 条/正文 64KB/简述 200 字符）仅经 `.md` 导入产生（YAML frontmatter name/description/command + 正文，`shared/skill-md.ts` 手写最小解析：CRLF 归一化 + 启发式拆分——非 frontmatter 开头的段并回前一段并留「已并入」warning，序列化 name/description 换行防御；多文档 `\n---\n\n` 串联；同 command 覆盖更新保留 id/enabled，坏文档跳过+warning 带 filename 归属）；管理页 = 设置页二级页 `SkillsPage`（第四入口，列表搜索/多选导入聚合/导出 Blob 下载/启停/删除/详情只读，无新建无编辑）；启用技能简述经 `LoopDeps.getSkills` 每轮 `buildContext` 第 5 参注入 system prompt（`buildSkillsPrompt`，port 侧 storage 故障降级空数组）；斜杠指令 = 输入框 `/` 浮层（`components/chat/slash.ts` 纯函数 shouldOpenSlash/handleSlashKey/completeSlash + `SlashMenu` 展示组件，Enter/Tab/点击 = 补全 `/cmd ` 非发送，Esc dismissed 后输入变化重开，候选统一截断 8 条）+ loop 侧 `/^\/([a-z0-9-]+)(?:\s+([\s\S]*))?$/` 解析（原文落库，命中 enabled 技能把正文作为隐藏 system 消息仅注入触发轮——`pendingSlash` 消费即清防多轮重复，未命中原样普通文本；resumeAgentLoop 恢复轮不重新注入）；AI 自主调用为遵循式（无新工具位，工具数 25 不变）。已知取舍：多文档拆分对正文含 `---` 水平线的文档会并段+warning；浮层空匹配无占位行、blur 不关浮层、IME 组合期 Enter 未豁免（与既有 send-on-Enter 同病）；徽标正则不 trim 与 loop 侧 trim 后解析有纯外观分叉。

## AI 写脚本流程优化（2026-09-06）

（`docs/superpowers/specs/2026-09-06-ai-script-authoring-optimization-design.md`）已完成，四修卡死 + 分步写入：

1. **卡死四修**：(a) loop 下发 `max_tokens`（`AgentConfig.maxTokens` 默认 8192，0=不下发；`LoopDeps.getMaxTokens` 每轮读 settings）；(b) `llmTimeoutSec` 默认 10→60s，且 `timeoutMs=0`（不限时）仍有 300s 静默硬兜底（`ProviderOptions.hardCapMs`，防网关挂死 → Promise 永不 resolve → runningConvs 永久占位 → 面板永久 running）；(c) 新增 `tool-args-delta` 事件（run-turn 的 `onToolArgsDelta` hook 回调累计字节 → loop 侧 `makeArgsThrottle` 节流（首次立即 + 满 200ms 或涨够 1KB）→ agent-tail `argsProgress` 续播 → chat store 顶层瞬态 → ChatView 消息流末尾进度条），根治「模型在写长参数时 UI 全静默」；(d) AI 工具层写操作返回瘦身（`toWriteResult`：id/name/lines/bytes/matches/enabled/runAt/world/warnings/balance，不回灌 text/code——同一份代码此前在上下文存三份）。
2. **分步写入**：`ScriptPatch` 扩 `append`（追加到末尾，不需行号）与 `replace`（`{old,new,all?}` 字面量精确替换，old 需唯一否则报错列行号）；`handleUpdate` 文本分支四支互斥（text/edit/append/replace 同传两支报错，不再静默取优先）；`create_script` 长度硬闸（`MAX_CREATE_LINES`=200 / `MAX_CREATE_CHARS`=8192，超限报错文案教分步；url 导入/patch.text 不受限）。骨架约定：create 只交元数据头 + 未闭合 IIFE（`(function () {` 结尾），末段 append 带 `})();` 闭合——提前闭合会让追加落到全局作用域。write-script 技能第 3 步重写为分步流程（2026-09-08 再修订为四步：第 1 步先查脚本池查重可复用、简单需求不追问，第 3 步提方案后停下来等用户确认才动笔，第 4 步交付使用说明但不自行注入验证——仅用户明确要求测试才验证）。
3. **配平扫描**：`shared/js-balance.ts` 纯函数词法扫描（跳过字符串/模板串含 `${}` 嵌套/注释/正则字面量，检查 {}()[] 配平与未闭合引号；不做 eval——SW CSP 禁 eval），写入返回带 `balance: 'ok' | 'unclosed'`（只报告不阻断——分步中间态必然 unclosed）。
4. **按需读取**：`list_scripts` 摘要加 `lines`/`bytes`；`get_script` 每行带 `%4d| ` 行号前缀（`annotateLines`，仅 AI 工具层，编排层 handleGet 不动）+ 默认限量 200 行 + notice 翻页提示；新增 `grep_script` 工具（26→27，`agent/tools/script-grep.ts`：正则优先非法降级字面量+warning、id 缺省搜全库、contextLines 去重膨胀、limit 截断；纯 storage 豁免受限页预检，进 ASK_MODE_TOOLS）。
5. **教学式纠正**：finishReason=length + toolCalls 的 tool 消息改为分步指引（截断 → create 骨架 → append 追加 → 末段闭合）；四个脚本工具 schema description 写入分步规则与 balance 判读；SYSTEM_PROMPT 加「写长内容先建骨架再分次追加」通用规则。已知边界：js-balance 的正则/除号区分是启发式（`return /re/` 会误判为除号）；`bytes` 是 UTF-16 code units 非严格字节；部分模型（o1 系）需 `maxTokens` 置 0 或经 extraBody 补 `max_completion_tokens`。

## 系统提示词自定义 + Agent 记忆（2026-09-07）

（`docs/superpowers/specs/2026-09-07-system-prompt-and-agent-memory-design.md`）已完成：

1. **系统提示词覆盖式自定义**：`Settings` 新增第三个顶层段 `prompt`（`{ custom, baseSnapshot? }`，上限 16KB），`resolveSystemPrompt(custom)` 决定用自定义还是内置 `SYSTEM_PROMPT`，经 `LoopDeps.getSystemPrompt` 每轮重读。**覆盖只替换 `SYSTEM_PROMPT` 常量，动态块照旧追加**（页面信息 + 技能清单 + 记忆 + 模式说明）——故记忆的用法指令必须放在记忆块而非 `SYSTEM_PROMPT` 里，否则覆盖提示词的用户会连带丢掉记忆能力说明。设置页第 2 张卡 `SystemPromptPage`（CodeMirror md 编辑器 + 预览切换 + 恢复默认 + 「你的自定义基于旧版内置提示词」提示条，靠保存时留的 `baseSnapshot` 快照比对；dirty 门控防「已保存」假象与零改动固化）。`CodeEditor` 泛化出 `language?: 'javascript' | 'markdown'`（新依赖 `@codemirror/lang-markdown`）。已知取舍：编辑后固化在当时版本，后续内置规则改进不自动进入；误删承重规则（uid/stale、分步写入、不可信输入）会让 agent 明显变笨且不易归因，页面上只做文案提示不做技术阻拦。
2. **Agent 记忆（条目式 + 站点作用域）**：`MemoryEntry`（`id` = nanoid(8) 省注入 token、`content` ≤500 字、`matches` 空数组 = 全局、`source: 'ai' | 'user'`）存单键 `local:memory:index`，上限 100 条；非法 match pattern **整条拒存**（不同于脚本池的「跳过坏规则 + 警告」——记忆只有一个 matches 字段，静默跳过会让 AI 以为写成功了而作用域是错的）。
3. **三层注入**（`agent/memory-prompt.ts` 纯函数）：全局记忆全文 → 当前页 `matchUrl` 命中的记忆全文 → 其余记忆只出**站点清单**（pattern + 条数，最多 30 个）。第三层是为了补「模型在导航**前**看不到目标站记忆」这个洞——记忆过滤依赖 `page.url`，而它每轮循环顶部才重读，导航后的新站记忆本来要等下一轮。预算 6000 字符由全局与站点两层**各分半、未用满的额度让给另一层**（全局被挤掉用户立刻察觉，站点被挤掉 agent 在当前页重复踩坑，都不能牺牲）。空库仍注入冷启动文案，否则模型永远不知道自己有这个能力。
4. **三个工具（27 → 30）**：`memory_list`（`scope` 两趟匹配——先当完整 URL 走 `matchUrl`，未命中再对 pattern 做子串匹配；带 `scope` 时排除全局记忆，因其已常驻注入）、`memory_write`（无 id 新增 / 带 id 改写，`matches` 传了才改，保留 `createdAt` 与 `source`）、`memory_delete`（幂等）。返回值瘦身（正文截 120 字、不回灌全库）。三个都进 `ASK_MODE_TOOLS`——ask 的语义是「不改网页/浏览器状态」，记忆只改扩展自己的本地笔记。新增 `MEMORY` 能力域（调试台第六组）。
5. **两个开关 + 三档守卫**：`AgentConfig.memoryEnabled`（关 = 不注入不下发）与 `memoryWritable`（关 = 只注入 + 只给 `memory_list`）→ `MemoryCap = 'off' | 'read' | 'full'`，`getToolSchemas(mode, cap)` 二维过滤 + `executeTool` 硬闸兜底拦幻觉调用（与既有 ask 守卫同一位置同一形状）。`MemoryState` 必须同时带 `enabled` 与 `writable`：仅有 `writable` 无法区分「总开关关闭」（完全静默）与「只读模式下记忆池为空」（注入只读版冷启动文案），两者 `entries` 都是空数组。
6. **设置页不走 background 路由**：`MemoryPage` 直接读写 `storage/memory.ts`（同 `ModelSettings` 直接读写 `storage/settings.ts`），刻意不照技能池的 `SKILLS_*` 消息链——记忆无 md 解析、无注入引擎、无 tabs 监听，那层间接省掉一个编排层、一组消息类型、一个 zustand store。加 `storage.watch` 让 AI 任务中写入时列表自动刷新。
7. **`buildContext` 签名重构**：6 个位置参数改 `(history, page, opts)`，`page` 仍是必需主参数，其余进具名 `opts`（原先再加两项就是 8 个位置参数）。

**已知限制**：(1) 覆盖提示词后固化在当时版本；(2) 同一轮内导航后的后续工具仍看不到新站记忆——三层注入让模型有能力主动规避（先 `memory_list` 再动手）但不强制，最坏延迟一轮；(3) click 触发的同标签跳转 URL 更新时序无保证（`navigate_page` 内部 `await waitForCsReady` 能保证，页内跳转不能——这是 `getPageInfo` 既有特性，非记忆新引入）；(4) 站点清单按 pattern 字面聚合，`*://bilibili.com/*` 与 `*://*.bilibili.com/*` 显示为两项；(5) `memory_list` 的 `scope` 第二趟是子串匹配，`scope: 'com'` 会命中大量条目；(6) AI 与用户并发写同一条时后写覆盖（wxt storage 无事务，`storage.watch` 会让面板刷新到最新值）。

## 敏感站排除名单（2026-09-08）

（`docs/superpowers/specs/2026-09-08-hook-exclusion-list-design.md`）已完成：MAIN world 观测 hook（`entrypoints/hook.content.ts`）改 SW 动态注册（`registration: 'runtime'`，manifest 不再静态声明），`background/hook-registration.ts` 经 scripting.registerContentScripts diff 同步（注册详情 js 为裸路径 string[] 形状——与 userScripts 的 {file}/{code} 对象形状不同；persistAcrossSessions 显式 true 作防御，官方默认即 true），excludeMatches 承载名单；`background/hook-exclusions.ts` 独立存储（`local:hook:exclusions`，默认招聘四站 zhipin/lagou/zhaopin/51job，未存过时兜底），`HOOK_EXCLUSIONS_GET/SAVE` 消息 + 设置页第五卡「敏感站点排除」（`components/settings/HookExclusionsPage.tsx`，增删/恢复默认，保存即生效，刷新页面后生效）。动机：Boss直聘等强风控站指纹检测 MAIN world hook 包装的 console/fetch/XHR 拒开；排除站上 console 观测失效、网络观测无 body，AI 工具（ISOLATED）照常。已知边界：第三方风控 iframe（跨域文档）不覆盖；用户自己的脚本池脚本不归名单管；dev 模式改 hook 需重载扩展（SW 冷启动 sync 兜底）。

## 品牌资产（2026-09-08，feat/new-name）

标识概念 = **编织的雀**：产品名「织雀」指织巢鸟（用草茎编织巢穴），对应「AI 替你编织脚本」。两条等宽斜杠交叉成展翼，交叉处为 `mask` 真挖空缺口（非描边描白，任意底色可用），读作经纬互穿的「织」；中央胶囊既是雀的躯干，也是鼠标滚轮（浏览器操控的双重读法）。配色只用既有 token —— `--signal #53589a` 双翼 + `--ink #1c1c22` 躯干，呼应双声道设定，不引入新色值。

- 几何定稿（勿随意改）：viewBox `0 0 32 32`，双臂 `stroke-width 4.6`，顶点 y=9.22、交叉点 y=19.72、尾端越中 3.2；躯干 `4.4×10.52` rx 2.2；缺口 = mask 描边 6.7（较双臂宽 2.1，即两侧各 1.05）。外接框 25.18×16.88（≈1.5:1），在 32 格内严格居中。
- **尾长是关键约束**：双臂与双尾等长时整体读作「X」，尾长收到 3.2 才让双臂占主导、雀形成立。加长尾巴会退回 X。
- 四份 SVG 在 `public/brand/`：`logo-mark.svg`（主标识）/ `logo-mono.svg`（单色，走 `currentColor`，深底与内联 UI 用）/ `icon-tile.svg`（signal 底 + 白字形，PNG 母版）/ `logo-lockup.svg`（横向组合 + 中文字标 + mono 副标）。
- 多份 SVG 同页内联时 `mask` id 会撞车，故各文件用 `vv-weave-{mark,mono,tile,lockup}` 独立命名，新增变体沿用该前缀。
- 扩展图标 `public/icon/{16,32,48,96,128}.png` 由 `icon-tile.svg` 栅格化而来（MV3 不吃 SVG）。WXT 自动发现该路径并写入 manifest 的 `icons`，**不要**在 `wxt.config.ts` 里显式声明。改动母版后需重新栅格化五档。
- 16px 下编织缺口按亚像素退化消失、剪影完整，是设计时留的优雅降级，非缺陷。
- `logo-lockup.svg` 字标用 `<text>` + 系统字体栈（零网络依赖），渲染依赖查看端字体；印刷场景需转曲。

正式定名「织雀AI脚本 Vevscript-ai」全量改名（9fc717e），logo 设计 + 扩展图标五档（156d03f）。

## 宣传页 `landing/`（2026-09-09）

已完成：独立 Vite + React 19 + TS 站点，自带 `package.json` / `tsconfig.json` / `node_modules`，与 WXT 构建零耦合。开源地址 <https://github.com/yutian0525/VevScript-AI>（`src/router.ts` 导出 `REPO` 常量，全站引用它，不散落硬编码 URL）。

- **构建隔离**：根 `tsconfig.json` 必须 `"exclude": ["./node_modules", ".output", "landing"]`——`.wxt/tsconfig.json` 的 include 是 `../**/*`，会把 landing 卷进扩展的 `npm run compile`，而 landing 依赖 `vite/client` 类型（扩展侧没有）。exclude 在继承时整体覆盖而非合并，故基础配置那两条要一并列出。`base: './'` 让产物可丢到任意子路径（GitHub Pages）。
- **字体换源（重要）**：原指定的自建 CDN `mypan.yutkit.com/raw/fonts/MiSans-*.woff2` 文件在、返回 200，但**不回 `Access-Control-Allow-Origin`，且 OPTIONS 405**。webfont 是 CORS 强制资源，浏览器一律拒载，换任何部署域名都一样（那边的简历站看着正常是因为本机装了 MiSans，走的系统字体）。改用 `misans@4.1.0`（小米官方字体的 npm 分发）经 jsDelivr，`ACAO: *`；且已按 unicode-range 切成每档 100 个子集片，实测本页只下 32 片约 130KB，而原方案单档全字库 4.7MB（两档 9.6MB）。**该包声明的是 MiSans 光学字重而非 CSS 百分档：Regular = 330、Semibold = 520**，故全站字重走 `--w-body` / `--w-bold` 两个 token，直接写 400/600 会命中不到 face 并静默掉回系统栈。字体由 `index.html` 的两条 `<link>` 拉，styles.css 内不再声明 `@font-face`。
- **设计语言**：几何取自标识——logo 双臂斜率算出约 43.7°，全页取 44deg 用作编织底纹的经纬双向线（`--weave`，只在 hero / CTA 出现）。曾做过一道"44° 斜切"的 hero 底边界，后删除：全宽楔形高 104px 实际只有 4°，与标称角度不符，属自欺的装饰。色板全部继承产品既有 token（`--signal #53589a` 单信号色），不引新色值。双声道排版延续到宣传页：MiSans 作人语言，系统 mono 栈作机器语言（工具名 / uid / JSON / 令牌 / 数字量）。
- **定位是「浏览器里的 agent harness」**（二次返工，最终口径）：本项目的身份不是"能操控浏览器的助手"，而是一个**完整的 agent harness**——多轮 loop、上下文组装与压缩、token 计量、熔断阀、权限模式、流式与续播、会话持久化、技能加载，机件齐全——只是运行时目标是浏览器而非终端里的代码库。`agent/loop-guards.ts` 第 6 行的设计注释是直接证据：「正经 agent harness（如 pi）都不靠数步数/数 token 兜底」，代码本就以 harness 为参照系设计。区别于其它 harness 的两点：(1) 工具作用在你真在用的浏览器上（真登录态/会话/标签页，非沙箱自动化浏览器）；(2) **能产出脱离 harness 存活的产物**——用户脚本在 loop 停止后照旧运行，一般 harness 的活干完就没了。「两条路」（当场做完 / 写成脚本常驻）是这个身份的两种输出形态，不是两个并列产品。
  - **但 harness 不能当钩子用**（三次返工，最终形态）：曾把 harness 顶成 slogan 与首屏 H1，结果读者在知道「它替我干什么」之前先撞上「多轮循环 / 上下文压缩 / token 计量 / 熔断阀」一整墙机件——`agent harness` 是圈内行话，对外零信息量。现在的顺序是**先说人话，harness 作可信度层垫在后面**：slogan =「在侧边栏说一句话，AI 就在当前网页上替你做完。常做的事，写成用户脚本以后自动跑。」，harness 降为正文一节，标题「它不是套壳调模型」（不认识 harness 的读者也知道这节为什么值得看），节内才引入该词。
  - slogan 六处联动：`wxt.config.ts` 的 manifest description、`package.json` 的 description、README 引言 blockquote、`landing/index.html` 的 title/description/og、宣传页 H1（`说一句话，` + em `AI 替你动手`）。改口径时一起动。
  - **章节顺序（README 与宣传页必须一致）**：引言/首屏（人话 + 两个对话例子）→ 两条路 → 写脚本细节 → **它不是套壳调模型**（机件表 + 设计取向）→ 工具集 → 脚本引擎/观测/调试 → 上手。机件表垫在两条路之后，不许再往前挪。
  - README「它不是套壳调模型」一节有 12 行机件表 + 4 条设计取向，宣传页有对应的 `#harness` 节（复用 `.tools/.toolrow` 规格表骨架 + `.stances` 取向格）。**新增 harness 机件时这两处要同步**。
  - **首屏 H1 的 em 那行有字数硬约束**：`white-space: nowrap`（编织下划线不能断行），1440px 下左栏约 470px、74px 字号最多容 6 个汉字。写到 9 个字（「AI 在这一页上动手」= 594px）会溢出 125px 并压进右侧装置。加字前先量。
- **两条能力都要写到**（初版返工点）：产品是「操控浏览器」+「写用户脚本」两条并列输出（`SYSTEM_PROMPT` 第一句就是「一个能操控浏览器、并替用户编写和安装用户脚本的 AI 助手」）。初版宣传页把操控降格成「写脚本前的读页面手段」，装置三个场景全以写出脚本收尾，等于只演了一半，已返工：新增 `#paths` 节（两条路对照 + ask/agent 两种模式）、装置加 `act-now` 场景（`take_snapshot` + 三次 `click` 点亮「稍后读」，全程不调 `create_script`，收尾台词点出「一次性的活儿不值当留常驻脚本」这个取舍）。（旧 slogan「说一句需求，AI 替你写并装好用户脚本」只覆盖一半能力，已在二次返工中替换。）
- **签名装置**（`src/components/Demo.tsx` + `DemoPanel` + `DemoPage` + `demo/`）：左仿侧边栏 + 右仿网页，四个场景（加进稍后读=直接操控 / 去掉推广卡片 / 缩略图悬停放大 / 注入阅读时长徽标）。`act-now` 排在首位故为滚入自动播的那条——首屏既已立在 harness / 当场动手上，自动播的场景必须与之呼应；用户最初要的「卡片消失」效果保留为第二个 tag，一点即到。演出脚本是纯数据（`demo/script.ts` 的 beat 数组，按 `at` 毫秒排布），`demo/useRunner.ts` 是时间线执行器——所有 timer 收进 ref 数组统一 clear，切场景/卸载都能干净取消（已验证半途连点三次无残留写入）。工具名、参数形状、结果摘要全取产品真实存在的那套（`patch.append`、`balance: unclosed`），不编造 API。滚入视口自动跑第一条（IntersectionObserver，阈值 0.2——窄屏装置竖排后很高，0.45 要滚很久才满足）。`prefers-reduced-motion` 下时间线压缩至 0.45 倍且文字整段落地不逐字。
- **踩过的坑（勿重犯）**：(1) 单列栅格必须写 `minmax(0, 1fr)`，裸 `1fr` = `minmax(auto, 1fr)` 不肯缩到内容最小宽度以下，里头一个不可断行的 `<code>` 就把整页顶出横向滚动条（375px 下 scrollWidth 一度 492）；(2) 长 mono URL 的表格要套 `overflow-x: auto` 容器，表的固有最小宽度会顶宽栅格轨道，`minmax(0,…)` 管不到表自身；(3) `text-overflow: ellipsis` 在 flex 容器上不生效，卡片标题会被硬切没有省略号——要块级；(4) **JSX 把「行尾 + 缩进」折成一个空格，中文句内换行会真的多出一个空格**（`、 装进`），故每个中文句子留在同一物理行；(5) 卡片退场动画用 margin 而非 gap 排列，gap 无法参与过渡，抽出瞬间会留空隙；(6) 悬停放大要 `transform-origin: right`（向左长），向右长会盖住自己的标题看着像布局坏了，且需给仿真网页左右 24px 内边距，18px 时放大的缩略图会探出 `overflow: hidden` 被切一刀；(7) 仿真网页里的"标题"不能用 `h3/h4`——会进宿主文档大纲，造成 H1→H3→H4→H2 跳级且读屏按标题跳转会掉进示意内容，改用 div + 类名承载样式。
- **文档页刻意留空**：不假装有内容，给出章节骨架（10 章，标"待写"）+ 现成去处（仓库 README / `docs/gm-api.md` / `docs/使用指南.md`）。
- **上手不能只给构建路径**（2026-09-14 返工）：原「快速上手」四步的第一步是「克隆并构建」，把「用扩展」和「改扩展」混成了一件事——读者会以为必须先装 Node 才能用。现拆成并列两条：第 1 步下载 Release 打包版（免构建，零依赖），第 2 步克隆并构建（标「可选」，供要改代码的人），后续步骤说「指向第 1 或第 2 步得到的目录」。连带两处口径修正：环境要求里的 Node.js 20+ 限定为「只有自建才需要」（原先无条件列出，与下载路径矛盾）；代码块前加一行注释点明它属于第 2 步，免得看着像必经流程。Release 产物名 `vevscript-ai-v<版本>-chrome-mv3.zip` 取自 `.github/workflows/release.yml` 的重命名步骤，不是编的。宣传页首页那版同构列表（`#start` 的「四步能跑」）一并对齐成五步，README「快速开始」也同步拆成两条路——三处描述同一件事，改一处必须跟另两处。
- **已知边界**：`#flow` / `#tools` / `#start` 这些区块 id 与 hash 路由同名空间，`#tools` 会被解析成路由并落回首页（当前无任何链接指向它们，仅作滚动锚点）；宣传页无测试（纯静态展示页，按项目约定不为它铺测试基建）；`logo-lockup.svg` 的字标走系统字体栈，渲染依赖查看端字体。

## 输入框草稿跨面板重建保留（2026-09-14）

**症状**：在输入框敲了字、切到别的标签再切回，内容清空。**根因**：侧边栏文档在切标签时被销毁重建——这本来就是既有设计的既定前提（`agent:attach` 回放运行态、会话指针放 `session:` 区都是为它而生），消息靠 storage 重载所以看着还在，而输入框草稿只活在 ChatView 的 `useState` 里，随文档一起没了。

修法：新建 `storage/composer.ts`，草稿落 `session:composer:draft`（与 `session:currentConvId` 同生命周期：同一浏览器会话内切标签/重开面板都在，浏览器关闭随 session 区清空；空串删键而非写字面空串）。ChatView 挂载后恢复、每次变更即回写——**不做防抖**，切标签随时可能销毁本文档，晚一步就丢。两处时序约定：恢复完成才置 `draftReady` 并开始回写（否则挂载时的空值会把已存草稿抹掉）；恢复前用户已敲字则以用户为准（`cur || d`）。

已知边界：(1) 附件暂存不入草稿——图片走 dataURL，session 区配额 10MB，且非文本内容序列化收益不抵风险，切标签仍会丢附件；(2) 草稿是全局单份、不按会话分桶，与既有行为一致（切会话本就不清输入框）；(3) 未覆盖其它输入框（脚本页 URL 框、各搜索框），那些是一次性输入，丢与不丢都无妨。

测试：`tests/ui/composer-draft.test.tsx`（敲字 → `cleanup()` 模拟文档销毁 → 重挂载仍在；清空即删键；空串删键语义）。已验无修复时该用例红、修复后绿。

## CDP 深度观测（2026-09-21）

设计见 `docs/superpowers/specs/2026-09-21-cdp-deep-observe-design.md`。已完成：新增 CDP（`chrome.debugger`）观测通道，网络与控制台观测从「页面内包装」搬到「浏览器级附着」。`background/cdp/` 四模块——`session.ts` 附着/脱离 + per-tab 会话注册表（含 SW 冷启动 `reconcile()` 对账自愈，绝不信任内存标志位，一律以 `getTargets()` 为准）、`domains.ts` 七类 CDP 事件 → observe-store 摄入（含子 target 的 `sessionId` 路由）、`console-text.ts` 的 `RemoteObject[]` 文本序列化（零 `getProperties` 往返，对象只到 description/preview 浅层）、`bodies.ts` 响应体抓取（XHR/Fetch/Document 白名单 + 非文本 mimeType 跳过 + 64KB 截断）。`observe-store` 接纳第二数据源：id 加 `wr:` / `cdp:` 前缀分号，附着期间该 tab 的 webRequest 三入口静默（两套 `requestId` 命名空间无法对齐，硬合并只产生幽灵重复条目）。输入坞新增圆形开关（三态：关 / 开 / 异常，异常态点击即重试），模型侧新增 `toggle_deep_observe({ enabled })` 并进 ask 白名单（附着不改页面内容，符合 ask 语义；原设计为 `enable_deep_observe` / `disable_deep_observe` 两工具，终审后合并为单工具带布尔，形状对齐既有 `toggle_script`，理由见 spec §4.1），`permissions` 增 `debugger`。CDP 关闭时观测工具不报错、不空转：`list_network_requests` 照常回 webRequest 元数据，`list_console_messages` 回空数组 + `deepObserve: false` + hint 说明如何开启。

**hook 退役**：MAIN world hook 整条链路全部删除——`entrypoints/hook.content.ts` 的 fetch/XHR/console 包装、`background/hook-registration.ts` 的 SW 动态注册、`background/hook-exclusions.ts` 的敏感站排除名单、`shared/hook-bridge.ts` 的 window.postMessage 桥协议（`ConsoleEntry` 早已迁出，存活于 `shared/observe.ts`）、`stores/hook-exclusions.ts` 与设置页「敏感站点排除」入口/路由/`SettingsSub` 成员、`content.ts` 的 postMessage 中继块与 `RELAY_READY` 握手、`HOOK_CONSOLE` / `HOOK_NETWORK` 两个 router handler、`observe-store` 的 `ingestHookNet` / `MATCH_WINDOW_MS` / `TabBuf.hookKeys`，`observe/serialize.ts` 随之失去唯一消费方。两条退役理由：① **包装即指纹**——改写 `console.*` / `fetch` / `XHR` 会在页面里留下 `toString()` 一查即明的替换函数，Boss直聘等强风控站据此判定环境异常直接拒服务，此前只能靠排除名单逐个站点绕过；② **观测天然残缺**——响应体只覆盖 fetch/XHR，无浏览器自动请求头、无 WebSocket 帧、无浏览器级错误（CSP 违规、资源加载失败、弃用警告），console 无堆栈。CDP 从根上取消了注入，保真度又是另一档。**保留**：`scripting` 权限（脚本池仍用）、`webRequest` 权限与元数据主干（CDP 关闭时的兜底观测）、`entrypoints/content.ts` 本身（页面操作能力，uid 树与 DOM 动作照旧）。

**两条硬代价**（写进工具描述，让模型知道自己在做什么）：① 附着期间页面顶部常驻 Chrome 调试信息条，用户可见、可撤销（点「取消」即 `canceled_by_user`）；② 与页面 DevTools **双向互斥**——先开 DevTools 再点开关则 attach 失败落 `error` 态并给出明确文案，附着后用户开 DevTools 则被踢下线转 `error`（且不自动重附着，避免与 DevTools 抢占成死循环）。

**四条边界**：

1. **CDP 不是零可检测**。页面仍可用 `console.log` getter 陷阱、`debugger` 语句计时探测调试器附着，信息条本身也是明示的。去掉的是**最廉价的那类包装指纹**（`window.fetch.toString()` 一眼假），不是隐身。
2. **Shared Worker / Service Worker 够不到**。`chrome.debugger` 的附着单位是标签页，`Target.setAutoAttach` 只能收该页的子 target（跨域 iframe、Dedicated Worker）；Shared Worker 与 Service Worker 是独立 target，不在页的子树里。
3. **`sessionId` 定位子会话需 Chrome 125+**（`DebuggerSession` 自 Chrome 125 引入）。更低版本只覆盖主帧，跨域 iframe 内的请求观测不到。
4. **WebSocket 帧 payload 不过脱敏**。`networkCaptureHeaders` 只作用于 headers，帧体（可能夹带 token）原样落库——与响应体同一立场，但 WS 场景更容易夹带凭据，要收紧需另设规则。

另：新增 `debugger` 权限会让已安装的扩展被 Chrome 禁用，直到用户重新同意——老用户升级有一次摩擦。敏感站排除名单随之删除，CDP 关闭时该类站点无 console 观测（webRequest 元数据仍在），但不再需要维护名单。

## AI 会话调试页（2026-09-22）

设计见 `docs/superpowers/specs/2026-09-21-conv-debug-design.md`。已完成：agent loop 的「过程」首次落盘可查。动机：消息流只持久化了「结果」（assistant 正文、reasoning、toolCalls、tool 输出），而排障时真正要看的「过程」此前全无记录——单轮耗时、TTFT、usage 明细、每个工具的执行耗时与成败、压缩触发与效果、熔断原因、上下文组装体积。这些量要么是瞬态广播（`compact-start/done`），要么纯内存（`loop-guards` 的 `GuardState`、`agent-tail` 的流式尾巴、`observe-store` 的环形缓冲），SW 一重启即失。

**数据模型**：每会话一个独立 key `local:conv:{id}:trace`（`storage/traces.ts`），形状 `{ seq, turns }`，环形保留最近 200 轮（`MAX_TURNS`，与消息的 `MAX_MESSAGES=200` 对齐）；`seq` 是会话内累计轮数、**不随环形裁剪回退**，`seq > turns.length` 即「已被裁过」的判据。随会话删除（`deleteConversation` 连带 `clearTraces`）。**每会话独立 key 而非与消息共用是刻意的**：trace 每轮写一次，共用 key 会把写放大到整个消息数组。

**关键取舍——不存 prompt 全文**：manifest 无 `unlimitedStorage`，quota 即默认 10MB，而 prompt 全文与已落盘的消息流高度重复；trace 只存组装摘要（消息条数、字符数、是否带 summary、技能数、系统提示词长度、页面 URL）。调试页**直读 `storage/*`** 不走消息协议——扩展页面读 `chrome.storage` 无障碍（先例 `ChatView`/`MemoryPage`），那层间接省掉一个编排层、一组消息类型。

**`drive()` 的接线**（`agent/loop.ts` + `agent/trace.ts` 采集器）：每轮迭代包一层 `try/finally`，`await tr.commit()` 一处收口——轮体内有 1 处轮级 `continue`（截断重试；另有 2 处内层工具循环的 `continue`，只跳过当前工具、不离开 try 块）+ 8 处 `return`，`finally` 在 `continue` 前同样执行。9 处出口各自显式赋值 `outcome`，轮末自然落下是第 10 个赋值点（承载最常见的 `'continue'`）。`rec.outcome` 默认值 `'error'` 是刻意的绊线：漏赋值暴露成错误而非伪装成 `done`。`outcome` 六值：`'continue' | 'done' | 'paused' | 'aborted' | 'error' | 'truncated-retry'`。

**页面**：`entrypoints/conv-debug/` 单页 master-detail（左会话列表 + 右详情，`components/convdebug/`），`?convId=` 深链（`history.replaceState`），`storage.watch` 自动跟随——每轮 commit 后页面自动刷新，带「自动跟随」开关。详情区双视图：「轮次时间线」（`TurnTimeline`，每轮一个折叠块，展开见上下文摘要/LLM/TTFT/工具明细/压缩/熔断）与「原始消息流」（`RawMessages`，逐条渲染，user/assistant 走 `Markdown`）。

**入口**：设置页「开发者工具」组新增「AI 会话调试」。`Entry` 加可选 `tabUrl` 字段——有 tabUrl = 不开二级页、直接开独立标签页；`TAB_ENTRIES` 由 `GROUPS` 派生（防两处漂移）。`stores/extension-tabs.ts` 的 `openExtensionTab`：已开同路径标签页则 `tabs.update` 导航 + 聚焦（复用 `confirm-queue` 的 hub 模式），未开则 `tabs.create`。

**降级**：trace 环形裁剪后时间线只覆盖保留下来的轮次，头部提示「trace 仅保留最近 200 轮，更早的轮次请查看原始消息流」；trace 写失败静默吞掉（含读侧 `readTraces` 的 `.catch`）——调试设施不该有能力搞挂主流程。

**踩过的坑（勿重犯）**：(1) **wxt storage 的 key 映射**：`local:x` 在 driver 里存成裸 `x`（按第一个冒号切分 area），测试里要直接写 storage 时得用裸 key；(2) **切会话的状态串扰**：两个视图机理不同、结论相同——`RawMessages` 的行折叠是 `<details>`，`open` 属非受控 DOM 态且行 key 撞号（两会话都以 `0-system`/`1-user` 开头），React 原地 reconcile 复用同一批 DOM 节点、不会重置 `open`；`TurnTimeline` 的折叠是 React `useState`（以裸轮次号为键，两会话都从 1 起号），不加 key 时复用的是组件实例、state 原样带过去。所以两者都靠调用处 `key={convId}` 重挂载隔离，折叠态才不跨会话串扰（两条护栏用例已覆盖）；(3) **判「会话是否已落库」只能用 `updatedAt === 0`，不能用 `createdAt`**：侧边栏「新会话」是客户端草稿 id（`stores/conversations.ts` 的 `newConversation` 不落库），首条消息经 `appendMessage` → `getConversation`(返回 EPOCH 空壳) → `saveConversation` 建档，而 `saveConversation` 只刷新 `updatedAt`——哨兵值 `createdAt: 0` 被**永久**写进库，于是每个真实会话都长着 `createdAt === 0`。调试页最初拿它判「会话不存在」，结果打开任何会话都显示「会话不存在或已删除」（`tests/storage/conversations.test.ts` 有两条用例钉住这条不变量）。`stores/conversations.ts` 的 `rename` 早就用 `conv.updatedAt === 0` 识别草稿，是同一条约定。

测试：`tests/agent/trace.test.ts`、`tests/agent/loop-trace.test.ts`（含 9 处出口断言与 TTFT）、`tests/convdebug/` 四件（App 壳/时间线/原始消息流/投影纯函数）、`tests/storage/conversations.test.ts`（草稿时间戳不变量）、`tests/stores/extension-tabs.test.ts`、`tests/settings/tab-entries.test.ts`。

## 工具确认卡与三级确认策略（2026-09-22）

spec: `docs/superpowers/specs/2026-09-22-tool-confirm-and-permission-levels-design.md`

- agent 工具调用新增会话流内确认卡（单卡双态：待确认展开面板 → 决策后折叠一行工具卡）与三级确认策略（全部询问 / 仅敏感 / 自动放行，默认仅敏感）。档位存 `settings.agent.confirmLevel`，全局生效，选择器浮窗切换。
- 判定核心 `agent/permission.ts`：敏感集 12（任意 JS/跨域请求/导航开闭页/脚本池技能池写入）、微操集 9（click/fill 等页面细节 + 记忆写）、只读 = ask 白名单减记忆写。sensitive 档按白名单放行微操，未分类工具默认要问（fail-safe）。
- 协议增量：下行 `tool-confirm` 事件 + 上行 `agent:confirm` 消息；卡片状态转移复用既有 `tool-start`/`tool-end`（allow 后补发 tool-start 翻卡，deny/timeout 直接 tool-end 终结）。
- 闸门在 loop（spec §6）：`confirmToolCall` 缺省 = 不设闸；会话放行集（allow-session）随 loop 生灭不落库；拒绝计入熔断阀失败统计。
- 后台确认槽（spec §7）：120s 超时自动拒绝、停止键 abort 收口为拒绝、`agent:confirm` 按 convId+callId 幂等、attach 回放待确认状态（until 为绝对时间戳，倒计时跨重挂载连续）。
- ModeSelect 触发钮改「模式图标 + 权限状态」chip（去右箭头、加底色，auto 档 warn 前景），浮窗两组（行为模式 + 确认策略，ask 下确认组禁用），键盘导航扁平跨五项。
- 确认决策进 trace（`TurnToolRecord.confirm/confirmMs`），convdebug 时间线工具行带决策标记。

## 上下文 token 优化：前缀稳定化与 schema 瘦身（2026-09-22）

spec: `docs/superpowers/specs/2026-09-22-context-token-optimization-design.md`，计划： `docs/superpowers/plans/2026-09-22-context-token-optimization.md`。三段改动：① `buildContext` 布局重排让 tools+system+history 成为逐字节稳定的缓存前缀；② ask 工具集 18→10；③ 37 个工具 schema 按中等档规则瘦身 + 技能清单封顶。

**实测数字**（vitest 探针，新对话固定开销 = system + 易变块 + 工具 schema，工具为逐工具 `JSON.stringify` 求和口径）：

| 模式 | system | 易变块 | 工具 schema | 合计 | 改前 | 降幅 |
|---|---|---|---|---|---|---|
| agent（37 工具） | 1,889 | 69 | 17,384 | **19,342** | 21,708 | **−10.9%** |
| ask（10 工具） | 1,630 | 69 | 4,703 | **6,402** | 11,861 | **−46.0%** |

（改前的 21,708/11,861 里工具段按整组数组序列化口径计——19,783 = 逐工具求和 19,745 + 38 字符数组包装。两种口径下 agent 降幅都是 ~11%。）

**诚实口径：agent 模式实际 −10.9%，不是最初承诺的 −20%。** 工具 schema 的 57.2%（11,294 字符）是 `obj()` 包装、anyOf、enum 这类结构管道，散文删光也降不到它以下（spec §0.1）——真正能压低地板的杠杆是减少工具数，不是缩短描述；而中等档为守住「参数级 description 是模型填参的唯一依据」，只删与工具级重复的部分，实测 −13% 而非预估 −23%（spec §5.4 勘误：预估公式与保留清单互相矛盾，以保留清单为准）。这条修正改变了承诺的收益量级，spec 已明文记录。ask 的 −46% 不受影响——它靠砍工具数。

**布局重排**：`buildContext` 输出形状改为 `[system, ...history, volatile?]`。页面 URL/标题与记忆条目从 system 挪到末条 `user` 易变块，首行显式声明 `【环境】以下为当前页面与记忆的即时状态（由系统注入，非用户发言）：`——防模型把它当成用户最新指令；两段内容都空则整条不追加，不产生空壳消息。`agent/memory-prompt.ts` 拆 `buildMemoryPrompt` → `{ stable, volatile }`（说明与用法留 system，条目与站点清单进易变块；装箱/分组逻辑一行未动）。不变量钉在 `tests/agent/context-prefix-stability.test.ts`：连续两轮、改 URL/标题、改记忆条目，去掉末条易变块后逐字节相同；技能清单变了前缀跟着变（技能块留在前缀里是刻意的，靠封顶控大小）。导航、写记忆、标题抖动从此不再打断前缀缓存。

**61 条边界（诚实记录）**：历史正文的保护在 history ≤ `keepRecent + 1`（默认 60+1 = 61 条）内成立——`truncateMessages` 在此区间原样返回，前缀单调增长。超过 61 条后每轮从尾部重切窗口，历史正文逐轮失效，缓存收益退回 tools+system（实测 ≈19.3K 字符）——仍远好于改动前的全前缀失效，但从「整段历史」缩回「tools+system」。这是决策 4（不做分块滑窗）的既知代价（spec §9.2），超长会话由既有 80% 自动压缩接住。

**一处残留的前缀抖动（接受）**：记忆 stable 段的冷启动句以 `entries.length === 0` 为键（`agent/memory-prompt.ts`）——空库注入「你具备跨会话的长期记忆，当前为空」，非空换另一句。首次向空库写入（或删光最后一条）会让 `stable` 变一次、当轮前缀失效一次。这是每库一次性的状态转移，不是逐轮抖动；要修掉它得把该句挪进易变块，等于每轮全价多付一句文案去换一辈子一次的失效，不划算，接受。

**ask 边界收窄（修订 2026-09-07 spec §3.4）**：`ASK_MODE_TOOLS` 18 → 10，收走深度观测、`get_network_request`、`wait_for`、脚本池读三件、记忆写两件，新口径「看页面 + 答问 + 加载技能」= **不产生任何持久化副作用**。原 §3.4 决定「记忆只改扩展自己的本地笔记，三工具全留」——本次收走 `memory_write`/`memory_delete` 换边界整齐，旧口径解释不了的灰色地带（深度观测附着算不算改状态）一并消失。CLAUDE.md 的 ask 行已同步。

**`agent/permission.ts` 的 `READONLY_TOOLS` 解耦（惊险一处）**：确认策略的只读集原本从 `ASK_MODE_TOOLS` 派生（ask 白名单减记忆写）——本次把 ask 白名单砍到 10 个，若按旧规则无意识联动重派生，`wait_for`、深度观测、`get_network_request`、脚本池读三件这六个真纯读工具会掉出只读集，在敏感档突然开始要确认；且漂移方向是「变得更烦」而非「变得更危险」，review 时极易被当成预期行为放过。现改为独立 16 名集合，与旧派生逐元素等价（注释在 `agent/permission.ts:20-23`）。**后续建议**：下次动 `agent/permission.ts` 时把工具分类下沉进 registry 的 per-tool 元数据——手工平行分类检测不了危险方向的漂移（工具加了副作用却还挂在只读集里，fail-safe 拦不住静默放行）。

**预算闸门三改（15,800 → 17,400 → 17,700）**：初值 15,800 来自 §5.2 的 `地板 + 散文 × 0.45` 公式，而该公式与计划自己的保留清单（参数级 description 只删与工具级重复的部分）矛盾——按保留清单执行后实测落点 17,177，闸门随实测地板改为 17,400；`list_skills` 加 `query` 参数并回补三条被误删的工具选择线索后升至 17,384，闸门再定 17,700（余量 316）。原则：闸门是**回归绊线**，设在实测地板之上 ~1%，不是目标；它只负责让「描述又写长了」在 CI 报红。

**`list_skills` 加 `query` 模糊搜索**：技能清单封顶 20 个后，未列出的技能必须能被找回，否则封顶就是能力阉割。`shared/skill-search.ts` 五档打分（command 精确 100 > command 子串 80 > name 子串 60 > 简述子串 40 > 字符子序列 20），同分按 command 字典序兜底（确定性）。命中 0 个返回诊断而非裸空数组（模型读到空数组会以为技能库是空的，而查重恰恰是写技能前的第一步），且基数口径是「检索范围内共 N 个」而非「技能库共 N 个」——`enabled` 过滤发生在检索之前，这条 hint 直接喂给写路径的查重判断，而写入链路没有第二道重复检测，说错了模型无从核对。

**观测**：`TurnContextSummary` 加 `volatileChars`（可选——本字段之前落盘的 trace 没有它，conv-debug 对旧行显示 `—` 而非 `0`）。布局改动后「system 变小了但总量没变」是常见误判，单独计一列看清构成；这只是字符计量，不是缓存命中计量（后者本期不做，spec 决策 12）。

**待做（欠账）**：**实机验证未完成**。布局改动是模型可见的行为变化（页面信息换了位置、ask 文案改写），实施计划标注「必须」：加载扩展 → 跑一次含导航的 agent 会话 + 一次 ask 会话 → 在 AI 会话调试页确认易变块字符数正常、system 里不再有 URL、模型仍知道当前页面（问它「现在这页是什么」）、ask 只读边界与记忆只读文案正确。本文所有实测数字来自 vitest 探针；真实链路（loop 组装、用户自定义提示词覆盖后的表现）尚未过机。

**实机验证首轮收获（2026-09-22）**：验证刚开始就抓到两个与本分支无关、但被验证场景第一次踩中的 loop 旧账——都是 storage 里的历史序列违反「tool_calls 响应必须连续」的 wire 协议约束，下一轮请求 400 "insufficient tool messages following tool_calls message"：① 截图的独立 user 图片消息紧跟其 tool 响应落库，模型同轮并行调用 `take_screenshot` 与其他工具时插进响应序列（`c18c4a6`：图片延后到本轮全部响应之后）；② 工具循环中段按停止时，未执行调用在 storage 里悬空，停止后继续对话复现同一 400（`b85ea9e`：中断收尾补合成响应）。`loop.ts` 自分叉点起未动过，两个都不是布局改动引入。验证继续。

## 存储管理页（2026-09-23）

spec: `docs/superpowers/specs/2026-09-22-storage-manager-design.md`，计划：`docs/superpowers/plans/2026-09-22-storage-manager.md`。设置页「数据」组新增二级页 `StoragePage`（`components/settings/StoragePage.tsx`，入口由 `SettingsHome` 的 GROUPS 派生），三区块 = 用量总览 / 清理 / 备份。后台 `background/storage-manager.ts` 注册四条消息（`STORAGE_USAGE_GET` / `STORAGE_CLEAN` / `STORAGE_EXPORT` / `STORAGE_IMPORT`），SW 挂线于 `entrypoints/background.ts` 的 init 链尾（`initSkillsModule` 之后）。

- **用量总览**：`getStorageUsage` 走裸 `browser.storage.local.get(null)` 全量 dump，`classifyKey` 按物理键前缀分 **11 域**（conv / trace / scripts / skills / memory / settings / gm-resources / gm-auth / gm-values / update-state / other）；字节数用 `new TextEncoder().encode(JSON.stringify(v))` **精确计量**（不是 UTF-16 code units）；条目数区分数组型单键（scripts / skills / memory 的 `:index` 记数组长度）与 `conv-index`（索引不计条目）。UI 占比条以**最大域字节数为基准**（groups 已按字节降序，首个即最大），宽度 `Math.max(2, …)` 保底可见（小域不缩成不可见的一线）。trace 明细按会话列（convId 从键中段切、标题从 `conv-index` 拼），gm-resources 单列缓存条数。
- **清理只给可再生数据**：GM 资源缓存整键删（`remove('gm:resources')`，下次用到按 7 天 TTL 原语义重新预取）；agent trace 按会话勾选或全清（`remove(['conv:{id}:trace'])`，全清时扫 dump 过滤 trace 键）。两者都是「删了能重建」的数据，故不设导出前置；会话消息、脚本、技能、设置一律不可清。行内二次确认 `ConfirmButton`（首点武装变 confirmLabel，5s 超时还原，再点才执行）。
- **备份导出**：全量 dump → `buildBackup` 深拷贝（绝不改调用方 dump）后按 `includeApiKey` 处理——不勾选时把 `settings.provider.apiKey` **置空串**（保形状而非删字段，导入方拿到的是合法 settings）；文件头 meta（app / kind / exportedAt / extVersion / includesApiKey）。MV3 SW 无 `URL.createObjectURL`，下载走 `data:application/json;base64,` URL；`btoa` 只收 Latin1，故经 `TextEncoder` 转字节后按 `0x8000` 分块转二进制串——中文（BMP 外字符）不烂码。
- **导入（全量替换语义）**：`parseBackup` 先校验文件头（app / kind）与 data 体，**校验不过不碰现有库**；`importBackup` 走「**留存先行**」——固定含 Key 的当前库完整备份先下载，**下载成功才** `clear()` + `set(data)`，失败即中止导入（fail-safe：宁可导入失败也不丢数据）。`apiKeyMissing` 判定 = 本地原本有 Key 且导入文件无 Key（提醒导入后需重填）。完成后面板 `setTimeout(runtime.reload, 1200)` 自动重载。
- **键前缀双轨坑（勿重犯）**：`classifyKey` 与全量 dump / clear / remove 只能认**物理键**（裸 API 无 `local:` 前缀——WXT storage 的 `local:x` 落盘成裸 `x`），而 `storage/*.ts` 业务层用的是 WXT 前缀键；两套键名混用会让分类全落 `other`。同类先例见 AI 会话调试页条目「wxt storage 的 key 映射」。

**已知边界**：data: URL 方案对超大备份有内存压力（base64 再膨胀 33%，退路是 offscreen document + blob）；导入留存依赖 downloads API 可用（被拒则整个导入中止，是刻意 fail-safe）；reload 后侧边栏整页重载（正在进行的会话会中断）；trace 拼标题对已删会话置空（列表仍列出该条供清理）。测试：`tests/background/storage-manager.test.ts`（分组 / 字节 / 清理 / 备份 / 导入各路径）、`tests/settings/storage-page.test.tsx`（三区块 UI）。实机验证已过（真机截图核对总览/清理列表/导出链路），首轮实机反馈落地两笔修缮：UI 卡片化 + 窄态文案精简（8ca3ec1）、全源 404 人话文案 + 种初始 latest.json（85f37de）。v0.2.0 发布即本特性首次吃狗粮——latest.json 由 release-manifest 工作流在 Publish 时生成（含说明正文），检查更新闭环自此真实可用。

## MCP 接入（2026-09-26）

spec：`docs/superpowers/specs/2026-09-26-mcp-integration-design.md`，计划：`docs/superpowers/plans/2026-09-26-mcp-integration.md`。三处落点：AI 对话能用 MCP 工具、设置页新增「MCP 服务器」二级页（`components/settings/McpSettings.tsx`，入口并入「模型与会话」组）、输入坞左下角「网页调试」右侧新增状态钮（`components/chat/McpStatusButton.tsx`，弹层里可重连与禁用）。

- **传输只有 HTTP（环境硬约束）**：MV3 扩展跑在浏览器里，起不了本地子进程，stdio 物理不可行。`agent/mcp/client.ts` 实现 Streamable HTTP（2025-06-18，单端点 POST，响应可为 JSON 或 `text/event-stream`）与 HTTP+SSE（2024-11-05，GET 拿 `endpoint` 事件 + POST `/messages`，响应靠 id 在流上匹配），`auto` 先试前者、失败回退后者，两条都不通时报错带上两端原因。SSE 帧解析抽成纯函数 `agent/mcp/sse.ts`（粘包/半包有单测）。
- **连接不保活**：SW 空闲约 30s 被回收，SSE 长流活不过一次回收，`background/mcp.ts` 因此做成「用到才连、断了就废、重连即换客户端」。状态机 `disabled → idle → connecting → connected / error`，**error 态不自动重试**（否则每轮 loop 都打一遍外部服务），由用户显式重连。面板侧 `stores/mcp.ts` 只缓存，靠 `MCP_STATE` 广播跟随。
- **工具命名**：`mcp__<slug>__<tool>`，`agent/mcp/naming.ts` 净化到 `^[A-Za-z0-9_-]{1,64}$`（超长截断 + 4 位哈希防撞）。反查不切字符串（slug 与工具名都可能含 `__`），由后台维护 `exposedName → MCP 原名` 的 Map。
- **接缝用 bridge 而非反向依赖**：registry（agent 层）要用 MCP 工具但连接归 background 管，`agent/mcp/bridge.ts` 做注入点，未注入时安全降级为「没有 MCP 工具」。`registry.buildToolSchemas` 因此变成异步（loop 改 await），同步的 `getToolSchemas` 留给调试台。`executeTool` 里 MCP 分支排在受限页预检之前——外部服务与当前页无关。
- **ask 模式不发 MCP 工具**（外部服务证明不了只读），确认闸门沿用 `needsConfirm`：MCP 工具未登记在任何集合里，sensitive 档走 fail-safe 分支需要确认，确认卡的「本会话允许」可逐会话放行。
- **导入只吃 url 条目**：兼容 Claude Desktop 的 `{ mcpServers: {...} }`，stdio（`command`）条目跳过并逐条报 warning——浏览器跑不了，静默丢弃会让用户以为导入成功。

**已知边界**：无 OAuth（只支持静态请求头，含 Bearer）；只要 tools，不要 resources/prompts；工具开关粒度到 server，不做单工具开关；首次用到要付一次握手时间。测试：`tests/agent/mcp-{sse,naming,client,registry}.test.ts`、`tests/storage/mcp.test.ts`、`tests/background/mcp.test.ts`。

### 界面改版（同日）

初版两处界面实机偏挤偏灰，按同一轮反馈重做，逻辑未动，只换呈现与定位。

- **状态浮层改为锚在输入卡上**（与「行为模式选择器」同款）：原来锚在小钮自身、`left: -8px` 起算，面板窄时会顶穿右缘；现在 `mcpbtn-wrap` 只作定位上下文，浮层 `left: 0; right: 0` 贴住输入卡两侧，弹入动效沿用 `rise`。
- **聚合展示抽成纯函数** `summarizeMcp` / `mcpTone` / `MCP_STATUS_LABEL`（`shared/mcp.ts`）：判定优先级「没配置 > 全禁用 > 有异常 > 连接中 > 全连上 > 部分未连」只有一份，浮层聚合钮与设置页仪表条不再各写一遍。色档五档（ok/busy/warn/idle/off）统一驱动状态点、胶囊与仪表条。测试 `tests/shared/mcp-summary.test.ts`。
- **设置页重排**：页眉加聚合仪表条（台数/工具数一眼看到），能力边界做成须知条（只支持 HTTP、不保活、error 不自动重试），一台服务一小块且状态行与操作行分开，传输方式改分段控件，导入导出收进能力行。
- **写类失败不再被吞**：`stores/mcp.ts` 加 `must()`，保存/删除遇到后台 `ok:false`（重名、URL 非法、超上限）抛错上浮到表单；此前一律显示「已保存」，用户以为改好了，下次唤醒发现还是旧配置。
- **跨页跳转**：浮层「配置服务器」经 `stores/ui.ts` 的 `pendingSettingsSub` 一次性意图直接落到设置二级页，挂载后即清，不持久化。
