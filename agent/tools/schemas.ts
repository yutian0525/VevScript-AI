// agent/tools/schemas.ts
// 25 个工具的 OpenAI function calling schema：Phase 2 的 9 个 + Phase 3a 的 7 个（tabs/screenshot/evaluate/http_request）+ Phase 3b 的 3 个（console/network 观测）+ Phase 4 的 6 个（脚本池）。描述对齐 chrome-devtools-mcp。
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
        '获取当前页面的完整内容树：根为 RootWebArea，含所有可见元素与文本（StaticText）行，每行带 [uid]。用 uid 做 click/fill/hover。注意 uid 定位到可点击元素，同一元素下多行文本可能共享同一 uid（非逐行唯一）。隐藏子菜单聚合在父节点的 description 里，要操作需先 hover 展开再重新 take_snapshot。页面变化后 uid 会失效，需重新调用。',
      parameters: obj({}),
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
      description: '等待页面出现指定文本（轮询）。命中任一文本即返回。',
      parameters: obj(
        {
          texts: { type: 'array', items: { type: 'string' }, description: '要等待的文本（命中任一即可）' },
          timeoutMs: { type: 'number', description: '超时毫秒（默认 10000）' },
        },
        ['texts'],
      ),
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
      description: '在页面中执行一段 JavaScript 并返回其结果（必须可 JSON 序列化）。用于读取 a11y 快照无法覆盖的深层数据。',
      parameters: obj(
        {
          function: {
            type: 'string',
            description:
              "一个函数表达式字符串，如 \"() => document.title\" 或 \"() => document.querySelectorAll('a').length\"",
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
      description: '读取当前操作目标页面的 console 日志（含 console.log/info/warn/error/debug 与运行时错误）。用于诊断页面报错、观察脚本输出。返回按时间倒序的最近若干条。',
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
      description: '列出当前操作目标页面发生过的网络请求（摘要：方法/URL/状态/类型/耗时/是否有 body）。用于观察页面调了哪些接口。要看某条的请求头/响应体，用 get_network_request。',
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
      description: '按 requestId 取单条网络请求的完整信息（含请求头/响应头/请求体/响应体，若页面 JS 发起时被捕获）。requestId 来自 list_network_requests。敏感头默认脱敏。',
      parameters: obj({
        requestId: { type: 'string', description: '来自 list_network_requests 的 requestId' },
      }, ['requestId']),
    },
  },
  // ---- Phase 4：脚本池（19→25 见 schemas.test 注释；与 UI 共用 background/scripts 编排层）----
  {
    type: 'function',
    function: {
      name: 'list_scripts',
      description:
        '列出脚本库中的用户脚本摘要（不含代码体）。enabled 按启用状态过滤；urlContains 按匹配模式子串过滤（大小写不敏感）。summary 含 errorCount（脚本运行报错条数，>0 时可主动向用户提议排查）与 grantSupported/grantUnsupported（GM API 支持状态）。update 字段来自后台定期检查的缓存（不会触发新检查）：update.hasUpdate=true 表示有可用更新、update.remoteVersion 为远端版本；无 update 字段 = 该脚本无更新源或后台尚未检查过。要更新脚本用 update_script 并传 patch.applyUpdate=true（会即时拉取远端最新覆盖，无需先检查）。需要完整代码时用 get_script。',
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
        '读取单个用户脚本：完整 text（.user.js 原文）+ 解析投影 + totalLines 总行数。可选 offset/limit 读取行区间（1-based 含端点，越界自动钳制；limit 缺省读到末尾），此时 script.text 为切片、startLine/endLine 为实际返回区间。id 来自 list_scripts。',
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
      name: 'create_script',
      description:
        '创建用户脚本：以浏览器用户脚本权限在头部匹配规则命中的页面上自动运行。创建前先向用户说明脚本用途与作用范围。两种来源二选一：source=完整的 .user.js 文本（含 ==UserScript== 元数据头，头部 @字段即配置：@name/@match/@include/@run-at/@world/@grant，无独立名称/匹配参数），或 url=.user.js 直链（下载安装，自动记录为更新源以便日后检查更新）。代码以页面脚本方式原样执行，无 GM_* API。source 方式解析后须有匹配规则（@match 或 pattern 形式的 @include）。',
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
        '更新用户脚本。patch 至少一项：applyUpdate 从脚本更新源（@updateURL/@downloadURL）拉取远端最新文本并覆盖本地（含代码与头部设置，会覆盖本地修改；脚本无更新源则报错——常用于 list_scripts 显示 update.hasUpdate 后应用更新，也可不经检查直接拉最新）；text 整文替换（完整 .user.js 原文，重新解析头部）；edit 行区间替换（1-based 含端点，越界报错，替换后整体重解析）；enabled 启停。applyUpdate 与 text/edit 互斥且优先。改头部字段（名称/匹配/时机等）就是改原文，没有独立字段可改。规则/代码更新在下次页面导航后生效。',
      parameters: obj(
        {
          id: { type: 'string', description: '脚本 id' },
          patch: {
            type: 'object',
            description: '至少包含 applyUpdate / text / enabled / edit 之一',
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
];
