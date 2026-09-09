import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { scriptsForUrlChange, initUrlChange } from '../../background/gm-urlchange';
import { saveScript } from '../../storage/scripts';
import type { UserScript } from '../../shared/types';

function mkScript(over: Partial<UserScript>): UserScript {
  return {
    id: 's1', text: '', name: 't', enabled: true, matches: ['https://a.com/*'], code: '',
    runAt: 'document_idle', world: 'USER_SCRIPT', source: 'user', createdAt: 1, updatedAt: 1,
    meta: { grants: ['window.onurlchange'] }, ...over,
  };
}

describe('gm-urlchange', () => {
  beforeEach(() => { fakeBrowser.reset(); vi.restoreAllMocks(); });

  it('scriptsForUrlChange：仅 @grant window.onurlchange 且 match 命中且启用', async () => {
    await saveScript(mkScript({ id: 's1', matches: ['https://a.com/*'], meta: { grants: ['window.onurlchange'] } }));
    await saveScript(mkScript({ id: 's2', matches: ['https://a.com/*'], meta: { grants: [] } }));
    await saveScript(mkScript({ id: 's3', matches: ['https://b.com/*'], meta: { grants: ['window.onurlchange'] } }));
    await saveScript(mkScript({ id: 's4', enabled: false, matches: ['https://a.com/*'], meta: { grants: ['window.onurlchange'] } }));
    expect(await scriptsForUrlChange('https://a.com/page')).toEqual(['s1']);
  });

  it('initUrlChange：主帧导航事件 → dispatch 每个命中脚本；子帧忽略', async () => {
    await saveScript(mkScript({ id: 's1', matches: ['https://a.com/*'], meta: { grants: ['window.onurlchange'] } }));
    let hist: ((d: { tabId: number; frameId: number; url: string }) => void) | undefined;
    (browser as unknown as { webNavigation: unknown }).webNavigation = {
      onHistoryStateUpdated: { addListener: (cb: typeof hist) => { hist = cb; } },
      onReferenceFragmentUpdated: { addListener: vi.fn() },
    };
    const dispatch = vi.fn();
    initUrlChange(dispatch);
    hist!({ tabId: 5, frameId: 1, url: 'https://a.com/x' }); // 子帧忽略
    await new Promise((r) => setTimeout(r, 0));
    expect(dispatch).not.toHaveBeenCalled();
    hist!({ tabId: 5, frameId: 0, url: 'https://a.com/x' }); // 主帧
    await new Promise((r) => setTimeout(r, 0));
    expect(dispatch).toHaveBeenCalledWith(5, 's1', 'https://a.com/x');
  });
});
