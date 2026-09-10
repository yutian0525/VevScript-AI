# 织雀AI脚本（Vevscript-ai）

说一句需求，AI 替你写并装好用户脚本。AI 驱动的浏览器用户脚本引擎与操控助手。

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

### 品牌资产

标识概念 = **编织的雀**：产品名「织雀」指织巢鸟（用草茎编织巢穴），对应「AI 替你编织脚本」。两条等宽斜杠交叉成展翼，交叉处为 `mask` 真挖空缺口（非描边描白，任意底色可用），读作经纬互穿的「织」；中央胶囊既是雀的躯干，也是鼠标滚轮（浏览器操控的双重读法）。配色只用既有 token —— `--signal #53589a` 双翼 + `--ink #1c1c22` 躯干，呼应双声道设定，不引入新色值。

- 几何定稿（勿随意改）：viewBox `0 0 32 32`，双臂 `stroke-width 4.6`，顶点 y=9.22、交叉点 y=19.72、尾端越中 3.2；躯干 `4.4×10.52` rx 2.2；缺口 = mask 描边 6.7（较双臂宽 2.1，即两侧各 1.05）。外接框 25.18×16.88（≈1.5:1），在 32 格内严格居中。
- **尾长是关键约束**：双臂与双尾等长时整体读作「X」，尾长收到 3.2 才让双臂占主导、雀形成立。加长尾巴会退回 X。
- 四份 SVG 在 `public/brand/`：`logo-mark.svg`（主标识）/ `logo-mono.svg`（单色，走 `currentColor`，深底与内联 UI 用）/ `icon-tile.svg`（signal 底 + 白字形，PNG 母版）/ `logo-lockup.svg`（横向组合 + 中文字标 + mono 副标）。
- 多份 SVG 同页内联时 `mask` id 会撞车，故各文件用 `vv-weave-{mark,mono,tile,lockup}` 独立命名，新增变体沿用该前缀。
- 扩展图标 `public/icon/{16,32,48,96,128}.png` 由 `icon-tile.svg` 栅格化而来（MV3 不吃 SVG）。WXT 自动发现该路径并写入 manifest 的 `icons`，**不要**在 `wxt.config.ts` 里显式声明。改动母版后需重新栅格化五档。
- 16px 下编织缺口按亚像素退化消失、剪影完整，是设计时留的优雅降级，非缺陷。
- `logo-lockup.svg` 字标用 `<text>` + 系统字体栈（零网络依赖），渲染依赖查看端字体；印刷场景需转曲。

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

GM API 扩充 Tier A+B（2026-09-07，`docs/superpowers/specs/2026-09-07-gm-api-expansion-tier-ab-design.md`）已完成：新增 14 函数型 API + 3 特殊 grant（注册表 `shared/gm-apis.ts` 15→29 函数 grant，`SPECIAL_GRANTS` 1→4）。Tier A（零新权限）：批量值 `GM_getValues/setValues/deleteValues`、`GM_removeValueChangeListener`、`GM_addElement`、`GM_unregisterMenuCommand`、`GM_getResourceURL`、`GM_getTab/saveTab/getTabs`（`background/gm-tab-store.ts`，storage.session per-tab 键 `gm-tab:{scriptId}:{tabId}`）、`GM_closeNotification/updateNotification`、特殊 grant `window.close/focus`。Tier B（新权限）：`GM_download`（`background/gm-download.ts`，chrome.downloads + downloads 权限 + @connect 门控，onload/onerror，onprogress 暂缺）、`GM_cookie.list/set/delete`（`background/gm-cookie.ts`，cookies 权限 + @connect 门控复用，对象型 grant 一次装齐三方法）、特殊 grant `window.onurlchange`（`background/gm-urlchange.ts`，webNavigation onHistoryStateUpdated/onReferenceFragmentUpdated 主帧下行 URL_CHANGE + `'urlchange'` 事件双形态）。manifest 加 downloads/cookies/webNavigation 三权限。预取管线（`background/gm-resources.ts`）扩二进制 base64+mime，`GM_getResourceURL` 拼完整 data: URL。wrapper（`shared/gm-wrapper.ts`）objectApi 分支支持对象型 grant、specialGrantLines 处理特殊 grant + preamble 加 URL_CHANGE 分发。手测 fixtures 扩 storage/dom-resource/tabs + 新增 cookie/download/urlchange/notify-menu 四模块（`gmt-selftest` 同步 29+4 grant，调试台 CALL 表登记 14 新 API）。已知边界：cookie/download/xhr 共用同一 @connect 授权库；download 无 onprogress；window.close/focus 作用整 tab；urlchange 仅主帧不覆盖 iframe。工具计数不变（GM API 非 agent 工具）。

