// tests/background/gm-token.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { storage } from 'wxt/utils/storage';
import { saveScript } from '../../storage/scripts';
import type { UserScript } from '../../shared/types';

function mkScript(over: Partial<UserScript> = {}): UserScript {
  return {
    id: 's1', text: '// ==UserScript==\n// @name t\n// @match https://a.com/*\n// ==/UserScript==\nx();',
    name: 't', enabled: true, matches: ['https://a.com/*'], code: 'x();',
    runAt: 'document_idle', world: 'USER_SCRIPT', source: 'user', createdAt: 1, updatedAt: 1, ...over,
  };
}

/** gm-token 的 seed in-flight 记忆是模块级状态，fakeBrowser.reset() 只清 storage 清不掉它——
 *  每个用例先 vi.resetModules() 再动态 import 拿全新模块实例（顺带模拟 SW 重启）。 */
function freshGmToken() {
  return import('../../background/gm-token');
}

describe('gm-token', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.resetModules();
  });

  it('同 seed 同 scriptId 派生相同 token；不同 scriptId 不同', async () => {
    const { getBridgeToken } = await freshGmToken();
    const t1 = await getBridgeToken('s1');
    const t2 = await getBridgeToken('s1');
    const t3 = await getBridgeToken('s2');
    expect(t1).toBe(t2);
    expect(t1).not.toBe(t3);
    expect(t1).toMatch(/^[a-f0-9]{16,}$/);
  });

  it('seed 持久化：第二次调用不换 token（SW 重启语义）', async () => {
    const { getBridgeToken } = await freshGmToken();
    const t1 = await getBridgeToken('s1');
    const raw = await storage.getItem<string>('local:gm:seed');
    expect(typeof raw).toBe('string');
    const t2 = await getBridgeToken('s1');
    expect(t2).toBe(t1);
  });

  it('bridgeTokensForUrl：enabled + matchUrl 过滤，disabled 不发 token', async () => {
    await saveScript(mkScript());
    await saveScript(mkScript({ id: 's2', enabled: false }));
    const { bridgeTokensForUrl } = await freshGmToken();
    const entries = await bridgeTokensForUrl('https://a.com/x');
    expect(entries.map((e) => e.scriptId)).toEqual(['s1']);
    expect(typeof entries[0]!.token).toBe('string');
  });

  it('并发首用无覆盖失配：并发 10 个调用共享同一次 seed 生成', async () => {
    const mod = await freshGmToken();
    const toks = await Promise.all(
      Array.from({ length: 10 }, (_, i) => mod.getBridgeToken('s' + i)),
    );
    // 不同 scriptId → 不同 token，均为 hex
    expect(new Set(toks).size).toBe(10);
    for (const t of toks) expect(t).toMatch(/^[a-f0-9]{16,}$/);
    // seed 已落库
    const seed = await storage.getItem<string>('local:gm:seed');
    expect(typeof seed).toBe('string');
    // 模拟 SW 重启：全新模块（in-flight 记忆清空）从落库 seed 重新派生，
    // 须与并发 burst 中的 token 一致——否则说明中途有人用了被写覆盖的 seed
    vi.resetModules();
    const mod2 = await import('../../background/gm-token');
    expect(await mod2.getBridgeToken('s0')).toBe(toks[0]);
  });
});
