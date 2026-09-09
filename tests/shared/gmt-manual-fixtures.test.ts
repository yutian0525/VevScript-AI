// tests/shared/gmt-manual-fixtures.test.ts
// gmt-manual-* 五产物 fixture 护栏（spec §7）：解析面/grants/卡片数/体量/源同步。
// 文本经 Vite ?raw 原文内联（同 gmt-selftest-fixture.test.ts 惯例——项目无 @types/node，
// node:fs 过不了 `npm run compile` 门禁，故不采用）。
// 拼接公式与 scripts/build-manual.mjs 一致：源同步用例防「改了源忘跑 build」。
import { describe, it, expect } from 'vitest';
import { parseUserScript } from '../../shared/userscript-meta';
import { GM_API_REGISTRY, SPECIAL_GRANTS } from '../../shared/gm-apis';

import storageText from '../../fixtures/userscripts/manual/gmt-manual-storage.user.js?raw';
import domResourceText from '../../fixtures/userscripts/manual/gmt-manual-dom-resource.user.js?raw';
import interactionText from '../../fixtures/userscripts/manual/gmt-manual-interaction.user.js?raw';
import tabsText from '../../fixtures/userscripts/manual/gmt-manual-tabs.user.js?raw';
import networkText from '../../fixtures/userscripts/manual/gmt-manual-network.user.js?raw';
import cookieText from '../../fixtures/userscripts/manual/gmt-manual-cookie.user.js?raw';
import downloadText from '../../fixtures/userscripts/manual/gmt-manual-download.user.js?raw';
import urlchangeText from '../../fixtures/userscripts/manual/gmt-manual-urlchange.user.js?raw';
import notifyMenuText from '../../fixtures/userscripts/manual/gmt-manual-notify-menu.user.js?raw';

import storageSrc from '../../fixtures/userscripts/manual/storage.user.js.src?raw';
import domResourceSrc from '../../fixtures/userscripts/manual/dom-resource.user.js.src?raw';
import interactionSrc from '../../fixtures/userscripts/manual/interaction.user.js.src?raw';
import tabsSrc from '../../fixtures/userscripts/manual/tabs.user.js.src?raw';
import networkSrc from '../../fixtures/userscripts/manual/network.user.js.src?raw';
import cookieSrc from '../../fixtures/userscripts/manual/cookie.user.js.src?raw';
import downloadSrc from '../../fixtures/userscripts/manual/download.user.js.src?raw';
import urlchangeSrc from '../../fixtures/userscripts/manual/urlchange.user.js.src?raw';
import notifyMenuSrc from '../../fixtures/userscripts/manual/notify-menu.user.js.src?raw';

import coreText from '../../fixtures/userscripts/manual/_panel-core.js?raw';

