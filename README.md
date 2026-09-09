# 织雀AI脚本 Vevscript-ai

> 说一句需求，AI 替你写并装好用户脚本。

让 AI 替你写浏览器用户脚本。

对着侧边栏说一句需求（"在 B 站首页把缩略图悬停放大"），AI 通过 27 个内置工具理解页面、编写并安装一个 `.user.js` 用户脚本，下次打开匹配页面自动生效——不需要你打开编辑器。它同时也是一个完整的类 Tampermonkey 脚本管理器、页面/网络观测台，和一个长在浏览器侧边栏里的通用 Agent。

基于 **WXT + React 19 + TypeScript**，面向 Chrome MV3（Chrome 120+）。

## 核心能力：AI 写用户脚本

这是本项目的主打场景。传统用户脚本的门槛在于：要懂 `@match`/`@grant` 元数据格式、要在陌生页面的 DOM 里摸黑调试、要自己装 Tampermonkey 再粘贴代码。在这里，这些全部交给 AI：

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

## 其他能力

### AI Agent（侧边栏会话）

- **多会话管理**：会话与标签页解绑，独立列表、重命名、删除、切换；上下文会话间隔离。
- **工具调用**：AI 通过 27 个内置工具操作浏览器，每步以卡片形式展示工具名、参数、结果摘要。
- **流式输出**：reasoning/正文增量流式渲染（Markdown，GFM 表格/任务列表），长任务可切走再切回续播。
- **上下文压缩**：token 用量环形仪表（80%/95% 变色），达阈值自动 LLM 摘要压缩，也可手动点击触发；原始消息永不删除。
- **技能系统**：导入 `.md` 技能（YAML frontmatter + 正文），启用技能的简述注入每轮 system prompt；输入框 `/` 唤起斜杠指令浮层，`/command` 触发技能。

### 工具集（27 个）

| 能力域 | 工具 |
|---|---|
| 页面操控 | `take_snapshot` `click` `fill` `fill_form` `hover` `scroll` `press_key` `wait_for` `navigate_page` |
| 标签页 | `list_pages` `new_page` `close_page` `select_page` |
| 感知 | `take_screenshot` `evaluate_script` `http_request` |
| 观测 | `list_console_messages` `list_network_requests` `get_network_request` |
| 脚本池 | `list_scripts` `get_script` `create_script` `update_script` `delete_script` `toggle_script` `grep_script` |
| 技能 | `load_skill` |

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
  run-turn.ts         agent 单轮执行（含 tool-args-delta 流式参数进度）
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
```

## 架构要点

- **三环境通信**：前后台与 content script 的消息类型统一定义在 `shared/messages.ts`，request/response + correlation id；`background/router.ts` 集中路由。
- **Agent loop**：`agent/run-turn.ts` 单轮执行工具调用循环，事件（reasoning/text 增量、tool-start/end、usage、compact 等）经 Port 协议广播到面板；面板重开时后台回放权威状态 + 未落库的流式尾巴。
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
