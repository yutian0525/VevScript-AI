// tests/shared/userscript-meta.test.ts
import { describe, it, expect } from 'vitest';
import { parseUserScript, stringifyUserScript } from '../../shared/userscript-meta';
import type { UserScript } from '../../shared/types';

const fixture = `// ==UserScript==
// @name         去广告助手
// @namespace    https://example.org/
// @version      1.2.0
// @author       someone
// @description  移除页面广告
// @match        https://example.com/*
// @match        https://www.example.com/*
// @run-at       document-end
// @grant        GM_setValue
// ==/UserScript==

document.querySelector('.ad')?.remove();`;

describe('parseUserScript', () => {
  it('解析标准头：name/matches/run-at/world/grants/代码体', () => {
    const { fields, warnings } = parseUserScript(fixture);
    expect(fields.name).toBe('去广告助手');
    expect(fields.matches).toEqual(['https://example.com/*', 'https://www.example.com/*']);
    expect(fields.runAt).toBe('document_end');
    expect(fields.world).toBe('USER_SCRIPT'); // 缺省
    expect(fields.code).toBe('\ndocument.querySelector(\'.ad\')?.remove();');
    expect(fields.meta).toMatchObject({ namespace: 'https://example.org/', version: '1.2.0', author: 'someone', description: '移除页面广告', grants: ['GM_setValue'] });
    expect(warnings.some((w) => w.includes('不支持'))).toBe(false);
  });

  it('无元数据头：整段作为 code + 警告', () => {
    const { fields, warnings } = parseUserScript('console.log(1)', 'my.user.js');
    expect(fields.code).toBe('console.log(1)');
    expect(fields.name).toBe('my');
    expect(fields.matches).toEqual([]);
    expect(fields.world).toBe('USER_SCRIPT');
    expect(warnings.some((w) => w.includes('元数据头'))).toBe(true);
  });

  it('无 @name 时用 fallbackName，再退「未命名脚本」', () => {
    const src = '// ==UserScript==\n// @match https://a.com/*\n// ==/UserScript==\n';
    expect(parseUserScript(src, 'x.user.js').fields.name).toBe('x');
    expect(parseUserScript(src).fields.name).toBe('未命名脚本');
  });

  it('@run-at 三种值映射 + 非法值警告并回退 document_idle', () => {
    const mk = (v: string) => `// ==UserScript==\n// @run-at ${v}\n// ==/UserScript==\n`;
    expect(parseUserScript(mk('document-start')).fields.runAt).toBe('document_start');
    expect(parseUserScript(mk('document-idle')).fields.runAt).toBe('document_idle');
    const bad = parseUserScript(mk('whenever'));
    expect(bad.fields.runAt).toBe('document_idle');
    expect(bad.warnings.some((w) => w.includes('@run-at'))).toBe(true);
  });

  it('@include pattern 形式并入 matches（去重），不再警告', () => {
    const src = '// ==UserScript==\n// @match https://a.com/*\n// @include https://b.com/*\n// @include https://a.com/*\n// ==/UserScript==\ncode();';
    const r = parseUserScript(src);
    expect(r.fields.matches).toEqual(['https://a.com/*', 'https://b.com/*']);
    expect(r.warnings.some((w) => w.includes('@include'))).toBe(false);
  });

  it('@include 正则形式 /…/ 警告并忽略', () => {
    const src = '// ==UserScript==\n// @include /^https:\\/\\/a\\.com\\//\n// ==/UserScript==\ncode();';
    const r = parseUserScript(src);
    expect(r.fields.matches).toEqual([]);
    expect(r.warnings.some((w) => w.includes('正则形式'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('@match/@include'))).toBe(true); // 无匹配规则警告仍在
  });

  it('@include 非 pattern glob 警告并忽略', () => {
    const src = '// ==UserScript==\n// @include *.a.com/*\n// ==/UserScript==\ncode();';
    const r = parseUserScript(src);
    expect(r.fields.matches).toEqual([]);
    expect(r.warnings.some((w) => w.includes('match pattern 语法'))).toBe(true);
  });

  it('@match 容错：合法保留、非法（缺路径/带端口）警告并跳过，不整条失败', () => {
    const src = '// ==UserScript==\n// @match https://a.com/*\n// @match https://b.com\n// @match *://c.com:8080/*\n// ==/UserScript==\ncode();';
    const r = parseUserScript(src);
    expect(r.fields.matches).toEqual(['https://a.com/*']); // 只保留合法条目
    expect(r.warnings.some((w) => w.includes('@match') && w.includes('match pattern 语法'))).toBe(true);
    expect(r.warnings.join('\n')).toContain('https://b.com');
    expect(r.warnings.join('\n')).toContain('*://c.com:8080/*');
  });

  it('@world：USER_SCRIPT/MAIN 映射 + 非法值警告回退 USER_SCRIPT', () => {
    const mk = (v: string) => `// ==UserScript==\n// @world ${v}\n// ==/UserScript==\n`;
    expect(parseUserScript(mk('MAIN')).fields.world).toBe('MAIN');
    expect(parseUserScript(mk('USER_SCRIPT')).fields.world).toBe('USER_SCRIPT');
    const bad = parseUserScript(mk('ISOLATED'));
    expect(bad.fields.world).toBe('USER_SCRIPT');
    expect(bad.warnings.some((w) => w.includes('@world'))).toBe(true);
  });

  it('其它不支持的键汇总为一条 ignored 警告', () => {
    const src = '// ==UserScript==\n// @icon a.png\n// @updateURL https://u\n// @downloadURL https://d\n// ==/UserScript==\n';
    const { warnings } = parseUserScript(src);
    expect(warnings.filter((w) => w.includes('已忽略'))).toHaveLength(1);
    expect(warnings.join('\n')).toContain('@icon');
  });

  it('@grant none 不产生警告', () => {
    const src = '// ==UserScript==\n// @match https://a.com/*\n// @grant none\n// ==/UserScript==\n';
    const r = parseUserScript(src);
    expect(r.warnings.some((w) => w.includes('GM_*'))).toBe(false);
    expect(r.fields.meta.grants).toBeUndefined();
  });

  it('@connect/@require/@resource 解析进 meta（多条去重）', () => {
    const src = [
      '// ==UserScript==',
      '// @name        t',
      '// @match       https://a.com/*',
      '// @connect     api.a.com',
      '// @connect     api.a.com',
      '// @connect     b.com',
      '// @require     https://cdn.example/lib.js',
      '// @require     https://cdn.example/lib.js',
      '// @resource    css https://cdn.example/s.css',
      '// ==/UserScript==',
      'x();',
    ].join('\n');
    const { fields, warnings } = parseUserScript(src);
    expect(fields.meta.connects).toEqual(['api.a.com', 'b.com']);
    expect(fields.meta.requires).toEqual(['https://cdn.example/lib.js']);
    expect(fields.meta.resources).toEqual({ css: 'https://cdn.example/s.css' });
    // connect/require/resource 不再进 ignoredKeys 警告
    expect(warnings.join('\n')).not.toContain('@connect');
    expect(warnings.join('\n')).not.toContain('@require');
  });

  it('grant 警告按注册表判定：有 unsupported 才警示，全 supported 无警告', () => {
    const ok = parseUserScript('// ==UserScript==\n// @name t\n// @match https://a.com/*\n// @grant GM_getValue\n// @grant GM_setValue\n// ==/UserScript==\nx();');
    expect(ok.warnings.some((w) => w.includes('不支持'))).toBe(false);
    expect(ok.fields.meta.grants).toEqual(['GM_getValue', 'GM_setValue']);

    const bad = parseUserScript('// ==UserScript==\n// @name t\n// @match https://a.com/*\n// @grant GM_getValue\n// @grant GM_download\n// ==/UserScript==\nx();');
    expect(bad.warnings.some((w) => w.includes('GM_download'))).toBe(true);
    expect(bad.warnings.some((w) => w.includes('GM_getValue'))).toBe(false);
  });
});

describe('stringifyUserScript / parse 往返', () => {
  it('stringify → parse 元数据无损（world USER_SCRIPT 缺省不输出）', () => {
    const s: UserScript = {
      id: 's1', text: '', name: '测试', enabled: true, matches: ['https://a.com/*'],
      code: 'console.log("x");', runAt: 'document_start', world: 'USER_SCRIPT', source: 'import',
      meta: { namespace: 'ns', version: '0.1', author: 'me', description: '描述', grants: ['GM_getValue'] },
      createdAt: 0, updatedAt: 0,
    };
    const text = stringifyUserScript(s);
    expect(text).toContain('@name');
    const back = parseUserScript(text);
    expect(back.fields.name).toBe('测试');
    expect(back.fields.matches).toEqual(['https://a.com/*']);
    expect(back.fields.runAt).toBe('document_start');
    expect(back.fields.world).toBe('USER_SCRIPT');
    expect(back.fields.code).toBe('\nconsole.log("x");');
    expect(back.fields.meta).toEqual(s.meta);
  });

  it('world MAIN 往返无损（@world 输出）', () => {
    const s: UserScript = {
      id: 's2', text: '', name: '主世界', enabled: true, matches: ['https://a.com/*'],
      code: 'x();', runAt: 'document_idle', world: 'MAIN', source: 'user',
      createdAt: 0, updatedAt: 0,
    };
    const text = stringifyUserScript(s);
    expect(text).toContain('@world');
    const back = parseUserScript(text);
    expect(back.fields.world).toBe('MAIN');
    expect(back.fields.name).toBe('主世界');
    expect(back.fields.code).toBe('\nx();');
  });
});
