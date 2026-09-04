# GM 人工测试脚本族（gmt-manual-*）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 五个「一个 GM 模块一个脚本」的人工测试用户脚本（22 卡：API 说明 + 测试步骤 + 通过/失败标记 + GM 存储持久化），由共享面板内核拼接产出。

**Architecture:** `fixtures/userscripts/manual/` 源目录（`_panel-core.js` 内核 + 5 个 `.user.js.src` 模块定义）→ `scripts/build-manual.mjs`（Node 直跑拼接，零依赖）→ 五个 `.user.js` 产物入库。fixture 单测断言产物解析面/grants/内核锚点/卡片数/源同步。探针页机制沿用 gmt-selftest（`?__gmt_probe=1` 休眠写键）。

**Tech Stack:** ES5 风格用户脚本（var/function，与 gmt-selftest 同风格）；Node ESM 拼接脚本（node:fs）；vitest + Vite `?raw` 导入（同 `tests/shared/gmt-selftest-fixture.test.ts` 惯例——项目无 @types/node，测试不走 node:fs）。

**Spec:** `docs/superpowers/specs/2026-09-04-gmt-manual-test-userscripts-design.md`

---

## 参考锚点（实现前先读）

- 面板视觉与骨架复用：`fixtures/userscripts/gmt-selftest.user.js` 的 `injectPanel()`（L118-157，样式串/innerHTML 骨架）、`escapeHtml`（L178-182）、`updateSummary`（L184-195，「N 过 / N 挂 / N 待定」格式）。
- 探针页休眠模式：`gmt-selftest.user.js` L42-46（`location.search.indexOf(PROBE_MARK) !== -1` → 写键 → return）。
- 元头解析口径：`shared/userscript-meta.ts`（`@run-at document-end` → `document_end`、`@noframes` → `meta.noframes`、零 warning 条件）。
- grant 全集：`shared/gm-apis.ts` `GM_API_REGISTRY`（14 API）+ `SPECIAL_GRANTS`（unsafeWindow）。
- 拼接产物结构：元头 + `(function () { 'use strict'; <panel-core 主体> <module-cards 主体> })();`——`.user.js.src` 文件含元头与卡片定义体（不含 IIFE 壳）。

## 约定（全任务通用）

- 存储键：`__gmt_manual_<module>`（值：`{ [cardId]: { verdict:'pass'|'fail', note?, at } }` 字典——按 id 取单卡结果 O(1)；spec §4 伪码的数组形式落地为字典，语义等价）；探针键：`__gmt_manual_probe_<module>`。
- 卡片数据形状：`{ id: string, api: string, desc: string, steps: string[], expect: string }`。
- 五模块 module 键：`storage` / `dom-resource` / `interaction` / `tabs` / `network`。
- 产物命名：`gmt-manual-<module>.user.js`；源命名：`<module>.user.js.src`。
- 提交尾随 `Co-Authored-By: Claude Code <noreply@anthropic.com>`。

---

### Task 1: 拼接脚本 + 面板内核骨架

**Files:**
- Create: `scripts/build-manual.mjs`
- Create: `fixtures/userscripts/manual/_panel-core.js`
- Modify: `package.json`（scripts 加 `build:manual`）

- [ ] **Step 1: 写拼接脚本 scripts/build-manual.mjs**

```javascript
// scripts/build-manual.mjs
// gmt-manual-* 人工测试脚本族拼接：_panel-core.js + <module>.user.js.src → gmt-manual-<module>.user.js
// 零依赖（node:fs）；幂等（重复运行产物一致）。
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, 'fixtures/userscripts/manual');
const core = readFileSync(join(srcDir, '_panel-core.js'), 'utf8');

// 扫描 <module>.user.js.src（排除 _panel-core.js）
const modules = readdirSync(srcDir)
  .filter((f) => f.endsWith('.user.js.src'))
  .map((f) => f.replace(/\.user\.js\.src$/, ''))
  .sort();

for (const mod of modules) {
  const src = readFileSync(join(srcDir, `${mod}.user.js.src`), 'utf8');
  // 源文件 = 元头 + 正文（卡片定义体）。元头结束标记后拆两段。
  const END = '// ==/UserScript==';
  const endIdx = src.indexOf(END);
  if (endIdx === -1) throw new Error(`${mod}.user.js.src 缺少 ==/UserScript== 结束标记`);
  const header = src.slice(0, endIdx + END.length);
  const body = src.slice(endIdx + END.length).trim();
  const out = `${header}\n\n(function () {\n'use strict';\n${core}\n${body}\n})();\n`;
  const outFile = join(srcDir, `gmt-manual-${mod}.user.js`);
  writeFileSync(outFile, out);
  console.log(`built gmt-manual-${mod}.user.js (${out.length} bytes)`);
}
console.log(`done: ${modules.length} modules`);
```

