import { ArrowRight, Download } from 'lucide-react';
import { GithubMark } from '../components/Logo';
import { RichText } from '../components/RichText';
import { REPO, RELEASES } from '../router';

/** 文档页：项目介绍 / 快速上手 / GM API 说明 / Tools 介绍，左内容右侧粘性锚点目录。 */
export function Docs() {
  return (
    <div className="shell docs">
      <div className="docs__grid">
        <div className="docs__body">
          <span className="eyebrow">Documentation</span>
          <h1 className="h-section docs__h" style={{ marginTop: 14 }}>
            使用文档
          </h1>
          <p className="lede" style={{ maxWidth: '60ch' }}>
            涵盖项目概述、安装配置、GM_* API 参考与内置工具清单，供快速了解功能范围与使用方式。
          </p>

          {/* ---------- 项目介绍 ---------- */}
          <section className="doc-sec" id="intro">
            <span className="doc-sec__k">01</span>
            <h2 className="h-card doc-sec__h">项目介绍</h2>
            <p className="doc-p">
              <RichText text="织雀AI脚本（Vevscript-ai）是一款基于 Chrome 侧边栏的 AI 浏览器自动化扩展。用户以自然语言描述需求，扩展通过 accessibility 快照（uid 树）、截图、控制台与网络观测感知当前页面，再执行点击、填写、翻页等操作，完成一次性任务。" />
            </p>
            <p className="doc-p">
              <RichText text="对于重复性需求，扩展可将其生成为用户脚本并纳入脚本池，由 `chrome.userScripts` 在匹配页面加载时自动注入运行，无需再次打开侧边栏。AI 生成的脚本与手写脚本一致，共享同一套 GM_* API 与页面观测能力。" />
            </p>
            <div className="doc-cards">
              {INTRO.map((c) => (
                <div className="doc-card" key={c.t}>
                  <h3 className="doc-card__t">{c.t}</h3>
                  <p className="doc-card__d">
                    <RichText text={c.d} />
                  </p>
                </div>
              ))}
            </div>
          </section>

          {/* ---------- 快速上手 ---------- */}
          <section className="doc-sec" id="quickstart">
            <span className="doc-sec__k">02</span>
            <h2 className="h-card doc-sec__h">快速上手</h2>
            <p className="doc-p">按以下五步完成安装与配置，只想用起来的话跳过第 2 步。环境要求：Chrome 120 及以上（<code>chrome.userScripts</code> 依赖）；只有自建才需要 Node.js 20 及以上。</p>
            <ol className="olist">
              {QUICKSTART.map((s) => (
                <li key={s.t}>
                  <b>{s.t}</b>
                  <RichText text={s.d} />
                </li>
              ))}
            </ol>
            <div className="well">
              <div className="well__bar">
                <span className="well__lang">bash</span>
              </div>
              <pre>
                <code>
                  <span className="c"># 以下是第 2 步「克隆并构建」的内容；只想用扩展走第 1 步的下载包</span>
                  {'\n\n'}
                  <span className="c"># 安装依赖（postinstall 自动 wxt prepare）</span>
                  {'\n'}npm install{'\n\n'}
                  <span className="c"># 生产构建 → .output/chrome-mv3/</span>
                  {'\n'}npm run build{'\n\n'}
                  <span className="c"># 或开发模式（热更新 + 自动拉起浏览器）</span>
                  {'\n'}npm run dev
                </code>
              </pre>
            </div>
            <div className="empty__actions" style={{ marginTop: 20 }}>
              <a className="btn btn--primary" href={RELEASES} target="_blank" rel="noreferrer noopener">
                <Download aria-hidden="true" />
                下载打包版
              </a>
              <a className="btn btn--ghost" href={`${REPO}#readme`} target="_blank" rel="noreferrer noopener">
                <GithubMark size={15} />
                看仓库 README
              </a>
            </div>
          </section>

          {/* ---------- GM API 说明 ---------- */}
          <section className="doc-sec" id="gm-api">
            <span className="doc-sec__k">03</span>
            <h2 className="h-card doc-sec__h">GM_* API 说明</h2>
            <p className="doc-p">
              <RichText text="用户脚本通过 `@grant` 按需声明 GM_* 能力，扩展仅安装脚本头声明的对应项。当前支持 29 个函数 grant 与 4 个特殊 grant，覆盖值存储、DOM 操作、菜单命令、网络请求、标签页、通知、cookie 与下载。跨域请求（`GM_xmlhttpRequest` / `GM_download` / `GM_cookie`）经 `@connect` 白名单门控，命中时弹出确认对话框。" />
            </p>
            <div className="gm-groups">
              {GM_GROUPS.map((g) => (
                <div className="gm-group" key={g.k}>
                  <div className="gm-group__head">
                    <span className="gm-group__name">{g.k}</span>
                    <span className="gm-group__c">{g.v.length}</span>
                  </div>
                  <ul className="gm-list">
                    {g.v.map((a) => (
                      <li className="gm-item" key={a.n}>
                        <code className="gm-item__n">{a.n}</code>
                        <span className="gm-item__d">
                          <RichText text={a.d} />
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            <p className="doc-note">
              <RichText text="点形式 `GM.xxx` 与下划线形式 `GM_xxx` 均受支持（`GM.info` 为同一引用，非 Promise）。完整函数签名、与 Tampermonkey / Violentmonkey / ScriptCat 的兼容对照及实现细节，参见仓库 `docs/gm-api.md`。" />
            </p>
          </section>

          {/* ---------- Tools 介绍 ---------- */}
          <section className="doc-sec" id="tools">
            <span className="doc-sec__k">04</span>
            <h2 className="h-card doc-sec__h">Tools 介绍</h2>
            <p className="doc-p">
              <RichText text="模型可调用 28 个内置工具，划分为 6 个能力域。每次调用均以卡片形式记录在会话中，包含工具名、参数与结果摘要。其中 12 个只读工具在 ask 模式下可用，其余仅在 agent 模式下可用。设置页的工具调试台支持绕过模型直接调用任意工具。" />
            </p>
            <div className="doc-modes">
              {MODES.map((m) => (
                <div className={`doc-mode doc-mode--${m.k}`} key={m.k}>
                  <span className="doc-mode__name">{m.k}</span>
                  <span className="doc-mode__n">{m.n}</span>
                  <p className="doc-mode__d">{m.d}</p>
                </div>
              ))}
            </div>
            <div className="tools" style={{ marginTop: 22 }}>
              {TOOL_GROUPS.map((g) => (
                <div className="toolrow" key={g.k}>
                  <div className="toolrow__k">
                    <span className="toolrow__name">{g.k}</span>
                    <span className="toolrow__c">{g.v.length} {g.v.length === 1 ? 'tool' : 'tools'}</span>
                  </div>
                  <div className="chips">
                    {g.v.map((t) => (
                      <span className="chip" key={t}>{t}</span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>

        <aside className="docs__aside">
          <span className="eyebrow">本页目录</span>
          <nav className="doc-toc" aria-label="文档目录">
            {TOC.map((t) => (
              <a className="doc-toc__link" href="#/docs" key={t.id}
                onClick={(e) => { e.preventDefault(); document.getElementById(t.id)?.scrollIntoView({ behavior: 'smooth' }); }}>
                <span className="doc-toc__n">{t.n}</span>
                {t.label}
              </a>
            ))}
          </nav>
          <div className="doc-aside-cta">
            <p>安装或运行遇到问题，可参阅仓库 <code className="code-inline">docs/使用指南.md</code> 末尾的故障排查章节。</p>
            <a className="doc-aside-link" href={`${REPO}/issues`} target="_blank" rel="noreferrer noopener">
              提交反馈 <ArrowRight aria-hidden="true" size={14} />
            </a>
          </div>
        </aside>
      </div>
    </div>
  );
}

const TOC: { id: string; n: string; label: string }[] = [
  { id: 'intro', n: '01', label: '项目介绍' },
  { id: 'quickstart', n: '02', label: '快速上手' },
  { id: 'gm-api', n: '03', label: 'GM_* API 说明' },
  { id: 'tools', n: '04', label: 'Tools 介绍' },
];

const INTRO: { t: string; d: string }[] = [
  { t: '两种执行方式', d: '即时执行一次性任务，或生成用户脚本供后续自动运行。两者共用同一套页面感知机制。' },
  { t: '两种权限模式', d: 'ask 模式为只读（12 个工具），agent 模式为完整操控（28 个工具），可在输入框旁切换。' },
  { t: '完整 agent 运行时', d: '内置多轮循环、上下文压缩、熔断保护、权限模式、流式续播与会话持久化。' },
  { t: '内置脚本管理器', d: '提供脚本池、GM_* API、页面观测与两台调试台，覆盖脚本全生命周期管理。' },
];

const QUICKSTART: { t: string; d: string }[] = [
  { t: '下载打包版。', d: '点下方「下载打包版」到 Release 页，取最新的 `vevscript-ai-v<版本>-chrome-mv3.zip`，解压到一个以后不再挪动的目录——Chrome 记住的是这个路径，加载后再挪扩展会失效。这条路不装 Node、不用构建，是最快的一条。' },
  { t: '克隆并构建（可选）。', d: '要改代码或自己出包再走这条：Node.js 20+ 环境执行 `npm install` 与 `npm run build`，产物位于 `.output/chrome-mv3/`。' },
  { t: '加载扩展。', d: '打开 `chrome://extensions`，启用开发者模式，选择「加载已解压的扩展程序」，指向第 1 或第 2 步得到的那个目录。需 Chrome 120+。' },
  { t: '配置模型。', d: '进入侧边栏「设置 → 模型设置」，填写 Base URL（以 `/v1` 结尾）、API Key 与模型 ID，测试连接通过后保存。' },
  { t: '开始使用。', d: '打开任意网页，在侧边栏输入需求。兼容 DeepSeek、Qwen、OpenAI、中转服务及本地 Ollama。' },
];

const GM_GROUPS: { k: string; v: { n: string; d: string }[] }[] = [
  {
    k: '值存储',
    v: [
      { n: 'GM_getValue / setValue / deleteValue / listValues', d: '读写脚本命名空间的持久值。读取基于注入时快照，无需 RPC；写入经桥接跨标签页广播。' },
      { n: 'GM_getValues / setValues / deleteValues', d: '批量读写与删除，支持键数组、带默认值对象与全量三种形态。' },
      { n: 'GM_addValueChangeListener / removeValueChangeListener', d: '值变更监听，标记跨标签页来源。' },
    ],
  },
  {
    k: '页面与 DOM',
    v: [
      { n: 'GM_addStyle', d: '注入 `<style>` 元素，在当前 world 中直接创建。' },
      { n: 'GM_addElement', d: '创建并插入元素以绕过扩展 CSP，支持 textContent、innerHTML 与 setAttribute。' },
      { n: 'unsafeWindow', d: '访问页面真实 window（特殊 grant）；如需页面上下文的 window，请声明 `@world MAIN`。' },
    ],
  },
  {
    k: '资源',
    v: [
      { n: 'GM_getResourceText', d: '返回 `@resource` 文本内容，随资源预取直接嵌入快照。' },
      { n: 'GM_getResourceURL', d: '返回资源的 data: URL，二进制资源经预取拼接为 base64 完整 URL。' },
    ],
  },
  {
    k: '菜单命令',
    v: [
      { n: 'GM_registerMenuCommand / unregisterMenuCommand', d: '注册与注销菜单命令，入口位于侧边栏脚本页（非浏览器右键菜单）。' },
    ],
  },
  {
    k: '网络',
    v: [
      { n: 'GM_xmlhttpRequest', d: '发起跨域请求，经 `@connect` 白名单与确认对话框校验；非流式，响应上限 1MB。' },
      { n: 'GM_download', d: '下载文件，基于 `chrome.downloads` 与 downloads 权限，受 `@connect` 门控。' },
      { n: 'GM_cookie.list / set / delete', d: '读写站点 cookie，`@grant GM_cookie` 一次性安装全部三个方法。' },
      { n: 'GM_llmChat', d: '调用扩展所配置的大模型（支持文本 / 图片、流式 onChunk），需选择权限档并经确认对话框。' },
    ],
  },
  {
    k: '标签页',
    v: [
      { n: 'GM_openInTab', d: '打开新标签页，返回包含 `close()`、`onclose`、`closed` 的句柄。' },
      { n: 'GM_getTab / saveTab / getTabs', d: '按标签页存储脚本私有数据，保存于 `storage.session`，随会话失效。' },
      { n: 'window.close / window.focus', d: '关闭或激活脚本所在标签页（特殊 grant，经桥接至 Service Worker）。' },
      { n: 'window.onurlchange', d: '监听 SPA 路由变化事件（特殊 grant），由 Service Worker 的 webNavigation 主帧下发。' },
    ],
  },
  {
    k: '通知与剪贴板',
    v: [
      { n: 'GM_notification / closeNotification / updateNotification', d: '系统通知的发送、关闭与更新，基于 Service Worker 的 `chrome.notifications`。' },
      { n: 'GM_setClipboard', d: '写入剪贴板，基于 offscreen 文档与 execCommand，仅支持文本。' },
    ],
  },
  {
    k: '信息与日志',
    v: [
      { n: 'GM_info', d: '脚本与扩展元数据（scriptHandler、version、script 等），构建期直接嵌入。' },
      { n: 'GM_log', d: '输出带脚本名前缀 `[脚本名]` 的本地 console 日志。' },
    ],
  },
];

const MODES: { k: string; n: string; d: string }[] = [
  { k: 'ask', n: '12 个只读工具', d: '仅读取，不修改页面或浏览器状态。可解读页面、定向查询元素、查看截图、检索控制台与网络请求、读取脚本库。涉及修改操作时会提示切换模式。' },
  { k: 'agent', n: '全部 28 个工具', d: '完整操控。支持点击、填写、导航、标签页管理、脚本执行、HTTP 请求及脚本池增删改，执行前先行观察页面。' },
];

const TOOL_GROUPS: { k: string; v: string[] }[] = [
  { k: '页面操控', v: ['take_snapshot', 'query_page', 'click', 'fill', 'fill_form', 'hover', 'scroll', 'press_key', 'wait_for', 'navigate_page'] },
  { k: '标签页', v: ['list_pages', 'new_page', 'close_page', 'select_page'] },
  { k: '感知', v: ['take_screenshot', 'evaluate_script', 'http_request'] },
  { k: '观测', v: ['list_console_messages', 'list_network_requests', 'get_network_request'] },
  { k: '脚本池', v: ['list_scripts', 'get_script', 'create_script', 'update_script', 'delete_script', 'toggle_script', 'grep_script'] },
  { k: '技能', v: ['load_skill'] },
];