设置页枢纽 + 脚本运行时调试台（2026-09-03）已完成：railnav 减为 3 项（会话/脚本池/设置），调试台入口收进设置页。设置页改为壳（`components/settings/SettingsView.tsx` 内部 `useState` 二级路由，不持久化）→ 三入口：模型设置（`ModelSettings.tsx`，原表单平移）/ 工具调试台（`components/debug/ToolBenchPage.tsx`，按能力域 PAGE/TABS/NET/SCRIPTS 四分分组 + tag chip 四档，修正原 12 个错标 TABS）/ 脚本运行时调试台（`components/scriptdebug/ScriptDebugPage.tsx`）。工具能力域数据抽 `components/debug/tool-tags.ts`（可测），结果面板抽 `components/debug/ResultPanel.tsx`（工具台与 GM 台共用）。脚本运行时调试台三块：白名单视图（`GM_DEBUG_INFO` 回 grant 二分/@connect/始终允许主机/注入态）、GM API 列表（读 `GM_API_REGISTRY` 14 行）、三类直调（bridge 7 + SW 分支 2 完整真实链路，页面内 5 置灰）。直调链路：面板 `GM_DEBUG_CALL`→SW `bridgeTokensForUrl` 查 token→`GM_DEBUG_INVOKE` 下行 content→`gm-bridge-host.debugCall()` 在页面 dispatch `gmreq`（debug 命名空间 reqId 从 10 亿起）→宿主真实 token 校验 + `handleGmCall`→`gmres` 回环（10s 超时），除 wrapper 函数体外全链路真实。直调 api 用点形式短名（SetValue/XmlHttpRequest…）。已知边界：SW 内存态随重启丢失；页面内 5 API 置灰是第一版取舍；受限页因查不到 token 直接报错。

技能系统 + 斜杠指令（2026-09-04）已完成：`Skill` 实体（`local:skills:index`，command 唯一键 kebab-case——`saveSkill` 新增/更新两路径都校验，上限 100 条/正文 64KB/简述 200 字符）仅经 `.md` 导入产生（YAML frontmatter name/description/command + 正文，`shared/skill-md.ts` 手写最小解析：CRLF 归一化 + 启发式拆分——非 frontmatter 开头的段并回前一段并留「已并入」warning，序列化 name/description 换行防御；多文档 `\n---\n\n` 串联；同 command 覆盖更新保留 id/enabled，坏文档跳过+warning 带 filename 归属）；管理页 = 设置页二级页 `SkillsPage`（第四入口，列表搜索/多选导入聚合/导出 Blob 下载/启停/删除/详情只读，无新建无编辑）；启用技能简述经 `LoopDeps.getSkills` 每轮 `buildContext` 第 5 参注入 system prompt（`buildSkillsPrompt`，port 侧 storage 故障降级空数组）；斜杠指令 = 输入框 `/` 浮层（`components/chat/slash.ts` 纯函数 shouldOpenSlash/handleSlashKey/completeSlash + `SlashMenu` 展示组件，Enter/Tab/点击 = 补全 `/cmd ` 非发送，Esc dismissed 后输入变化重开，候选统一截断 8 条）+ loop 侧 `/^\/([a-z0-9-]+)(?:\s+([\s\S]*))?$/` 解析（原文落库，命中 enabled 技能把正文作为隐藏 system 消息仅注入触发轮——`pendingSlash` 消费即清防多轮重复，未命中原样普通文本；resumeAgentLoop 恢复轮不重新注入）；AI 自主调用为遵循式（无新工具位，工具数 25 不变）。已知取舍：多文档拆分对正文含 `---` 水平线的文档会并段+warning；浮层空匹配无占位行、blur 不关浮层、IME 组合期 Enter 未豁免（与既有 send-on-Enter 同病）；徽标正则不 trim 与 loop 侧 trim 后解析有纯外观分叉。

AI 写脚本流程优化（2026-09-06，`docs/superpowers/specs/2026-09-06-ai-script-authoring-optimization-design.md`）已完成，四修卡死 + 分步写入：