- [ ] **Step 2: package.json 加 build:manual**

`scripts` 对象内、`"zip"` 行后加：

```json
    "build:manual": "node scripts/build-manual.mjs",
```

- [ ] **Step 3: 写面板内核 fixtures/userscripts/manual/_panel-core.js**

完整内容（`GMT` 命名空间；卡片渲染/存储/汇总/探针）：

```javascript
// _panel-core.js —— gmt-manual-* 共享面板内核（拼接时内联进各产物 IIFE，非独立脚本）。
// 依赖调用方提供 CFG（render({module,title,cards,probe?}) 的实参，见底部 GMT.render 调用）。
var GMT = (function () {
  var PREFIX = '__gmt_manual_';
  var PROBE_MARK = '__gmt_probe=1';
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

  // 卡片定义 {id, api, desc, steps, expect} → DOM。steps 可含 {act:'button', label, onClick} 混入项：
  // 字符串项渲染为有序步骤；对象项渲染为按钮（供模块脚本挂交互，如「触发 setValue」「close()」）。
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
        if (fn) fn(logLine, card);
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
```

注意：`CFG` 是内核 IIFE 外的隐式全局（拼接产物里由模块体 `GMT.render({...})` 赋值）——ES5 产物无模块作用域可用，在内核顶部 `var CFG;` 声明（上方代码已含），模块体调用 `GMT.render` 时赋值。

- [ ] **Step 4: 写最小模块源占位并验证拼接**

`fixtures/userscripts/manual/tabs.user.js.src`（先建最小占位让拼接可跑，Task 5 再补全 2 卡）：

```text
// ==UserScript==
// @name         GM 手测·标签页
// @namespace    ai-browser-extend/gmt-manual
// @version      1.0.0
// @description  GM 标签页模块人工测试：说明 + 步骤 + 人工标记
// @match        *://*/*
// @run-at       document-end
// @grant        GM_openInTab
// @grant        GM_setValue
// @grant        GM_getValue
// @noframes
// ==/UserScript==

GMT.render({
  module: 'tabs',
  title: 'GM 手测·标签页',
  cards: [],
  probe: { mark: '__gmt_probe=1', key: '__gmt_manual_probe_tabs' }
});
```

- [ ] **Step 5: 跑拼接验证**

Run: `npm run build:manual`
Expected: 输出 `built gmt-manual-tabs.user.js (N bytes)` + `done: 1 modules`；`fixtures/userscripts/manual/gmt-manual-tabs.user.js` 生成，`node --check` 语法过：

```bash
node --check fixtures/userscripts/manual/gmt-manual-tabs.user.js
```

- [ ] **Step 6: Commit**

```bash
git add scripts/build-manual.mjs fixtures/userscripts/manual/_panel-core.js fixtures/userscripts/manual/tabs.user.js.src fixtures/userscripts/manual/gmt-manual-tabs.user.js package.json
git commit -m "feat(manual): 拼接脚本 + 面板内核骨架（gmt-manual 任务 1）"
```

---

### Task 2: 模块 1 值存储（storage，7 卡）

**Files:**
- Create: `fixtures/userscripts/manual/storage.user.js.src`
- Create: `fixtures/userscripts/manual/gmt-manual-storage.user.js`（拼接产物）

- [ ] **Step 1: 写模块源 storage.user.js.src**

