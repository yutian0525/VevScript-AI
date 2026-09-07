import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { runDownload } from '../../background/gm-download';
import { handleGmCall } from '../../background/gm-api';
import { resolveConfirm, getPending, __resetConfirmQueue } from '../../background/confirm-queue';
import { saveScript } from '../../storage/scripts';
import type { UserScript } from '../../shared/types';

type Delta = { id: number; state?: { current?: string }; error?: { current?: string } };

function fakeDownloads() {
  let listener: ((d: Delta) => void) | undefined;
  const download = vi.fn(async () => 42);
  const removeListener = vi.fn();
  (browser as unknown as { downloads: unknown }).downloads = {
    download,
    onChanged: { addListener: (cb: (d: Delta) => void) => { listener = cb; }, removeListener },
  };
  return { download, removeListener, emit: (d: Delta) => listener?.(d) };
}

describe('gm-download', () => {
  beforeEach(() => { fakeBrowser.reset(); vi.restoreAllMocks(); });

  it('complete → ok；filename/headers 透传', async () => {
    const f = fakeDownloads();
    const p = runDownload({ url: 'https://c.com/f.zip', name: 'f.zip', headers: { 'X-A': '1' } });
    await new Promise((r) => setTimeout(r, 0)); // 等 download() resolve、id 落定
    f.emit({ id: 42, state: { current: 'complete' } });
    expect(await p).toEqual({ ok: true });
    expect(f.download).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://c.com/f.zip', filename: 'f.zip', headers: [{ name: 'X-A', value: '1' }],
    }));
  });

  it('interrupted → error', async () => {
    const f = fakeDownloads();
    const p = runDownload({ url: 'https://c.com/f.zip' });
    await new Promise((r) => setTimeout(r, 0));
    f.emit({ id: 42, state: { current: 'interrupted' }, error: { current: 'NETWORK_FAILED' } });
    expect(await p).toEqual({ ok: false, error: 'NETWORK_FAILED' });
  });
});

function mkScript(over: Partial<UserScript> = {}): UserScript {
  return {
    id: 's1', text: '', name: 't', enabled: true, matches: ['https://a.com/*'], code: '',
    runAt: 'document_idle', world: 'USER_SCRIPT', source: 'user', createdAt: 1, updatedAt: 1,
    meta: { grants: ['GM_download'] }, ...over,
  };
}

describe('GM_download 门控', () => {
  beforeEach(() => { fakeBrowser.reset(); vi.restoreAllMocks(); __resetConfirmQueue();
    vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({} as never);
    vi.spyOn(browser.tabs, 'create').mockResolvedValue({ id: 100 } as never);
  });

  it('跨域下载未列 @connect → 弹卡；allow-once 后 complete→ok', async () => {
    await saveScript(mkScript());
    const f = fakeDownloads();
    const pending = handleGmCall({ scriptId: 's1', api: 'Download', reqId: 1, params: [{ url: 'https://c.com/f.zip' }] }, { tab: { id: 1, url: 'https://a.com/' } } as never);
    await new Promise((r) => setTimeout(r, 10));
    const confirms = getPending();
    expect(confirms).toHaveLength(1);
    resolveConfirm(confirms[0]!.confirmId, 'allow-once');
    await new Promise((r) => setTimeout(r, 10));
    f.emit({ id: 42, state: { current: 'complete' } });
    expect((await pending as { ok: boolean }).ok).toBe(true);
  });
});
