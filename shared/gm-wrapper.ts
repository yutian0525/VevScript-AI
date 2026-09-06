// shared/gm-wrapper.ts
// wrapper 生成（spec §5）：preamble 内联 + GM 对象按 @grant 精确安装 + 值快照直嵌 + require 前置。
// 纯函数（字符串拼装）——无 grant 且无 @require 的脚本返回裸 code（零开销）。
// preamble 里只用页面环境必然存在的全局（window/document/console/Promise/Map/CustomEvent），不依赖扩展 API。
// 生成的 wrapper 代码走 ES5 风格（var/function，无箭头/模板串）——目标脚本可能跑在旧语法页面，且避免与用户代码转义互相干扰。

import type { UserScript } from './types';
import { GM_API_REGISTRY, SPECIAL_GRANTS } from './gm-apis';

export const PREAMBLE_MARKER = '/* __GM_PREAMBLE__ */';

export interface WrapperDeps {
  token: string;
  /** 注入时值快照（GM_getValue 零 RPC 数据源） */
  values: Record<string, unknown>;
  /** @resource 内容（name → text） */
  resources: Record<string, string>;
  /** @require 预取产物（按声明顺序） */
  requireCodes: string[];
  extensionVersion: string;
}

const J = JSON.stringify;

function gmInfoLiteral(script: UserScript, version: string): string {
  const m = script.meta ?? {};
  return J({
    scriptHandler: 'ai-browser-extend',
    version,
    script: {
      name: script.name,
      namespace: m.namespace ?? '',
      version: m.version ?? '0.0',
      description: m.description ?? '',
      matches: script.matches,
      grants: m.grants ?? [],
    },
    injectInto: script.world === 'MAIN' ? 'Main' : 'UserScript',
  });
}