```text
// ==UserScript==
// @name         GM 手测·值存储
// @namespace    ai-browser-extend/gmt-manual
// @version      1.0.0
// @description  GM 值存储模块人工测试：说明 + 步骤 + 人工标记
// @match        *://*/*
// @run-at       document-end
// @grant        GM_info
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_addValueChangeListener
// @noframes
// ==/UserScript==

(function () {
  var K = '__gmt_manual_storage_probe';

  var actions = {
    's2-set': function (log) {
      GM_setValue(K, 'v1');
      log('s2', 'GM_setValue 后 GM_getValue → ' + JSON.stringify(GM_getValue(K)));
    },
    's3-obj': function (log) {
      GM_setValue(K + '.obj', { a: 1, b: 'x' });
      log('s3', '读回 → ' + JSON.stringify(GM_getValue(K + '.obj')));
    },
    's4-def': function (log) {
      log('s4', 'GM_getValue("不存在的键", "def") → ' + JSON.stringify(GM_getValue(K + '.missing', 'def')));
    },
    's5-del': function (log) {
      GM_deleteValue(K);
      log('s5', '删除后 GM_getValue → ' + JSON.stringify(GM_getValue(K)));
    },
    's6-list': function (log) {
      log('s6', 'GM_listValues → ' + JSON.stringify(GM_listValues()));
    },
    's7-emit': function (log, card) {
      GM_setValue(K + '.evt', 'x' + Date.now() % 1000);
    }
  };

  var listenerId = GM_addValueChangeListener(K + '.evt', function (key, oldV, newV, remote) {
    var el = document.querySelector('#gmt-panel [data-card="s7"] .gmt-log');
    if (el) { el.style.display = ''; el.textContent += '事件: key=' + key + ' old=' + JSON.stringify(oldV) + ' new=' + JSON.stringify(newV) + ' remote=' + remote + '\n'; }
  });

  GMT.render({
    module: 'storage',
    title: 'GM 手测·值存储',
    cards: [
      { id: 's1', api: 'GM_info', desc: '脚本与扩展元数据（scriptHandler/version/script/injectInto）。', steps: ['核对下方日志里的 script.name 是否为本脚本名、scriptHandler 是否为 ai-browser-extend'], expect: '字段与本脚本元头一致' },
      { id: 's2', api: 'GM_getValue(key, def?) / GM_setValue(key, val)', desc: '写后读往返（下划线形式同步返回，值来自注入时快照 + 桥写穿透）。', steps: [{ id: 's2-set', label: '写入 v1 并读回' }], expect: '日志显示 "v1"' },
      { id: 's3', api: 'GM_setValue（对象值）', desc: '对象值经 JSON 往返存取。', steps: [{ id: 's3-obj', label: '存 {a:1,b:"x"} 并读回' }], expect: '日志显示 {"a":1,"b":"x"}' },
      { id: 's4', api: 'GM_getValue 默认值分支', desc: '读不存在的键返回调用方默认值。', steps: [{ id: 's4-def', label: '读缺失键（默认 "def"）' }], expect: '日志显示 "def"' },
      { id: 's5', api: 'GM_deleteValue(key)', desc: '删除后读回 undefined。', steps: [{ id: 's5-del', label: '删除 s2 写入的键并读回' }], expect: '日志显示 undefined' },
      { id: 's6', api: 'GM_listValues()', desc: '列本脚本命名空间全部键。', steps: [{ id: 's6-list', label: '列出全部键' }], expect: '日志数组含 __gmt_manual_storage_probe.obj / .evt 等键' },
      { id: 's7', api: 'GM_addValueChangeListener(key, fn)', desc: '值变更监听；本 tab 触发的事件 remote=false。', steps: [{ id: 's7-emit', label: '触发一次 setValue' }, '核对下方日志的事件字段'], expect: '出现 remote=false 的事件行，old/new 值正确' }
    ],
    actions: actions
  });

  // s1 卡的日志：GM_info 自读
  setTimeout(function () {
    var el = document.querySelector('#gmt-panel [data-card="s1"] .gmt-log');
    if (!el) return;
    el.style.display = '';
    el.textContent = 'scriptHandler=' + GM_info.scriptHandler + ' version=' + GM_info.version +
      '\nscript.name=' + GM_info.script.name + ' injectInto=' + GM_info.injectInto;
  }, 0);
})();
```

- [ ] **Step 2: 拼接 + 语法检查**

```bash
npm run build:manual
node --check fixtures/userscripts/manual/gmt-manual-storage.user.js
```

Expected: `done: 2 modules`；`node --check` 无输出（语法 OK）。

- [ ] **Step 3: Commit**

```bash
git add fixtures/userscripts/manual/storage.user.js.src fixtures/userscripts/manual/gmt-manual-storage.user.js
git commit -m "feat(manual): 模块1 值存储 7 卡（storage）"
```

