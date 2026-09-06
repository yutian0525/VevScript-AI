// tests/background/scripts-llm-tier.test.ts
// SCRIPTS_GET/SET_LLM_TIER 消息对（Task 5）：详情页「模型调用」档位读写接线 + 改档清会话内授权。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { MessageRouter } from '../../background/router';
import { initScriptsModule } from '../../background/scripts';
import { getLlmTier } from '../../background/gm-permissions';
import { saveScript } from '../../storage/scripts';
import type { UserScript } from '../../shared/types';

function mkScript(over: Partial<UserScript> = {}): UserScript {
  return {
    id: 's1', text: '', name: 't', enabled: true, matches: ['https://a.com/*'], code: '',
    runAt: 'document_idle', world: 'USER_SCRIPT', source: 'user', createdAt: 1, updatedAt: 1,
    meta: {}, ...over,
  };
}

describe('SCRIPTS_GET/SET_LLM_TIER', () => {
  beforeEach(() => { fakeBrowser.reset(); vi.restoreAllMocks(); });

  it('get 缺省 ask；set 往返；set 后 session 授权被清', async () => {
    await saveScript(mkScript());
    vi.spyOn(browser.tabs.onUpdated, 'addListener').mockImplementation(() => {});
    vi.spyOn(browser.tabs.onRemoved, 'addListener').mockImplementation(() => {});
    const router = new MessageRouter();
    initScriptsModule(router);

    const r1 = await router.dispatch({ type: 'SCRIPTS_GET_LLM_TIER', id: 's1' } as never);
    expect(r1).toEqual({ ok: true, data: { tier: 'ask' } });

    const gmApi = await import('../../background/gm-api');
    gmApi.__addLlmSessionForTest('s1');
    expect(gmApi.__llmSessionHasForTest('s1')).toBe(true);

    await router.dispatch({ type: 'SCRIPTS_SET_LLM_TIER', id: 's1', tier: 'deny' } as never);
    expect(await getLlmTier('s1')).toBe('deny');
    expect(gmApi.__llmSessionHasForTest('s1')).toBe(false);

    const r2 = await router.dispatch({ type: 'SCRIPTS_GET_LLM_TIER', id: 's1' } as never);
    expect(r2).toEqual({ ok: true, data: { tier: 'deny' } });
  });
});
