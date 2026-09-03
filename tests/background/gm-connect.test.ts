import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { matchConnect, ConnectDecision, matchConnectWithPermissions, handleGmCall, resolveConfirm, getPendingConfirms } from '../../background/gm-api';
import { setAlwaysAllow } from '../../background/gm-permissions';
import { saveScript } from '../../storage/scripts';
import type { UserScript } from '../../shared/types';

function mkScript(over: Partial<UserScript> = {}): UserScript {
  return {
    id: 's1', text: '', name: 't', enabled: true, matches: ['https://a.com/*'], code: '',
    runAt: 'document_idle', world: 'USER_SCRIPT', source: 'user', createdAt: 1, updatedAt: 1,
    meta: { grants: ['GM_xmlhttpRequest'] }, ...over,
  };
}

describe('matchConnect', () => {
  it('self：同 host / 子域放行', () => {
    expect(matchConnect([], 'https://api.a.com/x', 'https://a.com/', [])).toBe(ConnectDecision.ALLOW);
    expect(matchConnect([], 'https://a.com/x', 'https://a.com/', [])).toBe(ConnectDecision.ALLOW);
  });
  it('@connect 命中放行（精确 / *.通配 / *）', () => {
    expect(matchConnect(['api.b.com'], 'https://api.b.com/x', 'https://a.com/', [])).toBe(ConnectDecision.ALLOW);
    expect(matchConnect(['*.b.com'], 'https://x.b.com/x', 'https://a.com/', [])).toBe(ConnectDecision.ALLOW);
    expect(matchConnect(['*'], 'https://any.com/x', 'https://a.com/', [])).toBe(ConnectDecision.ALLOW);
  });
  it('列了 @connect 不命中 → DENY', () => {
    expect(matchConnect(['b.com'], 'https://c.com/x', 'https://a.com/', [])).toBe(ConnectDecision.DENY);
  });
  it('未列 @connect：always 授权 → ALLOW；否则 CONFIRM', () => {
    expect(matchConnect([], 'https://c.com/x', 'https://a.com/', ['c.com'])).toBe(ConnectDecision.ALLOW);
    expect(matchConnect([], 'https://d.com/x', 'https://a.com/', [])).toBe(ConnectDecision.CONFIRM);
  });
});

describe('matchConnectWithPermissions（查 always 授权库）', () => {
  beforeEach(() => fakeBrowser.reset());
  it('always 命中 → ALLOW；否则 CONFIRM', async () => {
    await setAlwaysAllow('s1', 'c.com');
    expect(await matchConnectWithPermissions([], 'https://c.com/x', 'https://a.com/', 's1')).toBe(ConnectDecision.ALLOW);
    expect(await matchConnectWithPermissions([], 'https://d.com/x', 'https://a.com/', 's1')).toBe(ConnectDecision.CONFIRM);
  });
});

describe('GM_xmlhttpRequest 确认流', () => {
  beforeEach(() => { fakeBrowser.reset(); vi.restoreAllMocks(); vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({} as never); });

  it('CONFIRM 路径：广播 GM_CONFIRM_PENDING；resolve allow-once 后 fetch', async () => {
    await saveScript(mkScript());
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, statusText: 'OK', headers: new Map(), text: async () => 'body', url: 'https://c.com/x' }));
    vi.stubGlobal('fetch', fetchMock);

    const pending = handleGmCall(
      { scriptId: 's1', api: 'XmlHttpRequest', reqId: 1, params: [{ url: 'https://c.com/x', method: 'GET' }] },
      { tab: { id: 1, url: 'https://a.com/' } } as never,
    );
    await new Promise((r) => setTimeout(r, 10));
    const confirms = getPendingConfirms();
    expect(confirms).toHaveLength(1);
    expect(confirms[0]).toMatchObject({ scriptId: 's1', host: 'c.com' });

    await resolveConfirm(confirms[0]!.confirmId, 'allow-once');
    const r = await pending as { ok: boolean; data?: { status: number; body: string; finalUrl: string } };
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ status: 200, body: 'body', finalUrl: 'https://c.com/x' });
    vi.unstubAllGlobals();
  });

  it('resolve always → 落库 + fetch；下次同域直通', async () => {
    await saveScript(mkScript());
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, statusText: 'OK', headers: new Map(), text: async () => 'ok', url: 'https://d.com/x' }));
    vi.stubGlobal('fetch', fetchMock);

    const pending = handleGmCall(
      { scriptId: 's1', api: 'XmlHttpRequest', reqId: 2, params: [{ url: 'https://d.com/x' }] },
      { tab: { id: 1, url: 'https://a.com/' } } as never,
    );
    await new Promise((r) => setTimeout(r, 10));
    const cid = getPendingConfirms()[0]!.confirmId;
    await resolveConfirm(cid, 'always');
    expect((await pending as { ok: boolean }).ok).toBe(true);

    const again = await handleGmCall(
      { scriptId: 's1', api: 'XmlHttpRequest', reqId: 3, params: [{ url: 'https://d.com/x' }] },
      { tab: { id: 1, url: 'https://a.com/' } } as never,
    );
    expect((again as { ok: boolean }).ok).toBe(true);
    vi.unstubAllGlobals();
  });

  it('deny → ok:false（onerror 语义）', async () => {
    await saveScript(mkScript());
    const pending = handleGmCall(
      { scriptId: 's1', api: 'XmlHttpRequest', reqId: 4, params: [{ url: 'https://e.com/x' }] },
      { tab: { id: 1, url: 'https://a.com/' } } as never,
    );
    await new Promise((r) => setTimeout(r, 10));
    const cid = getPendingConfirms()[0]!.confirmId;
    await resolveConfirm(cid, 'deny');
    expect((await pending as { ok: boolean }).ok).toBe(false);
  });

  it('列了 @connect 不命中 → 直接 DENY（不弹卡）', async () => {
    await saveScript(mkScript({ meta: { grants: ['GM_xmlhttpRequest'], connects: ['b.com'] } }));
    const r = await handleGmCall(
      { scriptId: 's1', api: 'XmlHttpRequest', reqId: 5, params: [{ url: 'https://c.com/x' }] },
      { tab: { id: 1, url: 'https://a.com/' } } as never,
    );
    expect((r as { ok: boolean }).ok).toBe(false);
    expect(getPendingConfirms()).toHaveLength(0);
  });
});