---

### Task 3: 模块 2 DOM/资源/日志（dom-resource，5 卡）+ 模块 3 菜单/通知/剪贴板（interaction，4 卡）

**Files:**
- Create: `fixtures/userscripts/manual/dom-resource.user.js.src`
- Create: `fixtures/userscripts/manual/gmt-manual-dom-resource.user.js`
- Create: `fixtures/userscripts/manual/interaction.user.js.src`
- Create: `fixtures/userscripts/manual/gmt-manual-interaction.user.js`

- [ ] **Step 1: 写 dom-resource.user.js.src**

```text
// ==UserScript==
// @name         GM 手测·DOM资源日志
// @namespace    ai-browser-extend/gmt-manual
// @version      1.0.0
// @description  GM DOM/资源/日志模块人工测试：说明 + 步骤 + 人工标记
// @match        *://*/*
// @run-at       document-end
// @grant        GM_addStyle
// @grant        GM_getResourceText
// @grant        GM_log
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// @noframes
// ==/UserScript==

(function () {
  var actions = {
    'd1-style': function () {
      GM_addStyle('#gmt-colorprobe{position:fixed;left:12px;top:12px;z-index:2147483646;width:80px;height:40px;background:#53589a;color:#fff;font:12px system-ui;display:flex;align-items:center;justify-content:center;border-radius:4px}');
      var probe = document.createElement('div');
      probe.id = 'gmt-colorprobe';
      probe.textContent = '色块探针';
      (document.body || document.documentElement).appendChild(probe);
    },
    'd2-res': function (log) {
      log('d2', 'GM_getResourceText("不存在") → ' + JSON.stringify(GM_getResourceText('no-such-resource')));
    },
    'd3-log': function () {
      GM_log('GM_log 探针行（gmt-manual-dom-resource）');
    },
    'd4-uw': function (log) {
      log('d4', 'typeof unsafeWindow → ' + typeof unsafeWindow +
        '；unsafeWindow.document === document → ' + (unsafeWindow.document === document));
    },
    'd5-dot': function (log) {
      GM.setValue('__gmt_manual_dr_dot', 'pv');
      GM.getValue('__gmt_manual_dr_dot').then(function (v) {
        log('d5', 'GM.getValue Promise resolve → ' + JSON.stringify(v));
      });
    }
  };

  GMT.render({
    module: 'dom-resource',
    title: 'GM 手测·DOM资源日志',
    cards: [
      { id: 'd1', api: 'GM_addStyle(css)', desc: '注入 <style> 元素（同步返回元素）。', steps: [{ id: 'd1-style', label: '注入色块样式' }, '看页面左上角是否出现紫色「色块探针」'], expect: '左上角出现 #53589a 色块' },
      { id: 'd2', api: 'GM_getResourceText(name)', desc: '读 @resource 声明的资源文本；未声明返回 undefined（真实资源内容验证归 gmt-selftest）。', steps: [{ id: 'd2-res', label: '读未声明资源' }], expect: '日志显示 undefined' },
      { id: 'd3', api: 'GM_log(...args)', desc: '带 [脚本名] 前缀写本地 console。', steps: [{ id: 'd3-log', label: '打一条日志' }, '开 F12 → Console，找 [GM 手测·DOM资源日志] 前缀行'], expect: 'Console 出现前缀行' },
      { id: 'd4', api: 'unsafeWindow（特殊 grant）', desc: 'USER_SCRIPT world 下为隔离 world window（要真页面 window 需 @world MAIN）。', steps: [{ id: 'd4-uw', label: '打印 unsafeWindow 判定' }], expect: 'document === document 为 true（window 同一性不定 true，见说明）' },
      { id: 'd5', api: 'GM.setValue / GM.getValue（点形式）', desc: '点形式为 Promise 形态。', steps: [{ id: 'd5-dot', label: '点形式写后读' }], expect: '日志显示 "pv"' }
    ],
    actions: actions
  });
})();
```

- [ ] **Step 2: 写 interaction.user.js.src**

