# 织雀AI脚本 Vevscript-ai

> 浏览器里的 agent harness：AI 在你的页面上动手，也能写成用户脚本常驻。

开源地址：<https://github.com/yutian0525/VevScript-AI>

这是一个**完整的 agent harness**——多轮工具调用循环、上下文组装与压缩、token 计量、熔断阀、权限模式、流式与续播、会话持久化、技能加载，该有的都在——只是它的运行时目标不是终端里的代码库，而是**你正在用的这个浏览器**。

工具作用在真实页面上：你的登录态、你的会话、你的标签页，不是另起一个自动化浏览器。

它还有一件别的 harness 做不到的事：**产出能脱离 harness 存活的东西**。一般 harness 的活干完，loop 一停就没了；这个可以留下一份 `.user.js` 在脚本池里，之后每次打开匹配页面自动运行，不需要再开侧边栏、不需要再调模型。

```text
一次性的活儿  →  loop 里直接做完（读页面结构 → 点击/填写/翻页 → 汇报）
每次都要的改动 →  写成 .user.js 常驻（loop 结束后照旧运行）
```

基于 **WXT + React 19 + TypeScript**，面向 Chrome MV3（Chrome 120+）。

## Harness 机件

| 机件 | 位置 | 实现 |
|---|---|---|
| 多轮循环 | `agent/loop.ts` | 工具调用循环、per-conv 并发闸门、斜杠指令解析、达阈值自动压缩 |
| 单轮执行 | `agent/run-turn.ts` | 流式增量（reasoning / 正文 / 工具参数）、工具分发、`finishReason` 处理 |
| 熔断阀 | `agent/loop-guards.ts` | 打转检测（3 次同工具同参数）、连续失败检测（5 轮全错）——**暂停问用户，不硬杀** |
| 上下文组装 | `agent/context.ts` | system prompt + 当前页面 + 技能简述 + 模式段；截断防孤立 tool 消息；图片只留最近 2 张 |
| 上下文压缩 | `agent/compact.ts` | 增量 LLM 摘要，保留近 20 条原文，边界单调不倒退，**原始消息永不删除** |
| 用量计量 | `agent/context-meter.ts`、`model-windows.ts` | token 估算 + 窗口映射表（设置可覆盖）+ 80% / 95% 档位 |
| 权限模式 | `agent/mode.ts` | ask / agent 工具面闸门，三层落实 |
| 模型抽象 | `agent/provider/` | OpenAI 兼容流式，超时 60s + 300s 静默硬兜底，`max_tokens` 显式下发 |
| 工具注册表 | `agent/tools/registry.ts` | 27 个工具，schema 驱动，返回值统一判别联合 |
| 会话持久化 | `storage/conversations.ts` | 多会话、与标签页解绑、上下文互相隔离 |
| 流式续播 | `background/agent-tail.ts` | loop 跑在 SW 里，面板切走再回来补未落库的流式尾巴 |
| 技能 | `shared/skill-md.ts` | `.md` 导入，简述注入每轮 prompt，`/command` 触发，`load_skill` 取正文 |

几个刻意的设计取向：

- **不设步数上限、不设 token 软预算**。主退出是自然终止（模型不再调工具）+ 用户中断。熔断阀只做故障检测——它测的是模型真卡住了（原地打转、每步都失败），不是正常的长任务。判定命中也只是暂停问你，不是硬杀。
- **压缩不删原文**。摘要置顶注入，被摘的原始消息仍在 storage 里；压缩改变的只是"这一轮往模型送什么"，不是历史本身。
- **loop 在 Service Worker 里**，不在面板里。所以关掉侧边栏、切标签页、面板重挂载都不打断任务；重开时后台回放权威运行态 + 补流式尾巴，而不是重跑。
- **权限约束三层落实**，因为 prompt 遵循不等于硬约束：工具清单按模式过滤 → system prompt 交代边界 → `executeTool` 执行前守卫兜底。

## 它能做什么（一）：操控浏览器

让 AI 在你当前这个浏览器里直接动手——用你的登录态、你的会话、你的标签页，不是另起一个自动化浏览器。

```text
你：把这一页的候选人姓名和邮箱整理出来，填进下面的表单
       │
       ▼
take_snapshot 取 accessibility 快照 → 页面结构树，每个可交互元素带 [uid] 编号
       │
       ▼
按 uid 定位并动手：click / fill / fill_form / hover / scroll / press_key
       │  页面结构变了旧 uid 会失效（stale），此时重新 take_snapshot
       ▼
wait_for 等文本出现、navigate_page 导航、take_screenshot 看渲染效果
       │
       ▼
做完用自然语言汇报，每一步的工具名/参数/结果都以卡片留在会话里可回查
```

