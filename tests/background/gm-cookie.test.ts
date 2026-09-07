import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { listCookies, setCookie, deleteCookie, cookieTargetUrl } from '../../background/gm-cookie';
import { handleGmCall } from '../../background/gm-api';
import { resolveConfirm, getPending, __resetConfirmQueue } from '../../background/confirm-queue';
import { saveScript } from '../../storage/scripts';
import type { UserScript } from '../../shared/types';

describe('gm-cookie 封装', () => {
  beforeEach(() => { fakeBrowser.reset(); vi.restoreAllMocks(); });

  it('cookieTargetUrl：url 优先，其次 domain 构造 https', () => {
    expect(cookieTargetUrl({ url: 'https://a.com/x' })).toBe('https://a.com/x');
    expect(cookieTargetUrl({ domain: '.a.com' })).toBe('https://a.com/');
    expect(cookieTargetUrl({})).toBe('');
  });

  it('list/set/delete 透传 chrome.cookies', async () => {
    const getAll = vi.fn(async () => [{ name: 'k', value: 'v', domain: 'a.com' }]);
    const set = vi.fn(async () => ({}));
    const remove = vi.fn(async () => ({}));
    (browser as unknown as { cookies: Record<string, unknown> }).cookies = { getAll, set, remove };
    expect(await listCookies({ url: 'https://a.com/' })).toEqual([{ name: 'k', value: 'v', domain: 'a.com' }]);
    await setCookie({ url: 'https://a.com/', name: 'k', value: 'v' });
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://a.com/', name: 'k', value: 'v' }));
    await deleteCookie({ url: 'https://a.com/', name: 'k' });
    expect(remove).toHaveBeenCalledWith({ url: 'https://a.com/', name: 'k' });
  });
});

function mkScript(over: Partial<UserScript> = {}): UserScript {
  return {
    id: 's1', text: '', name: 't', enabled: true, matches: ['https://a.com/*'], code: '',
    runAt: 'document_idle', world: 'USER_SCRIPT', source: 'user', createdAt: 1, updatedAt: 1,
    meta: { grants: ['GM_cookie'] }, ...over,
  };
}

describe('GM_cookie 门控', () => {
  beforeEach(() => { fakeBrowser.reset(); vi.restoreAllMocks(); __resetConfirmQueue();
    vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({} as never);
    vi.spyOn(browser.tabs, 'create').mockResolvedValue({ id: 100 } as never);
    (browser as unknown as { cookies: Record<string, unknown> }).cookies = { getAll: vi.fn(async () => [{ name: 'k' }]), set: vi.fn(async () => ({})), remove: vi.fn(async () => ({})) };
  });

  it('跨域 cookie 未列 @connect → 弹卡；allow-once 后放行 list', async () => {
    await saveScript(mkScript());
    const pending = handleGmCall({ scriptId: 's1', api: 'CookieList', reqId: 1, params: [{ url: 'https://c.com/' }] }, { tab: { id: 1, url: 'https://a.com/' } } as never);
    await new Promise((r) => setTimeout(r, 10));
    const confirms = getPending();
    expect(confirms).toHaveLength(1);
    expect(confirms[0]).toMatchObject({ kind: 'connect' });
    resolveConfirm(confirms[0]!.confirmId, 'allow-once');
    const r = await pending as { ok: boolean; data?: unknown };
    expect(r.ok).toBe(true);
    expect(r.data).toEqual([{ name: 'k' }]);
  });

  it('self 域直通（同 host 不弹卡）', async () => {
    await saveScript(mkScript());
    const r = await handleGmCall({ scriptId: 's1', api: 'CookieList', reqId: 2, params: [{ url: 'https://a.com/' }] }, { tab: { id: 1, url: 'https://a.com/' } } as never);
    expect((r as { ok: boolean }).ok).toBe(true);
    expect(getPending()).toHaveLength(0);
  });
});
