// ==UserScript==
// @name         GM 手测·网络
// @namespace    ai-browser-extend/gmt-manual
// @version      1.0.0
// @description  GM 网络模块人工测试：说明 + 步骤 + 人工标记
// @match        *://*/*
// @run-at       document-end
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_addStyle
// @connect      cdn.jsdelivr.net
// @noframes
// ==/UserScript==

(function () {
'use strict';
// _panel-core.js —— gmt-manual-* 共享面板内核（拼接时内联进各产物 IIFE，非独立脚本）。
// 依赖调用方提供 CFG（render({module,title,cards,probe?}) 的实参，见各模块源的 GMT.render 调用）。
// 注意：var CFG; 必须声明在本 IIFE 外、var GMT = 之前（拼接进产物 IIFE 后，var 提升使其成为该 IIFE 的函数作用域变量）。
var CFG;
var GMT = (function () {
  var PREFIX = '__gmt_manual_';
  var ICONS = {
    pass: '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="#188038" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    fail: '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="#c5221f" stroke-width="2" stroke-linecap="round"/></svg>',
    none: '<svg viewBox="0 0 16 16" width="14" height="14"><circle cx="8" cy="8" r="5.5" fill="none" stroke="#9aa0a6" stroke-width="1.6"/></svg>'
  };

  function storeKey() { return PREFIX + CFG.module; }

  function loadResults() {
    try {
      var raw = GM_getValue(storeKey());
      return raw && typeof raw === 'object' ? raw : {};
    } catch (e) { return {}; }
  }

  function saveResult(id, verdict, note) {
    var all = loadResults();
    all[id] = { verdict: verdict, note: note || '', at: Date.now() };
    try { GM_setValue(storeKey(), all); } catch (e) { /* 存储失败不阻断面板 */ }
  }

  function resetResults() {
    try { GM_deleteValue(storeKey()); } catch (e) { /* ignore */ }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function injectStyles() {
    GM_addStyle(
      '#gmt-panel{position:fixed;right:16px;bottom:16px;z-index:2147483647;width:380px;max-height:75vh;' +
      'background:#fff;color:#202124;font:13px/1.5 system-ui,sans-serif;border:1px solid #dadce0;border-radius:8px;' +
      'box-shadow:0 4px 16px rgba(0,0,0,.18);display:flex;flex-direction:column}' +
      '#gmt-panel .gmt-head{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid #eee;flex:none}' +
      '#gmt-panel .gmt-title{font-weight:600;flex:1}' +
      '#gmt-panel .gmt-summary{font-size:11px;color:#5f6368}' +
      '#gmt-panel .gmt-body{overflow-y:auto;padding:4px 0}' +
      '#gmt-panel .gmt-card{padding:8px 12px;border-bottom:1px solid #f1f3f4}' +
      '#gmt-panel .gmt-api{font:12px ui-monospace,monospace;background:#f8f9fa;border-radius:4px;padding:2px 6px;display:inline-block}' +
      '#gmt-panel .gmt-desc{margin:4px 0 0;color:#3c4043}' +
      '#gmt-panel .gmt-steps{margin:4px 0 0;padding-left:18px;color:#3c4043}' +
      '#gmt-panel .gmt-expect{margin:4px 0 0;color:#188038;font-size:12px}' +
      '#gmt-panel .gmt-verdict{margin:4px 0 0;display:flex;gap:6px;align-items:center}' +
      '#gmt-panel .gmt-verdict button{font:12px system-ui;padding:3px 10px;border:1px solid #dadce0;border-radius:4px;background:#fff;cursor:pointer}' +
      '#gmt-panel .gmt-note{font:12px system-ui;padding:3px 6px;border:1px solid #dadce0;border-radius:4px;flex:1}' +
      '#gmt-panel .gmt-state{flex:none}' +
      '#gmt-panel .gmt-btns{display:flex;gap:6px;padding:8px 12px;border-top:1px solid #eee;flex:none}' +
      '#gmt-panel .gmt-btns button{font:12px system-ui;padding:4px 10px;border:1px solid #dadce0;border-radius:4px;background:#fff;cursor:pointer}' +
      '#gmt-panel .gmt-btns button:hover{background:#f1f3f4}' +
      '#gmt-panel .gmt-log{margin:4px 0 0;font:12px ui-monospace,monospace;background:#f8f9fa;border-radius:4px;padding:4px 6px;word-break:break-all;white-space:pre-wrap}'
    );
  }

  function buildPanel() {
    var old = document.getElementById('gmt-panel');
    if (old) old.remove();
    var panel = document.createElement('div');
    panel.id = 'gmt-panel';
    panel.innerHTML =
      '<div class="gmt-head"><span class="gmt-title">' + escapeHtml(CFG.title) + '</span><span class="gmt-summary"></span></div>' +
      '<div class="gmt-body"></div>' +
      '<div class="gmt-btns">' +
      '<button type="button" data-act="reset">重置本模块</button>' +
      '</div>';
    (document.body || document.documentElement).appendChild(panel);
    panel.querySelector('[data-act="reset"]').addEventListener('click', function () {
      resetResults();
      renderAll();
    });
    return panel;
  }

  // 卡片定义 {id, api, desc, steps, expect} → DOM。steps 可混入按钮项（供模块脚本挂交互，
  // 如「触发 setValue」「close()」）：字符串项渲染为有序步骤；对象项形状 { id: string, label: string }
  // 渲染为按钮，点击回调 CFG.actions[id]。
  function renderCard(card, results) {
    var el = document.createElement('div');
    el.className = 'gmt-card';
    el.setAttribute('data-card', card.id);
    var html =
      '<span class="gmt-api">' + escapeHtml(card.api) + '</span>' +
      '<p class="gmt-desc">' + escapeHtml(card.desc) + '</p>' +
      '<ol class="gmt-steps">';
    for (var i = 0; i < card.steps.length; i++) {
      var s = card.steps[i];
      html += '<li>' + (typeof s === 'string' ? escapeHtml(s) : '<button type="button" data-step-act="' + escapeHtml(s.id) + '">' + escapeHtml(s.label) + '</button>') + '</li>';
    }
    html += '</ol>' +
      '<p class="gmt-expect">期望：' + escapeHtml(card.expect) + '</p>' +
      '<div class="gmt-verdict">' +
      '<span class="gmt-state"></span>' +
      '<button type="button" data-verdict="pass">通过</button>' +
      '<button type="button" data-verdict="fail">失败</button>' +
      '<input class="gmt-note" placeholder="失败备注（可选）">' +
      '</div>' +
      '<div class="gmt-log" style="display:none"></div>';
    el.innerHTML = html;

    var r = results[card.id];
    var noteInput = el.querySelector('.gmt-note');
    if (r && r.note) noteInput.value = r.note;
    paintState(el, r);

    el.querySelectorAll('[data-verdict]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var verdict = btn.getAttribute('data-verdict');
        saveResult(card.id, verdict, noteInput.value.trim());
        paintState(el, loadResults()[card.id]);
        updateSummary();
      });
    });
    el.querySelectorAll('[data-step-act]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var fn = CFG.actions && CFG.actions[btn.getAttribute('data-step-act')];
        if (fn) fn(function (cardId, text) { GMT.log(cardId, text); }, card);
      });
    });
    return el;
  }

  function paintState(cardEl, r) {
    var stateEl = cardEl.querySelector('.gmt-state');
    if (r && r.verdict === 'pass') { stateEl.innerHTML = ICONS.pass; cardEl.style.background = '#f2f8f2'; }
    else if (r && r.verdict === 'fail') { stateEl.innerHTML = ICONS.fail; cardEl.style.background = '#fdf2f1'; }
    else { stateEl.innerHTML = ICONS.none; cardEl.style.background = ''; }
  }

  function logLine(cardId, text) {
    var el = document.querySelector('#gmt-panel [data-card="' + cardId + '"] .gmt-log');
    if (!el) return;
    el.style.display = '';
    el.textContent += text + '\n';
  }

  function updateSummary() {
    var el = document.querySelector('#gmt-panel .gmt-summary');
    if (!el) return;
    var pass = 0, fail = 0;
    for (var i = 0; i < CFG.cards.length; i++) {
      var r = loadResults()[CFG.cards[i].id];
      if (r && r.verdict === 'pass') pass++;
      else if (r && r.verdict === 'fail') fail++;
    }
    el.textContent = pass + ' 过 / ' + fail + ' 挂 / ' + (CFG.cards.length - pass - fail) + ' 未测';
  }

  function renderAll() {
    var body = document.querySelector('#gmt-panel .gmt-body');
    if (!body) return;
    var results = loadResults();
    body.innerHTML = '';
    for (var i = 0; i < CFG.cards.length; i++) body.appendChild(renderCard(CFG.cards[i], results));
    updateSummary();
  }

  return {
    render: function (cfg) {
      CFG = cfg;
      // 探针页休眠：带 probe.mark 的第二实例只写 probe.key 后返回，不建面板
      if (cfg.probe && location.search.indexOf(cfg.probe.mark) !== -1) {
        try { GM_setValue(cfg.probe.key, { at: Date.now(), from: location.host }); } catch (e) { /* 静默 */ }
        return;
      }
      injectStyles();
      function boot() {
        if (!document.body) { setTimeout(boot, 50); return; }
        buildPanel();
        renderAll();
      }
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
      else boot();
    },
    log: logLine
  };
})();

