<p align="center">
  <img src="public/brand/logo-mark.svg" width="76" height="76" alt="织雀AI脚本" />
</p>

<h1 align="center">织雀AI脚本 Vevscript-ai</h1>

<p align="center">在侧边栏说一句话，AI 就在当前网页上替你做完。<br />常做的事，写成用户脚本以后自动跑。</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-1.0.0-53589a?style=flat" alt="version" />
  <img src="https://img.shields.io/badge/Chrome-120%2B-53589a?style=flat" alt="Chrome 120+" />
  <img src="https://img.shields.io/badge/React-19-53589a?style=flat" alt="React 19" />
  <img src="https://img.shields.io/badge/TypeScript-7-53589a?style=flat" alt="TypeScript 7" />
  <img src="https://img.shields.io/badge/WXT-MV3-53589a?style=flat" alt="WXT MV3" />
</p>

<p align="center">
  <a href="https://vevscript.yutkit.com">官网</a> ·
  <a href="docs/使用指南.md">使用文档</a> ·
  <a href="https://github.com/yutian0525/VevScript-AI/issues">问题反馈</a>
</p>

---

## 目录

- [这是什么](#这是什么)
- [两种用法](#两种用法)
- [核心特性](#核心特性)
- [快速开始](#快速开始)
- [工具与模式](#工具与模式)
- [用户脚本引擎](#用户脚本引擎)
- [项目结构](#项目结构)
- [深入了解](#深入了解)
- [常用命令](#常用命令)

## 这是什么

织雀 AI 脚本（Vevscript-ai）是一款基于 Chrome 侧边栏的 AI 浏览器自动化扩展。装上后浏览器右侧多出一个侧边栏，用户以自然语言描述需求，扩展读懂当前页面后直接动手完成。

它有两种用法：**当场做完一件事**，或把重复性需求**生成用户脚本**后自动运行。两者共用同一套页面感知——accessibility 结构树、截图、控制台与网络观测。

一个关键区别：它操作的是**用户正在使用的浏览器**——现有登录态、Cookie 与已打开的标签页，而非另起一个干净的自动化实例。因此任务可即时执行，无需重新登录。

模型可自由接入任意 OpenAI 兼容 API（DeepSeek / Qwen / OpenAI / 中转服务 / 本地 Ollama）。项目开源，基于 WXT + React 19 + TypeScript，面向 Chrome MV3。

## 两种用法

**当场做完一件事**

```text
你：把这页候选人的姓名和邮箱整理出来，填进下面的表单
它：读页面结构 → 逐个点击、填写 → 完成后汇报
    每一步调用的工具、参数与结果都留成卡片，可回查
```

**写成脚本，以后自动做**

```text
你：把这个站点信息流里的推广卡片都去掉
它：写一份 .user.js 装进脚本池 → 以后每次打开该站点自动生效
    无需再开侧边栏，也无需再调用模型
```

第二种即**用户脚本**（Tampermonkey 那一套）。传统方式需自行掌握 `@match` / `@grant` 元数据格式、在陌生 DOM 中调试、再安装管理器粘贴代码；这里一句话即可生成，脚本也统一在此管理。

## 核心特性

- **自然语言操控网页** — 基于 accessibility 快照（uid 树）定位元素，点击、填写、翻页、导航一气呵成，每步以卡片记录。
- **AI 生成用户脚本** — 读懂页面后生成完整 `.user.js`，由 `chrome.userScripts` 在匹配页面自动注入，与手写脚本同池管理。
- **完整 agent 运行时** — 多轮循环、上下文压缩、熔断保护、权限模式、流式续播、会话持久化，机件齐全。
- **两种权限模式** — ask 只读、agent 完整操控，工具面按模式三层收放。
- **类 Tampermonkey 引擎** — 脚本池、29 个 GM\_\* 函数 grant、页面观测、更新检查一应俱全。
- **模型自由接入** — 任意 OpenAI 兼容 API，DeepSeek / Qwen / OpenAI / 中转服务 / 本地 Ollama 均可。

## 快速开始

**环境要求**

- Chrome 120+（`chrome.userScripts` API 要求；Edge / Brave 等 Chromium 系可用）
- 一个 OpenAI 兼容 API 的 Key
- Node.js ≥ 20（只有自己构建才需要；下 Release 打包版不需要）

**安装**（两条路，任选一条）

- **下载打包版**（免构建）：到 [Releases](https://github.com/yutian0525/VevScript-AI/releases) 取最新的 `vevscript-ai-v<版本>-chrome-mv3.zip`，解压到一个以后不再挪动的目录——Chrome 记住的是这个路径，加载后再挪扩展会失效。
- **自己构建**：

  ```bash
  npm install      # 安装依赖（postinstall 自动 wxt prepare 生成类型）
  npm run build    # 生产构建 → .output/chrome-mv3/
  npm run dev      # 或开发模式（热更新 + 自动拉起浏览器）
  ```

**加载**

1. 打开 `chrome://extensions`，右上角开启**开发者模式**
2. 点**加载已解压的扩展程序**，选上一步得到的目录（自建为 `.output/chrome-mv3`，打包版为解压出的目录）
3. 将扩展图标固定到工具栏；点图标弹出 popup，可开侧边栏 / 直达脚本管理 / 触发菜单命令
4. 侧边栏 → 设置 → 模型设置，填写 Base URL（以 `/v1` 结尾）/ API Key / 模型 ID，测试连接后保存

**常见服务商**

| 服务商      | Base URL                                            | 模型示例        |
| ----------- | --------------------------------------------------- | --------------- |
| DeepSeek    | `https://api.deepseek.com/v1`                       | `deepseek-chat` |
| 阿里 Qwen   | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus`     |
| OpenAI      | `https://api.openai.com/v1`                         | `gpt-4o-mini`   |
| 本地 Ollama | `http://localhost:11434/v1`                         | `qwen3:8b`      |

> Ollama 需以 `OLLAMA_ORIGINS=chrome-extension://*` 环境变量启动，允许扩展访问 localhost。

上手细节（冒烟清单、故障排查）见 [docs/使用指南.md](docs/使用指南.md)。

## 工具与模式

模型可调用 **28 个功能工具**（分 6 个能力域）加 **3 个记忆工具**。每次调用以卡片形式记录工具名、参数与结果摘要。为什么走 accessibility 快照而非原始 HTML：uid 树仅保留可交互元素与可读文本，体积小一到两个数量级，且 uid 是稳定句柄，比模型现编 CSS 选择器可靠。

**两种模式**（输入框旁下拉切换，`agent/mode.ts`）：

| 模式      | 工具面        | 用途                                                                       |
| --------- | ------------- | -------------------------------------------------------------------------- |
| **ask**   | 12 个只读工具 | 仅读取：解读页面、定向查询、截图、控制台报错、网络请求。涉及修改时提示切换 |
| **agent** | 全部 28 个    | 完整操控：点击填写导航、标签页管理、脚本执行、HTTP 请求、脚本池增删改      |

模式约束三层落实，不只靠 prompt：按模式过滤工具清单 → system prompt 交代能力边界 → 执行前守卫兜底拦截幻觉调用。

**功能工具一览**（`*` = ask 模式下同样可用）：

| 能力域   | 工具                                                                                                                  |
| -------- | --------------------------------------------------------------------------------------------------------------------- |
| 页面操控 | `take_snapshot`\* `query_page`\* `click` `fill` `fill_form` `hover` `scroll` `press_key` `wait_for`\* `navigate_page` |
| 标签页   | `list_pages`\* `new_page` `close_page` `select_page`                                                                  |
| 感知     | `take_screenshot`\* `evaluate_script` `http_request`                                                                  |
| 观测     | `list_console_messages`\* `list_network_requests`\* `get_network_request`\*                                           |
| 脚本池   | `list_scripts`\* `get_script`\* `create_script` `update_script` `delete_script` `toggle_script` `grep_script`\*       |
| 技能     | `load_skill`\*                                                                                                        |

## 用户脚本引擎

- **脚本池** — 完整 `.user.js` 源码为唯一真源，`chrome.userScripts` 注入（Chrome 120+）；支持启停、搜索、导入导出、URL 直链安装，全屏详情页内置 CodeMirror 6 编辑器，`@updateURL` 更新检查。
- **GM\_\* API** — 29 个函数 grant + 4 个特殊 grant，按 `@grant` 精确安装：值存储、菜单命令、通知、资源、DOM、XHR（`@connect` 门控 + 跨域确认页）、cookie、download、标签页、`window.onurlchange` 等。详见 [docs/gm-api.md](docs/gm-api.md)。
- **AI 分步写入** — 长脚本受单次输出长度限制，流程为先建骨架（元数据头 + 未闭合 IIFE）再分次追加，每次写入经词法级括号配平校验。
- **页面观测** — 默认用 `webRequest` 记录全量网络元数据；在输入坞一键开启「深度观测」（CDP）后可拿到全量响应体、完整请求头、WebSocket 帧与带堆栈的控制台日志，且不再向页面注入任何 MAIN world 脚本。

## 项目结构

```text
entrypoints/     Service Worker / content script / 侧边栏 / popup / 脚本详情页 / 确认页
agent/           工具注册表 + LLM provider 抽象 + 多轮循环 + 单轮执行 + 模式 + 上下文组装
background/      消息路由 + 脚本池编排 + userScripts 注入 + GM_* SW 中心 + 观测缓冲
components/      UI 组件（chat / scripts / settings / detail / debug / popup / ui ...）
stores/          zustand 状态（chat / ui / scripts ...）
shared/          三环境共享类型与纯函数（messages / gm-apis / gm-wrapper / brand ...）
landing/         宣传页（独立 Vite 站点，不参与扩展构建）
docs/            开发历程、GM API 参考、使用指南
```

## 深入了解

README 仅作概览。以下主题在专门文档中展开：

- **agent harness 机件** — 多轮循环、熔断阀、上下文压缩、流式续播等的实现与设计取向，见 [docs/history.md](docs/history.md)。
- **GM\_\* API 全集** — 完整签名、与 Tampermonkey / Violentmonkey / ScriptCat 的兼容对照，见 [docs/gm-api.md](docs/gm-api.md)。
- **架构与开发约定** — 三环境通信、Port 协议、页面操控/观测管线，及各迭代阶段记录，见 [CLAUDE.md](CLAUDE.md)。

## 常用命令

```bash
npm run dev          # 开发模式（WXT 热更新）
npm run dev:firefox  # Firefox 目标开发构建
npm run build        # 生产构建 → .output/chrome-mv3/
npm run zip          # 打包发布 zip
npm run compile      # TypeScript 类型检查（tsc --noEmit）
npm test             # Vitest 全量测试
```

## 许可证

[MIT](LICENSE)
