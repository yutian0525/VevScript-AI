import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { getTabData, saveTabData, getAllTabData, cleanupTabData } from '../../background/gm-tab-store';

describe('gm-tab-store', () => {
  beforeEach(() => fakeBrowser.reset());

  it('getTab 首次空对象；saveTab 后读回', async () => {
    expect(await getTabData('s1', 9)).toEqual({});
    await saveTabData('s1', 9, { count: 3 });
    expect(await getTabData('s1', 9)).toEqual({ count: 3 });
  });

  it('getTabs 聚合按 tabId', async () => {
    await saveTabData('s1', 9, { a: 1 });
    await saveTabData('s1', 10, { b: 2 });
    await saveTabData('s2', 9, { c: 3 }); // 别的脚本不混入
    expect(await getAllTabData('s1')).toEqual({ '9': { a: 1 }, '10': { b: 2 } });
  });

  it('cleanup 清该脚本全部 tab 数据', async () => {
    await saveTabData('s1', 9, { a: 1 });
    await saveTabData('s1', 10, { b: 2 });
    await cleanupTabData('s1');
    expect(await getAllTabData('s1')).toEqual({});
  });
});
