/** 仿真侧边栏的演出脚本。
 *
 * 一个场景 = 一串 beat，按 wait 依次执行：用户消息 → reasoning 流 → 工具卡 → 正文流 → 改右侧页面。
 * 工具名、参数形状、结果摘要都取产品里真实存在的那套（27 工具 / patch.append / balance），
 * 不编造不存在的能力——宣传页里的假 API 是最容易被一眼看穿的破绽。
 */

export type PageMutation =
  | { type: 'drop'; ids: string[] }
  | { type: 'zoom' }
  | { type: 'read-badge' }
  /** 直接操控的结果：把指定卡片标成已收藏（不经脚本，是 click 工具真点出来的） */
  | { type: 'save'; ids: string[] }
  | { type: 'reset' };

export type Beat =
  /** 用户气泡（整条直接出现，人打字不需要演） */
  | { at: number; kind: 'user'; text: string }
  /** 思考流，逐字 */
  | { at: number; kind: 'reasoning'; text: string }
  /** 工具卡：先 running，dur 毫秒后转 ok 并显示结果摘要 */
  | { at: number; kind: 'tool'; name: string; args: string; result: string; dur: number }
  /** 助手正文流，逐字 */
  | { at: number; kind: 'text'; text: string }
  /** 改右侧仿真页面 */
  | { at: number; kind: 'page'; mutation: PageMutation };

export interface Scenario {
  id: string;
  /** 输入框上方的 tag 文案，也是这条会话的用户消息 */
  tag: string;
  /** 页眉会话抽屉里的短名（真实产品按首条消息命名会话，这里同理） */
  title: string;
  beats: Beat[];
}

