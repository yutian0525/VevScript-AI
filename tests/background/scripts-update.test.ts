// tests/background/scripts-update.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  readUpdateStates, clearUpdateState, checkScriptUpdate, runStartupUpdateCheck,
  handleImportUrl, handleApplyUpdate, updateCheckUrl, updateDownloadUrl,
  maybeRunStartupUpdateCheck, readLastCheckAt, resetStartupCheckGuardForTest,
} from '../../background/scripts-update';
import { saveScript, listScripts } from '../../storage/scripts';
import type { UserScript } from '../../shared/types';

function mkScript(over: Partial<UserScript> = {}): UserScript {
  return {
    id: 's1',
    text: '// ==UserScript==\n// @name t\n// @version 1.0.0\n// @match https://a.com/*\n// ==/UserScript==\ncode();',
    name: 't', enabled: true, matches: ['https://a.com/*'], code: 'code();',
    runAt: 'document_idle', world: 'USER_SCRIPT', source: 'import', createdAt: 1, updatedAt: 1,
    ...over,
  };
}

function okFetch(body: string) {
  return vi.fn(async () => ({ ok: true, status: 200, text: async () => body }));
}

interface FakeUserScriptsApi {
  register: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  unregister: ReturnType<typeof vi.fn>;
  getScripts: ReturnType<typeof vi.fn>;
}

/** 往 fakeBrowser 挂 userScripts stub（WXT fakeBrowser 未内置该 API；handleUpdate 走引擎的用例需要）。 */
function installFakeUserScripts(over: Partial<FakeUserScriptsApi> = {}): FakeUserScriptsApi {
  const api: FakeUserScriptsApi = {
    register: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
    unregister: vi.fn(async () => {}),
    getScripts: vi.fn(async () => [] as Array<Record<string, unknown>>),
    ...over,
  };
  (browser as unknown as Record<string, unknown>).userScripts = api;
  return api;
}

function uninstallFakeUserScripts(): void {
  delete (browser as unknown as Record<string, unknown>).userScripts;
}

beforeEach(() => {
  fakeBrowser.reset();
  uninstallFakeUserScripts();
  vi.restoreAllMocks();
  resetStartupCheckGuardForTest();
});

describe('update-state 存取', () => {
  it('空库返回 {}；clearUpdateState 对不存在 id 幂等', async () => {
    expect(await readUpdateStates()).toEqual({});
    await clearUpdateState('nope');
    expect(await readUpdateStates()).toEqual({});
  });
});

describe('update-state 物理键对称（防 WXT local: 前缀回归）', () => {
  it('WXT storage 写入后，裸 API 按 WXT 剥前缀后的键可读到', async () => {
    const { UPDATE_STATE_KEY } = await import('../../shared/types');
    const { storage } = await import('wxt/utils/storage');
    await storage.setItem(UPDATE_STATE_KEY, { s1: { remoteVersion: '2', checkedAt: 1, status: 'available' } });
    // WXT 将 'local:scripts:update-state' 剥前缀为物理键 'scripts:update-state'
    const raw = await browser.storage.local.get('scripts:update-state');
    expect(raw['scripts:update-state']).toBeDefined();
    // 且裸 API 用带前缀键读不到（历史上 UI 读方踩过的坑）
    const wrong = await browser.storage.local.get(UPDATE_STATE_KEY);
    expect(wrong[UPDATE_STATE_KEY]).toBeUndefined();
  });
});

describe('updateCheckUrl / updateDownloadUrl（TM 回退链）', () => {
  it('检查 = updateURL ?? downloadURL；下载 = downloadURL ?? updateURL', () => {
    const both = mkScript({ meta: { updateURL: 'u', downloadURL: 'd' } });
    const onlyUp = mkScript({ meta: { updateURL: 'u' } });
    const onlyDown = mkScript({ meta: { downloadURL: 'd' } });
    const none = mkScript({});
    expect(updateCheckUrl(both)).toBe('u');
    expect(updateDownloadUrl(both)).toBe('d');
    expect(updateCheckUrl(onlyUp)).toBe('u');
    expect(updateDownloadUrl(onlyUp)).toBe('u');
    expect(updateCheckUrl(onlyDown)).toBe('d');
    expect(updateDownloadUrl(onlyDown)).toBe('d');
    expect(updateCheckUrl(none)).toBeUndefined();
    expect(updateDownloadUrl(none)).toBeUndefined();
  });
});

