// tests/shared/gm-apis.test.ts
import { describe, it, expect } from 'vitest';
import { GM_API_REGISTRY, classifyGrants } from '../../shared/gm-apis';

describe('GM_API_REGISTRY', () => {
  it('全部 29 个 API 有 impl 分支', () => {
    expect(Object.keys(GM_API_REGISTRY).sort()).toEqual([
      'GM_addElement', 'GM_addStyle', 'GM_addValueChangeListener', 'GM_closeNotification',
      'GM_cookie', 'GM_deleteValue', 'GM_deleteValues', 'GM_download', 'GM_getResourceText',
      'GM_getResourceURL', 'GM_getTab', 'GM_getTabs', 'GM_getValue', 'GM_getValues', 'GM_info',
      'GM_listValues', 'GM_llmChat', 'GM_log', 'GM_notification', 'GM_openInTab',
      'GM_registerMenuCommand', 'GM_removeValueChangeListener', 'GM_saveTab', 'GM_setClipboard',
      'GM_setValue', 'GM_setValues', 'GM_unregisterMenuCommand', 'GM_updateNotification',
      'GM_xmlhttpRequest',
    ]);
  });

  it('每个条目 impl 属于三个分支之一', () => {
    for (const [name, def] of Object.entries(GM_API_REGISTRY)) {
      expect(['snapshot', 'local', 'bridge']).toContain(def.impl);
      expect(typeof def.promiseForm).toBe('boolean');
    }
  });
});

describe('classifyGrants', () => {
  it('按注册表二分：supported / unsupported', () => {
    const r = classifyGrants(['GM_getValue', 'GM_fakeApi', 'unsafeWindow', 'none']);
    expect(r.supported).toEqual(['GM_getValue', 'unsafeWindow']);
    expect(r.unsupported).toEqual(['GM_fakeApi']);
  });

  it('新特殊 grant：window.close/focus/onurlchange 归 supported', () => {
    const { supported } = classifyGrants(['window.close', 'window.focus', 'window.onurlchange']);
    expect(supported).toEqual(['window.close', 'window.focus', 'window.onurlchange']);
  });

  it('none 与空数组都归空', () => {
    expect(classifyGrants(['none'])).toEqual({ supported: [], unsupported: [] });
    expect(classifyGrants([])).toEqual({ supported: [], unsupported: [] });
  });

  it('空字符串 grant 不进 unsupported（裸 @grant 防御）', () => {
    expect(classifyGrants(['', 'GM_getValue'])).toEqual({ supported: ['GM_getValue'], unsupported: [] });
  });
});

describe('GM_llmChat 注册', () => {
  it('bridge 实现 + Promise 形态', () => {
    expect(GM_API_REGISTRY.GM_llmChat).toEqual({ impl: 'bridge', promiseForm: true });
  });
  it('classifyGrants 归为 supported', () => {
    const { supported, unsupported } = classifyGrants(['GM_llmChat', 'GM_fakeApi']);
    expect(supported).toEqual(['GM_llmChat']);
    expect(unsupported).toEqual(['GM_fakeApi']);
  });
});
