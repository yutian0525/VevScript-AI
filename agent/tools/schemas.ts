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
        '获取页面内容树，每行带 [uid]，用 uid 做 click/fill/hover。默认 detail="interactive"：只出可交互元素、标题与视口内文本，容器折叠为「… [N 个未展开节点]」计数行（体量约为全量的一半）。需要完整文本时用 detail="full"；只关心某个区域时用 region 限定（比 full 便宜得多）。已知目标是什么时，优先用 query_page 定向查询而非倒整棵树。注意 uid 定位到元素，同一元素下多行文本共享同一 uid（非逐行唯一）；隐藏子菜单聚合在父节点 description 里，要操作需先 hover 展开再重新快照。穿透同源 iframe；跨域 iframe 内容无法读取，返回值的 skippedFrames 会计数。页面变化后 uid 失效，需重新调用。',
      parameters: obj({
        detail: {
          type: 'string',
          enum: ['interactive', 'full'],
          description: '详细档位。缺省 interactive（推荐）；full 为全量含所有文本',
        },
        region: {
          description: '限定子树：元素 uid（数字）或 CSS 选择器（字符串，仅主帧）。传了则只倒该容器内部',
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
        '等待页面达到某个条件。四种条件互斥，一次只传一个：texts（任一文本出现）、appear（元素出现）、gone（元素消失，等 loading 消失用这个）、idle（网络静默指定毫秒，等异步渲染完成用这个）。',
      parameters: obj({
        texts: {
          type: 'array', items: { type: 'string' },
          description: '任一文本出现即成功',
        },
        appear: { description: '等该 locator 的元素出现。locator 语法同 query_page' },
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
        '截取当前操作目标标签页的可视区域截图，供你用视觉理解页面（布局/图表/验证码等 a11y 快照看不到的内容）。截图会作为图片消息呈现给你。',
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
      description: '在页面中执行一段 JavaScript 并返回其结果（必须可 JSON 序列化）。用于读取 a11y 快照无法覆盖的深层数据、在页内做一次多步操作，或对多个元素做同型重复操作（页内循环一次完成，避免逐元素 click/fill 往返）。函数体可用 await；注意 main world 与 isolated world 各自独立，页面 JS 变量只在 main world 可见。响应慢的页面操作可配合 wait_for 使用。',
      parameters: obj(
        {
          function: {
            type: 'string',
            description:
              "一个函数表达式字符串，如 \"() => document.title\" 或 \"async () => { const el = document.querySelector('.item'); return el?.textContent; }\"",
          },
          args: { type: 'array', description: '传给该函数的参数（可选）', items: {} },
          world: { type: 'string', enum: ['main', 'isolated'], description: 'main=可访问页面变量（默认），isolated=隔离环境' },
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
        '按意图定向查询页面元素，只返回命中的几行（带 uid，可直接给 click/fill）。比 take_snapshot 便宜得多——已知要找什么时优先用它。命中 0 个时返回诊断：relaxed 给出逐级放宽后的命中数、nearMiss 给出最像的候选、hint 给出改法，据此改 locator 再试。',
      parameters: obj(
        {
          locator: {
            // anyOf 三形状必须显式声明：无 type 约束时部分模型把语义对象/uid 序列化成
            // JSON 字符串上送，CS 侧虽已做防御解析，但正确形状从源头消除一次误分派。
            anyOf: [
              { type: 'string', description: 'CSS 选择器，如 "button.submit" / "a"' },
              { type: 'number', description: '元素 uid（来自最近一次 take_snapshot / query_page 的 [uid]）' },
              {
                type: 'object',
                description: '语义对象：按角色与文本定位',
                properties: {
                  role: { type: 'string', description: 'button/link/textbox/combobox/checkbox/tab/heading 等' },
                  text: { type: 'string', description: '文本，默认包含匹配，exact:true 转精确' },
                  near: { type: 'string', description: '找"该文本附近"的元素（如 { role:"textbox", near:"密码" }）' },
                  nth: { type: 'number', description: '命中多个时取第几个（0-based）' },
                  exact: { type: 'boolean', description: 'text 转精确匹配' },
                },
                additionalProperties: false,
              },
            ],
            description:
              '三形状之一：CSS 选择器字符串；元素 uid 数字；语义对象 { role, text, near, nth, exact }。role 如 button/link/textbox/combobox/checkbox/tab/heading；text 默认包含匹配，exact:true 转精确；near 找"该文本附近"的元素（如 { role:"textbox", near:"密码" }）；nth 命中多个时取第几个（0-based）',
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
      description: '读取当前操作目标页面的 console 日志（含 console.log/info/warn/error/debug 与运行时错误）。用于诊断页面报错、观察脚本输出。返回按时间倒序的最近若干条。深度观测（CDP）未开启时返回空列表并附 hint，可按提示用 toggle_deep_observe 开启。',
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
      description: '列出当前操作目标页面发生过的网络请求（摘要：方法/URL/状态/类型/耗时/是否有 body/wsFrameCount）。用于观察页面调了哪些接口。要看某条的请求头/响应体/WebSocket 帧，用 get_network_request。深度观测未开启时只有 webRequest 元数据（无响应体与请求头）。',
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
      description: '按 requestId 取单条网络请求的完整信息（含请求头/响应头/请求体/响应体，若页面 JS 发起时被捕获）。requestId 来自 list_network_requests。WebSocket 条目没有 body，内容在 wsFrames（按时间顺序的收发帧，含方向/opcode/payload，单帧截断 4096 字符）；摘要里 wsFrameCount>0 的条目就是这类，值得用本工具展开看。敏感头默认脱敏。深度观测未开启时响应体与请求头可能缺失（附 hint 说明）。',
      parameters: obj({
        requestId: { type: 'string', description: '来自 list_network_requests 的 requestId' },
      }, ['requestId']),
    },
  },
  // ---- 深度观测（CDP）开关（设计 §4.1）：作用于当前操作目标页 ----
  {
    type: 'function',
    function: {
      name: 'toggle_deep_observe',
      description:
        '开启或关闭当前操作目标页面的「深度观测」（CDP/chrome.debugger 附着），方向由 enabled 决定。开启后能拿到完整网络观测（全量响应体、含浏览器自动头的完整请求/响应头、WebSocket 帧、跨域 iframe 与 Web Worker 内的请求）与完整控制台（带调用堆栈、CSP 违规等浏览器级条目）；代价是页面顶部会出现 Chrome 的「正在调试此浏览器」提示条（用户可点取消关闭），且附着期间用户无法为该页打开 DevTools——若用户已打开 DevTools 会开启失败。关闭后网络观测退回只有元数据（无响应体与请求头）、控制台观测不可用；关闭是幂等的。默认关闭。当 list_console_messages 返回空或 get_network_request 提示缺 body/headers 时，可传 enabled=true 开启。',
      parameters: obj(
        { enabled: { type: 'boolean', description: 'true = 开启深度观测；false = 关闭' } },
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
        '列出脚本库中的用户脚本摘要（不含代码体）。enabled 按启用状态过滤；urlContains 按匹配模式子串过滤（大小写不敏感）。summary 含 errorCount（脚本运行报错条数，>0 时可主动向用户提议排查）与 grantSupported/grantUnsupported（GM API 支持状态）。update 字段来自后台定期检查的缓存（不会触发新检查）：update.hasUpdate=true 表示有可用更新、update.remoteVersion 为远端版本；无 update 字段 = 该脚本无更新源或后台尚未检查过。要更新脚本用 update_script 并传 patch.applyUpdate=true（会即时拉取远端最新覆盖，无需先检查）。需要完整代码时用 get_script。summary 含 lines/bytes（脚本规模）：行数多时优先用 grep_script 定位或 get_script 按区间读，不要整份读回。',
      parameters: obj({
        enabled: { type: 'boolean', description: '按启用状态过滤' },
        urlContains: { type: 'string', description: '匹配模式包含该子串（大小写不敏感）' },
      }),
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_script',
      description:
        '读取单个用户脚本：完整 text（.user.js 原文）+ 解析投影 + totalLines 总行数。可选 offset/limit 读取行区间（1-based 含端点，越界自动钳制；limit 缺省读到末尾），此时 script.text 为切片、startLine/endLine 为实际返回区间。id 来自 list_scripts。返回的每行带 `  12| ` 形式的行号前缀（右对齐 4 位）——它是标注不是文件内容，写回时不要带上。不传 offset/limit 时默认只返回前 200 行并在 notice 里给出续读位置；定位特定代码用 grep_script 更省上下文。',
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
        '在用户脚本原文中检索（按正则；非法正则自动降级为字面量子串）。id 缺省时搜全库（脚本库全部脚本）——可用来回答「哪个脚本动了这个选择器/接口」。返回命中行的 scriptId、脚本名、行号与带行号前缀的内容。用于在不整份读回长脚本的前提下定位代码，配合 update_script 的 patch.replace 做精确改写。',
      parameters: obj(
        {
          pattern: { type: 'string', description: '检索式（正则语法；非法时按字面量处理）' },
          id: { type: 'string', description: '限定单个脚本 id；缺省搜全库' },
          ignoreCase: { type: 'boolean', description: '忽略大小写（默认 false）' },
          contextLines: { type: 'number', description: '每处命中额外返回的上下文行数（默认 0）' },
          limit: { type: 'number', description: '最多返回行数（默认 50，超出时 truncated=true）' },
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
        '创建用户脚本：以浏览器用户脚本权限在头部匹配规则命中的页面上自动运行。创建前先向用户说明脚本用途与作用范围。两种来源二选一：source=完整的 .user.js 文本（含 ==UserScript== 元数据头，头部 @字段即配置：@name/@match/@include/@run-at/@world/@grant，无独立名称/匹配参数），或 url=.user.js 直链（下载安装，自动记录为更新源以便日后检查更新）。代码以页面脚本方式原样执行，无 GM_* API。source 方式解析后须有匹配规则（@match 或 pattern 形式的 @include）。source 有长度上限（200 行 / 8192 字符）：超限会被拒绝。写长脚本请分步——本次只提交元数据头 + 未闭合的 IIFE 骨架（写到 `(function () {` 为止，不要写 `})();`），再用 update_script 的 patch.append 分次追加代码体，最后一段带上 `})();` 闭合。骨架若提前闭合，后续追加的代码会落到 IIFE 外的全局作用域。',
      parameters: obj(
        {
          source: { type: 'string', description: '完整 .user.js 文本（含 ==UserScript== 元数据头）。与 url 二选一' },
          url: { type: 'string', description: '.user.js 脚本直链（http/https），下载后安装。与 source 二选一' },
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
        '更新用户脚本。patch 至少一项：applyUpdate 从脚本更新源（@updateURL/@downloadURL）拉取远端最新文本并覆盖本地（含代码与头部设置，会覆盖本地修改；脚本无更新源则报错——常用于 list_scripts 显示 update.hasUpdate 后应用更新，也可不经检查直接拉最新）；text 整文替换（完整 .user.js 原文，重新解析头部）；edit 行区间替换（1-based 含端点，越界报错，替换后整体重解析）；enabled 启停。applyUpdate 与各文本分支互斥且优先。改头部字段（名称/匹配/时机等）就是改原文，没有独立字段可改。规则/代码更新在下次页面导航后生效。append 追加到原文末尾（不需要行号，分步写脚本的主力）；replace 按字面量精确替换 {old,new,all?}（不依赖行号，old 必须在原文中唯一，命中多处会报错并列出行号，可加上下文让它唯一或传 all:true）。text/edit/append/replace 四支互斥，一次只能传一支。返回里的 balance 是括号配平状态：分步过程中骨架未闭合时为 unclosed（正常），最后一段写完应为 ok；若不为 ok 就用 grep_script 定位漏掉的括号再 replace 修正。',
      parameters: obj(
        {
          id: { type: 'string', description: '脚本 id' },
          patch: {
            type: 'object',
            description: '至少包含 applyUpdate / text / edit / append / replace / enabled 之一；四个文本分支互斥',
            properties: {
              applyUpdate: { type: 'boolean', description: '从更新源拉取远端最新文本覆盖本地（与 text/edit 互斥，优先生效）' },
              text: { type: 'string', description: '整文替换：完整 .user.js 原文' },
              enabled: { type: 'boolean', description: '启停' },
              edit: {
                type: 'object',
                description: '行区间替换（在当前原文上 splice 后整体重解析）',
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
                description: '字面量精确替换（不依赖行号）；old 需在原文中唯一',
                properties: {
                  old: { type: 'string', description: '要被替换的原文片段（字面量，非正则）' },
                  new: { type: 'string', description: '替换为' },
                  all: { type: 'boolean', description: 'old 命中多处时全部替换（默认 false，多处则报错）' },
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
        '按 command 加载一个「技能」的完整指令正文并据此执行。系统提示里列出的可用技能只有简述；当用户以 /command 触发某技能，或当前任务与某技能明显匹配时，先调用本工具取回它的完整正文，再遵循正文行事。command 即技能的斜杠命令名（不含 /），如 frontend-design。',
      parameters: obj(
        { command: { type: 'string', description: '技能的斜杠命令名（不含 /），来自系统提示中的可用技能清单' } },
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
        '列出技能库中的技能摘要（不含正文）。写技能之前先调用它查重——已有同 command 或功能相近的技能时，先问用户「改写它还是另建一个」，不要默默建重叠的。contentChars 是正文字符数：超过 8000 说明改写要分步。',
      parameters: obj({
        enabled: { type: 'boolean', description: '按启用状态过滤' },
      }),
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_skill',
      description:
        '读取单个技能的完整 .md 原文（--- frontmatter --- 三键 + Markdown 指令正文）。改写技能前先读它——update_skill 的 patch.replace 需要原文里的字面量，凭空写会写不准。返回的 text 是完整 .md，可直接整份复制、改好再喂回 update_skill 的 patch.text。id 来自 list_skills。',
      parameters: obj({ id: { type: 'string', description: '技能 id（来自 list_skills）' } }, ['id']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_skill',
      description:
        '创建一个技能：一段用 /命令 触发、由 AI 在后续对话里遵循的指令正文。写之前先向用户说明技能会做什么、什么时候触发，等用户点头再动手；先 list_skills 查重。source 是完整的 .md：frontmatter 三键 name（中文名）/ description（**什么时候该触发**，不是「它是什么」——这是日后唯一能触发它的依据，必填）/ command（kebab-case，小写字母数字连字符，全库唯一），其后是 Markdown 正文。source 有长度上限（200 行 / 8192 字符）：超限会被拒绝。写长技能请分步——本次只交 frontmatter + 正文开头，再用 update_skill 的 patch.append 按小节逐段追加。command 撞车会被拒绝（不静默覆盖），用 get_skill 读原文后 update_skill 改写，或换个 command。',
      parameters: obj(
        {
          source: { type: 'string', description: '完整技能 .md 文本（--- frontmatter --- + Markdown 正文）' },
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
        '改写已有技能。patch 至少一项，三个文本分支互斥（一次只能传一支）：append 追加到全文末尾（= 正文末尾，分步写技能的主力，不需要原文）；replace 按字面量精确替换 {old,new,all?}（不依赖行号，old 必须在原文中唯一，命中多处会报错并列出行号——先用 get_skill 确认原文）；text 整文替换（完整 .md，重新解析 frontmatter）；enabled 启停（独立，可与文本分支并存）。改 name/description/command 就是改 frontmatter——没有独立字段可改，用 replace 或 text。返回 contentChars/totalChars：正文过短会带 warning 提示可能还没写完（技能正文是自然语言，没有语法可校验，靠体量自己判断收尾）。',
      parameters: obj(
        {
          id: { type: 'string', description: '技能 id（来自 list_skills）' },
          patch: {
            type: 'object',
            description: '至少包含 text / append / replace / enabled 之一；三个文本分支互斥',
            properties: {
              text: { type: 'string', description: '整文替换：完整的技能 .md（--- frontmatter --- + 正文）' },
              append: { type: 'string', description: '追加到全文末尾（= 正文末尾，不需要原文）；分步写技能的主力' },
              replace: {
                type: 'object',
                description: '字面量精确替换（不依赖行号）；old 需在原文中唯一',
                properties: {
                  old: { type: 'string', description: '要被替换的原文片段（字面量，非正则）' },
                  new: { type: 'string', description: '替换为' },
                  all: { type: 'boolean', description: 'old 命中多处时全部替换（默认 false，多处则报错）' },
                },
                required: ['old', 'new'],
              },
              enabled: { type: 'boolean', description: '启停' },
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
        '列出长期记忆（含未在系统提示里出现的其他站点记忆）。用途：① 写入前查重，避免记两条矛盾的；② 导航到某站点【之前】提前取该站经验——系统提示只会列出当前页命中的记忆全文，其他站点只给站点清单。scope 可传完整 URL（精确匹配作用域）或站点关键词如 bilibili（对作用域做子串匹配）；不传 scope 则返回全库。注意：带 scope 时不返回全局记忆，因为全局记忆已常驻在系统提示里。',
      parameters: obj({
        scope: { type: 'string', description: '完整 URL 或站点关键词；缺省返回全库' },
        limit: { type: 'number', description: `返回条数上限，默认 ${30}，最大 100` },
      }),
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_write',
      description:
        '记录或改写一条长期记忆（跨会话持久保留）。不传 id = 新增；传 id = 改写那一条（content 必传；matches 传了才改、不传保持原作用域）。该记：用户的偏好与习惯、某站点的固定操作路径、踩过的坑与解法、账号与环境的稳定事实。不该记：本轮的中间结果、页面上随时会变的数字、马上就用完的临时数据。matches 是站点作用域（Chrome match pattern，如 *://*.bilibili.com/*），留空则为全局记忆、任何页面都会注入——只在某站适用的经验务必填 matches，否则会在别的站误导你自己。正文上限 500 字符，写不下就拆成两条。',
      parameters: obj(
        {
          content: { type: 'string', description: '记忆正文，≤500 字符，一条只说一件事' },
          matches: {
            type: 'array',
            items: { type: 'string' },
            description: '站点作用域（Chrome match pattern）。留空 = 全局记忆',
          },
          id: { type: 'string', description: '要改写的记忆 id（来自系统提示的 [id …] 或 memory_list）；不传则新增' },
        },
        ['content'],
      ),
    },
  },
  {
    type: 'function',
    function: {
      name: 'memory_delete',
      description: '删除一条长期记忆。记忆过时或与新发现矛盾时，改写（memory_write 带 id）优先于删除；确认无用再删。幂等：id 不存在也返回成功。',
      parameters: obj(
        { id: { type: 'string', description: '记忆 id（来自系统提示的 [id …] 或 memory_list）' } },
        ['id'],
      ),
    },
  },
];