describe('checkScriptUpdate', () => {
  it('远端版本更高 → available', async () => {
    vi.stubGlobal('fetch', okFetch('// ==UserScript==\n// @version 2.0.0\n// ==/UserScript==\nx'));
    const st = await checkScriptUpdate(mkScript({ meta: { updateURL: 'https://x/u' } }));
    expect(st.status).toBe('available');
    expect(st.remoteVersion).toBe('2.0.0');
    vi.unstubAllGlobals();
  });
  it('远端低 → up-to-date（降级不提示）', async () => {
    vi.stubGlobal('fetch', okFetch('// ==UserScript==\n// @version 0.9.0\n// ==/UserScript==\nx'));
    const st = await checkScriptUpdate(mkScript({ meta: { updateURL: 'https://x/u' } }));
    expect(st.status).toBe('up-to-date');
    vi.unstubAllGlobals();
  });
  it('远端无 @version → 视为 0 → up-to-date 不误报', async () => {
    vi.stubGlobal('fetch', okFetch('// ==UserScript==\n// @name t\n// ==/UserScript==\nx'));
    const st = await checkScriptUpdate(mkScript({ meta: { updateURL: 'https://x/u' } }));
    expect(st.status).toBe('up-to-date');
    vi.unstubAllGlobals();
  });
  it('HTTP 404 → error 带原因', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, text: async () => '' })));
    const st = await checkScriptUpdate(mkScript({ meta: { updateURL: 'https://x/u' } }));
    expect(st.status).toBe('error');
    expect(st.message).toContain('404');
    vi.unstubAllGlobals();
  });
  it('下载到 HTML（无脚本头）→ error', async () => {
    vi.stubGlobal('fetch', okFetch('<html><body>login</body></html>'));
    const st = await checkScriptUpdate(mkScript({ meta: { updateURL: 'https://x/u' } }));
    expect(st.status).toBe('error');
    expect(st.message).toContain('不是有效脚本');
    vi.unstubAllGlobals();
  });
  it('无更新源 → error 且不发起 fetch', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    const st = await checkScriptUpdate(mkScript({}));
    expect(st.status).toBe('error');
    expect(st.message).toContain('无更新源');
    expect(f).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe('runStartupUpdateCheck', () => {
  it('只查有更新源的脚本；结果落 storage 并广播', async () => {
    await saveScript(mkScript({ id: 'a', meta: { updateURL: 'https://x/a' } }));
    await saveScript(mkScript({ id: 'b' }));
    const fetchMock = vi.fn(async () => ({
      ok: true, status: 200, text: async () => '// ==UserScript==\n// @version 9.9.9\n// ==/UserScript==\nx',
    }));
    vi.stubGlobal('fetch', fetchMock);
    const sendSpy = vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue(undefined);
    await runStartupUpdateCheck();
    expect(fetchMock).toHaveBeenCalledTimes(1); // 只有 a
    const map = await readUpdateStates();
    expect(map.a?.status).toBe('available');
    expect(map.b).toBeUndefined();
    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'SCRIPTS_UPDATES' }));
    vi.unstubAllGlobals();
  });

  it('并发池：5 个目标全部恰好检查一次并落库', async () => {
    const ids = ['a1', 'a2', 'a3', 'a4', 'a5'];
    for (const id of ids) await saveScript(mkScript({ id, meta: { updateURL: `https://x/${id}` } }));
    const fetchMock = vi.fn(async () => ({
      ok: true, status: 200, text: async () => '// ==UserScript==\n// @version 9.9.9\n// ==/UserScript==\nx',
    }));
    vi.stubGlobal('fetch', fetchMock);
    const sendSpy = vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue(undefined);
    await runStartupUpdateCheck();
    expect(fetchMock).toHaveBeenCalledTimes(5); // 每个目标恰好检查一次（并发池不重复不漏）
    const map = await readUpdateStates();
    for (const id of ids) expect(map[id]?.status).toBe('available');
    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'SCRIPTS_UPDATES' }));
    vi.unstubAllGlobals();
  });
});