1. **卡死四修**：(a) loop 下发 `max_tokens`（`AgentConfig.maxTokens` 默认 8192，0=不下发；`LoopDeps.getMaxTokens` 每轮读 settings）；(b) `llmTimeoutSec` 默认 10→60s，且 `timeoutMs=0`（不限时）仍有 300s 静默硬兜底（`ProviderOptions.hardCapMs`，防网关挂死 → Promise 永不 resolve → runningConvs 永久占位 → 面板永久 running）；(c) 新增 `tool-args-delta` 事件（run-turn 的 `onToolArgsDelta` hook 回调累计字节 → loop 侧 `makeArgsThrottle` 节流（首次立即 + 满 200ms 或涨够 1KB）→ agent-tail `argsProgress` 续播 → chat store 顶层瞬态 → ChatView 消息流末尾进度条），根治「模型在写长参数时 UI 全静默」；(d) AI 工具层写操作返回瘦身（`toWriteResult`：id/name/lines/bytes/matches/enabled/runAt/world/warnings/balance，不回灌 text/code——同一份代码此前在上下文存三份）。
2. **分步写入**：`ScriptPatch` 扩 `append`（追加到末尾，不需行号）与 `replace`（`{old,new,all?}` 字面量精确替换，old 需唯一否则报错列行号）；`handleUpdate` 文本分支四支互斥（text/edit/append/replace 同传两支报错，不再静默取优先）；`create_script` 长度硬闸（`MAX_CREATE_LINES`=200 / `MAX_CREATE_CHARS`=8192，超限报错文案教分步；url 导入/patch.text 不受限）。骨架约定：create 只交元数据头 + 未闭合 IIFE（`(function () {` 结尾），末段 append 带 `})();` 闭合——提前闭合会让追加落到全局作用域。write-script 技能第 3 步重写为分步流程（2026-09-08 再修订为四步：第 1 步先查脚本池查重可复用、简单需求不追问，第 3 步提方案后停下来等用户确认才动笔，第 4 步交付使用说明但不自行注入验证——仅用户明确要求测试才验证）。
3. **配平扫描**：`shared/js-balance.ts` 纯函数词法扫描（跳过字符串/模板串含 `${}` 嵌套/注释/正则字面量，检查 {}()[] 配平与未闭合引号；不做 eval——SW CSP 禁 eval），写入返回带 `balance: 'ok' | 'unclosed'`（只报告不阻断——分步中间态必然 unclosed）。
4. **按需读取**：`list_scripts` 摘要加 `lines`/`bytes`；`get_script` 每行带 `%4d| ` 行号前缀（`annotateLines`，仅 AI 工具层，编排层 handleGet 不动）+ 默认限量 200 行 + notice 翻页提示；新增 `grep_script` 工具（26→27，`agent/tools/script-grep.ts`：正则优先非法降级字面量+warning、id 缺省搜全库、contextLines 去重膨胀、limit 截断；纯 storage 豁免受限页预检，进 ASK_MODE_TOOLS）。
5. **教学式纠正**：finishReason=length + toolCalls 的 tool 消息改为分步指引（截断 → create 骨架 → append 追加 → 末段闭合）；四个脚本工具 schema description 写入分步规则与 balance 判读；SYSTEM_PROMPT 加「写长内容先建骨架再分次追加」通用规则。已知边界：js-balance 的正则/除号区分是启发式（`return /re/` 会误判为除号）；`bytes` 是 UTF-16 code units 非严格字节；部分模型（o1 系）需 `maxTokens` 置 0 或经 extraBody 补 `max_completion_tokens`。

宣传页 `landing/`（2026-09-09）已完成：独立 Vite + React 19 + TS 站点，自带 `package.json` / `tsconfig.json` / `node_modules`，与 WXT 构建零耦合。开源地址 <https://github.com/yutian0525/VevScript-AI>（`src/router.ts` 导出 `REPO` 常量，全站引用它，不散落硬编码 URL）。