为什么走 accessibility snapshot 而不是喂 HTML：uid 树只保留可交互元素与可读文本，比原始 DOM 小一到两个数量级，模型不会被样式与噪声淹没；uid 是稳定句柄，比让模型现编 CSS 选择器可靠得多。

**两种模式**（输入框旁的下拉框切换，`agent/mode.ts`）：

| 模式 | 工具面 | 用途 |
|---|---|---|
| **ask** | 11 个只读工具 | 只看不改：解读页面内容、截图、报错、网络请求。要它改动状态时它会提示你切模式 |
| **agent** | 全部 27 个 | 完整操控：点击填写导航、标签页管理、执行脚本、HTTP 请求、脚本池增删改 |

模式约束是三层的，不只靠 prompt 遵循：`filterSchemasForMode` 决定每轮给模型的工具清单 → `modePrompt` 在 system prompt 里交代能力边界 → `executeTool` 的守卫兜底拦截（防模型幻觉调用没给它的写工具）。

## 它能做什么（二）：写用户脚本

上面那条路是「现在替你做完」，这条路是「以后自动生效」。传统用户脚本的门槛在于：要懂 `@match`/`@grant` 元数据格式、要在陌生页面的 DOM 里摸黑调试、要自己装 Tampermonkey 再粘贴代码。在这里，这些全部交给 AI：

```text
你：帮我在 xxx 网站实现 <某个功能>
       │
       ▼
AI 用 take_snapshot 读页面结构（uid 树）、take_screenshot 看渲染效果，
用 list_console_messages / list_network_requests 摸清接口行为
       │
       ▼
create_script 建骨架：元数据头（@match/@grant/...）+ 未闭合 IIFE
       │
       ▼
update_script(append) 分次追加代码体，最后一段带 })(); 闭合
       │  每次写入返回 balance（括号配平状态），未闭合为 unclosed（正常）
       ▼
脚本即刻进脚本池，页面导航后自动注入运行
```

支撑这套流程的机制：

- **分步写入**：`create_script` 有长度硬闸（200 行 / 8192 字符），超限会拒绝并引导分步——先建骨架（只写到 `(function () {`，刻意不闭合），再 `patch.append` 逐段追加，末段闭合。提前闭合会让追加落到全局作用域，schema 文档里写明了这条约定。写错的段落用 `patch.replace` 按字面量精确替换（`old` 需唯一，命中多处会报错并列出行号）。
- **配平扫描**：每次写入都经词法级括号配平检查（跳过字符串/注释/正则字面量），返回 `balance: 'ok' | 'unclosed'`。分步中间态必然 unclosed，最后一段写完应为 ok——不是 ok 时 AI 会用 `grep_script` 定位漏括号再修。不做 eval（SW 的 CSP 禁 eval）。
- **按需读取**：`get_script` 行区间读取（每行带行号前缀，默认限量 200 行 + 翻页提示），`grep_script` 正则/字面量搜索（可搜全库），`list_scripts` 摘要含行数/字节数——AI 不需要把整份代码读进上下文。
- **教学式纠正**：模型输出被截断（finishReason=length）时，工具消息不是报错了事，而是带上分步指引（截断 → 建骨架 → append 追加 → 末段闭合），模型下一轮自己走对路。
- **防卡死**：LLM 超时 60s + 300s 静默硬兜底、`max_tokens` 显式下发、长参数写入时流式进度条——模型写大段代码时 UI 不会全程静默假死。

写完之后呢？脚本体进**脚本池**，和手工写的脚本待遇完全一致：启停/搜索/导入导出、全屏详情页（CodeMirror 6 编辑器可人工接管微调）、错误日志环形缓冲、`@updateURL` 更新检查（启动时节流自动查，`patch.applyUpdate` 可手动拉取）。

## 其余部件

### 会话机制（侧边栏）

- **多会话管理**：会话与标签页解绑，独立列表、重命名、删除、切换；上下文会话间隔离。
- **工具卡片**：每步调用以卡片展示工具名、参数、结果摘要，长任务的每个动作事后可回查。
- **流式输出**：reasoning/正文增量流式渲染（Markdown，GFM 表格/任务列表），长任务可切走再切回续播。写长参数时有流式进度条，不会全程静默。
- **上下文压缩**：token 用量环形仪表（80%/95% 变色），达阈值自动 LLM 摘要压缩，也可手动点击触发；原始消息永不删除。
- **技能系统**：导入 `.md` 技能（YAML frontmatter + 正文），启用技能的简述注入每轮 system prompt；输入框 `/` 唤起斜杠指令浮层，`/command` 触发技能。

### 工具集（27 个）

`*` = ask（只读）模式下也可用的 11 个，其余仅 agent 模式可用。