```text
// ==UserScript==
// @name         GM 手测·菜单通知剪贴板
// @namespace    ai-browser-extend/gmt-manual
// @version      1.0.0
// @description  GM 菜单/通知/剪贴板模块人工测试：说明 + 步骤 + 人工标记
// @match        *://*/*
// @run-at       document-end
// @grant        GM_registerMenuCommand
// @grant        GM_notification
// @grant        GM_setClipboard
// @grant        GM_info
// @noframes
// ==/UserScript==

(function () {
  var actions = {
    'i1-menu': function (log) {
      GM_registerMenuCommand('GMT 手测：点我', function () {
        log('i1', '菜单命令被点击 @ ' + new Date().toLocaleTimeString());
      });
      log('i1', '已注册，去侧边栏脚本池「菜单命令」区（或扩展 popup）点击「GMT 手测：点我」');
    },
    'i2-notif': function (log) {
      GM_notification({ title: 'GMT 手测通知', text: '点我或关闭我以验证 ondone 回调' }, function (why) {
        log('i2', 'ondone 回调 → ' + why);
      });
      log('i2', '已发系统通知，请点掉它（Chrome 通知中心）');
    },
    'i3-clip': function (log) {
      GM.setClipboard('gmt-manual-clipboard-' + Date.now() % 10000).then(function () {
        log('i3', '写入成功，请粘到下方备注框核对内容');
      }, function (e) {
        log('i3', '写入失败（MV3 SW 无手势链可能被拒）：' + (e && e.message || e));
      });
    }
  };

  GMT.render({
    module: 'interaction',
    title: 'GM 手测·菜单通知剪贴板',
    cards: [
      { id: 'i1', api: 'GM_registerMenuCommand(name, fn)', desc: '注册菜单命令；入口在侧边栏脚本池「菜单命令」区（非浏览器右键菜单）。', steps: [{ id: 'i1-menu', label: '注册菜单命令' }, '侧边栏 → 脚本池 → 菜单命令 → 点「GMT 手测：点我」'], expect: '卡片日志出现「菜单命令被点击」时间戳' },
      { id: 'i2', api: 'GM_notification(details, ondone?)', desc: '系统通知；点击/关闭后 ondone 触发（click/close）。', steps: [{ id: 'i2-notif', label: '发通知' }, '点掉系统通知'], expect: '卡片日志出现 ondone 回调值（click 或 close）' },
      { id: 'i3', api: 'GM_setClipboard(data)', desc: '写剪贴板（仅文本；SW 无手势链时可能被拒，失败给可读提示）。', steps: [{ id: 'i3-clip', label: '写剪贴板' }, '把内容粘贴到备注框核对前缀'], expect: '粘贴出 gmt-manual-clipboard-* 文本（或失败行给可读错误）' },
      { id: 'i4', api: 'GM.info / GM_info', desc: 'GM.info 与 GM_info 同引用（点形式别名）。', steps: ['核对卡片日志：两者引用相同为 true'], expect: '同引用 true（打开面板时已自动打印）' }
    ],
    actions: actions
  });

  setTimeout(function () {
    var el = document.querySelector('#gmt-panel [data-card="i4"] .gmt-log');
    if (!el) return;
    el.style.display = '';
    el.textContent = 'GM.info === GM_info → ' + (GM.info === GM_info);
  }, 0);
})();
```

- [ ] **Step 3: 拼接 + 语法检查**

```bash
npm run build:manual
node --check fixtures/userscripts/manual/gmt-manual-dom-resource.user.js
node --check fixtures/userscripts/manual/gmt-manual-interaction.user.js
```

Expected: `done: 4 modules`；两个 `node --check` 无输出。

- [ ] **Step 4: Commit**

```bash
git add fixtures/userscripts/manual/dom-resource.user.js.src fixtures/userscripts/manual/gmt-manual-dom-resource.user.js fixtures/userscripts/manual/interaction.user.js.src fixtures/userscripts/manual/gmt-manual-interaction.user.js
git commit -m "feat(manual): 模块2 DOM资源日志 5 卡 + 模块3 菜单通知剪贴板 4 卡"
```

---

### Task 4: 模块 5 网络（network，4 卡）+ 补全模块 4 标签页（tabs，2 卡）

**Files:**
- Create: `fixtures/userscripts/manual/network.user.js.src`
- Create: `fixtures/userscripts/manual/gmt-manual-network.user.js`
- Modify: `fixtures/userscripts/manual/tabs.user.js.src`（占位 → 2 卡全量）
- Modify: `fixtures/userscripts/manual/gmt-manual-tabs.user.js`（重新拼接）