- **构建隔离**：根 `tsconfig.json` 必须 `"exclude": ["./node_modules", ".output", "landing"]`——`.wxt/tsconfig.json` 的 include 是 `../**/*`，会把 landing 卷进扩展的 `npm run compile`，而 landing 依赖 `vite/client` 类型（扩展侧没有）。exclude 在继承时整体覆盖而非合并，故基础配置那两条要一并列出。`base: './'` 让产物可丢到任意子路径（GitHub Pages）。
- **字体换源（重要）**：原指定的自建 CDN `mypan.yutkit.com/raw/fonts/MiSans-*.woff2` 文件在、返回 200，但**不回 `Access-Control-Allow-Origin`，且 OPTIONS 405**。webfont 是 CORS 强制资源，浏览器一律拒载，换任何部署域名都一样（那边的简历站看着正常是因为本机装了 MiSans，走的系统字体）。改用 `misans@4.1.0`（小米官方字体的 npm 分发）经 jsDelivr，`ACAO: *`；且已按 unicode-range 切成每档 100 个子集片，实测本页只下 32 片约 130KB，而原方案单档全字库 4.7MB（两档 9.6MB）。**该包声明的是 MiSans 光学字重而非 CSS 百分档：Regular = 330、Semibold = 520**，故全站字重走 `--w-body` / `--w-bold` 两个 token，直接写 400/600 会命中不到 face 并静默掉回系统栈。字体由 `index.html` 的两条 `<link>` 拉，styles.css 内不再声明 `@font-face`。
- **设计语言**：几何取自标识——logo 双臂斜率算出约 43.7°，全页取 44deg 用作编织底纹的经纬双向线（`--weave`，只在 hero / CTA 出现）。曾做过一道"44° 斜切"的 hero 底边界，后删除：全宽楔形高 104px 实际只有 4°，与标称角度不符，属自欺的装饰。色板全部继承产品既有 token（`--signal #53589a` 单信号色），不引新色值。双声道排版延续到宣传页：MiSans 作人语言，系统 mono 栈作机器语言（工具名 / uid / JSON / 令牌 / 数字量）。
- **定位是「浏览器里的 agent harness」**（二次返工，最终口径）：本项目的身份不是"能操控浏览器的助手"，而是一个**完整的 agent harness**——多轮 loop、上下文组装与压缩、token 计量、熔断阀、权限模式、流式与续播、会话持久化、技能加载，机件齐全——只是运行时目标是浏览器而非终端里的代码库。`agent/loop-guards.ts` 第 6 行的设计注释是直接证据：「正经 agent harness（如 pi）都不靠数步数/数 token 兜底」，代码本就以 harness 为参照系设计。区别于其它 harness 的两点：(1) 工具作用在你真在用的浏览器上（真登录态/会话/标签页，非沙箱自动化浏览器）；(2) **能产出脱离 harness 存活的产物**——用户脚本在 loop 停止后照旧运行，一般 harness 的活干完就没了。「两条路」（当场做完 / 写成脚本常驻）是这个身份的两种输出形态，不是两个并列产品。
  - **但 harness 不能当钩子用**（三次返工，最终形态）：曾把 harness 顶成 slogan 与首屏 H1，结果读者在知道「它替我干什么」之前先撞上「多轮循环 / 上下文压缩 / token 计量 / 熔断阀」一整墙机件——`agent harness` 是圈内行话，对外零信息量。现在的顺序是**先说人话，harness 作可信度层垫在后面**：slogan =「在侧边栏说一句话，AI 就在当前网页上替你做完。常做的事，写成用户脚本以后自动跑。」，harness 降为正文一节，标题「它不是套壳调模型」（不认识 harness 的读者也知道这节为什么值得看），节内才引入该词。
  - slogan 六处联动：`wxt.config.ts` 的 manifest description、`package.json` 的 description、README 引言 blockquote、`landing/index.html` 的 title/description/og、宣传页 H1（`说一句话，` + em `AI 替你动手`）。改口径时一起动。
  - **章节顺序（README 与宣传页必须一致）**：引言/首屏（人话 + 两个对话例子）→ 两条路 → 写脚本细节 → **它不是套壳调模型**（机件表 + 设计取向）→ 工具集 → 脚本引擎/观测/调试 → 上手。机件表垫在两条路之后，不许再往前挪。
  - README「它不是套壳调模型」一节有 12 行机件表 + 4 条设计取向，宣传页有对应的 `#harness` 节（复用 `.tools/.toolrow` 规格表骨架 + `.stances` 取向格）。**新增 harness 机件时这两处要同步**。
  - **首屏 H1 的 em 那行有字数硬约束**：`white-space: nowrap`（编织下划线不能断行），1440px 下左栏约 470px、74px 字号最多容 6 个汉字。写到 9 个字（「AI 在这一页上动手」= 594px）会溢出 125px 并压进右侧装置。加字前先量。
