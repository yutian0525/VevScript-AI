// tests/background/scripts.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  computeRuntimeScriptIds, recomputeTab, recomputeAllTabs, dropTab, getRuntimeSnapshot,
} from '../../background/scripts';
import { saveScript } from '../../storage/scripts';
import type { UserScript } from '../../shared/types';

function mkScript(over: Partial<UserScript> = {}): UserScript {
  return {
    id: 's1', name: '测试', enabled: true, matches: ['https://a.com/*'],
    code: 'x();', runAt: 'document_idle', world: 'USER_SCRIPT',
    source: 'user', createdAt: 1, updatedAt: 1, ...over,
  };
}

describe('运行态跟踪（预期注入语义）', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
    // runtimeMap 是模块级状态，fakeBrowser.reset 不会清它——用公共导出清掉上一用例残留
    getRuntimeSnapshot().forEach((e) => dropTab(e.tabId));
  });

  it('computeRuntimeScriptIds：enabled + matchUrl 联合过滤', () => {
    const scripts = [
      mkScript({ id: 'a', matches: ['https://a.com/*'] }),
      mkScript({ id: 'b', enabled: false, matches: ['https://a.com/*'] }),
      mkScript({ id: 'c', matches: ['https://b.com/*'] }),
    ];
    expect(computeRuntimeScriptIds('https://a.com/x', scripts)).toEqual(['a']);
    expect(computeRuntimeScriptIds('chrome://extensions/', scripts)).toEqual([]);
    expect(computeRuntimeScriptIds('', scripts)).toEqual([]);
  });

  it('recomputeTab：运行集变化时广播 SCRIPTS_RUNTIME；不变不广播', async () => {
    await saveScript(mkScript());
    const spy = vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue(undefined);

    await recomputeTab(1, 'https://a.com/');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toMatchObject({
      type: 'SCRIPTS_RUNTIME',
      payload: { tabId: 1, url: 'https://a.com/', scriptIds: ['s1'] },
    });

    spy.mockClear();
    await recomputeTab(1, 'https://a.com/'); // 同 url 同集合 → 不广播
    expect(spy).not.toHaveBeenCalled();
    expect(getRuntimeSnapshot()).toEqual([{ tabId: 1, url: 'https://a.com/', scriptIds: ['s1'] }]);
  });

  it('recomputeAllTabs：按 tabs.query 全量重算', async () => {
    await saveScript(mkScript({ id: 's1', matches: ['https://a.com/*'] }));
    await saveScript(mkScript({ id: 's2', matches: ['https://b.com/*'] }));
    vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue(undefined);
    await fakeBrowser.tabs.create({ url: 'https://a.com/' });
    await fakeBrowser.tabs.create({ url: 'https://b.com/' });

    await recomputeAllTabs();
    const snap = getRuntimeSnapshot();
    expect(snap).toHaveLength(2);
    const urls = snap.map((e) => e.url).sort();
    expect(urls).toEqual(['https://a.com/', 'https://b.com/']);
  });

  it('dropTab 移除条目', async () => {
    vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue(undefined);
    await recomputeTab(7, 'https://a.com/');
    dropTab(7);
    expect(getRuntimeSnapshot()).toEqual([]);
  });
});
