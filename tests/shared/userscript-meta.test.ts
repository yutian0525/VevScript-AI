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
  it('解析标准头：name/matches/run-at/grants/代码体', () => {
    const { fields, warnings } = parseUserScript(fixture);
    expect(fields.name).toBe('去广告助手');
    expect(fields.matches).toEqual(['https://example.com/*', 'https://www.example.com/*']);
    expect(fields.runAt).toBe('document_end');
    expect(fields.code).toBe('\ndocument.querySelector(\'.ad\')?.remove();');
    expect(fields.meta).toMatchObject({ namespace: 'https://example.org/', version: '1.2.0', author: 'someone', description: '移除页面广告', grants: ['GM_setValue'] });
    expect(warnings.some((w) => w.includes('GM_*'))).toBe(true);
  });

  it('无元数据头：整段作为 code + 警告', () => {
    const { fields, warnings } = parseUserScript('console.log(1)', 'my.user.js');
    expect(fields.code).toBe('console.log(1)');
    expect(fields.name).toBe('my');
    expect(fields.matches).toEqual([]);
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

  it('@include 警告并忽略；无 @match 警告', () => {
    const src = '// ==UserScript==\n// @include https://a.com/*\n// ==/UserScript==\ncode();';
    const r = parseUserScript(src);
    expect(r.fields.matches).toEqual([]);
    expect(r.warnings.some((w) => w.includes('@include'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('@match'))).toBe(true);
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
});

describe('stringifyUserScript / parse 往返', () => {
  it('stringify → parse 元数据无损', () => {
    const s: UserScript = {
      id: 's1', name: '测试', enabled: true, matches: ['https://a.com/*'],
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
    expect(back.fields.code).toBe('\nconsole.log("x");');
    expect(back.fields.meta).toEqual(s.meta);
  });
});
