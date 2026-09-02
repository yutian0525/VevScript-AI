// tests/background/gm-token.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { storage } from 'wxt/utils/storage';
import { getBridgeToken, bridgeTokensForUrl } from '../../background/gm-token';
import { saveScript } from '../../storage/scripts';
import type { UserScript } from '../../shared/types';

function mkScript(over: Partial<UserScript> = {}): UserScript {
  return {
    id: 's1', text: '// ==UserScript==\n// @name t\n// @match https://a.com/*\n// ==/UserScript==\nx();',
    name: 't', enabled: true, matches: ['https://a.com/*'], code: 'x();',
    runAt: 'document_idle', world: 'USER_SCRIPT', source: 'user', createdAt: 1, updatedAt: 1, ...over,
  };
}

describe('gm-token', () => {
  beforeEach(() => fakeBrowser.reset());

  it('同 seed 同 scriptId 派生相同 token；不同 scriptId 不同', async () => {
    const t1 = await getBridgeToken('s1');
    const t2 = await getBridgeToken('s1');
    const t3 = await getBridgeToken('s2');
    expect(t1).toBe(t2);
    expect(t1).not.toBe(t3);
    expect(t1).toMatch(/^[a-f0-9]{16,}$/);
  });

  it('seed 持久化：第二次调用不换 token（SW 重启语义）', async () => {
    const t1 = await getBridgeToken('s1');
    const raw = await storage.getItem<string>('local:gm:seed');
    expect(typeof raw).toBe('string');
    const t2 = await getBridgeToken('s1');
    expect(t2).toBe(t1);
  });

  it('bridgeTokensForUrl：enabled + matchUrl 过滤，disabled 不发 token', async () => {
    await saveScript(mkScript());
    await saveScript(mkScript({ id: 's2', enabled: false }));
    const entries = await bridgeTokensForUrl('https://a.com/x');
    expect(entries.map((e) => e.scriptId)).toEqual(['s1']);
    expect(typeof entries[0]!.token).toBe('string');
  });
});
