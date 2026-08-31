// agent/tools/schemas.ts
// 9 个 Phase 2 工具的 OpenAI function calling schema（设计 §4）。描述对齐 chrome-devtools-mcp。
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
];