/** 卡片定义条目：小写字母 + 纯数字 id（步骤按钮 id 如 's2-set' 带 - 不会命中） */
const CARD_RE = /\{ id: '([a-z]\d+)'/g;

interface ManualFixture {
  mod: string;
  /** 模块中文名（@name = 「GM 手测·<中文名>」） */
  label: string;
  /** spec §5 卡片数 */
  cards: number;
  /** 源文件实际 @grant 行（逐文件核对，非记忆） */
  grants: string[];
  text: string;
  src: string;
}

const FIXTURES: ManualFixture[] = [
  {
    mod: 'storage',
    label: '值存储',
    cards: 10,
    grants: ['GM_info', 'GM_getValue', 'GM_setValue', 'GM_deleteValue', 'GM_listValues', 'GM_addValueChangeListener', 'GM_addStyle', 'GM_getValues', 'GM_setValues', 'GM_deleteValues', 'GM_removeValueChangeListener'],
    text: storageText,
    src: storageSrc,
  },
  {
    mod: 'dom-resource',
    label: 'DOM资源日志',
    cards: 7,
    grants: ['GM_addStyle', 'GM_getResourceText', 'GM_log', 'GM_getValue', 'GM_setValue', 'GM_deleteValue', 'unsafeWindow', 'GM_addElement', 'GM_getResourceURL'],
    text: domResourceText,
    src: domResourceSrc,
  },
  {
    mod: 'interaction',
    label: '菜单通知剪贴板',
    cards: 4,
    grants: ['GM_registerMenuCommand', 'GM_notification', 'GM_setClipboard', 'GM_info', 'GM_getValue', 'GM_setValue', 'GM_deleteValue', 'GM_addStyle'],
    text: interactionText,
    src: interactionSrc,
  },
  {
    mod: 'tabs',
    label: '标签页',
    cards: 5,
    grants: ['GM_openInTab', 'GM_setValue', 'GM_getValue', 'GM_addStyle', 'GM_deleteValue', 'GM_getTab', 'GM_saveTab', 'GM_getTabs', 'window.close', 'window.focus', 'unsafeWindow'],
    text: tabsText,
    src: tabsSrc,
  },
  {
    mod: 'network',
    label: '网络',
    cards: 4,
    grants: ['GM_xmlhttpRequest', 'GM_setClipboard', 'GM_setValue', 'GM_getValue', 'GM_deleteValue', 'GM_addStyle'],
    text: networkText,
    src: networkSrc,
  },
  { mod: 'cookie', label: 'Cookie', cards: 3,
    grants: ['GM_cookie', 'GM_getValue', 'GM_setValue', 'GM_deleteValue', 'GM_addStyle'],
    text: cookieText, src: cookieSrc },
  { mod: 'download', label: '下载', cards: 1,
    grants: ['GM_download', 'GM_getValue', 'GM_setValue', 'GM_deleteValue', 'GM_addStyle'],
    text: downloadText, src: downloadSrc },
  { mod: 'urlchange', label: 'URL变化', cards: 2,
    grants: ['window.onurlchange', 'GM_getValue', 'GM_setValue', 'GM_deleteValue', 'GM_addStyle'],
    text: urlchangeText, src: urlchangeSrc },
  { mod: 'notify-menu', label: '通知菜单', cards: 5,
    grants: ['GM_notification', 'GM_closeNotification', 'GM_updateNotification', 'GM_registerMenuCommand', 'GM_unregisterMenuCommand', 'GM_getValue', 'GM_setValue', 'GM_deleteValue', 'GM_addStyle'],
    text: notifyMenuText, src: notifyMenuSrc },
];

/** 按 scripts/build-manual.mjs 的拼接公式重算产物文本 */
function expectedProduct(src: string, core: string): string {
  const END = '// ==/UserScript==';
  const endIdx = src.indexOf(END);
  if (endIdx === -1) throw new Error('src 缺少 ==/UserScript== 结束标记');
  const header = src.slice(0, endIdx + END.length);
  const body = src.slice(endIdx + END.length).trim();
  return `${header}\n\n(function () {\n'use strict';\n${core}\n${body}\n})();\n`;
}

for (const f of FIXTURES) {
  const { fields, warnings } = parseUserScript(f.text);

  describe(`gmt-manual-${f.mod} fixture`, () => {
    it('解析零警告 + 基本字段', () => {
      expect(warnings).toEqual([]);
      expect(fields.name).toBe(`GM 手测·${f.label}`);
      expect(fields.matches).toEqual(['*://*/*']);
      expect(fields.runAt).toBe('document_end');
      expect(fields.world).toBe('USER_SCRIPT');
      expect(fields.meta.noframes).toBe(true);
      expect(fields.meta.namespace).toBe('vevscript-ai/gmt-manual');
    });

    it('grants 精确等于模块 API 并集，且全部已注册', () => {
      expect([...(fields.meta.grants ?? [])].sort()).toEqual([...f.grants].sort());
      for (const g of f.grants) {
        expect(GM_API_REGISTRY[g] != null || SPECIAL_GRANTS.has(g)).toBe(true);
      }
    });

    it(`卡片数 = ${f.cards}（spec §5）`, () => {
      const ids = [...f.text.matchAll(CARD_RE)].map((m) => m[1] ?? '');
      expect(ids).toHaveLength(f.cards);
    });

    it('体量 ≤ 280KB（storage MAX_TEXT_LENGTH 护栏）', () => {
      expect(f.text.length).toBeLessThanOrEqual(280 * 1024);
    });

    it('产物与源同步（按拼接公式重算，防改源忘跑 build）', () => {
      expect(f.text).toBe(expectedProduct(f.src, coreText));
    });
  });
}

describe('gmt-manual fixture 附加护栏', () => {
  it('[network] 额外声明 @connect cdn.jsdelivr.net', () => {
    expect(parseUserScript(networkText).fields.meta.connects).toEqual(['cdn.jsdelivr.net']);
  });

  it('[内核] 锚点：GMT 定义 / __gmt_manual_ 前缀 / __gmt_probe=1 探针标记', () => {
    expect(coreText).toContain('var GMT');
    expect(coreText).toContain('__gmt_manual_');
    // 实际（以文件为准）：__gmt_probe=1 字面量在 tabs 源的 probe.mark 配置里，
    // 内核只按 cfg.probe.mark 动态比对、不持该字面量——故对拼接产物断言
    expect(tabsText).toContain('__gmt_probe=1');
  });
});