describe('handleImportUrl', () => {
  it('非 http(s) 协议拒绝', async () => {
    await expect(handleImportUrl('file:///c/x.user.js')).rejects.toThrow('http(s)');
    await expect(handleImportUrl('javascript:alert(1)')).rejects.toThrow('http(s)');
  });
  it('下载内容无脚本头 → 拒绝', async () => {
    vi.stubGlobal('fetch', okFetch('<html>404 page</html>'));
    await expect(handleImportUrl('https://x/s.js')).rejects.toThrow('不是有效脚本');
    vi.unstubAllGlobals();
  });
  it('成功：头无更新源 → 导入 URL 记为 @updateURL', async () => {
    const body = '// ==UserScript==\n// @name from-url\n// @match https://a.com/*\n// ==/UserScript==\ncode();';
    vi.stubGlobal('fetch', okFetch(body));
    const { script } = await handleImportUrl('https://cdn.example.com/s.user.js');
    expect(script.name).toBe('from-url');
    expect(script.meta?.updateURL).toBe('https://cdn.example.com/s.user.js');
    expect((await listScripts()).length).toBe(1);
    vi.unstubAllGlobals();
  });
  it('成功：头已有 updateURL → 不覆盖', async () => {
    const body = '// ==UserScript==\n// @name t\n// @updateURL https://origin/u\n// @match https://a.com/*\n// ==/UserScript==\ncode();';
    vi.stubGlobal('fetch', okFetch(body));
    const { script } = await handleImportUrl('https://cdn.example.com/other.user.js');
    expect(script.meta?.updateURL).toBe('https://origin/u');
    vi.unstubAllGlobals();
  });
});

describe('handleApplyUpdate', () => {
  // handleUpdate 内部走注册引擎（requireEngine）——挂假 userScripts API
  beforeEach(() => {
    installFakeUserScripts();
    vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue(undefined);
  });

  it('无更新源 → 报错', async () => {
    await saveScript(mkScript({ id: 'n1' }));
    await expect(handleApplyUpdate('n1')).rejects.toThrow('无更新源');
  });
  it('成功：远端文本覆盖 + 本地更新源保留 + update-state 清除', async () => {
    await saveScript(mkScript({ id: 'a1', meta: { version: '1.0.0', downloadURL: 'https://x/d' } }));
    // 预置一条 stale state，验证成功后被清
    const { UPDATE_STATE_KEY } = await import('../../shared/types');
    const { storage } = await import('wxt/utils/storage');
    await storage.setItem(UPDATE_STATE_KEY, { a1: { remoteVersion: '9', checkedAt: 1, status: 'available' } });
    const remote = '// ==UserScript==\n// @name t\n// @version 2.0.0\n// @match https://a.com/*\n// ==/UserScript==\nnewcode();';
    vi.stubGlobal('fetch', okFetch(remote));
    const next = await handleApplyUpdate('a1');
    expect(next.meta?.version).toBe('2.0.0');
    expect(next.meta?.downloadURL).toBe('https://x/d'); // 本地更新源保留
    expect(next.code).toBe('newcode();');
    const map = await readUpdateStates();
    expect(map.a1).toBeUndefined(); // 徽标清除
    vi.unstubAllGlobals();
  });
  it('下载超长 → 拒绝且不写库', async () => {
    await saveScript(mkScript({ id: 'a2', meta: { version: '1.0.0', downloadURL: 'https://x/d' } }));
    vi.stubGlobal('fetch', okFetch('x'.repeat(280 * 1024 + 1)));
    await expect(handleApplyUpdate('a2')).rejects.toThrow('超过上限');
    expect((await listScripts()).find((x) => x.id === 'a2')?.meta?.version).toBe('1.0.0');
    vi.unstubAllGlobals();
  });
  it('远端空码（头后无代码体）→ 拒绝', async () => {
    await saveScript(mkScript({ id: 'a3', meta: { downloadURL: 'https://x/d' } }));
    vi.stubGlobal('fetch', okFetch('// ==UserScript==\n// @name t\n// ==/UserScript==\n'));
    await expect(handleApplyUpdate('a3')).rejects.toThrow('code 不能为空');
    vi.unstubAllGlobals();
  });
});