- [ ] **Step 1: 写 network.user.js.src**

```text
// ==UserScript==
// @name         GM 手测·网络
// @namespace    ai-browser-extend/gmt-manual
// @version      1.0.0
// @description  GM 网络模块人工测试：说明 + 步骤 + 人工标记
// @match        *://*/*
// @run-at       document-end
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      cdn.jsdelivr.net
// @noframes
// ==/UserScript==

(function () {
  var PKG = 'https://cdn.jsdelivr.net/npm/zepto@1.2.0/package.json';

  // 无 @connect 版本全文（确认卡分支引导用）：本脚本源去掉 @connect 行的等价文本
  var NO_CONNECT_SRC = [
    '// ==UserScript==',
    '// @name         GM 手测·网络确认卡',
    '// @namespace    ai-browser-extend/gmt-manual',
    '// @version      1.0.0',
    '// @description  触发 @connect 确认卡的临时脚本（测完删除）',
    '// @match        *://*/*',
    '// @run-at       document-end',
    '// @grant        GM_xmlhttpRequest',
    '// @noframes',
    '// ==/UserScript==',
    '',
    'GM_xmlhttpRequest({',
    '  method: "GET",',
    '  url: "https://cdn.jsdelivr.net/npm/zepto@1.2.0/package.json",',
    '  timeout: 15000,',
    '  onload: function (r) { GM_log("确认卡放行 → HTTP " + r.status); },',
    '  onerror: function (r) { GM_log("请求失败：" + (r && r.error || "unknown")); }',
    '});'
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
        log('n4', '无 @connect 版本已复制，去脚本池导入并发到任意页触发确认卡');
      }, function (e) {
        log('n4', '复制失败：' + (e && e.message || e));
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
```

- [ ] **Step 2: 补全 tabs.user.js.src（替换 Task 1 占位全文）**

```text
// ==UserScript==
// @name         GM 手测·标签页
// @namespace    ai-browser-extend/gmt-manual
// @version      1.0.0
// @description  GM 标签页模块人工测试：说明 + 步骤 + 人工标记
// @match        *://*/*
// @run-at       document-end
// @grant        GM_openInTab
// @grant        GM_setValue
// @grant        GM_getValue
// @noframes
// ==/UserScript==

(function () {
  var handle = null;

  var actions = {
    't1-open': function (log) {
      handle = GM_openInTab(location.origin + location.pathname + '?__gmt_probe=1', { active: false });
      log('t1', '句柄 closed=' + handle.closed + ' typeof close=' + typeof handle.close);
    },
    't2-close': function (log) {
      if (!handle) { log('t2', '先点上一卡的「打开探针页」'); return; }
      handle.onclose = function () { log('t2', 'onclose 触发 @ ' + new Date().toLocaleTimeString()); };
      handle.close();
      log('t2', 'close() 已调用，等探针页关闭…');
    }
  };

  GMT.render({
    module: 'tabs',
    title: 'GM 手测·标签页',
    cards: [
      { id: 't1', api: 'GM_openInTab(url, opts?)', desc: '开新 tab（active:false 后台开），返回句柄 {closed, close(), onclose}。', steps: [{ id: 't1-open', label: '后台打开探针页' }], expect: '后台出现新 tab；日志 closed=false、close 为 function' },
      { id: 't2', api: '句柄 close() / onclose', desc: 'close() 关闭探针页；关闭后 onclose 回调触发、closed 翻 true。', steps: [{ id: 't2-close', label: '关闭探针页' }, '切回本页看日志'], expect: '探针页被关；日志出现 onclose 触发时间戳' }
    ],
    actions: actions,
    probe: { mark: '__gmt_probe=1', key: '__gmt_manual_probe_tabs' }
  });
})();
```

注意探针页分支在内核 `GMT.render` 顶部处理（检测 `?__gmt_probe=1` → 写 `__gmt_manual_probe_tabs` → return），探针 tab 不建面板、秒关无感。

- [ ] **Step 3: 拼接 + 语法检查**

```bash
npm run build:manual
node --check fixtures/userscripts/manual/gmt-manual-network.user.js
node --check fixtures/userscripts/manual/gmt-manual-tabs.user.js
```

Expected: `done: 5 modules`；两个 `node --check` 无输出。