export const SCENARIOS: Scenario[] = [
  {
    // 这条刻意不写脚本：产品的两条路里，「现在就替你做完」这条同样是主线能力。
    // 收尾那句点出取舍——一次性的活儿不该留一个常驻脚本。
    id: 'act-now',
    title: '加进稍后读',
    tag: '把前三条加进稍后读',
    beats: [
      { at: 0, kind: 'user', text: '把前三条加进稍后读' },
      { at: 260, kind: 'reasoning', text: '这是一次性的操作，直接点就行，不用写脚本。先取快照拿到每条的收藏按钮。' },
      {
        at: 2100,
        kind: 'tool',
        name: 'take_snapshot',
        args: '{ }',
        result: '38 节点 · 6 条 article，各含 button[稍后读]',
        dur: 900,
      },
      {
        at: 3300,
        kind: 'reasoning',
        text: 'uid 到手：e12 / e19 / e26。逐条点，点完看状态有没有真的变，免得点空。',
      },
      {
        at: 5400,
        kind: 'tool',
        name: 'click',
        args: '{ uid: "e12" }',
        result: '已点击 · aria-pressed 转 true',
        dur: 620,
      },
      { at: 5900, kind: 'page', mutation: { type: 'save', ids: ['p1'] } },
      {
        at: 6300,
        kind: 'tool',
        name: 'click',
        args: '{ uid: "e19" }',
        result: '已点击 · aria-pressed 转 true',
        dur: 620,
      },
      { at: 6800, kind: 'page', mutation: { type: 'save', ids: ['a1'] } },
      {
        at: 7200,
        kind: 'tool',
        name: 'click',
        args: '{ uid: "e26" }',
        result: '已点击 · aria-pressed 转 true',
        dur: 620,
      },
      { at: 7700, kind: 'page', mutation: { type: 'save', ids: ['p2'] } },
      {
        at: 8100,
        kind: 'text',
        text: '前三条都进稍后读了。这次是直接替你点的，没写脚本——一次性的活儿不值当留一个常驻脚本。如果你想每次打开都自动收藏某类文章，我再写成 `.user.js` 挂上去。',
      },
    ],
  },
  {
    id: 'drop-ads',
    title: '去掉推广位',
    tag: '帮我去掉信息流里的推广卡片',
    beats: [
      { at: 0, kind: 'user', text: '帮我去掉信息流里的推广卡片' },
      { at: 260, kind: 'reasoning', text: '先看页面结构，确认推广卡片和正常条目怎么区分。' },
      {
        at: 1500,
        kind: 'tool',
        name: 'take_snapshot',
        args: '{ }',
        result: '38 节点 · 命中 6 个 article[data-slot]',
        dur: 900,
      },
      {
        at: 2760,
        kind: 'reasoning',
        text: '两条赞助位带 data-slot="promo"，正常条目是 data-slot="post"，用属性选择器就够，不必碰文案。',
      },
      {
        at: 5100,
        kind: 'tool',
        name: 'create_script',
        args: '{ source: "// ==UserScript==\\n// @name 信息流去推广 …" }',
        result: 'id: us_7fa2 · 14 行 · balance: unclosed',
        dur: 1000,
      },
      {
        at: 6400,
        kind: 'tool',
        name: 'update_script',
        args: '{ patch: { append: "  })();" } }',
        result: '21 行 · balance: ok',
        dur: 760,
      },
      {
        at: 7500,
        kind: 'tool',
        name: 'toggle_script',
        args: '{ id: "us_7fa2", enabled: true }',
        result: '已注入 · 匹配 2 个标签页',
        dur: 700,
      },
      { at: 8460, kind: 'page', mutation: { type: 'drop', ids: ['a1', 'a2'] } },
      {
        at: 8560,
        kind: 'text',
        text: '两条赞助位已经摘掉了。脚本按 `data-slot="promo"` 匹配，不依赖文案，所以换一批广告也照样管用。它已存进脚本池，下次打开这个站点会自动生效。',
      },
    ],
  },
  {
    id: 'zoom-thumb',
    title: '缩略图放大',
    tag: '缩略图悬停时放大看',
    beats: [
      { at: 0, kind: 'user', text: '缩略图悬停时放大看' },
      { at: 240, kind: 'reasoning', text: '这类视觉增强不用碰 JS 事件，注一段 CSS 更稳。' },
      {
        at: 1300,
        kind: 'tool',
        name: 'take_snapshot',
        args: '{ }',
        result: '缩略图容器 .thumb · 6 个实例',
        dur: 800,
      },
      {
        at: 2400,
        kind: 'reasoning',
        text: '卡片有 overflow 裁切，放大得让缩略图自己升一层 z-index，否则会被邻居盖住。',
      },
      {
        at: 4500,
        kind: 'tool',
        name: 'create_script',
        args: '{ source: "…GM_addStyle(`.thumb:hover{transform:scale(1.6)}`)" }',
        result: 'id: us_31c8 · 17 行 · balance: ok',
        dur: 950,
      },
      {
        at: 5760,
        kind: 'tool',
        name: 'toggle_script',
        args: '{ id: "us_31c8", enabled: true }',
        result: '已注入 · @grant GM_addStyle',
        dur: 680,
      },
      { at: 6700, kind: 'page', mutation: { type: 'zoom' } },
      {
        at: 6800,
        kind: 'text',
        text: '好了，把鼠标移到右边任意一张缩略图上试试。用 `GM_addStyle` 注的样式，transform 走 GPU，滚动时不掉帧。',
      },
    ],
  },
  {
    id: 'read-time',
    title: '阅读时长',
    tag: '每条标题前加上阅读时长',
    beats: [
      { at: 0, kind: 'user', text: '每条标题前加上阅读时长' },
      { at: 240, kind: 'reasoning', text: '页面上没有现成字数，得算。先看有没有接口能直接给。' },
      {
        at: 1320,
        kind: 'tool',
        name: 'list_network_requests',
        args: '{ resourceTypes: ["xhr", "fetch"] }',
        result: 'GET /api/feed?page=1 · 200 · 6 项',
        dur: 880,
      },
      {
        at: 2500,
        kind: 'tool',
        name: 'get_network_request',
        args: '{ reqid: 4 }',
        result: '响应体含 word_count 字段',
        dur: 760,
      },
      {
        at: 3660,
        kind: 'reasoning',
        text: '接口自带 word_count，直接读比数 DOM 文本准。按每分钟 400 字折算，插在标题前。',
      },
      {
        at: 6100,
        kind: 'tool',
        name: 'create_script',
        args: '{ source: "// @name 信息流阅读时长 …" }',
        result: 'id: us_9d40 · 23 行 · balance: ok',
        dur: 980,
      },
      {
        at: 7400,
        kind: 'tool',
        name: 'toggle_script',
        args: '{ id: "us_9d40", enabled: true }',
        result: '已注入 · 匹配 2 个标签页',
        dur: 700,
      },
      { at: 8360, kind: 'page', mutation: { type: 'read-badge' } },
      {
        at: 8460,
        kind: 'text',
        text: '徽标进去了，数字取接口的 `word_count` 按 400 字/分钟折算。脚本挂了 `MutationObserver`，翻页加载的新条目也会补上。',
      },
    ],
  },
];