function preamble(scriptId: string): string {
  // IIFE 闭包持有 token/pending；事件桥客户端（gmreq/gmres/gmevt 三事件，spec §6）。
  return `${PREAMBLE_MARKER}
(function () {
  'use strict';
  var __GM_id = ${J(scriptId)};
  var __GM_token = TOKEN_PLACEHOLDER;
  var __GM_reqSeq = 0;
  var __GM_pending = new Map();
  var __GM_listeners = new Map();
  var __GM_valueHooks = new Map();
  var GM = {};
  var GM_info = GMINFO_PLACEHOLDER;
  GM.info = GM_info;
  var unsafeWindow = window;
  var __values = VALUES_PLACEHOLDER;
  var __resources = RESOURCES_PLACEHOLDER;
  // 握手态：wrapper 可能早于桥宿主挂 gmreq 监听（@run-at document-end/start 早于宿主的
  // document_idle + 异步拉 token）。宿主未就绪时 gmreq 派发进虚空、请求永挂——故未就绪先入
  // backlog，收到 gmhost 就绪信号再冲刷（见 shared/gm-bridge.ts 握手注释）。
  var __GM_hostReady = false;
  var __GM_backlog = [];
  function __GM_send(detail) {
    window.dispatchEvent(new CustomEvent('gmreq:' + __GM_id, { detail: detail }));
  }
  function __GM_post(api, params) {
    return new Promise(function (resolve, reject) {
      var reqId = ++__GM_reqSeq;
      __GM_pending.set(reqId, { resolve: resolve, reject: reject });
      var detail = { token: __GM_token, reqId: reqId, api: api, params: params };
      if (__GM_hostReady) __GM_send(detail);
      else __GM_backlog.push(detail);
    });
  }
  // 收到宿主就绪信号：置位 + 冲刷 backlog（取出并清空，重复 gmhost 到达时 backlog 已空，幂等）。
  window.addEventListener('gmhost:' + __GM_id, function () {
    __GM_hostReady = true;
    if (__GM_backlog.length) {
      var pend = __GM_backlog;
      __GM_backlog = [];
      for (var i = 0; i < pend.length; i++) __GM_send(pend[i]);
    }
  });
  // 宣告 wrapper 就绪并问询：宿主若已就绪会收到 gmhello 重发 gmhost；若未就绪，宿主 attachFor
  // 时主动发首个 gmhost。gmhost 监听器已在上方挂好，故重发能被接住。
  window.dispatchEvent(new CustomEvent('gmhello:' + __GM_id));
  window.addEventListener('gmres:' + __GM_id, function (e) {
    var d = e.detail || {};
    var p = __GM_pending.get(d.reqId);
    if (!p) return;
    __GM_pending.delete(d.reqId);
    if (d.ok) p.resolve(d.data); else p.reject(new Error(d.error || 'GM bridge error'));
  });
  window.addEventListener('gmevt:' + __GM_id, function (e) {
    var d = e.detail || {};
    if (d.kind === 'VALUE_CHANGE') {
      var hooks = __GM_valueHooks.get(d.data.key);
      if (hooks) hooks.forEach(function (fn) { fn(d.data.key, d.data.oldValue, d.data.newValue, d.data.remote); });
    } else if (d.kind === 'MENU_CLICK') {
      var cb = __GM_listeners.get('menu:' + d.data.key);
      if (cb) cb();
    } else if (d.kind === 'NOTIF_CLICK') {
      var nc = __GM_listeners.get('notif:' + d.data.id);
      if (nc) nc(d.data.byUser ? 'click' : 'close');
    } else if (d.kind === 'TAB_EVENT') {
      var tc = __GM_listeners.get('tab:' + d.data.tabId);
      if (tc) tc(d.data);
    }
  });
  function __GM_report(message, stack, line) {
    try { __GM_post('ReportError', [message, stack, line]); } catch (e) { /* 上报失败静默 */ }
  }
  // 递归摘除对象里的函数（onload/onerror 等回调不过桥——跨 world 结构化克隆会把含函数的
  // detail 克隆失败变 null，宿主静默丢弃导致请求永挂）。纯数据（字符串/数字/布尔/数组/ Plain object）保留。
  function __GM_plain(v) {
    if (v === null || typeof v !== 'object') {
      return typeof v === 'function' ? undefined : v;
    }
    if (Array.isArray(v)) {
      var arr = [];
      for (var i = 0; i < v.length; i++) {
        var item = __GM_plain(v[i]);
        if (item !== undefined) arr.push(item);
      }
      return arr;
    }
    var out = {};
    for (var k in v) {
      if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
      var val = __GM_plain(v[k]);
      if (val !== undefined) out[k] = val;
    }
    return out;
  }
  // 可变参 Function 构造器：预编译探测（只编译不执行）与用户代码执行共用语言级构造。
  // 构造器返回对象覆盖 new 产物，故 new __GM_probe(...) 直接得到编译出的函数。
  // 注意：Function 构造体只认全局作用域——wrapper 闭包变量对用户代码不可见，
  // 执行体经形参注入（见 tail），形参名/实参一一对应。
  function __GM_probe() { return Function.apply(null, [].slice.call(arguments)); }
  // 点形式 GM.xxx 以 GM 自身为命名空间宿主；下划线形式挂 GM 对象并返回 fn（赋给同名闭包 var）。
  function install(name, fn) {
    var dot = name.indexOf('.');
    if (dot > 0) { GM[name.slice(dot + 1)] = fn; return fn; }
    GM[name] = fn;
    return fn;
  }
  // 全局错误钩子（spec §4 组 9）：tail 的 try/catch 只包住初次同步执行，脚本生命周期内
  // 的后继未捕获异常（事件回调 / setTimeout 等异步路径）经此上报进 SW 错误缓冲。
  // 资源加载错误（target 非全局对象）不是脚本异常，跳过防误报。
  window.addEventListener('error', function (e) {
    if (e.target && e.target !== window) return;
    __GM_report(String(e.message || 'Unknown error'), (e.error && String(e.error.stack)) || '', e.lineno || 0);
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    __GM_report('UnhandledRejection: ' + ((r && r.message) || String(r)), (r && String(r.stack)) || '', 0);
  });
`;
}