- [ ] **Step 4: Commit**

```bash
git add fixtures/userscripts/manual/network.user.js.src fixtures/userscripts/manual/gmt-manual-network.user.js fixtures/userscripts/manual/tabs.user.js.src fixtures/userscripts/manual/gmt-manual-tabs.user.js
git commit -m "feat(manual): 模块5 网络 4 卡 + 补全模块4 标签页 2 卡"
```

---

### Task 5: fixture 单测护栏

**Files:**
- Create: `tests/shared/gmt-manual-fixtures.test.ts`

- [ ] **Step 1: 写单测（先于运行应全绿——产物已入库，护栏性质）**

```typescript
// tests/shared/gmt-manual-fixtures.test.ts
// gmt-manual-* 五产物 fixture 护栏（spec §7）：解析面/grants/内核锚点/卡片数/体量/源同步。
// 文本经 Vite ?raw 原文内联（同 gmt-selftest-fixture.test.ts 惯例——项目无 @types/node，不走 node:fs）。
import { describe, it, expect } from 'vitest';
import { parseUserScript } from '../../shared/userscript-meta';
import { GM_API_REGISTRY } from '../../shared/gm-apis';
import type { UserScript } from '../../shared/types';

import storageText from '../../fixtures/userscripts/manual/gmt-manual-storage.user.js?raw';
import domText from '../../fixtures/userscripts/manual/gmt-manual-dom-resource.user.js?raw';
import interactionText from '../../fixtures/userscripts/manual/gmt-manual-interaction.user.js?raw';
import tabsText from '../../fixtures/userscripts/manual/gmt-manual-tabs.user.js?raw';
import networkText from '../../fixtures/userscripts/manual/gmt-manual-network.user.js?raw';
import coreText from '../../fixtures/userscripts/manual/_panel-core.js?raw';
import storageSrc from '../../fixtures/userscripts/manual/storage.user.js.src?raw';
import domSrc from '../../fixtures/userscripts/manual/dom-resource.user.js.src?raw';
import interactionSrc from '../../fixtures/userscripts/manual/interaction.user.js.src?raw';
import tabsSrc from '../../fixtures/userscripts/manual/tabs.user.js.src?raw';
import networkSrc from '../../fixtures/userscripts/manual/network.user.js.src?raw';

interface Fixture { mod: string; text: string; src: string; grants: string[]; cards: number }

const FIXTURES: Fixture[] = [
  {
    mod: 'storage', text: storageText, src: storageSrc, cards: 7,
    grants: ['GM_info', 'GM_getValue', 'GM_setValue', 'GM_deleteValue', 'GM_listValues', 'GM_addValueChangeListener'],
  },
  {
    mod: 'dom-resource', text: domText, src: domSrc, cards: 5,
    grants: ['GM_addStyle', 'GM_getResourceText', 'GM_log', 'GM_getValue', 'GM_setValue', 'unsafeWindow'],
  },
  {
    mod: 'interaction', text: interactionText, src: interactionSrc, cards: 4,
    grants: ['GM_registerMenuCommand', 'GM_notification', 'GM_setClipboard', 'GM_info'],
  },
  {
    mod: 'tabs', text: tabsText, src: tabsSrc, cards: 2,
    grants: ['GM_openInTab', 'GM_getValue', 'GM_setValue'],
  },
  {
    mod: 'network', text: networkText, src: networkSrc, cards: 4,
    grants: ['GM_xmlhttpRequest', 'GM_getValue', 'GM_setValue'],
  },
];

describe('gmt-manual 五产物解析面', () => {
  for (const f of FIXTURES) {
    it(`[${f.mod}] 解析零警告 + 基本字段`, () => {
      const { fields, warnings } = parseUserScript(f.text);
      expect(warnings).toEqual([]);
      expect(fields.name).toBe(`GM 手测·${NAME_BY_MOD[f.mod]}`);
      expect(fields.matches).toEqual(['*://*/*']);
      expect(fields.runAt).toBe('document_end');
      expect(fields.world).toBe('USER_SCRIPT');
      expect(fields.meta.noframes).toBe(true);
      expect(fields.meta.namespace).toBe('ai-browser-extend/gmt-manual');
    });

    it(`[${f.mod}] grants 精确等于模块 API 并集`, () => {
      const { fields } = parseUserScript(f.text);
      expect([...fields.meta.grants ?? []].sort()).toEqual([...f.grants].sort());
      // 全部 grant 都在注册表内（防手滑写出不存在的 API 名）
      for (const g of fields.meta.grants ?? []) {
        expect(GM_API_REGISTRY[g] != null || g === 'unsafeWindow').toBe(true);
      }
    });

    it(`[${f.mod}] 卡片定义条数与 spec §5 一致`, () => {
      // 卡片以 { id: '<模块前缀><序号>', api: ... } 形式定义；数 cards 数组字面量里的 id 行
      const idRe = /\{ id: '([a-z]\d+)'/g;
      const ids = [...f.text.matchAll(idRe)].map((m) => m[1]);
      expect(ids.length).toBe(f.cards);
    });

    it(`[${f.mod}] 体量 ≤ 280KB（MAX_TEXT_LENGTH 护栏）`, () => {
      expect(f.text.length).toBeLessThanOrEqual(280 * 1024);
    });

    it(`[${f.mod}] 产物与源同步（源 + 内核拼接 = 产物；防改源忘跑 build）`, () => {
      const END = '// ==/UserScript==';
      const header = f.src.slice(0, f.src.indexOf(END) + END.length);
      const body = f.src.slice(f.src.indexOf(END) + END.length).trim();
      const expected = `${header}\n\n(function () {\n'use strict';\n${coreText}\n${body}\n})();\n`;
      expect(f.text).toBe(expected);
    });
  }

  it('[network] 额外声明 @connect cdn.jsdelivr.net', () => {
    const { fields } = parseUserScript(networkText);
    expect(fields.meta.connects).toEqual(['cdn.jsdelivr.net']);
  });

  it('[内核] 存储键前缀 __gmt_manual_ 与探针标记 __gmt_probe=1', () => {
    expect(coreText).toContain('__gmt_manual_');
    expect(coreText).toContain('__gmt_probe=1');
    expect(coreText).toContain('var GMT');
  });
});

// 模块中文名（与各源 @name 一致）
const NAME_BY_MOD: Record<string, string> = {
  storage: '值存储',
  'dom-resource': 'DOM资源日志',
  interaction: '菜单通知剪贴板',
  tabs: '标签页',
  network: '网络',
};
```

