import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { prefetchResources, getResourceBundle } from '../../background/gm-resources';
import type { UserScript } from '../../shared/types';

function mkScript(over: Partial<UserScript> = {}): UserScript {
  return {
    id: 's1', text: '', name: 't', enabled: true, matches: ['https://a.com/*'], code: '',
    runAt: 'document_idle', world: 'USER_SCRIPT', source: 'user', createdAt: 1, updatedAt: 1,
    meta: { requires: ['https://cdn/lib.js'], resources: { css: 'https://cdn/s.css' } }, ...over,
  };
}

describe('gm-resources', () => {
  beforeEach(() => { fakeBrowser.reset(); vi.restoreAllMocks(); });

  it('prefetchResources：fetch 全部资源落缓存；成功返回空 warnings', async () => {
    const fetchMock = vi.fn(async (url: string) => ({
      ok: true, status: 200, headers: new Map([['content-type', 'text/javascript']]),
      text: async () => `content of ${url}`,
    }));
    vi.stubGlobal('fetch', fetchMock);
    const warnings = await prefetchResources(mkScript());
    expect(warnings).toEqual([]);
    const bundle = await getResourceBundle(mkScript());
    expect(bundle.requireCodes).toEqual(['content of https://cdn/lib.js']);
    expect(bundle.resources).toEqual({ css: 'content of https://cdn/s.css' });
    vi.unstubAllGlobals();
  });

  it('失败返回 warning 且不阻塞（spec §9.4 缺哪段跳哪段）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, headers: new Map(), text: async () => '' })));
    const warnings = await prefetchResources(mkScript());
    expect(warnings).toHaveLength(2); // require + resource 各一条
    expect(warnings[0]).toContain('https://cdn/lib.js');
    const bundle = await getResourceBundle(mkScript());
    expect(bundle.requireCodes).toEqual([]); // 失败段被跳过（缓存无内容）
    vi.unstubAllGlobals();
  });

  it('7 天内缓存命中不重取', async () => {
    const fetchMock = vi.fn(async (url: string) => ({ ok: true, status: 200, headers: new Map(), text: async () => `v1 ${url}` }));
    vi.stubGlobal('fetch', fetchMock);
    await prefetchResources(mkScript());
    await prefetchResources(mkScript());
    expect(fetchMock).toHaveBeenCalledTimes(2); // 第二次全命中缓存（首次 2 个 URL 各取一次）
    vi.unstubAllGlobals();
  });
});
