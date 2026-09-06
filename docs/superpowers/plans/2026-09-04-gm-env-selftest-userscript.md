# GM 运行环境自检用户脚本（gmt-selftest）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付一个用户脚本 `gmt-selftest.user.js`，注入任意 http(s) 页面后自动运行 39 项检查（元字段解析自证 + 14 个 GM API + grant 语义 + require/resource + 探针页跨 tab），在页面渲染结果面板；外加一个 fixture 完整性单测。

**Architecture:** 纯交付物任务——脚本本体是独立 .user.js 文本（不进构建产物），fixture 单测用 `fs.readFileSync` 读入并对其跑 `parseUserScript`/`buildWrappedCode` 断言。脚本内部自带迷你 runner（逐项 await、三态结果、SVG 图标面板），探针页经 URL 参数识别进入休眠模式。

**Tech Stack:** 原生 JS（ES2020，用户脚本无构建步骤）、vitest + node:fs（fixture 单测）。

**Spec:** `docs/superpowers/specs/2026-09-04-gm-env-selftest-userscript-design.md`

**注意：** 本计划无生产代码改动，只有 1 个新 fixture 文件 + 1 个新测试文件。Task 1（脚本本体）与 Task 2（单测）可独立执行；TDD 顺序为**先写单测**（Task 1 步骤 1 的失败断言），再写脚本使其通过。

---

## File Structure

```text
fixtures/
  userscripts/
    gmt-selftest.user.js    脚本本体（完整 .user.js 文本，Task 1）
tests/
  shared/
    gmt-selftest-fixture.test.ts   fixture 完整性单测（Task 2）
```

不修改任何现有文件。`fixtures/` 目录是新建的（当前仓库不存在）。

---

### Task 1: 自检脚本本体 `gmt-selftest.user.js`

**Files:**
- Create: `fixtures/userscripts/gmt-selftest.user.js`
- Test: `tests/shared/gmt-selftest-fixture.test.ts`（本任务先写失败测试）

**依赖的现有实现事实**（脚本代码的正确性依据，执行者无需再查）：

- `shared/gm-apis.ts`：14 个 API 名（`GM_info` `GM_getValue` `GM_setValue` `GM_deleteValue` `GM_listValues` `GM_addValueChangeListener` `GM_addStyle` `GM_getResourceText` `GM_log` `GM_registerMenuCommand` `GM_setClipboard` `GM_notification` `GM_openInTab` `GM_xmlhttpRequest`）+ 特殊 grant `unsafeWindow`。
- `shared/gm-wrapper.ts`：`GM_info.script` 形状 = `{ name, namespace, version, description, matches, grants }`；`GM.info` 与 `GM_info` 同引用；下划线形式同步、点形式 Promise；未 grant 的 API 不存在于作用域（`typeof GM_getTab === 'undefined'`）。
- `background/gm-api.ts`：XmlHttpRequest 响应形状 `{ status, statusText, headers, body, finalUrl, truncated?, droppedHeaders? }`；失败时 wrapper 走 `details.onerror({ error })`；@connect 三分支（self/命中→ALLOW，列了不中→DENY，未列→CONFIRM）。
- `background/gm-resources.ts`：@require/@resource 预取进 wrapper（require 前置拼接进同一 Function 作用域，`var Zepto` 直接可见）。
- `shared/userscript-meta.ts`：`@run-at document-end` → `document_end`；`@noframes` → `meta.noframes=true`；零 warning 是本脚本的断言之一。

- [ ] **Step 1: 先写失败测试（fixture 完整性单测）**

Create: `tests/shared/gmt-selftest-fixture.test.ts`