注意两处口径：
1. 内核命名空间是 `var GMT =`（spec §4 伪码里的 `GMTManual.render` 落地为 `GMT.render`）——测试断言 `var GMT` 锚点，各模块源以 `GMT.render({...})` 收尾。
2. 每个源末尾都有 `GMT.render({` 调用——在「产物与源同步」用例里已被等价覆盖，不再单独断言。

- [ ] **Step 2: 跑测试**

```bash
npx vitest run tests/shared/gmt-manual-fixtures.test.ts
```

Expected: 全绿（约 27 用例：5 模块 × 5 用例 + network @connect + 内核锚点）。

- [ ] **Step 3: Commit**

```bash
git add tests/shared/gmt-manual-fixtures.test.ts
git commit -m "test(manual): 五产物 fixture 护栏（解析面/grants/卡片数/源同步）"
```

---

### Task 6: 全量回归 + package.json 校验

- [ ] **Step 1: 全量验证**

```bash
npm run compile
npm run test
npm run build
```

Expected: compile 零错误；全量测试绿（含新 fixture 测试）；WXT 构建成功（脚本族不入 WXT 产物，不影响体积）。

- [ ] **Step 2: 幂等校验（重跑 build 无 diff）**

```bash
npm run build:manual
git diff --stat
```

Expected: `git diff --stat` 无产物文件变更（拼接幂等）。

- [ ] **Step 3: Commit（如有 package.json 遗漏变更；无则跳过）**

```bash
git status --short
# 有变更才提交：
git add -A && git commit -m "chore(manual): 回归收尾"
```

---

## 完成定义（对应 spec §10）

1. `npm run build:manual` 产五产物且幂等；compile/test/build 全绿。
2. fixture 单测五产物全绿（解析零警告 / grants 精确 / 卡片数 7+5+4+2+4 / 源同步 / 体量护栏）。
3. 人工冒烟路径走通：导入 `gmt-manual-storage.user.js` → example.com 面板 7 卡 → 逐卡标记 → 刷新结果仍在 → 重置清空。