- **两条能力都要写到**（初版返工点）：产品是「操控浏览器」+「写用户脚本」两条并列输出（`SYSTEM_PROMPT` 第一句就是「一个能操控浏览器、并替用户编写和安装用户脚本的 AI 助手」）。初版宣传页把操控降格成「写脚本前的读页面手段」，装置三个场景全以写出脚本收尾，等于只演了一半，已返工：新增 `#paths` 节（两条路对照 + ask/agent 两种模式）、装置加 `act-now` 场景（`take_snapshot` + 三次 `click` 点亮「稍后读」，全程不调 `create_script`，收尾台词点出「一次性的活儿不值当留常驻脚本」这个取舍）。（旧 slogan「说一句需求，AI 替你写并装好用户脚本」只覆盖一半能力，已在二次返工中替换，见上条。）
- **签名装置**（`src/components/Demo.tsx` + `DemoPanel` + `DemoPage` + `demo/`）：左仿侧边栏 + 右仿网页，四个场景（加进稍后读=直接操控 / 去掉推广卡片 / 缩略图悬停放大 / 注入阅读时长徽标）。`act-now` 排在首位故为滚入自动播的那条——首屏既已立在 harness / 当场动手上，自动播的场景必须与之呼应；用户最初要的「卡片消失」效果保留为第二个 tag，一点即到。演出脚本是纯数据（`demo/script.ts` 的 beat 数组，按 `at` 毫秒排布），`demo/useRunner.ts` 是时间线执行器——所有 timer 收进 ref 数组统一 clear，切场景/卸载都能干净取消（已验证半途连点三次无残留写入）。工具名、参数形状、结果摘要全取产品真实存在的那套（`patch.append`、`balance: unclosed`），不编造 API。滚入视口自动跑第一条（IntersectionObserver，阈值 0.2——窄屏装置竖排后很高，0.45 要滚很久才满足）。`prefers-reduced-motion` 下时间线压缩至 0.45 倍且文字整段落地不逐字。
- **踩过的坑（勿重犯）**：(1) 单列栅格必须写 `minmax(0, 1fr)`，裸 `1fr` = `minmax(auto, 1fr)` 不肯缩到内容最小宽度以下，里头一个不可断行的 `<code>` 就把整页顶出横向滚动条（375px 下 scrollWidth 一度 492）；(2) 长 mono URL 的表格要套 `overflow-x: auto` 容器，表的固有最小宽度会顶宽栅格轨道，`minmax(0,…)` 管不到表自身；(3) `text-overflow: ellipsis` 在 flex 容器上不生效，卡片标题会被硬切没有省略号——要块级；(4) **JSX 把「行尾 + 缩进」折成一个空格，中文句内换行会真的多出一个空格**（`、 装进`），故每个中文句子留在同一物理行；(5) 卡片退场动画用 margin 而非 gap 排列，gap 无法参与过渡，抽出瞬间会留空隙；(6) 悬停放大要 `transform-origin: right`（向左长），向右长会盖住自己的标题看着像布局坏了，且需给仿真网页左右 24px 内边距，18px 时放大的缩略图会探出 `overflow: hidden` 被切一刀；(7) 仿真网页里的"标题"不能用 `h3/h4`——会进宿主文档大纲，造成 H1→H3→H4→H2 跳级且读屏按标题跳转会掉进示意内容，改用 div + 类名承载样式。
- **文档页刻意留空**：不假装有内容，给出章节骨架（10 章，标"待写"）+ 现成去处（仓库 README / `docs/gm-api.md` / `docs/使用指南.md`）。
- **已知边界**：`#flow` / `#tools` / `#start` 这些区块 id 与 hash 路由同名空间，`#tools` 会被解析成路由并落回首页（当前无任何链接指向它们，仅作滚动锚点）；宣传页无测试（纯静态展示页，按项目约定不为它铺测试基建）；`logo-lockup.svg` 的字标走系统字体栈，渲染依赖查看端字体。

敏感站排除名单（2026-09-08，`docs/superpowers/specs/2026-09-08-hook-exclusion-list-design.md`）已完成：MAIN world 观测 hook（`entrypoints/hook.content.ts`）改 SW 动态注册（`registration: 'runtime'`，manifest 不再静态声明），`background/hook-registration.ts` 经 scripting.registerContentScripts diff 同步（注册详情 js 为裸路径 string[] 形状——与 userScripts 的 {file}/{code} 对象形状不同；persistAcrossSessions 显式 true 作防御，官方默认即 true），excludeMatches 承载名单；`background/hook-exclusions.ts` 独立存储（`local:hook:exclusions`，默认招聘四站 zhipin/lagou/zhaopin/51job，未存过时兜底），`HOOK_EXCLUSIONS_GET/SAVE` 消息 + 设置页第五卡「敏感站点排除」（`components/settings/HookExclusionsPage.tsx`，增删/恢复默认，保存即生效，刷新页面后生效）。动机：Boss直聘等强风控站指纹检测 MAIN world hook 包装的 console/fetch/XHR 拒开；排除站上 console 观测失效、网络观测无 body，AI 工具（ISOLATED）照常。已知边界：第三方风控 iframe（跨域文档）不覆盖；用户自己的脚本池脚本不归名单管；dev 模式改 hook 需重载扩展（SW 冷启动 sync 兜底）。
