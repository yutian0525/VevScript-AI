import { ArrowRight, BookOpen, Eye, Puzzle, ScrollText, Wrench } from 'lucide-react';
import { Demo } from '../components/Demo';
import { GithubMark } from '../components/Logo';
import { RichText } from '../components/RichText';
import { REPO } from '../router';

export function Home() {
  return (
    <>
      <section className="hero">
        <div className="shell hero__grid">
          <div className="hero__copy">
            {/* 不复述 H1 里的 agent harness，只补它没说的事实 */}
            <span className="eyebrow hero__eyebrow">Chrome MV3 · OpenAI 兼容 · 开源</span>
            <h1 className="h-display hero__h1">
              浏览器里的
              <br />
              <em>agent harness</em>
            </h1>
            <p className="lede hero__lede">
              多轮 loop、上下文压缩、熔断阀、权限模式、流式续播——该有的都在。只是它的作用对象是你正在用的这个浏览器：真登录态、真会话、真标签页。
            </p>
            <div className="hero__actions">
              <a className="btn btn--primary" href={REPO} target="_blank" rel="noreferrer noopener">
                <GithubMark size={15} />
                去 GitHub 拿源码
              </a>
              <a className="btn btn--ghost" href="#/docs">
                <BookOpen aria-hidden="true" />
                读使用文档
              </a>
            </div>
            <ul className="facts">
              <li className="fact">
                <span className="fact__n">27</span>
                <span className="fact__l">个内置工具</span>
              </li>
              <li className="fact">
                <span className="fact__n">33</span>
                <span className="fact__l">个 GM_* 授权项</span>
              </li>
              <li className="fact">
                <span className="fact__n">0</span>
                <span className="fact__l">行代码要你手写</span>
              </li>
            </ul>
          </div>
          <Demo />
        </div>
      </section>

      <section className="section section--white" id="harness">
        <div className="shell">
          <div className="section__head">
            <span className="eyebrow">Harness 机件</span>
            <h2 className="h-section">一个 agent 运行时该有的东西</h2>
            <p className="lede">
              不是「调模型 + 几个函数」。会话在后台跑、上下文自己收拢、模型卡住有熔断、能力面按权限收放。
            </p>
          </div>

          <div className="tools rig">
            {RIG.map((r) => (
              <div className="toolrow" key={r.k}>
                <div className="toolrow__k">
                  <span className="toolrow__name">{r.k}</span>
                  <span className="toolrow__c">{r.f}</span>
                </div>
                <p className="rig__d">
                  <RichText text={r.d} />
                </p>
              </div>
            ))}
          </div>

          <div className="stances">
            <span className="eyebrow">几个刻意的取向</span>
            <div className="stances__grid">
              {STANCES.map((s) => (
                <div className="stance" key={s.t}>
                  <h3 className="h-card stance__t">{s.t}</h3>
                  <p className="stance__d">
                    <RichText text={s.d} />
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="section section--paper" id="paths">
        <div className="shell">
          <div className="section__head">
            <span className="eyebrow">两条路</span>
            <h2 className="h-section">现在就做完，或者以后自动做</h2>
            <p className="lede">
              同一句需求，可以让它当场动手，也可以让它写成脚本常驻。两条路共用同一套感知——
              accessibility 快照、截图、控制台与网络观测。
            </p>
          </div>
          <div className="paths">
            {PATHS.map((p) => (
              <article className="path" key={p.t}>
                <span className="path__k">{p.k}</span>
                <h3 className="h-card path__t">{p.t}</h3>
                <p className="path__d">
                  <RichText text={p.d} />
                </p>
                <div className="chips path__tools">
                  {p.tools.map((t) => (
                    <span className="chip" key={t}>
                      {t}
                    </span>
                  ))}
                </div>
                <p className="path__when">
                  <span className="path__when-k">适合</span>
                  {p.when}
                </p>
              </article>
            ))}
          </div>

          <div className="modes">
            <div className="modes__head">
              <span className="eyebrow">两种模式</span>
              <p className="modes__lede">
                输入框旁一个下拉框切。约束不只靠模型自觉——工具清单按模式过滤、system prompt 交代边界、
                执行前还有一道守卫兜底。
              </p>
            </div>
            <div className="modes__grid">
              {MODES.map((m) => (
                <div className={`mode mode--${m.k}`} key={m.k}>
                  <div className="mode__top">
                    <span className="mode__name">{m.k}</span>
                    <span className="mode__n">{m.n}</span>
                  </div>
                  <p className="mode__d">{m.d}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="section section--white" id="flow">
        <div className="shell">
          <div className="section__head">
            <span className="eyebrow">脚本那条路 · 拆开看</span>
            <h2 className="h-section">写脚本这件事，它替你干了四步</h2>
            <p className="lede">
              传统用户脚本的门槛在别处：要背 <code className="code-inline">@match</code> /{' '}
              <code className="code-inline">@grant</code> 的元数据格式、要在陌生 DOM 里摸黑调试、要自己装管理器再粘代码。这四步现在由 AI 走。
            </p>
          </div>
          <div className="flow">
            {STEPS.map((s, i) => (
              <article className="step" key={s.t}>
                <span className="step__n">{String(i + 1).padStart(2, '0')}</span>
                <h3 className="h-card step__t">{s.t}</h3>
                <p className="step__d">
                  <RichText text={s.d} />
                </p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="section section--paper" id="tools">
        <div className="shell">
          <div className="section__head">
            <span className="eyebrow">27 tools · 6 domains</span>
            <h2 className="h-section">模型手上的工具</h2>
            <p className="lede">
              每一步都以卡片形式摊在会话里：工具名、参数、结果摘要。其中 11 个只读工具在 ask 模式下也可用，
              其余仅 agent 模式。设置页的工具调试台可以绕开模型直调任意一个。
            </p>
          </div>
          <div className="tools">
            {TOOLS.map((g) => (
              <div className="toolrow" key={g.k}>
                <div className="toolrow__k">
                  <span className="toolrow__name">{g.k}</span>
                  <span className="toolrow__c">
                    {g.v.length} {g.v.length === 1 ? 'tool' : 'tools'}
                  </span>
                </div>
                <div className="chips">
                  {g.v.map((t) => (
                    <span className="chip" key={t}>
                      {t}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="section section--white" id="more">
        <div className="shell">
          <div className="section__head">
            <span className="eyebrow">写脚本之外</span>
            <h2 className="h-section">也是一台完整的脚本管理器</h2>
            <p className="lede">
              AI 写出的脚本和你手写的待遇完全一致，进同一个池子。观测、调试、GM API 一并给全。
            </p>
          </div>
          <div className="feats">
            {FEATS.map((f) => (
              <article className="feat" key={f.t}>
                <span className="feat__icon">{f.icon}</span>
                <h3 className="h-card feat__t">{f.t}</h3>
                <p className="feat__d">
                  <RichText text={f.d} />
                </p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="section section--paper" id="start">
        <div className="shell start">
          <div>
            <span className="eyebrow">装起来</span>
            <h2 className="h-section" style={{ marginBlock: '14px 18px' }}>
              四步能跑
            </h2>
            <ol className="olist">
              <li>
                <b>克隆并构建。</b>Node ≥ 20，产物落在 <code>.output/chrome-mv3/</code>。
              </li>
              <li>
                <b>加载扩展。</b>打开 <code>chrome://extensions</code>，开发者模式 → 加载已解压的扩展程序 →
                选那个目录。需要 Chrome 120+（<code>chrome.userScripts</code> 的门槛）。
              </li>
              <li>
                <b>填模型。</b>侧边栏 → 设置 → 模型设置，填 Base URL（到 <code>/v1</code> 为止）、API Key、模型 ID，测试连接后保存。
              </li>
              <li>
                <b>说需求。</b>打开任意网页，在侧边栏说你想要什么。
              </li>
            </ol>
          </div>
          <div>
            <div className="well">
              <div className="well__bar">
                <span className="well__lang">bash</span>
              </div>
              <pre>
                <code>
                  <span className="c"># 安装依赖（postinstall 自动 wxt prepare）</span>
                  {'\n'}npm install{'\n\n'}
                  <span className="c"># 生产构建 → .output/chrome-mv3/</span>
                  {'\n'}npm run build{'\n\n'}
                  <span className="c"># 或开发模式（热更新 + 自动拉起浏览器）</span>
                  {'\n'}npm run dev
                </code>
              </pre>
            </div>
            {/* 表里是长 mono URL，其固有最小宽度会把整条栅格轨道顶宽（minmax(0,…) 管不到表自身），
                窄屏于是整页横向溢出。套一层横滚容器把溢出关在表内。 */}
            <div className="ptable-scroll">
              <table className="ptable">
                <thead>
                  <tr>
                    <th>服务商</th>
                    <th>Base URL</th>
                    <th>模型示例</th>
                  </tr>
                </thead>
                <tbody>
                  {PROVIDERS.map((p) => (
                    <tr key={p[0]}>
                      <td>{p[0]}</td>
                      <td>{p[1]}</td>
                      <td>{p[2]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </section>

      <section className="cta">
        <div className="shell">
          <h2 className="h-section">下一个脚本，你只需要把它说出来</h2>
          <p className="lede cta__lede">
            开源、可自建、模型自选。DeepSeek / Qwen / OpenAI / 中转站 / 本地 Ollama 都能接。
          </p>
          <div className="cta__actions">
            <a className="btn btn--primary" href={REPO} target="_blank" rel="noreferrer noopener">
              <GithubMark size={15} />
              yutian0525/VevScript-AI
            </a>
            <a className="btn btn--ghost" href="#/docs">
              使用文档
              <ArrowRight aria-hidden="true" />
            </a>
          </div>
          <p className="cta__note">Chrome 120+ · Node ≥ 20 · WXT + React 19 + TypeScript</p>
        </div>
      </section>
    </>
  );
}

const RIG: { k: string; f: string; d: string }[] = [
  { k: '多轮循环', f: 'agent/loop.ts', d: '工具调用循环、per-conv 并发闸门、斜杠指令解析、达阈值自动压缩。' },
  { k: '单轮执行', f: 'agent/run-turn.ts', d: '流式增量（reasoning / 正文 / 工具参数三路）、工具分发、`finishReason` 处理。' },
  { k: '熔断阀', f: 'agent/loop-guards.ts', d: '打转检测（3 次同工具同参数）、连续失败检测（5 轮全错）。判定命中是暂停问你，不是硬杀。' },
  { k: '上下文组装', f: 'agent/context.ts', d: 'system prompt + 当前页面 + 技能简述 + 模式段；截断时防孤立 tool 消息；历史截图只留最近两张。' },
  { k: '上下文压缩', f: 'agent/compact.ts', d: '增量 LLM 摘要，保留近 20 条原文，边界单调不倒退。原始消息永不删除。' },
  { k: '用量计量', f: 'agent/context-meter.ts', d: 'token 估算 + 模型窗口映射表（设置可覆盖）+ 80% / 95% 档位，环形仪表随轮次变色。' },
  { k: '权限模式', f: 'agent/mode.ts', d: 'ask / agent 工具面闸门，三层落实：清单过滤 → prompt 交代 → 执行前守卫。' },
  { k: '模型抽象', f: 'agent/provider/', d: 'OpenAI 兼容流式；超时 60s + 300s 静默硬兜底；`max_tokens` 显式下发。' },
  { k: '会话持久化', f: 'storage/conversations.ts', d: '多会话、与标签页解绑、上下文互相隔离；会话指针存 session storage。' },
  { k: '流式续播', f: 'background/agent-tail.ts', d: 'loop 跑在 Service Worker 里，面板切走再回来补未落库的流式尾巴。' },
  { k: '技能', f: 'shared/skill-md.ts', d: '`.md` 导入，简述注入每轮 prompt，`/command` 触发，`load_skill` 取正文。' },
];

const STANCES: { t: string; d: string }[] = [
  {
    t: '不数步数，不设 token 预算',
    d: '主退出是自然终止（模型不再调工具）和你手动中断。熔断阀只做故障检测——它测的是模型真卡住了，不是正常的长任务。',
  },
  {
    t: '压缩不删原文',
    d: '摘要置顶注入，被摘的原始消息仍在 storage 里。压缩改变的只是「这一轮往模型送什么」，不是历史本身。',
  },
  {
    t: 'loop 在后台，不在面板',
    d: '关掉侧边栏、切标签页都不打断任务。重开时后台回放权威运行态并补上流式尾巴，而不是重跑一遍。',
  },
  {
    t: '权限三层落实',
    d: 'prompt 遵循不等于硬约束。所以除了按模式过滤工具清单、在 prompt 里交代边界，执行前还有一道守卫兜底。',
  },
];

const PATHS: { k: string; t: string; d: string; tools: string[]; when: string }[] = [
  {
    k: '操控',
    t: '当场把这件事做完',
    d: '`take_snapshot` 取 accessibility 快照——页面结构树，每个可交互元素带 `[uid]` 编号。之后按 uid 点击、填写、悬停、滚动、按键。页面结构变了旧 uid 会失效并报 stale，它重新取一次快照接着干。',
    tools: ['take_snapshot', 'click', 'fill', 'fill_form', 'wait_for', 'navigate_page'],
    when: '一次性的活儿。整理这一页的数据、把内容填进表单、连着翻十页把要的东西挑出来。',
  },
  {
    k: '脚本',
    t: '写成脚本，以后自动做',
    d: '同样先读懂页面，然后写一份完整的 `.user.js` 装进脚本池。`chrome.userScripts` 负责注入，下次打开匹配的页面自动运行，不需要再开侧边栏。',
    tools: ['create_script', 'update_script', 'grep_script', 'toggle_script'],
    when: '每次打开都想要的改动。去广告、改样式、补信息、加快捷键。',
  },
];

const MODES: { k: string; n: string; d: string }[] = [
  {
    k: 'ask',
    n: '11 个只读工具',
    d: '只看不改。解读页面内容、看截图、翻控制台报错与网络请求、读脚本库。你让它改东西时，它会说明当前是只读模式并请你切换。',
  },
  {
    k: 'agent',
    n: '全部 27 个工具',
    d: '完整操控。点击填写导航、标签页管理、执行脚本、发 HTTP 请求、增删改脚本池。先观察再动手，做完用自然语言汇报。',
  },
];

const STEPS: { t: string; d: string }[] = [
  {
    t: '读懂这一页',
    d: '`take_snapshot` 取 uid 树、`take_screenshot` 看渲染，必要时翻 console 与网络请求摸清接口行为。',
  },
  {
    t: '先搭骨架',
    d: '`create_script` 只写元数据头加一个未闭合的 IIFE。超 200 行会被硬闸拦下并引导分步——长代码一次性写必截断。',
  },
  {
    t: '分次追加',
    d: '`patch.append` 逐段续写，末段补 `})();` 闭合。每次写入都过词法级括号配平检查，回 `balance`。',
  },
  {
    t: '自动注入',
    d: '脚本即刻进池，页面导航后由 `chrome.userScripts` 注入运行。写错的段落用 `patch.replace` 按字面量精确改。',
  },
];

const TOOLS: { k: string; v: string[] }[] = [
  {
    k: '页面操控',
    v: ['take_snapshot', 'click', 'fill', 'fill_form', 'hover', 'scroll', 'press_key', 'wait_for', 'navigate_page'],
  },
  { k: '标签页', v: ['list_pages', 'new_page', 'close_page', 'select_page'] },
  { k: '感知', v: ['take_screenshot', 'evaluate_script', 'http_request'] },
  { k: '观测', v: ['list_console_messages', 'list_network_requests', 'get_network_request'] },
  {
    k: '脚本池',
    v: ['list_scripts', 'get_script', 'create_script', 'update_script', 'delete_script', 'toggle_script', 'grep_script'],
  },
  { k: '技能', v: ['load_skill'] },
];

const FEATS: { icon: React.ReactNode; t: string; d: string }[] = [
  {
    icon: <ScrollText aria-hidden="true" />,
    t: '脚本池',
    d: '完整源码为唯一真源。启停、搜索、导入导出、URL 直链安装，全屏详情页带 CodeMirror 6 可人工接管微调，`@updateURL` 更新检查。',
  },
  {
    icon: <Puzzle aria-hidden="true" />,
    t: 'GM_* API',
    d: '29 个函数 grant + 4 个特殊 grant，按 `@grant` 精确安装：值存储、菜单命令、通知、资源、XHR、cookie、download、`window.onurlchange`。跨域走 `@connect` 门控加确认卡。',
  },
  {
    icon: <Eye aria-hidden="true" />,
    t: '页面观测',
    d: 'MAIN world hook 包装 fetch / XHR / console，`webRequest` 记全量网络元数据，读取时按设置脱敏敏感头。强风控站可加排除名单。',
  },
  {
    icon: <Wrench aria-hidden="true" />,
    t: '两台调试台',
    d: '工具调试台绕开模型直调任意工具；脚本运行时调试台看 grant 白名单与 `@connect` 授权，并经真实桥链路直调 GM API。',
  },
];

const PROVIDERS: [string, string, string][] = [
  ['DeepSeek', 'https://api.deepseek.com/v1', 'deepseek-chat'],
  ['阿里 Qwen', 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen-plus'],
  ['OpenAI', 'https://api.openai.com/v1', 'gpt-4o-mini'],
  ['本地 Ollama', 'http://localhost:11434/v1', 'qwen3:8b'],
];