| 能力域 | 工具 |
|---|---|
| 页面操控 | `take_snapshot`\* `click` `fill` `fill_form` `hover` `scroll` `press_key` `wait_for`\* `navigate_page` |
| 标签页 | `list_pages`\* `new_page` `close_page` `select_page` |
| 感知 | `take_screenshot`\* `evaluate_script` `http_request` |
| 观测 | `list_console_messages`\* `list_network_requests`\* `get_network_request`\* |
| 脚本池 | `list_scripts`\* `get_script`\* `create_script` `update_script` `delete_script` `toggle_script` `grep_script`\* |
| 技能 | `load_skill`\* |

### 用户脚本引擎（类 Tampermonkey）

- **脚本池**：完整 `.user.js` 源码为唯一真源，`chrome.userScripts` 注入（Chrome 120+），启停/搜索/导入导出/URL 直链安装。
- **GM_* API**：29 个函数 grant + 4 个特殊 grant，按 `@grant` 精确安装——值存储、菜单命令、通知、资源、DOM、XHR（@connect 门控 + 跨域确认 hub 页）、cookie、download、标签页、`window.close/focus`、`window.onurlchange` 等。详见 [docs/gm-api.md](docs/gm-api.md)。
- **菜单命令入口**：扩展图标 popup 可查看当前页运行中的脚本并触发其菜单命令。

### 页面观测（无侵入）

- MAIN world hook 包装 `fetch`/`XHR`/`console` + `window.onerror`/`unhandledrejection`，经 postMessage 桥中继到 Service Worker 环形缓冲。
- `webRequest` 三事件记录全量网络元数据，hook 捕获的 body 按 (method+url+±2s) 关联富化；读取时按设置脱敏敏感头。
- **敏感站点排除**：强风控站（如 Boss直聘）可在设置页加入名单，不注入观测 hook，避免被指纹检测拒开；名单经 SW 动态注册 `excludeMatches` 生效。

### 设置页

模型设置 / 工具调试台（绕过模型直调工具）/ 脚本运行时调试台（GM API 白名单视图 + 真实桥链路直调）/ 技能管理 / 敏感站点排除。

## 环境要求

- **Node.js ≥ 20**
- **Chrome 120+**（`chrome.userScripts` API 要求；Edge/Brave 等 Chromium 系可用）
- 一个 **OpenAI 兼容 API** 的 Key（DeepSeek / Qwen / OpenAI / 中转站 / 本地 Ollama 均可）

## 快速开始

```bash
# 安装依赖（postinstall 自动执行 wxt prepare 生成类型）
npm install

# 生产构建 → .output/chrome-mv3/
npm run build

# 或开发模式（热更新 + 自动拉起浏览器）
npm run dev
```

在 Chrome 中加载：

1. 打开 `chrome://extensions`，右上角开启 **开发者模式**
2. 点 **加载已解压的扩展程序**，选择 `.output/chrome-mv3` 目录
3. 把扩展图标钉到工具栏；点图标弹出 popup，可开侧边栏/直达脚本管理/触发菜单命令
4. 侧边栏 → 设置 → 模型设置，填 Base URL（到 `/v1` 为止）/ API Key / 模型 ID，测试连接后保存

常见服务商：

| 服务商 | Base URL | 模型示例 |
|---|---|---|
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| 阿里 Qwen | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| 本地 Ollama | `http://localhost:11434/v1` | `qwen3:8b` |

> Ollama 需以 `OLLAMA_ORIGINS=chrome-extension://*` 环境变量启动，允许扩展访问 localhost。

更多上手细节（冒烟清单、故障排查）见 [docs/使用指南.md](docs/使用指南.md)。

## 常用命令

```bash
npm run dev          # 开发模式（WXT 热更新）
npm run dev:firefox  # Firefox 目标开发构建
npm run build        # 生产构建 → .output/chrome-mv3/
npm run zip          # 打包发布 zip
npm run compile      # TypeScript 类型检查（tsc --noEmit）
npm test             # Vitest 全量测试
npm run test:watch   # 测试监听模式
```

## 宣传页（landing/）

`landing/` 是独立的宣传页站点，自带 `package.json` / `tsconfig.json` / `node_modules`，与扩展的 WXT 构建互不干扰（根 `tsconfig.json` 已把它排除在扩展类型检查之外）。

```bash
cd landing
npm install
npm run dev      # 开发服务器
npm run build    # tsc --noEmit && vite build → landing/dist/
npm run preview  # 预览产物
```

- 技术栈：Vite + React 19 + TypeScript，`base: './'`（产物可直接丢到任意静态托管的子路径，含 GitHub Pages）。
- 两个页面：首页 + 使用文档页（**当前留空**，给出章节骨架与仓库内 md 的去处）。路由是手写 hash 路由（`src/router.ts`），无需服务端 rewrite。
- 首屏是可交互的仿真装置：左侧仿侧边栏、右侧仿网页，点 tag 触发「流式输出 → 工具卡 → 页面变化」三种演出（去掉推广卡片 / 缩略图悬停放大 / 注入阅读时长徽标）。
- 字体走 CDN 上的 MiSans，详见 [CLAUDE.md](CLAUDE.md) 里的换源与字重说明。

