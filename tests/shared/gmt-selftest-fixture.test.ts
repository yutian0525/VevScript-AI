// tests/shared/gmt-selftest-fixture.test.ts
// gmt-selftest.user.js fixture 完整性单测（spec §7）：把自检脚本当作解析器的
// 真实全字段用例——脚本本体改坏任何元字段/安装面，此处先红。
// 文本经 Vite ?raw 原文内联（vitest 跑在 Vite 管道上，等价真实读盘）——项目无 @types/node，
// node:fs/__dirname 过不了 `npm run compile` 门禁，故不采用。
import selftestText from '../../fixtures/userscripts/gmt-selftest.user.js?raw';
import { describe, it, expect } from 'vitest';
import { parseUserScript } from '../../shared/userscript-meta';
import { buildWrappedCode } from '../../shared/gm-wrapper';
import { GM_API_REGISTRY, SPECIAL_GRANTS } from '../../shared/gm-apis';
import type { UserScript } from '../../shared/types';

const text: string = selftestText;

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
      namespace: 'vevscript-ai/gmt-selftest',
      version: '1.0.0',
      author: 'gmt-selftest',
      description: '本扩展脚本池运行环境全功能自检：元字段解析自证 + 29 个 GM API 可用性',
      homepage: 'https://example.com/gmt-selftest',
      supportURL: 'https://example.com/gmt-selftest/support',
      iconURL: 'https://example.com/favicon.ico',
      downloadURL: 'https://example.com/gmt-selftest.user.js',
      updateURL: 'https://example.com/gmt-selftest.meta.js',
      noframes: true,
    });
  });

  it('匹配/run-at/world：document_end 非默认 + USER_SCRIPT 缺省', () => {
    expect(fields.matches).toEqual(['*://*/*']);
    expect(fields.runAt).toBe('document_end');
    expect(fields.world).toBe('USER_SCRIPT');
  });

  it('grants：29 个 API 全部 + 4 特殊 grant = 33 项', () => {
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
  it('buildWrappedCode 安装全部 29 个 API（下划线 + 点形式）', () => {
    const code = buildWrappedCode(asScript(), {
      token: 't', values: {}, resources: {}, requireCodes: [], extensionVersion: '1.0.0',
    });
    for (const name of Object.keys(GM_API_REGISTRY)) {
      expect(code).toContain(`install("${name}"`);
      if (GM_API_REGISTRY[name]?.promiseForm) {
        expect(code).toContain(`install("GM.${name.slice(3)}"`);
      }
      // promiseForm=false（GM_info/GM_log）无点形式 install：GM_info 由 preamble 无条件同引用安装
    }
    expect(code).toContain('GM.info = GM_info');
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