/** 下划线 API 安装表（grant 名 → 安装表达式）。emit 顺序即安装顺序（无依赖，稳定即可）。 */
const GM_INSTALLS: ReadonlyArray<readonly [string, string]> = [
  ['GM_info', 'GM_info'],
  ['GM_getValue', 'function (key, def) { var v = __values[key]; return v === undefined ? def : v; }'],
  ['GM_setValue', 'function (key, val) { __values[key] = val; __GM_post("SetValue", [key, val]); }'],
  ['GM_deleteValue', 'function (key) { delete __values[key]; __GM_post("DeleteValue", [key]); }'],
  ['GM_listValues', 'function () { return Object.keys(__values); }'],
  ['GM_addValueChangeListener', 'function (key, fn) { var arr = __GM_valueHooks.get(key) || []; arr.push(fn); __GM_valueHooks.set(key, arr); return key + ":" + (arr.length - 1); }'],
  ['GM_addStyle', 'function (css) { var el = document.createElement("style"); el.textContent = css; (document.head || document.documentElement).appendChild(el); return el; }'],
  ['GM_getResourceText', 'function (name) { return __resources[name]; }'],
  ['GM_log', 'function () { var a = [].slice.call(arguments); a.unshift(GM_info.script.name); console.log.apply(console, a); }'],
  ['GM_registerMenuCommand', 'function (name, fn) { var key = "m" + (++__GM_reqSeq); __GM_listeners.set("menu:" + key, fn); __GM_post("RegisterMenu", [key, name]); return key; }'],
  ['GM_setClipboard', 'function (text) { return __GM_post("SetClipboard", [text]); }'],
  ['GM_notification', 'function (details, ondone) { var id = "n" + (++__GM_reqSeq); if (ondone) __GM_listeners.set("notif:" + id, ondone); __GM_post("Notification", [__GM_plain(details), id]); }'],
  ['GM_openInTab', 'function (url, opts) { opts = opts || {}; var h = { closed: false, onclose: null, __tabId: null, close: function () { if (h.__tabId != null) { __GM_post("CloseTab", [h.__tabId]); } else { h.__closePending = true; } } }; __GM_post("OpenInTab", [url, __GM_plain(opts)]).then(function (tabId) { h.__tabId = tabId; if (h.__closePending) { __GM_post("CloseTab", [tabId]); } __GM_listeners.set("tab:" + tabId, function (d) { h.closed = !!d.closed; if (d.closed && h.onclose) h.onclose(); }); }); return h; }'],
  // details 经 __GM_plain 摘除回调函数再过桥：CustomEvent detail 跨 world（USER_SCRIPT→ISOLATED）
  // 走结构化克隆，函数不可克隆会使 detail 变 null（宿主静默丢弃，请求永挂无任何回显）。
  // onload/onerror/ontimeout 留在闭包里，由 .then 分支调用。
  ['GM_xmlhttpRequest', 'function (details) { var d = __GM_plain(details); __GM_post("XmlHttpRequest", [d]).then(function (resp) { if (resp && resp.error) { details.onerror && details.onerror(resp); } else { details.onload && details.onload(resp); } }, function (err) { details.onerror && details.onerror({ error: String(err) }); }); return { abort: function () {} }; }'],
] as const;

