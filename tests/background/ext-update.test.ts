// tests/background/ext-update.test.ts
// 扩展自身更新检查（background/ext-update.ts）：清单源链回退、版本比对、节流守卫、available 不被 error 覆盖。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  readExtUpdateState, checkExtUpdate, maybeRunStartupExtUpdateCheck, readLastCheckAt,
  resetStartupCheckGuardForTest,
} from '../../background/ext-update';
import { EXT_UPDATE_STATE_KEY } from '../../shared/types';

/** latest.json 清单体 */
function manifest(over: Record<string, unknown> = {}): string {
  return JSON.stringify({ version: '9.9.9', zipUrl: 'https://x/vevscript-ai-v9.9.9-chrome-mv3.zip', notes: 'n', ...over });
}

function okJson(body: string) {
  return { ok: true, status: 200, text: async () => body };
}
function httpError(status: number) {
  return { ok: false, status, text: async () => '' };
}

/** 按主机 stub fetch：jsDelivr（源链第一位）给 first 的应答，raw.githubusercontent（兜底）给 second 的应答 */
function stubSources(first: () => { ok: boolean; status: number; text: () => Promise<string> }, second: () => { ok: boolean; status: number; text: () => Promise<string> }) {
  return vi.fn(async (url: string | URL) => {
    const u = String(url);
    return u.includes('jsdelivr') ? first() : second();
  });
}

function stubLocalVersion(v: string) {
  vi.spyOn(browser.runtime, 'getManifest').mockReturnValue(
    { version: v } as unknown as ReturnType<typeof browser.runtime.getManifest>,
  );
}

beforeEach(() => {
  fakeBrowser.reset();
  vi.restoreAllMocks();
  resetStartupCheckGuardForTest();
  stubLocalVersion('1.0.0');
});

describe('checkExtUpdate（清单源链 + 版本比对）', () => {
  it('远端版本更高 → available，zipUrl/notes 落库并广播', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okJson(manifest())));
    const sendSpy = vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue(undefined);
    const st = await checkExtUpdate();
    expect(st.status).toBe('available');
    expect(st.remoteVersion).toBe('9.9.9');
    expect(st.zipUrl).toContain('vevscript-ai-v9.9.9');
    expect(st.notes).toBe('n');
    const saved = await readExtUpdateState();
    expect(saved?.status).toBe('available');
    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'EXT_UPDATE_STATE' }));
    vi.unstubAllGlobals();
  });

  it('远端版本相同 → up-to-date 不误报', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okJson(manifest({ version: '1.0.0' }))));
    vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue(undefined);
    const st = await checkExtUpdate();
    expect(st.status).toBe('up-to-date');
    vi.unstubAllGlobals();
  });

  it('远端版本更低 → up-to-date（降级不提示）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okJson(manifest({ version: '0.0.9' }))));
    vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue(undefined);
    const st = await checkExtUpdate();
    expect(st.status).toBe('up-to-date');
    vi.unstubAllGlobals();
  });

  it('第一源 404 → 回退第二源成功', async () => {
    const fetchMock = stubSources(() => httpError(404), () => okJson(manifest()));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue(undefined);
    const st = await checkExtUpdate();
    expect(st.status).toBe('available');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it('第一源返回 HTML（SPA 兜底页/缓存污染）→ JSON 解析失败回退第二源', async () => {
    const fetchMock = stubSources(() => okJson('<!doctype html><html><body>fallback</body></html>'), () => okJson(manifest()));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue(undefined);
    const st = await checkExtUpdate();
    expect(st.status).toBe('available');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it('清单缺 version → 视为无效源继续回退', async () => {
    const fetchMock = stubSources(() => okJson('{"zipUrl":"https://x/z.zip"}'), () => okJson(manifest()));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue(undefined);
    const st = await checkExtUpdate();
    expect(st.status).toBe('available');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it('全部源失败 → error 带原因', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => httpError(404)));
    vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue(undefined);
    const st = await checkExtUpdate();
    expect(st.status).toBe('error');
    expect(st.message).toBeTruthy();
    vi.unstubAllGlobals();
  });

  it('已知 available 时检查失败 → 不覆盖（别把已知更新藏起来）', async () => {
    vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue(undefined);
    vi.stubGlobal('fetch', vi.fn(async () => okJson(manifest())));
    await checkExtUpdate(); // 先拿到 available
    vi.unstubAllGlobals();
    vi.stubGlobal('fetch', vi.fn(async () => httpError(500)));
    const st = await checkExtUpdate();
    expect(st.status).toBe('available'); // 原 available 原样保留
    expect((await readExtUpdateState())?.remoteVersion).toBe('9.9.9');
    vi.unstubAllGlobals();
  });
});

describe('maybeRunStartupExtUpdateCheck（冷启动节流 + 生命周期守卫）', () => {
  function stubAvailable() {
    vi.stubGlobal('fetch', vi.fn(async () => okJson(manifest())));
    vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue(undefined);
  }

  it('无时间戳（首次冷启动）→ 执行检查并写时间戳', async () => {
    stubAvailable();
    expect(await readLastCheckAt()).toBe(0);
    await maybeRunStartupExtUpdateCheck();
    expect((await readExtUpdateState())?.status).toBe('available');
    expect(await readLastCheckAt()).toBeGreaterThan(0);
    vi.unstubAllGlobals();
  });

  it('节流窗口内（近期已查）且非 force → 跳过，不 fetch', async () => {
    const { storage } = await import('wxt/utils/storage');
    await storage.setItem('local:ext-update:last-check', Date.now()); // 刚查过
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await maybeRunStartupExtUpdateCheck(); // 非 force
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('节流窗口内 + force（onStartup/onInstalled）→ 仍执行', async () => {
    const { storage } = await import('wxt/utils/storage');
    await storage.setItem('local:ext-update:last-check', Date.now());
    stubAvailable();
    await maybeRunStartupExtUpdateCheck(true);
    expect((await readExtUpdateState())?.status).toBe('available');
    vi.unstubAllGlobals();
  });

  it('同一生命周期只跑一次（守卫）：第二次调用不再 fetch', async () => {
    const fetchMock = vi.fn(async () => okJson(manifest({ version: '0.0.1' })));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue(undefined);
    await maybeRunStartupExtUpdateCheck(true);
    await maybeRunStartupExtUpdateCheck(true);
    expect(fetchMock).toHaveBeenCalledTimes(1); // 守卫拦住第二次
    vi.unstubAllGlobals();
  });

  it('节流未到不占用守卫：跳过后 force 仍可执行', async () => {
    const { storage } = await import('wxt/utils/storage');
    await storage.setItem('local:ext-update:last-check', Date.now());
    stubAvailable();
    await maybeRunStartupExtUpdateCheck();      // 节流跳过，不设守卫
    await maybeRunStartupExtUpdateCheck(true);  // force 接住执行
    expect((await readExtUpdateState())?.status).toBe('available');
    vi.unstubAllGlobals();
  });
});
