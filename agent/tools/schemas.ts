// agent/tools/schemas.ts
// 37 个工具的 OpenAI function calling schema：Phase 2 的 9 个 + Phase 3a 的 7 个（tabs/screenshot/evaluate/http_request）+ Phase 3b 的 3 个（console/network 观测）+ 深度观测开关的 1 个（CDP）+ Phase 4 的 6 个（脚本池）+ Skill 的 1 个 + 脚本检索的 1 个 + 记忆的 3 个 + 页面感知的 1 个（query_page）+ 技能池的 5 个。描述对齐 chrome-devtools-mcp。
import type { ToolSchema } from '../provider/types';

// 显式声明返回 Record<string, unknown>，避免 type:'object' 字面量收窄导致的赋值报错。
const obj = (
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

export const TOOL_SCHEMAS: ToolSchema[] = [
  {
    type: 'function',
    function: {
      name: 'take_snapshot',
      description:
        '获取页面内容树，每行带 [uid]，用 uid 做 click/fill/hover。默认 detail="interactive"：只出可交互元素、标题与视口内文本，容器折叠为「… [N 个未展开节点]」计数行。需要完整文本时用 detail="full"；只关心某个区域时用 region 限定。注意 uid 定位到元素，同一元素下多行文本共享同一 uid（非逐行唯一）；隐藏子菜单聚合在父节点 description 里，要操作需先 hover 展开再重新快照。穿透同源 iframe，跨域 iframe 读不到，skippedFrames 计数。页面变化后 uid 失效，需重新调用。',
      parameters: obj({
        detail: {
          type: 'string',
          enum: ['interactive', 'full'],
          description: '详细档位，缺省 interactive（推荐），full 为全量',
        },
        region: {
          description: '限定子树：元素 uid（数字）或 CSS 选择器（字符串，仅主帧）',
        },
      }),
    },
  },
  {
    type: 'function',
    function: {
      name: 'click',
      description: '点击快照中 uid 指定的元素。可选双击。点击后如需查看页面变化，请另行调用 take_snapshot。',
      parameters: obj(
        {
          uid: { type: 'number', description: '来自最近一次 take_snapshot 的元素 uid' },
          dblClick: { type: 'boolean', description: '是否双击' },
        },
        ['uid'],
      ),
    },
  },
  {
    type: 'function',
    function: {
      name: 'fill',
      description: '向 uid 指定的输入框/文本域/下拉框填入值（会触发 input/change 事件）。',
      parameters: obj(
        {
          uid: { type: 'number', description: '元素 uid' },
          value: { type: 'string', description: '要填入的文本' },
        },
        ['uid', 'value'],
      ),
    },
  },
  {
    type: 'function',
    function: {
      name: 'fill_form',
      description: '批量填写多个表单字段。',
      parameters: obj(
        {
          elements: {
            type: 'array',
            description: '要填写的字段列表',
            items: obj({ uid: { type: 'number' }, value: { type: 'string' } }, ['uid', 'value']),
          },
        },
        ['elements'],
      ),
    },
  },
  {
    type: 'function',
    function: {
      name: 'hover',
      description: '悬停到 uid 指定的元素（触发 hover 效果，如下拉菜单）。',
      parameters: obj({ uid: { type: 'number', description: '元素 uid' } }, ['uid']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'scroll',
      description: '滚动页面。',
      parameters: obj(
        {
          direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: '滚动方向' },
          amount: { type: 'number', description: '滚动像素（默认 400）' },
        },
        ['direction'],
      ),
    },
  },
  {
    type: 'function',
    function: {
      name: 'press_key',
      description: '按键（如 Enter、Escape、Tab）。可带修饰键。',
      parameters: obj(
        {
          key: { type: 'string', description: '按键名，如 "Enter"' },
          modifiers: { type: 'array', items: { type: 'string' }, description: '修饰键：Control/Shift/Alt/Meta' },
        },
        ['key'],
      ),
    },
  },
  {
    type: 'function',
    function: {
      name: 'navigate_page',
      description: '导航当前标签页：打开 URL、后退、前进、刷新。',
      parameters: obj(
        {
          type: { type: 'string', enum: ['url', 'back', 'forward', 'reload'], description: '导航类型' },
          url: { type: 'string', description: 'type=url 时的目标地址' },
        },
        ['type'],
      ),
    },
  },
  {
    type: 'function',
    function: {
      name: 'wait_for',
      description:
        '等待页面达到某个条件。四种条件互斥，一次只传一个；等异步渲染完成用 idle，等 loading 消失用 gone。',
      parameters: obj({
        texts: {
          type: 'array', items: { type: 'string' },
          description: '任一文本出现即成功',
        },
        appear: { description: '等该 locator 的元素出现（语法同 query_page）' },
        gone: { description: '等该 locator 的元素消失（如 ".loading"）' },
        idle: { type: 'number', description: '等网络静默这么多毫秒（如 600）' },
        timeoutMs: { type: 'number', description: '超时，缺省 10000' },
      }),
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_pages',
      description: '列出当前所有打开的标签页（tabId、URL、标题、是否活动、是否为当前操作目标）。',
      parameters: obj({}),
    },
  },
  {
    type: 'function',
    function: {
      name: 'new_page',
      description: '打开新标签页并把它设为后续操作的目标。',
      parameters: obj(
        {
          url: { type: 'string', description: '要打开的地址' },
          background: { type: 'boolean', description: '是否后台打开（不夺焦，默认 false）' },
        },
        ['url'],
      ),
    },
  },
  {
    type: 'function',
    function: {
      name: 'close_page',
      description: '关闭指定标签页。若关闭的是当前操作目标，目标回落到启动标签。',
      parameters: obj({ tabId: { type: 'number', description: '要关闭的标签页 id（来自 list_pages）' } }, ['tabId']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'select_page',
      description: '切换到指定标签页并把它设为后续操作的目标。',
      parameters: obj({ tabId: { type: 'number', description: '目标标签页 id（来自 list_pages）' } }, ['tabId']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'take_screenshot',
      description:
        '截取当前操作目标标签页的可视区域截图，用于理解 a11y 快照看不到的内容（布局/图表/验证码等）。结果会作为图片消息呈现给你。',
      parameters: obj({
        format: { type: 'string', enum: ['jpeg', 'png'], description: '图片格式（默认 jpeg）' },
        quality: { type: 'number', description: 'jpeg 压缩质量 0~1（默认 0.7）' },
      }),
    },
  },
  {
    type: 'function',
    function: {
      name: 'evaluate_script',
      description: '在页面中执行一段 JavaScript 并返回结果（必须可 JSON 序列化）。函数体可用 await。',
      parameters: obj(
        {
          function: {
            type: 'string',
            description:
              "函数表达式字符串（可用 async），如 \"() => document.title\"",
          },
          args: { type: 'array', description: '传给该函数的参数（可选）', items: {} },
          world: { type: 'string', enum: ['main', 'isolated'], description: 'main=可访问页面变量（默认）；isolated=隔离。两者不共享状态' },
          timeoutMs: { type: 'number', description: '超时毫秒（默认 5000）' },
        },
        ['function'],
      ),
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_page',
      description:
        '按意图定向查询页面元素，只返回命中的几行（带 uid，可直接给 click/fill）。命中 0 个时返回诊断：relaxed 给出逐级放宽后的命中数、nearMiss 给出最像的候选、hint 给出改法，据此改 locator 再试。',
      parameters: obj(
        {
          locator: {
            // anyOf 三形状必须显式声明：无 type 约束时部分模型把语义对象/uid 序列化成
            // JSON 字符串上送，CS 侧虽已做防御解析，但正确形状从源头消除一次误分派。
            anyOf: [
              { type: 'string', description: 'CSS 选择器，如 "button.submit"' },
              { type: 'number', description: '元素 uid（来自最近一次快照或查询的 [uid]）' },
              {
                type: 'object',
                description: '语义对象：按角色与文本定位',
                properties: {
                  role: { type: 'string', description: 'button/link/textbox/combobox/checkbox/tab/heading 等 ARIA role' },
                  text: { type: 'string', description: '文本，默认包含匹配，exact:true 转精确' },
                  near: { type: 'string', description: '找该文本附近的元素（如 near:"密码" 配 role:"textbox"）' },
                  nth: { type: 'number', description: '命中多个时取第几个（0-based）' },
                  exact: { type: 'boolean', description: 'text 转精确匹配' },
                },
                additionalProperties: false,
              },
            ],
            description:
              '三形状之一：CSS 选择器字符串、元素 uid 数字，或语义对象（各形状的字段说明见对应分支）',
          },
          limit: { type: 'number', description: '最多返回几个，缺省 5，上限 20' },
          within: { type: 'number', description: '限定在该 uid 的容器内查找' },
        },
        ['locator'],
      ),
    },
  },
  {
    type: 'function',
    function: {
      name: 'http_request',
      description: '直接发起 HTTP 请求（带当前浏览器登录态 cookie）。用于调用接口、抓取数据。响应体截断至 64KB。',
      parameters: obj(
        {
          url: { type: 'string', description: '请求地址' },
          method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'], description: '方法（默认 GET）' },
          headers: {
            type: 'object',
            description: '请求头键值对（可选）',
            additionalProperties: { type: 'string' },
          },
          body: { type: 'string', description: '请求体（可选，字符串）' },
        },
        ['url'],
      ),
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_console_messages',
      description: '读取当前操作目标页面的 console 日志（含运行时错误），按时间倒序返回最近若干条。深度观测（CDP）未开启时返回空列表并附 hint（提示可用 toggle_deep_observe 开启）。',
      parameters: obj({
        level: { type: 'string', enum: ['log', 'info', 'warn', 'error', 'debug'], description: '只看某一级别（默认全部）' },
        limit: { type: 'number', description: '最多返回条数（默认 50，上限 200）' },
      }),
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_network_requests',
      description: '列出当前操作目标页面发生过的网络请求（摘要：方法/URL/状态/类型/耗时/是否带 body/wsFrameCount）；展开某条的请求头/响应体/WebSocket 帧用 get_network_request。深度观测未开启时只有 webRequest 元数据。',
      parameters: obj({
        method: { type: 'string', description: '按方法过滤（如 GET/POST，可选）' },
        urlContains: { type: 'string', description: '按 URL 子串过滤（可选）' },
        status: { type: 'number', description: '按状态码过滤（可选）' },
        limit: { type: 'number', description: '最多返回条数（默认 50）' },
      }),
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_network_request',
      description: '按 requestId 取单条网络请求的完整信息（含请求头/响应头/请求体/响应体，仅页面 JS 发起时被捕获）。WebSocket 条目没有 body，内容在 wsFrames（按时间顺序的收发帧，单帧截断 4096 字符）——摘要里 wsFrameCount>0 的就是这类。敏感头默认脱敏。深度观测未开启时响应体与请求头可能缺失。',
      parameters: obj({
        requestId: { type: 'string', description: '来自 list_network_requests' },
      }, ['requestId']),
    },
  },
  // ---- 深度观测（CDP）开关（设计 §4.1）：作用于当前操作目标页 ----
  {
    type: 'function',
    function: {
      name: 'toggle_deep_observe',
      description:
        '开启/关闭当前操作目标页面的「深度观测」（CDP/chrome.debugger 附着）。开启后才有全量响应体与请求头、WebSocket 帧、跨域 iframe 与 Worker 内请求，以及带调用堆栈的浏览器级控制台条目；代价是页面顶部出现 Chrome 的「正在调试此浏览器」提示条（用户可点取消关闭），且附着期间用户无法为该页打开 DevTools——已开 DevTools 时会开启失败。关闭后网络观测退回只有元数据、控制台不可用；关闭幂等。默认关闭。',
      parameters: obj(
        { enabled: { type: 'boolean', description: 'true = 开启；false = 关闭' } },
        ['enabled'],
      ),
    },
  },
  // ---- Phase 4：脚本池（19→25 见 schemas.test 注释；与 UI 共用 background/scripts 编排层）----
  {
    type: 'function',
    function: {
      name: 'list_scripts',
      description:
        '列出脚本库中的用户脚本摘要（不含代码体）。summary 含 errorCount（运行报错数，>0 时可主动向用户提议排查）、grantSupported/grantUnsupported（GM API 支持）与 lines/bytes：行数多时优先用 grep_script 定位或 get_script 按区间读，不要整份读回。update 来自后台定期检查缓存（不触发新检查）：hasUpdate=true 表示有可用更新、remoteVersion 为远端版本；无 update = 无更新源或尚未检查过；此时用 update_script 的 patch.applyUpdate 拉取最新。',
      parameters: obj({
        enabled: { type: 'boolean', description: '按启用状态过滤' },
        urlContains: { type: 'string', description: '匹配模式包含该子串（不区分大小写）' },
      }),
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_script',
      description:
        '读取单个用户脚本：完整 text（.user.js 原文）+ 解析投影 + totalLines。可选 offset/limit 读行区间（越界钳制），此时 text 为切片、startLine/endLine 为实际返回区间。每行带 `  12| ` 形式行号前缀——是标注不是文件内容，写回时不要带上。不传 offset/limit 时默认只返回前 200 行，notice 给出续读位置。',
      parameters: obj(
        {
          id: { type: 'string', description: '脚本 id' },
          offset: { type: 'number', description: '起始行（1-based，缺省 1）' },
          limit: { type: 'number', description: '行数（缺省读到末尾）' },
        },
        ['id'],
      ),
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep_script',
      description:
        '在用户脚本原文中检索（按正则；非法正则降级为字面量）；id 缺省时搜全库。返回命中行的 scriptId、脚本名、行号与带行号前缀的内容。',
      parameters: obj(
        {
          pattern: { type: 'string', description: '检索式（正则语法）' },
          id: { type: 'string', description: '限定脚本 id' },
          ignoreCase: { type: 'boolean', description: '忽略大小写（默认 false）' },
          contextLines: { type: 'number', description: '每处命中额外返回的上下文行数（默认 0）' },
          limit: { type: 'number', description: '最多返回行数（默认 50，超出置 truncated）' },
        },
        ['pattern'],
      ),
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_script',
      description:
        '创建用户脚本：以用户脚本权限在匹配规则命中的页面上自动运行。创建前先向用户说明脚本用途与作用范围。source 为完整 .user.js（@字段即配置、无独立名称/匹配参数，解析后须有 @match 或 pattern 形式的 @include），url 为直链（下载安装并记为更新源），二者选一。代码以页面脚本原样执行，无 GM_* API。source 上限 200 行 / 8192 字符。分步写：本次只交元数据头 + 未闭合的 IIFE 骨架（写到 `(function () {` 为止），再用 update_script 的 patch.append 追加代码体，末段带 `})();` 闭合；骨架提前闭合会让代码落到 IIFE 外。',
      parameters: obj(
        {
          source: { type: 'string', description: '完整 .user.js 文本（含 ==UserScript== 头）；与 url 二选一' },
          url: { type: 'string', description: '.user.js 直链（http/https），下载后安装；与 source 二选一' },
          enabled: { type: 'boolean', description: '创建后是否立即启用，默认 true' },
        },
        [],
      ),
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_script',
      description:
        '更新用户脚本。改头部字段（名称/匹配/时机等）就是改原文，没有独立字段可改。规则/代码更新在下次页面导航后生效。返回的 balance 是括号配平状态：分步过程中骨架未闭合时为 unclosed（正常），最后一段写完应为 ok；不为 ok 就用 grep_script 定位漏掉的括号再 replace 修正。',
      parameters: obj(
        {
          id: { type: 'string', description: '脚本 id' },
          patch: {
            type: 'object',
            description: '至少包含 applyUpdate / text / edit / append / replace / enabled 之一；四个文本分支互斥、一次一支，applyUpdate 优先',
            properties: {
              applyUpdate: { type: 'boolean', description: '从更新源（@updateURL/@downloadURL）拉取远端最新文本覆盖本地（含头部设置）——会覆盖本地修改，无更新源则报错' },
              text: { type: 'string', description: '整文替换：完整 .user.js 原文' },
              enabled: { type: 'boolean', description: '启停（独立，可与文本分支并存）' },
              edit: {
                type: 'object',
                description: '行区间替换（1-based 含端点，越界报错、不钳制；替换后整体重解析）',
                properties: {
                  startLine: { type: 'number', description: '起始行（1-based）' },
                  endLine: { type: 'number', description: '结束行（含端点）' },
                  text: { type: 'string', description: '替换文本（可多行）' },
                },
                required: ['startLine', 'endLine', 'text'],
              },
              append: { type: 'string', description: '追加到原文末尾（不需要行号）' },
              replace: {
                type: 'object',
                description: '字面量精确替换；old 需在原文中唯一',
                properties: {
                  old: { type: 'string', description: '被替换的原文片段（字面量）' },
                  new: { type: 'string', description: '替换为' },
                  all: { type: 'boolean', description: 'old 命中多处时全部替换（默认 false，否则报错）' },
                },
                required: ['old', 'new'],
              },
            },
          },
        },
        ['id', 'patch'],
      ),
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_script',
      description: '删除用户脚本（不可恢复）。',
      parameters: obj({ id: { type: 'string', description: '脚本 id' } }, ['id']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'toggle_script',
      description: '启用或禁用用户脚本。禁用后匹配页面不再注入，刷新页面生效。',
      parameters: obj(
        {
          id: { type: 'string', description: '脚本 id' },
          enabled: { type: 'boolean', description: 'true 启用 / false 禁用' },
        },
        ['id', 'enabled'],
      ),
    },
  },
  // ---- Skill（技能）：加载完整指令正文（spec §2.4 修订 2026-09-05）----
  {
    type: 'function',
    function: {
      name: 'load_skill',
      description:
        '按 command 加载一个「技能」的完整指令正文，再遵循正文行事。',
      parameters: obj(
        { command: { type: 'string', description: '技能的斜杠命令名（不含 /），来自系统提示的技能清单' } },
        ['command'],
      ),
    },
  },
  // ---- 技能池（spec §4）：AI 自己写技能。.md 全文为源，头部即配置——与脚本池同构 ----
  {
    type: 'function',
    function: {
      name: 'list_skills',
      description:
        '列出技能库中的技能摘要（不含正文）。系统提示里只列前 20 个技能，找未列出的用 query 模糊搜索（子串匹配 command/名字/简述，也支持缩写如 wscr）。写技能之前先调用它查重——已有同 command 或功能相近的技能时，先问用户「改写它还是另建一个」，不要默默建重叠的。contentChars 是正文字符数：超过 8000 说明改写要分步。',
      parameters: obj({
        enabled: { type: 'boolean', description: '按启用状态过滤' },
        query: { type: 'string', description: '模糊搜索关键词；缺省列出全部' },
      }),
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_skill',
      description:
        '读取单个技能的完整 .md 原文（--- frontmatter --- 三键 + Markdown 正文）。text 可整份复制、改好再喂回 update_skill 的 patch.text。',
      parameters: obj({ id: { type: 'string', description: '技能 id（来自 list_skills）' } }, ['id']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_skill',
      description:
        '创建一个用 /命令 触发、由 AI 在后续对话里遵循的指令正文。source 是完整 .md：frontmatter 三键 name（中文名）/ description（**什么时候该触发**，不是「它是什么」——日后唯一能触发它的依据，必填）/ command（kebab-case，小写字母数字连字符，全库唯一），其后是正文。source 上限 200 行 / 8192 字符。分步写：本次只交 frontmatter + 正文开头，再用 update_skill 的 patch.append 按小节追加。command 撞车会被拒绝（不静默覆盖），先 get_skill 读原文再改写，或换个 command。',
      parameters: obj(
        {
          source: { type: 'string', description: '完整技能 .md（frontmatter + 正文）' },
          enabled: { type: 'boolean', description: '创建后是否立即启用，默认 true' },
        },
        ['source'],
      ),
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_skill',
      description:
        '改写已有技能。改 name/description/command 就是改 frontmatter——没有独立字段可改，用 replace 或 text。返回 contentChars/totalChars：正文过短会带 warning 提示可能还没写完（技能正文无语法可校验，靠体量判断收尾）。',
      parameters: obj(
        {
          id: { type: 'string', description: '技能 id（来自 list_skills）' },
          patch: {
            type: 'object',
            description: '至少包含 text / append / replace / enabled 之一；三个文本分支互斥、一次一支',
            properties: {
              text: { type: 'string', description: '整文替换：完整 .md（frontmatter + 正文）' },
              append: { type: 'string', description: '追加到全文末尾（不需要原文）；分步写技能的主力' },
              replace: {
                type: 'object',
                description: '字面量精确替换；old 需在原文中唯一',
                properties: {
                  old: { type: 'string', description: '被替换的原文片段（字面量）' },
                  new: { type: 'string', description: '替换为' },
                  all: { type: 'boolean', description: 'old 命中多处时全部替换（默认 false，否则报错）' },
                },
                required: ['old', 'new'],
              },
              enabled: { type: 'boolean', description: '启停（独立，可与文本分支并存）' },
            },
          },
        },
        ['id', 'patch'],
      ),
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_skill',
      description:
        '删除技能（不可恢复）。删除前先跟用户确认——这是一次性、不可撤销的操作。内置技能（builtin）不可删除，会报错，如不需要可停用。',
      parameters: obj({ id: { type: 'string', description: '技能 id（来自 list_skills）' } }, ['id']),
    },
  },
  // ---- Memory（跨会话长期记忆，spec §3.4）----
  {
    type: 'function',
    function: {
      name: 'memory_list',
      description:
        '列出长期记忆（含未在系统提示里出现的其他站点记忆）。用途：① 写入前查重；② 导航到某站点【之前】提前取该站经验——系统提示只列当前页命中的记忆全文，其他站点只给站点清单。带 scope 时不返回全局记忆（全局记忆已常驻系统提示）。',
      parameters: obj({
        scope: { type: 'string', description: '完整 URL（精确匹配）或站点关键词如 bilibili（子串匹配）；缺省全库' },
        limit: { type: 'number', description: `返回条数上限，默认 ${30}，最大 100` },
      }),
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_write',
      description:
        '记录或改写一条长期记忆（跨会话持久保留）。传 id 时改写那一条：content 必传，matches 传了才改、不传保持原作用域。该记：用户偏好与习惯、某站点的固定操作路径、踩过的坑与解法、账号与环境的稳定事实；不该记：本轮中间结果、页面上随时会变的数字、临时数据。matches 留空会在任何页面注入——只在某站适用的经验务必填 matches，否则会误导你自己。写不下就拆成两条。',
      parameters: obj(
        {
          content: { type: 'string', description: '记忆正文，≤500 字符，一条只说一件事' },
          matches: {
            type: 'array',
            items: { type: 'string' },
            description: '站点作用域（Chrome match pattern）；留空 = 全局',
          },
          id: { type: 'string', description: '要改写的记忆 id（来自 [id …] 或 memory_list）；不传则新增' },
        },
        ['content'],
      ),
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_delete',
      description: '删除一条长期记忆。记忆过时或与新发现矛盾时，改写（memory_write 带 id）优先于删除。幂等：id 不存在也返回成功。',
      parameters: obj(
        { id: { type: 'string', description: '记忆 id（来自 [id …] 或 memory_list）' } },
        ['id'],
      ),
    },
  },
];
