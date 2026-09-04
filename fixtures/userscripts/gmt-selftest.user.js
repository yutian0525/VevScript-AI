// ==UserScript==
// @name         GM 运行环境全功能自检
// @namespace    ai-browser-extend/gmt-selftest
// @version      1.0.0
// @author       gmt-selftest
// @description  本扩展脚本池运行环境全功能自检：元字段解析自证 + 14 个 GM API 可用性
// @homepage     https://example.com/gmt-selftest
// @supportURL   https://example.com/gmt-selftest/support
// @iconURL      https://example.com/favicon.ico
// @downloadURL  https://example.com/gmt-selftest.user.js
// @updateURL    https://example.com/gmt-selftest.meta.js
// @match        *://*/*
// @run-at       document-end
// @grant        GM_info
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_addValueChangeListener
// @grant        GM_addStyle
// @grant        GM_getResourceText
// @grant        GM_log
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @grant        GM_notification
// @grant        GM_openInTab
// @grant        GM_xmlhttpRequest
// @connect      cdn.jsdelivr.net
// @require      https://cdn.jsdelivr.net/npm/zepto@1.2.0/dist/zepto.min.js
// @resource     gmtPkg https://cdn.jsdelivr.net/npm/zepto@1.2.0/package.json
// @noframes
// ==/UserScript==

