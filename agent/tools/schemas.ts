// agent/tools/schemas.ts
// 16 个工具的 OpenAI function calling schema：Phase 2 的 9 个 + Phase 3a 的 7 个（tabs/screenshot/evaluate/http_request）。描述对齐 chrome-devtools-mcp。
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
        '获取当前页面的可访问性快照（带 [uid] 编号的元素树）。后续 click/fill 等操作用 uid 定位元素。页面变化后应重新调用。',
      parameters: obj({ verbose: { type: 'boolean', description: '是否输出更详细的树（默认 false）' } }),
    },
  },
  {
    type: 'function',
    function: {
      name: 'click',
      description: '点击快照中 uid 指定的元素。可选双击、可选点击后自动附带新快照。',
      parameters: obj(
        {
          uid: { type: 'number', description: '来自最近一次 take_snapshot 的元素 uid' },
          dblClick: { type: 'boolean', description: '是否双击' },
          includeSnapshot: { type: 'boolean', description: '点击后是否返回新快照（默认 false）' },
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
];