```ts
// tests/shared/gmt-selftest-fixture.test.ts
// gmt-selftest.user.js fixture 完整性单测（spec §7）：把自检脚本当作解析器的
// 真实全字段用例——脚本本体改坏任何元字段/安装面，此处先红。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { parseUserScript } from '../../shared/userscript-meta';
import { buildWrappedCode } from '../../shared/gm-wrapper';
import { GM_API_REGISTRY, SPECIAL_GRANTS } from '../../shared/gm-apis';
import type { UserScript } from '../../shared/types';

const text = readFileSync(join(__dirname, '../../fixtures/userscripts/gmt-selftest.user.js'), 'utf-8');

function asScript(): UserScript {
  const { fields } = parseUserScript(text);
  return {
    id: 'gmt-selftest', text, enabled: true, source: 'import',
    createdAt: 0, updatedAt: 0, ...fields,
  };
}

describe('gmt-selftest fixture 元字段解析面', () => {
  const { fields, warnings } = parseUserScript(text);

  it('解析零警告（头部本身即全字段合法用例）', () => {
    expect(warnings).toEqual([]);
  });

  it('基本信息字段全命中', () => {
    expect(fields.name).toBe('GM 运行环境全功能自检');
    expect(fields.meta).toMatchObject({
      namespace: 'ai-browser-extend/gmt-selftest',
      version: '1.0.0',
      author: 'gmt-selftest',
      description: '本扩展脚本池运行环境全功能自检：元字段解析自证 + 14 个 GM API 可用性',
      homepage: 'https://example.com/gmt-selftest',
      supportURL: 'https://example.com/gmt-selftest/support',
      iconURL: 'https://example.com/favicon.ico',
      downloadURL: 'https://example.com/gmt-selftest.user.js',
      updateURL: 'https://example.com/gmt-selftest.meta.js',
      noframes: true,
    });
  });

  it('匹配/run-at/world：document_end 非 默认 + USER_SCRIPT 缺省', () => {
    expect(fields.matches).toEqual(['*://*/*']);
    expect(fields.runAt).toBe('document_end');
    expect(fields.world).toBe('USER_SCRIPT');
  });

  it('grants：14 个 API 全部 + unsafeWindow = 15 项', () => {
    const expected = [...Object.keys(GM_API_REGISTRY), ...SPECIAL_GRANTS].sort();
    expect([...fields.meta.grants ?? []].sort()).toEqual(expected);
  });

  it('connects/requires/resources 命中', () => {
    expect(fields.meta.connects).toEqual(['cdn.jsdelivr.net']);
    expect(fields.meta.requires).toEqual(['https://cdn.jsdelivr.net/npm/zepto@1.2.0/dist/zepto.min.js']);
    expect(fields.meta.resources).toEqual({
      gmtPkg: 'https://cdn.jsdelivr.net/npm/zepto@1.2.0/package.json',
    });
  });

  it('体量 ≤ 280KB（storage/scripts MAX_TEXT_LENGTH 护栏）', () => {
    expect(text.length).toBeLessThanOrEqual(280 * 1024);
  });
});

describe('gmt-selftest fixture wrapper 安装面', () => {
  it('buildWrappedCode 安装全部 14 个 API（下划线 + 点形式）', () => {
    const code = buildWrappedCode(asScript(), {
      token: 't', values: {}, resources: {}, requireCodes: [], extensionVersion: '1.0.0',
    });
    for (const name of Object.keys(GM_API_REGISTRY)) {
      expect(code).toContain(`install("${name}"`);
      expect(code).toContain(`install("GM.${name.slice(3)}"`);
    }
  });

  it('unsafeWindow / require 前置 / 值快照占位生效', () => {
    const code = buildWrappedCode(asScript(), {
      token: 'tok', values: { k: 1 }, resources: {}, requireCodes: ['/*REQ*/;'], extensionVersion: '1.0.0',
    });
    expect(code).toContain('"unsafeWindow"');
    expect(code.indexOf('/*REQ*/;')).toBeLessThan(code.indexOf('gmtRunner('));
    expect(code).toContain('__values = {"k":1}');
    expect(code).toContain('"tok"');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/shared/gmt-selftest-fixture.test.ts`
Expected: FAIL — `ENOENT ... fixtures/userscripts/gmt-selftest.user.js`（文件尚不存在）

- [ ] **Step 3: 写脚本本体**

Create: `fixtures/userscripts/gmt-selftest.user.js`

```javascript
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
  var results = []; // { id, group, name, state: 'pass'|'fail'|'manual'|'wait', detail? }
  var ICONS = {
    pass: '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="#188038" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    fail: '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="#c5221f" stroke-width="2" stroke-linecap="round"/></svg>',
    wait: '<svg viewBox="0 0 16 16" width="14" height="14"><circle cx="8" cy="8" r="6" fill="none" stroke="#e8710a" stroke-width="2"/><path d="M8 5v3.2l2.2 1.6" fill="none" stroke="#e8710a" stroke-width="1.6" stroke-linecap="round"/></svg>',
    manual: '<svg viewBox="0 0 16 16" width="14" height="14"><circle cx="8" cy="8" r="6" fill="none" stroke="#5f6368" stroke-width="2"/><path d="M8 5v3.2l2.2 1.6" fill="none" stroke="#5f6368" stroke-width="1.6" stroke-linecap="round"/></svg>'
  };
  var STATE_LABEL = { pass: '通过', fail: '失败', wait: '待人工', manual: '人工' };

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

  // ---- 断言执行器：fn 返回 true → pass；throw / falsy → fail；返回 'wait' 保持待人工 ----
  async function runTest(item) {
    if (!item.fn) return; // 人工行无 fn
    try {
      var r = await item.fn(item);
      if (r === 'wait') return; // 保持 wait（人工指引中）
      setState(item.id, r === false ? 'fail' : 'pass', r === true || r == null ? undefined : r);
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
      '#gmt-panel .gmt-row{display:flex;align-items:flex-start;gap:6px;padding:3px 12px;cursor:default}' +
      '#gmt-panel .gmt-row .gmt-icon{flex:none;margin-top:2px}' +
      '#gmt-panel .gmt-row .gmt-name{flex:1;word-break:break-all}' +
      '#gmt-panel .gmt-row .gmt-detail{color:#c5221f;font-size:12px;word-break:break-all}' +
      '#gmt-panel .gmt-row.gmt-fail{cursor:pointer}' +
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
    row.className = 'gmt-row' + (r.state === 'fail' ? ' gmt-fail' : '');
    var html = '<span class="gmt-icon">' + (ICONS[r.state] || '') + '</span>' +
      '<span class="gmt-name">' + escapeHtml(r.name) +
      (r.state === 'fail' && r.detail ? '<br><span class="gmt-detail">' + escapeHtml(detailText(r)) + '</span>' : '') +
      (r.manual && r.state === 'wait' ? '<br><span class="gmt-hint">' + (r.hint || '需人工操作') + '</span>' : '') +
      '</span>';
    row.innerHTML = html;
    if (r.manual && r.state === 'wait') {
      var mark = document.createElement('button');
      mark.type = 'button';
      mark.textContent = '标记通过';
      mark.style.cssText = 'font:11px system-ui;padding:2px 6px;border:1px solid #dadce0;border-radius:4px;background:#fff;cursor:pointer;flex:none';
      mark.addEventListener('click', function () { setState(r.id, 'pass'); });
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
      row.addEventListener('click', function (e) {
        if (e.target.tagName === 'BUTTON') return;
        var d = this.querySelector('.gmt-detail');
        if (d) d.style.display = d.style.display === 'none' ? '' : 'none';
      });
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

  function group1() { // 元字段解析自证（8 项）
    var info = GM_info;
    addRow('1 元字段解析', 'scriptHandler === ai-browser-extend', function () {
      return info.scriptHandler === 'ai-browser-extend' || 'scriptHandler=' + info.scriptHandler;
    });
    addRow('1 元字段解析', 'version 非空字符串', function () {
      return typeof info.version === 'string' && info.version.length > 0 || 'version=' + JSON.stringify(info.version);
    });
    addRow('1 元字段解析', 'script.name 命中', function () {
      return info.script.name === 'GM 运行环境全功能自检' || 'name=' + info.script.name;
    });
    addRow('1 元字段解析', 'script.version/namespace/description 非空', function () {
      var s = info.script;
      return s.version === '1.0.0' && s.namespace.length > 0 && s.description.length > 0 ||
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
      // 「声明即授权」：作用域里只有声明过的 API。Function 作用域查不到 → ReferenceError，即语义正确
      try { return typeof GM_getTab === 'undefined' || 'GM_getTab=' + typeof GM_getTab; }
      catch (e) { return true; }
    });
    addRow('2 环境与 grant', 'unsafeWindow.document === document', function () {
      return unsafeWindow && unsafeWindow.document === document || 'unsafeWindow 非 window';
    });
    addRow('2 环境与 grant', '@require 已执行（typeof Zepto）', function () {
      return typeof Zepto !== 'undefined' || 'Zepto 未定义（jsDelivr 预取失败或网络受限）';
    });
  }

  function group3() { // 值存储（8 项）
    addRow('3 值存储', '运行前清理 __gmt_ 残留', async function () {
      try {
        var keys = GM_listValues();
        for (var i = 0; i < keys.length; i++) {
          if (keys[i].indexOf(PREFIX) === 0) GM_deleteValue(keys[i]);
        }
        var rest = GM_listValues().filter(function (k) { return k.indexOf(PREFIX) === 0; });
        return rest.length === 0 || '残留：' + rest.join(',');
      } catch (e) { throw new Error(fmtError(e)); }
    });
    addRow('3 值存储', 'set + get 字符串往返', function () {
      GM_setValue('k1', 'v1');
      return GM_getValue('k1') === 'v1' || 'get=' + JSON.stringify(GM_getValue('k1'));
    });
    addRow('3 值存储', '对象值往返', function () {
      GM_setValue('k2', { obj: true });
      var v = GM_getValue('k2');
      return v && v.obj === true || 'get=' + JSON.stringify(v);
    });
    addRow('3 值存储', 'get 缺失键返回默认值', function () {
      return GM_getValue('missing', 'def') === 'def' || 'get=' + JSON.stringify(GM_getValue('missing', 'def'));
    });
    addRow('3 值存储', 'get 未设键返回 undefined', function () {
      return GM_getValue('never-set') === undefined || 'get=' + JSON.stringify(GM_getValue('never-set'));
    });
    addRow('3 值存储', 'listValues 含 k1/k2', function () {
      var ks = GM_listValues();
      return ks.indexOf('k1') !== -1 && ks.indexOf('k2') !== -1 || 'list=' + JSON.stringify(ks);
    });
    addRow('3 值存储', 'deleteValue 后不可见', function () {
      GM_deleteValue('k2');
      return GM_getValue('k2') === undefined && GM_listValues().indexOf('k2') === -1 || 'delete 未生效';
    });
    addRow('3 值存储', '点形式 GM.getValue 返回 Promise', async function () {
      var v = await GM.getValue('k1');
      return v === 'v1' || 'resolve=' + JSON.stringify(v);
    });
  }

  function group4() { // 值变更监听（3 项）
    var localEvent = null;
    addRow('4 值监听', 'addValueChangeListener 返回 id', function () {
      var id = GM_addValueChangeListener('k3', function (key, oldV, newV, remote) {
        localEvent = { key: key, oldV: oldV, newV: newV, remote: remote };
      });
      return typeof id === 'string' && id.length > 0 || 'id=' + JSON.stringify(id);
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
      var handle = GM_openInTab(location.pathname + '?__gmt_probe=1', { active: false });
      var ok = await waitFor(function () { return remoteEvent; }, 10000);
      try { handle.close(); } catch (e) { /* 已关 */ }
      return (ok && remoteEvent && remoteEvent.remote === true) ||
        'wait'; // 探针页可能未及注入即被关——标黄提示（spec §8）
    });
  }

  function group5() { // DOM / 资源 / 日志（4 项）
    addRow('5 DOM/资源/日志', 'addStyle 返回已连接 style 元素', function () {
      var el = GM_addStyle('#gmt-styleprobe{color:red}');
      return el && el.tagName === 'STYLE' && el.isConnected || 'el=' + JSON.stringify(el && el.tagName);
    });
    addRow('5 DOM/资源/日志', '样式真实生效（getComputedStyle）', function () {
      var probe = document.createElement('div');
      probe.className = 'gmt-styleprobe';
      document.body.appendChild(probe);
      var pos = getComputedStyle(probe).position;
      probe.remove();
      return pos === 'absolute' ||
        'position=' + pos + '（页面 CSP 可能拦截内联 style——建议在 example.com 等宽松页跑）';
    });
    addRow('5 DOM/资源/日志', 'getResourceText(gmtPkg) 含 name 字段', function () {
      var t = GM_getResourceText('gmtPkg');
      return typeof t === 'string' && t.length > 0 && t.indexOf('"name"') !== -1 ||
        'text=' + JSON.stringify(t == null ? null : String(t).slice(0, 80));
    });
    addRow('5 DOM/资源/日志', 'GM_log 不抛异常', function () {
      GM_log('自检运行中——本行出现在 console，带 [GM 运行环境全功能自检] 前缀');
      return true;
    });
  }

  function group6() { // 剪贴板 / 通知 / 菜单（5 项）
    addRow('6 剪贴板/通知/菜单', 'setClipboard Promise resolve', async function () {
      try {
        await GM.setClipboard('gmt clipboard probe');
        return true;
      } catch (e) {
        return 'wait'; // MV3 SW 无手势链可能被拒——已知降级非缺陷（spec §8），标黄
      }
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
      if (!ok) { notifDone = 'pending'; return 'wait'; }
      return notifDone === 'click' || notifDone === 'close' || 'why=' + JSON.stringify(notifDone);
    });
    var menuKey = null, menuClicked = false;
    addRow('6 剪贴板/通知/菜单', 'registerMenuCommand 返回 key', function () {
      menuKey = GM_registerMenuCommand('GMT 自检：点我', function () { menuClicked = true; });
      return typeof menuKey === 'string' && menuKey.length > 0 || 'key=' + JSON.stringify(menuKey);
    });
    addRow('6 剪贴板/通知/菜单', '菜单命令点击回环', async function (item) {
      item.manual = true;
      item.hint = '人工：侧边栏 → 脚本池 → 菜单命令 → 点击「GMT 自检：点我」';
      var ok = await waitFor(function () { return menuClicked; }, 120000);
      return ok || 'wait';
    });
  }

  function group7() { // 标签页（2 项）
    addRow('7 标签页', 'openInTab 返回句柄', function () {
      var h = GM_openInTab('https://example.com/?__gmt_probe=1&__gmt_solo=1', { active: false });
      soloHandle = h;
      return h && h.closed === false && typeof h.close === 'function' ||
        'handle=' + JSON.stringify(h && { closed: h.closed });
    });
    addRow('7 标签页', 'close() 后 closed=true 且 onclose 触发', async function () {
      var closed = false;
      if (soloHandle) {
        soloHandle.onclose = function () { closed = true; };
        try { soloHandle.close(); } catch (e) { /* ignore */ }
      }
      var ok = await waitFor(function () { return soloHandle && soloHandle.closed; }, 10000);
      return (ok && closed) || 'closed=' + JSON.stringify(soloHandle && soloHandle.closed);
    });
  }
  var soloHandle = null; // 组 7 专用（探针页复用组 4 的 openInTab）

  function group8() { // 网络（3 项）
    var pkgUrl = 'https://cdn.jsdelivr.net/npm/zepto@1.2.0/package.json';
    addRow('8 网络', '@connect 命中：GET jsdelivr 200', async function () {
      return await new Promise(function (resolve) {
        GM_xmlhttpRequest({
          method: 'GET', url: pkgUrl, timeout: 15000,
          onload: function (resp) {
            resolve(resp.status === 200 && resp.body && resp.body.length > 0 &&
              resp.finalUrl && resp.headers && resp.headers['content-type'] ||
              'status=' + resp.status + ' bodyLen=' + (resp.body || '').length);
          },
          onerror: function (resp) { resolve('请求失败：' + (resp && resp.error || 'onerror')); },
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
            resolve(resp.status === 200 && Array.isArray(resp.droppedHeaders) &&
              resp.droppedHeaders.indexOf('user-agent') !== -1 ||
              'status=' + resp.status + ' dropped=' + JSON.stringify(resp.droppedHeaders));
          },
          onerror: function (resp) { resolve('请求失败：' + (resp && resp.error || 'onerror')); },
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
            resolve(resp && resp.error && String(resp.error).indexOf('connect') !== -1 ||
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
    updateSummary();
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
```

- [ ] **Step 4: 运行 fixture 测试确认通过**

Run: `npx vitest run tests/shared/gmt-selftest-fixture.test.ts`
Expected: PASS（9 个用例全绿）

- [ ] **Step 5: 全量回归**

Run: `npm run compile && npm run test`
Expected: compile 零错误；vitest 全绿（fixture 单测计入）

- [ ] **Step 6: Commit**

```bash
git add fixtures/userscripts/gmt-selftest.user.js tests/shared/gmt-selftest-fixture.test.ts
git commit -m "feat(scripts): gmt-selftest 自检用户脚本 + fixture 完整性单测

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: 手动冒烟验证 + spec §9 使用说明回填

**Files:**
- Modify: `docs/superpowers/specs/2026-09-04-gm-env-selftest-userscript-design.md`（仅当冒烟发现 spec 需修正时）

本任务无法自动化，产出为验证记录：

- [ ] **Step 1: 构建**

Run: `npm run build`
Expected: 构建成功，`chrome.userScripts` 注入引擎随扩展加载

- [ ] **Step 2: 装载脚本**

在浏览器扩展侧边栏 → 脚本池 → 导入 `fixtures/userscripts/gmt-selftest.user.js`（或新建脚本粘贴文本）。确认详情页解析面板：name/version/matches/run-at/grants/connects/require/resource/noframes 全部正确、无警告徽标。

- [ ] **Step 3: 打开 https://example.com 观察面板**

Expected: 右下角出现「GM 运行环境自检」面板并自动运行。组 1/2/3/5/7/8 的行全部绿勾；组 4.3（跨 tab）、组 6（剪贴板/通知/菜单）出现黄/灰待人工行。

- [ ] **Step 4: 人工动作**

1. 点掉系统通知 → 组 6「ondone 触发」行翻绿。
2. 侧边栏脚本池 → 菜单命令区 → 点击「GMT 自检：点我」→ 对应行翻绿。
3. 点面板「测试错误上报」→ 侧边栏该脚本错误徽标 +1，错误列表含「GMT 测试错误」与 stack。
4. 确认组 4.3 跨 tab 行：探针页写入 remote_probe 后翻绿（或标黄提示）。

- [ ] **Step 5: 重跑与清理**

点面板「重跑」→ 页面刷新后全部重跑、无残留键（组 3.1 清理生效）。验证完在脚本池把脚本停用（`@match *://*/*` 全站注入）。

- [ ] **Step 6: 如冒烟发现问题 → 回到 Task 1 修脚本；若 spec 与现实不符，回填 spec 并 commit**

```bash
git add -A && git commit -m "docs(spec): gmt-selftest 冒烟修正

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Self-Review 记录

1. **Spec 覆盖**：§3 元头（Task 1 Step 3 头部逐行落实 + Task 1 Step 1 解析面断言）· §4 全部 39 项（group1–9 与 spec 编号一一对应）· §5 面板（injectPanel/renderAll/renderStore）· §6.1 探针页（boot 前置分支 + 组 4.3/7.1）· §6.2 waitFor（基础设施）· §6.3 前缀清理（组 3.1）· §7 fixture 单测（Task 1 Step 1）· §9 使用说明（Task 2 步骤复述）· §10 验收（Task 1 Step 5 + Task 2）。无缺口。
2. **占位符**：无 TBD/TODO；所有代码步骤含完整代码。
3. **类型一致性**：`addRow(group, name, fn, opts)` 四参签名在 group1–9 与 renderAll 用法一致；`setState(id, state, detail)` 三参一致；fixture 单测的 `asScript()` 字段展开顺序（`...fields` 在后覆盖 id 之外的解析产物）与 `UserScript` 类型匹配。