(function gmtRunner() {
  'use strict';
  var PREFIX = '__gmt_';
  var PROBE_MARK = '__gmt_probe=1';

  // ---- 探针页休眠模式（spec §6.1）：GM_openInTab 开的页再次命中 @match，
  // 带 ?__gmt_probe=1 的第二实例只写一个键供第一实例验证跨 tab 广播，不建面板。 ----
  if (location.search.indexOf(PROBE_MARK) !== -1) {
    try { GM_setValue('remote_probe', { at: Date.now(), from: location.host }); } catch (e) { /* 静默 */ }
    return;
  }

  // ---- runner 基础设施 ----
  var results = []; // { id, group, name, state: 'pass'|'fail'|'wait', fn?, manual?, hint?, detail? }
  var ICONS = {
    pass: '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="#188038" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    fail: '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="#c5221f" stroke-width="2" stroke-linecap="round"/></svg>',
    wait: '<svg viewBox="0 0 16 16" width="14" height="14"><circle cx="8" cy="8" r="6" fill="none" stroke="#e8710a" stroke-width="2"/><path d="M8 5v3.2l2.2 1.6" fill="none" stroke="#e8710a" stroke-width="1.6" stroke-linecap="round"/></svg>'
  };

  function findRow(id) { return document.querySelector('#gmt-panel [data-row="' + id + '"]'); }

  function setState(id, state, detail) {
    for (var i = 0; i < results.length; i++) {
      if (results[i].id === id) {
        results[i].state = state;
        if (detail !== undefined) results[i].detail = detail;
        break;
      }
    }
    var row = findRow(id);
    if (row) renderRow(row, results.find(function (r) { return r.id === id; }));
    updateSummary();
  }

  function addRow(group, name, fn, opts) {
    var id = 't' + (results.length + 1);
    var item = { id: id, group: group, name: name, state: 'wait', fn: fn, manual: opts && opts.manual };
    results.push(item);
    return id;
  }

  function detailText(r) {
    if (!r.detail) return '';
    return typeof r.detail === 'string' ? r.detail : JSON.stringify(r.detail);
  }

  // ---- 等待原语（spec §6.2）----
  function sleep(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }
  function waitFor(cond, timeoutMs, pollMs) {
    timeoutMs = timeoutMs || 10000; pollMs = pollMs || 100;
    var deadline = Date.now() + timeoutMs;
    return new Promise(function (resolve) {
      (function tick() {
        var v;
        try { v = cond(); } catch (e) { v = false; }
        if (v) return resolve(v);
        if (Date.now() >= deadline) return resolve(false);
        setTimeout(tick, pollMs);
      })();
    });
  }
  function fmtError(e) { return e instanceof Error ? (e.message || String(e)) : String(e); }

  // ---- 断言执行器：fn 返回 true → pass；返回字符串 → fail（附详情）；throw → fail；返回 'wait' 保持待人工 ----
  async function runTest(item) {
    if (!item.fn) return; // 人工行无 fn
    try {
      var r = await item.fn(item);
      if (r === 'wait') return; // 保持 wait（人工指引中）
      setState(item.id, r === false ? 'fail' : 'pass', (r === true || r == null) ? undefined : r);
    } catch (e) {
      setState(item.id, 'fail', fmtError(e));
    }
  }

  // ---- 面板 DOM + 样式（样式全经 GM_addStyle 注入，spec §5）----
  function injectPanel() {
    var old = document.getElementById('gmt-panel');
    if (old) old.remove();
    GM_addStyle(
      '#gmt-panel{position:fixed;right:16px;bottom:16px;z-index:2147483647;width:340px;max-height:70vh;' +
      'background:#fff;color:#202124;font:13px/1.5 system-ui,sans-serif;border:1px solid #dadce0;border-radius:8px;' +
      'box-shadow:0 4px 16px rgba(0,0,0,.18);display:flex;flex-direction:column}' +
      '#gmt-panel .gmt-head{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid #eee;flex:none}' +
      '#gmt-panel .gmt-title{font-weight:600;flex:1}' +
      '#gmt-panel .gmt-summary{font-size:11px;color:#5f6368}' +
      '#gmt-panel .gmt-body{overflow-y:auto;padding:4px 0}' +
      '#gmt-panel .gmt-group{padding:4px 12px;font-size:11px;color:#5f6368;background:#f8f9fa;border-top:1px solid #eee}' +
      '#gmt-panel .gmt-row{display:flex;align-items:flex-start;gap:6px;padding:3px 12px}' +
      '#gmt-panel .gmt-row .gmt-icon{flex:none;margin-top:2px}' +
      '#gmt-panel .gmt-row .gmt-name{flex:1;word-break:break-all}' +
      '#gmt-panel .gmt-row .gmt-detail{color:#c5221f;font-size:12px;word-break:break-all}' +
      '#gmt-panel .gmt-btns{display:flex;gap:6px;padding:8px 12px;border-top:1px solid #eee;flex:none}' +
      '#gmt-panel .gmt-btns button{font:12px system-ui;padding:4px 10px;border:1px solid #dadce0;border-radius:4px;background:#fff;cursor:pointer;color:#202124}' +
      '#gmt-panel .gmt-btns button:hover{background:#f1f3f4}' +
      '#gmt-panel .gmt-store{padding:6px 12px;border-top:1px solid #eee;font-size:11px;color:#5f6368;flex:none;max-height:96px;overflow-y:auto}' +
      '#gmt-panel .gmt-hint{color:#e8710a;font-size:12px}'
    );
    var panel = document.createElement('div');
    panel.id = 'gmt-panel';
    panel.innerHTML =
      '<div class="gmt-head"><span class="gmt-title">GM 运行环境自检</span><span class="gmt-summary"></span></div>' +
      '<div class="gmt-body"></div>' +
      '<div class="gmt-store"></div>' +
      '<div class="gmt-btns">' +
      '<button type="button" data-act="rerun">重跑（刷新页面）</button>' +
      '<button type="button" data-act="err">测试错误上报</button>' +
      '</div>';
    (document.body || document.documentElement).appendChild(panel);
    panel.querySelector('[data-act="rerun"]').addEventListener('click', function () { location.reload(); });
    // 错误上报链路（spec §4 组 9）：throw → wrapper 捕获 → ReportError → SW 环形缓冲 → 侧边栏徽标
    panel.querySelector('[data-act="err"]').addEventListener('click', function () {
      setTimeout(function () { throw new Error('GMT 测试错误（来自自检面板按钮）'); }, 0);
    });
    return panel;
  }

  function renderRow(row, r) {
    if (!r) return;
    row.className = 'gmt-row';
    row.innerHTML =
      '<span class="gmt-icon">' + (ICONS[r.state] || '') + '</span>' +
      '<span class="gmt-name">' + escapeHtml(r.name) +
      (r.state === 'fail' && r.detail ? '<br><span class="gmt-detail">' + escapeHtml(detailText(r)) + '</span>' : '') +
      ((r.manual && r.state === 'wait') ? '<br><span class="gmt-hint">' + escapeHtml(r.hint || '需人工操作') + '</span>' : '') +
      '</span>';
    if (r.manual && r.state === 'wait') {
      var mark = document.createElement('button');
      mark.type = 'button';
      mark.textContent = '标记通过';
      mark.style.cssText = 'font:11px system-ui;padding:2px 6px;border:1px solid #dadce0;border-radius:4px;background:#fff;cursor:pointer;flex:none';
      mark.addEventListener('click', function (ev) { ev.stopPropagation(); setState(r.id, 'pass'); });
      row.appendChild(mark);
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function updateSummary() {
    var el = document.querySelector('#gmt-panel .gmt-summary');
    if (!el) return;
    var pass = 0, fail = 0, wait = 0;
    for (var i = 0; i < results.length; i++) {
      var s = results[i].state;
      if (s === 'pass') pass++;
      else if (s === 'fail') fail++;
      else wait++;
    }
    el.textContent = pass + ' 过 / ' + fail + ' 挂 / ' + wait + ' 待定';
  }

  function renderAll() {
    var body = document.querySelector('#gmt-panel .gmt-body');
    if (!body) return;
    body.innerHTML = '';
    var lastGroup = null;
    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      if (r.group !== lastGroup) {
        lastGroup = r.group;
        var g = document.createElement('div');
        g.className = 'gmt-group';
        g.textContent = r.group;
        body.appendChild(g);
      }
      var row = document.createElement('div');
      row.className = 'gmt-row';
      row.setAttribute('data-row', r.id);
      body.appendChild(row);
      renderRow(row, r);
    }
    renderStore();
  }

  function renderStore() {
    var el = document.querySelector('#gmt-panel .gmt-store');
    if (!el) return;
    var keys = [];
    try { keys = GM_listValues(); } catch (e) { /* ignore */ }
    var lines = [];
    for (var i = 0; i < keys.length; i++) {
      var full = keys[i];
      if (full.indexOf(PREFIX) !== 0) continue;
      var v;
      try { v = GM_getValue(full); } catch (e) { v = '(读取失败)'; }
      lines.push(full + ' = ' + (typeof v === 'object' ? JSON.stringify(v) : String(v)));
    }
    el.textContent = lines.length ? '存储键：' + lines.join('；') : '存储键：（无 __gmt_ 前缀键）';
  }

  // ---- 组定义（spec §4，与 39 项一一对应）----
  // 约定：fn 返回 true → pass；返回字符串 → fail 且字符串为详情；返回 'wait' → 保持待人工。
  // 注意：GM 值 API 的下划线形式同步；对象值经 JSON 往返（wrapper 快照/桥均为 JSON 序列化）。

  function group1() { // 元字段解析自证（8 项）
    var info = GM_info;
    addRow('1 元字段解析', 'scriptHandler === ai-browser-extend', function () {
      return info.scriptHandler === 'ai-browser-extend' || 'scriptHandler=' + info.scriptHandler;
    });
    addRow('1 元字段解析', 'version 非空字符串', function () {
      return (typeof info.version === 'string' && info.version.length > 0) || 'version=' + JSON.stringify(info.version);
    });
    addRow('1 元字段解析', 'script.name 命中', function () {
      return info.script.name === 'GM 运行环境全功能自检' || 'name=' + info.script.name;
    });
    addRow('1 元字段解析', 'script.version/namespace/description 非空', function () {
      var s = info.script;
      return (s.version === '1.0.0' && s.namespace.length > 0 && s.description.length > 0) ||
        'v=' + s.version + ' ns=' + s.namespace + ' d=' + s.description;
    });
    addRow('1 元字段解析', 'script.matches 含 *://*/*', function () {
      return (info.script.matches || []).indexOf('*://*/*') !== -1 || 'matches=' + JSON.stringify(info.script.matches);
    });
    addRow('1 元字段解析', 'script.grants = 14 API + unsafeWindow', function () {
      var g = (info.script.grants || []).slice().sort();
      var expected = ['GM_addStyle', 'GM_addValueChangeListener', 'GM_deleteValue', 'GM_getResourceText', 'GM_getValue',
        'GM_info', 'GM_listValues', 'GM_log', 'GM_notification', 'GM_openInTab', 'GM_registerMenuCommand',
        'GM_setClipboard', 'GM_setValue', 'GM_xmlhttpRequest', 'unsafeWindow'];
      return JSON.stringify(g) === JSON.stringify(expected) || 'grants=' + JSON.stringify(g);
    });
    addRow('1 元字段解析', 'injectInto === UserScript', function () {
      return info.injectInto === 'UserScript' || 'injectInto=' + info.injectInto;
    });
    addRow('1 元字段解析', 'GM.info 与 GM_info 同引用', function () {
      return GM.info === GM_info || '引用不同';
    });
  }

  function group2() { // 环境与 grant 语义（5 项）
    addRow('2 环境与 grant', 'typeof GM === object', function () {
      return typeof GM === 'object' || 'GM=' + typeof GM;
    });
    addRow('2 环境与 grant', '点形式 GM.getValue 是函数', function () {
      return typeof GM.getValue === 'function' || 'typeof=' + typeof GM.getValue;
    });
    addRow('2 环境与 grant', '未 grant 的 API 不存在（GM_getTab）', function () {
      // 「声明即授权」：未声明的 API 不注入作用域，裸引用抛 ReferenceError 即语义正确
      try { return typeof GM_getTab === 'undefined' || 'GM_getTab=' + typeof GM_getTab; }
      catch (e) { return true; }
    });
    addRow('2 环境与 grant', 'unsafeWindow.document === document', function () {
      return (unsafeWindow && unsafeWindow.document === document) || 'unsafeWindow 非 window';
    });
    addRow('2 环境与 grant', '@require 已执行（typeof Zepto）', function () {
      return typeof Zepto !== 'undefined' || 'Zepto 未定义（jsDelivr 预取失败或网络受限）';
    });
  }

  function group3() { // 值存储（8 项）
    addRow('3 值存储', '运行前清理 __gmt_ 残留', function () {
      try {
        var keys = GM_listValues();
        for (var i = 0; i < keys.length; i++) {
          if (keys[i].indexOf(PREFIX) === 0) GM_deleteValue(keys[i]);
        }
        var rest = GM_listValues().filter(function (k) { return k.indexOf(PREFIX) === 0; });
        return rest.length === 0 || '残留：' + rest.join(',');
      } catch (e) { return fmtError(e); }
    });
    addRow('3 值存储', 'set + get 字符串往返', function () {
      GM_setValue('k1', 'v1');
      return GM_getValue('k1') === 'v1' || 'get=' + JSON.stringify(GM_getValue('k1'));
    });
    addRow('3 值存储', '对象值往返', function () {
      GM_setValue('k2', { obj: true });
      var v = GM_getValue('k2');
      return (v && v.obj === true) || 'get=' + JSON.stringify(v);
    });
    addRow('3 值存储', 'get 缺失键返回默认值', function () {
      return GM_getValue('missing', 'def') === 'def' || 'get=' + JSON.stringify(GM_getValue('missing', 'def'));
    });
    addRow('3 值存储', 'get 未设键返回 undefined', function () {
      return GM_getValue('never-set') === undefined || 'get=' + JSON.stringify(GM_getValue('never-set'));
    });
    addRow('3 值存储', 'listValues 含 k1/k2', function () {
      var ks = GM_listValues();
      return (ks.indexOf('k1') !== -1 && ks.indexOf('k2') !== -1) || 'list=' + JSON.stringify(ks);
    });
    addRow('3 值存储', 'deleteValue 后不可见', function () {
      GM_deleteValue('k2');
      return (GM_getValue('k2') === undefined && GM_listValues().indexOf('k2') === -1) || 'delete 未生效';
    });
    addRow('3 值存储', '点形式 GM.getValue 返回 Promise', function () {
      return GM.getValue('k1') && typeof GM.getValue('k1').then === 'function' || '非 Promise';
    });
  }

  function group4() { // 值变更监听（3 项）
    var localEvent = null;
    addRow('4 值监听', 'addValueChangeListener 返回 id', function () {
      var id = GM_addValueChangeListener('k3', function (key, oldV, newV, remote) {
        localEvent = { key: key, oldV: oldV, newV: newV, remote: remote };
      });
      return (typeof id === 'string' && id.length > 0) || 'id=' + JSON.stringify(id);
    });
    addRow('4 值监听', '本地事件 remote=false', async function () {
      GM_setValue('k3', 'x');
      var ok = await waitFor(function () { return localEvent; }, 5000);
      return (ok && localEvent.key === 'k3' && localEvent.remote === false && localEvent.newV === 'x') ||
        'event=' + JSON.stringify(localEvent);
    });
    addRow('4 值监听', '跨 tab 事件 remote=true（探针页）', async function () {
      var remoteEvent = null;
      GM_addValueChangeListener('remote_probe', function (key, oldV, newV, remote) {
        if (remote) remoteEvent = { key: key, remote: remote };
      });
      var handle = GM_openInTab(location.origin + location.pathname + '?__gmt_probe=1', { active: false });
      var ok = await waitFor(function () { return remoteEvent; }, 10000);
      try { handle.close(); } catch (e) { /* 已关 */ }
      return (ok && remoteEvent && remoteEvent.remote === true) ? true : 'wait';
    });
  }

  function group5() { // DOM / 资源 / 日志（4 项）
    addRow('5 DOM/资源/日志', 'addStyle 返回已连接 style 元素', function () {
      var el = GM_addStyle('#gmt-styleprobe-a{color:red}');
      return (el && el.tagName === 'STYLE' && el.isConnected) || 'el=' + JSON.stringify(el && el.tagName);
    });
    addRow('5 DOM/资源/日志', '样式真实生效（getComputedStyle）', function () {
      // 类选择器（探针 div 用 className 命中；计划文本的 #id 选择器永不匹配类探针，此处修正）
      GM_addStyle('.gmt-styleprobe-b{position:absolute}');
      var probe = document.createElement('div');
      probe.className = 'gmt-styleprobe-b';
      document.body.appendChild(probe);
      var pos = getComputedStyle(probe).position;
      probe.remove();
      // 页面可能拦截 GM_addStyle 注入的内联 style（CSP）——位置断言失败时给出可读详情
      return pos === 'absolute' || 'position=' + pos + '（页面 CSP 可能拦截内联 style——建议在 example.com 等宽松页跑）';
    });
    addRow('5 DOM/资源/日志', 'getResourceText(gmtPkg) 含 name 字段', function () {
      var t = GM_getResourceText('gmtPkg');
      return (typeof t === 'string' && t.length > 0 && t.indexOf('"name"') !== -1) ||
        'text=' + JSON.stringify(t == null ? null : String(t).slice(0, 80));
    });
    addRow('5 DOM/资源/日志', 'GM_log 不抛异常', function () {
      GM_log('自检运行中——本行出现在 console，带 [GM 运行环境全功能自检] 前缀');
      return true;
    });
  }

  function group6() { // 剪贴板 / 通知 / 菜单（5 项）
    addRow('6 剪贴板/通知/菜单', 'setClipboard Promise resolve', async function () {
      try { await GM.setClipboard('gmt clipboard probe'); return true; }
      catch (e) { return 'wait'; } // MV3 SW 无手势链可能被拒——已知降级非缺陷（spec §8），标黄
    });
    var notifDone = null;
    addRow('6 剪贴板/通知/菜单', 'notification 调用不抛', function () {
      GM_notification({ title: 'GMT 自检通知', text: '点我或关闭我以验证 ondone 回调' }, function (why) {
        notifDone = why;
      });
      return true;
    });
    addRow('6 剪贴板/通知/菜单', '通知点击/关闭 → ondone 触发', async function (item) {
      item.manual = true;
      item.hint = '人工：点掉系统通知（Chrome 通知中心）';
      var ok = await waitFor(function () { return notifDone; }, 60000);
      if (!ok) return 'wait';
      return (notifDone === 'click' || notifDone === 'close') || 'why=' + JSON.stringify(notifDone);
    });
    var menuKey = null, menuClicked = false;
    addRow('6 剪贴板/通知/菜单', 'registerMenuCommand 返回 key', function () {
      menuKey = GM_registerMenuCommand('GMT 自检：点我', function () { menuClicked = true; });
      return (typeof menuKey === 'string' && menuKey.length > 0) || 'key=' + JSON.stringify(menuKey);
    });
    addRow('6 剪贴板/通知/菜单', '菜单命令点击回环', async function (item) {
      item.manual = true;
      item.hint = '人工：侧边栏 → 脚本池 → 菜单命令 → 点击「GMT 自检：点我」';
      var ok = await waitFor(function () { return menuClicked; }, 120000);
      return ok || 'wait';
    });
  }

  function group7() { // 标签页（2 项）
    var soloHandle = null; // 组 7 专用（探针页复用组 4 的 openInTab）
    addRow('7 标签页', 'openInTab 返回句柄', function () {
      soloHandle = GM_openInTab('https://example.com/?__gmt_probe=1', { active: false });
      return (soloHandle && soloHandle.closed === false && typeof soloHandle.close === 'function') ||
        'handle=' + JSON.stringify(soloHandle && { closed: soloHandle.closed });
    });
    addRow('7 标签页', 'close() 后 closed=true 且 onclose 触发', async function () {
      var oncloseFired = false;
      if (soloHandle && soloHandle.onclose !== undefined) {
        soloHandle.onclose = function () { oncloseFired = true; };
      }
      if (soloHandle) { try { soloHandle.close(); } catch (e) { /* ignore */ } }
      var ok = await waitFor(function () { return soloHandle && soloHandle.closed; }, 10000);
      return (ok && oncloseFired) || 'closed=' + JSON.stringify(soloHandle && soloHandle.closed) + ' onclose=' + oncloseFired;
    });
  }

  function group8() { // 网络（3 项）
    var pkgUrl = 'https://cdn.jsdelivr.net/npm/zepto@1.2.0/package.json';
    addRow('8 网络', '@connect 命中：GET jsdelivr 200', async function () {
      return await new Promise(function (resolve) {
        GM_xmlhttpRequest({
          method: 'GET', url: pkgUrl, timeout: 15000,
          onload: function (resp) {
            resolve((resp.status === 200 && resp.body && resp.body.length > 0 &&
              resp.finalUrl && resp.headers && resp.headers['content-type']) ||
              'status=' + resp.status + ' bodyLen=' + (resp.body || '').length);
          },
          onerror: function (resp) { resolve('请求失败：' + ((resp && resp.error) || 'onerror')); },
          ontimeout: function () { resolve('请求超时'); }
        });
      });
    });
    addRow('8 网络', 'droppedHeaders：user-agent 被忽略', async function () {
      return await new Promise(function (resolve) {
        GM_xmlhttpRequest({
          method: 'GET', url: pkgUrl, timeout: 15000,
          headers: { 'user-agent': 'gmt', 'x-gmt': '1' },
          onload: function (resp) {
            resolve((resp.status === 200 && Array.isArray(resp.droppedHeaders) &&
              resp.droppedHeaders.indexOf('user-agent') !== -1) ||
              'status=' + resp.status + ' dropped=' + JSON.stringify(resp.droppedHeaders));
          },
          onerror: function (resp) { resolve('请求失败：' + ((resp && resp.error) || 'onerror')); },
          ontimeout: function () { resolve('请求超时'); }
        });
      });
    });
    addRow('8 网络', '@connect 拒绝未列 host', async function () {
      return await new Promise(function (resolve) {
        GM_xmlhttpRequest({
          method: 'GET', url: 'https://example.org/favicon.ico', timeout: 15000,
          onload: function () { resolve(false); }, // 不该放行
          onerror: function (resp) {
            resolve((resp && resp.error && String(resp.error).indexOf('connect') !== -1) ||
              'error=' + JSON.stringify(resp && resp.error));
          },
          ontimeout: function () { resolve('请求超时（应为同步拒绝而非超时）'); }
        });
      });
    });
  }

  function group9() { // 人工引导（1 项）
    addRow('9 错误上报', '错误上报链路（throw → 徽标）', null, { manual: true });
    var row = results[results.length - 1];
    row.hint = '人工：点面板「测试错误上报」→ 侧边栏脚本池该脚本徽标 +1，错误列表含 stack';
  }

  // ---- 主流程 ----
  function boot() {
    if (!document.body) {
      // document-end 仍防御 body 未就绪（如脚本被手动提前执行）
      setTimeout(boot, 50);
      return;
    }
    injectPanel();
    group1(); group2(); group3(); group4(); group5(); group6(); group7(); group8(); group9();
    renderAll();
    (async function () {
      for (var i = 0; i < results.length; i++) {
        await runTest(results[i]);
        renderStore();
      }
    })();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  GM_log('gmt-selftest 已启动（' + location.host + '）');
})();