(function () {
  var PKG = 'https://cdn.jsdelivr.net/npm/zepto@1.2.0/package.json';

  // 无 @connect 版本全文（确认卡分支引导用）：临时脚本文本，人工导入触发确认卡
  var NO_CONNECT_SRC = [
    '// ==UserScript==',
    '// @name         GM 手测·网络确认卡',
    '// @namespace    ai-browser-extend/gmt-manual',
    '// @version      1.0.0',
    '// @description  触发 @connect 确认卡的临时脚本（测完删除）',
    '// @match        *://*/*',
    '// @run-at       document-end',
    '// @grant        GM_xmlhttpRequest',
    '// @grant        GM_log',
    '// @noframes',
    '// ==/UserScript==',
    '',
    '(function () {',
    '  GM_xmlhttpRequest({',
    '    method: "GET",',
    '    url: "https://cdn.jsdelivr.net/npm/zepto@1.2.0/package.json",',
    '    timeout: 15000,',
    '    onload: function (r) { GM_log("确认卡放行 → HTTP " + r.status); },',
    '    onerror: function (r) { GM_log("请求失败：" + ((r && r.error) || "unknown")); }',
    '  });',
    '})();'
  ].join('\n');

  var actions = {
    'n1-get': function (log) {
      GM_xmlhttpRequest({
        method: 'GET', url: PKG, timeout: 15000,
        onload: function (r) {
          log('n1', 'HTTP ' + r.status + ' content-type=' + ((r.headers || {})['content-type'] || '?') + ' finalUrl=' + (r.finalUrl || '?') + ' bodyLength=' + (r.body || '').length);
        },
        onerror: function (r) { log('n1', '请求失败：' + ((r && r.error) || 'unknown')); },
        ontimeout: function () { log('n1', '请求超时'); }
      });
      log('n1', '已发起请求…');
    },
    'n2-drop': function (log) {
      GM_xmlhttpRequest({
        method: 'GET', url: PKG, timeout: 15000,
        headers: { 'user-agent': 'gmt', 'x-gmt': '1' },
        onload: function (r) {
          log('n2', 'HTTP ' + r.status + ' droppedHeaders=' + JSON.stringify((r || {}).droppedHeaders));
        },
        onerror: function (r) { log('n2', '请求失败：' + ((r && r.error) || 'unknown')); }
      });
      log('n2', '已发起带 user-agent 头的请求…');
    },
    'n3-deny': function (log) {
      GM_xmlhttpRequest({
        method: 'GET', url: 'https://example.org/favicon.ico', timeout: 15000,
        onload: function () { log('n3', '意外放行（应为拒绝）'); },
        onerror: function (r) { log('n3', '拒绝 error=' + ((r && r.error) || 'unknown')); }
      });
      log('n3', '已发起未列 host 的请求…');
    },
    'n4-copy': function (log) {
      GM.setClipboard(NO_CONNECT_SRC).then(function () {
        GMT.log('n4', '无 @connect 版本已复制，去脚本池导入并发到任意页触发确认卡');
      }, function (e) {
        GMT.log('n4', '复制失败：' + ((e && e.message) || e));
      });
    }
  };

  GMT.render({
    module: 'network',
    title: 'GM 手测·网络',
    cards: [
      { id: 'n1', api: 'GM_xmlhttpRequest(details) — @connect 命中', desc: '@connect 列出的 host 直接放行；响应 {status,statusText,headers,body,finalUrl}。', steps: [{ id: 'n1-get', label: 'GET jsDelivr package.json' }], expect: 'HTTP 200、content-type 出现、bodyLength > 0' },
      { id: 'n2', api: 'GM_xmlhttpRequest — droppedHeaders', desc: 'fetch 禁头（user-agent/referer/cookie/origin/host）被忽略并在响应 droppedHeaders 列出。', steps: [{ id: 'n2-drop', label: '带 user-agent 头请求' }], expect: 'droppedHeaders 含 "user-agent"，请求本身成功' },
      { id: 'n3', api: 'GM_xmlhttpRequest — @connect 拒绝', desc: '列了 @connect 但请求不命中 → 直接拒绝（无网络 I/O），error 文案应可读。', steps: [{ id: 'n3-deny', label: '请求未列 host' }], expect: 'error 含「不在 @connect 列表」字样' },
      { id: 'n4', api: '@connect 确认卡分支', desc: '未列 @connect 的脚本请求任意 host → 侧边栏弹确认卡（允许一次/总是/拒绝，60s 超时拒绝）。', steps: [{ id: 'n4-copy', label: '复制无 @connect 版本' }, '脚本池导入该文本 → 刷新任意页触发请求 → 侧边栏批准 → 回来看临时脚本 console 日志'], expect: '确认卡弹出；批准后临时脚本 console 出现「确认卡放行 → HTTP 200」' }
    ],
    actions: actions
  });
})();
})();