describe('handleImportUrl source 归属', () => {
  it('默认 import；显式传 agent 覆盖', async () => {
    const body = '// ==UserScript==\n// @name t\n// @match https://a.com/*\n// ==/UserScript==\ncode();';
    vi.stubGlobal('fetch', okFetch(body));
    const def = await handleImportUrl('https://cdn.example.com/a.user.js');
    expect(def.script.source).toBe('import');
    const ag = await handleImportUrl('https://cdn.example.com/b.user.js', 'agent');
    expect(ag.script.source).toBe('agent');
    vi.unstubAllGlobals();
  });
});

describe('maybeRunStartupUpdateCheck（冷启动节流 + 生命周期守卫）', () => {
  function stubFetchVersion(v: string) {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, text: async () => `// ==UserScript==\n// @version ${v}\n// ==/UserScript==\nx`,
    })));
    vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue(undefined);
  }

  it('无时间戳（首次冷启动）→ 执行检查并写时间戳', async () => {
    await saveScript(mkScript({ id: 'a', meta: { updateURL: 'https://x/a' } }));
    stubFetchVersion('9.9.9');
    expect(await readLastCheckAt()).toBe(0);
    await maybeRunStartupUpdateCheck();
    expect((await readUpdateStates()).a?.status).toBe('available');
    expect(await readLastCheckAt()).toBeGreaterThan(0);
    vi.unstubAllGlobals();
  });

  it('节流窗口内（近期已查）且非 force → 跳过，不 fetch', async () => {
    await saveScript(mkScript({ id: 'a', meta: { updateURL: 'https://x/a' } }));
    const { storage } = await import('wxt/utils/storage');
    await storage.setItem('local:scripts:last-update-check', Date.now()); // 刚查过
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await maybeRunStartupUpdateCheck(); // 非 force
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('节流窗口内 + force（onStartup/onInstalled）→ 仍执行', async () => {
    await saveScript(mkScript({ id: 'a', meta: { updateURL: 'https://x/a' } }));
    const { storage } = await import('wxt/utils/storage');
    await storage.setItem('local:scripts:last-update-check', Date.now());
    stubFetchVersion('9.9.9');
    await maybeRunStartupUpdateCheck(true);
    expect((await readUpdateStates()).a?.status).toBe('available');
    vi.unstubAllGlobals();
  });

  it('同一生命周期只跑一次（守卫）：第二次调用不再 fetch', async () => {
    await saveScript(mkScript({ id: 'a', meta: { updateURL: 'https://x/a' } }));
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => '// ==UserScript==\n// @version 9\n// ==/UserScript==\nx' }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue(undefined);
    await maybeRunStartupUpdateCheck(true);
    await maybeRunStartupUpdateCheck(true);
    expect(fetchMock).toHaveBeenCalledTimes(1); // 守卫拦住第二次
    vi.unstubAllGlobals();
  });

  it('节流未到不占用守卫：跳过后 force 仍可执行', async () => {
    await saveScript(mkScript({ id: 'a', meta: { updateURL: 'https://x/a' } }));
    const { storage } = await import('wxt/utils/storage');
    await storage.setItem('local:scripts:last-update-check', Date.now());
    stubFetchVersion('9.9.9');
    await maybeRunStartupUpdateCheck();      // 节流跳过，不设守卫
    await maybeRunStartupUpdateCheck(true);  // force 接住执行
    expect((await readUpdateStates()).a?.status).toBe('available');
    vi.unstubAllGlobals();
  });
});