## 项目结构

```text
entrypoints/
  background.ts       Service Worker：消息路由中枢 + webRequest 观测接线 + 各模块 init
  content.ts          ISOLATED content script：页面动作执行 + hook 观测中继 + GM 桥宿主
  hook.content.ts     MAIN world hook（document_start）：包装 fetch/XHR/console
  sidepanel/          侧边栏主 UI（会话/脚本池/设置三页）
  popup/              扩展图标 popup（开侧边栏/脚本直达/菜单命令）
  script-detail/      全屏脚本详情页
  confirm/            跨域确认 hub 页
agent/
  tools/              工具 schema 注册表 + 具体工具实现
  provider/           LLM provider 抽象（OpenAI 兼容）
  loop.ts             多轮工具调用循环（并发闸门 / 斜杠指令 / 自动压缩）
  run-turn.ts         agent 单轮执行（含 tool-args-delta 流式参数进度）
  mode.ts             ask / agent 模式：只读工具白名单 + 模式 prompt + 守卫
  context.ts          上下文组装：SYSTEM_PROMPT + 页面信息 + 技能简述 + 截断
background/
  router.ts           消息路由
  agent-port.ts       长连接管理、CS_READY 等待
  scripts.ts          脚本池编排层（UI 与 AI 工具共用）
  scripts-update.ts   脚本更新检查（@updateURL 拉取/节流/广播）
  user-scripts.ts     userScripts 注入引擎
  gm-api.ts           GM_* API SW 中心（grant 白名单/值广播/菜单/错误缓冲）
  gm-*.ts             GM 资源预取 / token / tab 存储 / 下载 / cookie / urlchange / 权限
  confirm-queue.ts    通用确认队列（登记/广播/超时/解析）
  hook-registration.ts MAIN hook SW 动态注册（excludeMatches diff 同步）
  hook-exclusions.ts  敏感站点排除名单存储
  observe-store.ts    per-tab 观测环形缓冲
components/           UI 组件（chat / scripts / settings / detail / debug / scriptdebug / confirm / popup / ui）
stores/               zustand 状态（chat / ui / scripts / agent-port-client 等）
shared/               三环境共享类型与纯函数（messages / gm-apis / gm-wrapper / userscript-meta / js-balance ...）
landing/              宣传页（独立 Vite 站点，不参与扩展构建）
```

## 架构要点

Harness 那层见上面的[机件表](#harness-机件)，这里只记它之外的东西。

- **三环境通信**：前后台与 content script 的消息类型统一定义在 `shared/messages.ts`，request/response + correlation id；`background/router.ts` 集中路由。
- **Port 协议**：loop 的事件（reasoning/text 增量、tool-start/end、usage、compact 等）经 Port 广播到面板；`PortMsgToPanel = AgentEvent & {convId}` 用分布式条件类型叠加（直接交叉会破坏判别联合）；SW 侧用 `panelPorts: Set<Port>` 广播而非捏死单端口。
- **页面操控**：`take_snapshot` 在 content script 侧把 accessibility 树压成带 `[uid]` 的结构文本，uid → 元素的映射留在 content script；后续 `click`/`fill` 等只传 uid，页面结构变动后旧 uid 失效并回 stale 错误，模型据此重新取快照。选择器由此不经模型现编。
- **观测管线**：MAIN hook（页面主世界）→ postMessage → ISOLATED content.ts → `runtime.sendMessage` → SW 环形缓冲；观测工具读 SW 缓冲，零 CS 往返。
- **用户脚本**：`UserScript.text`（完整源码）为唯一真源，name/matches/grants 等均为保存时解析投影；`@grant` 精确决定 API 安装面，`@connect` 域校验 + 确认卡门控跨域。

## 开发约定（摘要）

- 图标一律用 **lucide-react**，禁止 emoji 代替图标。
- 样式统一走 `entrypoints/sidepanel/styles.css`，CSS 变量（`:root` tokens），禁硬编码色值；动画需考虑 `prefers-reduced-motion`。
- 双声道排版：`mono` 类用于机器语言（工具名/uid/JSON），`sans` 用于人语言。
- 新增工具：`agent/tools/` 实现 → 注册进 `schemas.ts` → 补测试（工具返回值统一 `{ ok: true, data? } | { ok: false, error }`）。
- 完整阶段记录与已知限制见 [CLAUDE.md](CLAUDE.md)。

## 许可证

未定（私有项目）。
