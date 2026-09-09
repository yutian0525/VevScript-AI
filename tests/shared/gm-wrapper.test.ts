// tests/shared/gm-wrapper.test.ts
import { describe, it, expect } from 'vitest';
import { buildWrappedCode, PREAMBLE_MARKER } from '../../shared/gm-wrapper';
import type { UserScript } from '../../shared/types';

function mkScript(over: Partial<UserScript> = {}): UserScript {
  return {
    id: 's1',
    text: '// ==UserScript==\n// @name t\n// @match https://a.com/*\n// @grant GM_getValue\n// @grant GM_setValue\n// ==/UserScript==\nuserCode();',
    name: 't', enabled: true, matches: ['https://a.com/*'], code: 'userCode();',
    runAt: 'document_idle', world: 'USER_SCRIPT', source: 'user', createdAt: 1, updatedAt: 1,
    meta: { grants: ['GM_getValue', 'GM_setValue'] }, ...over,
  };
}

describe('buildWrappedCode', () => {
  it('包含 preamble/GM_info/快照/token，用户代码在末尾', () => {
    const code = buildWrappedCode(mkScript(), {
      token: 'tok123', values: { k: 1 }, resources: {}, requireCodes: [], extensionVersion: '1.0.0',
    });
    expect(code).toContain(PREAMBLE_MARKER);
    expect(code).toContain('"scriptHandler":"ai-browser-extend"');
    expect(code).toContain('"version":"1.0.0"');
    expect(code).toContain('__values = {"k":1}');
    // JSON.stringify 产双引号字面量（实现惯例），断言按双引号
    expect(code).toContain('"tok123"');
    expect(code.indexOf('userCode();')).toBeGreaterThan(code.indexOf(PREAMBLE_MARKER));
    // 末尾执行（预编译探测 + try/catch 包裹用户代码）
    expect(code).toContain('new __GM_probe(');
    expect(code.trimEnd().endsWith('})();'));
  });

  it('grant 安装精确：只安装声明过的 API', () => {
    const code = buildWrappedCode(mkScript(), {
      token: 't', values: {}, resources: {}, requireCodes: [], extensionVersion: '1.0.0',
    });
    // J(name) 产双引号字符串字面量（JSON.stringify 惯例，与 token 修正同由）
    expect(code).toContain('install("GM_getValue"');
    expect(code).toContain('install("GM_setValue"');
    expect(code).not.toContain('install("GM_xmlhttpRequest"');
  });

  it('点形式双形态：GM.getValue 为 Promise 包装、GM_getValue 同步', () => {
    const code = buildWrappedCode(mkScript(), {
      token: 't', values: {}, resources: {}, requireCodes: [], extensionVersion: '1.0.0',
    });
    expect(code).toContain('GM.getValue');
    expect(code).toContain('GM_getValue');
  });

  it('unsafeWindow grant：MAIN world = window', () => {
    const s = mkScript({ world: 'MAIN', meta: { grants: ['unsafeWindow'] } });
    const code = buildWrappedCode(s, { token: 't', values: {}, resources: {}, requireCodes: [], extensionVersion: '1.0.0' });
    expect(code).toContain('var unsafeWindow = window;');
  });

  it('openInTab 句柄：OpenInTab 未 resolve 前 close() 不发 CloseTab（防 undefined tabId），resolve 后补发', () => {
    const s = mkScript({ meta: { grants: ['GM_openInTab'] } });
    const code = buildWrappedCode(s, { token: 't', values: {}, resources: {}, requireCodes: [], extensionVersion: '1.0.0' });
    // __closePending 惰性补发语义：close 早于 tabId 到达时先记账，OpenInTab resolve 后再发
    expect(code).toContain('__closePending');
    expect(code).toContain('if (h.__tabId != null)');
  });

  it('XmlHttpRequest/notification 过桥参数经 __GM_plain 摘除回调（跨 world 结构化克隆含函数 detail 会变 null）', () => {
    const s = mkScript({ meta: { grants: ['GM_xmlhttpRequest', 'GM_notification', 'GM_openInTab'] } });
    const code = buildWrappedCode(s, { token: 't', values: {}, resources: {}, requireCodes: [], extensionVersion: '1.0.0' });
    // XHR：闭包 details 原样持有回调（onload/onerror 可调），过桥用 __GM_plain 摘函数后的副本
    expect(code).toContain('var d = __GM_plain(details)');
    expect(code).toContain('__GM_post("XmlHttpRequest", [d])');
    // notification/openInTab 的 details/opts 同样摘函数（防御未来加回调字段）
    expect(code).toContain('__GM_post("Notification", [__GM_plain(details), id])');
    expect(code).toContain('__GM_post("OpenInTab", [url, __GM_plain(opts)])');
    // __GM_plain 定义在 preamble（全部 grant 组合都可用）
    expect(code).toContain('function __GM_plain(v)');
  });

  it('桥类 API：setValues/deleteValues/unregisterMenu/通知管理/getTab 系/download', () => {
    const s = mkScript({ meta: { grants: [
      'GM_setValues', 'GM_deleteValues', 'GM_unregisterMenuCommand',
      'GM_closeNotification', 'GM_updateNotification', 'GM_getTab', 'GM_saveTab', 'GM_getTabs', 'GM_download',
    ] } });
    const code = buildWrappedCode(s, { token: 't', values: {}, resources: {}, requireCodes: [], extensionVersion: '1.0.0' });
    expect(code).toContain('__GM_post("SetValues"');
    expect(code).toContain('__GM_post("DeleteValues"');
    expect(code).toContain('__GM_post("UnregisterMenu"');
    expect(code).toContain('__GM_post("CloseNotification"');
    expect(code).toContain('__GM_post("UpdateNotification"');
    expect(code).toContain('__GM_post("GetTab"');
    expect(code).toContain('__GM_post("SaveTab"');
    expect(code).toContain('__GM_post("GetTabs"');
    // download：url/details 双签名归一化 + onload/onerror 留闭包（过桥用 __GM_plain）
    expect(code).toContain('__GM_post("Download"');
    expect(code).toContain('typeof arg === "string"');
  });

  it('@require 内容在用户代码之前、preamble 之后', () => {
    const code = buildWrappedCode(mkScript(), {
      token: 't', values: {}, resources: {}, requireCodes: ['libBody();'], extensionVersion: '1.0.0',
    });
    const p = code.indexOf(PREAMBLE_MARKER);
    const r = code.indexOf('libBody();');
    const u = code.indexOf('userCode();');
    expect(p).toBeLessThan(r);
    expect(r).toBeLessThan(u);
  });

  it('无 grant 且无 @require：返回裸 code（零开销）', () => {
    const s = mkScript({ meta: undefined, text: '// ==UserScript==\n// @name t\n// @match https://a.com/*\n// ==/UserScript==\nuserCode();' });
    const code = buildWrappedCode(s, { token: 't', values: {}, resources: {}, requireCodes: [], extensionVersion: '1.0.0' });
    expect(code).toBe('userCode();');
  });

  it('@grant none + @require：加 wrapper（require 拼接宿主），GM 仅 GM_info', () => {
    const s = mkScript({
      meta: { requires: ['https://cdn/lib.js'] },
      text: '// ==UserScript==\n// @name t\n// @match https://a.com/*\n// @grant none\n// @require https://cdn/lib.js\n// ==/UserScript==\nuserCode();',
    });
    const code = buildWrappedCode(s, { token: 't', values: {}, resources: {}, requireCodes: ['lib();'], extensionVersion: '1.0.0' });
    expect(code).toContain(PREAMBLE_MARKER);
    expect(code).toContain('lib();');
    expect(code).not.toContain('install("GM_setValue"');
  });

  it('语法错误探测：用户代码以 JSON 转义字符串传给 __GM_probe', () => {
    const code = buildWrappedCode(mkScript(), {
      token: 't', values: {}, resources: {}, requireCodes: [], extensionVersion: '1.0.0',
    });
    expect(code).toContain(JSON.stringify('userCode();').slice(1, -1));
  });

  it('握手 backlog：__GM_post 就绪直发/未就绪入队，gmhost 监听冲刷，gmhello 派发（收口早到 gmreq 竞态）', () => {
    const code = buildWrappedCode(mkScript({ meta: { grants: ['GM_xmlhttpRequest'] } }), {
      token: 't', values: {}, resources: {}, requireCodes: [], extensionVersion: '1.0.0',
    });
    // backlog 态 + 分流：hostReady 直发，否则入 backlog
    expect(code).toContain('var __GM_hostReady = false;');
    expect(code).toContain('var __GM_backlog = [];');
    expect(code).toContain('if (__GM_hostReady) __GM_send(detail);');
    expect(code).toContain('else __GM_backlog.push(detail);');
    // gmhost 就绪信号：置位 + 冲刷 backlog
    expect(code).toContain("window.addEventListener('gmhost:' + __GM_id");
    // gmhello 问询派发（在用户代码之前的 preamble 内）
    expect(code).toContain("window.dispatchEvent(new CustomEvent('gmhello:' + __GM_id))");
    expect(code.indexOf("'gmhello:'")).toBeLessThan(code.indexOf('userCode();'));
    // gmhost 监听须先于 gmhello 派发挂好（否则宿主重发的 gmhost 漏接）
    expect(code.indexOf("addEventListener('gmhost:'")).toBeLessThan(code.indexOf("dispatchEvent(new CustomEvent('gmhello:'"));
  });

  it('全局错误钩子：error/unhandledrejection 均上报 __GM_report（后继异步异常链路）', () => {
    const code = buildWrappedCode(mkScript(), {
      token: 't', values: {}, resources: {}, requireCodes: [], extensionVersion: '1.0.0',
    });
    // window 'error' 监听：调 __GM_report 且跳过资源加载错误（target 非全局对象）
    expect(code).toContain("window.addEventListener('error', function (e) {");
    expect(code).toContain('if (e.target && e.target !== window) return;');
    // window 'unhandledrejection' 监听：reason 归一化后经 __GM_report 上报
    expect(code).toContain("window.addEventListener('unhandledrejection', function (e) {");
    // 两处钩子都汇入 __GM_report（ReportError 内部通道的页面侧入口）
    expect(code.match(/__GM_report\(/g)?.length).toBeGreaterThanOrEqual(4);
    // 钩子定义在 preamble 内（先于用户代码执行体注册，保证首帧后的异步异常已被覆盖）
    expect(code.indexOf("window.addEventListener('error'")).toBeLessThan(code.indexOf('userCode();'));
  });

  it('本地/快照类 API：getValues/addElement/removeValueChangeListener/getResourceURL', () => {
    const s = mkScript({ meta: { grants: ['GM_getValues', 'GM_addElement', 'GM_removeValueChangeListener', 'GM_getResourceURL'] } });
    const code = buildWrappedCode(s, {
      token: 't', values: { a: 1 }, resources: {}, resourceUrls: { logo: 'data:image/png;base64,AAA' },
      requireCodes: [], extensionVersion: '1.0.0',
    });
    expect(code).toContain('install("GM_getValues"');
    expect(code).toContain('install("GM_addElement"');
    expect(code).toContain('install("GM_removeValueChangeListener"');
    expect(code).toContain('install("GM_getResourceURL"');
    // getResourceURL 数据源：注入时快照 __resourceUrls
    expect(code).toContain('__resourceUrls = {"logo":"data:image/png;base64,AAA"}');
    // 全为 local/snapshot：无 __GM_post（无这些 API 的桥调用）
    expect(code).not.toContain('__GM_post("SetValues"');
    // addElement 无 parent 时默认落 body（head 的 UA display:none 会吞掉渲染元素——d6/d7 手测教训）
    expect(code).toContain('document.body || document.head || document.documentElement');
  });

  it('对象型 GM_cookie：@grant 一次装齐三方法，GM.cookie 同引用（非 Promise 包装）', () => {
    const s = mkScript({ meta: { grants: ['GM_cookie'] } });
    const code = buildWrappedCode(s, { token: 't', values: {}, resources: {}, requireCodes: [], extensionVersion: '1.0.0' });
    expect(code).toContain('install("GM_cookie"');
    expect(code).toContain('__GM_post("CookieList"');
    expect(code).toContain('__GM_post("CookieSet"');
    expect(code).toContain('__GM_post("CookieDelete"');
    // 点形式同引用（对象），不生成通用 Promise 包装函数
    expect(code).toContain('GM.cookie = GM_cookie;');
    expect(code).not.toContain('install("GM.cookie", function ()');
  });

  it('特殊 grant：window.close/focus 覆写 unsafeWindow，onurlchange 占位 + URL_CHANGE 分发', () => {
    const s = mkScript({ meta: { grants: ['window.close', 'window.focus', 'window.onurlchange'] } });
    const code = buildWrappedCode(s, { token: 't', values: {}, resources: {}, requireCodes: [], extensionVersion: '1.0.0' });
    expect(code).toContain('unsafeWindow.close = function () { __GM_post("WindowClose", []); };');
    expect(code).toContain('unsafeWindow.focus = function () { __GM_post("WindowFocus", []); };');
    expect(code).toContain('unsafeWindow.onurlchange = null;');
    // URL_CHANGE 分支在 preamble（始终存在，未 grant 则 SW 不下行）
    expect(code).toContain("d.kind === 'URL_CHANGE'");
    expect(code).toContain("new CustomEvent('urlchange'");
  });

  it('未 grant 特殊项：不覆写 unsafeWindow.close/focus/onurlchange', () => {
    const code = buildWrappedCode(mkScript(), { token: 't', values: {}, resources: {}, requireCodes: [], extensionVersion: '1.0.0' });
    expect(code).not.toContain('unsafeWindow.close = function');
    expect(code).not.toContain('unsafeWindow.onurlchange = null;');
  });
});

describe('GM_llmChat wrapper', () => {
  const opts = { token: 't', values: {}, resources: {}, requireCodes: [], extensionVersion: '1.0.0' };

  it('grant 精确安装：声明才安装，且带 LLM_CHUNK 通道注册/清理逻辑', () => {
    const code = buildWrappedCode(mkScript({ meta: { grants: ['GM_llmChat'] } }), opts);
    expect(code).toContain('install("GM_llmChat"');
    expect(code).toContain('__GM_plain_llm');
    expect(code).toContain('__GM_listeners.set("llmchan:" + chan');
    expect(code).toContain('__GM_listeners.delete("llmchan:" + chan');
    // 点形式 Promise 包装由 promiseForm 驱动
    expect(code).toContain('install("GM.llmChat"');
    // 未声明则不安装
    const code2 = buildWrappedCode(mkScript(), opts);
    expect(code2).not.toContain('install("GM_llmChat"');
  });

  it('preamble 含页实例 id（chan 前缀）+ 显式 reqId 版 __GM_post_id；__GM_post 委托它', () => {
    const code = buildWrappedCode(mkScript({ meta: { grants: ['GM_llmChat'] } }), opts);
    expect(code).toContain('var __GM_inst =');
    expect(code).toContain('function __GM_post_id(api, params, reqId)');
    expect(code).toMatch(/var reqId = \+\+__GM_reqSeq;\s*\n\s*return __GM_post_id\(api, params, reqId\);/);
  });

  it('gmevt 分发器含 LLM_CHUNK 分支（按 chan 找 llmchan: 监听）', () => {
    const code = buildWrappedCode(mkScript(), opts);
    expect(code).toContain("d.kind === 'LLM_CHUNK'");
    expect(code).toContain("__GM_listeners.get('llmchan:' + d.data.chan)");
  });

  it('onChunk 摘除后过桥：payload 里无 onChunk 键（__GM_plain_llm 摘函数语义）', () => {
    const code = buildWrappedCode(mkScript({ meta: { grants: ['GM_llmChat'] } }), opts);
    expect(code).toMatch(/function __GM_plain_llm\(v\) \{[\s\S]*?__GM_plain\(v\)/);
    expect(code).toContain('delete copy.onChunk');
  });

  it('chan/reqId 共用单次自增：安装行 ++__GM_reqSeq 恰好一次，且 reqId 同时喂 chan 与 __GM_post_id', () => {
    const code = buildWrappedCode(mkScript({ meta: { grants: ['GM_llmChat'] } }), opts);
    const installLine = code.split('\n').find((l) => l.includes('install("GM_llmChat"'));
    expect(installLine).toBeDefined();
    expect(installLine!.match(/\+\+__GM_reqSeq/g)).toHaveLength(1);
    expect(installLine).toContain('__GM_post_id("LlmChat", [d, chan], reqId)');
  });

  it('集成：真实执行安装表达式——过桥 params[1] 携带 chan（SW 下行配对依赖，防桥两侧契约断点）', () => {
    const code = buildWrappedCode(mkScript({ meta: { grants: ['GM_llmChat'] } }), opts);
    // 从产物中提取 GM_llmChat 安装表达式源码（install("GM_llmChat", <expr>); 行），
    // 在 stub 最小环境里 eval：捕获 __GM_post_id 收到的 params。
    const line = code.split('\n').find((l) => l.includes('install("GM_llmChat"'));
    expect(line).toBeDefined();
    const exprMatch = /install\("GM_llmChat", (.+)\);$/.exec(line!.trim())!;
    expect(exprMatch).toBeTruthy();
    const captured: Array<{ api: string; params: unknown[]; reqId: number }> = [];
    const listeners = new Map<string, unknown>();
    const fn = new Function(
      '__GM_plain_llm', '__GM_plain', '__GM_inst', '__GM_listeners', '__GM_post_id',
      'var __GM_reqSeq = 0; return (' + exprMatch[1] + ');',
    )(
      (v: unknown) => { const c = JSON.parse(JSON.stringify(v ?? null)); if (c && c.onChunk !== undefined) delete c.onChunk; return c; },
      (v: unknown) => JSON.parse(JSON.stringify(v ?? null)),
      'inst1', listeners,
      (api: string, params: unknown[], reqId: number) => { captured.push({ api, params, reqId }); return Promise.resolve({ text: 'x' }); },
    );
    const onChunk = (): void => {};
    fn({ messages: [{ role: 'user', content: 'hi' }], onChunk });
    expect(captured).toHaveLength(1);
    expect(captured[0]!.api).toBe('LlmChat');
    expect(captured[0]!.params).toHaveLength(2);
    expect(captured[0]!.params[1]).toBe('inst1:1'); // inst 前缀 + reqId（++__GM_reqSeq 后为 1）
  });
});
