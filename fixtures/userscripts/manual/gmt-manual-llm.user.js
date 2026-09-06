// ==UserScript==
// @name         GM 手测·大模型
// @namespace    ai-browser-extend/gmt-manual
// @version      1.0.0
// @description  GM_llmChat 模块人工测试：说明 + 步骤 + 人工标记
// @match        *://*/*
// @run-at       document-end
// @grant        GM_llmChat
// @grant        GM_log
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_setClipboard
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
  var MSGL = [{ role: 'user', content: '用一句话介绍你自己' }];

  // canvas 画纯色方块转 data URL（l3 多模态用）
  function colorDataUrl(size, color) {
    var c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    var ctx = c.getContext('2d');
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, size, size);
    return c.toDataURL('image/png');
  }

  // 随机噪点图 data URL（l5 超限用）。纯色 PNG 经 deflate 压缩后仅 KB 级（3000px 纯色 ≈34KB），
  // 永远到不了 5MB 上限——必须用逐像素随机的噪声图：1200px 噪声 PNG 压缩后 ≈4.2MB、
  // base64 后 ≈5.6MB，稳超 LLM_IMAGE_MAX。
  function noiseDataUrl(size) {
    var c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    var ctx = c.getContext('2d');
    var img = ctx.createImageData(size, size);
    var d = img.data;
    for (var i = 0; i < d.length; i++) {
      d[i] = Math.floor(Math.random() * 256);
      d[i + 1] = Math.floor(Math.random() * 256);
      d[i + 2] = Math.floor(Math.random() * 256);
      d[i + 3] = 255;
      i += 3;
    }
    ctx.putImageData(img, 0, 0);
    return c.toDataURL('image/png');
  }

  // 无 @grant GM_llmChat 的最小临时脚本（l6 导入用，测完删除）。
  // 「声明即授权」语义下 GM_llmChat 未声明 → 作用域内不存在 → 裸调用 ReferenceError，
  // 故正文用 typeof 分支区分「未安装（正确表现）」与「安装但报 permission not requested」。
  var NO_GRANT_SRC = [
    '// ==UserScript==',
    '// @name         GM 手测·大模型无授权探针',
    '// @namespace    ai-browser-extend/gmt-manual',
    '// @version      1.0.0',
    '// @description  触发 GM_llmChat 未授权分支的临时脚本（测完删除）',
    '// @match        *://*/*',
    '// @run-at       document-end',
    '// @grant        GM_log',
    '// @noframes',
    '// ==/UserScript==',
    '',
    '(function () {',
    '  if (typeof GM_llmChat !== "function") {',
    '    GM_log("l6 预期分支：GM_llmChat 未安装（@grant 未声明，权限缺失的正确表现）");',
    '    return;',
    '  }',
    '  GM_llmChat({ messages: [{ role: "user", content: "ping" }] }).then(function (r) {',
    '    GM_log("l6 意外放行 → " + JSON.stringify(r));',
    '  }, function (e) {',
    '    GM_log("l6 预期分支：安装但拒绝 → " + ((e && e.message) || e));',
    '  });',
    '})();'
  ].join('\n');

  var actions = {
    'l1-text': function (log) {
      log('l1', '已发起（等 Promise）…');
      GM_llmChat({ messages: MSGL }).then(function (r) {
        log('l1', 'text=' + r.text + ' | usage=' + JSON.stringify(r.usage) + ' | finish=' + r.finishReason);
      }, function (e) {
        log('l1', '失败：' + ((e && e.message) || e));
      });
    },
    'l2-stream': function (log) {
      var n = 0;
      log('l2', '已发起（流式，等 chunk）…');
      GM_llmChat({
        messages: MSGL,
        onChunk: function (d) { n++; log('l2', 'chunk#' + n + ': ' + d); }
      }).then(function (r) {
        log('l2', '终值 text=' + r.text + '（共 ' + n + ' 条 chunk）');
      }, function (e) {
        log('l2', '失败：' + ((e && e.message) || e));
      });
    },
    'l3-image': function (log) {
      log('l3', '已发起（64px 红色方块，等 Promise）…');
      GM_llmChat({
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: '图里是什么颜色的方块？只答颜色。' },
            { type: 'image_url', image_url: { url: colorDataUrl(64, '#e53935') } }
          ]
        }]
      }).then(function (r) {
        log('l3', 'text=' + r.text);
      }, function (e) {
        log('l3', '失败：' + ((e && e.message) || e));
      });
    },
    'l4-deny': function (log) {
      log('l4', '已发起（预期 permission denied）…');
      GM_llmChat({ messages: MSGL }).then(function (r) {
        log('l4', '意外放行 → ' + JSON.stringify(r));
      }, function (e) {
        log('l4', '拒绝：' + ((e && e.message) || e));
      });
    },
    'l5-oversize': function (log) {
      // 注意：不能用纯色方块——纯色 PNG deflate 后仅 KB 级，根本到不了 5MB。
      // 用 1200px 随机噪点图（base64 后 ≈5.6MB，稳超上限）。
      var url = noiseDataUrl(1200);
      log('l5', '已发起（1200px 噪点图 data URL ' + Math.round(url.length / 1024) + 'KB，预期图片过大）…');
      GM_llmChat({
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: '图里是什么？' },
            { type: 'image_url', image_url: { url: url } }
          ]
        }]
      }).then(function (r) {
        log('l5', '意外放行 → ' + JSON.stringify(r));
      }, function (e) {
        log('l5', '拒绝：' + ((e && e.message) || e));
      });
    },
    'l6-nogrant-copy': function (log) {
      // GM 值按脚本命名空间隔离（local:script-values:{scriptId}），临时脚本读不到本脚本的键——
      // 只能经调试台（走 SW）或取值脚本（本身 grant 了 GM_getValue 也不行，同因命名空间隔离）。
      // 故落点 = 工具调试台 GM_getValue 直调（SW 侧按 scriptId 查 values，需选注入中的脚本）
      // 或 GM_setClipboard 把源文本写进剪贴板（面板侧手动触发一次，零依赖）。
      GM_setValue('gmt_llm_nogrant_src', NO_GRANT_SRC);
      log('l6', '临时脚本源已存 GM 值 gmt_llm_nogrant_src（本脚本命名空间）。');
      log('l6', '读出方式 A：设置 → 工具调试台 → SCRIPTS 分组 → GM_getValue 直调（脚本选本脚本），键 gmt_llm_nogrant_src。');
      GM_setClipboard(NO_GRANT_SRC);
      log('l6', '读出方式 B（已同时复制到剪贴板，覆盖式写入）：直接去脚本池粘贴导入。');
      log('l6', '操作链：导入（无 @grant GM_llmChat 的探针脚本）→ 刷新任意页触发 → F12 看探针脚本 console 日志 → 测完删除探针脚本。');
    }
  };

  GMT.render({
    module: 'llm',
    title: 'GM 手测·大模型',
    cards: [
      { id: 'l1', api: 'GM_llmChat(details) — 文本单轮', desc: 'messages 数组单轮问答，Promise resolve { text, usage, finishReason }。前置：设置 → 模型设置已配置；本脚本「模型调用」档位默认「每次询问」→ 首次点击侧边栏会弹确认卡。', steps: [{ id: 'l1-text', label: '发一次文本问答' }], expect: 'text 非空、usage（promptTokens/completionTokens）与 finishReason 有值' },
      { id: 'l2', api: 'GM_llmChat — 流式 onChunk', desc: '可选 onChunk(delta) 逐段收流式文本增量，Promise 终值 text = 各增量拼接。', steps: [{ id: 'l2-stream', label: '发一次流式问答' }], expect: 'chunk 若干条（顺序递增），终值 text = 各 chunk 拼接' },
      { id: 'l3', api: 'GM_llmChat — 多模态（图片）', desc: 'content 为数组 [{type:text},{type:image_url}]，图片传 canvas 生成的 data URL。', steps: [{ id: 'l3-image', label: '发 64px 红色方块图' }], expect: '回答含「红」' },
      { id: 'l4', api: 'GM_llmChat — 权限档「始终拒绝」', desc: 'deny 硬拒：既不弹确认卡也不暴露模型配置状态。', steps: ['先到侧边栏 脚本池 → 本脚本详情 → 设置 → 模型调用 改「始终拒绝」', { id: 'l4-deny', label: '发起调用' }, '看完把档位改回「每次询问」'], expect: '报 permission denied（文案含可读指引）' },
      { id: 'l5', api: 'GM_llmChat — 单图超限', desc: '单张 data URL 上限 5MB。纯色图会被 PNG 压到 KB 级，必须用随机噪点图：1200px 噪声 PNG base64 后 ≈5.6MB，稳超。', steps: [{ id: 'l5-oversize', label: '发 1200px 噪点图' }], expect: '日志先显示 data URL 实际 KB 数（>5120），后报「图片过大」且不发起模型请求' },
      { id: 'l6', api: '未声明 @grant GM_llmChat 的脚本', desc: '「声明即授权」：未声明的 API 不注入作用域。两种结果都算预期——① 未安装（裸引用不存在）② 安装但报 permission not requested。', steps: [{ id: 'l6-nogrant-copy', label: '存源到 GM 值并复制到剪贴板' }, '读出源文本（调试台直调 GM_getValue 或直接用剪贴板内容）→ 脚本池导入探针脚本 → 任意页触发 → 看探针脚本 console 日志 → 测完删除探针脚本'], expect: '探针脚本 console 日志显示「未安装」或「permission not requested」之一' }
    ],
    actions: actions
  });
})();
})();