function installLines(script: UserScript): { code: string; vars: string[] } {
  // 按 @grant 精确安装（spec §5）；下划线形式同步语义、点形式 Promise（双形态决策）。
  // vars：grant 过的下划线 API 名——install 在 IIFE 内动态挂 GM 对象，但闭包变量必须
  // 静态 var 声明（用户代码经 Function 形参注入作用域，argList 引用裸标识符）。
  const grants = script.meta?.grants ?? [];
  const real = grants.filter((g) => g !== 'none' && !SPECIAL_GRANTS.has(g));
  const lines: string[] = [];
  const vars: string[] = [];
  const emit = (name: string, syncExpr: string) => {
    lines.push(`  ${name} = install(${J(name)}, ${syncExpr});`);
    vars.push(name);
    const def = GM_API_REGISTRY[name];
    if (def?.promiseForm) {
      const dot = name.replace(/^GM_/, 'GM.');
      lines.push(`  install(${J(dot)}, function () { var a = [].slice.call(arguments); var r = GM[${J(name)}].apply(null, a); return r && typeof r.then === 'function' ? r : Promise.resolve(r); });`);
    }
  };
  for (const [name, expr] of GM_INSTALLS) {
    if (real.includes(name)) emit(name, expr);
  }
  return { code: lines.join('\n'), vars };
}

/** 拼装完整注入代码。无 grant 且无 @require → 返回裸 code（spec §5 零开销）。 */
export function buildWrappedCode(script: UserScript, deps: WrapperDeps): string {
  const grants = script.meta?.grants ?? [];
  const hasRequires = (script.meta?.requires?.length ?? 0) > 0;
  const realGrants = grants.filter((g) => g !== 'none');
  if (realGrants.length === 0 && !hasRequires) return script.code;

  // 替换用函数形式：避免 JSON 产物里的 $&/$' 等序列被 replace 当替换模式解释
  const head = preamble(script.id)
    .replace('TOKEN_PLACEHOLDER', () => J(deps.token))
    .replace('VALUES_PLACEHOLDER', () => J(deps.values))
    .replace('RESOURCES_PLACEHOLDER', () => J(deps.resources))
    .replace('GMINFO_PLACEHOLDER', () => gmInfoLiteral(script, deps.extensionVersion));

  // 用户代码执行体：@require 前置拼接（require 与用户代码共享同一函数作用域，TM 同款），
  // 以 JSON 转义字符串字面量嵌进 Function 构造器——对反引号/引号/换行等任意用户代码字符安全。
  const body = [...deps.requireCodes.map((c) => `${c};`), script.code].join('\n');
  const bodyLit = J(body);

  // 用户代码执行作用域注入：wrapper 闭包变量经 Function 形参传入
  // （Function 构造体只认全局作用域，闭包变量必须显式注入才能对用户代码可见）。
  // GM/GM_info/unsafeWindow 始终可见（preamble 无条件定义；GM.info 同引用）；下划线 API 按 grant 精确注入。
  const { code: installs, vars } = installLines(script);
  const apiVars = vars.filter((n) => n !== 'GM_info');
  const params = ['GM', 'GM_info', 'unsafeWindow', ...apiVars];
  const paramList = params.map((n) => J(n)).join(', ');
  const argList = params.join(', ');

  // 下划线 API 的 IIFE 闭包 var 声明段（hoisting 无依赖，与 install 行序无关）
  const varDecl = apiVars.length > 0 ? `  var ${apiVars.join(', ')};\n` : '';

  // 预编译探测（语法错误上报，spec §5；wrapper 主体独立解析，用户代码语法错误不炸整段）+ try/catch 执行。
  // 探测只编译（new Function 不执行），执行体同一份 body 经形参注入作用域后立即调用。
  const tail = `
  try { new __GM_probe(${bodyLit}); } catch (e) {
    console.error('[' + GM_info.script.name + '] 语法错误:', e && e.message);
    __GM_report('SyntaxError: ' + (e && e.message), String(e && e.stack), 0);
    return;
  }
  try { new __GM_probe(${paramList ? paramList + ', ' : ''}${bodyLit})(${argList}); } catch (e) {
    console.error('[' + GM_info.script.name + ']', e);
    __GM_report(String(e && e.message), String(e && e.stack), e && e.lineNumber || 0);
  }
})();
`;

  return [head, varDecl, installs + '\n', tail].join('\n');
}
